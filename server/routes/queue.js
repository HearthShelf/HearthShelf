// Per-user listening queue sync. Mounted at /hs/queue. The queue follows a
// user across devices, keyed by (server_id, user_id). Mode/auto-rules are NOT
// here - they're preferences and sync through /hs/settings.

import { json, readBody } from '../lib/http.js'
import { getQueue, setQueue } from '../queue.js'
import { resolveQueue } from '../lib/computeQueue.js'
import { getUserSetting } from '../settings.js'

export async function handleQueue(req, res, url, ctx) {
  if (url.pathname !== '/hs/queue') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  if (req.method === 'GET') {
    // The server owns the queue: in 'auto' mode this computes it from the user's
    // rules + ABS library/progress + club picks and persists it; other modes
    // return the stored (manual) queue. Clients just display the result. `manual`
    // is the durable hand-queued list, carried alongside so a client can edit it
    // even while Auto drives the active `items`.
    const { items, manual, playlistId, updatedAt } = await resolveQueue(ctx)
    return (json(res, 200, { items, manual, playlistId, updatedAt }), true)
  }
  if (req.method === 'PUT') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const { items, manual, playlistId, updatedAt } = body ?? {}
    if (!Array.isArray(items) || typeof updatedAt !== 'number') {
      return (json(res, 400, { error: 'invalid_queue' }), true)
    }
    // manual is optional: absent = preserve the stored list; present must be an
    // array (the hand-queued list the client is replacing).
    if (manual !== undefined && !Array.isArray(manual)) {
      return (json(res, 400, { error: 'invalid_queue' }), true)
    }
    // The server OWNS the active `items` list in every mode except Manual: Auto
    // and Playlist compute it on GET (resolveQueue), and Off has none. Only
    // Manual is a client-authored order. So in non-Manual modes we ignore the
    // client's `items` (a client should never be able to write the computed
    // list) and only accept the durable `manual` edit. Without this, a client
    // that keeps a large Auto `items` list in its store re-PUTs it and the
    // stored queue inflates across syncs - the exact drift where one device
    // shows a 30-item queue while another (which never writes) shows none.
    const mode = (await getUserSetting(ctx.serverId, ctx.userId, 'queueMode')) ?? 'off'
    const acceptItems = mode === 'manual'
    const saved = await setQueue(ctx.serverId, ctx.userId, {
      // In non-Manual modes preserve the stored items (the last server compute);
      // don't let the client's copy overwrite them.
      items: acceptItems ? items : undefined,
      manual,
      playlistId: playlistId ?? null,
      updatedAt,
    })
    // 200 either way: a rejected (stale) write still returns the current
    // server state so the caller can adopt it instead of erroring.
    return (
      json(res, 200, {
        items: saved.items,
        manual: saved.manual,
        playlistId: saved.playlistId,
        updatedAt: saved.updatedAt,
        applied: saved.applied,
      }),
      true
    )
  }
  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
