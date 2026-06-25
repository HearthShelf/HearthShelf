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
import { configureHostedOidc } from '../lib/oidc-setup.js'
import { acquireCert } from '../lib/hsdirect.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '')
const DEFAULT_CP = (process.env.HS_CONTROL_PLANE_URL || 'https://app.hearthshelf.com').replace(/\/$/, '')
// The hosted SPA origin allowed to receive tokens from the connect-return relay
// and to make cross-origin calls (CORS). One origin, never '*'.
const APP_ORIGIN = (process.env.HS_APP_ORIGIN || 'https://app.hearthshelf.com').replace(/\/$/, '')

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

  // OIDC connect-return relay (UNAUTHENTICATED, runs in the browser mid-login).
  // ABS finishes OIDC on this server's own origin and redirects here (its
  // same-origin auth_cb) with ?accessToken=<ABS JWT>&state=<nonce>. We can't
  // redirect cross-origin to app.hearthshelf.com (ABS forbids it, and we
  // shouldn't put a token in a cross-origin URL), so this tiny page hands the
  // token to the SPA opener via postMessage, pinned to the app origin. If there
  // is no opener (full-page fallback), it redirects to the app with the token in
  // the URL FRAGMENT (never the query, so it isn't logged).
  if (p === '/hs/hosted/connect-return' && req.method === 'GET') {
    const token = url.searchParams.get('accessToken') || url.searchParams.get('setToken') || ''
    const state = url.searchParams.get('state') || ''
    // JSON-encode for safe embedding inside the inline script.
    const payload = JSON.stringify({ type: 'hs-connect-token', token, state })
    const appOrigin = JSON.stringify(APP_ORIGIN)
    const fragment = `#token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`
    const html = `<!doctype html><meta charset="utf-8"><title>Connecting...</title>
<body style="font:14px system-ui;background:#1b1a18;color:#f4f1ea;display:grid;place-items:center;height:100vh;margin:0">
<p>Connecting to HearthShelf...</p>
<script>
(function(){
  var msg = ${payload};
  var appOrigin = ${appOrigin};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, appOrigin);
      window.close();
      return;
    }
  } catch (e) {}
  // No opener: full-page fallback. Token in the fragment, not the query.
  window.location.replace(appOrigin + "/connected" + ${JSON.stringify(fragment)});
})();
</script>
</body>`
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // This page must not be cached (it carries a one-time token).
      'Cache-Control': 'no-store',
    })
    res.end(html)
    return true
  }

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

  // Pre-flight reachability check (called by the setup wizard before pairing).
  // Proxies to the control plane's /reachability/check so the probe runs from the
  // public internet vantage point, not this box (which can reach itself on the
  // LAN regardless). Advisory only - never blocks pairing.
  if (p === '/hs/hosted/reachability' && req.method === 'POST') {
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

    let cpRes
    try {
      cpRes = await fetch(`${controlPlane}/reachability/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_url: publicUrl }),
      })
    } catch (err) {
      return (json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }), true)
    }
    const data = await cpRes.json().catch(() => ({}))
    if (!cpRes.ok) {
      return (json(res, 502, { error: 'reachability_check_failed', status: cpRes.status }), true)
    }
    return (json(res, 200, data), true)
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

    // Now that the server_secret exists, hs.direct can provision this box its own
    // valid HTTPS cert automatically - the monitored fallback connection that is
    // a core reason HearthShelf exists. On by default once paired; skipped only
    // when the admin opted out (HSDIRECT_DISABLED) or this isn't the AIO image.
    // Background + non-fatal: pairing succeeds regardless of cert outcome.
    void acquireCert().catch(() => {})

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

  // Configure ABS for OIDC federation. Called after the admin has redeemed the
  // pairing code on app.hearthshelf.com (which provisions this server's Clerk
  // OAuth client). We pull that client's config from the control plane and write
  // it into ABS via PATCH /api/auth-settings, so hosted users sign in via Clerk
  // and land in ABS matched by verified email. Idempotent-ish: re-running after
  // the one-time secret is consumed returns a clear "re-pair" error.
  if (p === '/hs/hosted/configure-oidc' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)

    const cfg = await getHostedConfig()
    if (!cfg?.issuer || !cfg?.serverSecret) {
      return (json(res, 409, { error: 'not_paired', detail: 'pair with app.hearthshelf.com first' }), true)
    }

    const serverId = await getServerId()
    try {
      const result = await configureHostedOidc(serverId, adminToken)
      return (json(res, 200, { ok: true, issuer: result.issuer }), true)
    } catch (err) {
      const msg = String(err?.message || err)
      // The control plane returns 409 (not provisioned yet) / 410 (secret
      // consumed) - reflect those as actionable statuses.
      if (msg.includes('not provisioned') || msg.includes('oidc_not_provisioned')) {
        return (json(res, 409, { error: 'oidc_not_provisioned', detail: 'redeem the pairing code on app.hearthshelf.com first' }), true)
      }
      if (msg.includes('secret_consumed')) {
        return (json(res, 410, { error: 'secret_consumed', detail: 're-pair to rotate the OIDC client secret' }), true)
      }
      return (json(res, 502, { error: 'oidc_setup_failed', detail: msg.slice(0, 200) }), true)
    }
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
