// Admin API for the import/merge engine (Phase 4). Mounted under /hs/import/*.
// All endpoints are admin-only. See docs/data-lifecycle/merge-engine.md.
//
//   POST /hs/import/inspect        -> dry-run; returns + persists an ImportReport
//   POST /hs/import/execute        -> apply a report (WS4.4)
//   GET  /hs/import/runs           -> recent reports
//   GET  /hs/import/runs/:id       -> one report (+ result if executed)
//
// Source is provided one of two ways:
//   - multipart-free raw upload: body is a .hsarchive / .audiobookshelf, with
//     mode + options in query params (X-Import-* headers avoided; query is simpler)
//   - live: a JSON body { source: { absUrl, adminToken }, mode, ... } - used when
//     no file is uploaded (Content-Type: application/json)

import { json, readBody, readBodyBuffer } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { importInspect, getImportReport, listImportReports } from '../lib/importEngine.js'
import { importExecute } from '../lib/importExecute.js'

const MAX_IMPORT_UPLOAD_BYTES = 1024 * 1024 * 1024

export async function handleImport(req, res, url, ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/import')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)

  // GET /hs/import/runs - recent reports.
  if (p === '/hs/import/runs' && req.method === 'GET') {
    return (json(res, 200, { runs: await listImportReports() }), true)
  }

  // GET /hs/import/runs/:id - one report.
  const runMatch = p.match(/^\/hs\/import\/runs\/([^/]+)$/)
  if (runMatch && req.method === 'GET') {
    const found = await getImportReport(decodeURIComponent(runMatch[1]))
    if (!found) return (json(res, 404, { error: 'not_found' }), true)
    return (json(res, 200, found), true)
  }

  // POST /hs/import/inspect - dry-run.
  if (p === '/hs/import/inspect' && req.method === 'POST') {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim()
    try {
      let opts
      if (contentType === 'application/json') {
        // Live source (or a re-run with no file).
        const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}')
        opts = {
          mode: body.mode || 'import',
          allowInode: Boolean(body.allowInode),
          userSubset: Array.isArray(body.userSubset) ? body.userSubset.map(String) : null,
          source: body.source?.absUrl
            ? { absUrl: String(body.source.absUrl), adminToken: String(body.source.adminToken || ctx.absToken) }
            : undefined,
        }
      } else {
        // Uploaded file; options ride in the query string.
        const buf = await readBodyBuffer(req, MAX_IMPORT_UPLOAD_BYTES)
        if (!buf.length) return (json(res, 400, { error: 'empty' }), true)
        const subset = url.searchParams.get('userSubset')
        opts = {
          mode: url.searchParams.get('mode') || 'import',
          allowInode: url.searchParams.get('allowInode') === '1',
          userSubset: subset ? subset.split(',').filter(Boolean) : null,
          source: { uploadBuf: buf },
        }
      }
      const report = await importInspect(opts)
      return (json(res, 200, report), true)
    } catch (err) {
      if (err?.code === 'payload_too_large') return (json(res, 413, { error: 'too_large' }), true)
      return (json(res, 400, { error: 'inspect_failed', detail: String(err?.message ?? err) }), true)
    }
  }

  // POST /hs/import/execute - apply a persisted report.
  if (p === '/hs/import/execute' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse((await readBody(req, 256 * 1024)) || '{}')
    } catch {
      return (json(res, 400, { error: 'bad_json' }), true)
    }
    const reportId = String(body.reportId || '')
    if (!reportId) return (json(res, 400, { error: 'missing_report_id' }), true)
    try {
      // The admin's overrides to the report's user mappings (edited in the UI),
      // plus the source is re-supplied: a live source's per-user writes need the
      // source data again (we don't persist source progress in the report).
      const result = await importExecute({
        reportId,
        userOverrides: Array.isArray(body.users) ? body.users : null,
        source: body.source ?? null,
        ctx,
      })
      return (json(res, 200, result), true)
    } catch (err) {
      return (json(res, 400, { error: 'execute_failed', detail: String(err?.message ?? err) }), true)
    }
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
