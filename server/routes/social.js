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
} from '../lib/absdb.js'
import { getExplicitSharePrefs } from '../settings.js'
import { getCommunityConfig, setCommunityConfig } from '../community.js'

const LEADERBOARD_LIMIT = 100
const WINDOWS = new Set(['week', 'month', 'all'])

// Does this user appear on the leaderboard? Their explicit choice wins; absent a
// choice, the admin default applies. The caller always sees their own row.
function shares(userId, explicit, defaultShare, meId) {
  if (userId === meId) return true
  if (explicit.has(userId)) return explicit.get(userId)
  return defaultShare
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

  if (req.method === 'GET' && p === '/hs/social/leaderboard') {
    if (!(await absDbAvailable())) {
      return (json(res, 200, { available: false, me: null, entries: [] }), true)
    }
    // Accept ?window=week|month|all; anything else falls back to 'all'.
    const requested = url.searchParams.get('window') || 'all'
    const window = WINDOWS.has(requested) ? requested : 'all'
    const [rows, explicit, community] = await Promise.all([
      getLeaderboard({ limit: LEADERBOARD_LIMIT, window }),
      getExplicitSharePrefs(ctx.serverId),
      getCommunityConfig(),
    ])
    // If the date-format probe failed, only all-time is trustworthy. Echo the
    // window we actually served (the DB serves all-time when windowing is off).
    const windowsAvailable = getWindowsAvailable()
    const servedWindow = windowsAvailable ? window : 'all'
    // Keep users who share (explicit choice, else the admin default). The caller
    // always sees their own row (even if hidden from others), flagged isMe so
    // the UI can highlight it.
    const visible = rows.filter((r) =>
      shares(r.userId, explicit, community.defaultShare, ctx.userId),
    )
    const entries = visible.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      username: r.username,
      booksFinished: r.booksFinished,
      secondsListened: r.secondsListened,
      isMe: r.userId === ctx.userId,
    }))
    const me = entries.find((e) => e.isMe) ?? null
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

  // Who finished a book (privacy-filtered), for the detail-page avatar chips.
  // /hs/social/finished-by?libraryItemId=...
  if (req.method === 'GET' && p === '/hs/social/finished-by') {
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
    const counts = await getFinishedCountsBulk(ids)
    return (json(res, 200, { available: true, counts }), true)
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
