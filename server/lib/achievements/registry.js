// Achievement DEFINITIONS. The unlocks themselves are rows in user_achievements
// (lib/achievementsStore.js); this file is the code-side registry the evaluator
// walks. No achievements UI exists yet (billing/reveal deferred, per the stats
// plan) - the engine runs so unlocks accumulate, so the eventual reveal isn't
// empty.
//
// Each definition:
//   id          - stable string id (stored in user_achievements.achievement_id)
//   name        - short display name (for the future trophy case)
//   description - one line on how it's earned
//   tier        - 'bronze' | 'silver' | 'gold' | 'platinum' (cosmetic grouping)
//   evaluate(ctx) -> { unlocked: boolean, progress: number }
//     ctx (see lib/achievements/engine.js buildContext):
//       history        - HSStatsHistoryDay[] oldest-first (the durable series)
//       booksFinished  - all-time distinct books finished (ABS-db count)
//       distinctGenres - count of distinct finished genres
//     progress is a human-meaningful number toward the goal (e.g. current best
//     streak, or books finished), stored so a future UI can show a bar.
//
// Every rule here is computable from stats_daily + the finished count/genres the
// snapshot job already gathers - nothing needs startTime/deviceInfo (those are
// flagged in the plan as needing live-schema verification and are deferred).

// Longest run of consecutive listening days anywhere in the durable history.
// Works on the immutable stats_daily series, so it's a durable "longest-ever"
// streak - not the trailing-window streak ABS can express. Days are 'YYYY-MM-DD'.
export function longestStreak(history) {
  const active = history
    .filter((d) => (d.secondsListened || 0) > 0)
    .map((d) => d.date)
    .sort()
  let best = 0
  let run = 0
  let prevMs = null
  const DAY = 24 * 60 * 60 * 1000
  for (const date of active) {
    const ms = Date.parse(`${date}T00:00:00Z`)
    if (prevMs != null && ms - prevMs === DAY) {
      run += 1
    } else {
      run = 1
    }
    if (run > best) best = run
    prevMs = ms
  }
  return best
}

function streakTier(id, name, days, tier) {
  return {
    id,
    name,
    description: `Listen ${days} days in a row.`,
    tier,
    evaluate(ctx) {
      const best = longestStreak(ctx.history)
      return { unlocked: best >= days, progress: best }
    },
  }
}

function finishTier(id, name, count, tier) {
  return {
    id,
    name,
    description: `Finish ${count} books.`,
    tier,
    evaluate(ctx) {
      const n = ctx.booksFinished || 0
      return { unlocked: n >= count, progress: n }
    },
  }
}

function genreTier(id, name, count, tier) {
  return {
    id,
    name,
    description: `Finish books across ${count} different genres.`,
    tier,
    evaluate(ctx) {
      const n = ctx.distinctGenres || 0
      return { unlocked: n >= count, progress: n }
    },
  }
}

export const ACHIEVEMENTS = [
  // Consecutive-day streak tiers (durable, from stats_daily).
  streakTier('streak-7', 'Getting Cozy', 7, 'bronze'),
  streakTier('streak-30', 'Hearth Keeper', 30, 'silver'),
  streakTier('streak-100', 'Ever Burning', 100, 'gold'),
  streakTier('streak-365', 'Eternal Flame', 365, 'platinum'),
  // Finish-count tiers (all-time, from the ABS finished count).
  finishTier('finish-10', 'Shelf Starter', 10, 'bronze'),
  finishTier('finish-50', 'Well Read', 50, 'silver'),
  finishTier('finish-100', 'Bibliophile', 100, 'gold'),
  finishTier('finish-500', 'Living Library', 500, 'platinum'),
  // Genre breadth (from finished-book genres).
  genreTier('genre-5', 'Broadening Horizons', 5, 'bronze'),
  genreTier('genre-15', 'Genre Explorer', 15, 'silver'),
  genreTier('genre-30', 'Omnivore', 30, 'gold'),
]

export function getAchievement(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) ?? null
}
