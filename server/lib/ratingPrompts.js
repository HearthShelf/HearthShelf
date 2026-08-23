// Delivery for the "how was it?" prompt shown after a book is finished.
//
// The trigger is the completion signal the stats-snapshot job already computes:
// recordFinishObservation() returns true exactly when a (user, book) pair is a
// NEW completion - first sighting, or a re-finish whose finishedAt moved
// forward. That is precisely "they just finished a book", so this rides along
// rather than re-deriving finish detection from ABS.
//
// Server-side rather than in each client so a book finished anywhere - the
// phone, the web app, or by listening to the end in ABS itself - prompts once,
// in every client's tray, deduped by the shared notifications entityId.

import { db, initDb } from '../db.js'
import { getBookByMediaId } from './absdb.js'
import { createNotification } from '../notifications.js'
import { notifyPrefsFor, shouldNotify } from './notificationPrefs.js'
import { getRatingsForKeys } from './ratingsStore.js'
import {
  RATING_NOTIFICATION_KIND,
  ratingPromptTitle,
  ratingPromptBody,
} from '@hearthshelf/core/lib/ratingPrompt'

// How recently a book must have been finished to be worth asking about.
//
// This exists for the FIRST run after the feature ships. recordFinishObservation
// seeds a row for every book it has never seen, so on that run every book the
// user has ever finished reads as a new completion - without this window that is
// one prompt per book, hundreds of rows, all at once. It is also just good
// manners afterwards: a book finished three weeks ago is not something anyone
// wants to be asked about now.
const PROMPT_WINDOW_MS = Number(process.env.HS_RATING_PROMPT_WINDOW_MS || 3 * 24 * 60 * 60 * 1000)

/** True when a finish is recent enough to ask about. A null finishedAt (ABS had
 *  an unparseable date) is NOT prompted: we cannot tell whether it happened
 *  today or in 2019, and the wrong guess is a stale prompt. */
export function isPromptableFinish(finishedAt, now = Date.now()) {
  if (finishedAt == null) return false
  const ms = Number(finishedAt)
  if (!Number.isFinite(ms)) return false
  return ms <= now && now - ms <= PROMPT_WINDOW_MS
}

/**
 * Create the rating prompt for one just-finished book. Best-effort: returns
 * true only when a notification was actually written.
 *
 * Skipped when the user turned rating prompts off, when the finish is outside
 * the freshness window, when the book has left the library (nothing to rate),
 * or when they have ALREADY rated it - re-finishing a book you rated years ago
 * should not re-open the question.
 *
 * Only the in-app channel is consulted. Push/email for this type are off by
 * default and there is no delivery path for them here on purpose: the prompt is
 * answered by tapping stars in the tray, so a push that merely says "rate it"
 * would add an interruption without adding an action.
 */
export async function maybeCreateRatingPrompt(
  serverId,
  { userId, mediaItemId, finishedAt },
  { prefs, now = Date.now() } = {},
) {
  if (!userId || !mediaItemId) return false
  if (!isPromptableFinish(finishedAt, now)) return false

  const resolved = prefs ?? (await notifyPrefsFor(serverId, userId))
  if (!shouldNotify(resolved, 'rating', 'inApp')) return false

  // Needs the library item id: that is what a rating is keyed by, and what the
  // client routes to. A book that has left the library resolves to null.
  const book = await getBookByMediaId(mediaItemId)
  const itemKey = book?.libraryItemId
  if (!itemKey) return false

  const existing = await getRatingsForKeys(serverId, userId, [itemKey])
  if (existing.get(itemKey) != null) return false

  // They already said "not this one". The notification row that would otherwise
  // dedupe this was deleted by the skip itself, so without this check the hourly
  // job would re-ask every hour until the finish aged out of the window.
  if (await hasSkippedRating(serverId, userId, itemKey)) return false

  // entityId is the library item, so createNotification's own dedupe collapses a
  // re-run (or a re-finish while the first prompt is still unanswered) into the
  // one row already sitting in the tray.
  await createNotification(serverId, userId, {
    kind: RATING_NOTIFICATION_KIND,
    entityId: itemKey,
    title: ratingPromptTitle(book.title),
    body: ratingPromptBody(book.author),
    data: { itemKey, mediaItemId: String(mediaItemId), title: book.title, author: book.author },
  })
  return true
}

/** Record that the reader declined to rate this book, so nothing asks again. */
export async function skipRatingPrompt(serverId, userId, itemKey) {
  await initDb()
  await db.execute({
    sql: `INSERT INTO rating_prompt_skips (server_id, user_id, item_key, skipped_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (server_id, user_id, item_key) DO UPDATE SET skipped_at = excluded.skipped_at`,
    args: [serverId, String(userId), String(itemKey), Date.now()],
  })
}

/** True when the reader already skipped rating this book. */
export async function hasSkippedRating(serverId, userId, itemKey) {
  await initDb()
  const r = await db.execute({
    sql: `SELECT 1 FROM rating_prompt_skips
           WHERE server_id = ? AND user_id = ? AND item_key = ? LIMIT 1`,
    args: [serverId, String(userId), String(itemKey)],
  })
  return Boolean(r.rows[0])
}
