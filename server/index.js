// HearthShelf QuestGiver backend — the app's only server beyond static nginx.
// Holds the AI provider key server-side, identifies the caller via their ABS
// token, enforces per-user rate limits, and forwards the prompt to the provider.
//
// Routes (nginx proxies /qg/* here):
//   GET  /qg/config     -> { enabled, provider, model, limit }
//   POST /qg/recommend  -> { intro, picks, newPicks, engine } | 429 | 503
//
// Env: QG_PROVIDER, QG_MODEL, QG_API_KEY, QG_BASE_URL, QG_LIMIT,
//      ABS_SERVER_URL (to validate the caller's token).

import http from 'node:http'
import { complete, isProviderConfigured, providerInfo } from './providers.js'
import { check, consume } from './ratelimit.js'
import { isRmabConfigured, rmabFetch } from './rmab.js'

const PORT = process.env.QG_PORT || 8080
const ABS_URL = process.env.ABS_SERVER_URL || ''
// Feature gate, independent of AI config: the admin can turn QuestGiver off
// entirely. When off, the SPA hides the route and nav. Default on (the
// heuristic recommender works even with no AI provider). "0"/"false"/"off" = off.
const FEATURE_ENABLED = !/^(0|false|off|no)$/i.test(process.env.QG_ENABLED ?? 'true')

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

// Validate the caller's ABS token by asking ABS who they are. Returns the user
// id, or null if the token is missing/invalid.
async function authUser(req) {
  const header = req.headers['authorization'] || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !ABS_URL) return null
  try {
    const res = await fetch(`${ABS_URL}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const me = await res.json()
    return me?.id ?? null
  } catch {
    return null
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
    const info = providerInfo()
    const rate = userId ? check(userId) : { limit: null, remaining: null, period: null }
    return json(res, 200, {
      featureEnabled: FEATURE_ENABLED,
      enabled: info.configured,
      provider: info.provider,
      model: info.model,
      limit: rate.limit,
      remaining: rate.remaining,
      period: rate.period,
    })
  }

  if (req.method === 'POST' && url.pathname === '/qg/recommend') {
    const userId = await authUser(req)
    if (!userId) return json(res, 401, { error: 'unauthorized' })

    if (!FEATURE_ENABLED) return json(res, 403, { error: 'feature_disabled' })

    if (!isProviderConfigured()) {
      // No AI configured — the client runs its heuristic fallback.
      return json(res, 503, { error: 'ai_unavailable' })
    }

    const rate = check(userId)
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
      const after = consume(userId)
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
    } catch (err) {
      return json(res, 502, { error: 'rmab_error', detail: String(err).slice(0, 200) })
    }

    return json(res, 404, { error: 'not_found' })
  }

  json(res, 404, { error: 'not_found' })
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[questgiver] listening on :${PORT} (provider configured: ${isProviderConfigured()})`)
})
