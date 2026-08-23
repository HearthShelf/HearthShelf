// Book Club data access (see docs/social.md). All club/member/book table
// knowledge lives here; routes/clubs.js (and routes/notes.js's club scoping)
// call these instead of writing SQL inline. Kept separate from routes so the
// gate/query helpers (lib/notesQuery.js) and this data layer are each single
// authoritative implementations.
//
// A club is a persistent group; the book is an attribute of its timeline. The
// club_books table holds every book in one of four states: queued (queued_at
// set), current (queued_at, finished_at and abandoned_at all NULL, exactly one),
// finished (finished_at stamped), and set aside (abandoned_at stamped - started
// but shelved without finishing, so it is NOT a past read). The owner queues
// up-next books, promotes them, and can send any book back to the queue.

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
    visibility: Boolean(row.is_open) ? 'public' : 'closed',
    isOpen: Boolean(row.is_open),
    archived: Boolean(row.archived),
    createdAt: Number(row.created_at),
    lastActivityAt: Number(row.last_activity_at ?? row.created_at),
    recBasis: normalizeRecBasis(row.rec_basis == null ? undefined : String(row.rec_basis)),
    allowCommentEditing:
      row.allow_comment_editing == null ? true : Boolean(row.allow_comment_editing),
    allowReplies: row.allow_replies == null ? true : Boolean(row.allow_replies),
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
    abandonedAt: row.abandoned_at == null ? null : Number(row.abandoned_at),
    sortOrder: Number(row.sort_order ?? 0),
  }
}

// One club by id, or null. Does not filter archived (callers decide).
export async function getClub(serverId, clubId) {
  if (!clubId) return null
  await ensure()
  const r = await db.execute({
    sql: `SELECT id, name, created_by, is_open, archived, created_at, rec_basis, allow_comment_editing, allow_replies
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

// The club's reading history: current + finished + set-aside books, in
// started_at order. Excludes queued books - those aren't part of the timeline
// yet (see listQueue). Callers separate past reads (finished_at) from set-aside
// books (abandoned_at); the current book has neither stamp.
export async function listBooks(serverId, clubId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT library_item_id, title, author, added_by, started_at, finished_at, queued_at, abandoned_at, sort_order
          FROM club_books WHERE server_id = ? AND club_id = ? AND queued_at IS NULL
          ORDER BY started_at ASC`,
    args: [serverId, clubId],
  })
  return r.rows.map(mapBookRow)
}

// The up-next queue: books queued but not yet started, in the owner's order
// (sort_order, then queued_at for rows predating ordering).
export async function listQueue(serverId, clubId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT library_item_id, title, author, added_by, started_at, finished_at, queued_at, abandoned_at, sort_order
          FROM club_books WHERE server_id = ? AND club_id = ?
            AND queued_at IS NOT NULL AND finished_at IS NULL
          ORDER BY sort_order ASC, queued_at ASC`,
    args: [serverId, clubId],
  })
  return r.rows.map(mapBookRow)
}

// The club's current book (started, not finished, not set aside, not queued),
// or null.
export async function currentBook(serverId, clubId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT library_item_id, title, author, added_by, started_at, finished_at, queued_at, abandoned_at, sort_order
          FROM club_books
          WHERE server_id = ? AND club_id = ? AND finished_at IS NULL AND queued_at IS NULL
            AND abandoned_at IS NULL
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
  { name, createdBy, username, libraryItemId, bookSnapshot, visibility = 'public' },
) {
  await ensure()
  const id = crypto.randomUUID()
  const now = Date.now()
  await db.execute({
    sql: `INSERT INTO clubs (id, server_id, name, created_by, is_open, archived, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)`,
    args: [id, serverId, name, createdBy, visibility === 'closed' ? 0 : 1, now],
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

// Advance the club to a new current book. The outgoing current book leaves the
// slot as either a past read (finishPrevious true - the club read it to the end)
// or set aside (finishPrevious false - the club shelved it unread, so it stays
// eligible to come back via requeueBook). Then upsert the new one as
// started/current, clearing every terminal stamp so promoting a queued, set
// aside, or past book all work. `bookSnapshot` is { title, author }.
export async function setCurrentBook(
  serverId,
  clubId,
  { libraryItemId, addedBy, bookSnapshot, finishPrevious = true },
) {
  await ensure()
  const now = Date.now()
  // Stamp the outgoing current book (if any) unless it's the same item. Only the
  // started current book qualifies (queued_at NULL, no terminal stamp) - queued
  // books also have finished_at NULL and must not be stamped here.
  await db.execute({
    sql: `UPDATE club_books SET ${finishPrevious ? 'finished_at' : 'abandoned_at'} = ?
          WHERE server_id = ? AND club_id = ? AND finished_at IS NULL AND queued_at IS NULL
            AND abandoned_at IS NULL AND library_item_id != ?`,
    args: [now, serverId, clubId, libraryItemId],
  })
  // Upsert the new current book; re-adding a past, set aside, or queued book
  // clears its stamps and restamps started_at now.
  await db.execute({
    sql: `INSERT INTO club_books (server_id, club_id, library_item_id, title, author, added_by, started_at, finished_at, queued_at, abandoned_at, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)
          ON CONFLICT (server_id, club_id, library_item_id)
          DO UPDATE SET finished_at = NULL, queued_at = NULL, abandoned_at = NULL,
                        started_at = excluded.started_at, title = excluded.title,
                        author = excluded.author, added_by = excluded.added_by`,
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

// The next sort_order for a club's queue (max + 1, so new books land at the
// back). Returns 0 for an empty queue.
async function nextQueueOrder(serverId, clubId) {
  const r = await db.execute({
    sql: `SELECT COALESCE(MAX(sort_order), -1) AS m FROM club_books
          WHERE server_id = ? AND club_id = ? AND queued_at IS NOT NULL AND finished_at IS NULL`,
    args: [serverId, clubId],
  })
  return (Number(r.rows[0]?.m) || 0) + 1
}

// Move a book that already left the queue - a past read or a set aside book -
// back into the up-next queue, clearing its terminal stamps. This is how a club
// un-does a book it shelved (or one wrongly marked finished). Refuses to touch
// the current book: promote a different book first. Returns true if a row moved.
export async function requeueBook(serverId, clubId, libraryItemId) {
  await ensure()
  const order = await nextQueueOrder(serverId, clubId)
  const r = await db.execute({
    sql: `UPDATE club_books
          SET queued_at = ?, finished_at = NULL, abandoned_at = NULL, started_at = 0,
              sort_order = ?
          WHERE server_id = ? AND club_id = ? AND library_item_id = ?
            AND queued_at IS NULL
            AND (finished_at IS NOT NULL OR abandoned_at IS NOT NULL)`,
    args: [Date.now(), order, serverId, clubId, libraryItemId],
  })
  return (r.rowsAffected ?? 0) > 0
}

// Rewrite the queue's order from an explicit list of library item ids. Ids not
// currently queued are ignored; queued books the list omits keep their relative
// order after the listed ones, so a partial list can never drop a book.
export async function reorderQueue(serverId, clubId, libraryItemIds) {
  await ensure()
  const queue = await listQueue(serverId, clubId)
  const queued = new Set(queue.map((b) => b.libraryItemId))
  const wanted = libraryItemIds.filter((id) => queued.has(id))
  const seen = new Set(wanted)
  const finalOrder = [...wanted, ...queue.map((b) => b.libraryItemId).filter((id) => !seen.has(id))]
  for (let i = 0; i < finalOrder.length; i++) {
    await db.execute({
      sql: `UPDATE club_books SET sort_order = ?
            WHERE server_id = ? AND club_id = ? AND library_item_id = ? AND queued_at IS NOT NULL`,
      args: [i, serverId, clubId, finalOrder[i]],
    })
  }
  return finalOrder.length
}

// Add a book to the up-next queue. No-op (returns false) if the book is already
// in the club (queued, current, or finished) - re-queueing a finished book would
// need an explicit re-add via setCurrentBook. `bookSnapshot` is { title, author }.
export async function enqueueBook(serverId, clubId, { libraryItemId, addedBy, bookSnapshot }) {
  await ensure()
  if (await bookInClub(serverId, clubId, libraryItemId)) return false
  const now = Date.now()
  const order = await nextQueueOrder(serverId, clubId)
  await db.execute({
    sql: `INSERT INTO club_books (server_id, club_id, library_item_id, title, author, added_by, started_at, finished_at, queued_at, abandoned_at, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?)`,
    args: [
      serverId,
      clubId,
      libraryItemId,
      bookSnapshot?.title || '',
      bookSnapshot?.author || '',
      addedBy,
      now,
      order,
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

// Permanently delete a club and its club-scoped data.
export async function deleteClub(serverId, clubId) {
  await ensure()
  await db.execute('BEGIN')
  try {
    await db.execute({
      sql: `DELETE FROM book_notes WHERE server_id = ? AND club_id = ?`,
      args: [serverId, clubId],
    })
    await db.execute({
      sql: `DELETE FROM club_books WHERE server_id = ? AND club_id = ?`,
      args: [serverId, clubId],
    })
    await db.execute({
      sql: `DELETE FROM club_members WHERE server_id = ? AND club_id = ?`,
      args: [serverId, clubId],
    })
    await db.execute({
      sql: `DELETE FROM notifications
            WHERE server_id = ? AND kind = 'club_invite'
              AND entity_id IN (SELECT id FROM club_invites WHERE server_id = ? AND club_id = ?)`,
      args: [serverId, serverId, clubId],
    })
    await db.execute({
      sql: `DELETE FROM club_invites WHERE server_id = ? AND club_id = ?`,
      args: [serverId, clubId],
    })
    const r = await db.execute({
      sql: `DELETE FROM clubs WHERE server_id = ? AND id = ?`,
      args: [serverId, clubId],
    })
    await db.execute('COMMIT')
    return (r.rowsAffected ?? 0) > 0
  } catch (err) {
    await db.execute('ROLLBACK')
    throw err
  }
}

// --- invitations -----------------------------------------------------------

export async function getClubInvite(serverId, inviteId) {
  if (!inviteId) return null
  await ensure()
  const result = await db.execute({
    sql: `SELECT id, club_id, inviter_user_id, inviter_username, invitee_user_id,
                 invitee_username, invitee_email, status, created_at, responded_at
            FROM club_invites WHERE server_id = ? AND id = ? LIMIT 1`,
    args: [serverId, inviteId],
  })
  const row = result.rows[0]
  if (!row) return null
  return {
    id: String(row.id),
    clubId: String(row.club_id),
    inviterUserId: String(row.inviter_user_id),
    inviterUsername: String(row.inviter_username ?? ''),
    inviteeUserId: String(row.invitee_user_id),
    inviteeUsername: String(row.invitee_username ?? ''),
    inviteeEmail: row.invitee_email ? String(row.invitee_email) : null,
    status: String(row.status ?? 'pending'),
    createdAt: Number(row.created_at),
    respondedAt: row.responded_at == null ? null : Number(row.responded_at),
  }
}

export async function listPendingClubInvites(serverId, clubId) {
  await ensure()
  const result = await db.execute({
    sql: `SELECT id, invitee_user_id, invitee_username, created_at
            FROM club_invites
           WHERE server_id = ? AND club_id = ? AND status = 'pending'
           ORDER BY created_at DESC`,
    args: [serverId, clubId],
  })
  return result.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.invitee_user_id),
    username: String(row.invitee_username ?? ''),
    createdAt: Number(row.created_at),
  }))
}

export async function createClubInvite(
  serverId,
  clubId,
  { inviterUserId, inviterUsername, inviteeUserId, inviteeUsername, inviteeEmail },
) {
  await ensure()
  const id = crypto.randomUUID()
  const now = Date.now()
  // Re-inviting after decline resets the same unique user/club slot to pending;
  // a duplicate pending invite is reported as existing and does not notify twice.
  const existing = await db.execute({
    sql: `SELECT id, status FROM club_invites
          WHERE server_id = ? AND club_id = ? AND invitee_user_id = ? LIMIT 1`,
    args: [serverId, clubId, inviteeUserId],
  })
  const row = existing.rows[0]
  if (row && String(row.status) === 'pending') {
    return { id: String(row.id), created: false }
  }
  if (row) {
    await db.execute({
      sql: `UPDATE club_invites
               SET id = ?, inviter_user_id = ?, inviter_username = ?,
                   invitee_username = ?, invitee_email = ?, status = 'pending',
                   created_at = ?, responded_at = NULL
             WHERE server_id = ? AND club_id = ? AND invitee_user_id = ?`,
      args: [
        id,
        inviterUserId,
        inviterUsername || '',
        inviteeUsername || '',
        inviteeEmail || null,
        now,
        serverId,
        clubId,
        inviteeUserId,
      ],
    })
  } else {
    await db.execute({
      sql: `INSERT INTO club_invites
              (id, server_id, club_id, inviter_user_id, inviter_username,
               invitee_user_id, invitee_username, invitee_email, status, created_at, responded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      args: [
        id,
        serverId,
        clubId,
        inviterUserId,
        inviterUsername || '',
        inviteeUserId,
        inviteeUsername || '',
        inviteeEmail || null,
        now,
      ],
    })
  }
  return { id, created: true }
}

export async function respondToClubInvite(
  serverId,
  inviteId,
  inviteeUserId,
  accept,
  username = '',
) {
  await ensure()
  await db.execute('BEGIN IMMEDIATE')
  try {
    const invite = await getClubInvite(serverId, inviteId)
    if (!invite || invite.inviteeUserId !== inviteeUserId || invite.status !== 'pending') {
      await db.execute('ROLLBACK')
      return null
    }
    const status = accept ? 'accepted' : 'declined'
    const updated = await db.execute({
      sql: `UPDATE club_invites SET status = ?, responded_at = ?
            WHERE server_id = ? AND id = ? AND status = 'pending'`,
      args: [status, Date.now(), serverId, inviteId],
    })
    if ((updated.rowsAffected ?? 0) === 0) {
      await db.execute('ROLLBACK')
      return null
    }
    if (accept) {
      await db.execute({
        sql: `INSERT INTO club_members
                (server_id, club_id, user_id, username, role, joined_at, last_read_at)
              VALUES (?, ?, ?, ?, 'member', ?, 0)
              ON CONFLICT (server_id, club_id, user_id)
              DO UPDATE SET username = excluded.username`,
        args: [
          serverId,
          invite.clubId,
          inviteeUserId,
          username || invite.inviteeUsername,
          Date.now(),
        ],
      })
    }
    await db.execute('COMMIT')
    return { ...invite, status }
  } catch (error) {
    await db.execute('ROLLBACK')
    throw error
  }
}

export async function revokeClubInvite(serverId, clubId, inviteId) {
  await ensure()
  const result = await db.execute({
    sql: `UPDATE club_invites SET status = 'revoked', responded_at = ?
          WHERE server_id = ? AND club_id = ? AND id = ? AND status = 'pending'`,
    args: [Date.now(), serverId, clubId, inviteId],
  })
  return (result.rowsAffected ?? 0) > 0
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

// Change whether a club is server-discoverable/open-join or invite-only.
export async function setClubVisibility(serverId, clubId, visibility) {
  if (visibility !== 'closed' && visibility !== 'public') return null
  await ensure()
  await db.execute({
    sql: `UPDATE clubs SET is_open = ? WHERE server_id = ? AND id = ?`,
    args: [visibility === 'public' ? 1 : 0, serverId, clubId],
  })
  return visibility
}

// Latest meaningful club activity. A queued book or a new discussion wakes an
// otherwise quiet club, rather than relying on creation/current-book dates.
export async function clubActivityAt(serverId, clubId, createdAt = 0) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT MAX(activity_at) AS activity_at FROM (
            SELECT created_at AS activity_at FROM clubs
              WHERE server_id = ? AND id = ?
            UNION ALL SELECT started_at FROM club_books
              WHERE server_id = ? AND club_id = ?
            UNION ALL SELECT finished_at FROM club_books
              WHERE server_id = ? AND club_id = ? AND finished_at IS NOT NULL
            UNION ALL SELECT queued_at FROM club_books
              WHERE server_id = ? AND club_id = ? AND queued_at IS NOT NULL
            UNION ALL SELECT abandoned_at FROM club_books
              WHERE server_id = ? AND club_id = ? AND abandoned_at IS NOT NULL
            UNION ALL SELECT created_at FROM book_notes
              WHERE server_id = ? AND club_id = ?
          )`,
    args: [
      serverId,
      clubId,
      serverId,
      clubId,
      serverId,
      clubId,
      serverId,
      clubId,
      serverId,
      clubId,
      serverId,
      clubId,
    ],
  })
  return Number(r.rows[0]?.activity_at) || Number(createdAt) || 0
}

// Update member discussion policy for one club. Both values are explicit so a
// partial client cannot accidentally reset the other switch.
export async function setClubSettings(serverId, clubId, { allowCommentEditing, allowReplies }) {
  await ensure()
  await db.execute({
    sql: `UPDATE clubs SET allow_comment_editing = ?, allow_replies = ?
          WHERE server_id = ? AND id = ?`,
    args: [allowCommentEditing ? 1 : 0, allowReplies ? 1 : 0, serverId, clubId],
  })
  return { allowCommentEditing: Boolean(allowCommentEditing), allowReplies: Boolean(allowReplies) }
}

// Clubs the user belongs to, with member counts + current book resolved by the
// caller. Returns club summaries (without memberCount/currentBook - the route
// assembles those, one query each, to keep this layer thin).
export async function listMyClubs(serverId, userId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT c.id, c.name, c.created_by, c.is_open, c.archived, c.created_at, c.rec_basis, c.allow_comment_editing, c.allow_replies
          FROM clubs c
          JOIN club_members m ON m.server_id = c.server_id AND m.club_id = c.id
          WHERE c.server_id = ? AND m.user_id = ? AND c.archived = 0
          ORDER BY c.created_at DESC`,
    args: [serverId, userId],
  })
  return r.rows.map(mapClubRow)
}

// Open, non-archived clubs whose CURRENT book (no terminal stamp, not queued) is
// the item. A book the club set aside no longer advertises the club.
export async function listJoinableClubs(serverId, libraryItemId = '') {
  await ensure()
  if (!libraryItemId) {
    const r = await db.execute({
      sql: `SELECT c.id, c.name, c.created_by, c.is_open, c.archived, c.created_at, c.rec_basis,
                   c.allow_comment_editing, c.allow_replies
            FROM clubs c
            WHERE c.server_id = ? AND c.is_open = 1 AND c.archived = 0
            ORDER BY c.created_at DESC`,
      args: [serverId],
    })
    return r.rows.map(mapClubRow)
  }
  const r = await db.execute({
    sql: `SELECT c.id, c.name, c.created_by, c.is_open, c.archived, c.created_at, c.rec_basis, c.allow_comment_editing, c.allow_replies
          FROM clubs c
          JOIN club_books cb ON cb.server_id = c.server_id AND cb.club_id = c.id
          WHERE c.server_id = ? AND c.is_open = 1 AND c.archived = 0
            AND cb.library_item_id = ? AND cb.finished_at IS NULL AND cb.queued_at IS NULL
            AND cb.abandoned_at IS NULL
          ORDER BY c.created_at DESC`,
    args: [serverId, libraryItemId],
  })
  return r.rows.map(mapClubRow)
}
