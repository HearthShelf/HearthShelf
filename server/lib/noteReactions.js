// Reactions on club notes: storing them, tallying them onto a page of notes,
// and telling the author when someone reacts.
//
// `kind` is a raw emoji rather than a boolean "liked" or a fixed name, so the
// set grows without a migration or a version gate: the kind IS the glyph, and a
// reaction this server has never seen renders correctly on every client. Three
// legacy names ('up' | 'heart' | 'laugh') predate emoji kinds and are still
// accepted so existing rows keep working.
//
// Validation is shared with the clients via @hearthshelf/core rather than
// duplicated here - this is the security boundary for a value that lands in a
// unique index, so it must not drift between surfaces. It is deliberately
// strict: emoji codepoints only, capped in length, skin-tone modifiers folded
// away. See core's lib/noteReactions.ts for why each rule is there.
//
// No spoiler gate applies here, unlike mentions. You can only react to a note
// you can already read, and the notification goes to that note's AUTHOR, who
// by definition has read it - their own. So there is nothing to defer, and no
// note_reactions equivalent of delivered_at.

import crypto from 'node:crypto'
import { db, initDb } from '../db.js'
import { getUserEmail } from './absdb.js'
import { createNotification } from '../notifications.js'
import { notifyPrefsFor, shouldNotify } from './notificationPrefs.js'
import { sendPushMessages } from './expoPush.js'
import { deletePushToken, listPushTokens } from './subscriptionsStore.js'
import { sendTransactionalEmail } from './emailRelay.js'
import { renderEmail } from './emailTemplate.js'
import {
  isValidReactionKind as isValidKind,
  normalizeReactionKind,
} from '@hearthshelf/core'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

const APP_ORIGIN = (process.env.HS_APP_ORIGIN || 'https://app.hearthshelf.com').replace(/\/$/, '')
const EXCERPT_MAX = 140

/**
 * Normalize a kind for storage, folding skin-tone variants onto their base so a
 * note's counts don't split across five near-identical chips. Always call this
 * BEFORE isValidReactionKind, and store exactly what it returned - validating
 * one string and writing another is how a check gets bypassed.
 */
export { normalizeReactionKind }

/** Whether a normalized kind may be stored. */
export function isValidReactionKind(kind) {
  return isValidKind(kind)
}

function excerpt(body) {
  const text = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}...` : text
}

/**
 * Reaction tallies for a set of notes, as note_id -> [{ kind, count, mine }].
 *
 * `mine` is resolved here rather than by a second round trip, so a client can
 * render its own toggle state straight from the notes payload.
 */
export async function reactionsForNotes(serverId, noteIds, meId) {
  await ensure()
  const ids = [...new Set((noteIds ?? []).filter(Boolean))]
  if (!ids.length) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const r = await db.execute({
    sql: `SELECT note_id, kind, user_id FROM note_reactions
           WHERE server_id = ? AND note_id IN (${placeholders})`,
    args: [serverId, ...ids],
  })
  // Tally in memory rather than with GROUP BY: the same scan has to answer
  // "did I react" per kind, and these pages are small.
  const byNote = new Map()
  for (const row of r.rows) {
    const noteId = String(row.note_id)
    const kind = String(row.kind ?? 'up')
    if (!byNote.has(noteId)) byNote.set(noteId, new Map())
    const kinds = byNote.get(noteId)
    if (!kinds.has(kind)) kinds.set(kind, { kind, count: 0, mine: false })
    const tally = kinds.get(kind)
    tally.count += 1
    if (meId && String(row.user_id) === String(meId)) tally.mine = true
  }
  const out = new Map()
  for (const [noteId, kinds] of byNote) {
    out.set(
      noteId,
      [...kinds.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    )
  }
  return out
}

/**
 * Attach `reactions` to gated notes in place. Best-effort: a failure here must
 * never break a notes read.
 */
export async function hydrateReactions(serverId, notes, meId) {
  try {
    if (!Array.isArray(notes) || !notes.length) return notes
    const byNote = await reactionsForNotes(
      serverId,
      notes.map((n) => n.id),
      meId,
    )
    if (!byNote.size) return notes
    for (const note of notes) {
      const found = byNote.get(note.id)
      if (found?.length) note.reactions = found
    }
  } catch {
    // Notes render fine without reaction chips.
  }
  return notes
}

/**
 * Add or remove one user's reaction of one kind on one note.
 *
 * Returns the note's fresh tallies so the caller can answer with them, letting a
 * client reconcile rather than guess at the new count. `added` is false when the
 * row already existed (or already didn't), which is what keeps a racing double
 * tap from notifying twice.
 */
export async function setReaction(serverId, note, userId, kind, on) {
  await ensure()
  let added = false
  if (on) {
    const r = await db.execute({
      sql: `INSERT OR IGNORE INTO note_reactions
              (id, server_id, note_id, club_id, library_item_id, user_id, kind, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        serverId,
        note.id,
        note.clubId ?? '',
        note.libraryItemId,
        userId,
        kind,
        Date.now(),
      ],
    })
    added = Number(r.rowsAffected ?? 0) > 0
  } else {
    await db.execute({
      sql: `DELETE FROM note_reactions
             WHERE server_id = ? AND note_id = ? AND user_id = ? AND kind = ?`,
      args: [serverId, note.id, userId, kind],
    })
  }
  const byNote = await reactionsForNotes(serverId, [note.id], userId)
  return { added, reactions: byNote.get(note.id) ?? [] }
}

/**
 * Tell a note's author that someone reacted. Fire-and-forget by design - a
 * delivery failure must never fail the reaction itself.
 *
 * Never notifies you about your own reaction, and stays silent when the author
 * has the 'reaction' category off.
 */
export async function deliverReaction(serverId, note, actor, kind) {
  try {
    if (!note?.userId || String(note.userId) === String(actor.userId)) return
    const prefs = await notifyPrefsFor(serverId, note.userId)
    const title = `${actor.username || 'Someone'} reacted to your comment`
    const body = excerpt(note.body)
    const data = {
      clubId: note.clubId ?? '',
      noteId: note.id,
      libraryItemId: note.libraryItemId,
      authorUsername: actor.username || '',
      kind,
    }

    if (shouldNotify(prefs, 'reaction', 'inApp')) {
      // entityId is the note, so repeated reactions collapse into one inbox row
      // rather than stacking one per reactor.
      await createNotification(serverId, note.userId, {
        kind: 'reaction',
        entityId: note.id,
        title,
        body,
        data,
      })
    }

    if (shouldNotify(prefs, 'reaction', 'push')) {
      try {
        const tokens = await listPushTokens(serverId, note.userId)
        if (tokens.length) {
          const result = await sendPushMessages(
            tokens.map((token) => ({
              to: token.token,
              title,
              body,
              channelId: 'social',
              data: { kind: 'reaction', ...data },
            })),
          )
          await Promise.all(result.invalidTokens.map((token) => deletePushToken(serverId, token)))
        }
      } catch {
        // A dead push service must not block the inbox row or the email.
      }
    }

    if (shouldNotify(prefs, 'reaction', 'email')) {
      try {
        const to = await getUserEmail(note.userId)
        if (to) {
          const href = `${APP_ORIGIN}/club/${encodeURIComponent(note.clubId ?? '')}?note=${encodeURIComponent(note.id)}`
          await sendTransactionalEmail({
            to,
            subject: title,
            // `body` is the comment being reacted/replied to, so it reads as a
            // quote rather than as our own prose.
            ...renderEmail({
              title,
              quote: body,
              actionUrl: href,
              actionLabel: 'Open the discussion',
            }),
          })
        }
      } catch {
        // Email is the softest channel - never let it fail the reaction.
      }
    }
  } catch {
    // Reacting succeeded; only the telling failed.
  }
}

/**
 * Tell a note's author that someone replied to it.
 *
 * Unlike a reaction, a reply is a NEW note that carries the spoiler gate: it
 * gates at its parent's timeSec (see the HSNote docs), and the parent is the
 * recipient's own note, which they have necessarily read. So the reply is
 * always readable by the person being told, and this needs no deferral either.
 */
export async function deliverReply(serverId, parent, reply, actor) {
  try {
    if (!parent?.userId || String(parent.userId) === String(actor.userId)) return
    const prefs = await notifyPrefsFor(serverId, parent.userId)
    const title = `${actor.username || 'Someone'} replied to your comment`
    const body = excerpt(reply.body)
    const data = {
      clubId: reply.clubId ?? '',
      noteId: reply.id,
      libraryItemId: reply.libraryItemId,
      authorUsername: actor.username || '',
    }

    if (shouldNotify(prefs, 'reply', 'inApp')) {
      await createNotification(serverId, parent.userId, {
        kind: 'reply',
        entityId: reply.id,
        title,
        body,
        data,
      })
    }

    if (shouldNotify(prefs, 'reply', 'push')) {
      try {
        const tokens = await listPushTokens(serverId, parent.userId)
        if (tokens.length) {
          const result = await sendPushMessages(
            tokens.map((token) => ({
              to: token.token,
              title,
              body,
              channelId: 'social',
              data: { kind: 'reply', ...data },
            })),
          )
          await Promise.all(result.invalidTokens.map((token) => deletePushToken(serverId, token)))
        }
      } catch {
        // A dead push service must not block the inbox row or the email.
      }
    }

    if (shouldNotify(prefs, 'reply', 'email')) {
      try {
        const to = await getUserEmail(parent.userId)
        if (to) {
          const href = `${APP_ORIGIN}/club/${encodeURIComponent(reply.clubId ?? '')}?note=${encodeURIComponent(reply.id)}`
          await sendTransactionalEmail({
            to,
            subject: title,
            // `body` is the comment being reacted/replied to, so it reads as a
            // quote rather than as our own prose.
            ...renderEmail({
              title,
              quote: body,
              actionUrl: href,
              actionLabel: 'Open the discussion',
            }),
          })
        }
      } catch {
        // Email is the softest channel - never let it fail the reply.
      }
    }
  } catch {
    // The reply landed; only the telling failed.
  }
}
