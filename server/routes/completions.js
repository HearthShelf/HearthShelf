// Finished-books history. Mounted at /hs/completions.
//
//   GET /hs/completions?limit=&offset=  -> { available, total, rows }
//
// The caller's own completion log, newest finish first: what they finished, when,
// and how many times. Per-user, no admin gate - same posture as routes/stats.js.
//
// This exists because nothing else can answer it. ABS's mediaProgresses keeps a
// single finishedAt per (user, book) that is OVERWRITTEN on a re-finish, so a
// client deriving "finished books" from library progress gets "finished, at some
// point" with no reliable date and no re-read count. HearthShelf's own
// book_completions table is the only durable record of both.
//
// Like every completion-backed feature, this depends on the read-only ABS db
// being mounted (the snapshot job that populates the table reads it, and titles
// are resolved through it). On a slim install it reports available:false so the
// client can say "this server can't provide it" rather than showing an empty
// list, which would read as "you have finished nothing".

import { json } from '../lib/http.js'
import { absDbAvailable, getBooksByMediaIdsBulk } from '../lib/absdb.js'
import { getCompletionsPageForUser } from '../lib/bookCompletionsStore.js'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export async function handleCompletions(req, res, url, ctx) {
  if (url.pathname !== '/hs/completions') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (req.method !== 'GET') return (json(res, 405, { error: 'method_not_allowed' }), true)

  if (!(await absDbAvailable())) {
    return (json(res, 200, { available: false, total: 0, rows: [] }), true)
  }

  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)

  const { rows, total } = await getCompletionsPageForUser(ctx.userId, { limit, offset })
  if (!rows.length) return (json(res, 200, { available: true, total, rows: [] }), true)

  // One bulk hop for every title on the page - the single-id lookup would be an
  // N+1 against the ABS db for each row.
  const books = await getBooksByMediaIdsBulk(rows.map((r) => r.mediaItemId))

  // A book that has left the library still has a completion row, but nothing to
  // render and nowhere to navigate. Drop it rather than showing "Untitled" - but
  // keep `total` as the store reported it, so paging still terminates.
  const out = []
  for (const r of rows) {
    const book = books[r.mediaItemId]
    if (!book || !book.libraryItemId) continue
    out.push({
      libraryItemId: book.libraryItemId,
      title: book.title || 'Untitled',
      author: book.author || '',
      durationSec: book.durationSec,
      completions: r.completions,
      lastFinishedAt: r.lastFinishedAt,
    })
  }

  return (json(res, 200, { available: true, total, rows: out }), true)
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10)
  if (Number.isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
