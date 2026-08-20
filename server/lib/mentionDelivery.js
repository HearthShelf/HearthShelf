// @mentions in club notes: recording them, deciding WHEN to tell the target,
// and delivering across the user's chosen channels.
//
// The whole subtlety here is the spoiler gate. A club note timestamped ahead of
// where you are is invisible to you - it renders as an anonymous locked stub.
// So a mention inside such a note must not notify you yet: the notification
// would itself reveal that something was said at a point you haven't reached,
// which is precisely what the gate exists to prevent.
//
// Mentions are therefore DEFERRED, not dropped. Every mention is recorded with
// delivered_at NULL, delivered immediately if the target can already read the
// note, and otherwise left pending until their position crosses it (or they
// finish the book) - at which point a club/notes read flushes it. Nothing is
// silently lost, and nothing arrives early.
//
// Whether a note is readable is asked of lib/notesQuery.js's own isUnlocked,
// never reimplemented here: one spoiler rule, one implementation.

import crypto from 'node:crypto'
import { db, initDb } from '../db.js'
import { loadNotes, isUnlocked, resolveGatePosition } from './notesQuery.js'
import { getUserEmail } from './absdb.js'
import { createNotification } from '../notifications.js'
import { notifyPrefsFor, shouldNotify } from './notificationPrefs.js'
import { sendPushMessages } from './expoPush.js'
import { deletePushToken, listPushTokens } from './subscriptionsStore.js'
import { sendTransactionalEmail } from './emailRelay.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

const APP_ORIGIN = (process.env.HS_APP_ORIGIN || 'https://app.hearthshelf.com').replace(/\/$/, '')
const EXCERPT_MAX = 140

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function excerpt(body) {
  const text = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}...` : text
}

/**
 * Every mention row on a set of notes, as note_id -> [{ userId, username }].
 * The username is snapshotted on the row at write time (like book_notes does)
 * so a mention chip renders without an absdb mount.
 */
export async function mentionsForNotes(serverId, noteIds) {
  await ensure()
  const ids = [...new Set((noteIds ?? []).filter(Boolean))]
  if (!ids.length) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const r = await db.execute({
    sql: `SELECT note_id, target_id, username FROM note_mentions
           WHERE server_id = ? AND note_id IN (${placeholders})`,
    args: [serverId, ...ids],
  })
  const out = new Map()
  for (const row of r.rows) {
    const noteId = String(row.note_id)
    if (!out.has(noteId)) out.set(noteId, [])
    out.get(noteId).push({
      userId: String(row.target_id),
      username: String(row.username ?? ''),
    })
  }
  return out
}

/**
 * Attach `mentions` to gated notes in place. Best-effort: a failure here must
 * never break a notes read.
 */
export async function hydrateMentions(serverId, notes) {
  try {
    if (!Array.isArray(notes) || !notes.length) return notes
    const byNote = await mentionsForNotes(
      serverId,
      notes.map((n) => n.id),
    )
    if (!byNote.size) return notes
    for (const note of notes) {
      const found = byNote.get(note.id)
      if (found?.length) note.mentions = found
    }
  } catch {
    // Notes render fine without mention chips.
  }
  return notes
}

// Deliver one mention across whichever channels the target has enabled.
async function deliverMention(serverId, row, note, authorUsername) {
  const prefs = await notifyPrefsFor(serverId, row.targetId)
  const title = `${authorUsername || 'Someone'} mentioned you`
  const body = excerpt(note.body)
  const data = {
    clubId: row.clubId,
    noteId: row.noteId,
    libraryItemId: row.libraryItemId,
    authorUsername: authorUsername || '',
  }

  if (shouldNotify(prefs, 'mention', 'inApp')) {
    // entityId = noteId, so createNotification's existing dedupe makes a repeat
    // flush a no-op even if delivered_at somehow failed to stick.
    await createNotification(serverId, row.targetId, {
      kind: 'mention',
      entityId: row.noteId,
      title,
      body,
      data,
    })
  }

  if (shouldNotify(prefs, 'mention', 'push')) {
    try {
      const tokens = await listPushTokens(serverId, row.targetId)
      if (tokens.length) {
        const result = await sendPushMessages(
          tokens.map((token) => ({
            to: token.token,
            title,
            body,
            channelId: 'social',
            data: { kind: 'mention', ...data },
          })),
        )
        await Promise.all(result.invalidTokens.map((token) => deletePushToken(serverId, token)))
      }
    } catch {
      // A dead push service must not block the inbox row or the email.
    }
  }

  if (shouldNotify(prefs, 'mention', 'email')) {
    try {
      const to = await getUserEmail(row.targetId)
      if (to) {
        const href = `${APP_ORIGIN}/club/${encodeURIComponent(row.clubId)}?note=${encodeURIComponent(row.noteId)}`
        await sendTransactionalEmail({
          to,
          subject: title,
          text: `${title}\n\n${body}\n\nOpen the discussion: ${href}`,
          html: `<p>${escapeHtml(title)}</p><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(href)}">Open the discussion</a></p>`,
        })
      }
    } catch {
      // Email is best-effort, like every other transactional send here.
    }
  }
}

async function markDelivered(serverId, id) {
  await db.execute({
    sql: `UPDATE note_mentions SET delivered_at = ?
           WHERE server_id = ? AND id = ? AND delivered_at IS NULL`,
    args: [Date.now(), serverId, id],
  })
}

// Can `targetId` read `note` at their current progress? Runs the real gate:
// their own server-side position against the note's parent map.
async function canRead(serverId, targetId, note) {
  const rows = await loadNotes(serverId, note.libraryItemId, note.clubId, targetId, true)
  const byId = new Map(rows.map((n) => [n.id, n]))
  if (!byId.has(note.id)) byId.set(note.id, note)
  const { position, isFinished } = await resolveGatePosition(
    { serverId, userId: targetId },
    note.libraryItemId,
    Number.NaN,
    false,
  )
  return isUnlocked(byId.get(note.id) ?? note, byId, position, targetId, isFinished)
}

/**
 * Record the mentions on a freshly posted note, delivering to whoever can
 * already read it and leaving the rest pending.
 *
 * `targets` must ALREADY be authorized by the caller (club members only) - this
 * does not re-check membership. Self-mentions are dropped: being told that you
 * mentioned yourself is noise.
 */
export async function recordMentions(ctx, note, targets) {
  await ensure()
  const seen = new Set()
  const rows = []
  for (const target of targets ?? []) {
    const userId = String(target?.userId ?? '')
    if (!userId || userId === ctx.userId || seen.has(userId)) continue
    seen.add(userId)
    rows.push({
      id: crypto.randomUUID(),
      noteId: note.id,
      clubId: note.clubId,
      libraryItemId: note.libraryItemId,
      targetId: userId,
      username: String(target?.username ?? ''),
    })
  }
  if (!rows.length) return

  const now = Date.now()
  for (const row of rows) {
    await db.execute({
      sql: `INSERT INTO note_mentions
              (id, server_id, note_id, club_id, library_item_id, author_id, target_id, username, created_at, delivered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      args: [
        row.id,
        ctx.serverId,
        row.noteId,
        row.clubId,
        row.libraryItemId,
        ctx.userId,
        row.targetId,
        row.username,
        now,
      ],
    })
  }

  // A note with no timestamp, or one the author marked spoiler-free, is readable
  // by everyone right now - skip the per-target gate check entirely.
  const readableByAll = note.safe || note.timeSec == null
  for (const row of rows) {
    try {
      if (readableByAll || (await canRead(ctx.serverId, row.targetId, note))) {
        await deliverMention(ctx.serverId, row, note, ctx.username)
        await markDelivered(ctx.serverId, row.id)
      }
    } catch {
      // Leave it pending; the next club read retries.
    }
  }
}

/**
 * Deliver any pending mentions for this reader that they can NOW read.
 *
 * Called on club/notes reads - the moment we learn their current position.
 * Fire-and-forget: a failure must never break the read that triggered it.
 */
export async function flushPendingMentions(ctx, libraryItemId) {
  try {
    await ensure()
    const args = [ctx.serverId, ctx.userId]
    let sql = `SELECT id, note_id, club_id, library_item_id
                 FROM note_mentions
                WHERE server_id = ? AND target_id = ? AND delivered_at IS NULL`
    if (libraryItemId) {
      sql += ' AND library_item_id = ?'
      args.push(libraryItemId)
    }
    const pending = await db.execute({ sql, args })
    if (!pending.rows.length) return

    // Group by scope so each (item, club) note set is loaded once.
    const byScope = new Map()
    for (const row of pending.rows) {
      const key = `${row.library_item_id} ${row.club_id}`
      if (!byScope.has(key)) byScope.set(key, [])
      byScope.get(key).push(row)
    }

    for (const [key, rows] of byScope) {
      const [itemId, clubId] = key.split(' ')
      const notes = await loadNotes(ctx.serverId, itemId, clubId, ctx.userId, true)
      const byId = new Map(notes.map((n) => [n.id, n]))
      const { position, isFinished } = await resolveGatePosition(ctx, itemId, Number.NaN, false)
      for (const row of rows) {
        const note = byId.get(String(row.note_id))
        // A deleted note has nothing left to read - retire the mention rather
        // than leaving it pending forever.
        if (!note || note.deleted) {
          await markDelivered(ctx.serverId, String(row.id))
          continue
        }
        if (!isUnlocked(note, byId, position, ctx.userId, isFinished)) continue
        await deliverMention(
          ctx.serverId,
          {
            id: String(row.id),
            noteId: String(row.note_id),
            clubId: String(row.club_id),
            libraryItemId: String(row.library_item_id),
            targetId: ctx.userId,
          },
          note,
          note.username,
        )
        await markDelivered(ctx.serverId, String(row.id))
      }
    }
  } catch {
    // Never surface to the caller: this rides along on a read.
  }
}
