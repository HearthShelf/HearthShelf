// The achievement evaluator. Runs inside the stats-snapshot job (never on the
// request path) after stats_daily is refreshed: for each user it builds a
// context, runs every definition's evaluate(), and inserts newly-unlocked rows.
// Cheap and idempotent - INSERT OR IGNORE means an already-unlocked achievement
// is never re-stamped, so re-running the job just no-ops on existing unlocks.

import { ACHIEVEMENTS } from './registry.js'
import { getAllHistoryForUser } from '../statsHistoryStore.js'
import { getFinishedCountForUser, getFinishedGenresForUsers } from '../absdb.js'
import { getUnlockedIds, insertUnlock } from '../achievementsStore.js'

// Assemble the evaluation context for one user from the durable history + the
// live ABS-db counts. Kept small and pure-ish so a definition's evaluate() only
// reads plain numbers/arrays.
async function buildContext(userId) {
  const [history, booksFinished, genres] = await Promise.all([
    getAllHistoryForUser(userId),
    getFinishedCountForUser(userId),
    getFinishedGenresForUsers([userId]),
  ])
  return {
    history,
    booksFinished,
    distinctGenres: Object.keys(genres || {}).length,
  }
}

// Evaluate every definition for one user and persist any new unlocks. Only
// achievements not already unlocked are considered, so evaluate() runs are cheap.
// Returns the number of NEW unlocks recorded. `unlockedAt` defaults to now (the
// snapshot time - the closest we can date an unlock, since history is daily).
export async function evaluateUserAchievements(userId, unlockedAt = Date.now()) {
  if (!userId) return 0
  const already = await getUnlockedIds(userId)
  const pending = ACHIEVEMENTS.filter((a) => !already.has(a.id))
  if (!pending.length) return 0

  const ctx = await buildContext(userId)
  let newUnlocks = 0
  for (const def of pending) {
    let result
    try {
      result = def.evaluate(ctx)
    } catch {
      continue // a broken rule must never sink the whole evaluation
    }
    if (result?.unlocked) {
      const inserted = await insertUnlock({
        userId,
        achievementId: def.id,
        unlockedAt,
        progress: Number(result.progress) || 0,
      })
      if (inserted) newUnlocks += 1
    }
  }
  return newUnlocks
}
