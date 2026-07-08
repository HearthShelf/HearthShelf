// Listening stats. Mounted at /hs/stats.
//
//   GET /hs/stats?tz=<offsetMinutes>  -> the caller's computed HSListeningStats
//
// Computes streak / this-week / active-days / most-listened server-side from ABS
// /api/me/listening-stats so every client shows identical numbers instead of
// each reimplementing the walk. Per-user, no admin gate - the caller's own
// listening history, same posture as routes/finished-books.js.
//
// `tz` is the caller's timezone offset in minutes (JS Date.getTimezoneOffset();
// e.g. 300 for US Central). Day bucketing is caller-local; without `tz` we fall
// back to the server's clock, which may mis-bucket "today" across timezones.

import { json } from '../lib/http.js'
import { callerNow, computeListeningStats } from '../lib/stats.js'
import { absDbAvailable, getFinishedCountForUser } from '../lib/absdb.js'
import { getHistoryForUser } from '../lib/statsHistoryStore.js'

// Map the ?range= param to a 'YYYY-MM-DD' cutoff, or null for all history.
// 'year' = last 365 days, 'all' (default) = everything HS has snapshotted.
function historyCutoff(range) {
  const days = range === 'year' ? 365 : range === 'month' ? 31 : range === 'week' ? 7 : 0
  if (!days) return null
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// ABS returns the caller's total recorded session count as `total` on the
// paginated /api/me/listening-sessions endpoint; ask for one item to read it
// cheaply. Returns null on any failure so the field degrades rather than erroring.
async function fetchSessionCount(ctx) {
  try {
    const r = await fetch(`${ctx.absUrl}/api/me/listening-sessions?itemsPerPage=1&page=0`, {
      headers: { Authorization: `Bearer ${ctx.absToken}` },
    })
    if (!r.ok) return null
    const body = await r.json()
    return Number.isFinite(body?.total) ? Number(body.total) : null
  } catch {
    return null
  }
}

export async function handleStats(req, res, url, ctx) {
  const p = url.pathname
  if (p !== '/hs/stats' && p !== '/hs/stats/history') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (req.method !== 'GET') return (json(res, 405, { error: 'method_not_allowed' }), true)

  // Durable daily listening history (the stats-snapshot job's output). Reads the
  // HS-owned stats_daily table for the caller. `available` is false when the ABS
  // db isn't mounted (no snapshot source), so the heatmap hides instead of
  // showing an empty year. See @hearthshelf/core HSStatsHistory.
  if (p === '/hs/stats/history') {
    if (!(await absDbAvailable())) {
      return (json(res, 200, { available: false, days: [] }), true)
    }
    const since = historyCutoff(url.searchParams.get('range') || 'all')
    const days = await getHistoryForUser(ctx.userId, since)
    return (json(res, 200, { available: true, days }), true)
  }

  let raw
  try {
    const r = await fetch(`${ctx.absUrl}/api/me/listening-stats`, {
      headers: { Authorization: `Bearer ${ctx.absToken}` },
    })
    if (!r.ok) return (json(res, 502, { error: 'abs_unreachable' }), true)
    raw = await r.json()
  } catch {
    return (json(res, 502, { error: 'abs_unreachable' }), true)
  }

  // Finished-book counts come from a direct ABS-db read (leaderboard source of
  // truth), so they need the read-only db mounted; degrade to null on a slim
  // install. booksThisYear windows on finishedAt >= Jan 1 of the caller-local
  // year. The session count is a cheap REST call, independent of the db.
  const tz = Number.parseInt(url.searchParams.get('tz') ?? '', 10)
  const now = callerNow(Number.isNaN(tz) ? undefined : tz)
  const yearStart = `${now.getUTCFullYear()}-01-01`
  const dbUp = await absDbAvailable()
  const [sessionCount, booksFinished, booksThisYear] = await Promise.all([
    fetchSessionCount(ctx),
    dbUp ? getFinishedCountForUser(ctx.userId) : Promise.resolve(null),
    dbUp ? getFinishedCountForUser(ctx.userId, yearStart) : Promise.resolve(null),
  ])

  const stats = computeListeningStats(raw, now, { sessionCount, booksFinished, booksThisYear })
  return (json(res, 200, stats), true)
}
