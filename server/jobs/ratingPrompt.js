// The rating-prompt job: asks "how was it?" for books finished since the last
// run. Hourly, so a prompt shows up while the book is still fresh in mind rather
// than the next morning.
//
// Deliberately SEPARATE from jobs/statsSnapshot.js even though that job also
// detects completions. The snapshot is nightly and expensive - it scans ABS's
// unindexed playbackSessions table, writes daily aggregates, and re-evaluates
// every achievement - so running it hourly to get faster prompts would multiply
// a heavy scan 24x for one cheap signal. This job reads only the finished set
// (a filtered mediaProgresses read) and writes nothing but notifications.
//
// Both jobs call the same maybeCreateRatingPrompt(), and createNotification()
// dedupes on the library item id, so whichever runs first wins and the other
// no-ops. That overlap is intentional: it means the prompt still lands if this
// job is disabled, and neither job has to know about the other.

import { absDbAvailable, getFinishStates } from '../lib/absdb.js'
import { getServerId } from '../db.js'
import { notifyPrefsFor } from '../lib/notificationPrefs.js'
import { maybeCreateRatingPrompt, isPromptableFinish } from '../lib/ratingPrompts.js'

export async function runRatingPrompt(logger, signal) {
  if (!(await absDbAvailable())) {
    logger.warn('ABS database not available (HS_ABS_DB_PATH) - cannot detect finishes. Skipping.')
    return 'Skipped: ABS database not mounted'
  }

  const serverId = await getServerId()
  const states = await getFinishStates()

  // Filter to recent finishes BEFORE touching the completion store or prefs.
  // Nearly every row is an old finish on any given run, and this check is pure
  // arithmetic - doing it first keeps the hourly pass proportional to how many
  // books were actually finished, not to how many the server has ever seen.
  const fresh = states.filter((s) => isPromptableFinish(s.finishedAt))
  logger.info(`${fresh.length} recent finishes out of ${states.length} finished pairs`)
  if (!fresh.length) return 'No recently finished books'

  const prefsCache = new Map()
  const getPrefs = async (userId) => {
    if (!prefsCache.has(userId)) prefsCache.set(userId, await notifyPrefsFor(serverId, userId))
    return prefsCache.get(userId)
  }

  let created = 0
  let i = 0
  logger.progress(0, fresh.length)
  for (const s of fresh) {
    if (signal?.aborted) {
      logger.warn(`Cancelled after ${i} of ${fresh.length}`)
      return `Cancelled after ${i} of ${fresh.length} recent finishes`
    }
    i++
    try {
      if (
        await maybeCreateRatingPrompt(
          serverId,
          { userId: s.userId, mediaItemId: s.mediaItemId, finishedAt: s.finishedAt },
          { prefs: await getPrefs(s.userId) },
        )
      ) {
        created++
      }
    } catch (err) {
      logger.warn(`Rating prompt ${s.userId} ${s.mediaItemId}: ${String(err?.message ?? err)}`)
    }
    logger.progress(i, fresh.length)
  }

  return `${created} rating prompt${created === 1 ? '' : 's'} sent for ${fresh.length} recent finish${fresh.length === 1 ? '' : 'es'}`
}
