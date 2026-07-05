// Per-user release subscriptions + Expo push-token registration.
//   GET    /hs/subscriptions            -> { subscriptions: [...] }
//   POST   /hs/subscriptions            -> create/upsert a follow, returns it
//   DELETE /hs/subscriptions/{id}       -> unfollow
//   POST   /hs/push/register            -> store this device's Expo push token
// Subscriptions carry their full display payload so clients + the Home banner
// render without refetching Audible. The nightly series-roster job resolves them
// against ABS and sends the pushes. See lib/subscriptionsStore.js.

import { json, readBody } from '../lib/http.js'
import {
  listSubscriptions,
  saveSubscription,
  deleteSubscription,
  savePushToken,
} from '../lib/subscriptionsStore.js'

function newId() {
  // Cheap unique id; the client usually supplies its own, this is the fallback.
  return `sub_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

export async function handleSubscriptions(req, res, url, ctx) {
  const p = url.pathname
  const isSubs = p === '/hs/subscriptions' || p.startsWith('/hs/subscriptions/')
  const isPush = p === '/hs/push/register'
  if (!isSubs && !isPush) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  const { serverId, userId } = ctx

  // --- Push token registration ---
  if (isPush) {
    if (req.method !== 'POST') return (json(res, 405, { error: 'method_not_allowed' }), true)
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const token = typeof body?.token === 'string' ? body.token.trim() : ''
    if (!token) return (json(res, 400, { error: 'invalid_token' }), true)
    const platform = body?.platform === 'ios' || body?.platform === 'android' ? body.platform : null
    await savePushToken(serverId, userId, token, platform)
    return (json(res, 200, { ok: true }), true)
  }

  // --- List ---
  if (p === '/hs/subscriptions' && req.method === 'GET') {
    const subscriptions = await listSubscriptions(serverId, userId)
    // Drop the internal `notified` field from the client-facing payload.
    return (
      json(res, 200, { subscriptions: subscriptions.map(({ notified, ...s }) => s) }),
      true
    )
  }

  // --- Create / upsert ---
  if (p === '/hs/subscriptions' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const kind = body?.kind === 'series' ? 'series' : body?.kind === 'book' ? 'book' : null
    if (!kind) return (json(res, 400, { error: 'invalid_kind' }), true)
    if (!body?.title || typeof body.title !== 'string') {
      return (json(res, 400, { error: 'title_required' }), true)
    }
    // A book sub needs an asin; a series sub needs a seriesAsin.
    if (kind === 'book' && !body.asin) return (json(res, 400, { error: 'asin_required' }), true)
    if (kind === 'series' && !body.seriesAsin) {
      return (json(res, 400, { error: 'series_asin_required' }), true)
    }

    const sub = {
      id: typeof body.id === 'string' && body.id ? body.id : newId(),
      kind,
      asin: body.asin ?? null,
      seriesAsin: body.seriesAsin ?? null,
      title: body.title,
      author: body.author ?? null,
      seriesTitle: body.seriesTitle ?? null,
      sequence: body.sequence ?? null,
      coverArtUrl: body.coverArtUrl ?? null,
      narrator: body.narrator ?? null,
      durationMinutes: Number.isFinite(body.durationMinutes) ? body.durationMinutes : null,
      releaseDate: body.releaseDate ?? null,
      publicationDatetime: body.publicationDatetime ?? null,
      createdAt: Date.now(),
    }
    await saveSubscription(serverId, userId, sub)
    return (
      json(res, 200, {
        subscription: {
          ...sub,
          asin: sub.asin ?? undefined,
          seriesAsin: sub.seriesAsin ?? undefined,
          available: false,
          availableAt: null,
        },
      }),
      true
    )
  }

  // --- Delete ---
  if (p.startsWith('/hs/subscriptions/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/hs/subscriptions/'.length))
    if (!id) return (json(res, 400, { error: 'id_required' }), true)
    await deleteSubscription(serverId, userId, id)
    return (json(res, 200, { ok: true }), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
