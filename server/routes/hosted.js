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
import { getProvisioning } from '../lib/provisioning.js'
import { getHostedConfig, setHostedConfig } from '../lib/hosted.js'
import { configureHostedOidc } from '../lib/oidc-setup.js'
import { acquireCert, getHsDirectState } from '../lib/hsdirect.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '')
// The control plane has two hosts: the browser-facing app (where the admin
// redeems a pairing code, app.hearthshelf.com) and the server-to-server API
// (where this box POSTs pairing/start + reachability/check, api.hearthshelf.com).
// They are split because the app host doesn't serve the API (it 405s). The API
// base mirrors hsdirect.js's default. Override per-request via controlPlaneUrl
// (the app link) only - the API base is env-only.
const DEFAULT_CP = (process.env.HS_CONTROL_PLANE_URL || 'https://app.hearthshelf.com').replace(/\/$/, '')
const DEFAULT_CP_API = (
  process.env.HS_CONTROL_PLANE_API_URL || 'https://api.hearthshelf.com'
).replace(/\/$/, '')
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

  // hs.direct provisioning status, polled by the onboarding Verify step after
  // pairing. Returns { status, publicUrl, host } so the SPA can show the assigned
  // address and know when the cert is ready (status 'active') to test against it.
  // Same onboarding-window gate as the reachability check.
  if (p === '/hs/hosted/hsdirect' && req.method === 'GET') {
    const onboarding = getMode() === 'aio' && !(await getProvisioning()).onboarded
    if (!onboarding) {
      const adminToken = await requireAbsAdmin(req)
      if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    }
    return (json(res, 200, await getHsDirectState()), true)
  }

  // Pre-flight reachability check (called by the setup wizard before pairing).
  // Proxies to the control plane's /reachability/check so the probe runs from the
  // public internet vantage point, not this box (which can reach itself on the
  // LAN regardless). Advisory only - never blocks pairing.
  //
  // Auth: normally requires an ABS admin. But on the AIO image the wizard offers
  // the connect choice (with this check) on the create-admin step, BEFORE the
  // admin account exists - so during the first-run window (AIO + not yet
  // onboarded) we allow it unauthenticated. The probe writes nothing and reveals
  // nothing about the instance beyond the URL the caller already supplied.
  if (p === '/hs/hosted/reachability' && req.method === 'POST') {
    const onboarding = getMode() === 'aio' && !(await getProvisioning()).onboarded
    if (!onboarding) {
      const adminToken = await requireAbsAdmin(req)
      if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    }

    let body = {}
    try {
      const raw = await readBody(req)
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }

    // Reachability is a pure server-to-server probe, so it targets the API base
    // (an explicit controlPlaneUrl override still wins, for testing).
    const cpApi = (typeof body.controlPlaneUrl === 'string' && body.controlPlaneUrl
      ? body.controlPlaneUrl
      : DEFAULT_CP_API
    ).replace(/\/$/, '')
    const publicUrl = (typeof body.publicUrl === 'string' && body.publicUrl ? body.publicUrl : PUBLIC_URL).replace(/\/$/, '')
    if (!publicUrl) {
      return (json(res, 400, { error: 'public_url_required', detail: 'set PUBLIC_URL or pass publicUrl' }), true)
    }

    let cpRes
    try {
      cpRes = await fetch(`${cpApi}/reachability/check`, {
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

  // Poll the control plane for the pairing claim. The SPA passes the code it was
  // shown (the box doesn't persist it); we add the stored server_secret and ask
  // the control plane whether a signed-in user has claimed the server yet. Lets
  // the wizard auto-advance to diagnostics once claimed, without the admin
  // bouncing back to click a button.
  if (p === '/hs/hosted/pair-status' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    let body = {}
    try {
      const raw = await readBody(req)
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!code) return (json(res, 400, { error: 'code_required' }), true)
    const cfg = await getHostedConfig().catch(() => null)
    if (!cfg?.serverSecret) return (json(res, 409, { error: 'not_paired' }), true)

    try {
      const cpRes = await fetch(`${DEFAULT_CP_API}/pairing/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, server_secret: cfg.serverSecret }),
      })
      const data = await cpRes.json().catch(() => ({}))
      if (!cpRes.ok) return (json(res, 502, { error: 'status_check_failed', status: cpRes.status }), true)
      return (json(res, 200, data), true)
    } catch (err) {
      return (json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }), true)
    }
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

    // Two hosts: cpApi for the server-to-server pairing call, controlPlane for
    // the browser link the admin redeems the code on. An explicit
    // controlPlaneUrl override (testing) drives both.
    const override = typeof body.controlPlaneUrl === 'string' && body.controlPlaneUrl
    const cpApi = (override ? body.controlPlaneUrl : DEFAULT_CP_API).replace(/\/$/, '')
    const controlPlane = (override ? body.controlPlaneUrl : DEFAULT_CP).replace(/\/$/, '')
    // The admin's OWN domain, if they entered one (advanced). When absent, the
    // address comes from hs.direct, which we can't know until after start (it
    // needs the server_secret), so we send a placeholder now and update it once
    // the cert is provisioned, before the user redeems.
    const ownDomain = (typeof body.publicUrl === 'string' && body.publicUrl ? body.publicUrl : PUBLIC_URL).replace(/\/$/, '')

    const serverId = await getServerId()
    const name = typeof body.name === 'string' ? body.name : undefined
    // Placeholder for start: the own domain if given, else a harmless https
    // sentinel (start only sanity-checks the scheme; redeem is the real gate, and
    // we overwrite this with the hs.direct hostname below).
    const startUrl = ownDomain || `https://pending.${serverId}.hs.direct`

    let startRes
    try {
      startRes = await fetch(`${cpApi}/pairing/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: serverId, public_url: startUrl, name }),
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

    // With the server_secret in hand, provision the hs.direct cert NOW (awaited,
    // not fire-and-forget) so we can hand the control plane the real public
    // hostname before the user redeems. Skipped when the admin brought their own
    // domain or opted out of hs.direct. Non-fatal: if it fails, the placeholder
    // stays and the admin can retry; we just don't block returning the code.
    if (!ownDomain) {
      try {
        const cert = await acquireCert()
        if (cert?.ok && cert.publicUrl) {
          await fetch(`${cpApi}/pairing/update-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: data.code,
              server_secret: data.server_secret,
              public_url: cert.publicUrl,
            }),
          }).catch(() => {})
        }
      } catch {
        /* non-fatal - placeholder remains; redeem will prompt to fix */
      }
    }

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
