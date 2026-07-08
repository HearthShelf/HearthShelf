// Durable store for per-user achievement unlocks (the stats-snapshot job's
// second output). Rows are just the unlocks - the DEFINITIONS live in code
// (lib/achievements/registry.js). One row per (server_id, user_id,
// achievement_id); unlocked_at is immutable (INSERT OR IGNORE never overwrites a
// prior unlock), progress tracks how far a tiered achievement has come. No route
// reads these yet (billing/reveal deferred); they accumulate so the eventual
// trophy case isn't empty.

import { db, getServerId } from '../db.js'

// The set of achievement ids a user has already unlocked, so the evaluator only
// inserts new ones. Returns a Set of ids ([] -> empty Set on any failure).
export async function getUnlockedIds(userId) {
  if (!userId) return new Set()
  const serverId = await getServerId()
  try {
    const res = await db.execute({
      sql: `SELECT achievement_id FROM user_achievements WHERE server_id = ? AND user_id = ?`,
      args: [serverId, String(userId)],
    })
    return new Set(res.rows.map((r) => String(r.achievement_id)))
  } catch {
    return new Set()
  }
}

// Record a newly-unlocked achievement. INSERT OR IGNORE so a re-run never moves
// an existing unlocked_at (the first unlock time is the true one). Returns true
// if a row was inserted (a genuinely new unlock), false if it already existed.
export async function insertUnlock({ userId, achievementId, unlockedAt, progress = 0 }) {
  const serverId = await getServerId()
  const res = await db.execute({
    sql: `INSERT OR IGNORE INTO user_achievements
            (server_id, user_id, achievement_id, unlocked_at, progress)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      serverId,
      String(userId),
      String(achievementId),
      Math.round(Number(unlockedAt) || Date.now()),
      Math.round(Number(progress) || 0),
    ],
  })
  return Number(res.rowsAffected) > 0
}
