// Book Clubs. Mounted under /hs/clubs.
//
//   GET    /hs/clubs?libraryItemId=            -> { enabled, mine, joinable }
//   POST   /hs/clubs   { name, libraryItemId? } -> HSClub (creator = owner)
//   POST   /hs/clubs/:id/books  { libraryItemId } (owner) -> advance current book
//   POST   /hs/clubs/:id/join                   -> join (open + not archived)
//   POST   /hs/clubs/:id/leave                  -> leave (owner cannot)
//   POST   /hs/clubs/:id/kick   { userId } (owner)
//   GET    /hs/clubs/:id?bookId=&position=       -> HSClubDetail (membership req.)
//   PUT    /hs/clubs/:id/read   { lastReadAt }   -> max() cursor bump
//   DELETE /hs/clubs/:id                         -> archive (owner or admin)
//
// A club is a persistent multi-book group (see docs/social.md). The book data
// layer is server/clubs.js; the notes gate is lib/notesQuery.js - both single
// authoritative implementations. clubs_enabled=0 (admin kill-switch) returns
// { enabled:false } on GET and 403 on writes.

import { json, readBody } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { getCommunityConfig } from '../community.js'
import { check, consume } from '../ratelimit.js'
import {
  absDbAvailable,
  getMemberProgress,
  getActiveListeners,
} from '../lib/absdb.js'
import { loadNotes, gateNotes, resolveGatePosition, unreadCount } from '../lib/notesQuery.js'
import {
  getClub,
  getMembership,
  listMembers,
  memberCount,
  listBooks,
  currentBook,
  createClub,
  setCurrentBook,
  addMember,
  removeMember,
  bumpReadCursor,
  archiveClub,
  listMyClubs,
  listJoinableClubs,
} from '../clubs.js'

const CLUB_CREATE_LIMIT = '10/day'
const NAME_MAX = 120
const LISTENING_CUTOFF_MS = 3 * 60 * 1000

// Fetch a book's title/author from ABS as the caller (the routes/stats.js
// pattern), for the club_books snapshot. Returns { title, author }, both '' on
// any failure so a snapshot never blocks adding a book.
async function fetchBookSnapshot(ctx, libraryItemId) {
  try {
    const r = await fetch(`${ctx.absUrl}/api/items/${libraryItemId}`, {
      headers: { Authorization: `Bearer ${ctx.absToken}` },
    })
    if (!r.ok) return { title: '', author: '' }
    const item = await r.json()
    const md = item?.media?.metadata ?? {}
    const title = typeof md.title === 'string' ? md.title : ''
    const author =
      typeof md.authorName === 'string'
        ? md.authorName
        : Array.isArray(md.authors)
          ? md.authors.map((a) => a?.name).filter(Boolean).join(', ')
          : ''
    return { title, author }
  } catch {
    return { title: '', author: '' }
  }
}

// Assemble an HSClub summary (adds memberCount + currentBook to a club row).
async function clubSummary(serverId, club) {
  const [count, current] = await Promise.all([
    memberCount(serverId, club.id),
    currentBook(serverId, club.id),
  ])
  return { ...club, memberCount: count, currentBook: current }
}

// The last path segment after /hs/clubs/<id>/... - the club id.
function parseClubPath(pathname) {
  // /hs/clubs/:id            -> { id, action: '' }
  // /hs/clubs/:id/<action>   -> { id, action }
  const rest = pathname.slice('/hs/clubs/'.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return { id: decodeURIComponent(rest), action: '' }
  return {
    id: decodeURIComponent(rest.slice(0, slash)),
    action: rest.slice(slash + 1),
  }
}

async function readJson(req) {
  try {
    return JSON.parse(await readBody(req))
  } catch {
    return null
  }
}

export async function handleClubs(req, res, url, ctx) {
  const p = url.pathname
  if (p !== '/hs/clubs' && !p.startsWith('/hs/clubs/')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  const cfg = await getCommunityConfig()

  // --- Collection routes: /hs/clubs ---------------------------------------
  if (p === '/hs/clubs') {
    if (req.method === 'GET') {
      if (!cfg.clubsEnabled) return (json(res, 200, { enabled: false }), true)
      const libraryItemId = url.searchParams.get('libraryItemId') || ''
      const mineRows = await listMyClubs(ctx.serverId, ctx.userId)
      const mine = await Promise.all(mineRows.map((c) => clubSummary(ctx.serverId, c)))
      let joinable = []
      if (libraryItemId) {
        const joinRows = await listJoinableClubs(ctx.serverId, libraryItemId)
        // Don't list a club the caller already belongs to as joinable.
        const mineIds = new Set(mineRows.map((c) => c.id))
        joinable = await Promise.all(
          joinRows.filter((c) => !mineIds.has(c.id)).map((c) => clubSummary(ctx.serverId, c)),
        )
      }
      return (json(res, 200, { enabled: true, mine, joinable }), true)
    }
    if (req.method === 'POST') {
      if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
      const body = await readJson(req)
      if (!body) return (json(res, 400, { error: 'invalid_body' }), true)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length < 1 || name.length > NAME_MAX) {
        return (json(res, 400, { error: 'invalid_name' }), true)
      }
      const libraryItemId =
        typeof body.libraryItemId === 'string' && body.libraryItemId ? body.libraryItemId : ''

      const rl = await check(ctx.serverId, ctx.userId, CLUB_CREATE_LIMIT, 'clubs')
      if (!rl.allowed) return (json(res, 429, { error: 'rate_limited' }), true)

      const snapshot = libraryItemId ? await fetchBookSnapshot(ctx, libraryItemId) : null
      const id = await createClub(ctx.serverId, {
        name,
        createdBy: ctx.userId,
        username: ctx.username,
        libraryItemId,
        bookSnapshot: snapshot,
      })
      await consume(ctx.serverId, ctx.userId, CLUB_CREATE_LIMIT, 'clubs')
      const club = await getClub(ctx.serverId, id)
      return (json(res, 200, await clubSummary(ctx.serverId, club)), true)
    }
    return (json(res, 405, { error: 'method_not_allowed' }), true)
  }

  // --- Instance routes: /hs/clubs/:id[/action] ----------------------------
  const { id: clubId, action } = parseClubPath(p)
  if (!clubId) return (json(res, 400, { error: 'missing_id' }), true)

  const club = await getClub(ctx.serverId, clubId)
  if (!club) return (json(res, 404, { error: 'not_found' }), true)
  const membership = await getMembership(ctx.serverId, clubId, ctx.userId)
  const isOwner = membership?.role === 'owner' || club.createdBy === ctx.userId

  // DELETE /hs/clubs/:id -> archive (owner or admin)
  if (action === '' && req.method === 'DELETE') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (!isOwner && !isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    await archiveClub(ctx.serverId, clubId)
    return (json(res, 200, { ok: true }), true)
  }

  // GET /hs/clubs/:id?bookId=&position= -> detail (membership required)
  if (action === '' && req.method === 'GET') {
    if (!cfg.clubsEnabled) return (json(res, 200, { enabled: false }), true)
    if (!membership) return (json(res, 403, { error: 'not_member' }), true)

    const books = await listBooks(ctx.serverId, clubId)
    const current = books.find((b) => b.finishedAt == null) || null
    const requestedBookId = url.searchParams.get('bookId') || ''
    // Which book we're viewing: the requested one if it's in this club, else the
    // current book, else the most recent past book.
    const viewedBook =
      (requestedBookId && books.find((b) => b.libraryItemId === requestedBookId)) ||
      current ||
      books[books.length - 1] ||
      null
    const viewedBookId = viewedBook ? viewedBook.libraryItemId : ''
    const isCurrent = Boolean(current) && viewedBookId === current.libraryItemId

    const members = await listMembers(ctx.serverId, clubId)
    const memberIds = members.map((m) => m.userId)

    // Per-member progress in the viewed book + who's listening now (current book
    // only), both from absdb when available.
    let progress = new Map()
    let listeningIds = new Set()
    if (viewedBookId && (await absDbAvailable())) {
      progress = await getMemberProgress(memberIds, viewedBookId)
      if (isCurrent) {
        const rows = await getActiveListeners([viewedBookId], LISTENING_CUTOFF_MS)
        listeningIds = new Set(rows.map((r) => r.userId))
      }
    }
    const memberOut = members.map((m) => {
      const pr = progress.get(m.userId) || null
      return {
        userId: m.userId,
        username: m.username,
        role: m.role,
        joinedAt: m.joinedAt,
        currentTime: pr ? pr.currentTime : null,
        duration: pr ? pr.duration : null,
        isFinished: pr ? pr.isFinished : null,
        listeningNow: listeningIds.has(m.userId),
      }
    })

    // Notes for the viewed book, gated against the caller's position in it.
    // Locked stubs are returned only for the current book.
    let notes = { notes: [], locked: [], hiddenAhead: 0 }
    let unread = 0
    if (viewedBookId) {
      const position = Number.parseFloat(url.searchParams.get('position') ?? '')
      const { position: pos, isFinished } = await resolveGatePosition(
        ctx,
        viewedBookId,
        position,
        false,
      )
      const rows = await loadNotes(ctx.serverId, viewedBookId, clubId, null)
      notes = gateNotes(rows, {
        position: pos,
        meId: ctx.userId,
        isFinished,
        includeLocked: isCurrent,
      })
      unread = unreadCount(notes.notes, membership.lastReadAt)
    }

    return (
      json(res, 200, {
        enabled: true,
        club: await clubSummary(ctx.serverId, club),
        books,
        members: memberOut,
        notes,
        unreadCount: unread,
      }),
      true
    )
  }

  // POST /hs/clubs/:id/books { libraryItemId } -> advance current book (owner)
  if (action === 'books' && req.method === 'POST') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (!isOwner) return (json(res, 403, { error: 'forbidden' }), true)
    const body = await readJson(req)
    if (!body) return (json(res, 400, { error: 'invalid_body' }), true)
    const libraryItemId =
      typeof body.libraryItemId === 'string' && body.libraryItemId ? body.libraryItemId : ''
    if (!libraryItemId) return (json(res, 400, { error: 'missing_libraryItemId' }), true)
    const snapshot = await fetchBookSnapshot(ctx, libraryItemId)
    await setCurrentBook(ctx.serverId, clubId, {
      libraryItemId,
      addedBy: ctx.userId,
      bookSnapshot: snapshot,
    })
    return (json(res, 200, await clubSummary(ctx.serverId, club)), true)
  }

  // POST /hs/clubs/:id/join -> join (open + not archived)
  if (action === 'join' && req.method === 'POST') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (membership) return (json(res, 200, { ok: true }), true) // already a member
    if (club.archived) return (json(res, 403, { error: 'archived' }), true)
    if (!club.isOpen) return (json(res, 403, { error: 'not_open' }), true)
    await addMember(ctx.serverId, clubId, ctx.userId, ctx.username)
    return (json(res, 200, { ok: true }), true)
  }

  // POST /hs/clubs/:id/leave -> leave (owner cannot; they archive instead)
  if (action === 'leave' && req.method === 'POST') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (!membership) return (json(res, 200, { ok: true }), true) // not a member
    if (isOwner) return (json(res, 400, { error: 'owner_must_archive' }), true)
    await removeMember(ctx.serverId, clubId, ctx.userId)
    return (json(res, 200, { ok: true }), true)
  }

  // POST /hs/clubs/:id/kick { userId } -> owner only, not the owner, 404 if not a member
  if (action === 'kick' && req.method === 'POST') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (!isOwner) return (json(res, 403, { error: 'forbidden' }), true)
    const body = await readJson(req)
    if (!body) return (json(res, 400, { error: 'invalid_body' }), true)
    const targetId = typeof body.userId === 'string' ? body.userId : ''
    if (!targetId) return (json(res, 400, { error: 'missing_userId' }), true)
    if (targetId === club.createdBy) return (json(res, 400, { error: 'cannot_kick_owner' }), true)
    const target = await getMembership(ctx.serverId, clubId, targetId)
    if (!target) return (json(res, 404, { error: 'not_a_member' }), true)
    await removeMember(ctx.serverId, clubId, targetId)
    return (json(res, 200, { ok: true }), true)
  }

  // PUT /hs/clubs/:id/read { lastReadAt } -> max() cursor bump (per club)
  if (action === 'read' && req.method === 'PUT') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (!membership) return (json(res, 403, { error: 'not_member' }), true)
    const body = await readJson(req)
    if (!body) return (json(res, 400, { error: 'invalid_body' }), true)
    const lastReadAt = Number(body.lastReadAt)
    if (!Number.isFinite(lastReadAt)) return (json(res, 400, { error: 'invalid_lastReadAt' }), true)
    const cursor = await bumpReadCursor(ctx.serverId, clubId, ctx.userId, lastReadAt)
    return (json(res, 200, { lastReadAt: cursor }), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
