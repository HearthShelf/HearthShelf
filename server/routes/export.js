// Per-user data export (Phase 5). Any signed-in user can download their own
// HearthShelf data. Mounted under /hs/export/*. Self-scoped (the caller's own
// ctx.userId) - never another user's, so no admin gate is needed.
//
//   GET /hs/export/me       -> user-export.json (all exportable domains)
//   GET /hs/export/me.csv   -> finished books as CSV

import { json } from '../lib/http.js'
import { buildUserExport, finishedBooksCsv } from '../lib/export.js'

function slug(name) {
  return (
    String(name || 'hearthshelf')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'hearthshelf'
  )
}

export async function handleExport(req, res, url, ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/export')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  // GET /hs/export/me - the full JSON export.
  if (p === '/hs/export/me' && req.method === 'GET') {
    const data = await buildUserExport(ctx.userId, ctx.username)
    const body = JSON.stringify(data, null, 2)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Content-Disposition': `attachment; filename="hearthshelf-${slug(ctx.username)}-export.json"`,
    })
    res.end(body)
    return true
  }

  // GET /hs/export/me.csv - finished books as CSV.
  if (p === '/hs/export/me.csv' && req.method === 'GET') {
    const data = await buildUserExport(ctx.userId, ctx.username)
    const csv = finishedBooksCsv(data)
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': Buffer.byteLength(csv),
      'Content-Disposition': `attachment; filename="hearthshelf-${slug(ctx.username)}-finished-books.csv"`,
    })
    res.end(csv)
    return true
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
