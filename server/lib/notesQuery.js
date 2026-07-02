// The one authoritative notes gate + query, shared by routes/notes.js (public
// notes) and routes/clubs.js (club chat). Keeping it in a single module means
// the spoiler gate has exactly one server-side implementation - core's
// gateNotes is client-side optimistic re-gating ONLY and deliberately not
// mirrored here (see docs/social.md "Spoiler gating").
//
// The gate rule (docs/social.md): a note is visible iff
//   time_sec IS NULL            (general, ungated)
//   OR time_sec <= position     (you've reached it)
//   OR author = caller          (your own note)
//   OR caller has finished       (finished-bypass)
// A REPLY inherits its PARENT's time_sec gate (a reply to an ahead-note is ahead
// whatever its own timestamp). Locked TIMESTAMPED TOP-LEVEL notes become
// anonymous stubs { id, timeSec }; replies never get stubs (the parent's stub
// already marks the timestamp) but a locked reply still counts in hiddenAhead.
// Soft-deleted rows are kept in the gate's PARENT MAP (so a deleted locked
// parent still gates its replies) but are never emitted or counted.

import crypto from 'node:crypto'
import { db, initDb } from '../db.js'
import { absDbAvailable, getSelfProgress } from './absdb.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

// Load notes for one scope (server + item + club), oldest first. clubId ''
// selects public notes. `includeDeleted` (default false) controls whether
// soft-deleted rows are returned - the gate needs deleted rows in its parent
// map (a deleted locked parent must keep gating its replies), so gateNotes is
// fed the full set including deleted rows and filters them out of its output.
//
// Note: this deliberately does NOT filter by `after`. The spoiler gate must run
// over the COMPLETE scope so a reply's parent (which may predate any `after`
// cutoff) is always in the gate's parent map; `after` is applied to the gated
// output afterwards (see gateNotes' `after` option), never to the DB read.
export async function loadNotes(serverId, libraryItemId, clubId, includeDeleted = false) {
  await ensure()
  const args = [serverId, libraryItemId, clubId]
  let sql = `SELECT id, user_id, username, library_item_id, club_id, parent_id, time_sec, body, created_at, deleted
             FROM book_notes
             WHERE server_id = ? AND library_item_id = ? AND club_id = ?`
  if (!includeDeleted) sql += ' AND deleted = 0'
  sql += ' ORDER BY created_at ASC'
  const r = await db.execute({ sql, args })
  return r.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    username: String(row.username ?? ''),
    libraryItemId: String(row.library_item_id),
    clubId: String(row.club_id ?? ''),
    parentId: String(row.parent_id ?? ''),
    timeSec: row.time_sec == null ? null : Number(row.time_sec),
    body: String(row.body ?? ''),
    createdAt: Number(row.created_at),
    deleted: Boolean(row.deleted),
  }))
}

// Fetch a single note row (any club/item), even if deleted, for validation +
// authorization (parent lookup, delete). Returns null if absent.
export async function getNote(serverId, id) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT id, user_id, username, library_item_id, club_id, parent_id, time_sec, body, created_at, deleted
          FROM book_notes WHERE server_id = ? AND id = ? LIMIT 1`,
    args: [serverId, id],
  })
  const row = r.rows[0]
  if (!row) return null
  return {
    id: String(row.id),
    userId: String(row.user_id),
    username: String(row.username ?? ''),
    libraryItemId: String(row.library_item_id),
    clubId: String(row.club_id ?? ''),
    parentId: String(row.parent_id ?? ''),
    timeSec: row.time_sec == null ? null : Number(row.time_sec),
    body: String(row.body ?? ''),
    createdAt: Number(row.created_at),
    deleted: Boolean(row.deleted),
  }
}

// The effective gate timestamp for a note: a reply inherits its parent's
// time_sec; a top-level note uses its own. Returns null (= ungated) when the
// controlling time_sec is null, or Infinity when a reply's parent is missing.
// `byId` maps note id -> row for parent lookup (built from the FULL scope,
// including deleted rows, so a deleted locked parent still gates its replies).
function gateTime(note, byId) {
  if (note.parentId) {
    const parent = byId.get(note.parentId)
    // A reply whose parent is genuinely absent from the scope is treated as
    // maximally gated (Infinity) - author/finished bypasses still apply, but
    // nobody else sees a reply whose parent we can't confirm. Matches core's
    // "missing parent = locked" rule (HearthShelf-Core src/lib/social.ts).
    return parent ? parent.timeSec : Infinity
  }
  return note.timeSec
}

// Apply the spoiler gate to a set of loaded notes. Returns:
//   notes        - full visible notes (bodies)
//   locked       - anonymous stubs { id, timeSec } for locked TOP-LEVEL
//                  timestamped notes (only when includeLocked)
//   hiddenAhead  - count of ALL locked rows (notes + replies)
// `position` (seconds) and `isFinished` come from resolveGatePosition. `meId` is
// the caller (author-bypass). `includeLocked` gates whether stubs are returned
// (public scope: false per docs; club scope: true for the current book).
//
// `rows` must be the COMPLETE scope (loadNotes with includeDeleted=true): the
// parent map is built from every row so a reply's parent - even a soft-deleted
// or ahead-of-cutoff one - always gates it. Deleted rows themselves are never
// emitted or counted. `after` (ms, optional) is applied to the GATED output, not
// the DB read: only gated notes/stubs with createdAt > after are returned, so a
// delta poll can't leak an ahead-note's body by outrunning its parent lookup.
export function gateNotes(rows, { position, meId, isFinished, includeLocked, after = null }) {
  const byId = new Map(rows.map((n) => [n.id, n]))
  const pos = Number.isFinite(position) ? position : 0
  const cutoff = after != null && Number.isFinite(after) ? after : null
  const visible = []
  const locked = []
  let hiddenAhead = 0

  for (const note of rows) {
    // Deleted rows stay in the parent map (above) but are never output/counted.
    if (note.deleted) continue
    const t = gateTime(note, byId)
    const unlocked =
      t == null || isFinished || note.userId === meId || t <= pos
    if (unlocked) {
      if (cutoff == null || note.createdAt > cutoff) {
        visible.push({
          id: note.id,
          userId: note.userId,
          username: note.username,
          libraryItemId: note.libraryItemId,
          clubId: note.clubId,
          parentId: note.parentId,
          timeSec: note.timeSec,
          body: note.body,
          createdAt: note.createdAt,
        })
      }
      continue
    }
    // Locked. Count it, and (for top-level timestamped notes) emit an anonymous
    // stub. Replies never get their own stub - the parent's stub marks the tick.
    // The `after` cutoff also applies to stubs so a delta poll stays consistent.
    hiddenAhead++
    if (
      includeLocked &&
      !note.parentId &&
      note.timeSec != null &&
      (cutoff == null || note.createdAt > cutoff)
    ) {
      locked.push({ id: note.id, timeSec: note.timeSec })
    }
  }

  return { notes: visible, locked, hiddenAhead }
}

// Resolve the caller's gate position + finished flag for one item. Position is
// client-supplied (lying only spoils the liar), but when absdb is available we
// clamp it UP to the caller's own mediaProgresses.currentTime so a stale client
// can't re-lock notes, and take isFinished from the server row (authoritative).
// When absdb is absent we accept the client's finished claim (the gate protects
// the reader from themselves, it is not a security boundary).
export async function resolveGatePosition(ctx, libraryItemId, positionParam, finishedClaim) {
  let position = Number.isFinite(positionParam) ? Math.max(0, positionParam) : 0
  let isFinished = Boolean(finishedClaim)
  if (await absDbAvailable()) {
    const self = await getSelfProgress(ctx.userId, libraryItemId)
    if (self) {
      if (self.currentTime != null && self.currentTime > position) position = self.currentTime
      isFinished = Boolean(self.isFinished)
    } else {
      // No server progress row and absdb is present: the caller hasn't started
      // this book, so ignore any finished claim.
      isFinished = false
    }
  }
  return { position, isFinished }
}

// Insert a note/reply, snapshotting the author's username. Returns the created
// HSNote. Callers validate body/timeSec/parent first.
export async function insertNote(serverId, { userId, username, libraryItemId, clubId, parentId, timeSec, body }) {
  await ensure()
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  await db.execute({
    sql: `INSERT INTO book_notes
            (id, server_id, user_id, username, library_item_id, club_id, parent_id, time_sec, body, created_at, deleted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [
      id,
      serverId,
      userId,
      username || '',
      libraryItemId,
      clubId || '',
      parentId || '',
      timeSec == null ? null : timeSec,
      body,
      createdAt,
    ],
  })
  return {
    id,
    userId,
    username: username || '',
    libraryItemId,
    clubId: clubId || '',
    parentId: parentId || '',
    timeSec: timeSec == null ? null : timeSec,
    body,
    createdAt,
  }
}

// Soft-delete a note (keeps reply threads intact). Returns true if a row moved
// to deleted (idempotent: deleting an already-deleted note still returns true).
export async function softDeleteNote(serverId, id) {
  await ensure()
  const r = await db.execute({
    sql: `UPDATE book_notes SET deleted = 1 WHERE server_id = ? AND id = ?`,
    args: [serverId, id],
  })
  return (r.rowsAffected ?? 0) > 0
}

// Count only UNLOCKED notes with created_at > lastReadAt - the club unread
// badge. Locked notes never count, so the badge can't leak that discussion
// exists ahead of you. `visibleNotes` is the gated `notes` array.
export function unreadCount(visibleNotes, lastReadAt) {
  const cursor = Number.isFinite(lastReadAt) ? lastReadAt : 0
  let n = 0
  for (const note of visibleNotes) if (note.createdAt > cursor) n++
  return n
}
