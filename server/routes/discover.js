// Discover backend: monthly AI shelf, per-user feedback, server-wide popular
// signals. Mounted under /hs/discover/*. Requires a valid ABS caller.

import { json, readBody } from '../lib/http.js'
import { isProviderConfigured, complete } from '../providers.js'
import { craftDiscoverPrompt, heuristicShelf, filterByFeedback } from '../discover.js'
import { parseResult } from './questgiver.js'
import { getConfig } from '../config.js'
import * as store from '../store.js'
import { getRatings } from '../lib/ratingsStore.js'

// UTC period keys for the monthly shelf + daily popular cache. Stable across a
// restart (purely date-derived), so the cache survives process bounces.
function monthKey() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
function dateKey() {
  return new Date().toISOString().slice(0, 10)
}

// Aggregate "popular on this server" from all users' mediaProgress. ABS gates
// /api/users + /api/users/:id to admins (403 otherwise), so a non-admin caller
// silently yields []. Heavy (N+1), but called at most once/day (daily cache).
async function computePopular(ctx) {
  if (ctx.role !== 'admin' && ctx.role !== 'root') return []
  const auth = { headers: { Authorization: `Bearer ${ctx.absToken}` } }
  try {
    const usersRes = await fetch(`${ctx.absUrl}/api/users`, auth)
    if (!usersRes.ok) return []
    const users = (await usersRes.json())?.users ?? []
    const finished = new Map()
    const inProgress = new Map()
    // Cap the fan-out so a huge server can't stall the request indefinitely.
    for (const u of users.slice(0, 200)) {
      try {
        const detailRes = await fetch(`${ctx.absUrl}/api/users/${u.id}`, auth)
        if (!detailRes.ok) continue
        const detail = await detailRes.json()
        for (const mp of detail?.mediaProgress ?? []) {
          const id = mp.libraryItemId
          if (!id) continue
          if (mp.isFinished) finished.set(id, (finished.get(id) ?? 0) + 1)
          else if ((mp.progress ?? 0) > 0) inProgress.set(id, (inProgress.get(id) ?? 0) + 1)
        }
      } catch {
        // skip a user we can't read; keep aggregating the rest
      }
    }
    const ids = new Set([...finished.keys(), ...inProgress.keys()])
    return [...ids]
      .map((itemId) => ({
        itemId,
        finishedBy: finished.get(itemId) ?? 0,
        inProgressBy: inProgress.get(itemId) ?? 0,
      }))
      .sort((a, b) => b.finishedBy - a.finishedBy || b.inProgressBy - a.inProgressBy)
      .slice(0, 30)
  } catch {
    return []
  }
}

export async function handleDiscover(req, res, url, ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/discover')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!(await getConfig()).discoverEnabled) {
    return (json(res, 403, { error: 'discover_disabled' }), true)
  }

  const sid = ctx.serverId
  const uid = ctx.userId

  // Feedback: GET map, POST upsert.
  if (p === '/hs/discover/feedback') {
    if (req.method === 'GET') {
      return (json(res, 200, { feedback: await store.getFeedback(sid, uid) }), true)
    }
    if (req.method === 'POST') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return (json(res, 400, { error: 'invalid_body' }), true)
      }
      const itemKey = body?.itemKey
      if (typeof itemKey !== 'string' || !itemKey) {
        return (json(res, 400, { error: 'invalid_item' }), true)
      }
      const fb = {}
      if ('vote' in body) {
        const v = body.vote
        if (v === null || ['like', 'dislike', 'not_interested'].includes(v)) fb.vote = v
        else return (json(res, 400, { error: 'invalid_vote' }), true)
      }
      const next = await store.setFeedback(sid, uid, itemKey, fb)
      return (json(res, 200, { feedback: next }), true)
    }
    return (json(res, 404, { error: 'not_found' }), true)
  }

  // Popular: server-wide aggregate signals, cached daily. Admin-only data.
  if (req.method === 'GET' && p === '/hs/discover/popular') {
    const date = dateKey()
    const cached = await store.getPopular(sid, date)
    if (cached) return (json(res, 200, { items: cached.items }), true)
    const items = await computePopular(ctx)
    await store.setPopular(sid, { date, items })
    return (json(res, 200, { items }), true)
  }

  // Monthly AI shelf: GET (generate-once-per-month, then cached).
  if (req.method === 'GET' && p === '/hs/discover') {
    const month = monthKey()
    const cached = await store.getMonthly(sid, uid, month)
    if (cached) return (json(res, 200, cached), true)
    return (json(res, 200, { month, engine: 'none', intro: '', picks: [] }), true)
  }

  // The client posts its history summary + candidate pool to (re)generate.
  if (req.method === 'POST' && p === '/hs/discover') {
    const month = monthKey()
    const cached = await store.getMonthly(sid, uid, month)
    if (cached) return (json(res, 200, cached), true)

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const summary = body?.summary ?? {}
    const candidates = Array.isArray(body?.candidates) ? body.candidates : []
    if (!candidates.length) return (json(res, 400, { error: 'no_candidates' }), true)
    const feedback = await store.getFeedback(sid, uid)
    const ratings = await getRatings(sid, uid)
    const pool = filterByFeedback(candidates, feedback)

    let shelf
    if ((await isProviderConfigured()) && pool.length) {
      try {
        const text = await complete(craftDiscoverPrompt(summary, pool, feedback, ratings, month))
        const parsed = parseResult(text)
        shelf = { month, engine: 'ai', intro: parsed.intro, picks: parsed.picks }
      } catch {
        shelf = { month, engine: 'heuristic', ...heuristicShelf(summary, pool, feedback, ratings) }
      }
    } else if (pool.length) {
      shelf = { month, engine: 'heuristic', ...heuristicShelf(summary, pool, feedback, ratings) }
    } else {
      shelf = { month, engine: 'none', intro: '', picks: [] }
    }
    await store.setMonthly(sid, uid, shelf)
    return (json(res, 200, shelf), true)
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
