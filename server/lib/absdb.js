// Read-only accessor for AudiobookShelf's own SQLite database.
//
// ABS gates all cross-user data behind admin in its REST API, so a leaderboard
// every user can see can't be built on the API without a standing admin token.
// Instead we read absdatabase.sqlite directly, READ-ONLY, and aggregate here.
// This is the ONLY place that knows ABS's internal schema - keep all ABS table
// and column knowledge in this file so a future ABS migration is a one-file fix.
//
// We never write to this database. The connection runs PRAGMA query_only = ON
// (so SQLite rejects any write at the engine level) and we only ever issue
// SELECTs; ABS stays the sole writer of its own data.
//
// Env: HS_ABS_DB_PATH (default /config/absdatabase.sqlite). On the all-in-one
// image ABS's /config is already mounted in-container, so the default just
// works. On slim, the admin mounts ABS's config dir read-only and points this
// env at the file. When the file is absent the social features simply hide.

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'

const ABS_DB_PATH = process.env.HS_ABS_DB_PATH || '/config/absdatabase.sqlite'

// Lazily opened, read-only client. Null until first use (or if unavailable).
let client = null
let openable = null // tri-state cache: null=unknown, true/false once probed

function fileExists() {
  try {
    return fs.statSync(ABS_DB_PATH).isFile()
  } catch {
    return false
  }
}

// Open (once) a libSQL client against the ABS db file and lock it to reads with
// PRAGMA query_only = ON, so SQLite rejects any write on this connection and we
// can never corrupt ABS's data. (@libsql/client doesn't accept a ?mode=ro file
// flag, so query_only is how we enforce read-only.) Returns null if the file
// isn't present.
let clientReady = null
async function ensureClient() {
  if (client) return client
  if (clientReady) return clientReady
  if (!fileExists()) return null
  clientReady = (async () => {
    const c = createClient({ url: pathToFileURL(ABS_DB_PATH).toString() })
    await c.execute('PRAGMA query_only = ON')
    client = c
    return c
  })()
  try {
    return await clientReady
  } catch {
    clientReady = null
    return null
  }
}

// Is the ABS database present and queryable? Cached after the first probe so a
// missing file doesn't cost a stat on every request. Any failure -> unavailable.
export async function absDbAvailable() {
  if (openable !== null) return openable
  const c = await ensureClient()
  if (!c) return (openable = false)
  try {
    await c.execute('SELECT 1')
    return (openable = true)
  } catch {
    return (openable = false)
  }
}

// --- Small in-memory TTL cache -------------------------------------------
//
// playbackSessions has NO secondary indexes and the db is read-only (we cannot
// add any), so the leaderboard/finished-users scans are relatively expensive.
// A short TTL cache keyed by function+args collapses bursts (a Stats page load,
// a shelf render) into one scan. Returns clones are unnecessary - callers treat
// results as read-only.
const CACHE_TTL_MS = 45 * 1000
const cache = new Map() // key -> { at, value }

async function cached(key, produce) {
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value
  const value = await produce()
  cache.set(key, { at: now, value })
  return value
}

// --- Leaderboard windowing ------------------------------------------------
//
// Windows are lexicographic string compares against ABS's own date columns
// (its userStats.js does the same). playbackSessions.date is a plain
// 'YYYY-MM-DD' TEXT column; mediaProgresses.finishedAt is a Sequelize DATE
// stored as text. A plain 'YYYY-MM-DD' cutoff compares correctly against any
// ISO-ish stored format ('2026-07-02...' >= '2026-06-25'), so we NEVER call
// SQLite datetime() on these columns - that would break on the DATE text shape.
//
// windowsAvailable is gated on a one-time probe of a real finishedAt value: if
// the stored text doesn't start with YYYY-MM-DD, we can't trust the compare and
// fall back to serving all-time only. Probed lazily on the first windowed call.
let windowsAvailable = null // null = not yet probed

export function getWindowsAvailable() {
  // Callers (the route) want a definite boolean; treat "not probed yet" as
  // available so the first request doesn't have to await the probe here (the
  // probe runs inside getLeaderboard, which sets this before the route reads it).
  return windowsAvailable !== false
}

// UTC 'YYYY-MM-DD' cutoff for a rolling window, or null for all-time.
function windowCutoff(window) {
  const days = window === 'week' ? 7 : window === 'month' ? 30 : 0
  if (!days) return null
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

// Probe one real finishedAt to confirm the stored text is lexicographic-safe.
// Runs at most once (result cached in windowsAvailable). Any failure -> assume
// unavailable so we serve all-time only rather than a wrong windowed result.
async function probeWindowFormat(c) {
  if (windowsAvailable !== null) return windowsAvailable
  try {
    const res = await c.execute(`
      SELECT finishedAt FROM mediaProgresses
      WHERE finishedAt IS NOT NULL
      LIMIT 1
    `)
    const sample = res.rows[0]?.finishedAt
    // No finished rows at all: nothing to compare against, but the column shape
    // is fine to window on. Treat as available.
    if (sample == null) return (windowsAvailable = true)
    return (windowsAvailable = /^\d{4}-\d{2}-\d{2}/.test(String(sample)))
  } catch {
    return (windowsAvailable = false)
  }
}

// Leaderboard rows: per ABS user, how many books they've finished and how many
// seconds they've spent listening to books. Guests and inactive users are left
// out of BOTH queries. The two grouped queries (finished counts, listening
// totals) are merged into ONE user set keyed by userId, so a user with listening
// time but zero finishes (or finishes but no recorded sessions) still appears -
// the earlier code built entries only from the finished query and silently
// dropped listen-only users.
//
// `window`: 'week' (rolling 7 days), 'month' (rolling 30 days), or 'all'
// (default). Windowing is a lexicographic string compare against ABS's date
// columns; if the boot-time format probe fails, we serve all-time regardless of
// the requested window (the route reads getWindowsAvailable() to tell the UI).
//
// Returns [] on any failure so callers can treat "unavailable" and "empty" alike.
export async function getLeaderboard({ limit = 100, window = 'all' } = {}) {
  const c = await ensureClient()
  if (!c) return []
  return cached(`leaderboard:${window}:${limit}`, async () => {
    try {
      let cutoff = null
      if (window === 'week' || window === 'month') {
        // Probe once; if the stored date text isn't lexicographic-safe, fall
        // back to all-time (cutoff stays null).
        if (await probeWindowFormat(c)) cutoff = windowCutoff(window)
      } else {
        // 'all' still needs windowsAvailable set for the route's echo, but only
        // if it hasn't been probed yet - a cheap no-op when it has.
        await probeWindowFormat(c)
      }

      // The user join (with guest/inactive exclusion) is applied to BOTH queries
      // so the merged set only ever contains eligible users.
      const finishedSql = cutoff
        ? `
        SELECT u.id AS userId, u.username AS username, COUNT(*) AS booksFinished
        FROM mediaProgresses mp
        JOIN users u ON u.id = mp.userId
        WHERE mp.isFinished = 1
          AND mp.mediaItemType = 'book'
          AND mp.finishedAt >= ?
          AND u.type != 'guest'
          AND u.isActive = 1
        GROUP BY u.id
      `
        : `
        SELECT u.id AS userId, u.username AS username, COUNT(*) AS booksFinished
        FROM mediaProgresses mp
        JOIN users u ON u.id = mp.userId
        WHERE mp.isFinished = 1
          AND mp.mediaItemType = 'book'
          AND u.type != 'guest'
          AND u.isActive = 1
        GROUP BY u.id
      `
      const listenSql = cutoff
        ? `
        SELECT u.id AS userId, u.username AS username, SUM(ps.timeListening) AS secondsListened
        FROM playbackSessions ps
        JOIN users u ON u.id = ps.userId
        WHERE ps.mediaItemType = 'book'
          AND ps.date >= ?
          AND u.type != 'guest'
          AND u.isActive = 1
        GROUP BY u.id
      `
        : `
        SELECT u.id AS userId, u.username AS username, SUM(ps.timeListening) AS secondsListened
        FROM playbackSessions ps
        JOIN users u ON u.id = ps.userId
        WHERE ps.mediaItemType = 'book'
          AND u.type != 'guest'
          AND u.isActive = 1
        GROUP BY u.id
      `

      const [finishedRes, listenRes] = await Promise.all([
        c.execute(cutoff ? { sql: finishedSql, args: [cutoff] } : finishedSql),
        c.execute(cutoff ? { sql: listenSql, args: [cutoff] } : listenSql),
      ])

      // Merge both result sets into one map keyed by userId.
      const byUser = new Map()
      const ensure = (userId, username) => {
        let e = byUser.get(userId)
        if (!e) {
          e = { userId, username: username || '', booksFinished: 0, secondsListened: 0 }
          byUser.set(userId, e)
        } else if (!e.username && username) {
          e.username = username
        }
        return e
      }

      for (const row of finishedRes.rows) {
        const e = ensure(String(row.userId), String(row.username ?? ''))
        e.booksFinished = Number(row.booksFinished) || 0
      }
      for (const row of listenRes.rows) {
        const e = ensure(String(row.userId), String(row.username ?? ''))
        e.secondsListened = Number(row.secondsListened) || 0
      }

      const entries = [...byUser.values()]
      entries.sort(
        (a, b) => b.booksFinished - a.booksFinished || b.secondsListened - a.secondsListened,
      )
      return entries.slice(0, Math.max(1, limit))
    } catch {
      return []
    }
  })
}

// One user's email, read read-only from ABS (the source of truth for accounts).
// Used to derive a Gravatar fallback for the avatar route. Returns null when the
// db is unavailable, the user is unknown, or they have no email on file.
export async function getUserEmail(userId) {
  if (!userId) return null
  const c = await ensureClient()
  if (!c) return null
  try {
    const res = await c.execute({
      sql: `SELECT email FROM users WHERE id = ? LIMIT 1`,
      args: [userId],
    })
    const email = res.rows[0]?.email
    return email ? String(email) : null
  } catch {
    return null
  }
}

// How many distinct users have finished a given library item. The progress rows
// reference the book by its media id (books.id), not the library-item id, so we
// hop libraryItems -> books to resolve it. Returns 0 on any failure.
export async function getFinishedCount(libraryItemId) {
  if (!libraryItemId) return 0
  const c = await ensureClient()
  if (!c) return 0
  try {
    const res = await c.execute({
      sql: `
        SELECT COUNT(DISTINCT mp.userId) AS n
        FROM libraryItems li
        JOIN mediaProgresses mp
          ON mp.mediaItemId = li.mediaId AND mp.mediaItemType = 'book'
        WHERE li.id = ? AND li.mediaType = 'book' AND mp.isFinished = 1
      `,
      args: [libraryItemId],
    })
    return Number(res.rows[0]?.n) || 0
  } catch {
    return 0
  }
}

// Bulk variant for shelves: { libraryItemId: finishedCount } for the ids asked
// for. Ids with no finishers are omitted (callers default missing to 0). One
// grouped query over the whole set. Returns {} on any failure.
export async function getFinishedCountsBulk(libraryItemIds = []) {
  const ids = [...new Set(libraryItemIds.filter(Boolean))]
  if (!ids.length) return {}
  const c = await ensureClient()
  if (!c) return {}
  try {
    const placeholders = ids.map(() => '?').join(', ')
    const res = await c.execute({
      sql: `
        SELECT li.id AS libraryItemId, COUNT(DISTINCT mp.userId) AS n
        FROM libraryItems li
        JOIN mediaProgresses mp
          ON mp.mediaItemId = li.mediaId AND mp.mediaItemType = 'book'
        WHERE li.id IN (${placeholders})
          AND li.mediaType = 'book'
          AND mp.isFinished = 1
        GROUP BY li.id
      `,
      args: ids,
    })
    const out = {}
    for (const row of res.rows) out[String(row.libraryItemId)] = Number(row.n) || 0
    return out
  } catch {
    return {}
  }
}

// Who finished a given library item: the finished-count join plus a users join
// to name each finisher. Same media-id hop as getFinishedCount (libraryItems ->
// books/mediaProgresses). Guests and inactive users are excluded. finishedAt is
// returned as a ms epoch (via Date.parse of the stored DATE text), null when it
// can't be parsed. Ordered newest finish first. Returns [] on any failure.
export async function getFinishedUsers(libraryItemId) {
  if (!libraryItemId) return []
  const c = await ensureClient()
  if (!c) return []
  return cached(`finishedUsers:${libraryItemId}`, async () => {
    try {
      const res = await c.execute({
        sql: `
          SELECT u.id AS userId, u.username AS username, mp.finishedAt AS finishedAt
          FROM libraryItems li
          JOIN mediaProgresses mp
            ON mp.mediaItemId = li.mediaId AND mp.mediaItemType = 'book'
          JOIN users u ON u.id = mp.userId
          WHERE li.id = ?
            AND li.mediaType = 'book'
            AND mp.isFinished = 1
            AND u.type != 'guest'
            AND u.isActive = 1
          ORDER BY mp.finishedAt DESC
        `,
        args: [libraryItemId],
      })
      return res.rows.map((row) => {
        const raw = row.finishedAt
        const ms = raw != null ? Date.parse(String(raw)) : NaN
        return {
          userId: String(row.userId),
          username: String(row.username ?? ''),
          finishedAt: Number.isNaN(ms) ? null : ms,
        }
      })
    } catch {
      return []
    }
  })
}

export const ABS_DB_PATH_RESOLVED = ABS_DB_PATH
