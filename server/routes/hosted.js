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
import { getServerId, getServerName } from '../db.js'
import { getMode } from '../lib/context.js'
import { getProvisioning, setProvisioning } from '../lib/provisioning.js'
import {
  getHostedConfig,
  setHostedConfig,
  clearHostedConfig,
  resolveHostedContext,
  verifyGrant,
  getLinkedAbsUserIds,
} from '../lib/hosted.js'
import {
  getCredentialHealth,
  remintServiceKey,
  selfHeal,
  whoAmI,
  getServiceToken,
} from '../lib/serviceCredential.js'
import { appLog } from '../lib/appLog.js'
import { acquireCert, getHsDirectState } from '../lib/hsdirect.js'
import { emailRelayEndpoint, emailRelayOptedOut, emailRelayOnStartup } from '../lib/emailRelay.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''
const SERVICE_USERNAME = process.env.AIO_SERVICE_USERNAME || 'hearthshelf-service'
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '')
// The control plane has two hosts: the browser-facing app (where the admin
// redeems a pairing code, app.hearthshelf.com) and the server-to-server API
// (where this box POSTs pairing/start + reachability/check, api.hearthshelf.com).
// They are split because the app host doesn't serve the API (it 405s). The API
// base mirrors hsdirect.js's default. Override per-request via controlPlaneUrl
// (the app link) only - the API base is env-only.
const DEFAULT_CP = (process.env.HS_CONTROL_PLANE_URL || 'https://app.hearthshelf.com').replace(
  /\/$/,
  '',
)
const DEFAULT_CP_API = (
  process.env.HS_CONTROL_PLANE_API_URL || 'https://api.hearthshelf.com'
).replace(/\/$/, '')
// The connect-domain VPS broker, which also hosts the self-IP port probe. Same
// host the cert flow uses. The probe connects back to THIS box's public IP.
const BROKER_URL = (
  process.env.HSDIRECT_BROKER_URL || 'https://ns1.d.hearthshelf.com:8443'
).replace(/\/$/, '')
// The externally-reachable port (the host's WebUI port; default 9277). The port
// to forward + probe when there's no public URL yet (cert pending, no PUBLIC_URL
// set) - it's the single port the secure address serves HTTPS on once it lands.
const PUBLIC_PORT = Number(process.env.HSDIRECT_PUBLIC_PORT || '9277')
// The connect domain (zone) the auto address lives under. Config-driven, never a
// hardcoded literal - we own d.hearthshelf.com today; a dedicated connect domain
// is registered later. Used only for placeholder/sanity, never to fabricate a
// resolvable host (real hostnames are synthesized as <ip-dashed>.<hash>.<zone>).
const CONNECT_ZONE = (process.env.HSDIRECT_ZONE || 'd.hearthshelf.com').replace(/^\.+|\.+$/g, '')

// The port a user must forward / we probe: from a public URL's explicit port, or
// the scheme default. Returns a number, or null if no URL.
function portFromUrl(raw) {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.port) return Number(u.port)
    return u.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

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

  // HS-owned connect (replaces the ABS-OIDC bounce). The browser presents a
  // short-lived control-plane GRANT (minted by app.hearthshelf.com for THIS
  // server); HS verifies it offline against the pinned CP JWKS, then mints/returns
  // a per-user ABS token. No ABS OIDC, no popup - the SPA just fetches this and
  // calls ABS /api/* with the returned token. CORS for app.hearthshelf.com is
  // applied in index.js. The grant IS the auth (aud-pinned, email_verified).
  if (p === '/hs/hosted/connect' && req.method === 'POST') {
    let body = {}
    try {
      const raw = await readBody(req)
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const grant = typeof body.grant === 'string' ? body.grant : ''
    if (!grant) return (json(res, 400, { error: 'grant_required' }), true)

    const cfg = await getHostedConfig()
    if (!cfg?.issuer || !cfg?.jwksUrl) {
      return (json(res, 409, { error: 'not_paired' }), true)
    }

    const ctx = await resolveHostedContext(grant)
    if (!ctx?.absToken) {
      // Bad/expired grant, or the user couldn't be matched/provisioned + keyed.
      return (json(res, 401, { error: 'connect_failed' }), true)
    }
    return (json(res, 200, { token: ctx.absToken, userId: ctx.userId, role: ctx.role }), true)
  }

  // Admin recovery: re-enable disabled admin accounts when every human admin has
  // been locked out (so no one can present an ABS admin token anymore). This is
  // the break-glass path - it does NOT use requireAbsAdmin (which would be
  // impossible to satisfy). Instead the caller proves they are a SERVER ADMIN via
  // a control-plane grant (the control plane knows server-admins from the pairing
  // link), which we verify offline against the pinned JWKS. We then act with the
  // stored service-root absAdminToken (the ABS root/service account can't be
  // disabled), flipping disabled admins back to active. Requires connect to be
  // enabled (paired + an admin token on file).
  if (p === '/hs/hosted/recover-admins' && req.method === 'POST') {
    let body = {}
    try {
      const raw = await readBody(req)
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const grant = typeof body.grant === 'string' ? body.grant : ''
    if (!grant) return (json(res, 400, { error: 'grant_required' }), true)

    const cfg = await getHostedConfig()
    if (!cfg?.issuer || !cfg?.jwksUrl) {
      return (json(res, 409, { error: 'not_paired' }), true)
    }
    if (!ABS_URL) {
      return (json(res, 409, { error: 'no_service_token' }), true)
    }
    // Use the self-healing service token: if the stored credential is stale this
    // re-mints a durable one from the service account, so admin recovery still
    // works even after the credential died (the very situation this endpoint is
    // for). Null means it's broken beyond auto-repair.
    const svcToken = await getServiceToken()
    if (!svcToken) return (json(res, 409, { error: 'no_service_token' }), true)

    const claims = await verifyGrant(grant)
    if (!claims) return (json(res, 401, { error: 'invalid_grant' }), true)
    // Only a server admin may break the glass. A regular user's grant is rejected.
    if (claims.role !== 'admin') return (json(res, 403, { error: 'forbidden' }), true)

    // List users with the service token and re-enable every disabled admin/root
    // account. We don't touch regular users - this restores admin access only,
    // the minimum to get back in.
    let users
    try {
      const r = await fetch(`${ABS_URL}/api/users`, {
        headers: { Authorization: `Bearer ${svcToken}` },
      })
      if (!r.ok) return (json(res, 502, { error: 'abs_list_failed', status: r.status }), true)
      const data = await r.json()
      users = Array.isArray(data) ? data : data?.users || []
    } catch (err) {
      return (json(res, 502, { error: 'abs_unreachable', detail: String(err).slice(0, 160) }), true)
    }

    const targets = users.filter(
      (u) => (u.type === 'admin' || u.type === 'root') && (!u.isActive || u.isLocked),
    )
    const recovered = []
    for (const u of targets) {
      try {
        const r = await fetch(`${ABS_URL}/api/users/${u.id}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${svcToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ isActive: true, isLocked: false }),
        })
        if (r.ok) recovered.push({ id: u.id, username: u.username })
      } catch {
        // Skip this one; report the rest. A partial recovery still helps.
      }
    }

    return (json(res, 200, { ok: true, recovered, count: recovered.length }), true)
  }

  // Current hosted status - safe to read by any admin. Reports whether pairing
  // and config are in place, never leaking secrets.
  if (p === '/hs/hosted/config' && req.method === 'GET') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    const cfg = await getHostedConfig()
    // Live credential health so the Connect UI can show valid/stale/broken and
    // whether auto-recovery is possible - not just token PRESENCE (a present but
    // dead token is exactly the failure that hid this outage).
    const health = await getCredentialHealth().catch(() => null)
    return (
      json(res, 200, {
        mode: getMode(),
        paired: Boolean(cfg?.issuer && cfg?.jwksUrl),
        hasAbsAdminToken: Boolean(cfg?.absAdminToken),
        issuer: cfg?.issuer ?? null,
        adminCredStatus: health?.state ?? cfg?.adminCredStatus ?? null,
        canSelfHeal: health?.canSelfHeal ?? false,
      }),
      true
    )
  }

  // Live credential health probe for the Connect UI's service-account panel.
  // Read-only: validates the stored credential against ABS and reports whether
  // self-heal (re-mint from the service account) is possible. Does not re-mint.
  if (p === '/hs/hosted/service-health' && req.method === 'GET') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    const health = await getCredentialHealth().catch(() => null)
    if (!health) return (json(res, 200, { state: 'broken', canSelfHeal: false }), true)
    return (json(res, 200, health), true)
  }

  // Reset the service credential: mint a fresh DURABLE ABS API key and store it.
  // Prefer minting AS the service root (selfHeal, using the stored service
  // password) over minting from the caller's admin token - ABS forbids a non-root
  // admin from creating an API key for the root service account (403), so the
  // caller path fails for any operator who isn't root (i.e. almost everyone). We
  // fall back to the caller's token only if self-heal can't run (no/invalid
  // service password), which still works when the caller IS root.
  if (p === '/hs/hosted/service-credential/reset' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    let key = await selfHeal()
    if (!key) key = await remintServiceKey(adminToken)
    if (!key) return (json(res, 502, { error: 'mint_failed' }), true)
    appLog.info('hosted', 'admin credential reset from the Connect UI (new durable API key minted)')
    return (json(res, 200, { ok: true, status: 'valid' }), true)
  }

  // Manual override for when self-heal and reset can't recover automatically
  // (e.g. the stored service password has desynced from ABS). Accepts EITHER a
  // new service password (which we validate by logging in, re-sync into
  // provisioning, then re-mint a durable key from) OR a known-good admin API key
  // / token pasted directly (validated against ABS, then stored as-is).
  if (p === '/hs/hosted/service-credential/override' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    let body = {}
    try {
      const raw = await readBody(req)
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const pastedToken = typeof body.absAdminToken === 'string' ? body.absAdminToken.trim() : ''
    const servicePassword =
      typeof body.servicePassword === 'string' ? body.servicePassword : ''

    // Path A: paste a known-good admin token/key. Validate it authenticates as an
    // admin/root before storing, so a typo can't replace a working key with junk.
    if (pastedToken) {
      const me = await whoAmI(pastedToken)
      if (!(me?.type === 'admin' || me?.type === 'root')) {
        return (json(res, 422, { error: 'token_not_admin' }), true)
      }
      await setHostedConfig({ absAdminToken: pastedToken, adminCredStatus: 'valid' })
      appLog.info('hosted', 'admin credential overridden with a pasted admin token')
      return (json(res, 200, { ok: true, status: 'valid' }), true)
    }

    // Path B: supply a new service-account password. Log in with it to confirm it
    // works, persist it (re-syncing provisioning so boot self-heal works again),
    // then mint a durable key from that session.
    if (servicePassword) {
      const svcUsername = (await getProvisioning().catch(() => null))?.rootUsername || SERVICE_USERNAME
      let sessionToken = null
      try {
        const r = await fetch(`${ABS_URL}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: svcUsername, password: servicePassword }),
        })
        if (r.ok) sessionToken = (await r.json())?.user?.token || null
      } catch {
        return (json(res, 502, { error: 'abs_unreachable' }), true)
      }
      if (!sessionToken) return (json(res, 422, { error: 'bad_service_password' }), true)
      await setProvisioning({ servicePassword })
      const key = await remintServiceKey(sessionToken)
      if (!key) return (json(res, 502, { error: 'mint_failed' }), true)
      appLog.info('hosted', 'service password re-synced and a durable admin key re-minted')
      return (json(res, 200, { ok: true, status: 'valid' }), true)
    }

    return (json(res, 400, { error: 'missing_input' }), true)
  }

  // Email relay status. Tells the SPA whether this box can offer "use
  // HearthShelf email" (paired + not opted out) and whether ABS is currently
  // pointed at the loopback relay. The host/port come from emailRelay.js so the
  // SPA never hardcodes them. Admin-only; reads ABS's current SMTP host/port to
  // decide `active`.
  if (p === '/hs/hosted/email-relay' && req.method === 'GET') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    const cfg = await getHostedConfig()
    const paired = Boolean(cfg?.serverSecret && cfg?.issuer)
    const { host, port } = emailRelayEndpoint()

    // Is ABS already sending through the relay? Compare its saved SMTP target.
    let active = false
    try {
      const r = await fetch(`${ABS_URL}/api/emails/settings`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      if (r.ok) {
        const s = (await r.json())?.settings || {}
        active = s.host === host && Number(s.port) === port
      }
    } catch {
      // ABS unreachable: report not-active rather than failing the status read.
    }

    return (
      json(res, 200, {
        available: paired && !emailRelayOptedOut(),
        paired,
        optedOut: emailRelayOptedOut(),
        active,
        host,
        port,
      }),
      true
    )
  }

  // Point ABS's SMTP at the loopback relay (enable) - the 1-click setup. Writes
  // host/port/secure/from via ABS's settings API using the caller's admin token.
  // Only works when paired; the relay refuses unpaired sends anyway. Disabling
  // is left to the normal SMTP form (we don't clear the admin's other settings).
  if (p === '/hs/hosted/email-relay/apply' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    const cfg = await getHostedConfig()
    if (!cfg?.serverSecret || !cfg?.issuer) {
      return (
        json(res, 409, { error: 'not_paired', detail: 'pair with app.hearthshelf.com first' }),
        true
      )
    }

    // Make sure the listener is actually up before we point ABS at it (a paired
    // box that booted before pairing may not have started it yet). Idempotent.
    await emailRelayOnStartup().catch(() => {})

    const { host, port } = emailRelayEndpoint()
    let absRes
    try {
      absRes = await fetch(`${ABS_URL}/api/emails/settings`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          port,
          // Loopback plaintext inside the box; the relay adds TLS on the way out.
          secure: false,
          rejectUnauthorized: false,
          // ABS sends AUTH; the relay accepts any creds on loopback. A non-empty
          // user keeps nodemailer from skipping AUTH on some configs.
          user: 'hearthshelf',
          pass: 'hearthshelf',
        }),
      })
    } catch (err) {
      return (json(res, 502, { error: 'abs_unreachable', detail: String(err).slice(0, 160) }), true)
    }
    if (!absRes.ok) {
      const detail = await absRes.text().catch(() => '')
      return (json(res, 502, { error: 'abs_rejected', detail: detail.slice(0, 200) }), true)
    }
    return (json(res, 200, { ok: true, host, port }), true)
  }

  // Set the ABS admin credential (and optionally issuer/jwks directly). The admin
  // credential lets HS mint per-user ABS API keys for federated users. We store a
  // DURABLE API key, never the caller's perishable session token: mint one from
  // the caller's session (or an explicitly pasted token) via remintServiceKey. A
  // pasted token that is already a durable key round-trips fine (we re-mint from
  // it). Storing the raw session token is exactly what caused the silent outage.
  if (p === '/hs/hosted/config' && req.method === 'PUT') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    let body = {}
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    if (typeof body.issuer === 'string' || typeof body.jwksUrl === 'string') {
      await setHostedConfig({
        issuer: typeof body.issuer === 'string' ? body.issuer : undefined,
        jwksUrl: typeof body.jwksUrl === 'string' ? body.jwksUrl : undefined,
      })
    }
    // Mint a durable key from the supplied (or caller's) admin token.
    const seedToken =
      typeof body.absAdminToken === 'string' && body.absAdminToken
        ? body.absAdminToken
        : adminToken
    const key = await remintServiceKey(seedToken)
    if (!key) {
      await setHostedConfig({ adminCredStatus: 'broken' }).catch(() => {})
      return (json(res, 502, { error: 'mint_failed' }), true)
    }
    const saved = await getHostedConfig()
    return (
      json(res, 200, {
        paired: Boolean(saved.issuer && saved.jwksUrl),
        hasAbsAdminToken: Boolean(saved.absAdminToken),
      }),
      true
    )
  }

  // Port reachability check via the hs.direct VPS. Unlike the control plane's
  // hostname probe (which rejects bare IPs and needs a live cert), the VPS probes
  // THIS box's public IP directly on the port we're exposed on - so it works even
  // before the cert is ready. We derive the port from our public address (the
  // hs.direct URL's :PORT, else PUBLIC_URL, else 443). The VPS uses the request's
  // source IP, so we send only the port. Same onboarding-window gate as the others.
  if (p === '/hs/hosted/port-check' && req.method === 'GET') {
    const onboarding = getMode() === 'aio' && !(await getProvisioning()).onboarded
    if (!onboarding) {
      const adminToken = await requireAbsAdmin(req)
      if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    }
    // Port to test: the hs.direct URL's port, else PUBLIC_URL's, else the
    // hs.direct serving port (9443) - which is where we'll be reachable once the
    // cert lands, so it's the right thing to probe/forward even while pending.
    const hsd = await getHsDirectState().catch(() => null)
    const port = portFromUrl(hsd?.publicUrl) ?? portFromUrl(PUBLIC_URL) ?? PUBLIC_PORT
    try {
      // Time-boxed so a down/unresponsive broker fails fast (a bare fetch would
      // hang on the OS TCP timeout, ~minutes, holding the request open). 8s is
      // plenty for a live probe; past that we report broker_unreachable and the
      // UI shows "check unavailable" without blocking.
      const probeRes = await fetch(`${BROKER_URL}/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(8000),
      })
      const data = await probeRes.json().catch(() => ({}))
      if (!probeRes.ok)
        return (json(res, 502, { error: 'probe_failed', status: probeRes.status }), true)
      // { open, ip, port } from the VPS.
      return (json(res, 200, { open: Boolean(data.open), port, publicIp: data.ip ?? null }), true)
    } catch (err) {
      return (
        json(res, 502, { error: 'broker_unreachable', detail: String(err).slice(0, 160) }),
        true
      )
    }
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
    const cpApi = (
      typeof body.controlPlaneUrl === 'string' && body.controlPlaneUrl
        ? body.controlPlaneUrl
        : DEFAULT_CP_API
    ).replace(/\/$/, '')
    const publicUrl = (
      typeof body.publicUrl === 'string' && body.publicUrl ? body.publicUrl : PUBLIC_URL
    ).replace(/\/$/, '')
    if (!publicUrl) {
      return (
        json(res, 400, {
          error: 'public_url_required',
          detail: 'set PUBLIC_URL or pass publicUrl',
        }),
        true
      )
    }

    let cpRes
    try {
      cpRes = await fetch(`${cpApi}/reachability/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_url: publicUrl }),
      })
    } catch (err) {
      return (
        json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }),
        true
      )
    }
    const data = await cpRes.json().catch(() => ({}))
    if (!cpRes.ok) {
      return (json(res, 502, { error: 'reachability_check_failed', status: cpRes.status }), true)
    }
    return (json(res, 200, data), true)
  }

  // Disconnect from app.hearthshelf.com. Tears down the control-plane record
  // (best-effort, server_secret-authed) AND clears local trust state so the box
  // stops federating. Admin-only. Clearing local state always happens even if the
  // control plane call fails - the box is disconnected regardless.
  if (p === '/hs/hosted/disconnect' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    const cfg = await getHostedConfig().catch(() => null)
    if (cfg?.serverSecret) {
      try {
        const serverId = await getServerId()
        await fetch(`${DEFAULT_CP_API}/servers/deregister`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server_id: serverId, server_secret: cfg.serverSecret }),
        }).catch(() => {})
      } catch {
        /* best-effort; we still clear local state below */
      }
    }
    await clearHostedConfig()
    return (json(res, 200, { ok: true }), true)
  }

  // Recover connection: paste a server_secret the owner just minted via the
  // hosted app's "reset connection secret" action (POST /servers/:id/reset-secret)
  // and store it locally, so a box that lost/desynced its secret re-syncs WITHOUT
  // deregistering (links/certs/default survive). Admin-only. We validate the
  // pasted secret against the control plane FIRST (side-effect-free verify) so a
  // typo can't overwrite a still-valid stored secret with garbage. issuer/jwksUrl
  // are untouched - only the secret changed on the CP side.
  if (p === '/hs/hosted/recover-secret' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)
    let body = {}
    try {
      const raw = await readBody(req)
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const secret = typeof body.server_secret === 'string' ? body.server_secret.trim() : ''
    if (!secret) return (json(res, 400, { error: 'server_secret_required' }), true)

    const serverId = await getServerId()
    let vRes
    try {
      vRes = await fetch(`${DEFAULT_CP_API}/servers/verify-secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: serverId, server_secret: secret }),
      })
    } catch (err) {
      return (
        json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }),
        true
      )
    }
    if (vRes.status === 401) return (json(res, 400, { error: 'bad_server_secret' }), true)
    if (!vRes.ok) return (json(res, 502, { error: 'verify_failed', status: vRes.status }), true)

    // Verified live - persist it. Keeps issuer/jwksUrl/absAdminToken as they are.
    await setHostedConfig({ serverSecret: secret })
    return (json(res, 200, { ok: true }), true)
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
      if (!cpRes.ok)
        return (json(res, 502, { error: 'status_check_failed', status: cpRes.status }), true)
      return (json(res, 200, data), true)
    } catch (err) {
      return (
        json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }),
        true
      )
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
    const ownDomain = (
      typeof body.publicUrl === 'string' && body.publicUrl ? body.publicUrl : PUBLIC_URL
    ).replace(/\/$/, '')

    const serverId = await getServerId()
    // If this box has paired before, it still holds the current server_secret.
    // Forward it so the control plane can authorize re-keying an already-owned
    // server (a stranger who only knows the public server_id cannot). Absent on a
    // genuine first pair, which the control plane allows without proof.
    const existingSecret = (await getHostedConfig().catch(() => null))?.serverSecret || undefined
    // Prefer an explicit name from the caller, else the persisted server name.
    const name =
      (typeof body.name === 'string' && body.name.trim()) || (await getServerName()) || undefined
    // Placeholder for start: the own domain if given, else a sentinel under OUR
    // connect zone (never a domain we don't own). start only sanity-checks the
    // scheme; redeem is the real gate, and we overwrite this with the real
    // synthesized address below once the cert is provisioned. If that fails we
    // refuse rather than leave this unresolvable placeholder in place.
    const startUrl = ownDomain || `https://pending.${serverId}.${CONNECT_ZONE}`

    let startRes
    try {
      startRes = await fetch(`${cpApi}/pairing/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_id: serverId,
          public_url: startUrl,
          name,
          ...(existingSecret ? { server_secret: existingSecret } : {}),
        }),
      })
    } catch (err) {
      return (
        json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }),
        true
      )
    }
    if (!startRes.ok) {
      const detail = await startRes.text().catch(() => '')
      return (
        json(res, 502, {
          error: 'pairing_start_failed',
          status: startRes.status,
          detail: detail.slice(0, 200),
        }),
        true
      )
    }
    const data = await startRes.json()

    // Persist the trust details. The control plane issues a fresh server_secret
    // on every /pairing/start (and rotates the servers-row hash to match), so we
    // always store the new one.
    await setHostedConfig({
      issuer: data.issuer,
      jwksUrl: data.jwks_url,
      serverSecret: data.server_secret,
    })
    // Mint a DURABLE admin API key from the caller's session token rather than
    // storing the session token itself - a session token dies with its user, and
    // re-pairing must never clobber a healthy stored key with a perishable one.
    // Best-effort: if the mint fails we leave any existing key in place and flag
    // the state, rather than failing the whole pair.
    const paired_key = await remintServiceKey(adminToken).catch(() => null)
    if (!paired_key) {
      await setHostedConfig({ adminCredStatus: 'broken' }).catch(() => {})
      appLog.warn('hosted', 'pairing completed but could not mint a durable admin key; reset it under Connect')
    }

    // With the server_secret in hand, provision the secure connect-domain cert
    // NOW (awaited) so we can hand the control plane the real, RESOLVABLE address
    // before the user redeems. Skipped when the admin brought their own domain.
    //
    // The start placeholder (pending.<id>.<zone>) does NOT resolve, so if cert
    // provisioning fails we must NOT hand back a code that leads to a dead URL.
    // We surface the failure instead - the admin can fix reachability and retry,
    // and the cause shows up in the logs (the real bug to chase, #23).
    if (!ownDomain) {
      let cert
      try {
        cert = await acquireCert()
      } catch (err) {
        return (
          json(res, 502, { error: 'address_setup_failed', detail: String(err).slice(0, 160) }),
          true
        )
      }
      if (!cert?.ok || !cert.publicUrl) {
        return (
          json(res, 502, { error: 'address_setup_failed', reason: cert?.reason || 'no_url' }),
          true
        )
      }
      const upd = await fetch(`${cpApi}/pairing/update-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: data.code,
          server_secret: data.server_secret,
          public_url: cert.publicUrl,
        }),
      }).catch(() => null)
      if (!upd || !upd.ok) {
        return (json(res, 502, { error: 'address_update_failed' }), true)
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

  // Invite someone to this server from the self-hosted HS UI. The admin is
  // authenticated against ABS here; HS then calls the control plane with its
  // stored server secret (server-to-server), so the invite flows the same way
  // as one started on app.hearthshelf.com. Requires the instance to be paired.
  if (p === '/hs/hosted/invite' && req.method === 'POST') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)

    const cfg = await getHostedConfig()
    if (!cfg?.issuer || !cfg?.serverSecret) {
      return (
        json(res, 409, { error: 'not_paired', detail: 'pair with app.hearthshelf.com first' }),
        true
      )
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
      return (
        json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }),
        true
      )
    }
    const data = await cpRes.json().catch(() => ({}))
    return (json(res, cpRes.status, data), true)
  }

  // Which ABS users have an hs.com account linked to this server. Purely local
  // (hosted_user_keys), so this works even if the control plane is unreachable.
  if (p === '/hs/hosted/linked-users' && req.method === 'GET') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)

    const serverId = await getServerId()
    const linked = await getLinkedAbsUserIds(serverId)
    return (json(res, 200, { linked }), true)
  }

  // List pending invites for this server. Forwards to the control plane (the
  // source of truth for pending_invites), the same way the invite POST does.
  if (p === '/hs/hosted/invites' && req.method === 'GET') {
    const adminToken = await requireAbsAdmin(req)
    if (!adminToken) return (json(res, 401, { error: 'unauthorized' }), true)

    const cfg = await getHostedConfig()
    if (!cfg?.issuer || !cfg?.serverSecret) {
      return (
        json(res, 409, { error: 'not_paired', detail: 'pair with app.hearthshelf.com first' }),
        true
      )
    }

    const serverId = await getServerId()
    const cpBase = cfg.issuer.replace(/\/$/, '')

    let cpRes
    try {
      cpRes = await fetch(`${cpBase}/servers/invites-for-server`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: serverId, server_secret: cfg.serverSecret }),
      })
    } catch (err) {
      return (
        json(res, 502, { error: 'control_plane_unreachable', detail: String(err).slice(0, 160) }),
        true
      )
    }
    const data = await cpRes.json().catch(() => ({}))
    return (json(res, cpRes.status, data), true)
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
