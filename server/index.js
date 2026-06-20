// HearthShelf QuestGiver backend — the app's only server beyond static nginx.
// Holds the AI provider key server-side, identifies the caller via their ABS
// token, enforces per-user rate limits, and forwards the prompt to the provider.
//
// Routes (nginx proxies /qg/* here):
//   GET  /qg/config              -> { enabled, provider, model, limit, ... }
//   POST /qg/recommend           -> QuestGiver pick | 429 | 503
//   GET/POST /qg/discover        -> monthly AI shelf (cached per user+month)
//   GET/POST /qg/discover/feedback -> like/dislike/not_interested/rating
//   GET  /qg/discover/popular    -> server-wide popular item ids (admin data)
//   /qg/rmab/*                   -> ReadMeABook acquisition proxy (search,
//                                   requests CRUD, cancel/retry, watch
//                                   authors/series, ignore, ebook companion)
//
// Env: QG_PROVIDER, QG_MODEL, QG_API_KEY, QG_BASE_URL, QG_LIMIT, QG_ENABLED,
//      DISCOVER_ENABLED, QG_DATA_DIR, RMAB_URL, RMAB_LOGIN_TOKEN,
//      ABS_SERVER_URL (to validate the caller's token).

import http from 'node:http'
import { complete, isProviderConfigured, providerInfo } from './providers.js'
import { check, consume } from './ratelimit.js'
import { isRmabConfigured, rmabFetch } from './rmab.js'
import * as store from './store.js'
import { craftDiscoverPrompt, heuristicShelf, filterByFeedback } from './discover.js'
import { initDb } from './db.js'
import { getConfig, setConfig, publicConfig } from './config.js'
import { getSettings, setSettings } from './settings.js'

const PORT = process.env.QG_PORT || 8080
const ABS_URL = process.env.ABS_SERVER_URL || ''
// Feature gate, independent of AI config: the admin can turn QuestGiver off
// entirely. When off, the SPA hides the route and nav. Default on (the
// heuristic recommender works even with no AI provider). "0"/"false"/"off" = off.
const FEATURE_ENABLED = !/^(0|false|off|no)$/i.test(process.env.QG_ENABLED ?? 'true')
// Discover (history-driven ambient shelves) - a separate pure-client feature,
// gated independently of QuestGiver. Default on. "0"/"false"/"off" = off.
const DISCOVER_ENABLED = !/^(0|false|off|no)$/i.test(process.env.DISCOVER_ENABLED ?? 'true')

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

async function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Validate the caller's ABS token by asking ABS who they are. Returns
// { id, type, token } or null if the token is missing/invalid.
async function authUserFull(req) {
  const header = req.headers['authorization'] || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !ABS_URL) return null
  try {
    const res = await fetch(`${ABS_URL}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const me = await res.json()
    if (!me?.id) return null
    return { id: me.id, type: me.type ?? 'user', token }
  } catch {
    return null
  }
}

// Returns just the caller's user id, or null. (Convenience over authUserFull.)
async function authUser(req) {
  try {
    const u = await authUserFull(req)
    return u?.id ?? null
  } catch {
    return null
  }
}

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
async function computePopular(caller) {
  if (caller.type !== 'admin' && caller.type !== 'root') return []
  const auth = { headers: { Authorization: `Bearer ${caller.token}` } }
  try {
    const usersRes = await fetch(`${ABS_URL}/api/users`, auth)
    if (!usersRes.ok) return []
    const users = (await usersRes.json())?.users ?? []
    const finished = new Map()
    const inProgress = new Map()
    // Cap the fan-out so a huge server can't stall the request indefinitely.
    for (const u of users.slice(0, 200)) {
      try {
        const detailRes = await fetch(`${ABS_URL}/api/users/${u.id}`, auth)
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

// Extract the first {...} block and validate the QuestGiver result shape.
function parseResult(text) {
  const m = text && text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('no json in model output')
  const o = JSON.parse(m[0])
  if (!o || !Array.isArray(o.picks)) throw new Error('bad result shape')
  return {
    intro: typeof o.intro === 'string' ? o.intro : '',
    picks: o.picks,
    newPicks: Array.isArray(o.newPicks) ? o.newPicks : [],
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/qg/config') {
    const userId = await authUser(req)
    const cfg = await getConfig()
    const info = await providerInfo()
    const rate = userId
      ? await check(userId, cfg.limit)
      : { limit: null, remaining: null, period: null }
    return json(res, 200, {
      featureEnabled: FEATURE_ENABLED && cfg.enabled,
      discoverEnabled: DISCOVER_ENABLED,
      enabled: info.configured,
      provider: info.provider,
      model: info.model,
      limit: rate.limit,
      remaining: rate.remaining,
      period: rate.period,
    })
  }

  // --- Admin: read / edit the AI config (provider, model, key, limit) ---
  if (url.pathname === '/qg/admin/config') {
    const caller = await authUserFull(req)
    if (!caller) return json(res, 401, { error: 'unauthorized' })
    if (caller.type !== 'admin' && caller.type !== 'root') {
      return json(res, 403, { error: 'forbidden' })
    }
    if (req.method === 'GET') {
      return json(res, 200, await publicConfig())
    }
    if (req.method === 'PUT') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: 'invalid_body' })
      }
      await setConfig(body ?? {})
      return json(res, 200, await publicConfig())
    }
    return json(res, 405, { error: 'method_not_allowed' })
  }

  if (req.method === 'POST' && url.pathname === '/qg/recommend') {
    const userId = await authUser(req)
    if (!userId) return json(res, 401, { error: 'unauthorized' })

    const cfg = await getConfig()
    if (!FEATURE_ENABLED || !cfg.enabled) {
      return json(res, 403, { error: 'feature_disabled' })
    }

    if (!(await isProviderConfigured())) {
      // No AI configured — the client runs its heuristic fallback.
      return json(res, 503, { error: 'ai_unavailable' })
    }

    const rate = await check(userId, cfg.limit)
    if (!rate.allowed) {
      return json(res, 429, {
        error: 'rate_limited',
        limit: rate.limit,
        remaining: 0,
        period: rate.period,
      })
    }

    let prompt
    try {
      const body = JSON.parse(await readBody(req))
      prompt = body?.prompt
    } catch {
      return json(res, 400, { error: 'invalid_body' })
    }
    if (typeof prompt !== 'string' || prompt.length < 10) {
      return json(res, 400, { error: 'invalid_prompt' })
    }

    try {
      const text = await complete(prompt)
      const result = parseResult(text)
      const after = await consume(userId, cfg.limit)
      return json(res, 200, {
        ...result,
        engine: 'ai',
        remaining: after.remaining,
        limit: after.limit,
      })
    } catch (err) {
      // Provider/parse failure — let the client fall back to the heuristic.
      return json(res, 502, { error: 'ai_error', detail: String(err).slice(0, 200) })
    }
  }

  if (req.method === 'GET' && url.pathname === '/qg/health') {
    return json(res, 200, { ok: true })
  }

  // --- QuestGiver run history (per user, synced across devices) ---
  if (url.pathname === '/qg/runs') {
    const userId = await authUser(req)
    if (!userId) return json(res, 401, { error: 'unauthorized' })
    if (req.method === 'GET') {
      return json(res, 200, { runs: await store.getRuns(userId) })
    }
    if (req.method === 'POST') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: 'invalid_body' })
      }
      if (!body?.run || typeof body.run !== 'object') {
        return json(res, 400, { error: 'invalid_run' })
      }
      return json(res, 200, { runs: await store.addRun(userId, body.run) })
    }
    return json(res, 405, { error: 'method_not_allowed' })
  }

  // --- Per-user app settings (sync across the user's devices) ---
  if (url.pathname === '/qg/settings') {
    const userId = await authUser(req)
    if (!userId) return json(res, 401, { error: 'unauthorized' })
    if (req.method === 'GET') {
      const { values, updatedAt } = await getSettings(userId)
      return json(res, 200, { values, updatedAt })
    }
    if (req.method === 'PUT') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: 'invalid_body' })
      }
      const values = body?.values
      if (values == null || typeof values !== 'object') {
        return json(res, 400, { error: 'invalid_values' })
      }
      const saved = await setSettings(userId, values)
      return json(res, 200, { values: saved.values, updatedAt: saved.updatedAt })
    }
    return json(res, 405, { error: 'method_not_allowed' })
  }

  // --- Discover backend (monthly AI shelf, feedback, popular signals) ---

  if (url.pathname.startsWith('/qg/discover')) {
    const caller = await authUserFull(req)
    if (!caller) return json(res, 401, { error: 'unauthorized' })
    if (!DISCOVER_ENABLED) return json(res, 403, { error: 'discover_disabled' })

    // Feedback: GET map, POST upsert.
    if (url.pathname === '/qg/discover/feedback') {
      if (req.method === 'GET') {
        return json(res, 200, { feedback: await store.getFeedback(caller.id) })
      }
      if (req.method === 'POST') {
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, 400, { error: 'invalid_body' })
        }
        const itemKey = body?.itemKey
        if (typeof itemKey !== 'string' || !itemKey) {
          return json(res, 400, { error: 'invalid_item' })
        }
        const fb = {}
        if ('vote' in body) {
          const v = body.vote
          if (v === null || ['like', 'dislike', 'not_interested'].includes(v)) fb.vote = v
          else return json(res, 400, { error: 'invalid_vote' })
        }
        if ('rating' in body) {
          const r = body.rating
          if (r === null || (Number.isInteger(r) && r >= 1 && r <= 5)) fb.rating = r
          else return json(res, 400, { error: 'invalid_rating' })
        }
        const next = await store.setFeedback(caller.id, itemKey, fb)
        return json(res, 200, { feedback: next })
      }
      return json(res, 404, { error: 'not_found' })
    }

    // Popular: server-wide aggregate signals, cached daily. Admin-only data.
    if (req.method === 'GET' && url.pathname === '/qg/discover/popular') {
      const date = dateKey()
      const cached = await store.getPopular(date)
      if (cached) return json(res, 200, { items: cached.items })
      const items = await computePopular(caller)
      await store.setPopular({ date, items })
      return json(res, 200, { items })
    }

    // Monthly AI shelf: GET (generate-once-per-month, then cached).
    if (req.method === 'GET' && url.pathname === '/qg/discover') {
      const month = monthKey()
      const cached = await store.getMonthly(caller.id, month)
      if (cached) return json(res, 200, cached)
      return json(res, 200, { month, engine: 'none', intro: '', picks: [] })
    }

    // The client posts its history summary + candidate pool to (re)generate.
    if (req.method === 'POST' && url.pathname === '/qg/discover') {
      const month = monthKey()
      const cached = await store.getMonthly(caller.id, month)
      if (cached) return json(res, 200, cached)

      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return json(res, 400, { error: 'invalid_body' })
      }
      const summary = body?.summary ?? {}
      const candidates = Array.isArray(body?.candidates) ? body.candidates : []
      if (!candidates.length) return json(res, 400, { error: 'no_candidates' })
      const feedback = await store.getFeedback(caller.id)
      const pool = filterByFeedback(candidates, feedback)

      let shelf
      if ((await isProviderConfigured()) && pool.length) {
        try {
          const text = await complete(craftDiscoverPrompt(summary, pool, feedback, month))
          const parsed = parseResult(text)
          shelf = { month, engine: 'ai', intro: parsed.intro, picks: parsed.picks }
        } catch {
          shelf = { month, engine: 'heuristic', ...heuristicShelf(summary, pool, feedback) }
        }
      } else if (pool.length) {
        shelf = { month, engine: 'heuristic', ...heuristicShelf(summary, pool, feedback) }
      } else {
        shelf = { month, engine: 'none', intro: '', picks: [] }
      }
      await store.setMonthly(caller.id, shelf)
      return json(res, 200, shelf)
    }

    return json(res, 404, { error: 'not_found' })
  }

  // --- ReadMeABook acquisition proxy (all require a valid ABS caller) ---

  if (url.pathname === '/qg/rmab/config') {
    const userId = await authUser(req)
    if (!userId) return json(res, 401, { error: 'unauthorized' })
    return json(res, 200, { configured: isRmabConfigured() })
  }

  if (url.pathname.startsWith('/qg/rmab/')) {
    const userId = await authUser(req)
    if (!userId) return json(res, 401, { error: 'unauthorized' })
    if (!isRmabConfigured()) return json(res, 503, { error: 'rmab_unavailable' })

    try {
      // Catalog search: GET /qg/rmab/search?q=...
      if (req.method === 'GET' && url.pathname === '/qg/rmab/search') {
        const q = url.searchParams.get('q') ?? url.searchParams.get('query') ?? ''
        const page = url.searchParams.get('page') ?? '1'
        const r = await rmabFetch(
          'GET',
          `/api/audiobooks/search?q=${encodeURIComponent(q)}&page=${encodeURIComponent(page)}`
        )
        return json(res, r.status, r.body ?? {})
      }

      // Submit a request: POST /qg/rmab/requests
      if (req.method === 'POST' && url.pathname === '/qg/rmab/requests') {
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          return json(res, 400, { error: 'invalid_body' })
        }
        const r = await rmabFetch('POST', '/api/requests', payload)
        return json(res, r.status, r.body ?? {})
      }

      // List requests: GET /qg/rmab/requests?status=&take=&cursor=
      if (req.method === 'GET' && url.pathname === '/qg/rmab/requests') {
        const qs = url.search ? url.search : ''
        const r = await rmabFetch('GET', `/api/requests${qs}`)
        return json(res, r.status, r.body ?? {})
      }

      // Single request status: GET /qg/rmab/requests/:id
      const m = url.pathname.match(/^\/qg\/rmab\/requests\/([^/]+)$/)
      if (req.method === 'GET' && m) {
        const r = await rmabFetch('GET', `/api/requests/${encodeURIComponent(m[1])}`)
        return json(res, r.status, r.body ?? {})
      }

      // Cancel / retry a request: PATCH /qg/rmab/requests/:id { action }
      if (req.method === 'PATCH' && m) {
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          return json(res, 400, { error: 'invalid_body' })
        }
        const action = payload?.action
        if (action !== 'cancel' && action !== 'retry') {
          return json(res, 400, { error: 'invalid_action' })
        }
        const r = await rmabFetch('PATCH', `/api/requests/${encodeURIComponent(m[1])}`, { action })
        return json(res, r.status, r.body ?? {})
      }

      // Ebook companion: POST /qg/rmab/requests/:id/ebook -> fetch-ebook on the
      // completed parent audiobook request (RMAB admin role + ebook sources req'd).
      const me = url.pathname.match(/^\/qg\/rmab\/requests\/([^/]+)\/ebook$/)
      if (req.method === 'POST' && me) {
        const r = await rmabFetch('POST', `/api/requests/${encodeURIComponent(me[1])}/fetch-ebook`)
        return json(res, r.status, r.body ?? {})
      }

      // Watch authors: GET/POST /qg/rmab/watched-authors, DELETE .../:id
      if (url.pathname === '/qg/rmab/watched-authors') {
        if (req.method === 'GET') {
          const r = await rmabFetch('GET', '/api/user/watched-authors')
          return json(res, r.status, r.body ?? {})
        }
        if (req.method === 'POST') {
          let payload
          try {
            payload = JSON.parse(await readBody(req))
          } catch {
            return json(res, 400, { error: 'invalid_body' })
          }
          const r = await rmabFetch('POST', '/api/user/watched-authors', payload)
          return json(res, r.status, r.body ?? {})
        }
      }
      const wa = url.pathname.match(/^\/qg\/rmab\/watched-authors\/([^/]+)$/)
      if (req.method === 'DELETE' && wa) {
        const r = await rmabFetch('DELETE', `/api/user/watched-authors/${encodeURIComponent(wa[1])}`)
        return json(res, r.status, r.body ?? {})
      }

      // Watch series: GET/POST /qg/rmab/watched-series, DELETE .../:id
      if (url.pathname === '/qg/rmab/watched-series') {
        if (req.method === 'GET') {
          const r = await rmabFetch('GET', '/api/user/watched-series')
          return json(res, r.status, r.body ?? {})
        }
        if (req.method === 'POST') {
          let payload
          try {
            payload = JSON.parse(await readBody(req))
          } catch {
            return json(res, 400, { error: 'invalid_body' })
          }
          const r = await rmabFetch('POST', '/api/user/watched-series', payload)
          return json(res, r.status, r.body ?? {})
        }
      }
      const ws = url.pathname.match(/^\/qg\/rmab\/watched-series\/([^/]+)$/)
      if (req.method === 'DELETE' && ws) {
        const r = await rmabFetch('DELETE', `/api/user/watched-series/${encodeURIComponent(ws[1])}`)
        return json(res, r.status, r.body ?? {})
      }

      // Ignore / un-ignore a catalog item: POST /qg/rmab/ignored, DELETE .../:id
      if (req.method === 'POST' && url.pathname === '/qg/rmab/ignored') {
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          return json(res, 400, { error: 'invalid_body' })
        }
        const r = await rmabFetch('POST', '/api/user/ignored-audiobooks', payload)
        return json(res, r.status, r.body ?? {})
      }
      const ig = url.pathname.match(/^\/qg\/rmab\/ignored\/([^/]+)$/)
      if (req.method === 'DELETE' && ig) {
        const r = await rmabFetch('DELETE', `/api/user/ignored-audiobooks/${encodeURIComponent(ig[1])}`)
        return json(res, r.status, r.body ?? {})
      }
    } catch (err) {
      return json(res, 502, { error: 'rmab_error', detail: String(err).slice(0, 200) })
    }

    return json(res, 404, { error: 'not_found' })
  }

  json(res, 404, { error: 'not_found' })
})

// Initialise the database (schema + legacy JSON migration) before accepting
// traffic, so the first request never races table creation.
initDb()
  .then(async () => {
    const configured = await isProviderConfigured()
    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`[questgiver] listening on :${PORT} (provider configured: ${configured})`)
    })
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[questgiver] failed to initialise database:', err)
    process.exit(1)
  })
