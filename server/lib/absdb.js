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

// Leaderboard rows: per ABS user, how many books they've finished and how many
// seconds they've spent listening to books. Guests and inactive users are left
// out. Two grouped queries (finished counts, listening totals) merged by userId,
// so a user with finishes but no recorded sessions (or vice versa) still appears.
//
// Returns [] on any failure so callers can treat "unavailable" and "empty" alike.
export async function getLeaderboard({ limit = 100 } = {}) {
  const c = await ensureClient()
  if (!c) return []
  try {
    const [finishedRes, listenRes] = await Promise.all([
      c.execute(`
        SELECT u.id AS userId, u.username AS username, COUNT(*) AS booksFinished
        FROM mediaProgresses mp
        JOIN users u ON u.id = mp.userId
        WHERE mp.isFinished = 1
          AND mp.mediaItemType = 'book'
          AND u.type != 'guest'
          AND u.isActive = 1
        GROUP BY u.id
      `),
      c.execute(`
        SELECT ps.userId AS userId, SUM(ps.timeListening) AS secondsListened
        FROM playbackSessions ps
        WHERE ps.mediaItemType = 'book'
        GROUP BY ps.userId
      `),
    ])

    const listenBy = new Map()
    for (const row of listenRes.rows) {
      listenBy.set(String(row.userId), Number(row.secondsListened) || 0)
    }

    const entries = finishedRes.rows.map((row) => {
      const userId = String(row.userId)
      return {
        userId,
        username: String(row.username ?? ''),
        booksFinished: Number(row.booksFinished) || 0,
        secondsListened: listenBy.get(userId) ?? 0,
      }
    })

    entries.sort(
      (a, b) =>
        b.booksFinished - a.booksFinished || b.secondsListened - a.secondsListened
    )
    return entries.slice(0, Math.max(1, limit))
  } catch {
    return []
  }
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

export const ABS_DB_PATH_RESOLVED = ABS_DB_PATH
