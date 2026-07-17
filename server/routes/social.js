// Social backend: cross-user surfaces ABS's API won't expose to non-admins.
// Mounted under /hs/social/*. Reads aggregate facts straight from ABS's SQLite
// (see lib/absdb.js) so any logged-in user - admin or not - gets the leaderboard
// without us holding an ABS admin token. Privacy is opt-out via the shared
// shareReadBooks app setting (see lib/settings getLeaderboardOptOuts).
//
// Every response carries `available`: false when ABS's database isn't mapped
// (e.g. a slim deploy that hasn't added the read-only volume), so the UI hides
// the feature instead of erroring.

import { json, readBody } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import {
  absDbAvailable,
  getLeaderboard,
  getWindowsAvailable,
  getFinishedCount,
  getFinishedCountsBulk,
  getFinishedUsers,
  getFinishedUsersBulk,
  getActiveListeners,
  getUserCompareStats,
  getServerAggregateStats,
} from '../lib/absdb.js'
import { getExplicitSharePrefs } from '../settings.js'
import { getCommunityConfig, setCommunityConfig } from '../community.js'
import { callerNow } from '../lib/stats.js'

const LEADERBOARD_LIMIT = 100
const WINDOWS = new Set(['week', 'month', 'all'])
// Presence recency: a session counts as "listening recently" if its playback
// session updated within this window. ~3 minutes (see docs/social.md).
const LISTENING_CUTOFF_MS = 3 * 60 * 1000
// Bulk listening-now caps the id list, mirroring readBody size discipline.
const MAX_BULK_IDS = 100

// Does this user appear on the leaderboard? Their explicit choice wins; absent a
// choice, the admin default applies. The caller always sees their own row.
function shares(userId, explicit, defaultShare, meId) {
  if (userId === meId) return true
  if (explicit.has(userId)) return explicit.get(userId)
  return defaultShare
}

// Group flat getActiveListeners rows ({ libraryItemId, userId, username }) into
// { [libraryItemId]: HSListeningNowUser[] }, filtering each user by the presence
// privacy resolution: an explicit shareCurrentlyListening choice wins, else the
// community default_share_listening (default OFF); the caller always sees self.
function filterListeners(rows, explicit, community, meId) {
  const byItem = {}
  for (const row of rows) {
    if (!shares(row.userId, explicit, community.defaultShareListening, meId)) continue
    if (!byItem[row.libraryItemId]) byItem[row.libraryItemId] = []
    byItem[row.libraryItemId].push({ userId: row.userId, username: row.username })
  }
  return byItem
}

export async function handleSocial(req, res, url, ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/social')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  // Community config: the instance-wide default for leaderboard sharing. GET is
  // open to any authenticated user (the user toggle needs to show the inherited
  // default); PUT is admin-only.
  if (p === '/hs/social/community-config') {
    if (req.method === 'GET') {
      // Includes defaultShareListening / notesEnabled / clubsEnabled so the
      // per-user toggles can show the inherited default and clients can gate.
      const cfg = await getCommunityConfig()
      return (json(res, 200, { ...cfg, canEdit: isAdmin(ctx) }), true)
    }
    if (req.method === 'PUT') {
      if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return (json(res, 400, { error: 'invalid_body' }), true)
      }
      const next = await setCommunityConfig(body ?? {})
      return (json(res, 200, { ...next, canEdit: true }), true)
    }
    return (json(res, 405, { error: 'method_not_allowed' }), true)
  }

  // Listening-now presence: who is actively (recently) listening to a book.
  // GET ?libraryItemId= for one item; POST { libraryItemIds } (capped 100) for
  // a shelf. Privacy: an explicit shareCurrentlyListening choice wins, else the
  // community default_share_listening (which ships OFF); the caller always sees
  // themselves. UI labels this "listening recently", not "online".
  if (p === '/hs/social/listening-now') {
    if (req.method === 'GET') {
      if (!(await absDbAvailable())) {
        return (json(res, 200, { available: false, users: [] }), true)
      }
      const id = url.searchParams.get('libraryItemId') || ''
      if (!id) return (json(res, 400, { error: 'missing_libraryItemId' }), true)
      const [rows, explicit, community] = await Promise.all([
        getActiveListeners([id], LISTENING_CUTOFF_MS),
        getExplicitSharePrefs(ctx.serverId, 'shareCurrentlyListening'),
        getCommunityConfig(),
      ])
      const users = filterListeners(rows, explicit, community, ctx.userId)
      return (json(res, 200, { available: true, users: users[id] || [] }), true)
    }
    if (req.method === 'POST') {
      if (!(await absDbAvailable())) {
        return (json(res, 200, { available: false, byItem: {} }), true)
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return (json(res, 400, { error: 'invalid_body' }), true)
      }
      const ids = Array.isArray(body?.libraryItemIds) ? body.libraryItemIds : null
      if (!ids) return (json(res, 400, { error: 'missing_libraryItemIds' }), true)
      if (ids.length > MAX_BULK_IDS) return (json(res, 400, { error: 'too_many_ids' }), true)
      const [rows, explicit, community] = await Promise.all([
        getActiveListeners(ids, LISTENING_CUTOFF_MS),
        getExplicitSharePrefs(ctx.serverId, 'shareCurrentlyListening'),
        getCommunityConfig(),
      ])
      const byItem = filterListeners(rows, explicit, community, ctx.userId)
      return (json(res, 200, { available: true, byItem }), true)
    }
    return (json(res, 405, { error: 'method_not_allowed' }), true)
  }

  // Compare: the caller's own totals alongside a comparison target - the whole
  // server aggregate (?scope=server, no identity leaked) or one opted-in user
  // (?userId=). The user variant reuses the leaderboard privacy roster: the
  // target must appear in the caller's privacy-filtered leaderboard (so only
  // shareable users are ever comparable), otherwise 403. See HSCompareResponse.
  if (req.method === 'GET' && p === '/hs/social/compare') {
    if (!(await absDbAvailable())) {
      return (json(res, 200, { available: false, scope: 'server', me: null, target: null }), true)
    }
    // Caller-local year start for the booksThisYear comparison field (tz in
    // minutes, like /hs/stats; falls back to the server clock without it).
    const tz = Number.parseInt(url.searchParams.get('tz') ?? '', 10)
    const now = callerNow(Number.isNaN(tz) ? undefined : tz)
    const yearStart = `${now.getUTCFullYear()}-01-01`

    const me = await getUserCompareStats(ctx.userId, yearStart)
    if (!me) return (json(res, 200, { available: false, scope: 'server', me: null, target: null }), true)

    const targetUserId = url.searchParams.get('userId') || ''
    if (targetUserId) {
      // Gate on the same privacy roster the leaderboard uses: build the visible
      // set (explicit choice wins, else the admin default) and require the target
      // to be in it. The caller comparing against themselves is always allowed.
      const [rows, explicit, community] = await Promise.all([
        getLeaderboard({ window: 'all' }),
        getExplicitSharePrefs(ctx.serverId),
        getCommunityConfig(),
      ])
      const shareable = new Set(
        rows
          .filter((r) => shares(r.userId, explicit, community.defaultShare, ctx.userId))
          .map((r) => r.userId),
      )
      if (targetUserId !== ctx.userId && !shareable.has(targetUserId)) {
        return (json(res, 403, { error: 'not_shareable' }), true)
      }
      const target = await getUserCompareStats(targetUserId, yearStart)
      if (!target) return (json(res, 404, { error: 'user_not_found' }), true)
      const username = rows.find((r) => r.userId === targetUserId)?.username || ''
      return (
        json(res, 200, {
          available: true,
          scope: 'user',
          me,
          target,
          userId: targetUserId,
          username,
        }),
        true
      )
    }

    // Default: compare against the server-wide per-user average.
    const target = await getServerAggregateStats(yearStart)
    if (!target) return (json(res, 200, { available: false, scope: 'server', me: null, target: null }), true)
    return (json(res, 200, { available: true, scope: 'server', me, target }), true)
  }

  if (req.method === 'GET' && p === '/hs/social/leaderboard') {
    if (!(await absDbAvailable())) {
      return (json(res, 200, { available: false, me: null, entries: [] }), true)
    }
    // Accept ?window=week|month|all; anything else falls back to 'all'.
    const requested = url.searchParams.get('window') || 'all'
    const window = WINDOWS.has(requested) ? requested : 'all'
    const [rows, explicit, community] = await Promise.all([
      getLeaderboard({ window }),
      getExplicitSharePrefs(ctx.serverId),
      getCommunityConfig(),
    ])
    // If the date-format probe failed, only all-time is trustworthy. Echo the
    // window we actually served (the DB serves all-time when windowing is off).
    const windowsAvailable = getWindowsAvailable()
    const servedWindow = windowsAvailable ? window : 'all'
    // Privacy-filter BEFORE truncating: keep users who share (explicit choice,
    // else the admin default). getLeaderboard returns the full ranked set, so
    // opted-out users don't consume top-N slots. Ranks are assigned over this
    // filtered ordering (rows already sorted by books then hours). The caller
    // always sees their own row (even if hidden from others), flagged isMe.
    const ranked = rows
      .filter((r) => shares(r.userId, explicit, community.defaultShare, ctx.userId))
      .map((r, i) => ({
        rank: i + 1,
        userId: r.userId,
        username: r.username,
        booksFinished: r.booksFinished,
        secondsListened: r.secondsListened,
        isMe: r.userId === ctx.userId,
      }))
    // Truncate to the display page AFTER filtering.
    const entries = ranked.slice(0, LEADERBOARD_LIMIT)
    // The caller's row carries its true (pre-slice) rank. If it didn't survive
    // the cut, append it so the user always sees where they stand.
    const meRanked = ranked.find((e) => e.isMe) ?? null
    if (meRanked && !entries.some((e) => e.isMe)) entries.push(meRanked)
    const me = meRanked
    return (
      json(res, 200, {
        available: true,
        me,
        entries,
        window: servedWindow,
        windowsAvailable,
      }),
      true
    )
  }

  // Who finished a book (privacy-filtered). GET ?libraryItemId=... for the
  // detail-page avatar chips; POST { libraryItemIds } -> { byItem } for the
  // reader-avatar stacks on library/browse cards (capped 100).
  if (p === '/hs/social/finished-by') {
    if (req.method === 'GET') {
      if (!(await absDbAvailable())) {
        return (json(res, 200, { available: false, users: [] }), true)
      }
      const id = url.searchParams.get('libraryItemId') || ''
      if (!id) return (json(res, 400, { error: 'missing_libraryItemId' }), true)
      const [users, explicit, community] = await Promise.all([
        getFinishedUsers(id),
        getExplicitSharePrefs(ctx.serverId),
        getCommunityConfig(),
      ])
      // Same privacy pipeline as the leaderboard: explicit choice wins, else the
      // admin default; the caller always sees themselves.
      const visible = users.filter((u) =>
        shares(u.userId, explicit, community.defaultShare, ctx.userId),
      )
      return (json(res, 200, { available: true, users: visible }), true)
    }
    if (req.method === 'POST') {
      if (!(await absDbAvailable())) {
        return (json(res, 200, { available: false, byItem: {} }), true)
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return (json(res, 400, { error: 'invalid_body' }), true)
      }
      const ids = Array.isArray(body?.libraryItemIds) ? body.libraryItemIds : null
      if (!ids) return (json(res, 400, { error: 'missing_libraryItemIds' }), true)
      if (ids.length > MAX_BULK_IDS) return (json(res, 400, { error: 'too_many_ids' }), true)
      const [grouped, explicitRead, explicitListening, community] = await Promise.all([
        getFinishedUsersBulk(ids),
        getExplicitSharePrefs(ctx.serverId, 'shareReadBooks'),
        getExplicitSharePrefs(ctx.serverId, 'shareCurrentlyListening'),
        getCommunityConfig(),
      ])
      // Two privacy surfaces in one list: finishers are gated by shareReadBooks
      // (community defaultShare), in-progress readers by shareCurrentlyListening
      // (community defaultShareListening, default OFF). The caller always sees
      // themselves either way. Drop items left with no visible readers.
      const byItem = {}
      for (const [id, users] of Object.entries(grouped)) {
        const visible = users.filter((u) =>
          u.status === 'reading'
            ? shares(u.userId, explicitListening, community.defaultShareListening, ctx.userId)
            : shares(u.userId, explicitRead, community.defaultShare, ctx.userId),
        )
        if (visible.length) byItem[id] = visible
      }
      return (json(res, 200, { available: true, byItem }), true)
    }
    return (json(res, 405, { error: 'method_not_allowed' }), true)
  }

  // Single item: how many people finished it. /hs/social/finished-count?libraryItemId=...
  if (req.method === 'GET' && p === '/hs/social/finished-count') {
    if (!(await absDbAvailable())) {
      return (json(res, 200, { available: false, count: 0 }), true)
    }
    const id = url.searchParams.get('libraryItemId') || ''
    if (!id) return (json(res, 400, { error: 'missing_libraryItemId' }), true)
    const count = await getFinishedCount(id)
    return (json(res, 200, { available: true, count }), true)
  }

  // Bulk: counts for a shelf of items. POST { libraryItemIds: [...] } -> { counts }.
  if (req.method === 'POST' && p === '/hs/social/finished-count') {
    if (!(await absDbAvailable())) {
      return (json(res, 200, { available: false, counts: {} }), true)
    }
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const ids = Array.isArray(body?.libraryItemIds) ? body.libraryItemIds : null
    if (!ids) return (json(res, 400, { error: 'missing_libraryItemIds' }), true)
    if (ids.length > MAX_BULK_IDS) return (json(res, 400, { error: 'too_many_ids' }), true)
    const counts = await getFinishedCountsBulk(ids)
    return (json(res, 200, { available: true, counts }), true)
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
