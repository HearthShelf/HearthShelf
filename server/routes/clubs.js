// Book Clubs. Mounted under /hs/clubs.
//
//   GET    /hs/clubs?libraryItemId=            -> { enabled, mine, joinable }
//   POST   /hs/clubs   { name, libraryItemId? } -> HSClub (creator = owner)
//   POST   /hs/clubs/:id/books  { libraryItemId } (owner) -> advance current book
//   POST   /hs/clubs/:id/queue  { libraryItemId } (owner) -> add to up-next queue
//   DELETE /hs/clubs/:id/queue/:itemId          (owner) -> remove a queued book
//   POST   /hs/clubs/:id/join                   -> join (open + not archived)
//   POST   /hs/clubs/:id/leave                  -> leave (owner cannot)
//   POST   /hs/clubs/:id/kick   { userId } (owner)
//   GET    /hs/clubs/:id?bookId=&position=       -> HSClubDetail (membership req.)
//   PUT    /hs/clubs/:id/read   { lastReadAt }   -> max() cursor bump
//   PUT    /hs/clubs/:id/rec-basis { basis } (owner) -> set recommendation basis
//   POST   /hs/clubs/:id/recommend { candidates, historyGenres } (owner) -> next-book picks
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
  getFinishedGenresForUsers,
} from '../lib/absdb.js'
import { loadNotes, gateNotes, resolveGatePosition, unreadCount } from '../lib/notesQuery.js'
import { getExplicitSharePrefs } from '../settings.js'
import { getConfig } from '../config.js'
import { isProviderConfigured, complete } from '../providers.js'
import { parseResult } from './questgiver.js'
import { craftClubPrompt, clubHeuristic } from '@hearthshelf/core/lib/social'
import {
  getClub,
  getMembership,
  listMembers,
  memberCount,
  listBooks,
  listQueue,
  currentBook,
  createClub,
  setCurrentBook,
  enqueueBook,
  removeQueued,
  addMember,
  removeMember,
  bumpReadCursor,
  archiveClub,
  setRecBasis,
  listMyClubs,
  listJoinableClubs,
} from '../clubs.js'

const CLUB_CREATE_LIMIT = '10/day'
const NAME_MAX = 120
const LISTENING_CUTOFF_MS = 3 * 60 * 1000
// ABS library-item ids are opaque tokens (UUIDs, nanoids). Validate their shape
// before we interpolate one into an ABS URL or a club_books row.
const ID_RE = /^[A-Za-z0-9_-]+$/

// Fetch a book's title/author from ABS as the caller (the routes/stats.js
// pattern), for the club_books snapshot. Returns { title, author }, both '' on
// any failure so a snapshot never blocks adding a book.
async function fetchBookSnapshot(ctx, libraryItemId) {
  try {
    const r = await fetch(`${ctx.absUrl}/api/items/${encodeURIComponent(libraryItemId)}`, {
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
          ? md.authors
              .map((a) => a?.name)
              .filter(Boolean)
              .join(', ')
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

// Turn a raw { genre -> count } tally into the ClubTaste shape the core
// recommender wants: a 0..10 weight per genre (scaled to the strongest), the
// dominant genre, and the sample size. Genres the club barely touches still
// carry a small non-zero weight so they can win ties, matching qgBuildProfile's
// feel. Returns { weights, dominant, sampleSize:0 } when the tally is empty.
function tasteFromCounts(counts, sampleSize) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0)
  if (!entries.length) return { weights: {}, dominant: null, sampleSize: 0 }
  const max = Math.max(...entries.map(([, n]) => n))
  const weights = {}
  for (const [g, n] of entries) weights[g] = Math.max(1, Math.round((n / max) * 10))
  const dominant = entries.sort((a, b) => b[1] - a[1])[0][0]
  return { weights, dominant, sampleSize }
}

// Build the club's taste from the chosen basis. club-history counts the genres
// of books the club has read together (from the posted candidate genres is not
// possible - history books aren't candidates - so the client posts the club's
// read genres); all-members-finished reads every member's finished-book genres
// from ABS's db (read-only). Returns a ClubTaste, or null when the basis yields
// nothing to work with. `historyGenres` is the client-supplied genre list for
// the club's own read books (used only for club-history).
async function buildClubTaste(basis, memberIds, historyGenres) {
  if (basis === 'all-members-finished') {
    const counts = await getFinishedGenresForUsers(memberIds)
    const sample = Object.values(counts).reduce((n, x) => n + x, 0)
    return tasteFromCounts(counts, sample)
  }
  // club-history: tally the genres of the club's own read books.
  const counts = {}
  let books = 0
  for (const gs of historyGenres) {
    if (!Array.isArray(gs) || !gs.length) continue
    books++
    for (const g of gs) {
      if (typeof g === 'string' && g) counts[g] = (counts[g] || 0) + 1
    }
  }
  return tasteFromCounts(counts, books)
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
      if (libraryItemId && !ID_RE.test(libraryItemId)) {
        return (json(res, 400, { error: 'invalid_id' }), true)
      }

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

    const [books, queue] = await Promise.all([
      listBooks(ctx.serverId, clubId),
      listQueue(ctx.serverId, clubId),
    ])
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
    // only), both from absdb when available. Membership consent covers the live
    // pulse when a member hasn't set shareCurrentlyListening, but an EXPLICIT
    // false always wins - the member's progress still shows, only the live pulse
    // hides (docs/social.md privacy table). The community default is NOT
    // consulted in-club; the caller always sees their own pulse.
    let progress = new Map()
    let listeningIds = new Set()
    let listenPrefs = new Map()
    if (viewedBookId && (await absDbAvailable())) {
      progress = await getMemberProgress(memberIds, viewedBookId)
      if (isCurrent) {
        const [rows, prefs] = await Promise.all([
          getActiveListeners([viewedBookId], LISTENING_CUTOFF_MS),
          getExplicitSharePrefs(ctx.serverId, 'shareCurrentlyListening'),
        ])
        listeningIds = new Set(rows.map((r) => r.userId))
        listenPrefs = prefs
      }
    }
    const memberOut = members.map((m) => {
      const pr = progress.get(m.userId) || null
      // An explicit shareCurrentlyListening=false hides the live pulse even from
      // fellow members; the caller always sees their own.
      const optedOut =
        m.userId !== ctx.userId && listenPrefs.has(m.userId) && listenPrefs.get(m.userId) === false
      return {
        userId: m.userId,
        username: m.username,
        role: m.role,
        joinedAt: m.joinedAt,
        currentTime: pr ? pr.currentTime : null,
        duration: pr ? pr.duration : null,
        isFinished: pr ? pr.isFinished : null,
        listeningNow: listeningIds.has(m.userId) && !optedOut,
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
      // Full scope (incl. deleted rows) so the gate's parent map is complete;
      // deleted rows are gated out of the output (see lib/notesQuery.js). The
      // club detail has no `after` cursor - it returns the whole gated thread.
      const rows = await loadNotes(ctx.serverId, viewedBookId, clubId, ctx.userId, true)
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
        queue,
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
    if (club.archived) return (json(res, 403, { error: 'archived' }), true)
    const body = await readJson(req)
    if (!body) return (json(res, 400, { error: 'invalid_body' }), true)
    const libraryItemId =
      typeof body.libraryItemId === 'string' && body.libraryItemId ? body.libraryItemId : ''
    if (!libraryItemId) return (json(res, 400, { error: 'missing_libraryItemId' }), true)
    if (!ID_RE.test(libraryItemId)) return (json(res, 400, { error: 'invalid_id' }), true)
    const snapshot = await fetchBookSnapshot(ctx, libraryItemId)
    await setCurrentBook(ctx.serverId, clubId, {
      libraryItemId,
      addedBy: ctx.userId,
      bookSnapshot: snapshot,
    })
    return (json(res, 200, await clubSummary(ctx.serverId, club)), true)
  }

  // POST /hs/clubs/:id/queue { libraryItemId } -> add to up-next queue (owner)
  if (action === 'queue' && req.method === 'POST') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (!isOwner) return (json(res, 403, { error: 'forbidden' }), true)
    if (club.archived) return (json(res, 403, { error: 'archived' }), true)
    const body = await readJson(req)
    if (!body) return (json(res, 400, { error: 'invalid_body' }), true)
    const libraryItemId =
      typeof body.libraryItemId === 'string' && body.libraryItemId ? body.libraryItemId : ''
    if (!libraryItemId) return (json(res, 400, { error: 'missing_libraryItemId' }), true)
    if (!ID_RE.test(libraryItemId)) return (json(res, 400, { error: 'invalid_id' }), true)
    const snapshot = await fetchBookSnapshot(ctx, libraryItemId)
    const added = await enqueueBook(ctx.serverId, clubId, {
      libraryItemId,
      addedBy: ctx.userId,
      bookSnapshot: snapshot,
    })
    // Already in the club (queued/current/finished): a no-op, not an error.
    return (json(res, 200, { ok: true, added }), true)
  }

  // DELETE /hs/clubs/:id/queue/:itemId -> remove a queued book (owner)
  if (action.startsWith('queue/') && req.method === 'DELETE') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (!isOwner) return (json(res, 403, { error: 'forbidden' }), true)
    const libraryItemId = decodeURIComponent(action.slice('queue/'.length))
    if (!libraryItemId) return (json(res, 400, { error: 'missing_libraryItemId' }), true)
    const removed = await removeQueued(ctx.serverId, clubId, libraryItemId)
    return (json(res, 200, { ok: true, removed }), true)
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

  // PUT /hs/clubs/:id/rec-basis { basis } -> set the recommendation basis (owner)
  if (action === 'rec-basis' && req.method === 'PUT') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (!isOwner) return (json(res, 403, { error: 'forbidden' }), true)
    const body = await readJson(req)
    if (!body) return (json(res, 400, { error: 'invalid_body' }), true)
    const stored = await setRecBasis(ctx.serverId, clubId, body.basis)
    if (stored == null) return (json(res, 400, { error: 'invalid_basis' }), true)
    return (json(res, 200, { recBasis: stored }), true)
  }

  // POST /hs/clubs/:id/recommend { candidates, historyGenres } -> next-book picks
  // (owner). candidates are the owner's unstarted library books (posted by the
  // client, matching the Discover pattern); historyGenres are the genre lists of
  // the club's own read books (for the club-history basis). AI runs only when the
  // admin allowed it AND a provider is configured; otherwise the deterministic
  // heuristic. Charged to the QuestGiver rate limit (only on an actual AI call).
  if (action === 'recommend' && req.method === 'POST') {
    if (!cfg.clubsEnabled) return (json(res, 403, { error: 'clubs_disabled' }), true)
    if (!isOwner) return (json(res, 403, { error: 'forbidden' }), true)
    if (club.archived) return (json(res, 403, { error: 'archived' }), true)
    if (club.recBasis === 'off') return (json(res, 403, { error: 'recommendations_off' }), true)

    const body = await readJson(req)
    if (!body) return (json(res, 400, { error: 'invalid_body' }), true)
    const candidates = Array.isArray(body.candidates) ? body.candidates : []
    const historyGenres = Array.isArray(body.historyGenres) ? body.historyGenres : []
    if (!candidates.length) return (json(res, 400, { error: 'no_candidates' }), true)
    // Drop books already anywhere in the club, and anything without an id.
    const inClub = new Set(
      (await Promise.all([listBooks(ctx.serverId, clubId), listQueue(ctx.serverId, clubId)])).flat().map((b) => b.libraryItemId),
    )
    const pool = candidates.filter(
      (c) => c && typeof c.libraryItemId === 'string' && c.libraryItemId && !inClub.has(c.libraryItemId),
    )
    if (!pool.length) return (json(res, 200, { engine: 'heuristic', basis: club.recBasis, intro: '', picks: [] }), true)

    const members = await listMembers(ctx.serverId, clubId)
    // all-members-finished needs ABS's db mounted to read finished genres; if
    // it isn't, tell the owner rather than silently recommending at random.
    if (club.recBasis === 'all-members-finished' && !(await absDbAvailable())) {
      return (json(res, 200, { engine: 'heuristic', basis: club.recBasis, intro: '', picks: [], unavailable: true }), true)
    }
    const taste = await buildClubTaste(
      club.recBasis,
      members.map((m) => m.userId),
      historyGenres,
    )

    // AI path: allowed by the admin AND a provider is configured. Charge the
    // QuestGiver limit; on any AI failure, fall through to the heuristic.
    const aiCfg = await getConfig()
    const wantAi = cfg.clubsAiEnabled && aiCfg.enabled && (await isProviderConfigured())
    if (wantAi) {
      const rate = await check(ctx.serverId, ctx.userId, aiCfg.limit)
      if (!rate.allowed) return (json(res, 429, { error: 'rate_limited', period: rate.period }), true)
      try {
        const prompt = craftClubPrompt(club.name, members.length, taste, pool, club.recBasis)
        const parsed = parseResult(await complete(prompt))
        await consume(ctx.serverId, ctx.userId, aiCfg.limit)
        // Resolve the model's chosen ids back to real candidates (it can only
        // return ids from the pool; drop any it invented).
        const byId = new Map(pool.map((c) => [c.libraryItemId, c]))
        const picks = parsed.picks
          .map((pk) => {
            const c = byId.get(pk.id)
            if (!c) return null
            return {
              libraryItemId: c.libraryItemId,
              title: c.title,
              author: c.author,
              genre: c.genre,
              reason: typeof pk.reason === 'string' ? pk.reason : '',
            }
          })
          .filter(Boolean)
        return (
          json(res, 200, { engine: 'ai', basis: club.recBasis, intro: parsed.intro, picks }),
          true
        )
      } catch {
        // fall through to the heuristic below
      }
    }

    const result = clubHeuristic(taste, pool, club.recBasis)
    return (
      json(res, 200, { engine: 'heuristic', basis: club.recBasis, intro: result.intro, picks: result.picks }),
      true
    )
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
