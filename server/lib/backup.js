// The HearthShelf backup engine. Produces a .hsbackup (a zip) holding a
// consistent snapshot of hearthshelf.db plus the avatars/ and narrators/ file
// trees and a manifest, and restores from one. This is the HS half of the
// data-lifecycle story (ABS backs up its own data separately). See
// docs/data-lifecycle/backups.md.
//
// What's inside a .hsbackup zip:
//   manifest.json          - format version, server id/name, HS version, row
//                            counts per data domain, included file roots
//   hearthshelf.db         - a VACUUM INTO snapshot (consistent under WAL)
//   avatars/<files>        - profile-photo files
//   narrators/<files>      - narrator-image files
//
// The included tables + file roots are driven by the data-domain registry
// (dataDomains.js), never a hand-list, so a new feature's data is backed up the
// moment it registers a domain.

import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import {
  db,
  initDb,
  DB_DIR,
  DB_FILE,
  getServerId,
  getServerName,
  reopenDb,
  closeDb,
  checkpointWal,
} from '../db.js'
import { validateBackupManifest } from '@hearthshelf/core'
import { DATA_DOMAINS, backupFileRoots } from './dataDomains.js'
import { HS_VERSION } from './hsVersion.js'
import { getBackupConfig } from '../backupConfig.js'

export const BACKUP_MANIFEST_VERSION = 1
export const BACKUP_EXT = '.hsbackup'
const BACKUP_DIR = path.join(DB_DIR, 'backups')

// A single in-process gate. Only one backup/restore touches the DB file at a
// time; a restore also holds it while it swaps the file out from under the
// connection. The backend is the single writer, so an in-process flag suffices.
let busy = false
export function isBackupBusy() {
  return busy
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

// Slugify the server name for a filename (falls back to 'hearthshelf').
function slug(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'hearthshelf'
}

// A filesystem-safe local timestamp 'YYYY-MM-DDTHHmm'. Uses UTC parts so the
// name is stable regardless of the box's TZ; the manifest carries the real ms.
function stamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}`
}

// Row counts per data domain, for the manifest. Best-effort per table (a table
// that somehow doesn't exist counts as 0), so a partial schema never sinks a
// backup.
async function domainRowCounts() {
  const out = []
  for (const d of DATA_DOMAINS) {
    let rows = 0
    for (const table of d.tables) {
      try {
        const r = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)
        rows += Number(r.rows[0]?.n) || 0
      } catch {
        // table missing / unreadable - skip
      }
    }
    out.push({ key: d.key, rows })
  }
  return out
}

// Take a consistent snapshot of hearthshelf.db into `destPath` using VACUUM INTO
// (works under WAL with no downtime; the target must not already exist).
async function snapshotDb(destPath) {
  await fs.rm(destPath, { force: true }).catch(() => {})
  await db.execute({ sql: 'VACUUM INTO ?', args: [destPath] })
}

// Add every file under `absRoot` to the zip under `zipRoot/`. No-op if the dir
// doesn't exist. Flat trees today (avatars/narrators have no subdirs), but it
// recurses defensively.
function addTreeToZip(zip, absRoot, zipRoot) {
  if (!fsSync.existsSync(absRoot)) return
  const walk = (dir, rel) => {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, relPath)
      else if (entry.isFile()) zip.addLocalFile(abs, path.posix.dirname(`${zipRoot}/${relPath}`))
    }
  }
  walk(absRoot, '')
}

// Copy `src` to `dest` (used for the off-box mirror). Best-effort; a mirror
// failure is logged by the caller but never fails the backup.
async function copyFile(src, dest) {
  await ensureDir(path.dirname(dest))
  await fs.copyFile(src, dest)
}

// Sweep old backups so at most `keep` remain (newest by filename, which sorts by
// timestamp). Runs against the primary backup dir only.
async function sweepRetention(keep, logger) {
  try {
    const files = (await fs.readdir(BACKUP_DIR))
      .filter((f) => f.endsWith(BACKUP_EXT))
      .sort() // ascending; timestamp in the name sorts chronologically
    const excess = files.length - keep
    if (excess > 0) {
      for (const f of files.slice(0, excess)) {
        await fs.rm(path.join(BACKUP_DIR, f), { force: true }).catch(() => {})
        logger?.info?.(`Removed old backup ${f}`)
      }
    }
  } catch {
    // no backups dir yet, or unreadable - nothing to sweep
  }
}

// Create a backup now. Returns { filename, size, path }. `logger` is the job
// logger (optional); pass one when run as a scheduled/manual job.
export async function createBackup(logger) {
  if (busy) throw new Error('A backup or restore is already in progress.')
  busy = true
  const tmpSnap = path.join(BACKUP_DIR, `.snapshot-${crypto.randomUUID()}.db`)
  try {
    await initDb()
    await ensureDir(BACKUP_DIR)

    const serverId = await getServerId()
    const serverName = await getServerName()
    const createdAt = Date.now()

    logger?.info?.('Snapshotting hearthshelf.db')
    await snapshotDb(tmpSnap)

    const domains = await domainRowCounts()
    const fileRoots = backupFileRoots()

    const manifest = {
      format: 'hsbackup',
      manifestVersion: BACKUP_MANIFEST_VERSION,
      createdAt,
      serverId,
      serverName,
      hsVersion: HS_VERSION,
      includesSecrets: true,
      domains,
      fileRoots,
    }

    logger?.info?.('Building archive')
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
    zip.addLocalFile(tmpSnap, '', 'hearthshelf.db')
    for (const root of fileRoots) addTreeToZip(zip, path.join(DB_DIR, root), root)

    const filename = `hearthshelf-${slug(serverName)}-${stamp(createdAt)}${BACKUP_EXT}`
    const outPath = path.join(BACKUP_DIR, filename)
    zip.writeZip(outPath)
    const size = (await fs.stat(outPath)).size
    logger?.info?.(`Wrote ${filename} (${size} bytes)`)

    // Off-box mirror (HS_BACKUP_PATH or the configured off_box_path). Best-effort.
    const cfg = await getBackupConfig()
    if (cfg.offBoxPath) {
      try {
        await copyFile(outPath, path.join(cfg.offBoxPath, filename))
        logger?.info?.(`Mirrored to ${cfg.offBoxPath}`)
      } catch (err) {
        logger?.warn?.(`Off-box mirror failed: ${String(err?.message ?? err)}`)
      }
    }

    await sweepRetention(cfg.keep, logger)

    return { filename, size, path: outPath }
  } finally {
    await fs.rm(tmpSnap, { force: true }).catch(() => {})
    busy = false
  }
}

// The job entry point (registry.js). Returns a one-line summary.
export async function runBackupJob(logger) {
  const { filename, size } = await createBackup(logger)
  return `Backed up ${filename} (${(size / 1024).toFixed(0)} KB)`
}

// --- Listing / reading / deleting ----------------------------------------

// Parse a backup's manifest without extracting the whole zip. Returns null if
// the file is unreadable or not a HS backup.
export function readManifestFromZip(zipPath) {
  try {
    const zip = new AdmZip(zipPath)
    const entry = zip.getEntry('manifest.json')
    if (!entry) return null
    return JSON.parse(zip.readAsText(entry))
  } catch {
    return null
  }
}

// List the backups in the primary dir, newest first, with manifest metadata.
export async function listBackups() {
  await ensureDir(BACKUP_DIR)
  let files
  try {
    files = await fs.readdir(BACKUP_DIR)
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    if (!f.endsWith(BACKUP_EXT)) continue
    const full = path.join(BACKUP_DIR, f)
    let size = 0
    let createdAt = 0
    let hsVersion = null
    try {
      const st = await fs.stat(full)
      size = st.size
      createdAt = st.mtimeMs
    } catch {
      continue
    }
    const manifest = readManifestFromZip(full)
    if (manifest?.createdAt) createdAt = Number(manifest.createdAt)
    if (manifest?.hsVersion) hsVersion = String(manifest.hsVersion)
    out.push({ id: f.slice(0, -BACKUP_EXT.length), filename: f, size, createdAt, hsVersion })
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

// Resolve a backup id (filename without extension) to an on-disk path, guarding
// against path traversal. Returns null if it doesn't exist.
export function backupPathForId(id) {
  const filename = `${String(id).replace(/[^a-zA-Z0-9_.-]/g, '')}${BACKUP_EXT}`
  const full = path.join(BACKUP_DIR, filename)
  if (!full.startsWith(BACKUP_DIR)) return null
  if (!fsSync.existsSync(full)) return null
  return full
}

export async function deleteBackup(id) {
  const full = backupPathForId(id)
  if (!full) return false
  await fs.rm(full, { force: true })
  return true
}

// Accept an uploaded backup: validate it's a real HS backup zip, then write it
// into the backups dir under a safe name. Returns the listing entry or throws.
export async function saveUploadedBackup(buf) {
  await ensureDir(BACKUP_DIR)
  let zip
  try {
    zip = new AdmZip(buf)
  } catch {
    throw new Error('That file is not a valid .hsbackup archive.')
  }
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('That archive is missing its manifest - not a HearthShelf backup.')
  let manifest
  try {
    manifest = JSON.parse(zip.readAsText(entry))
  } catch {
    throw new Error('That archive has an unreadable manifest.')
  }
  if (manifest?.format !== 'hsbackup') {
    throw new Error('That archive is not a HearthShelf backup.')
  }
  const serverName = manifest.serverName || 'uploaded'
  const filename = `hearthshelf-${slug(serverName)}-${stamp(
    Number(manifest.createdAt) || Date.now(),
  )}${BACKUP_EXT}`
  const outPath = path.join(BACKUP_DIR, filename)
  await fs.writeFile(outPath, buf)
  const size = (await fs.stat(outPath)).size
  return { id: filename.slice(0, -BACKUP_EXT.length), filename, size, createdAt: manifest.createdAt }
}

// --- Restore ---------------------------------------------------------------

// The WAL/SHM sidecars that must be moved aside with the main db file so a stale
// WAL from the old db can't be replayed over the restored one.
const DB_SIDECARS = ['-wal', '-shm']

// Restore hearthshelf.db + the file trees from a backup. REPLACE semantics
// (mirrors ABS): the current data is moved to pre-restore-<ts>/ (a one-shot
// escape hatch) and the backup's contents take its place, then the DB
// reconnects and re-runs boot migrations (an older backup upgrades forward).
//
// Steps (see backups.md restore semantics):
//   1. Validate the manifest (version supported).
//   2. Quiesce (the in-process busy gate) + checkpoint WAL.
//   3. Move current db (+sidecars) and file roots to pre-restore-<ts>/.
//   4. Extract the backup's db + file roots into place.
//   5. reopenDb() - fresh connection, re-run migrations.
//
// Returns { crossServer, backupServerId } so the caller can warn on a migration.
export async function restoreBackup(zipPath, logger) {
  if (busy) throw new Error('A backup or restore is already in progress.')
  busy = true
  let closed = false // did we close the DB (must reopen even on failure)?
  try {
    await initDb()
    let zip
    try {
      zip = new AdmZip(zipPath)
    } catch {
      throw new Error('That backup file is not a valid archive.')
    }
    const manifestEntry = zip.getEntry('manifest.json')
    const dbEntry = zip.getEntry('hearthshelf.db')
    let manifest = null
    if (manifestEntry) {
      try {
        manifest = JSON.parse(zip.readAsText(manifestEntry))
      } catch {
        manifest = null
      }
    }
    const check = validateBackupManifest(manifest)
    if (!check.ok) throw new Error(check.reason || 'This backup cannot be restored.')
    if (!dbEntry) throw new Error('That backup is missing its database - cannot restore.')

    const thisServerId = await getServerId()
    const backupServerId = String(manifest.serverId)
    const crossServer = backupServerId !== thisServerId

    // Escape hatch: move the current state aside (kept once). A prior
    // pre-restore dir is overwritten so we don't accrete them.
    const escapeDir = path.join(DB_DIR, `pre-restore-${stamp(Date.now())}`)
    logger?.info?.(`Saving current data to ${path.basename(escapeDir)}/`)
    await fs.rm(escapeDir, { recursive: true, force: true }).catch(() => {})
    await ensureDir(escapeDir)

    // Checkpoint so the main db file is complete, then CLOSE the connection so
    // the file can be moved (Windows won't move an open file; a stale handle
    // also risks reopening against old WAL). The busy gate is held across the
    // whole restore, so nothing else queries between close and reopen.
    await checkpointWal()
    closeDb()
    closed = true

    const fileRoots = Array.isArray(manifest.fileRoots) ? manifest.fileRoots : backupFileRoots()

    // Move the live db + sidecars aside.
    for (const suffix of ['', ...DB_SIDECARS]) {
      const src = DB_FILE + suffix
      if (fsSync.existsSync(src)) {
        await fs.rename(src, path.join(escapeDir, path.basename(src))).catch(async () => {
          // rename across devices can fail; fall back to copy. The unlink is
          // best-effort - the db extract below overwrites DB_FILE anyway, and
          // the escape-hatch copy already preserved the original.
          await fs.copyFile(src, path.join(escapeDir, path.basename(src)))
          await fs.rm(src, { force: true }).catch(() => {})
        })
      }
    }
    // Move the current file roots aside.
    for (const root of fileRoots) {
      const src = path.join(DB_DIR, root)
      if (fsSync.existsSync(src)) {
        await fs.rename(src, path.join(escapeDir, root)).catch(() => {})
      }
    }

    // Extract the backup's db into place.
    logger?.info?.('Restoring database')
    const dbBuf = zip.readFile(dbEntry)
    await fs.writeFile(DB_FILE, dbBuf)

    // Extract the file roots.
    for (const root of fileRoots) {
      const prefix = `${root}/`
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        const name = entry.entryName
        if (!name.startsWith(prefix)) continue
        const rel = name.slice(prefix.length)
        // Guard against path traversal in a crafted archive.
        const dest = path.join(DB_DIR, root, rel)
        if (!dest.startsWith(path.join(DB_DIR, root))) continue
        await ensureDir(path.dirname(dest))
        await fs.writeFile(dest, entry.getData())
      }
    }

    // Reconnect + re-run migrations (older backup -> forward-migrated).
    logger?.info?.('Reconnecting database')
    await reopenDb()
    closed = false

    logger?.info?.(crossServer ? 'Restored (from a different server)' : 'Restored')
    return { crossServer, backupServerId, escapeDir: path.basename(escapeDir) }
  } finally {
    // If we closed the DB but failed before the normal reopen (a mid-restore
    // error), reconnect so the box isn't left with a dead connection. The file
    // may be half-swapped, but a live connection beats a hung one, and the
    // pre-restore-<ts>/ escape hatch holds the original data for recovery.
    if (closed) {
      try {
        await reopenDb()
      } catch {
        // nothing more we can do here; boot will retry on next process start
      }
    }
    busy = false
  }
}

export { BACKUP_DIR }
