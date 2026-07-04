// Admin API for HearthShelf's own backups. Mounted under /hs/backups/*. All
// endpoints are admin-only (the standard resolveContext + isAdmin seam).
//
//   GET    /hs/backups                 -> { backups, config, lastRun, backupDir }
//   POST   /hs/backups                 -> run a backup now (202, returns runId)
//   PUT    /hs/backups/config          -> update schedule/retention (env-locked
//                                         fields rejected)
//   GET    /hs/backups/:id/download    -> stream the .hsbackup zip
//   DELETE /hs/backups/:id             -> delete a backup
//   POST   /hs/backups/upload          -> upload a .hsbackup (raw body) into the
//                                         backups dir (manifest validated)
//   POST   /hs/backups/:id/restore     -> restore from a backup (replace)
//
// The ABS half of the Backups page is served by ABS's own /api/backups; this
// module is only HearthShelf's data. See docs/data-lifecycle/backups.md.

import fs from 'node:fs'
import { json, readBodyBuffer } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { db, getServerId } from '../db.js'
import { publicBackupConfig, setBackupConfig } from '../backupConfig.js'
import {
  listBackups,
  deleteBackup,
  backupPathForId,
  saveUploadedBackup,
  restoreBackup,
  BACKUP_DIR,
} from '../lib/backup.js'
import { runJob, isJobRunning } from '../jobs/runner.js'
import { createArchive, estimateArchive, restoreArchive } from '../lib/archive.js'
import { runReconcile, reprovisionServiceRoot } from '../lib/reconcile.js'
import { setHostedConfig } from '../lib/hosted.js'

// A .hsbackup is small (the DB + a few avatars), but give generous headroom.
const MAX_BACKUP_UPLOAD_BYTES = 512 * 1024 * 1024

// The most recent hs-backup job run, for the lastRun field.
async function lastBackupRun(serverId) {
  try {
    const r = await db.execute({
      sql: `SELECT status, started_at, finished_at, summary, error
              FROM job_runs WHERE server_id = ? AND job_id = 'hs-backup'
              ORDER BY started_at DESC LIMIT 1`,
      args: [serverId],
    })
    const row = r.rows[0]
    if (!row) return null
    return {
      at: Number(row.finished_at ?? row.started_at) || 0,
      status: String(row.status),
      summary: row.summary != null ? String(row.summary) : row.error != null ? String(row.error) : null,
    }
  } catch {
    return null
  }
}

export async function handleBackups(req, res, url, ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/backups') && !p.startsWith('/hs/archive')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)

  const serverId = await getServerId()

  // --- reconcile (post-restore / post-migration) -------------------------

  // GET /hs/backups/reconcile - check service accounts, connection URLs, and
  // whether the library rescanned onto new item ids. Uses the caller's admin
  // token. Also rewrites stale connections.abs_url as a side effect (idempotent).
  if (p === '/hs/backups/reconcile' && req.method === 'GET') {
    const report = await runReconcile(ctx.absToken)
    return (json(res, 200, report), true)
  }

  // POST /hs/backups/reconcile/reprovision - re-create the AIO service root when
  // a restore replaced it, and adopt its token as the backend's admin token.
  if (p === '/hs/backups/reconcile/reprovision' && req.method === 'POST') {
    try {
      const { token, username } = await reprovisionServiceRoot(ctx.absToken)
      await setHostedConfig({ absAdminToken: token })
      return (json(res, 200, { ok: true, username }), true)
    } catch (err) {
      return (json(res, 400, { error: 'reprovision_failed', detail: String(err?.message ?? err) }), true)
    }
  }

  // --- .hsarchive (Phase 2 portability format) ---------------------------

  // GET /hs/archive/estimate - sizes before a download.
  if (p === '/hs/archive/estimate' && req.method === 'GET') {
    const est = await estimateArchive(ctx.absToken)
    return (json(res, 200, est), true)
  }

  // POST /hs/archive - build the archive and stream it back.
  if (p === '/hs/archive' && req.method === 'POST') {
    try {
      const { buffer, filename } = await createArchive(ctx.absToken)
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': buffer.length,
        'Content-Disposition': `attachment; filename="${filename}"`,
      })
      res.end(buffer)
      return true
    } catch (err) {
      return (json(res, 500, { error: 'archive_failed', detail: String(err?.message ?? err) }), true)
    }
  }

  // POST /hs/archive/restore - restore/replace from an uploaded archive.
  // Body is the raw .hsarchive bytes; ?mode=replace|hs-only (default replace).
  if (p === '/hs/archive/restore' && req.method === 'POST') {
    const mode = url.searchParams.get('mode') || 'replace'
    let buf
    try {
      buf = await readBodyBuffer(req, MAX_BACKUP_UPLOAD_BYTES)
    } catch (err) {
      if (err?.code === 'payload_too_large') return (json(res, 413, { error: 'too_large' }), true)
      return (json(res, 400, { error: 'read_failed' }), true)
    }
    if (!buf.length) return (json(res, 400, { error: 'empty' }), true)
    try {
      const result = await restoreArchive(buf, mode, ctx.absToken)
      return (json(res, 200, { ok: true, ...result }), true)
    } catch (err) {
      return (json(res, 400, { error: 'restore_failed', detail: String(err?.message ?? err) }), true)
    }
  }

  // GET /hs/backups - list + config + last run.
  if (p === '/hs/backups' && req.method === 'GET') {
    const [backups, config, lastRun] = await Promise.all([
      listBackups(),
      publicBackupConfig(),
      lastBackupRun(serverId),
    ])
    return (json(res, 200, { backups, config, lastRun, backupDir: BACKUP_DIR }), true)
  }

  // POST /hs/backups - run now (enqueue the job).
  if (p === '/hs/backups' && req.method === 'POST') {
    if (isJobRunning('hs-backup')) return (json(res, 409, { error: 'already_running' }), true)
    const runId = await runJob('hs-backup', { trigger: 'manual' })
    return (json(res, 202, { runId }), true)
  }

  // PUT /hs/backups/config - update schedule/retention.
  if (p === '/hs/backups/config' && req.method === 'PUT') {
    let body = {}
    try {
      const raw = await readBodyBuffer(req, 16 * 1024)
      body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
    } catch {
      return (json(res, 400, { error: 'bad_request' }), true)
    }
    const config = await setBackupConfig(body)
    return (json(res, 200, { config }), true)
  }

  // POST /hs/backups/upload - accept a raw .hsbackup body.
  if (p === '/hs/backups/upload' && req.method === 'POST') {
    let buf
    try {
      buf = await readBodyBuffer(req, MAX_BACKUP_UPLOAD_BYTES)
    } catch (err) {
      if (err?.code === 'payload_too_large') return (json(res, 413, { error: 'too_large' }), true)
      return (json(res, 400, { error: 'read_failed' }), true)
    }
    if (!buf.length) return (json(res, 400, { error: 'empty' }), true)
    try {
      const entry = await saveUploadedBackup(buf)
      return (json(res, 200, { ok: true, backup: entry }), true)
    } catch (err) {
      return (json(res, 400, { error: 'invalid_backup', detail: String(err?.message ?? err) }), true)
    }
  }

  // GET /hs/backups/:id/download - stream the zip.
  const dl = p.match(/^\/hs\/backups\/([^/]+)\/download$/)
  if (dl && req.method === 'GET') {
    const full = backupPathForId(decodeURIComponent(dl[1]))
    if (!full) return (json(res, 404, { error: 'not_found' }), true)
    const stat = fs.statSync(full)
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${decodeURIComponent(dl[1])}.hsbackup"`,
    })
    fs.createReadStream(full).pipe(res)
    return true
  }

  // POST /hs/backups/:id/restore - restore from a backup.
  const rs = p.match(/^\/hs\/backups\/([^/]+)\/restore$/)
  if (rs && req.method === 'POST') {
    const full = backupPathForId(decodeURIComponent(rs[1]))
    if (!full) return (json(res, 404, { error: 'not_found' }), true)
    try {
      const result = await restoreBackup(full)
      return (json(res, 200, { ok: true, ...result }), true)
    } catch (err) {
      return (json(res, 400, { error: 'restore_failed', detail: String(err?.message ?? err) }), true)
    }
  }

  // DELETE /hs/backups/:id - delete a backup.
  const del = p.match(/^\/hs\/backups\/([^/]+)$/)
  if (del && req.method === 'DELETE') {
    const ok = await deleteBackup(decodeURIComponent(del[1]))
    return (json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not_found' }), true)
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
