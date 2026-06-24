// Hosted-mode setup + pairing. Mounted under /hs/hosted/*.
//
// This is how a self-hosted instance opts in to being reachable through
// app.hearthshelf.com. The admin (already signed in to ABS) does two things,
// usually from the HearthShelf setup UI:
//
//   1. Provide an ABS admin token + the control-plane issuer/JWKS so HS can
//      verify grants and mint per-user ABS keys (PUT /hs/hosted/config).
//   2. Start pairing (POST /hs/hosted/pair): HS calls the control plane's
//      /pairing/start with its own server_id + public URL, stores the returned
//      trust details (issuer, jwks_url, server secret), and returns the pairing
//      CODE for the admin to enter on app.hearthshelf.com.
//
// These endpoints authenticate the caller as an ABS admin directly (validate
// the presented bearer against ABS /api/me and require an admin/root type) -
// they must work during setup, before hosted mode itself is active, so they do
// NOT depend on resolveContext's mode.
//
// Env: ABS_SERVER_URL (to validate the admin), PUBLIC_URL (this instance's
// public origin, used as the URL the control plane and browsers reach),
// HS_CONTROL_PLANE_URL (default control-plane base, overridable per request).

import { json, readBody } from '../lib/http.js'
import { getServerId } from '../db.js'
import { getMode } from '../lib/context.js'
import { getHostedConfig, setHostedConfig } from '../lib/hosted.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '')
const DEFAULT_CP = (process.env.HS_CONTROL_PLANE_URL || 'https://app.hearthshelf.com').replace(/\/$/, '')

// Validate the presented bearer as an ABS admin. Returns the ABS token on
// success (so we can reuse it as the admin token), or null.
async function requireAbsAdmin(req) {
  const header = req.headers['authorization'] || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token || !ABS_URL) return null
  try {
    const res = await fetch(`${ABS_URL}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const me = await res.json()
    const role = me?.type
    if (role !== 'admin' && role !== 'root') return null
    return token
  } catch {
    return null
  }
}

export async function handleHosted(req, res, url, _ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/hosted/')) return false

  // Current hosted status - safe to read by any admin. Reports whether pairing
  // and config are in place, never leaking secrets.
  if (p === '/hs/hosted/config' && req.method === 'GET') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    const cfg = await getHostedConfig()
    return (
      json(res, 200, {
        mode: getMode(),
        paired: Boolean(cfg?.issuer && cfg?.jwksUrl),
        hasAbsAdminToken: Boolean(cfg?.absAdminToken),
        issuer: cfg?.issuer ?? null,
      }),
      true
    )
  }

  // Set the ABS admin token (and optionally issuer/jwks directly). The admin
  // token lets HS mint per-user ABS API keys for federated users.
  if (p === '/hs/hosted/config' && req.method === 'PUT') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    let body = {}
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    // Default the ABS admin token to the caller's own token unless one is given.
    const saved = await setHostedConfig({
      absAdminToken: typeof body.absAdminToken === 'string' && body.absAdminToken ? body.absAdminToken : adminToken,
      issuer: typeof body.issuer === 'string' ? body.issuer : undefined,
      jwksUrl: typeof body.jwksUrl === 'string' ? body.jwksUrl : undefined,
    })
    return (
      json(res, 200, { paired: Boolean(saved.issuer && saved.jwksUrl), hasAbsAdminToken: Boolean(saved.absAdminToken) }),
      true
    )
  }

  // Start pairing with the control plane. HS announces itself; the control
  // plane returns a code (for the admin to enter on app.hearthshelf.com) plus
  // the trust details we persist (issuer, jwks_url, server secret).
  if (p === '/hs/hosted/pair' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)

    let body = {}
    try {
      const raw = await readBody(req)
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }

    const controlPlane = (typeof body.controlPlaneUrl === 'string' && body.controlPlaneUrl
      ? body.controlPlaneUrl
      : DEFAULT_CP
    ).replace(/\/$/, '')
    const publicUrl = (typeof body.publicUrl === 'string' && body.publicUrl ? body.publicUrl : PUBLIC_URL).replace(/\/$/, '')
    if (!publicUrl) {
      return (json(res, 400, { error: 'public_url_required', detail: 'set PUBLIC_URL or pass publicUrl' }), true)
    }

    const serverId = await getServerId()
    const name = typeof body.name === 'string' ? body.name : undefined

    let startRes
    try {
      startRes = await fetch(`${controlPlane}/pairing/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: serverId, public_url: publicUrl, name }),
      })
    } catch (err) {
      return (json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }), true)
    }
    if (!startRes.ok) {
      const detail = await startRes.text().catch(() => '')
      return (json(res, 502, { error: 'pairing_start_failed', status: startRes.status, detail: detail.slice(0, 200) }), true)
    }
    const data = await startRes.json()

    // Persist the trust details. The ABS admin token defaults to the caller's
    // token so a single setup call leaves HS ready to federate users.
    await setHostedConfig({
      issuer: data.issuer,
      jwksUrl: data.jwks_url,
      serverSecret: data.server_secret,
      absAdminToken: adminToken,
    })

    // Return the code (and expiry) for the admin to redeem on app.hs.com.
    return (
      json(res, 200, {
        code: data.code,
        expires_at: data.expires_at,
        control_plane: controlPlane,
        issuer: data.issuer,
      }),
      true
    )
  }

  // Invite someone to this server from the self-hosted HS UI. The admin is
  // authenticated against ABS here; HS then calls the control plane with its
  // stored server secret (server-to-server), so the invite flows the same way
  // as one started on app.hearthshelf.com. Requires the instance to be paired.
  if (p === '/hs/hosted/invite' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)

    const cfg = await getHostedConfig()
    if (!cfg?.issuer || !cfg?.serverSecret) {
      return (json(res, 409, { error: 'not_paired', detail: 'pair with app.hearthshelf.com first' }), true)
    }

    let body = {}
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    if (!email || !email.includes('@')) return (json(res, 400, { error: 'invalid_email' }), true)
    const role = body.role === 'admin' ? 'admin' : 'user'

    const serverId = await getServerId()
    // The control plane lives at the issuer origin (it serves JWKS there too).
    const cpBase = cfg.issuer.replace(/\/$/, '')

    let cpRes
    try {
      cpRes = await fetch(`${cpBase}/servers/invite-from-server`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_id: serverId,
          server_secret: cfg.serverSecret,
          email,
          role,
        }),
      })
    } catch (err) {
      return (json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }), true)
    }
    const data = await cpRes.json().catch(() => ({}))
    return (json(res, cpRes.status, data), true)
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
