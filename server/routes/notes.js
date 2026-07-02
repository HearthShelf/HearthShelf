// Public + club notes. Mounted under /hs/notes.
//
//   GET    /hs/notes?libraryItemId=&clubId=&position=&after=&finished=
//   POST   /hs/notes   { libraryItemId, clubId?, parentId?, timeSec?, body }
//   DELETE /hs/notes/:id
//
// The spoiler gate lives in lib/notesQuery.js (the one authoritative server-side
// implementation; core's gateNotes is client-only). Public notes never return
// locked stubs (locked is club-scope only); club notes require membership.
// notes_enabled=0 (admin kill-switch) hides GET ({ enabled:false }) and 403s
// POST. All degradations are 200 envelopes, never thrown errors.

import { json, readBody } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { getCommunityConfig } from '../community.js'
import { check, consume } from '../ratelimit.js'
import {
  loadNotes,
  getNote,
  gateNotes,
  resolveGatePosition,
  insertNote,
  softDeleteNote,
} from '../lib/notesQuery.js'
import { getClub, isClubMember, bookInClub, currentBook } from '../clubs.js'

const NOTES_RATE_LIMIT = '60/hour'
const BODY_MAX = 2000
// ABS library-item / club / note ids are opaque tokens (UUIDs, nanoids). Reject
// anything outside this shape early with 400 invalid_id, for consistency with
// the club routes and to keep ids safe to interpolate into URLs/queries.
const ID_RE = /^[A-Za-z0-9_-]+$/

// Verify the club exists and the caller is a member. Returns an error token
// ('club_not_found' | 'not_member') or null when OK.
async function checkClubAccess(serverId, clubId, userId) {
  const club = await getClub(serverId, clubId)
  if (!club) return 'club_not_found'
  if (!(await isClubMember(serverId, clubId, userId))) return 'not_member'
  return null
}

export async function handleNotes(req, res, url, ctx) {
  const p = url.pathname
  if (p !== '/hs/notes' && !p.startsWith('/hs/notes/')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  // DELETE /hs/notes/:id
  if (p.startsWith('/hs/notes/')) {
    if (req.method !== 'DELETE') return (json(res, 405, { error: 'method_not_allowed' }), true)
    const id = decodeURIComponent(p.slice('/hs/notes/'.length))
    if (!id) return (json(res, 400, { error: 'missing_id' }), true)
    const note = await getNote(ctx.serverId, id)
    if (!note || note.deleted) return (json(res, 404, { error: 'not_found' }), true)
    // Author, the owner of the note's club, or a server admin may delete.
    let allowed = note.userId === ctx.userId || isAdmin(ctx)
    if (!allowed && note.clubId) {
      const club = await getClub(ctx.serverId, note.clubId)
      if (club && club.createdBy === ctx.userId) allowed = true
    }
    if (!allowed) return (json(res, 403, { error: 'forbidden' }), true)
    await softDeleteNote(ctx.serverId, id)
    return (json(res, 200, { ok: true }), true)
  }

  const cfg = await getCommunityConfig()

  if (req.method === 'GET') {
    if (!cfg.notesEnabled) return (json(res, 200, { enabled: false }), true)
    const libraryItemId = url.searchParams.get('libraryItemId') || ''
    if (!libraryItemId) return (json(res, 400, { error: 'missing_libraryItemId' }), true)
    if (!ID_RE.test(libraryItemId)) return (json(res, 400, { error: 'invalid_id' }), true)
    const clubId = url.searchParams.get('clubId') || ''
    if (clubId && !ID_RE.test(clubId)) return (json(res, 400, { error: 'invalid_id' }), true)
    let isClubCurrentBook = false
    if (clubId) {
      const err = await checkClubAccess(ctx.serverId, clubId, ctx.userId)
      if (err === 'club_not_found') return (json(res, 404, { error: 'club_not_found' }), true)
      if (err === 'not_member') return (json(res, 403, { error: 'not_member' }), true)
      // Locked stubs (timeline ticks) are only correct for the club's CURRENT
      // book - a past book has no "ahead" to tease. Match clubs.js's detail path.
      const current = await currentBook(ctx.serverId, clubId)
      isClubCurrentBook = Boolean(current) && current.libraryItemId === libraryItemId
    }
    const position = Number.parseFloat(url.searchParams.get('position') ?? '')
    const afterRaw = url.searchParams.get('after')
    const afterParsed = afterRaw != null ? Number.parseInt(afterRaw, 10) : null
    const after = afterParsed != null && Number.isFinite(afterParsed) ? afterParsed : null
    const finishedClaim = url.searchParams.get('finished') === '1'

    const { position: pos, isFinished } = await resolveGatePosition(
      ctx,
      libraryItemId,
      position,
      finishedClaim,
    )
    // Load the FULL scope (including deleted rows for the gate's parent map);
    // `after` is a post-gate filter, never a DB filter, so a reply's parent is
    // always present to gate it (see lib/notesQuery.js).
    const rows = await loadNotes(ctx.serverId, libraryItemId, clubId, ctx.userId, true)
    // Locked stubs are club-scope only, and only for the club's CURRENT book
    // (public-note stubs would render as timeline ticks but the public GET
    // withholds them per docs/social.md).
    const gated = gateNotes(rows, {
      position: pos,
      meId: ctx.userId,
      isFinished,
      includeLocked: isClubCurrentBook,
      after,
    })
    return (
      json(res, 200, {
        enabled: true,
        notes: gated.notes,
        locked: gated.locked,
        hiddenAhead: gated.hiddenAhead,
        now: Date.now(),
      }),
      true
    )
  }

  if (req.method === 'POST') {
    if (!cfg.notesEnabled) return (json(res, 403, { error: 'notes_disabled' }), true)
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const libraryItemId = String(body?.libraryItemId ?? '')
    if (!libraryItemId) return (json(res, 400, { error: 'missing_libraryItemId' }), true)
    if (!ID_RE.test(libraryItemId)) return (json(res, 400, { error: 'invalid_id' }), true)
    const clubId = String(body?.clubId ?? '')
    if (clubId && !ID_RE.test(clubId)) return (json(res, 400, { error: 'invalid_id' }), true)
    const parentId = String(body?.parentId ?? '')
    if (parentId && !ID_RE.test(parentId)) return (json(res, 400, { error: 'invalid_id' }), true)

    // Visibility (docs/social.md): a club post is always 'club' (implicit, from
    // posting in the club room); a general post is 'public' (default) or
    // 'personal'. Enforce the visibility<->clubId pairing:
    //   - clubId set   -> force visibility='club' (membership checked below).
    //   - no clubId     -> visibility must be 'public' or 'personal'; a 'club'
    //                      value with no clubId is rejected (invalid_visibility).
    let visibility
    const visRaw = body?.visibility == null ? '' : String(body.visibility)
    if (clubId) {
      // A clubId with an explicit non-club visibility is contradictory.
      if (visRaw && visRaw !== 'club') return (json(res, 400, { error: 'invalid_visibility' }), true)
      visibility = 'club'
    } else {
      visibility = visRaw || 'public'
      if (visibility !== 'public' && visibility !== 'personal') {
        return (json(res, 400, { error: 'invalid_visibility' }), true)
      }
    }

    // safe: author-declared spoiler-free (bypasses the position gate). Coerced to
    // a bool; forced false on replies (only top-level notes may be safe).
    const safe = parentId ? false : Boolean(body?.safe)

    // Body: trimmed, 1..2000 chars.
    const text = typeof body?.body === 'string' ? body.body.trim() : ''
    if (text.length < 1 || text.length > BODY_MAX) {
      return (json(res, 400, { error: 'invalid_body_text' }), true)
    }

    // timeSec: null/absent, or a finite number >= 0.
    let timeSec = null
    if (body?.timeSec != null) {
      const t = Number(body.timeSec)
      if (!Number.isFinite(t) || t < 0) return (json(res, 400, { error: 'invalid_timeSec' }), true)
      timeSec = t
    }

    // Club scope: the club must exist and be non-archived, the caller must be a
    // member, and the book must be in the club's reading history (a note can only
    // attach to a book the club is or was reading).
    if (clubId) {
      const club = await getClub(ctx.serverId, clubId)
      if (!club) return (json(res, 404, { error: 'club_not_found' }), true)
      if (club.archived) return (json(res, 403, { error: 'archived' }), true)
      if (!(await isClubMember(ctx.serverId, clubId, ctx.userId))) {
        return (json(res, 403, { error: 'not_member' }), true)
      }
      if (!(await bookInClub(ctx.serverId, clubId, libraryItemId))) {
        return (json(res, 400, { error: 'book_not_in_club' }), true)
      }
    }

    // parentId must reference an existing TOP-LEVEL note in the same (server,
    // item, club) scope. Replies-of-replies are not allowed (parent must itself
    // be top-level).
    if (parentId) {
      const parent = await getNote(ctx.serverId, parentId)
      if (
        !parent ||
        parent.deleted ||
        parent.parentId ||
        parent.libraryItemId !== libraryItemId ||
        parent.clubId !== clubId
      ) {
        return (json(res, 400, { error: 'invalid_parent' }), true)
      }
    }

    // Rate limit: 60 notes/user/hour, reusing the durable rate_limits table.
    const rl = await check(ctx.serverId, ctx.userId, NOTES_RATE_LIMIT, 'notes')
    if (!rl.allowed) return (json(res, 429, { error: 'rate_limited' }), true)

    const note = await insertNote(ctx.serverId, {
      userId: ctx.userId,
      username: ctx.username,
      libraryItemId,
      clubId,
      visibility,
      parentId,
      timeSec,
      safe,
      body: text,
    })
    await consume(ctx.serverId, ctx.userId, NOTES_RATE_LIMIT, 'notes')
    return (json(res, 200, note), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
