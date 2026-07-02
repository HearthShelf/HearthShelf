// The one authoritative notes gate + query, shared by routes/notes.js (public
// notes) and routes/clubs.js (club chat). Keeping it in a single module means
// the spoiler gate has exactly one server-side implementation - core's
// gateNotes is client-side optimistic re-gating ONLY and deliberately not
// mirrored here (see docs/social.md "Spoiler gating").
//
// The gate rule (docs/social.md): a note is visible iff
//   safe                        (author-declared spoiler-free, bypasses position)
//   OR time_sec IS NULL         (general, ungated)
//   OR time_sec <= position     (you've reached it)
//   OR author = caller          (your own note)
//   OR caller has finished       (finished-bypass)
// A REPLY inherits its PARENT's time_sec gate (a reply to an ahead-note is ahead
// whatever its own timestamp) - a safe PARENT unlocks its replies, but a reply
// never carries its own safe flag. Other users' `personal` notes are filtered
// out at load time and never reach the gate at all. Locked TIMESTAMPED TOP-LEVEL
// notes become
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
// selects public/personal notes; a non-empty clubId selects that club's notes.
// `callerId` scopes personal-note visibility: in the PUBLIC scope (empty clubId)
// only public notes and the CALLER'S OWN personal notes are returned - other
// users' personal notes are never loaded, so they leak into no notes[], no
// locked[], and no hiddenAhead count. In the CLUB scope all rows are returned
// (club membership is the boundary; visibility is 'club' there).
//
// `includeDeleted` (default false) controls whether soft-deleted rows are
// returned - the gate needs deleted rows in its parent map (a deleted locked
// parent must keep gating its replies), so gateNotes is fed the full set
// including deleted rows and filters them out of its output.
//
// Note: this deliberately does NOT filter by `after`. The spoiler gate must run
// over the COMPLETE scope so a reply's parent (which may predate any `after`
// cutoff) is always in the gate's parent map; `after` is applied to the gated
// output afterwards (see gateNotes' `after` option), never to the DB read.
export async function loadNotes(serverId, libraryItemId, clubId, callerId, includeDeleted = false) {
  await ensure()
  const args = [serverId, libraryItemId, clubId]
  let sql = `SELECT id, user_id, username, library_item_id, club_id, visibility, parent_id, time_sec, safe, body, created_at, deleted
             FROM book_notes
             WHERE server_id = ? AND library_item_id = ? AND club_id = ?`
  // Personal notes are private to their author. In the public scope, filter so a
  // caller only ever sees public rows plus their own personal rows. (The club
  // scope has no personal notes - posting in a club is always 'club'.)
  if (!clubId) {
    sql += ` AND (visibility != 'personal' OR user_id = ?)`
    args.push(callerId || '')
  }
  if (!includeDeleted) sql += ' AND deleted = 0'
  sql += ' ORDER BY created_at ASC'
  const r = await db.execute({ sql, args })
  return r.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    username: String(row.username ?? ''),
    libraryItemId: String(row.library_item_id),
    clubId: String(row.club_id ?? ''),
    visibility: String(row.visibility ?? 'public'),
    parentId: String(row.parent_id ?? ''),
    timeSec: row.time_sec == null ? null : Number(row.time_sec),
    safe: Boolean(row.safe),
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
    sql: `SELECT id, user_id, username, library_item_id, club_id, visibility, parent_id, time_sec, safe, body, created_at, deleted
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
    visibility: String(row.visibility ?? 'public'),
    parentId: String(row.parent_id ?? ''),
    timeSec: row.time_sec == null ? null : Number(row.time_sec),
    safe: Boolean(row.safe),
    body: String(row.body ?? ''),
    createdAt: Number(row.created_at),
    deleted: Boolean(row.deleted),
  }
}

// Whether a note is unlocked (visible with its body) for the caller. Mirrors
// core's gateNotes (HearthShelf-Core src/lib/social.ts) exactly:
//
//   Top-level: safe OR author OR finished OR timeSec == null OR timeSec <= pos.
//   Reply:     own author OR finished bypass; ELSE the parent unlocks it iff the
//              parent is present AND (parent.safe OR parent.timeSec == null OR
//              parent.timeSec <= pos). A missing parent = locked. The parent's
//              AUTHOR bypass does NOT unlock a stranger's reply, and a reply
//              never carries its own `safe`.
//
// `byId` maps note id -> row for parent lookup (built from the FULL scope,
// including deleted rows, so a deleted locked parent still gates its replies).
function isUnlocked(note, byId, pos, meId, isFinished) {
  if (note.parentId) {
    if (note.userId === meId || isFinished) return true
    const parent = byId.get(note.parentId)
    if (!parent) return false
    return parent.safe || parent.timeSec == null || parent.timeSec <= pos
  }
  return (
    note.safe ||
    note.userId === meId ||
    isFinished ||
    note.timeSec == null ||
    note.timeSec <= pos
  )
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
// A `safe` note (author-declared spoiler-free) is a FULL unlocked note for
// everyone regardless of position - it never becomes a stub and never counts in
// hiddenAhead. It keeps its timeSec so the client can still place a scrubber
// marker (an avatar dot, not an anonymous tick). Other users' personal notes are
// never in `rows` at all (loadNotes filters them), so they cannot leak here.
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
    const unlocked = isUnlocked(note, byId, pos, meId, isFinished)
    if (unlocked) {
      if (cutoff == null || note.createdAt > cutoff) {
        visible.push({
          id: note.id,
          userId: note.userId,
          username: note.username,
          libraryItemId: note.libraryItemId,
          clubId: note.clubId,
          visibility: note.visibility,
          parentId: note.parentId,
          timeSec: note.timeSec,
          safe: note.safe,
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
// HSNote. Callers validate body/timeSec/parent/visibility first. `safe` is
// forced false for replies (only top-level notes may be spoiler-safe - a reply
// never carries its own safe flag; it inherits its parent's gate).
export async function insertNote(serverId, { userId, username, libraryItemId, clubId, visibility, parentId, timeSec, safe, body }) {
  await ensure()
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  const vis = visibility || 'public'
  const isReply = Boolean(parentId)
  const safeVal = !isReply && safe ? 1 : 0
  await db.execute({
    sql: `INSERT INTO book_notes
            (id, server_id, user_id, username, library_item_id, club_id, visibility, parent_id, time_sec, safe, body, created_at, deleted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [
      id,
      serverId,
      userId,
      username || '',
      libraryItemId,
      clubId || '',
      vis,
      parentId || '',
      timeSec == null ? null : timeSec,
      safeVal,
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
    visibility: vis,
    parentId: parentId || '',
    timeSec: timeSec == null ? null : timeSec,
    safe: Boolean(safeVal),
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
