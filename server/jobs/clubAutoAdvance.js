// The club auto-advance job. A club whose owner turned on "move on when
// everyone has finished" gets checked here: once every member who started the
// current book has finished it, the book becomes a past read and the first
// up-next book takes its place.
//
// Why a job and not a check on the club page: the last member to finish is
// usually not the one who opens the club next, so a read-path check would
// advance the club at an arbitrary moment (or never, for a quiet club). A
// scheduled pass moves every eligible club at a predictable time, and gives
// every member the same notification at once.
//
// "Everyone" means everyone who STARTED the book (a progress row with time on
// it). A member who joined late, or never opened it, does not hold the club up
// - otherwise one uninterested member freezes the club forever. A book nobody
// started is never auto-advanced: zero finishers is not consensus.

import { absDbAvailable, getMemberProgress } from '../lib/absdb.js'
import { getServerId } from '../db.js'
import {
  currentBook,
  finishCurrentBook,
  listAutoAdvanceClubs,
  listMembers,
  listQueue,
  setCurrentBook,
} from '../clubs.js'
import { createNotification } from '../notifications.js'
import { notifyPrefsFor, shouldNotify } from '../lib/notificationPrefs.js'
import { sendPushMessages } from '../lib/expoPush.js'
import { deletePushToken, listPushTokens } from '../lib/subscriptionsStore.js'

// A member counts as having started the book once they have any listening time
// on it. ABS writes a progress row on the first play, so currentTime > 0 is the
// honest signal; a finished book counts as started even if its time reads 0.
function hasStarted(progress) {
  if (!progress) return false
  return progress.isFinished || Number(progress.currentTime) > 0
}

/**
 * Decide whether one club should advance. Pure, so the rule can be read (and
 * tested) without a database: returns true only when at least one member
 * started the book and every member who started it has finished it.
 */
export function everyoneFinished(memberIds, progressByUser) {
  let started = 0
  for (const id of memberIds) {
    const p = progressByUser.get(id)
    if (!hasStarted(p)) continue
    started++
    if (!p.isFinished) return false
  }
  return started > 0
}

// Tell the club its book changed. Best effort on every channel: a dead push
// service must never leave the club's timeline half-advanced.
async function notifyAdvance(serverId, club, members, finishedTitle, nextBook) {
  const title = `${club.name} has moved on`
  const body = nextBook
    ? `Everyone finished ${finishedTitle || 'the book'}. Next up: ${nextBook.title || 'a new book'}.`
    : `Everyone finished ${finishedTitle || 'the book'}. There is no next book yet.`
  const data = {
    clubId: club.id,
    libraryItemId: nextBook ? nextBook.libraryItemId : '',
  }
  for (const member of members) {
    try {
      const prefs = await notifyPrefsFor(serverId, member.userId)
      if (shouldNotify(prefs, 'clubInvite', 'inApp')) {
        await createNotification(serverId, member.userId, {
          // entityId is the book the club moved TO (or the one it finished when
          // there is none), so one advance makes one inbox row per member.
          kind: 'club_advance',
          entityId: `${club.id}:${data.libraryItemId || finishedTitle}`,
          title,
          body,
          data,
        })
      }
      if (shouldNotify(prefs, 'clubInvite', 'push')) {
        const tokens = await listPushTokens(serverId, member.userId)
        if (!tokens.length) continue
        const result = await sendPushMessages(
          tokens.map((token) => ({
            to: token.token,
            title,
            body,
            channelId: 'social',
            data: { kind: 'club_advance', ...data },
          })),
        )
        await Promise.all(result.invalidTokens.map((t) => deletePushToken(serverId, t)))
      }
    } catch {
      // One member's delivery failing must not stop the rest.
    }
  }
}

export async function runClubAutoAdvance(logger, signal) {
  const serverId = await getServerId()
  const clubs = await listAutoAdvanceClubs(serverId)
  if (!clubs.length) return 'No clubs have auto-advance turned on'

  // Member progress lives in ABS's own database; without it mounted there is no
  // way to know who finished, so the pass is a no-op rather than a wrong guess.
  if (!(await absDbAvailable())) {
    logger.warn('ABS database not available (HS_ABS_DB_PATH) - cannot read who finished. Skipping.')
    return 'Skipped: ABS database not mounted'
  }

  logger.info(`${clubs.length} club${clubs.length === 1 ? '' : 's'} with auto-advance on`)
  let advanced = 0
  let i = 0
  logger.progress(0, clubs.length)
  for (const club of clubs) {
    if (signal?.aborted) {
      logger.warn(`Cancelled after ${i} of ${clubs.length}`)
      return `Cancelled after ${i} of ${clubs.length} clubs`
    }
    i++
    try {
      const current = await currentBook(serverId, club.id)
      if (!current) {
        logger.info(`${club.name}: no current book`)
        logger.progress(i, clubs.length)
        continue
      }
      const members = await listMembers(serverId, club.id)
      const progress = await getMemberProgress(
        members.map((m) => m.userId),
        current.libraryItemId,
      )
      if (!everyoneFinished(members.map((m) => m.userId), progress)) {
        logger.progress(i, clubs.length)
        continue
      }

      const queue = await listQueue(serverId, club.id)
      const next = queue[0] ?? null
      if (next) {
        await setCurrentBook(serverId, club.id, {
          libraryItemId: next.libraryItemId,
          addedBy: club.createdBy,
          bookSnapshot: { title: next.title, author: next.author },
          finishPrevious: true,
        })
      } else {
        await finishCurrentBook(serverId, club.id)
      }
      advanced++
      logger.info(
        next
          ? `${club.name}: finished ${current.title || current.libraryItemId}, now reading ${next.title || next.libraryItemId}`
          : `${club.name}: finished ${current.title || current.libraryItemId}, queue empty`,
      )
      await notifyAdvance(serverId, club, members, current.title, next)
    } catch (err) {
      logger.warn(`Club ${club.name}: ${String(err?.message ?? err)}`)
    }
    logger.progress(i, clubs.length)
  }

  return `${advanced} club${advanced === 1 ? '' : 's'} moved to the next book (${clubs.length} checked)`
}
