// "Someone commented on a part you already heard."
//
// The club note-pop is a CROSSING detector: it fires as playback passes a note's
// timestamp. That makes a whole class of comment permanently silent - one posted
// at a timestamp a member has ALREADY listened past. Nothing will ever cross it
// for them again, so unless they happen to scroll the thread they never learn it
// exists. This module is the only thing that tells them.
//
// It is the mirror image of lib/mentionDelivery.js. A mention is deferred until
// the target catches UP to it; a late note fires precisely because the target is
// already BEYOND it. That also makes it spoiler-safe with no gate to run: a
// comment behind your position reveals nothing you have not already heard.
//
// Deliberately narrow, because this is the one notification nobody asked for:
//  - Only members strictly PAST the note's timestamp (by a margin - see BEHIND_
//    MIN_SEC) are told. Someone sitting right at it is about to hear the pop.
//  - Only top-level notes with a timestamp. Replies notify their parent's author
//    via deliverReply, and an untimed note is not anchored to anything to be
//    "behind".
//  - Never the author, and never someone already being @mentioned in the same
//    note (mentionDelivery is already telling them, and one comment must not
//    produce two buzzes).

import { getSelfProgress } from './absdb.js'
import { getUserEmail } from './absdb.js'
import { createNotification } from '../notifications.js'
import { notifyPrefsFor, shouldNotify } from './notificationPrefs.js'
import { sendPushMessages } from './expoPush.js'
import { deletePushToken, listPushTokens } from './subscriptionsStore.js'
import { sendTransactionalEmail } from './emailRelay.js'
import { renderEmail } from './emailTemplate.js'

const APP_ORIGIN = (process.env.HS_APP_ORIGIN || 'https://app.hearthshelf.com').replace(/\/$/, '')
const EXCERPT_MAX = 140

// How far past the note a member must be before this counts as "already heard
// it". Without a margin, someone listening a second behind the poster gets this
// notification and then the live note-pop for the same comment moments later.
const BEHIND_MIN_SEC = 120

function excerpt(body) {
  const text = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}...` : text
}

// Deliver one late-note alert across whichever channels the member has enabled.
async function deliverOne(serverId, targetId, note, authorUsername) {
  const prefs = await notifyPrefsFor(serverId, targetId)
  const title = `${authorUsername || 'Someone'} commented on a part you've heard`
  const body = excerpt(note.body)
  const data = {
    clubId: note.clubId ?? '',
    noteId: note.id,
    libraryItemId: note.libraryItemId,
    authorUsername: authorUsername || '',
  }

  if (shouldNotify(prefs, 'lateNote', 'inApp')) {
    // entityId = noteId so a retry can never stack a second row for one comment.
    await createNotification(serverId, targetId, {
      kind: 'lateNote',
      entityId: note.id,
      title,
      body,
      data,
    })
  }

  if (shouldNotify(prefs, 'lateNote', 'push')) {
    try {
      const tokens = await listPushTokens(serverId, targetId)
      if (tokens.length) {
        const result = await sendPushMessages(
          tokens.map((token) => ({
            to: token.token,
            title,
            body,
            channelId: 'social',
            data: { kind: 'lateNote', ...data },
          })),
        )
        await Promise.all(result.invalidTokens.map((token) => deletePushToken(serverId, token)))
      }
    } catch {
      // A dead push service must not block the inbox row or the email.
    }
  }

  if (shouldNotify(prefs, 'lateNote', 'email')) {
    try {
      const to = await getUserEmail(targetId)
      if (to) {
        const href = `${APP_ORIGIN}/club/${encodeURIComponent(note.clubId ?? '')}?note=${encodeURIComponent(note.id)}`
        await sendTransactionalEmail({
          to,
          subject: title,
          // `body` is the comment itself, so it renders as a quote rather than
          // as our own prose.
          ...renderEmail({
            title,
            quote: body,
            actionUrl: href,
            actionLabel: 'Open the discussion',
          }),
        })
      }
    } catch {
      // Email is the softest channel - never let it fail the post.
    }
  }
}

/**
 * Tell every club member who is already past this note's timestamp that it was
 * posted. Fire-and-forget by design: a delivery failure must never fail the
 * comment that triggered it.
 *
 * @param ctx     { serverId, userId, username } of the poster.
 * @param note    the freshly inserted note.
 * @param members the club's members (already loaded by the caller).
 * @param skipIds user ids being notified another way for this same note
 *                (currently the @mention targets), so one comment never buzzes
 *                a person twice.
 */
export async function deliverLateNote(ctx, note, members, skipIds = []) {
  try {
    // Replies notify via deliverReply; an untimed note has no position to be
    // behind. Neither is a "you already heard this part" case.
    if (!note?.clubId || note.parentId) return
    const timeSec = Number(note.timeSec)
    if (!Number.isFinite(timeSec) || timeSec <= 0) return

    const skip = new Set([String(ctx.userId), ...skipIds.map((id) => String(id))])
    for (const member of members ?? []) {
      const targetId = String(member?.userId ?? '')
      if (!targetId || skip.has(targetId)) continue
      try {
        const progress = await getSelfProgress(targetId, note.libraryItemId)
        if (!progress) continue
        // A member who finished the book has heard every timestamp in it, so
        // they qualify regardless of where currentTime happens to sit.
        const heard =
          Boolean(progress.isFinished) ||
          (progress.currentTime != null && progress.currentTime > timeSec + BEHIND_MIN_SEC)
        if (!heard) continue
        await deliverOne(ctx.serverId, targetId, note, ctx.username)
      } catch {
        // One member's delivery failing must not stop the rest.
      }
    }
  } catch {
    // Never surfaces to the caller - this rides along on a note POST.
  }
}
