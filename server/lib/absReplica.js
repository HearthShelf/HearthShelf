// A private, indexed copy of AudiobookShelf's database that every absdb.js
// query reads instead of ABS's live file.
//
// Why: ABS keeps absdatabase.sqlite in SQLite's default rollback-journal mode,
// where a reader holding the file blocks every write until it finishes. ABS
// waits only a few seconds for a lock and then treats SQLITE_BUSY as fatal (an
// unhandled rejection exits the process), so one slow HearthShelf scan could
// crash ABS mid progress-sync, or stop it from starting at all. Our scans are
// inherently slow on the live file: playbackSessions has no secondary indexes,
// and we may never add any to ABS's database.
//
// So we read ABS's file only to copy it, and query the copy:
//   - The copy is taken under one short read lock (a kernel file copy, a reflink
//     where the filesystem supports one), so the time ABS can be kept waiting is
//     bounded by one file copy - never by how expensive our queries are, and
//     never by a query a future feature adds.
//   - The copy is ours, so it gets the indexes our queries need.
//   - It is refreshed in the background only when ABS's file has changed, at
//     most every HS_ABS_REPLICA_REFRESH_MS (default 15s). Readers always get the
//     newest finished copy and never wait on a refresh, except the very first.
//   - ABS's file is opened read-only for each copy and closed straight after,
//     so nothing of ours holds it between copies and a restored ABS backup
//     (which swaps the file out) is picked up on the next copy.
//
// Each refresh writes a new generation file and swaps it in; the previous one
// stays open for RETIRE_MS so a caller still holding it mid-request can finish,
// then it is closed and deleted.
//
// This uses node:sqlite rather than @libsql/client on purpose: libSQL only
// releases a database file when its object is garbage-collected, so retired
// generations would keep their disk space for an unpredictable time. node:sqlite
// closes the file when told to. The query surface matches the subset of the
// libSQL client absdb.js uses: `execute(sql | { sql, args })` -> `{ rows }`.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { appLog } from './appLog.js'

const DEFAULT_REFRESH_MS = 15 * 1000
const RETIRE_MS = 2 * 60 * 1000
const BUSY_TIMEOUT_MS = 5000
const FILE_PREFIX = 'abs-'
const STATEMENT_CACHE_MAX = 200

// Indexes for the scans absdb.js runs. ABS already indexes libraryItems.mediaId
// and mediaProgresses(userId, mediaItemId, ...); playbackSessions has none.
const REPLICA_INDEXES = [
  'CREATE INDEX IF NOT EXISTS hs_ps_user_type_updated ON playbackSessions (userId, mediaItemType, updatedAt)',
  'CREATE INDEX IF NOT EXISTS hs_ps_type_updated ON playbackSessions (mediaItemType, updatedAt)',
  'CREATE INDEX IF NOT EXISTS hs_ps_type_date ON playbackSessions (mediaItemType, date)',
  'CREATE INDEX IF NOT EXISTS hs_ps_media ON playbackSessions (mediaItemId)',
  'CREATE INDEX IF NOT EXISTS hs_mp_media_user ON mediaProgresses (mediaItemId, userId)',
  'CREATE INDEX IF NOT EXISTS hs_mp_finished ON mediaProgresses (isFinished, finishedAt)',
]

function openDb(file, { readOnly }) {
  const db = new DatabaseSync(file, { readOnly })
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  return db
}

// The read-only query client handed to absdb.js for one generation.
function replicaClient(db) {
  const statements = new Map()
  function prepare(sql) {
    let stmt = statements.get(sql)
    if (!stmt) {
      stmt = db.prepare(sql)
      if (statements.size >= STATEMENT_CACHE_MAX) statements.delete(statements.keys().next().value)
      statements.set(sql, stmt)
    }
    return stmt
  }
  return {
    async execute(stmtOrSql) {
      const { sql, args = [] } = typeof stmtOrSql === 'string' ? { sql: stmtOrSql } : stmtOrSql
      return { rows: prepare(sql).all(...args) }
    },
    close() {
      statements.clear()
      try {
        db.close()
      } catch {
        // already closed
      }
    },
  }
}

function sidecars(file) {
  return [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]
}

async function removeFiles(file) {
  await Promise.all(sidecars(file).map((f) => fsp.rm(f, { force: true }).catch(() => {})))
}

export function createAbsReplica({ sourcePath, dir, refreshMs = DEFAULT_REFRESH_MS }) {
  let current = null // { client, file, sig, at }
  let refreshing = null
  let timer = null
  let seq = 0
  let lastFailureLog = 0
  let cleaned = false

  // Identifies one state of ABS's file: a replaced file (new inode) or any
  // commit (size/mtime, or the -wal for a WAL-mode database) changes it.
  function sourceSignature() {
    try {
      const st = fs.statSync(sourcePath)
      if (!st.isFile()) return null
      let sig = `${st.ino}:${st.size}:${st.mtimeMs}`
      try {
        const wal = fs.statSync(`${sourcePath}-wal`)
        sig += `|${wal.size}:${wal.mtimeMs}`
      } catch {
        // no -wal file: rollback-journal mode, or a WAL with nothing pending
      }
      return sig
    } catch {
      return null
    }
  }

  async function cleanStaleFiles() {
    if (cleaned) return
    cleaned = true
    await fsp.mkdir(dir, { recursive: true })
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (name.startsWith(FILE_PREFIX)) await fsp.rm(path.join(dir, name), { force: true }).catch(() => {})
    }
  }

  // Copy ABS's database to `dest` as one consistent snapshot. Returns the source
  // signature the copy corresponds to.
  async function copySource(dest) {
    const src = openDb(sourcePath, { readOnly: true })
    try {
      const mode = String(src.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase()
      if (mode === 'wal') {
        // In WAL mode readers never block ABS's writes, so let SQLite assemble a
        // consistent copy from the main file and the -wal.
        const sig = sourceSignature()
        src.prepare('VACUUM INTO ?').run(dest)
        return sig
      }
      // Rollback-journal mode: while this read transaction holds its lock no
      // write can commit, so the file on disk stays consistent for exactly as
      // long as the copy takes, and no longer.
      src.exec('BEGIN')
      try {
        src.prepare('SELECT count(*) FROM sqlite_master').get()
        const sig = sourceSignature()
        await fsp.copyFile(sourcePath, dest, fs.constants.COPYFILE_FICLONE)
        return sig
      } finally {
        src.exec('ROLLBACK')
      }
    } finally {
      src.close()
    }
  }

  function addIndexes(file) {
    const db = openDb(file, { readOnly: false })
    try {
      db.exec('PRAGMA journal_mode = DELETE')
      for (const sql of REPLICA_INDEXES) {
        try {
          db.exec(sql)
        } catch (err) {
          // A table or column this ABS version doesn't have: that index just
          // doesn't apply. Queries still work, only slower.
          appLog.warn('absdb', `replica index skipped (${err?.message ?? err}): ${sql}`)
        }
      }
    } finally {
      db.close()
    }
  }

  function retire(gen) {
    setTimeout(() => {
      gen.client.close()
      void removeFiles(gen.file)
    }, RETIRE_MS).unref()
  }

  async function doRefresh() {
    const sig = sourceSignature()
    // ABS's file is gone (not mounted, or mid-restore): keep serving the last
    // copy if there is one; the next tick tries again.
    if (!sig) return current?.client ?? null
    if (current && current.sig === sig) return current.client

    await cleanStaleFiles()
    const file = path.join(dir, `${FILE_PREFIX}${Date.now()}-${seq++}.sqlite`)
    const tmp = `${file}.tmp`
    let client = null
    try {
      const copiedSig = await copySource(tmp)
      addIndexes(tmp)
      await fsp.rename(tmp, file)
      client = replicaClient(openDb(file, { readOnly: true }))
      const prev = current
      current = { client, file, sig: copiedSig ?? sig, at: Date.now() }
      if (prev) retire(prev)
      return client
    } catch (err) {
      client?.close()
      await removeFiles(tmp)
      await removeFiles(file)
      const now = Date.now()
      if (now - lastFailureLog > 5 * 60 * 1000) {
        lastFailureLog = now
        appLog.warn(
          'absdb',
          `could not refresh the copy of the AudiobookShelf database: ${err?.message ?? err}` +
            (current ? ' (still serving the previous copy)' : ''),
        )
      }
      return current?.client ?? null
    }
  }

  function refresh() {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null
      })
    }
    return refreshing
  }

  function startTimer() {
    if (timer) return
    timer = setInterval(() => {
      void refresh()
    }, refreshMs)
    timer.unref()
  }

  return {
    // The newest copy's client, or null when ABS's database isn't available.
    // Only the first call (no copy yet) waits for a copy to be taken.
    async client() {
      startTimer()
      if (current) return current.client
      return refresh()
    },
    // Take a fresh copy now if ABS's file changed.
    refresh,
    // When the copy being served was taken (ms epoch), or null.
    get takenAt() {
      return current?.at ?? null
    },
    async close() {
      if (timer) clearInterval(timer)
      timer = null
      if (refreshing) await refreshing.catch(() => {})
      if (current) {
        current.client.close()
        await removeFiles(current.file)
        current = null
      }
    },
  }
}
