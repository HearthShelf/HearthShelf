// Durable store for per-user daily listening history (the stats-snapshot job's
// output). One row per (server_id, user_id, date). ABS keeps no history, so this
// table is HearthShelf's own record; the nightly job re-derives recent days from
// ABS and upserts here, so the rows accumulate into full history over time. See
// jobs/statsSnapshot.js for the producer and routes/stats.js for the consumer.

import { db, getServerId } from '../db.js'

// Upsert one day of history for one user. Idempotent - re-running the snapshot
// re-derives the same day and overwrites in place (ON CONFLICT DO UPDATE), so a
// day is never double-counted. snapshot_at records the last write for debugging.
export async function upsertDaily({ userId, date, secondsListened, sessions, booksFinished }) {
  const serverId = await getServerId()
  await db.execute({
    sql: `
      INSERT INTO stats_daily
        (server_id, user_id, date, seconds_listened, sessions, books_finished, snapshot_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (server_id, user_id, date) DO UPDATE SET
        seconds_listened = excluded.seconds_listened,
        sessions         = excluded.sessions,
        books_finished   = excluded.books_finished,
        snapshot_at      = excluded.snapshot_at
    `,
    args: [
      serverId,
      String(userId),
      String(date),
      Math.round(Number(secondsListened) || 0),
      Math.round(Number(sessions) || 0),
      Math.round(Number(booksFinished) || 0),
      Date.now(),
    ],
  })
}

// The caller's daily history, oldest first, optionally only on/after sinceDate
// ('YYYY-MM-DD'). Returns the HSStatsHistoryDay[] shape (@hearthshelf/core).
// [] on any failure.
export async function getHistoryForUser(userId, sinceDate = null) {
  if (!userId) return []
  const serverId = await getServerId()
  try {
    const sql = sinceDate
      ? `SELECT date, seconds_listened, sessions, books_finished
         FROM stats_daily
         WHERE server_id = ? AND user_id = ? AND date >= ?
         ORDER BY date ASC`
      : `SELECT date, seconds_listened, sessions, books_finished
         FROM stats_daily
         WHERE server_id = ? AND user_id = ?
         ORDER BY date ASC`
    const res = await db.execute({
      sql,
      args: sinceDate ? [serverId, String(userId), String(sinceDate)] : [serverId, String(userId)],
    })
    return res.rows.map((r) => ({
      date: String(r.date),
      secondsListened: Number(r.seconds_listened) || 0,
      sessions: Number(r.sessions) || 0,
      booksFinished: Number(r.books_finished) || 0,
    }))
  } catch {
    return []
  }
}

// The full daily series HS holds for a user, as a plain array for the
// achievement engine (server-side, all-time - no window). Distinct from
// getHistoryForUser only in intent; kept separate so the achievement evaluator
// can pull every row regardless of any client-facing range default.
export async function getAllHistoryForUser(userId) {
  return getHistoryForUser(userId, null)
}
