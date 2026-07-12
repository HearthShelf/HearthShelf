// Per-user Auto-source dismissals. Mounted at /hs/dismissals. Lets a client hide
// a series/book from the Auto up-next queue and the Continue-* home shelves (and
// restore it later), keyed by (server_id, user_id) so it follows the user.
//
//   GET    /hs/dismissals            -> { seriesIds, itemIds }   (Dismissals)
//   POST   /hs/dismissals  { kind, entityId }  -> dismiss (hide)
//   DELETE /hs/dismissals  { kind, entityId }  -> restore (un-hide)
//
// kind is 'series' | 'item'. Writes never touch ABS progress - dismissal is a
// HearthShelf-only "not right now". After a write the queue recomputes on the
// next GET /hs/queue, so the client just re-pulls to see the change.

import { json, readBody } from '../lib/http.js'
import { getDismissals, addDismissal, removeDismissal } from '../dismissals.js'

export async function handleDismissals(req, res, url, ctx) {
  if (url.pathname !== '/hs/dismissals') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  if (req.method === 'GET') {
    const d = await getDismissals(ctx.serverId, ctx.userId)
    return (json(res, 200, d), true)
  }

  if (req.method === 'POST' || req.method === 'DELETE') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const kind = body?.kind
    const entityId = body?.entityId
    if ((kind !== 'series' && kind !== 'item') || typeof entityId !== 'string' || !entityId) {
      return (json(res, 400, { error: 'invalid_dismissal' }), true)
    }
    const ok =
      req.method === 'POST'
        ? await addDismissal(ctx.serverId, ctx.userId, kind, entityId, Date.now())
        : await removeDismissal(ctx.serverId, ctx.userId, kind, entityId)
    if (!ok) return (json(res, 400, { error: 'invalid_dismissal' }), true)
    // Return the fresh list so the client can adopt it without a second GET.
    const d = await getDismissals(ctx.serverId, ctx.userId)
    return (json(res, 200, d), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
