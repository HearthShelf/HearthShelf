// The .hsarchive portability format - one file carrying a whole HearthShelf
// server (an ABS backup + an HS backup + a manifest), the unit every migration
// flow produces or consumes. See docs/data-lifecycle/archive-format.md.
//
// Container (a plain zip):
//   manifest.json
//   abs/backup.audiobookshelf   - ABS's own backup zip, byte-for-byte (optional)
//   hs/backup.hsbackup          - the Phase 1 HS backup zip, byte-for-byte
//
// Both inner artifacts stay in their native formats, so a .hsarchive can always
// be unzipped by hand and each half fed to stock tooling (the UC4 "give me my
// data back" guarantee).

import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import { getServerId, getServerName, DB_DIR } from '../db.js'
import { getMode } from './context.js'
import { HS_VERSION } from './hsVersion.js'
import { createBackup, restoreBackup, readManifestFromZip, BACKUP_DIR } from './backup.js'
import { validateArchiveManifest } from '@hearthshelf/core'

export const ARCHIVE_FORMAT_VERSION = 1
export const ARCHIVE_EXT = '.hsarchive'

const ABS_INNER = 'abs/backup.audiobookshelf'
const HS_INNER = 'hs/backup.hsbackup'

function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex')
}

function absBase() {
  return (process.env.ABS_SERVER_URL || '').replace(/\/$/, '')
}

// Trigger an ABS backup and return the newest backup's bytes + id, using the
// caller's admin token. ABS's POST /api/backups is synchronous (it awaits
// runBackup and returns the full list), so no socket wait is needed. Returns
// null when ABS is unreachable or the token lacks permission (Thin/hosted), so
// the archive degrades to HS-only.
async function fetchAbsBackup(absToken, logger) {
  const base = absBase()
  if (!base || !absToken) return null
  const auth = { Authorization: `Bearer ${absToken}` }
  try {
    logger?.info?.('Requesting an AudiobookShelf backup')
    const created = await fetch(`${base}/api/backups`, { method: 'POST', headers: auth })
    if (!created.ok) {
      logger?.warn?.(`AudiobookShelf backup request failed (${created.status}) - archive will be HearthShelf-only`)
      return null
    }
    const data = await created.json()
    const backups = Array.isArray(data?.backups) ? data.backups : []
    if (!backups.length) return null
    // Newest by createdAt.
    const newest = backups.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]
    logger?.info?.(`Downloading AudiobookShelf backup ${newest.id}`)
    const dl = await fetch(`${base}/api/backups/${encodeURIComponent(newest.id)}/download`, {
      headers: auth,
    })
    if (!dl.ok) {
      logger?.warn?.(`Could not download the AudiobookShelf backup (${dl.status})`)
      return null
    }
    const bytes = Buffer.from(await dl.arrayBuffer())
    return { id: String(newest.id), bytes }
  } catch (err) {
    logger?.warn?.(`AudiobookShelf backup step failed: ${String(err?.message ?? err)} - archive will be HearthShelf-only`)
    return null
  }
}

// Best-effort ABS version for the manifest.
async function absVersion() {
  const base = absBase()
  if (!base) return null
  try {
    const r = await fetch(`${base}/status`)
    if (!r.ok) return null
    const d = await r.json()
    return typeof d?.serverVersion === 'string' ? d.serverVersion : null
  } catch {
    return null
  }
}

// Create an archive and return { buffer, filename, manifest }. `absToken` is the
// admin caller's ABS bearer; on Thin/hosted (or when omitted) the archive is
// HS-only. This holds no lock of its own beyond createBackup's gate.
export async function createArchive(absToken, logger) {
  const serverId = await getServerId()
  const serverName = await getServerName()
  const createdAt = Date.now()

  // HS half (always).
  logger?.info?.('Backing up HearthShelf data')
  const hs = await createBackup(logger)
  const hsBytes = await fs.readFile(hs.path)
  const hsManifest = readManifestFromZip(hs.path)

  // ABS half (best-effort).
  const abs = await fetchAbsBackup(absToken, logger)

  const zip = new AdmZip()
  const checksums = {}

  zip.addFile(HS_INNER, hsBytes)
  checksums[HS_INNER] = sha256(hsBytes)
  if (abs) {
    zip.addFile(ABS_INNER, abs.bytes)
    checksums[ABS_INNER] = sha256(abs.bytes)
  }

  const manifest = {
    format: 'hsarchive',
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdAt,
    source: {
      serverId,
      serverName,
      hsVersion: HS_VERSION,
      absVersion: await absVersion(),
      mode: getMode(),
    },
    contents: {
      abs: abs
        ? { present: true, filename: 'backup.audiobookshelf', size: abs.bytes.length, absBackupId: abs.id }
        : { present: false },
      hs: {
        present: true,
        filename: 'backup.hsbackup',
        size: hsBytes.length,
        domains: hsManifest?.domains ?? [],
      },
    },
    includesSecrets: true,
    checksums,
    encryption: null,
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))

  const slug = String(serverName || 'hearthshelf')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const d = new Date(createdAt)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}`
  const filename = `${slug || 'hearthshelf'}-${stamp}${ARCHIVE_EXT}`

  return { buffer: zip.toBuffer(), filename, manifest }
}

// Size estimate shown before a download (GET /hs/archive/estimate). ABS size is
// unknown until produced, so it's null; HS size is the last backup's size if one
// exists, else null (the UI shows "~" / "unknown").
export async function estimateArchive(absToken) {
  const base = absBase()
  const absPresent = Boolean(base && absToken)
  let hsBytes = null
  try {
    const files = await fs.readdir(BACKUP_DIR)
    const hsFiles = files.filter((f) => f.endsWith('.hsbackup'))
    if (hsFiles.length) {
      const newest = hsFiles.sort().at(-1)
      hsBytes = (await fs.stat(path.join(BACKUP_DIR, newest))).size
    }
  } catch {
    hsBytes = null
  }
  return { absPresent, hsPresent: true, absBytes: null, hsBytes }
}

// --- Restore from an archive ----------------------------------------------

// Apply the ABS half: upload it to ABS then trigger apply. ABS's apply
// (GET /api/backups/:id/apply) replaces its sqlite + metadata and reconnects
// with no process restart. Returns true on success. Best-effort logging.
export async function applyAbsHalf(absToken, absBytes, logger) {
  const base = absBase()
  if (!base || !absToken) throw new Error('AudiobookShelf is not reachable to restore its half.')
  const auth = { Authorization: `Bearer ${absToken}` }

  logger?.info?.('Uploading the AudiobookShelf backup')
  // ABS's upload is multipart/form-data with a `file` field.
  const form = new FormData()
  form.append('file', new Blob([absBytes], { type: 'application/zip' }), 'restore.audiobookshelf')
  const up = await fetch(`${base}/api/backups/upload`, { method: 'POST', headers: auth, body: form })
  if (!up.ok) throw new Error(`AudiobookShelf rejected the backup upload (${up.status}).`)
  const upData = await up.json().catch(() => ({}))
  const backups = Array.isArray(upData?.backups) ? upData.backups : []
  // The uploaded backup is the newest one now.
  const newest = backups.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]
  if (!newest) throw new Error('AudiobookShelf did not report the uploaded backup.')

  logger?.info?.('Applying the AudiobookShelf backup')
  const apply = await fetch(`${base}/api/backups/${encodeURIComponent(newest.id)}/apply`, {
    headers: auth,
  })
  if (!apply.ok) throw new Error(`AudiobookShelf could not apply the backup (${apply.status}).`)
  return true
}

// Restore from an archive buffer. Modes:
//   'replace'  - apply ABS half (if present) FIRST, then restore HS half. ABS's
//                restore replaces every user id with the archive's ids, and the
//                HS half is keyed to exactly those ids, so the pair stays
//                consistent. The full-server restore.
//   'hs-only'  - restore only the HS half (Thin -> AIO variants).
// ('import' is the merge engine's job - Phase 4 - and is rejected here.)
export async function restoreArchive(buffer, mode, absToken, logger) {
  if (mode === 'import') throw new Error('Import mode is handled by the merge engine, not archive restore.')
  let zip
  try {
    zip = new AdmZip(buffer)
  } catch {
    throw new Error('That file is not a valid .hsarchive.')
  }
  const mfEntry = zip.getEntry('manifest.json')
  let manifest = null
  if (mfEntry) {
    try {
      manifest = JSON.parse(zip.readAsText(mfEntry))
    } catch {
      manifest = null
    }
  }
  const check = validateArchiveManifest(manifest)
  if (!check.ok) throw new Error(check.reason || 'That archive cannot be restored.')

  const absEntry = zip.getEntry(ABS_INNER)
  const hsEntry = zip.getEntry(HS_INNER)

  // ABS FIRST (replace mode, ABS half present).
  if (mode === 'replace' && absEntry) {
    await applyAbsHalf(absToken, absEntry.getData(), logger)
  }

  // HS half. Write it to the backups dir then reuse the Phase 1 restore.
  if (!hsEntry) {
    // An ABS-only archive in hs-only mode has nothing to do.
    if (mode === 'hs-only') throw new Error('This archive has no HearthShelf data to restore.')
    return { absRestored: Boolean(absEntry), hsRestored: false }
  }
  const tmp = path.join(BACKUP_DIR, `.archive-hs-${crypto.randomUUID()}.hsbackup`)
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  await fs.writeFile(tmp, hsEntry.getData())
  try {
    const hsResult = await restoreBackup(tmp, logger)
    return { absRestored: mode === 'replace' && Boolean(absEntry), hsRestored: true, ...hsResult }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}
