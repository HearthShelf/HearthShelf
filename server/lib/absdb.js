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
import { appLog } from './appLog.js'

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
    // Wait-and-retry for a lock instead of failing instantly with SQLITE_BUSY.
    // ABS is the sole writer of this db and syncs progress from every device; our
    // read scans (leaderboard, presence, member progress) must not fail-fast and
    // thrash when they land during an ABS write. 5s matches our own hearthshelf.db
    // busy_timeout. query_only stays ON so we still can never write.
    await c.execute('PRAGMA busy_timeout = 5000')
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
  await c.execute('PRAGMA busy_timeout = 5000')
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
  const usersRes = await c.execute(`SELECT id, username, email, type, isActive FROM users`)
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
  const bmRes = await c.execute(
    `SELECT id AS userId, bookmarks FROM users WHERE bookmarks IS NOT NULL`,
  )
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

// Read THIS server's own inventory (the merge target) via the configured
// read-only client. Returns null when the ABS db isn't mounted (the import
// feature then reports unavailable, like the social features).
export async function readTargetInventory() {
  const c = await ensureClient()
  if (!c) return null
  return readImportInventory(c)
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

// Week starts Sunday, matching the DAY_LABELS order the stats UIs render.
const WEEK_STARTS_ON = 0

// 'YYYY-MM-DD' for a Date's LOCAL calendar day. Deliberately not toISOString(),
// which would shift the day across the UTC boundary for any non-UTC server.
function localDateKey(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 'YYYY-MM-DD' cutoff for the start of the current CALENDAR period, or null for
// all-time. These are calendar periods, not rolling windows: 'month' is the 1st
// of the current month and 'week' is the most recent week start - "this month"
// and "last 30 days" are different metrics and the UI pills say the former.
//
// The cutoff is a LOCAL calendar date because that is the only granularity both
// windowed columns share: playbackSessions.date is a plain 'YYYY-MM-DD' TEXT
// day with no time component, so an instant-precise cutoff is not expressible
// against it. Comparing a local day key to those columns can therefore be off
// by at most one boundary day on a server far from UTC - accepted, since the
// alternative (a UTC instant) is wrong for every day of the period, not one.
function windowCutoff(window) {
  const now = new Date()
  if (window === 'month') {
    return localDateKey(new Date(now.getFullYear(), now.getMonth(), 1))
  }
  if (window === 'week') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const back = (start.getDay() - WEEK_STARTS_ON + 7) % 7
    start.setDate(start.getDate() - back)
    return localDateKey(start)
  }
  return null
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
// `window`: 'week' (current calendar week, from Sunday), 'month' (current
// calendar month, from the 1st), or 'all' (default). Period starts are server
// LOCAL calendar dates - see windowCutoff. Windowing is a lexicographic compare
// against ABS's date columns; if the boot-time format probe fails, we serve
// all-time regardless of
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

      // Rank by time listened in the window, with books finished as the
      // tiebreak. Time is what the row's headline number shows, so ranking on
      // anything else reads as broken (a 16h user sitting below a 52m one).
      const entries = [...byUser.values()]
      entries.sort(
        (a, b) => b.secondsListened - a.secondsListened || b.booksFinished - a.booksFinished,
      )
      return entries.slice(0, LEADERBOARD_INTERNAL_CAP)
    } catch {
      return []
    }
  })
}

// How many distinct books one user has finished, optionally only those finished
// on/after `sinceDate` ('YYYY-MM-DD'). Same isFinished/book filter as the
// leaderboard, scoped to one user. The window is a lexicographic compare on
// finishedAt (never datetime()) - safe against ABS's DATE text shape, matching
// the leaderboard windowing. Returns 0 on any failure or when the db isn't
// mounted (callers degrade the field to null then). Cached by (user, since).
export async function getFinishedCountForUser(userId, sinceDate = null) {
  if (!userId) return 0
  const c = await ensureClient()
  if (!c) return 0
  return cached(`finishedForUser:${userId}:${sinceDate ?? ''}`, async () => {
    try {
      const sql = sinceDate
        ? `SELECT COUNT(*) AS n FROM mediaProgresses
           WHERE userId = ? AND isFinished = 1 AND mediaItemType = 'book'
             AND finishedAt >= ?`
        : `SELECT COUNT(*) AS n FROM mediaProgresses
           WHERE userId = ? AND isFinished = 1 AND mediaItemType = 'book'`
      const res = await c.execute({
        sql,
        args: sinceDate ? [userId, sinceDate] : [userId],
      })
      return Number(res.rows[0]?.n) || 0
    } catch {
      return 0
    }
  })
}

// --- Stats highlights (for /hs/stats) --------------------------------------
//
// Personal "highlight" badges over a user's FINISHED books, all from a direct db
// read (needs the read-only db mounted; degrade to null on a slim install).
// Books only; the caller's own finishes. Cached per user.

// The user's longest + shortest FINISHED book by canonical length (books.duration,
// FLOAT seconds - the book's length, not the per-user progress duration). Each is
// { title, durationSec } or null (no finished book with a positive duration).
export async function getFinishedExtremesForUser(userId) {
  if (!userId) return { longest: null, shortest: null }
  const c = await ensureClient()
  if (!c) return { longest: null, shortest: null }
  return cached(`finishedExtremes:${userId}`, async () => {
    try {
      const res = await c.execute({
        sql: `SELECT b.title AS title, b.duration AS dur, li.id AS libraryItemId
                FROM mediaProgresses mp
                JOIN books b ON b.id = mp.mediaItemId
                LEFT JOIN libraryItems li ON li.mediaId = b.id
               WHERE mp.userId = ? AND mp.isFinished = 1
                 AND mp.mediaItemType = 'book' AND b.duration > 0
               ORDER BY b.duration`,
        args: [userId],
      })
      const rows = res.rows
      if (!rows.length) return { longest: null, shortest: null }
      const mk = (r) => ({
        title: String(r.title ?? ''),
        durationSec: Number(r.dur) || 0,
        libraryItemId: r.libraryItemId != null ? String(r.libraryItemId) : null,
      })
      return { shortest: mk(rows[0]), longest: mk(rows[rows.length - 1]) }
    } catch {
      return { longest: null, shortest: null }
    }
  })
}

// The author the user has FINISHED the most books by, as { name, count } or null.
// Author via the bookAuthors join (matching readImportInventory's join). A book
// with multiple authors counts toward each.
export async function getTopFinishedAuthorForUser(userId) {
  if (!userId) return null
  const c = await ensureClient()
  if (!c) return null
  return cached(`topFinishedAuthor:${userId}`, async () => {
    try {
      const res = await c.execute({
        sql: `SELECT a.name AS name, COUNT(*) AS n
                FROM mediaProgresses mp
                JOIN books b ON b.id = mp.mediaItemId
                JOIN bookAuthors ba ON ba.bookId = b.id
                JOIN authors a ON a.id = ba.authorId
               WHERE mp.userId = ? AND mp.isFinished = 1 AND mp.mediaItemType = 'book'
               GROUP BY a.name
               ORDER BY n DESC
               LIMIT 1`,
        args: [userId],
      })
      const row = res.rows[0]
      if (!row || !row.name) return null
      return { name: String(row.name), count: Number(row.n) || 0 }
    } catch {
      return null
    }
  })
}

// The narrator the user has FINISHED the most books by, as { name, count } or
// null. Narrators are a JSON string array on books.narrators (like books.genres),
// so parse-and-count in JS - same shape as getFinishedGenresForUsers. A book with
// multiple narrators counts toward each.
export async function getTopFinishedNarratorForUser(userId) {
  if (!userId) return null
  const c = await ensureClient()
  if (!c) return null
  return cached(`topFinishedNarrator:${userId}`, async () => {
    try {
      const res = await c.execute({
        sql: `SELECT b.narrators AS narrators
                FROM mediaProgresses mp
                JOIN books b ON b.id = mp.mediaItemId
               WHERE mp.userId = ? AND mp.isFinished = 1 AND mp.mediaItemType = 'book'`,
        args: [userId],
      })
      const counts = new Map()
      for (const row of res.rows) {
        const raw = row.narrators
        if (raw == null) continue
        let list
        try {
          list = typeof raw === 'string' ? JSON.parse(raw) : raw
        } catch {
          continue
        }
        if (!Array.isArray(list)) continue
        for (const name of list) {
          if (typeof name !== 'string' || !name) continue
          counts.set(name, (counts.get(name) || 0) + 1)
        }
      }
      let best = null
      for (const [name, count] of counts) {
        if (!best || count > best.count) best = { name, count }
      }
      return best
    } catch {
      return null
    }
  })
}

// Resolve a book by its media id (books.id, = mediaProgresses.mediaItemId) to its
// title + canonical length + owning library-item id, for the "most re-read"
// highlight badge (bookCompletionsStore stores only the media id). libraryItemId
// lets the client render a cover; it's the newest libraryItems row that points at
// this book (a book is normally owned once). Returns null when the db isn't
// mounted or the book no longer exists in the library. Cached per media id.
export async function getBookByMediaId(mediaItemId) {
  if (!mediaItemId) return null
  const c = await ensureClient()
  if (!c) return null
  return cached(`bookByMediaId:${mediaItemId}`, async () => {
    try {
      const res = await c.execute({
        sql: `SELECT b.title AS title, b.duration AS dur,
                     (SELECT li.id FROM libraryItems li
                       WHERE li.mediaId = b.id AND li.mediaType = 'book'
                       LIMIT 1) AS libraryItemId
                FROM books b
               WHERE b.id = ?
               LIMIT 1`,
        args: [String(mediaItemId)],
      })
      const row = res.rows[0]
      if (!row) return null
      return {
        title: String(row.title ?? ''),
        durationSec: Number(row.dur) || 0,
        libraryItemId: row.libraryItemId == null ? null : String(row.libraryItemId),
      }
    } catch {
      return null
    }
  })
}

// Resolve MANY media ids to their book row in one query, keyed by media id.
//
// The single-id getBookByMediaId above is fine for a highlight badge, but a
// paginated finished-books list would call it once per row - an N+1 against the
// ABS db for every page. Same media-id -> libraryItems hop, plus the author name
// a list row needs. Ids not present in the library are simply absent from the
// result, so callers can tell "left the library" from "never finished".
// Returns {} on any failure or when the db isn't mounted.
export async function getBooksByMediaIdsBulk(mediaItemIds = []) {
  const ids = [...new Set(mediaItemIds.filter(Boolean))].map(String)
  if (!ids.length) return {}
  const c = await ensureClient()
  if (!c) return {}
  try {
    const placeholders = ids.map(() => '?').join(', ')
    const res = await c.execute({
      sql: `
        SELECT b.id AS mediaId, b.title AS title, b.duration AS dur,
               (SELECT li.id FROM libraryItems li
                 WHERE li.mediaId = b.id AND li.mediaType = 'book'
                 LIMIT 1) AS libraryItemId,
               (SELECT a.name FROM authors a
                  JOIN bookAuthors ba ON ba.authorId = a.id
                 WHERE ba.bookId = b.id LIMIT 1) AS authorName
          FROM books b
         WHERE b.id IN (${placeholders})
      `,
      args: ids,
    })
    const out = {}
    for (const row of res.rows) {
      out[String(row.mediaId)] = {
        title: String(row.title ?? ''),
        author: row.authorName == null ? '' : String(row.authorName),
        durationSec: Number(row.dur) || 0,
        libraryItemId: row.libraryItemId == null ? null : String(row.libraryItemId),
      }
    }
    return out
  } catch {
    return {}
  }
}

// --- Daily listening aggregates (for the stats-snapshot job) ---------------
//
// Per (user, day) listening totals for the snapshot job, over the recent window
// only (playbackSessions has no index; a full-table scan is bounded by reading
// just the last N days). date is ABS's own 'YYYY-MM-DD' day bucket, so the
// windowing is a lexicographic >= compare (never datetime()), matching the
// leaderboard. Books only; guests/inactive excluded to match every other
// cross-user read. Returns [] on any failure or when the db isn't mounted.
export async function getDailyListening(sinceDate) {
  const c = await ensureClient()
  if (!c) return []
  try {
    const res = await c.execute({
      sql: `
        SELECT ps.userId AS userId, ps.date AS date,
               SUM(ps.timeListening) AS seconds, COUNT(*) AS sessions
        FROM playbackSessions ps
        JOIN users u ON u.id = ps.userId
        WHERE ps.mediaItemType = 'book'
          AND ps.date >= ?
          AND u.type != 'guest'
          AND u.isActive = 1
        GROUP BY ps.userId, ps.date
      `,
      args: [String(sinceDate)],
    })
    return res.rows.map((r) => ({
      userId: String(r.userId),
      date: String(r.date),
      seconds: Number(r.seconds) || 0,
      sessions: Number(r.sessions) || 0,
    }))
  } catch {
    return []
  }
}

// Per (user, day) count of distinct books FINISHED on that day, over the recent
// window. finishedAt is a DATE text; we bucket by its leading 'YYYY-MM-DD' via
// substr (not datetime()) so the day key lines up with playbackSessions.date,
// and window with a lexicographic >= on the same prefix. Books only;
// guests/inactive excluded. Returns [] on any failure / when unmounted.
export async function getDailyFinished(sinceDate) {
  const c = await ensureClient()
  if (!c) return []
  try {
    const res = await c.execute({
      sql: `
        SELECT mp.userId AS userId,
               substr(mp.finishedAt, 1, 10) AS date,
               COUNT(*) AS finished
        FROM mediaProgresses mp
        JOIN users u ON u.id = mp.userId
        WHERE mp.isFinished = 1
          AND mp.mediaItemType = 'book'
          AND mp.finishedAt IS NOT NULL
          AND substr(mp.finishedAt, 1, 10) >= ?
          AND u.type != 'guest'
          AND u.isActive = 1
        GROUP BY mp.userId, substr(mp.finishedAt, 1, 10)
      `,
      args: [String(sinceDate)],
    })
    return res.rows.map((r) => ({
      userId: String(r.userId),
      date: String(r.date),
      finished: Number(r.finished) || 0,
    }))
  } catch {
    return []
  }
}

// Current per-(user, book) finish state for every finished book on the server,
// for the completion-tracking snapshot (jobs/statsSnapshot.js -> book_completions).
// ABS overwrites mediaProgresses.finishedAt on a re-finish and keeps no completion
// count, so re-reads aren't derivable from a single read - the snapshot compares
// THIS current state against the durable state HS stored last night to detect a
// new completion (a book that flipped unfinished->finished, or whose finishedAt
// moved forward while finished). We therefore need the FULL finished set, not a
// recent window: any book, finished long ago, can be re-finished today.
//
// finishedAt is returned as a ms epoch (Date.parse of ABS's DATE text), null when
// unparseable - the job compares epochs, never the raw text. Books only;
// guests/inactive excluded to match every other cross-user read. [] on any
// failure / when the db isn't mounted. Not cached: the nightly job is the only
// caller and wants a fresh read.
export async function getFinishStates() {
  const c = await ensureClient()
  if (!c) return []
  try {
    const res = await c.execute(`
      SELECT mp.userId AS userId, mp.mediaItemId AS mediaItemId,
             mp.finishedAt AS finishedAt
      FROM mediaProgresses mp
      JOIN users u ON u.id = mp.userId
      WHERE mp.isFinished = 1
        AND mp.mediaItemType = 'book'
        AND u.type != 'guest'
        AND u.isActive = 1
    `)
    return res.rows.map((r) => {
      const raw = r.finishedAt
      const ms = raw != null ? Date.parse(String(raw)) : NaN
      return {
        userId: String(r.userId),
        mediaItemId: String(r.mediaItemId),
        finishedAt: Number.isNaN(ms) ? null : ms,
      }
    })
  } catch {
    return []
  }
}

// --- Compare (for /hs/social/compare) --------------------------------------
//
// One user's comparable totals: books finished (all-time), seconds listened
// (all-time), distinct active days (distinct playbackSessions.date), average
// seconds per active day, and books finished this year (when `yearStart`, a
// 'YYYY-01-01' cutoff, is given). Books only; the caller passes their own or an
// opted-in user's id (the route gates which users are askable via the leaderboard
// privacy roster - this reader is identity-neutral). null when the db isn't
// mounted. Cached per (user, yearStart).
export async function getUserCompareStats(userId, yearStart = null) {
  if (!userId) return null
  const c = await ensureClient()
  if (!c) return null
  return cached(`compareUser:${userId}:${yearStart ?? ''}`, async () => {
    try {
      const [finishedRes, listenRes, yearRes] = await Promise.all([
        c.execute({
          sql: `SELECT COUNT(*) AS n FROM mediaProgresses
                WHERE userId = ? AND isFinished = 1 AND mediaItemType = 'book'`,
          args: [userId],
        }),
        c.execute({
          sql: `SELECT SUM(timeListening) AS secs, COUNT(DISTINCT date) AS days
                FROM playbackSessions
                WHERE userId = ? AND mediaItemType = 'book'`,
          args: [userId],
        }),
        // Books finished since Jan 1 of the caller's local year (lexicographic
        // compare on finishedAt, matching getFinishedCountForUser's windowing).
        yearStart
          ? c.execute({
              sql: `SELECT COUNT(*) AS n FROM mediaProgresses
                    WHERE userId = ? AND isFinished = 1 AND mediaItemType = 'book'
                      AND finishedAt >= ?`,
              args: [userId, yearStart],
            })
          : Promise.resolve({ rows: [{ n: null }] }),
      ])
      const secs = Number(listenRes.rows[0]?.secs) || 0
      const days = Number(listenRes.rows[0]?.days) || 0
      const yearN = yearRes.rows[0]?.n
      return {
        booksFinished: Number(finishedRes.rows[0]?.n) || 0,
        secondsListened: secs,
        activeDays: days,
        avgPerActiveDaySec: days ? secs / days : 0,
        booksThisYear: yearN == null ? null : Number(yearN) || 0,
      }
    } catch {
      return null
    }
  })
}

// --- Profile (for /hs/social/profile) ---------------------------------------
//
// One user's most recent book session, resolved to a real library item so the
// profile can render it as a hero. Derived from playbackSessions.updatedAt (the
// same server-sync-driven column getActiveListeners trusts - never
// mediaProgresses.updatedAt, which a client can set arbitrarily). `isLive` is
// true when that session updated within cutoffMs, so one query answers both
// "listening right now" and "last listened to". The item is resolved the same
// two ways as getActiveListeners: extraData.libraryItemId, falling back to the
// libraryItems.mediaId hop for older rows. Progress comes from mediaProgresses
// for that item, so the hero can show how far along they are.
//
// Identity-neutral: the ROUTE decides whether the caller may see this (the
// shareCurrentlyListening gate). null when the db isn't mounted, the user has no
// book session, or the date-format probe fails.
export async function getUserCurrentListen(userId, cutoffMs = 3 * 60 * 1000) {
  if (!userId) return null
  const c = await ensureClient()
  if (!c) return null
  const bucket = Math.floor(Date.now() / CACHE_TTL_MS)
  return cached(`currentListen:${bucket}:${userId}:${cutoffMs}`, async () => {
    // NOTE: the date-format probe is deliberately NOT a gate here. It's only
    // needed to decide isLive; failing it must still return the last listen
    // (with isLive false), or a box whose updatedAt text we can't parse would
    // show every profile as "Nothing playing" forever - and the probe result is
    // cached process-wide, so one odd sample would poison every user.
    const fmt = await probeListenFormat(c)
    try {
      // Resolving a session to a library item, robustly. Two traps here, both
      // of which silently emptied this query before:
      //
      // 1. json_extract() raises "malformed JSON" and aborts the WHOLE query if
      //    ANY scanned row has non-JSON extraData (an empty string is enough).
      //    A `json_valid(e) AND json_extract(e, ...)` guard does NOT save you:
      //    SQLite doesn't promise to short-circuit AND/OR, and in practice it
      //    still evaluates the extract. CASE WHEN *does* guarantee order, so
      //    every json_extract here is wrapped in one.
      // 2. json_valid(NULL) is NULL, not 0 - so `NOT json_valid(e)` is NULL for
      //    a NULL extraData, and a NULL predicate is not true, which dropped
      //    every legacy row. Compare with `IS NOT 1` instead of NOT.
      //
      // One coalesced expression resolves the item both ways, so a row is never
      // matched by neither branch: prefer extraData.libraryItemId when it's
      // safely readable, else hop through libraryItems.mediaId.
      const res = await c.execute({
        sql: `
          SELECT libraryItemId, updatedAt FROM (
            SELECT
              COALESCE(
                CASE WHEN json_valid(ps.extraData) = 1
                     THEN json_extract(ps.extraData, '$.libraryItemId')
                END,
                li.id
              ) AS libraryItemId,
              ps.updatedAt AS updatedAt
            FROM playbackSessions ps
            LEFT JOIN libraryItems li
              ON li.mediaId = ps.mediaItemId AND li.mediaType = 'book'
            WHERE ps.userId = ? AND ps.mediaItemType = 'book'
          )
          WHERE libraryItemId IS NOT NULL
          ORDER BY updatedAt DESC
          LIMIT 1
        `,
        args: [userId],
      })
      const row = res.rows[0]
      if (!row) {
        // Not an error - the user may genuinely have no book sessions. Logged
        // because "Nothing playing" for someone with recorded hours is the
        // symptom we keep chasing, and this says which layer came up empty.
        appLog.info('absdb', `currentListen: no resolvable book session for user ${userId}`)
        return null
      }
      const libraryItemId = row.libraryItemId == null ? '' : String(row.libraryItemId)
      if (!libraryItemId) {
        appLog.warn('absdb', `currentListen: session resolved to an empty item id for user ${userId}`)
        return null
      }

      // Title/author/progress for the hero. A missing item (deleted since the
      // session) still returns the session shell; the UI falls back to a
      // typeset cover.
      const meta = await c.execute({
        sql: `
          SELECT b.title AS title, b.narrators AS narrators,
                 b.duration AS bookDuration,
                 mp.currentTime AS currentTime, mp.duration AS progressDuration,
                 mp.isFinished AS isFinished
          FROM libraryItems li
          JOIN books b ON b.id = li.mediaId
          LEFT JOIN mediaProgresses mp
            ON mp.mediaItemId = li.mediaId AND mp.mediaItemType = 'book' AND mp.userId = ?
          WHERE li.id = ? AND li.mediaType = 'book'
          LIMIT 1
        `,
        args: [userId, libraryItemId],
      })
      const m = meta.rows[0] || {}
      const updatedMs = row.updatedAt != null ? Date.parse(String(row.updatedAt)) : NaN
      // Prefer a real parsed timestamp for the liveness check; fall back to the
      // lexicographic compare (in the column's own textual shape) only when the
      // text didn't parse. If neither works, isLive is simply false - we still
      // show the book as their last listen.
      let isLive = false
      if (!Number.isNaN(updatedMs)) {
        isLive = Date.now() - updatedMs <= cutoffMs
      } else if (fmt && row.updatedAt != null) {
        isLive = String(row.updatedAt) >= fmt(new Date(Date.now() - cutoffMs))
      }
      // mediaProgresses has NO `progress` column - ABS stores currentTime and a
      // per-user duration and derives the fraction. Prefer the progress row's
      // own duration (what ABS measured this user against); fall back to the
      // book's when the row is missing (never listened, or progress not synced).
      const currentTimeSec = Number(m.currentTime) || 0
      const durationSec = Number(m.progressDuration) || Number(m.bookDuration) || 0
      const isFinished = Number(m.isFinished) === 1
      const progress = isFinished
        ? 1
        : durationSec > 0
          ? Math.min(Math.max(currentTimeSec / durationSec, 0), 1)
          : 0
      return {
        libraryItemId,
        title: m.title == null ? '' : String(m.title),
        author: await getItemAuthorName(c, libraryItemId),
        narrator: parseFirstJsonName(m.narrators),
        durationSec,
        currentTimeSec,
        progress,
        isFinished,
        lastListenedAt: Number.isNaN(updatedMs) ? null : updatedMs,
        isLive,
      }
    } catch (err) {
      // NEVER swallow this silently. A bare `catch { return null }` here made
      // the profile hero read "Nothing playing" for a user with hundreds of
      // recorded hours, and hid the real SQL error through several rounds of
      // fixes. The feature still degrades (returns null) - but it says why.
      appLog.error('absdb', `currentListen failed for user ${userId}: ${err?.message ?? err}`)
      return null
    }
  })
}

// ABS stores books.narrators as a JSON array of plain strings. Return the first
// name, or '' when absent/unparseable.
function parseFirstJsonName(raw) {
  if (raw == null) return ''
  try {
    const arr = JSON.parse(String(raw))
    return Array.isArray(arr) && arr.length ? String(arr[0] ?? '') : ''
  } catch {
    return ''
  }
}

// Primary author name for a library item, via ABS's bookAuthors join table.
// '' when the item has no author row.
async function getItemAuthorName(c, libraryItemId) {
  try {
    const res = await c.execute({
      sql: `
        SELECT a.name AS name
        FROM libraryItems li
        JOIN bookAuthors ba ON ba.bookId = li.mediaId
        JOIN authors a ON a.id = ba.authorId
        WHERE li.id = ?
        LIMIT 1
      `,
      args: [libraryItemId],
    })
    return res.rows[0]?.name == null ? '' : String(res.rows[0].name)
  } catch {
    return ''
  }
}

// Every book a user has finished, newest finish first, resolved to library
// items so the profile can render covers and link through. Identity-neutral -
// the ROUTE gates this behind shareReadBooks. Capped so a heavy reader can't
// produce an unbounded response. [] on any failure or when the db isn't mounted.
const PROFILE_FINISHED_CAP = 500
export async function getUserFinishedBooks(userId, limit = PROFILE_FINISHED_CAP) {
  if (!userId) return []
  const c = await ensureClient()
  if (!c) return []
  const cap = Math.min(Math.max(Number(limit) || PROFILE_FINISHED_CAP, 1), PROFILE_FINISHED_CAP)
  return cached(`profileFinished:${userId}:${cap}`, async () => {
    try {
      const res = await c.execute({
        sql: `
          SELECT li.id AS libraryItemId, b.title AS title, mp.finishedAt AS finishedAt
          FROM mediaProgresses mp
          JOIN libraryItems li
            ON li.mediaId = mp.mediaItemId AND li.mediaType = 'book'
          JOIN books b ON b.id = li.mediaId
          WHERE mp.userId = ? AND mp.isFinished = 1 AND mp.mediaItemType = 'book'
          ORDER BY mp.finishedAt DESC
          LIMIT ?
        `,
        args: [userId, cap],
      })
      return res.rows.map((row) => {
        const ms = row.finishedAt != null ? Date.parse(String(row.finishedAt)) : NaN
        return {
          libraryItemId: String(row.libraryItemId),
          title: row.title == null ? '' : String(row.title),
          finishedAt: Number.isNaN(ms) ? null : ms,
        }
      })
    } catch (err) {
      appLog.error('absdb', `finishedBooks failed for user ${userId}: ${err?.message ?? err}`)
      return []
    }
  })
}

// Server-wide per-user AVERAGES over eligible (non-guest, active) users: mean
// books finished, seconds listened, avg-per-active-day, and (with `yearStart`)
// books finished this year. No identity is leaked, so this is available whenever
// the db is mounted. Averages are over the count of users who have ANY book
// session or finish (the listening population), so a library full of
// never-listened accounts doesn't drag the mean to zero. activeDays is null for
// the aggregate (a per-user notion). Cached per yearStart.
export async function getServerAggregateStats(yearStart = null) {
  const c = await ensureClient()
  if (!c) return null
  return cached(`compareServerAgg:${yearStart ?? ''}`, async () => {
    try {
      const [finishedRes, listenRes, yearRes] = await Promise.all([
        // Per-user finished counts, eligible users only.
        c.execute(`
          SELECT mp.userId AS userId, COUNT(*) AS n
          FROM mediaProgresses mp
          JOIN users u ON u.id = mp.userId
          WHERE mp.isFinished = 1 AND mp.mediaItemType = 'book'
            AND u.type != 'guest' AND u.isActive = 1
          GROUP BY mp.userId
        `),
        // Per-user seconds + active days.
        c.execute(`
          SELECT ps.userId AS userId, SUM(ps.timeListening) AS secs,
                 COUNT(DISTINCT ps.date) AS days
          FROM playbackSessions ps
          JOIN users u ON u.id = ps.userId
          WHERE ps.mediaItemType = 'book'
            AND u.type != 'guest' AND u.isActive = 1
          GROUP BY ps.userId
        `),
        // Per-user finishes this year, when a year cutoff is given.
        yearStart
          ? c.execute({
              sql: `SELECT mp.userId AS userId, COUNT(*) AS n
                FROM mediaProgresses mp
                JOIN users u ON u.id = mp.userId
                WHERE mp.isFinished = 1 AND mp.mediaItemType = 'book'
                  AND mp.finishedAt >= ?
                  AND u.type != 'guest' AND u.isActive = 1
                GROUP BY mp.userId`,
              args: [yearStart],
            })
          : Promise.resolve({ rows: [] }),
      ])
      // Union the two populations so a user with listen time but no finish (or
      // vice versa) still counts once toward the mean denominator.
      const finishedByUser = new Map()
      for (const r of finishedRes.rows) finishedByUser.set(String(r.userId), Number(r.n) || 0)
      const secsByUser = new Map()
      const daysByUser = new Map()
      for (const r of listenRes.rows) {
        secsByUser.set(String(r.userId), Number(r.secs) || 0)
        daysByUser.set(String(r.userId), Number(r.days) || 0)
      }
      const yearByUser = new Map()
      for (const r of yearRes.rows) yearByUser.set(String(r.userId), Number(r.n) || 0)
      const users = new Set([...finishedByUser.keys(), ...secsByUser.keys()])
      const n = users.size
      if (!n) {
        return {
          booksFinished: 0,
          secondsListened: 0,
          activeDays: null,
          avgPerActiveDaySec: 0,
          booksThisYear: yearStart ? 0 : null,
        }
      }
      let totalFinished = 0
      let totalSecs = 0
      let totalAvgPerDay = 0
      let totalYear = 0
      for (const u of users) {
        const secs = secsByUser.get(u) || 0
        const days = daysByUser.get(u) || 0
        totalFinished += finishedByUser.get(u) || 0
        totalSecs += secs
        totalAvgPerDay += days ? secs / days : 0
        totalYear += yearByUser.get(u) || 0
      }
      return {
        booksFinished: totalFinished / n,
        secondsListened: totalSecs / n,
        activeDays: null,
        avgPerActiveDaySec: totalAvgPerDay / n,
        booksThisYear: yearStart ? totalYear / n : null,
      }
    } catch {
      return null
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

// Total number of book library items across the whole server. Read straight from
// ABS's libraryItems table (the same read-only connection the social features
// use). Returns 0 when the ABS db isn't mounted (e.g. a slim install without the
// config volume) or on any error - callers treat 0 as "unknown/none".
export async function getLibraryBookCount() {
  const c = await ensureClient()
  if (!c) return 0
  try {
    const res = await c.execute(`SELECT COUNT(*) AS n FROM libraryItems WHERE mediaType = 'book'`)
    return Number(res.rows[0]?.n) || 0
  } catch {
    return 0
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

// Bulk variant for shelves:
// { libraryItemId: [{ userId, username, finishedAt, status }] } for the ids
// asked for. Includes both finishers (status 'finished') and in-progress
// readers (started but not finished; status 'reading', finishedAt null). Items
// with no readers are omitted (callers default missing to []). Same user filter
// as getFinishedUsers. Finishers are listed first (newest finish first), then
// in-progress readers; a user who is both for one item appears once as
// 'finished'. Returns {} on any failure.
export async function getFinishedUsersBulk(libraryItemIds = []) {
  const ids = [...new Set(libraryItemIds.filter(Boolean))]
  if (!ids.length) return {}
  const c = await ensureClient()
  if (!c) return {}
  try {
    const placeholders = ids.map(() => '?').join(', ')
    const res = await c.execute({
      sql: `
        SELECT li.id AS libraryItemId, u.id AS userId, u.username AS username,
               mp.finishedAt AS finishedAt, mp.isFinished AS isFinished
        FROM libraryItems li
        JOIN mediaProgresses mp
          ON mp.mediaItemId = li.mediaId AND mp.mediaItemType = 'book'
        JOIN users u ON u.id = mp.userId
        WHERE li.id IN (${placeholders})
          AND li.mediaType = 'book'
          AND (mp.isFinished = 1 OR mp.progress > 0)
          AND u.type != 'guest'
          AND u.isActive = 1
        ORDER BY mp.isFinished DESC, mp.finishedAt DESC
      `,
      args: ids,
    })
    const out = {}
    const seen = new Set() // itemId|userId - finished row wins (ordered first)
    for (const row of res.rows) {
      const key = String(row.libraryItemId)
      const userId = String(row.userId)
      const dedupeKey = `${key}|${userId}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const finished = Number(row.isFinished) === 1
      const raw = row.finishedAt
      const ms = raw != null ? Date.parse(String(raw)) : NaN
      ;(out[key] = out[key] || []).push({
        userId,
        username: String(row.username ?? ''),
        finishedAt: finished && !Number.isNaN(ms) ? ms : null,
        status: finished ? 'finished' : 'reading',
      })
    }
    return out
  } catch {
    return {}
  }
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
    if (sample == null) {
      appLog.info('absdb', 'listen-format probe: no playbackSessions.updatedAt to sample')
      return (listenFormat = false)
    }
    const text = String(sample)
    // Must lead with YYYY-MM-DD then a 'T' or ' ' separator then HH:MM:SS.
    const m = /^\d{4}-\d{2}-\d{2}([T ])\d{2}:\d{2}:\d{2}/.exec(text)
    if (!m) {
      // Presence (listening-now) can't window without this; the profile hero
      // still works, it just can't report isLive. Log the actual shape so the
      // regex can be widened rather than guessed at.
      appLog.warn(
        'absdb',
        `listen-format probe: unrecognised updatedAt shape ${JSON.stringify(text.slice(0, 40))}`,
      )
      return (listenFormat = false)
    }
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
      // Resolve each session's library item, preferring extraData.libraryItemId
      // and falling back to the libraryItems.mediaId hop. The CASE WHEN around
      // json_extract is load-bearing: a bare `json_valid(e) AND json_extract(e)`
      // still aborts the whole query with "malformed JSON" on a bad row, since
      // SQLite doesn't promise to short-circuit AND. Filtering on the resolved
      // id (not per-branch) also means a row can't slip through both branches.
      const res = await c.execute({
        sql: `
          SELECT DISTINCT libraryItemId, userId, username FROM (
            SELECT
              COALESCE(
                CASE WHEN json_valid(ps.extraData) = 1
                     THEN json_extract(ps.extraData, '$.libraryItemId')
                END,
                li.id
              ) AS libraryItemId,
              u.id AS userId, u.username AS username
            FROM playbackSessions ps
            JOIN users u ON u.id = ps.userId
            LEFT JOIN libraryItems li
              ON li.mediaId = ps.mediaItemId AND li.mediaType = 'book'
            WHERE ps.mediaItemType = 'book'
              AND ps.updatedAt >= ?
              AND u.type != 'guest'
              AND u.isActive = 1
          )
          WHERE libraryItemId IN (${placeholders})
        `,
        args: [cutoff, ...ids],
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
    } catch (err) {
      appLog.error('absdb', `activeListeners failed: ${err?.message ?? err}`)
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

// The books the library owns in one series: { asin, title, sequence, author }.
// asin/title/author may be '' when ABS has none. sequence is ABS's
// bookSeries.sequence (a string, e.g. "4" or "2.5") or ''. author is the first
// author name via the bookAuthors join (same join readImportInventory uses) and
// is what disambiguates two same-named series when resolving the Audible match.
// [] on any failure.
export async function getOwnedSeriesBooks(seriesId) {
  if (!seriesId) return []
  const c = await ensureClient()
  if (!c) return []
  try {
    const res = await c.execute({
      sql: `
        SELECT b.asin AS asin, b.title AS title, bs.sequence AS sequence,
               (SELECT a.name FROM authors a
                  JOIN bookAuthors ba ON ba.authorId = a.id
                 WHERE ba.bookId = b.id LIMIT 1) AS author
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
      author: r.author == null ? '' : String(r.author),
    }))
  } catch {
    return []
  }
}

// The set of all book ASINs held in the library (lowercased). Loaded once by the
// release-notification job to detect when a followed book has landed in ABS.
export async function getOwnedAsins() {
  const set = new Set()
  const c = await ensureClient()
  if (!c) return set
  try {
    const res = await c.execute(`SELECT asin FROM books WHERE asin IS NOT NULL AND asin != ''`)
    for (const r of res.rows) if (r.asin) set.add(String(r.asin).toLowerCase())
  } catch {
    // Return whatever we have; a missing table just means no matches.
  }
  return set
}

// Resolve a book by its Audible ASIN to its library-item id + title, for a push
// deep-link once the followed book is in the library. null when not present.
export async function getLibraryItemByAsin(asin) {
  if (!asin) return null
  const c = await ensureClient()
  if (!c) return null
  try {
    const res = await c.execute({
      sql: `
        SELECT li.id AS libraryItemId, b.title AS title
        FROM books b
        JOIN libraryItems li ON li.mediaId = b.id
        WHERE lower(b.asin) = ?
        LIMIT 1
      `,
      args: [String(asin).toLowerCase()],
    })
    const row = res.rows[0]
    if (!row) return null
    return {
      libraryItemId: row.libraryItemId == null ? null : String(row.libraryItemId),
      title: row.title == null ? '' : String(row.title),
    }
  } catch {
    return null
  }
}

export const ABS_DB_PATH_RESOLVED = ABS_DB_PATH
