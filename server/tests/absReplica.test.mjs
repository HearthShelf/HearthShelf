import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const { createAbsReplica } = await import('../lib/absReplica.js')

function makeAbsDb(file, rows = 3) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE playbackSessions (id INTEGER PRIMARY KEY, userId TEXT, mediaItemId TEXT,
      mediaItemType TEXT, updatedAt TEXT, date TEXT, extraData TEXT);
    CREATE TABLE mediaProgresses (id INTEGER PRIMARY KEY, userId TEXT, mediaItemId TEXT,
      isFinished INTEGER, finishedAt TEXT);
  `)
  const insert = db.prepare(
    "INSERT INTO playbackSessions (userId, mediaItemId, mediaItemType, updatedAt) VALUES ('u', 'm', 'book', ?)",
  )
  db.exec('BEGIN')
  for (let i = 0; i < rows; i++) insert.run(new Date().toISOString())
  db.exec('COMMIT')
  db.close()
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hs-abs-replica-'))
}

async function count(client, table = 'playbackSessions') {
  const res = await client.execute(`SELECT count(*) AS n FROM ${table}`)
  return Number(res.rows[0].n)
}

// Stands in for ABS: a separate process committing writes back to back with a
// short lock wait, counting every write that fails with SQLITE_BUSY.
const WRITER = `
  import { DatabaseSync } from 'node:sqlite'
  const db = new DatabaseSync(process.argv[1])
  db.exec('PRAGMA busy_timeout = 1000')
  let ok = 0, failed = 0
  const until = Date.now() + Number(process.argv[2])
  while (Date.now() < until) {
    try {
      db.prepare("INSERT INTO playbackSessions (userId, mediaItemId, mediaItemType, updatedAt) VALUES ('w', 'm', 'book', ?)").run(new Date().toISOString())
      ok++
    } catch { failed++ }
    await new Promise((r) => setTimeout(r, 5))
  }
  db.close()
  console.log(JSON.stringify({ ok, failed }))
`

function runWriter(file, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WRITER, file, String(ms)])
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('exit', () => resolve(JSON.parse(out.trim())))
  })
}

test('serves an indexed copy and leaves the source untouched', async () => {
  const dir = tempDir()
  const source = path.join(dir, 'absdatabase.sqlite')
  makeAbsDb(source)
  const replica = createAbsReplica({ sourcePath: source, dir: path.join(dir, 'replica') })
  try {
    const c = await replica.client()
    assert.equal(await count(c), 3)
    const idx = await c.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'hs_%'")
    assert.ok(idx.rows.length >= 4)
    await assert.rejects(c.execute("INSERT INTO mediaProgresses (userId) VALUES ('x')"))

    const src = new DatabaseSync(source)
    const srcIdx = src.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'hs_%'").get()
    src.close()
    assert.equal(Number(srcIdx.n), 0)
  } finally {
    await replica.close()
  }
})

test('never makes a concurrent writer fail, and catches up with its writes', async () => {
  const dir = tempDir()
  const source = path.join(dir, 'absdatabase.sqlite')
  makeAbsDb(source, 20000)
  const replica = createAbsReplica({ sourcePath: source, dir: path.join(dir, 'replica'), refreshMs: 20 })
  try {
    await replica.client()
    const writer = runWriter(source, 2000)
    let stop = false
    const reader = (async () => {
      let refreshes = 0
      while (!stop) {
        const c = await replica.refresh()
        // A heavy query on the copy must not matter to the writer at all.
        await c.execute('SELECT a.userId FROM playbackSessions a, playbackSessions b WHERE a.id = b.id LIMIT 1')
        refreshes++
      }
      return refreshes
    })()
    const result = await writer
    stop = true
    const refreshes = await reader
    assert.equal(result.failed, 0)
    assert.ok(result.ok > 50, `writer made ${result.ok} writes`)
    assert.ok(refreshes > 1)

    const c = await replica.refresh()
    assert.equal(await count(c), 20000 + result.ok)
  } finally {
    await replica.close()
  }
})

test('picks up a replaced database file (an ABS backup restore)', async () => {
  const dir = tempDir()
  const source = path.join(dir, 'absdatabase.sqlite')
  makeAbsDb(source, 3)
  const replica = createAbsReplica({ sourcePath: source, dir: path.join(dir, 'replica') })
  try {
    assert.equal(await count(await replica.client()), 3)
    const restored = path.join(dir, 'restored.sqlite')
    makeAbsDb(restored, 7)
    fs.rmSync(source)
    fs.renameSync(restored, source)
    assert.equal(await count(await replica.refresh()), 7)
  } finally {
    await replica.close()
  }
})

test('copies a WAL-mode database including uncheckpointed writes', async () => {
  const dir = tempDir()
  const source = path.join(dir, 'absdatabase.sqlite')
  makeAbsDb(source, 2)
  const writer = new DatabaseSync(source)
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  writer.exec("INSERT INTO playbackSessions (userId) VALUES ('wal')")
  const replica = createAbsReplica({ sourcePath: source, dir: path.join(dir, 'replica') })
  try {
    assert.equal(await count(await replica.client()), 3)
    writer.exec("INSERT INTO playbackSessions (userId) VALUES ('wal2')")
    assert.equal(await count(await replica.refresh()), 4)
  } finally {
    writer.close()
    await replica.close()
  }
})

test('reports unavailable when the database is not mounted', async () => {
  const dir = tempDir()
  const replica = createAbsReplica({
    sourcePath: path.join(dir, 'missing.sqlite'),
    dir: path.join(dir, 'replica'),
  })
  try {
    assert.equal(await replica.client(), null)
  } finally {
    await replica.close()
  }
})
