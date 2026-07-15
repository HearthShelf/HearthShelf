// ReadMeABook acquisition proxy. Mounted under /hs/rmab/*. All paths require a
// valid ABS caller; the RMAB session (login-token -> JWT) is held server-side in
// ../rmab.js. Forwards search, request CRUD, cancel/retry, ebook companion,
// watch authors/series, and ignore.

import { json, readBody } from '../lib/http.js'
import { isRmabConfigured, rmabFetch } from '../rmab.js'
import { appLog } from '../lib/appLog.js'

export async function handleRmab(req, res, url, ctx) {
  const p = url.pathname

  if (p === '/hs/rmab/config') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    return (json(res, 200, { configured: await isRmabConfigured() }), true)
  }

  if (!p.startsWith('/hs/rmab/')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!(await isRmabConfigured())) return (json(res, 503, { error: 'rmab_unavailable' }), true)

  try {
    // Catalog search: GET /hs/rmab/search?q=...
    if (req.method === 'GET' && p === '/hs/rmab/search') {
      const q = url.searchParams.get('q') ?? url.searchParams.get('query') ?? ''
      const page = url.searchParams.get('page') ?? '1'
      const r = await rmabFetch(
        'GET',
        `/api/audiobooks/search?q=${encodeURIComponent(q)}&page=${encodeURIComponent(page)}`,
      )
      return (json(res, r.status, r.body ?? {}), true)
    }

    // Submit a request: POST /hs/rmab/requests
    if (req.method === 'POST' && p === '/hs/rmab/requests') {
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        return (json(res, 400, { error: 'invalid_body' }), true)
      }
      const r = await rmabFetch('POST', '/api/requests', payload)
      const asin = payload?.audiobook?.asin || 'unknown'
      if (r.status >= 200 && r.status < 300 && r.body?.success !== false) {
        appLog.info('readmeabook', `Request submitted (asin=${asin}, status=${r.status})`)
      } else {
        const reason = r.body?.error || r.body?.message || `HTTP ${r.status}`
        appLog.warn('readmeabook', `Request rejected (asin=${asin}, status=${r.status}): ${reason}`)
      }
      return (json(res, r.status, r.body ?? {}), true)
    }

    // List requests: GET /hs/rmab/requests?status=&take=&cursor=
    if (req.method === 'GET' && p === '/hs/rmab/requests') {
      const qs = url.search ? url.search : ''
      const r = await rmabFetch('GET', `/api/requests${qs}`)
      return (json(res, r.status, r.body ?? {}), true)
    }

    // Single request status: GET /hs/rmab/requests/:id
    const m = p.match(/^\/hs\/rmab\/requests\/([^/]+)$/)
    if (req.method === 'GET' && m) {
      const r = await rmabFetch('GET', `/api/requests/${encodeURIComponent(m[1])}`)
      return (json(res, r.status, r.body ?? {}), true)
    }

    // Cancel / retry a request: PATCH /hs/rmab/requests/:id { action }
    if (req.method === 'PATCH' && m) {
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        return (json(res, 400, { error: 'invalid_body' }), true)
      }
      const action = payload?.action
      if (action !== 'cancel' && action !== 'retry') {
        return (json(res, 400, { error: 'invalid_action' }), true)
      }
      const r = await rmabFetch('PATCH', `/api/requests/${encodeURIComponent(m[1])}`, { action })
      return (json(res, r.status, r.body ?? {}), true)
    }

    // Ebook companion: POST /hs/rmab/requests/:id/ebook -> fetch-ebook on the
    // completed parent audiobook request (RMAB admin role + ebook sources req'd).
    const me = p.match(/^\/hs\/rmab\/requests\/([^/]+)\/ebook$/)
    if (req.method === 'POST' && me) {
      const r = await rmabFetch('POST', `/api/requests/${encodeURIComponent(me[1])}/fetch-ebook`)
      return (json(res, r.status, r.body ?? {}), true)
    }

    // Watch authors: GET/POST /hs/rmab/watched-authors, DELETE .../:id
    if (p === '/hs/rmab/watched-authors') {
      if (req.method === 'GET') {
        const r = await rmabFetch('GET', '/api/user/watched-authors')
        return (json(res, r.status, r.body ?? {}), true)
      }
      if (req.method === 'POST') {
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          return (json(res, 400, { error: 'invalid_body' }), true)
        }
        const r = await rmabFetch('POST', '/api/user/watched-authors', payload)
        return (json(res, r.status, r.body ?? {}), true)
      }
    }
    const wa = p.match(/^\/hs\/rmab\/watched-authors\/([^/]+)$/)
    if (req.method === 'DELETE' && wa) {
      const r = await rmabFetch('DELETE', `/api/user/watched-authors/${encodeURIComponent(wa[1])}`)
      return (json(res, r.status, r.body ?? {}), true)
    }

    // Watch series: GET/POST /hs/rmab/watched-series, DELETE .../:id
    if (p === '/hs/rmab/watched-series') {
      if (req.method === 'GET') {
        const r = await rmabFetch('GET', '/api/user/watched-series')
        return (json(res, r.status, r.body ?? {}), true)
      }
      if (req.method === 'POST') {
        let payload
        try {
          payload = JSON.parse(await readBody(req))
        } catch {
          return (json(res, 400, { error: 'invalid_body' }), true)
        }
        const r = await rmabFetch('POST', '/api/user/watched-series', payload)
        return (json(res, r.status, r.body ?? {}), true)
      }
    }
    const ws = p.match(/^\/hs\/rmab\/watched-series\/([^/]+)$/)
    if (req.method === 'DELETE' && ws) {
      const r = await rmabFetch('DELETE', `/api/user/watched-series/${encodeURIComponent(ws[1])}`)
      return (json(res, r.status, r.body ?? {}), true)
    }

    // Ignore / un-ignore a catalog item: POST /hs/rmab/ignored, DELETE .../:id
    if (req.method === 'POST' && p === '/hs/rmab/ignored') {
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        return (json(res, 400, { error: 'invalid_body' }), true)
      }
      const r = await rmabFetch('POST', '/api/user/ignored-audiobooks', payload)
      return (json(res, r.status, r.body ?? {}), true)
    }
    const ig = p.match(/^\/hs\/rmab\/ignored\/([^/]+)$/)
    if (req.method === 'DELETE' && ig) {
      const r = await rmabFetch(
        'DELETE',
        `/api/user/ignored-audiobooks/${encodeURIComponent(ig[1])}`,
      )
      return (json(res, r.status, r.body ?? {}), true)
    }
  } catch (err) {
    appLog.error('readmeabook', `Proxy request failed (${req.method} ${p}): ${String(err).slice(0, 300)}`)
    return (json(res, 502, { error: 'rmab_error', detail: String(err).slice(0, 200) }), true)
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
