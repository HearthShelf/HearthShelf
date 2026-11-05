// ABS has no undo, so a full restore must find every cheap reason to fail before it
// touches ABS, and must say so when it fails afterwards.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-archive-restore-'))
process.env.QG_DATA_DIR ??= dir
const { restoreArchive, ARCHIVE_FORMAT_VERSION } = await import('../lib/archive.js')
const { beginRestore, endRestore, isRestoring, BACKUP_MANIFEST_VERSION } = await import('../lib/backup.js')

function hsBackup({ manifest = {}, withDb = true } = {}) {
  const zip = new AdmZip()
  const full = {
    format: 'hsbackup',
    manifestVersion: BACKUP_MANIFEST_VERSION,
    createdAt: 1,
    serverId: 'server',
    serverName: 'Test',
    hsVersion: '0.1.0',
    includesSecrets: true,
    domains: [],
    fileRoots: [],
    ...manifest,
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(full)))
  if (withDb) zip.addFile('hearthshelf.db', Buffer.from('db'))
  return zip.toBuffer()
}

function archive(hsBytes) {
  const zip = new AdmZip()
  zip.addFile('abs/backup.audiobookshelf', Buffer.from('abs'))
  if (hsBytes) zip.addFile('hs/backup.hsbackup', hsBytes)
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        format: 'hsarchive',
        formatVersion: ARCHIVE_FORMAT_VERSION,
        createdAt: 1,
        source: { serverId: 'server', serverName: 'Test', hsVersion: '0.1.0', absVersion: null, mode: 'aio' },
        contents: {
          abs: { present: true, filename: 'backup.audiobookshelf', size: 3, absBackupId: 'a' },
          hs: { present: Boolean(hsBytes), filename: 'backup.hsbackup', size: hsBytes?.length ?? 0, domains: [] },
        },
        includesSecrets: true,
        checksums: {},
        encryption: null,
      }),
    ),
  )
  return zip.toBuffer()
}

function spies({ restoreError } = {}) {
  const calls = { abs: 0, hs: 0, hsGateHeld: null, restoringDuringAbs: null }
  return {
    calls,
    seams: {
      applyAbs: async () => {
        calls.abs += 1
        calls.restoringDuringAbs = isRestoring()
      },
      restoreHs: async (_file, _logger, options) => {
        calls.hs += 1
        calls.hsGateHeld = options?.gateHeld
        if (restoreError) throw restoreError
        return { crossServer: false }
      },
    },
  }
}

test('a bad HearthShelf half is refused before ABS is touched', async () => {
  const { calls, seams } = spies()
  const bad = hsBackup({ withDb: false })
  await assert.rejects(restoreArchive(archive(bad), 'replace', 't', null, seams), (err) => {
    assert.notEqual(err.partial, true)
    return true
  })
  assert.equal(calls.abs, 0)
  assert.equal(isRestoring(), false)
})

test('a busy server is refused before ABS is touched', async () => {
  const { calls, seams } = spies()
  beginRestore()
  try {
    await assert.rejects(restoreArchive(archive(hsBackup()), 'replace', 't', null, seams), (err) => {
      assert.notEqual(err.partial, true)
      return true
    })
  } finally {
    endRestore()
  }
  assert.equal(calls.abs, 0)
})

test('a failure after ABS changed is marked partial', async () => {
  const { calls, seams } = spies({ restoreError: new Error('disk full') })
  await assert.rejects(restoreArchive(archive(hsBackup()), 'replace', 't', null, seams), (err) => {
    assert.equal(err.partial, true)
    return true
  })
  assert.equal(calls.abs, 1)
  assert.equal(isRestoring(), false)
})

test('a good restore holds the gate across both halves and releases it', async () => {
  const { calls, seams } = spies()
  const result = await restoreArchive(archive(hsBackup()), 'replace', 't', null, seams)
  assert.equal(result.absRestored, true)
  assert.equal(result.hsRestored, true)
  assert.equal(calls.restoringDuringAbs, true)
  assert.equal(calls.hsGateHeld, true)
  assert.equal(isRestoring(), false)
})
