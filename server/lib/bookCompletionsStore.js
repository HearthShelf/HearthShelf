// Durable per-(user, book) completion counter - HearthShelf's record of how many
// times a user has finished a book. ABS keeps NO completion count: mediaProgresses
// stores a single finishedAt per (user, book) that is OVERWRITTEN on a re-finish,
// so re-reads/re-listens are not derivable from ABS data at all. This table is the
// only place that number can live.
//
// The nightly stats-snapshot job (jobs/statsSnapshot.js) reads ABS's CURRENT
// finish state (lib/absdb.js getFinishStates) and compares it against the state
// stored here to detect a new completion:
//   - first time a book is ever seen finished  -> completions = 1
//   - flipped unfinished->finished since        -> +1 (the row was absent, now present)
//   - still finished but finishedAt moved forward (a re-listen re-marked finished,
//     bumping ABS's finishedAt) -> +1
// Because a re-finish only ever moves finishedAt forward (never back), comparing
// the stored last_finished_at against the freshly-observed one is a robust
// re-read signal even when the user never explicitly unmarks the book.
//
// Not re-derivable from ABS once counted (ABS has overwritten the intermediate
// finishedAt values), so the data-domain registers backup:'full'. Keyed by
// (server_id, user_id, media_item_id) like every per-user HS table.

import { db, getServerId } from '../db.js'

// Reconcile ONE observed finish against the stored state, returning whether this
// observation is a NEW completion (so the caller can tally). Idempotent within a
// run: re-observing the same finishedAt is a no-op (no increment, last_seen_at
// refreshed). observedFinishedAt is a ms epoch or null (ABS had an unparseable
// date); when null we can't compare timestamps, so we only ever count the very
// first sighting and never a re-read for that book.
export async function recordFinishObservation({ userId, mediaItemId, observedFinishedAt }) {
  const serverId = await getServerId()
  const now = Date.now()
  const observed = observedFinishedAt == null ? null : Math.round(Number(observedFinishedAt))

  const existing = await db.execute({
    sql: `SELECT completions, last_finished_at
            FROM book_completions
           WHERE server_id = ? AND user_id = ? AND media_item_id = ?`,
    args: [serverId, String(userId), String(mediaItemId)],
  })
  const row = existing.rows[0]

  // First ever sighting of this finished book: seed completions = 1.
  if (!row) {
    await db.execute({
      sql: `INSERT INTO book_completions
              (server_id, user_id, media_item_id, completions, last_finished_at, last_seen_at)
            VALUES (?, ?, ?, 1, ?, ?)`,
      args: [serverId, String(userId), String(mediaItemId), observed, now],
    })
    return true
  }

  const stored = row.last_finished_at == null ? null : Number(row.last_finished_at)
  // A re-read is only detectable when BOTH timestamps are known and the observed
  // finish is strictly newer than the last one we counted. A null on either side
  // means "can't tell", so we conservatively don't count (the first sighting was
  // already counted above on insert).
  const isRereadEvent = observed != null && stored != null && observed > stored

  if (isRereadEvent) {
    await db.execute({
      sql: `UPDATE book_completions
               SET completions = completions + 1,
                   last_finished_at = ?,
                   last_seen_at = ?
             WHERE server_id = ? AND user_id = ? AND media_item_id = ?`,
      args: [observed, now, serverId, String(userId), String(mediaItemId)],
    })
    return true
  }

  // No new completion: just refresh last_seen_at (and adopt a finishedAt we didn't
  // have yet, so a later real re-read has a baseline to compare against).
  await db.execute({
    sql: `UPDATE book_completions
             SET last_seen_at = ?,
                 last_finished_at = COALESCE(last_finished_at, ?)
           WHERE server_id = ? AND user_id = ? AND media_item_id = ?`,
    args: [now, observed, serverId, String(userId), String(mediaItemId)],
  })
  return false
}

// The user's most re-read book: the highest completion count they hold, provided
// it's a genuine re-read (completions >= 2). Returns { mediaItemId, completions }
// or null when they have no re-read yet (or the store is empty). Ties break on the
// most recently finished. The route resolves mediaItemId -> title/cover via absdb.
export async function getMostReReadForUser(userId) {
  if (!userId) return null
  const serverId = await getServerId()
  try {
    const res = await db.execute({
      sql: `SELECT media_item_id, completions
              FROM book_completions
             WHERE server_id = ? AND user_id = ? AND completions >= 2
             ORDER BY completions DESC, last_finished_at DESC
             LIMIT 1`,
      args: [serverId, String(userId)],
    })
    const row = res.rows[0]
    if (!row) return null
    return {
      mediaItemId: String(row.media_item_id),
      completions: Number(row.completions) || 0,
    }
  } catch {
    return null
  }
}
