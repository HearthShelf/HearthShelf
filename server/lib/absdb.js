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

// --- Import-source reader (Phase 4 merge engine) -------------------------
//
// The merge engine reads a whole ABS install's users + library + progress +
// bookmarks, either from a LIVE server's own db (this module's client) or from a
// backup's extracted absdatabase.sqlite. Both go through the same read-only
// technique and the same queries, so all ABS-schema knowledge stays in this one
// file. openAbsDbReadonly() opens an ARBITRARY sqlite path read-only (for backup
// sources); readImportInventory() runs the inventory against any such client.

// Open any absdatabase.sqlite file read-only (query_only = ON). Caller closes it.
// Used for backup-zip sources (a temp-extracted db), separate from this module's
// long-lived client for the configured live db.
export async function openAbsDbReadonly(dbPath) {
  const c = createClient({ url: pathToFileURL(dbPath).toString() })
  await c.execute('PRAGMA query_only = ON')
  return c
}

// Read the full import inventory from an ABS db client. Returns:
//   { users, items, progress, bookmarks }
// - users:   { id, username, email, type, isActive }
// - items:   { libraryItemId, mediaId, title, author, asin, isbn, ino, isPodcast }
//            (books get asin/isbn/author from the books table; podcasts flagged)
// - progress:{ userId, mediaItemId, mediaItemType, isFinished, finishedAt,
//              currentTime, ebookLocation, ebookProgress,
//              hideFromContinueListening, lastUpdate }
// - bookmarks: { userId, libraryItemId, time, title, createdAt } (from users.bookmarks JSON)
// finishedAt / updatedAt are Sequelize DATEs (ISO strings); we convert to epoch ms.
export async function readImportInventory(client) {
  const c = client
  const toMs = (v) => {
    if (v == null) return null
    const n = typeof v === 'number' ? v : Date.parse(String(v))
    return Number.isFinite(n) ? n : null
  }

  // Users.
  const usersRes = await c.execute(
    `SELECT id, username, email, type, isActive FROM users`,
  )
  const users = usersRes.rows.map((r) => ({
    id: String(r.id),
    username: r.username != null ? String(r.username) : '',
    email: r.email != null ? String(r.email) : null,
    type: r.type != null ? String(r.type) : 'user',
    isActive: r.isActive == null ? true : Boolean(r.isActive),
  }))

  // Library items joined to books for asin/isbn/author. Author is the first
  // author name via the bookAuthors join table; a LEFT JOIN keeps items with no
  // author. Podcasts have no book row (b.id null) - flagged isPodcast.
  const itemsRes = await c.execute(
    `SELECT li.id AS libraryItemId, li.mediaId AS mediaId, li.mediaType AS mediaType,
            li.ino AS ino, li.title AS liTitle,
            b.title AS bookTitle, b.asin AS asin, b.isbn AS isbn,
            (SELECT a.name FROM authors a
               JOIN bookAuthors ba ON ba.authorId = a.id
              WHERE ba.bookId = b.id LIMIT 1) AS author
       FROM libraryItems li
       LEFT JOIN books b ON b.id = li.mediaId`,
  )
  const items = itemsRes.rows.map((r) => ({
    libraryItemId: String(r.libraryItemId),
    mediaId: r.mediaId != null ? String(r.mediaId) : '',
    title: String(r.bookTitle ?? r.liTitle ?? ''),
    author: r.author != null ? String(r.author) : null,
    asin: r.asin != null && String(r.asin) !== '' ? String(r.asin) : null,
    isbn: r.isbn != null && String(r.isbn) !== '' ? String(r.isbn) : null,
    ino: r.ino != null && String(r.ino) !== '' ? String(r.ino) : null,
    isPodcast: String(r.mediaType) === 'podcast',
  }))

  // Progress rows. lastUpdate from updatedAt (epoch ms).
  const progRes = await c.execute(
    `SELECT userId, mediaItemId, mediaItemType, isFinished, finishedAt, currentTime,
            ebookLocation, ebookProgress, hideFromContinueListening, updatedAt
       FROM mediaProgresses`,
  )
  const progress = progRes.rows.map((r) => ({
    userId: String(r.userId),
    mediaItemId: String(r.mediaItemId),
    mediaItemType: r.mediaItemType != null ? String(r.mediaItemType) : 'book',
    isFinished: Boolean(r.isFinished),
    finishedAt: toMs(r.finishedAt),
    currentTime: Number(r.currentTime) || 0,
    ebookLocation: r.ebookLocation != null ? String(r.ebookLocation) : null,
    ebookProgress: r.ebookProgress != null ? Number(r.ebookProgress) : null,
    hideFromContinueListening: Boolean(r.hideFromContinueListening),
    lastUpdate: toMs(r.updatedAt) ?? 0,
  }))

  // Bookmarks live as a JSON array on each user row.
  const bmRes = await c.execute(`SELECT id AS userId, bookmarks FROM users WHERE bookmarks IS NOT NULL`)
  const bookmarks = []
  for (const r of bmRes.rows) {
    let arr = null
    try {
      arr = JSON.parse(String(r.bookmarks ?? '[]'))
    } catch {
      arr = null
    }
    if (!Array.isArray(arr)) continue
    for (const b of arr) {
      if (!b?.libraryItemId) continue
      bookmarks.push({
        userId: String(r.userId),
        libraryItemId: String(b.libraryItemId),
        time: Number(b.time) || 0,
        title: b.title != null ? String(b.title) : '',
        createdAt: toMs(b.createdAt),
      })
    }
  }

  return { users, items, progress, bookmarks }
}

// --- Small in-memory TTL cache -------------------------------------------
//
// playbackSessions has NO secondary indexes and the db is read-only (we cannot
// add any), so the leaderboard/finished-users scans are relatively expensive.
// A short TTL cache keyed by function+args collapses bursts (a Stats page load,
// a shelf render) into one scan. Returns clones are unnecessary - callers treat
// results as read-only.
const CACHE_TTL_MS = 45 * 1000
// Bound the cache so caller-controlled key material (id lists, item ids) can't
// grow it without limit over the process lifetime. Well above the working set a
// few concurrent Stats/shelf renders produce; entries also expire by TTL.
const CACHE_MAX_ENTRIES = 500
const cache = new Map() // key -> { at, value }

async function cached(key, produce) {
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value
  const value = await produce()
  cache.set(key, { at: now, value })
  // Sweep expired entries, then evict oldest-first until under the cap. Map
  // preserves insertion order, so the first keys are the oldest inserts.
  for (const [k, v] of cache) {
    if (now - v.at >= CACHE_TTL_MS) cache.delete(k)
  }
  if (cache.size > CACHE_MAX_ENTRIES) {
    const overflow = cache.size - CACHE_MAX_ENTRIES
    let removed = 0
    for (const k of cache.keys()) {
      if (removed >= overflow) break
      cache.delete(k)
      removed++
    }
  }
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
// Returns the FULL ranked set (no display LIMIT) so the route can privacy-filter
// BEFORE truncating to the top N - otherwise opted-out users would consume slots
// and the caller's own row could fall off the visible page. User counts are
// small; an internal safety cap (2000) guards against a pathological instance.
// Returns [] on any failure so callers can treat "unavailable" and "empty" alike.
const LEADERBOARD_INTERNAL_CAP = 2000
export async function getLeaderboard({ window = 'all' } = {}) {
  const c = await ensureClient()
  if (!c) return []
  return cached(`leaderboard:${window}`, async () => {
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
      return entries.slice(0, LEADERBOARD_INTERNAL_CAP)
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

// --- Listening-now presence ------------------------------------------------
//
// Who is actively listening to a book right now-ish, derived ONLY from
// playbackSessions.updatedAt (server-sync-driven, moves forward as ABS records
// listen time) - never mediaProgresses.updatedAt, which the client can set
// arbitrarily (even backwards). The item is resolved from the session's
// extraData.libraryItemId (present on modern sessions), falling back to the
// libraryItems.mediaId hop for older rows whose extraData lacks it.
//
// playbackSessions.updatedAt is a Sequelize DATE stored as text. There is no
// datetime()-safe cutoff we can trust across shapes, so we compare
// lexicographically against a cutoff string built in the SAME textual shape as a
// real stored value: probe one updatedAt, discover its format, and format the
// cutoff to match. If the probe fails (no rows, or an unrecognised shape),
// presence just hides ([]).
//
// Guests/inactive users excluded; books only. TTL-cached like getLeaderboard.

let listenFormat = null // null=unprobed, false=unusable, or a formatter fn(Date)->string

// Probe one playbackSessions.updatedAt and return a formatter that renders a JS
// Date as a cutoff string in the SAME textual shape, for a lexicographic >=.
// ABS/Sequelize stores DATE either as ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' or as
// 'YYYY-MM-DD HH:MM:SS.sss +00:00' depending on dialect/version. Both are
// lexicographically ordered by the leading 'YYYY-MM-DD HH:MM:SS' prefix, so we
// only need to match the date/time separator (T vs space). Returns false if the
// stored text isn't a recognised leading-timestamp shape.
async function probeListenFormat(c) {
  if (listenFormat !== null) return listenFormat
  try {
    const res = await c.execute(`
      SELECT updatedAt FROM playbackSessions
      WHERE updatedAt IS NOT NULL
      LIMIT 1
    `)
    const sample = res.rows[0]?.updatedAt
    if (sample == null) return (listenFormat = false)
    const text = String(sample)
    // Must lead with YYYY-MM-DD then a 'T' or ' ' separator then HH:MM:SS.
    const m = /^\d{4}-\d{2}-\d{2}([T ])\d{2}:\d{2}:\d{2}/.exec(text)
    if (!m) return (listenFormat = false)
    const sep = m[1] // 'T' (ISO) or ' ' (space-separated)
    listenFormat = (date) => {
      // 'YYYY-MM-DDTHH:MM:SS' in UTC; the fractional/zone tail is irrelevant to a
      // >= compare on a prefix, and a truncated cutoff still bounds correctly.
      const iso = date.toISOString().slice(0, 19) // 'YYYY-MM-DDTHH:MM:SS'
      return sep === ' ' ? iso.replace('T', ' ') : iso
    }
    return listenFormat
  } catch {
    return (listenFormat = false)
  }
}

// For each of the given library items, the eligible users whose latest playback
// session updated within cutoffMs. Returns [] on any failure or when the date
// format can't be probed. Bounded by the id set; the whole result is TTL-cached
// per (sorted ids, cutoff bucket) so a shelf render collapses into one scan.
export async function getActiveListeners(libraryItemIds = [], cutoffMs = 3 * 60 * 1000) {
  const ids = [...new Set(libraryItemIds.filter(Boolean))]
  if (!ids.length) return []
  const c = await ensureClient()
  if (!c) return []
  // Bucket the cutoff to the cache TTL so keys are stable within a window.
  const bucket = Math.floor(Date.now() / CACHE_TTL_MS)
  return cached(`activeListeners:${bucket}:${cutoffMs}:${[...ids].sort().join(',')}`, async () => {
    const fmt = await probeListenFormat(c)
    if (!fmt) return []
    const cutoff = fmt(new Date(Date.now() - cutoffMs))
    try {
      const placeholders = ids.map(() => '?').join(', ')
      // Resolve each session's library item two ways and union: the direct
      // extraData.libraryItemId, and (for older sessions without it) the
      // mediaId hop through libraryItems. Only book sessions, eligible users,
      // and rows updated since the cutoff.
      const res = await c.execute({
        sql: `
          SELECT DISTINCT libraryItemId, userId, username FROM (
            SELECT json_extract(ps.extraData, '$.libraryItemId') AS libraryItemId,
                   u.id AS userId, u.username AS username
            FROM playbackSessions ps
            JOIN users u ON u.id = ps.userId
            WHERE ps.mediaItemType = 'book'
              AND ps.updatedAt >= ?
              AND u.type != 'guest'
              AND u.isActive = 1
              AND json_extract(ps.extraData, '$.libraryItemId') IN (${placeholders})
            UNION
            SELECT li.id AS libraryItemId, u.id AS userId, u.username AS username
            FROM playbackSessions ps
            JOIN users u ON u.id = ps.userId
            JOIN libraryItems li ON li.mediaId = ps.mediaItemId AND li.mediaType = 'book'
            WHERE ps.mediaItemType = 'book'
              AND ps.updatedAt >= ?
              AND u.type != 'guest'
              AND u.isActive = 1
              AND li.id IN (${placeholders})
          )
        `,
        args: [cutoff, ...ids, cutoff, ...ids],
      })
      const out = []
      for (const row of res.rows) {
        const libraryItemId = row.libraryItemId == null ? '' : String(row.libraryItemId)
        if (!libraryItemId) continue
        out.push({
          libraryItemId,
          userId: String(row.userId),
          username: String(row.username ?? ''),
        })
      }
      return out
    } catch {
      return []
    }
  })
}

// --- Per-book progress (for clubs + the notes finished-bypass) -------------

// Per-member progress in one library item, from mediaProgresses (same media-id
// hop as the finished queries). Returns a Map userId -> { currentTime, duration,
// isFinished, updatedAt } for the requested users who have a progress row.
// Missing users are absent (callers default to null). Returns an empty Map on
// any failure. Not cached: club detail is a per-request read of a small set.
export async function getMemberProgress(userIds = [], libraryItemId) {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (!ids.length || !libraryItemId) return new Map()
  const c = await ensureClient()
  if (!c) return new Map()
  try {
    const placeholders = ids.map(() => '?').join(', ')
    const res = await c.execute({
      sql: `
        SELECT mp.userId AS userId, mp.currentTime AS currentTime,
               mp.duration AS duration, mp.isFinished AS isFinished,
               mp.updatedAt AS updatedAt
        FROM libraryItems li
        JOIN mediaProgresses mp
          ON mp.mediaItemId = li.mediaId AND mp.mediaItemType = 'book'
        WHERE li.id = ? AND li.mediaType = 'book'
          AND mp.userId IN (${placeholders})
      `,
      args: [libraryItemId, ...ids],
    })
    const out = new Map()
    for (const row of res.rows) {
      const raw = row.updatedAt
      const ms = raw != null ? Date.parse(String(raw)) : NaN
      out.set(String(row.userId), {
        currentTime: row.currentTime == null ? null : Number(row.currentTime),
        duration: row.duration == null ? null : Number(row.duration),
        isFinished: Boolean(row.isFinished),
        updatedAt: Number.isNaN(ms) ? null : ms,
      })
    }
    return out
  } catch {
    return new Map()
  }
}

// The caller's own progress in one library item: { currentTime, duration,
// isFinished } or null when there's no row (or the db is unavailable). Used for
// the notes finished-bypass and the position clamp.
export async function getSelfProgress(userId, libraryItemId) {
  if (!userId || !libraryItemId) return null
  const c = await ensureClient()
  if (!c) return null
  try {
    const res = await c.execute({
      sql: `
        SELECT mp.currentTime AS currentTime, mp.duration AS duration,
               mp.isFinished AS isFinished
        FROM libraryItems li
        JOIN mediaProgresses mp
          ON mp.mediaItemId = li.mediaId AND mp.mediaItemType = 'book'
        WHERE li.id = ? AND li.mediaType = 'book' AND mp.userId = ?
        LIMIT 1
      `,
      args: [libraryItemId, userId],
    })
    const row = res.rows[0]
    if (!row) return null
    return {
      currentTime: row.currentTime == null ? null : Number(row.currentTime),
      duration: row.duration == null ? null : Number(row.duration),
      isFinished: Boolean(row.isFinished),
    }
  } catch {
    return null
  }
}

// Aggregate the genres of every book the given users have FINISHED, into a
// { genre -> count } map. Drives the club "all members' finished books"
// recommendation basis: one book finished by two members counts its genres
// twice, so genres the whole club reads rise to the top. Genres are a JSON text
// array on books.genres; SQLite has no portable JSON-array unnest we can rely
// on across libSQL versions, so we read the raw JSON per finished row and count
// in JS (the finished set for a handful of members is small). Guests/inactive
// users are excluded, matching the leaderboard. Returns {} on any failure or
// when the db isn't mounted. Not cached: recommendation is a deliberate action.
export async function getFinishedGenresForUsers(userIds = []) {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (!ids.length) return {}
  const c = await ensureClient()
  if (!c) return {}
  try {
    const placeholders = ids.map(() => '?').join(', ')
    const res = await c.execute({
      sql: `
        SELECT b.genres AS genres
        FROM mediaProgresses mp
        JOIN books b ON b.id = mp.mediaItemId
        JOIN users u ON u.id = mp.userId
        WHERE mp.isFinished = 1
          AND mp.mediaItemType = 'book'
          AND mp.userId IN (${placeholders})
          AND u.type != 'guest'
          AND u.isActive = 1
      `,
      args: ids,
    })
    const counts = {}
    for (const row of res.rows) {
      const raw = row.genres
      if (raw == null) continue
      let list
      try {
        list = typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch {
        continue
      }
      if (!Array.isArray(list)) continue
      for (const g of list) {
        if (typeof g !== 'string' || !g) continue
        counts[g] = (counts[g] || 0) + 1
      }
    }
    return counts
  } catch {
    return {}
  }
}

// A book's chapter list (books.chapters JSON), so notes can render
// "Chapter 14 - 1:02:05" on clients that don't hold the chapter list. Resolved
// via the libraryItems.mediaId hop. Returns [] on any failure or when absent.
export async function getChapters(libraryItemId) {
  if (!libraryItemId) return []
  const c = await ensureClient()
  if (!c) return []
  return cached(`chapters:${libraryItemId}`, async () => {
    try {
      const res = await c.execute({
        sql: `
          SELECT b.chapters AS chapters
          FROM libraryItems li
          JOIN books b ON b.id = li.mediaId
          WHERE li.id = ? AND li.mediaType = 'book'
          LIMIT 1
        `,
        args: [libraryItemId],
      })
      const raw = res.rows[0]?.chapters
      if (raw == null) return []
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })
}

// --- Series enumeration (for the series-roster job) ------------------------
//
// The whole library's series membership, read straight from ABS's own tables so
// a background job can enumerate every series and the books owned in each WITHOUT
// any user token or per-item API call. ABS stores series membership in the
// bookSeries join (bookId, seriesId, sequence), the series name in series.name,
// and each book's Audible id in books.asin - so we can compute a library-wide
// "owned" fact (does the library hold this ASIN / this sequence / this title in
// the series) that isn't per-user.

// Every distinct series in the library: { seriesId, name }. Ordered by name.
// [] on any failure or when the ABS db isn't mounted.
export async function getAllSeries() {
  const c = await ensureClient()
  if (!c) return []
  try {
    const res = await c.execute(`
      SELECT DISTINCT s.id AS seriesId, s.name AS name
      FROM series s
      JOIN bookSeries bs ON bs.seriesId = s.id
      WHERE s.name IS NOT NULL AND s.name != ''
      ORDER BY s.name
    `)
    return res.rows.map((r) => ({ seriesId: String(r.seriesId), name: String(r.name) }))
  } catch {
    return []
  }
}

// The books the library owns in one series: { asin, title, sequence }. asin/title
// may be '' when ABS has none. sequence is ABS's bookSeries.sequence (a string,
// e.g. "4" or "2.5") or ''. [] on any failure.
export async function getOwnedSeriesBooks(seriesId) {
  if (!seriesId) return []
  const c = await ensureClient()
  if (!c) return []
  try {
    const res = await c.execute({
      sql: `
        SELECT b.asin AS asin, b.title AS title, bs.sequence AS sequence
        FROM bookSeries bs
        JOIN books b ON b.id = bs.bookId
        WHERE bs.seriesId = ?
      `,
      args: [seriesId],
    })
    return res.rows.map((r) => ({
      asin: r.asin == null ? '' : String(r.asin),
      title: r.title == null ? '' : String(r.title),
      sequence: r.sequence == null ? '' : String(r.sequence),
    }))
  } catch {
    return []
  }
}

export const ABS_DB_PATH_RESOLVED = ABS_DB_PATH
