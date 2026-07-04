// Book Club data access (see docs/social.md). All club/member/book table
// knowledge lives here; routes/clubs.js (and routes/notes.js's club scoping)
// call these instead of writing SQL inline. Kept separate from routes so the
// gate/query helpers (lib/notesQuery.js) and this data layer are each single
// authoritative implementations.
//
// A club is a persistent group; the book is an attribute of its timeline. The
// club_books table holds every book in one of three states: queued (queued_at
// set), current (queued_at and finished_at both NULL, exactly one), and finished
// (finished_at stamped). The owner queues up-next books and promotes them.

import crypto from 'node:crypto'
import { db, initDb } from './db.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

// Valid recommendation bases (mirrors ClubRecBasis in @hearthshelf/core). An
// unrecognized stored value falls back to 'club-history'.
const REC_BASES = new Set(['off', 'club-history', 'all-members-finished'])
function normalizeRecBasis(v) {
  return REC_BASES.has(v) ? v : 'club-history'
}

function mapClubRow(row) {
  if (!row) return null
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    createdBy: String(row.created_by ?? ''),
    isOpen: Boolean(row.is_open),
    archived: Boolean(row.archived),
    createdAt: Number(row.created_at),
    recBasis: normalizeRecBasis(row.rec_basis == null ? undefined : String(row.rec_basis)),
  }
}

function mapBookRow(row) {
  return {
    libraryItemId: String(row.library_item_id),
    title: String(row.title ?? ''),
    author: String(row.author ?? ''),
    addedBy: String(row.added_by ?? ''),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    queuedAt: row.queued_at == null ? null : Number(row.queued_at),
  }
}

// One club by id, or null. Does not filter archived (callers decide).
export async function getClub(serverId, clubId) {
  if (!clubId) return null
  await ensure()
  const r = await db.execute({
    sql: `SELECT id, name, created_by, is_open, archived, created_at, rec_basis
          FROM clubs WHERE server_id = ? AND id = ? LIMIT 1`,
    args: [serverId, clubId],
  })
  return mapClubRow(r.rows[0])
}

// Is this user a member of the club?
export async function isClubMember(serverId, clubId, userId) {
  if (!clubId || !userId) return false
  await ensure()
  const r = await db.execute({
    sql: `SELECT 1 FROM club_members WHERE server_id = ? AND club_id = ? AND user_id = ? LIMIT 1`,
    args: [serverId, clubId, userId],
  })
  return r.rows.length > 0
}

// The member row for a user, or null. role is 'owner' | 'member'.
export async function getMembership(serverId, clubId, userId) {
  if (!clubId || !userId) return null
  await ensure()
  const r = await db.execute({
    sql: `SELECT user_id, username, role, joined_at, last_read_at
          FROM club_members WHERE server_id = ? AND club_id = ? AND user_id = ? LIMIT 1`,
    args: [serverId, clubId, userId],
  })
  const row = r.rows[0]
  if (!row) return null
  return {
    userId: String(row.user_id),
    username: String(row.username ?? ''),
    role: String(row.role ?? 'member'),
    joinedAt: Number(row.joined_at),
    lastReadAt: Number(row.last_read_at ?? 0),
  }
}

// All members of a club, ordered owner-first then by join time.
export async function listMembers(serverId, clubId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT user_id, username, role, joined_at, last_read_at
          FROM club_members WHERE server_id = ? AND club_id = ?
          ORDER BY (role = 'owner') DESC, joined_at ASC`,
    args: [serverId, clubId],
  })
  return r.rows.map((row) => ({
    userId: String(row.user_id),
    username: String(row.username ?? ''),
    role: String(row.role ?? 'member'),
    joinedAt: Number(row.joined_at),
    lastReadAt: Number(row.last_read_at ?? 0),
  }))
}

export async function memberCount(serverId, clubId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM club_members WHERE server_id = ? AND club_id = ?`,
    args: [serverId, clubId],
  })
  return Number(r.rows[0]?.n) || 0
}

// The club's reading history: current + finished books, in started_at order
// (current book, with finished_at NULL, sorts last as it's the newest started).
// Excludes queued books - those aren't part of the timeline yet (see listQueue).
export async function listBooks(serverId, clubId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT library_item_id, title, author, added_by, started_at, finished_at, queued_at
          FROM club_books WHERE server_id = ? AND club_id = ? AND queued_at IS NULL
          ORDER BY started_at ASC`,
    args: [serverId, clubId],
  })
  return r.rows.map(mapBookRow)
}

// The up-next queue: books queued but not yet started, oldest-queued first.
export async function listQueue(serverId, clubId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT library_item_id, title, author, added_by, started_at, finished_at, queued_at
          FROM club_books WHERE server_id = ? AND club_id = ?
            AND queued_at IS NOT NULL AND finished_at IS NULL
          ORDER BY queued_at ASC`,
    args: [serverId, clubId],
  })
  return r.rows.map(mapBookRow)
}

// The club's current book (started, not finished, not queued), or null.
export async function currentBook(serverId, clubId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT library_item_id, title, author, added_by, started_at, finished_at, queued_at
          FROM club_books
          WHERE server_id = ? AND club_id = ? AND finished_at IS NULL AND queued_at IS NULL
          LIMIT 1`,
    args: [serverId, clubId],
  })
  const row = r.rows[0]
  return row ? mapBookRow(row) : null
}

// Is a given library item in the club's reading history (past or current)?
export async function bookInClub(serverId, clubId, libraryItemId) {
  if (!libraryItemId) return false
  await ensure()
  const r = await db.execute({
    sql: `SELECT 1 FROM club_books WHERE server_id = ? AND club_id = ? AND library_item_id = ? LIMIT 1`,
    args: [serverId, clubId, libraryItemId],
  })
  return r.rows.length > 0
}

// --- writes -----------------------------------------------------------------

// Create a club with the creator as its owner member, optionally seeding a first
// current book. `bookSnapshot` (or null) is { title, author } captured by the
// caller. Returns the created club id.
export async function createClub(
  serverId,
  { name, createdBy, username, libraryItemId, bookSnapshot },
) {
  await ensure()
  const id = crypto.randomUUID()
  const now = Date.now()
  await db.execute({
    sql: `INSERT INTO clubs (id, server_id, name, created_by, is_open, archived, created_at)
          VALUES (?, ?, ?, ?, 1, 0, ?)`,
    args: [id, serverId, name, createdBy, now],
  })
  await db.execute({
    sql: `INSERT INTO club_members (server_id, club_id, user_id, username, role, joined_at, last_read_at)
          VALUES (?, ?, ?, ?, 'owner', ?, 0)`,
    args: [serverId, id, createdBy, username || '', now],
  })
  if (libraryItemId) {
    await db.execute({
      sql: `INSERT INTO club_books (server_id, club_id, library_item_id, title, author, added_by, started_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      args: [
        serverId,
        id,
        libraryItemId,
        bookSnapshot?.title || '',
        bookSnapshot?.author || '',
        createdBy,
        now,
      ],
    })
  }
  return id
}

// Advance the club to a new current book: stamp finished_at on the previous
// current, then upsert the new one as started/current (clearing finished_at and
// queued_at, so promoting a queued book works too). `bookSnapshot` is
// { title, author }.
export async function setCurrentBook(serverId, clubId, { libraryItemId, addedBy, bookSnapshot }) {
  await ensure()
  const now = Date.now()
  // Stamp the outgoing current book (if any) unless it's the same item. Only the
  // started current book qualifies (queued_at NULL) - queued books also have
  // finished_at NULL and must not be finished here.
  await db.execute({
    sql: `UPDATE club_books SET finished_at = ?
          WHERE server_id = ? AND club_id = ? AND finished_at IS NULL AND queued_at IS NULL
            AND library_item_id != ?`,
    args: [now, serverId, clubId, libraryItemId],
  })
  // Upsert the new current book; re-adding a past or queued book clears its
  // finished_at and queued_at and stamps started_at now.
  await db.execute({
    sql: `INSERT INTO club_books (server_id, club_id, library_item_id, title, author, added_by, started_at, finished_at, queued_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT (server_id, club_id, library_item_id)
          DO UPDATE SET finished_at = NULL, queued_at = NULL, started_at = excluded.started_at,
                        title = excluded.title, author = excluded.author, added_by = excluded.added_by`,
    args: [
      serverId,
      clubId,
      libraryItemId,
      bookSnapshot?.title || '',
      bookSnapshot?.author || '',
      addedBy,
      now,
    ],
  })
}

// Add a book to the up-next queue. No-op (returns false) if the book is already
// in the club (queued, current, or finished) - re-queueing a finished book would
// need an explicit re-add via setCurrentBook. `bookSnapshot` is { title, author }.
export async function enqueueBook(serverId, clubId, { libraryItemId, addedBy, bookSnapshot }) {
  await ensure()
  if (await bookInClub(serverId, clubId, libraryItemId)) return false
  const now = Date.now()
  await db.execute({
    sql: `INSERT INTO club_books (server_id, club_id, library_item_id, title, author, added_by, started_at, finished_at, queued_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    args: [
      serverId,
      clubId,
      libraryItemId,
      bookSnapshot?.title || '',
      bookSnapshot?.author || '',
      addedBy,
      now,
    ],
  })
  return true
}

// Remove a book from the queue (only a queued row; leaves current/finished
// books untouched). Returns true if a queued row was removed.
export async function removeQueued(serverId, clubId, libraryItemId) {
  await ensure()
  const r = await db.execute({
    sql: `DELETE FROM club_books
          WHERE server_id = ? AND club_id = ? AND library_item_id = ? AND queued_at IS NOT NULL`,
    args: [serverId, clubId, libraryItemId],
  })
  return (r.rowsAffected ?? 0) > 0
}

// Add a member (idempotent - re-joining is a no-op that keeps the existing row).
export async function addMember(serverId, clubId, userId, username) {
  await ensure()
  await db.execute({
    sql: `INSERT INTO club_members (server_id, club_id, user_id, username, role, joined_at, last_read_at)
          VALUES (?, ?, ?, ?, 'member', ?, 0)
          ON CONFLICT (server_id, club_id, user_id)
          DO UPDATE SET username = excluded.username`,
    args: [serverId, clubId, userId, username || '', Date.now()],
  })
}

// Remove a member row.
export async function removeMember(serverId, clubId, userId) {
  await ensure()
  await db.execute({
    sql: `DELETE FROM club_members WHERE server_id = ? AND club_id = ? AND user_id = ?`,
    args: [serverId, clubId, userId],
  })
}

// Bump a member's unread cursor to max(stored, incoming), so a stale device
// can't resurrect read badges. Returns the effective cursor.
export async function bumpReadCursor(serverId, clubId, userId, lastReadAt) {
  await ensure()
  const incoming = Number.isFinite(lastReadAt) ? lastReadAt : 0
  await db.execute({
    sql: `UPDATE club_members SET last_read_at = MAX(last_read_at, ?)
          WHERE server_id = ? AND club_id = ? AND user_id = ?`,
    args: [incoming, serverId, clubId, userId],
  })
  const m = await getMembership(serverId, clubId, userId)
  return m ? m.lastReadAt : incoming
}

// Archive a club (soft; chat history stays readable). Returns true if it moved.
export async function archiveClub(serverId, clubId) {
  await ensure()
  const r = await db.execute({
    sql: `UPDATE clubs SET archived = 1 WHERE server_id = ? AND id = ?`,
    args: [serverId, clubId],
  })
  return (r.rowsAffected ?? 0) > 0
}

// Set the owner's next-book recommendation basis. Returns the stored basis
// (normalized), or null if the value wasn't one of the valid bases.
export async function setRecBasis(serverId, clubId, basis) {
  if (!REC_BASES.has(basis)) return null
  await ensure()
  await db.execute({
    sql: `UPDATE clubs SET rec_basis = ? WHERE server_id = ? AND id = ?`,
    args: [basis, serverId, clubId],
  })
  return basis
}

// Clubs the user belongs to, with member counts + current book resolved by the
// caller. Returns club summaries (without memberCount/currentBook - the route
// assembles those, one query each, to keep this layer thin).
export async function listMyClubs(serverId, userId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT c.id, c.name, c.created_by, c.is_open, c.archived, c.created_at, c.rec_basis
          FROM clubs c
          JOIN club_members m ON m.server_id = c.server_id AND m.club_id = c.id
          WHERE c.server_id = ? AND m.user_id = ?
          ORDER BY c.created_at DESC`,
    args: [serverId, userId],
  })
  return r.rows.map(mapClubRow)
}

// Open, non-archived clubs whose CURRENT book (finished_at NULL, not queued) is
// the item.
export async function listJoinableClubs(serverId, libraryItemId) {
  if (!libraryItemId) return []
  await ensure()
  const r = await db.execute({
    sql: `SELECT c.id, c.name, c.created_by, c.is_open, c.archived, c.created_at, c.rec_basis
          FROM clubs c
          JOIN club_books cb ON cb.server_id = c.server_id AND cb.club_id = c.id
          WHERE c.server_id = ? AND c.is_open = 1 AND c.archived = 0
            AND cb.library_item_id = ? AND cb.finished_at IS NULL AND cb.queued_at IS NULL
          ORDER BY c.created_at DESC`,
    args: [serverId, libraryItemId],
  })
  return r.rows.map(mapClubRow)
}
