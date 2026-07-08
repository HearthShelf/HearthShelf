// Unified reading-history backend. Mounted at /hs/finished-books/*.
//
//   GET    /hs/finished-books               -> the caller's unified list
//   POST   /hs/finished-books/match          -> review-screen matching, no writes
//   POST   /hs/finished-books/import         -> commit reviewed Goodreads rows
//   POST   /hs/finished-books/sync-abs       -> reconcile ABS isFinished into the store
//   GET    /hs/finished-books/hardcover      -> connection status (never the token)
//   PUT    /hs/finished-books/hardcover      -> save + verify a Hardcover PAT
//   DELETE /hs/finished-books/hardcover      -> disconnect
//   POST   /hs/finished-books/hardcover/sync -> push unsynced rows to Hardcover
//
// All per-user, no admin gate - this is the caller's own reading history, same
// posture as routes/social.js and routes/narrators.js's PUT/DELETE.

import { json, readBody } from '../lib/http.js'
import { matchAgainstLibrary } from '../lib/bookMatch.js'
import * as hardcover from '../lib/hardcover.js'
import {
  listFinishedBooks,
  upsertGoodreadsRows,
  syncAbsFinished,
  getHardcoverAccount,
  getHardcoverToken,
  setHardcoverToken,
  clearHardcoverAccount,
  setHardcoverSyncResult,
  getUnsyncedFinishedBooks,
  markHardcoverSynced,
  getUnsyncedAbsFinishedBooks,
  markAbsSynced,
} from '../lib/finishedBooks.js'
import { writeFinishesAsUser } from '../lib/absProgress.js'

async function fetchLibraryItems(ctx, libraryId) {
  const res = await fetch(
    `${ctx.absUrl}/api/libraries/${encodeURIComponent(libraryId)}/items?minified=1&limit=0`,
    { headers: { Authorization: `Bearer ${ctx.absToken}` } },
  )
  if (!res.ok) throw new Error(`abs items ${res.status}`)
  const data = await res.json()
  return data?.results ?? []
}

export async function handleFinishedBooks(req, res, url, ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/finished-books')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  if (p === '/hs/finished-books' && req.method === 'GET') {
    const books = await listFinishedBooks(ctx.serverId, ctx.userId)
    return (json(res, 200, { books }), true)
  }

  if (p === '/hs/finished-books/match' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse(await readBody(req, 4 * 1024 * 1024))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const { libraryId, rows } = body ?? {}
    if (!libraryId || !Array.isArray(rows)) {
      return (json(res, 400, { error: 'libraryId and rows required' }), true)
    }
    let libraryItems
    try {
      libraryItems = await fetchLibraryItems(ctx, libraryId)
    } catch {
      return (json(res, 502, { error: 'abs_unreachable' }), true)
    }
    const matches = rows.map((row) => ({
      title: row.title,
      author: row.author,
      isbn: row.isbn,
      ...matchAgainstLibrary(row, libraryItems),
    }))
    return (json(res, 200, { matches }), true)
  }

  if (p === '/hs/finished-books/import' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse(await readBody(req, 4 * 1024 * 1024))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const rows = Array.isArray(body?.rows) ? body.rows : null
    if (!rows) return (json(res, 400, { error: 'rows required' }), true)
    const result = await upsertGoodreadsRows(ctx.serverId, ctx.userId, rows)

    // Opt-in: write the matched rows' backdated finishes into ABS so they count
    // toward the stats page. We write AS the caller (their own bearer is
    // self-scoped to /api/me), so this works on every image without minting a
    // key. Stub rows (no match) are left for the promotion job. Best-effort: a
    // failed batch just leaves rows unsynced to retry, and never fails the
    // import itself - the HS-side history is already saved.
    let absBackfilled = 0
    if (body?.backfillAbs) {
      const pending = await getUnsyncedAbsFinishedBooks(ctx.serverId, ctx.userId, true)
      if (pending.length) {
        try {
          absBackfilled = await writeFinishesAsUser(ctx.absToken, pending, ctx.absUrl)
          if (absBackfilled) {
            for (const row of pending) await markAbsSynced(row.id)
          }
        } catch {
          // leave rows unsynced; the promotion job or a re-import will retry
        }
      }
    }
    return (json(res, 200, { ...result, absBackfilled }), true)
  }

  if (p === '/hs/finished-books/sync-abs' && req.method === 'POST') {
    let meRes
    try {
      meRes = await fetch(`${ctx.absUrl}/api/me`, {
        headers: { Authorization: `Bearer ${ctx.absToken}` },
      })
    } catch {
      return (json(res, 502, { error: 'abs_unreachable' }), true)
    }
    if (!meRes.ok) return (json(res, 502, { error: 'abs_unreachable' }), true)
    const me = await meRes.json()
    const finished = (me?.mediaProgress ?? []).filter((mp) => mp.isFinished && mp.libraryItemId)
    if (!finished.length) return (json(res, 200, { inserted: 0 }), true)

    // Pull item metadata (title/author) for each finished id. ABS has no bulk
    // "fetch these ids" endpoint, so fetch each item directly - capped, this
    // only runs on-demand via a user-clicked button, not automatically.
    const items = []
    for (const mp of finished.slice(0, 500)) {
      try {
        const r = await fetch(`${ctx.absUrl}/api/items/${encodeURIComponent(mp.libraryItemId)}`, {
          headers: { Authorization: `Bearer ${ctx.absToken}` },
        })
        if (!r.ok) continue
        const item = await r.json()
        const meta = item?.media?.metadata
        if (!meta?.title) continue
        items.push({
          libraryItemId: mp.libraryItemId,
          title: meta.title,
          author: meta.authorName || null,
          isbn: meta.isbn || null,
          dateFinished: null,
        })
      } catch {
        // skip an item we can't read; keep reconciling the rest
      }
    }
    const result = await syncAbsFinished(ctx.serverId, ctx.userId, items)
    return (json(res, 200, result), true)
  }

  if (p === '/hs/finished-books/hardcover' && req.method === 'GET') {
    const account = await getHardcoverAccount(ctx.serverId, ctx.userId)
    return (json(res, 200, account), true)
  }

  if (p === '/hs/finished-books/hardcover' && req.method === 'PUT') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const token = (body?.token || '').trim()
    if (!token) return (json(res, 400, { error: 'token required' }), true)
    let username
    try {
      username = await hardcover.verifyToken(token)
    } catch {
      return (json(res, 502, { error: 'hardcover_unreachable' }), true)
    }
    if (username === null) return (json(res, 400, { error: 'invalid_token' }), true)
    await setHardcoverToken(ctx.serverId, ctx.userId, token, username)
    const account = await getHardcoverAccount(ctx.serverId, ctx.userId)
    return (json(res, 200, account), true)
  }

  if (p === '/hs/finished-books/hardcover' && req.method === 'DELETE') {
    await clearHardcoverAccount(ctx.serverId, ctx.userId)
    return (json(res, 200, { ok: true }), true)
  }

  if (p === '/hs/finished-books/hardcover/sync' && req.method === 'POST') {
    const token = await getHardcoverToken(ctx.serverId, ctx.userId)
    if (!token) return (json(res, 400, { error: 'not_connected' }), true)
    const unsynced = await getUnsyncedFinishedBooks(ctx.serverId, ctx.userId)
    let synced = 0
    const notFound = []
    const errors = []
    for (const book of unsynced) {
      try {
        const match = await hardcover.searchBook(token, {
          title: book.title,
          author: book.author,
          isbn: book.isbn,
        })
        if (!match?.id) {
          notFound.push(book.title)
          continue
        }
        await hardcover.upsertReadBook(token, {
          bookId: match.id,
          dateFinished: book.dateFinished,
          rating: book.rating,
        })
        await markHardcoverSynced(book.id, String(match.id))
        synced++
      } catch (err) {
        errors.push({ title: book.title, error: err?.message || 'sync failed' })
      }
    }
    const status = errors.length ? 'error' : 'ok'
    await setHardcoverSyncResult(
      ctx.serverId,
      ctx.userId,
      status,
      errors.length ? errors[0].error : null,
    )
    return (json(res, 200, { synced, notFound, errors }), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
