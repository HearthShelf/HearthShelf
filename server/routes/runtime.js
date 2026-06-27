// Runtime config the SPA reads once at boot (GET /hs/runtime, unauthenticated).
// It tells the client which deployment mode it is running in and how far setup
// has progressed, so the app can route a fresh install into the right onboarding
// flow instead of straight to the ABS login form.
//
// Shape:
//   {
//     mode: 'slim' | 'aio' | 'hosted',
//     absInitialized: boolean,   // does ABS have a root user yet?
//     paired: boolean,           // connected to app.hearthshelf.com?
//     onboarded: boolean,        // admin finished the HearthShelf wizard?
//     publicUrl: string | null,  // this instance's public origin, if known
//     controlPlaneUrl: string,   // where the connect step points
//     serviceUsername: string | null, // the auto-created HS service root (AIO)
//   }

import crypto from 'node:crypto'
import { json, readBody } from '../lib/http.js'
import { getMode, isAdmin } from '../lib/context.js'
import { getProvisioning, setProvisioning } from '../lib/provisioning.js'
import { getHostedConfig, setHostedConfig } from '../lib/hosted.js'
import { detectPublicIp } from '../lib/hsdirect.js'
import { getServerId, getServerName, setServerName } from '../db.js'

// The bundled ABS root user is HearthShelf's own service/backup admin, not a
// human login. Named so its purpose is obvious in the ABS user list years later.
const SERVICE_USERNAME = process.env.AIO_SERVICE_USERNAME || 'hearthshelf-service'

// On AIO the bundled ABS is co-located; ABS_SERVER_URL is set in the image but
// fall back to the in-container default so the init-admin step always has a
// target. On slim this env points at the admin's own ABS.
const ABS_URL = process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378'
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '') || null
const CONTROL_PLANE = (process.env.HS_CONTROL_PLANE_URL || 'https://app.hearthshelf.com').replace(/\/$/, '')
// Server-to-server control-plane API (api.hearthshelf.com), where the box pushes
// a renamed server so the hosted app stays in sync. Same default as hosted.js.
const CONTROL_PLANE_API = (
  process.env.HS_CONTROL_PLANE_API_URL || 'https://api.hearthshelf.com'
).replace(/\/$/, '')

// Is ABS initialised (has a root user)? ABS reports this on /api/status without
// auth. Used by slim, where HearthShelf doesn't provision ABS itself.
async function absInitializedFromAbs() {
  if (!ABS_URL) return false
  try {
    const res = await fetch(`${ABS_URL}/status`)
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data?.isInit)
  } catch {
    return false
  }
}

export async function handleRuntime(req, res, url, ctx) {
  // TEMPORARY dev helper: flip onboarded=false and bounce to the wizard so we can
  // re-run onboarding while iterating on the flow. Visit /hs/rerun-onboarding in a
  // browser (nginx only forwards /hs/* to this backend). NOTE: it only resets the
  // FLAG - ABS already has a root user, so the account step's init-admin returns
  // 'already_initialized'; this is for iterating on the library/connect/copy
  // steps. REMOVE before this flow stabilises.
  if (url.pathname === '/hs/rerun-onboarding' && req.method === 'GET') {
    await setProvisioning({ onboarded: false })
    // Land on the connect step by default - on a provisioned box the account +
    // library steps are already done, so connect is what we iterate on. Override
    // with ?step=account to walk the whole flow.
    const step = url.searchParams.get('step') || 'connect'
    res.writeHead(302, { Location: `/onboarding?step=${step}`, 'Cache-Control': 'no-store' })
    res.end()
    return true
  }

  // Mark the onboarding wizard finished so the SPA stops redirecting to it. An
  // admin-only write; the flag is read back via GET /hs/runtime.
  if (url.pathname === '/hs/runtime/onboarded' && req.method === 'POST') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    await setProvisioning({ onboarded: true })
    return (json(res, 200, { onboarded: true }), true)
  }

  // Set the server's display name. Editable later from Server Settings (admin),
  // but also written during the AIO name step BEFORE the admin account exists -
  // so during the AIO onboarding window we allow it unauthenticated, like the
  // other first-run writes. Otherwise admin-only.
  if (url.pathname === '/hs/runtime/server-name' && req.method === 'POST') {
    const onboarding = getMode() === 'aio' && !(await getProvisioning()).onboarded
    if (!onboarding && !isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return (json(res, 400, { error: 'bad_json' }), true)
    }
    const name = String(body.name || '').trim()
    if (name.length < 2) return (json(res, 400, { error: 'name_too_short' }), true)
    const saved = await setServerName(name)

    // If this box is paired, push the name to the control plane so the hosted app
    // shows the rename (otherwise it stays frozen at the pairing-time name).
    // Best-effort: a failure here must not fail the local save.
    try {
      const cfg = await getHostedConfig().catch(() => null)
      if (cfg?.serverSecret) {
        const serverId = await getServerId()
        await fetch(`${CONTROL_PLANE_API}/servers/name`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server_id: serverId, server_secret: cfg.serverSecret, name }),
        }).catch(() => {})
      }
    } catch {
      /* non-fatal - the name is saved locally; CP sync can retry on next edit */
    }

    return (json(res, 200, { serverName: saved }), true)
  }

  // Set up the bundled ABS from the AIO onboarding wizard. Creates a service
  // root account HearthShelf owns, then the user's own admin account with their
  // chosen username + email (see the two-account note below). This cannot require
  // an ABS token (there is no account yet), so it is gated structurally: AIO
  // only, before onboarding completes, and ABS must not already have a root user.
  // Returns the USER's bearer token so the SPA can sign them in.
  if (url.pathname === '/hs/runtime/init-admin' && req.method === 'POST') {
    if (getMode() !== 'aio') return (json(res, 404, { error: 'not_found' }), true)
    const prov = await getProvisioning()
    if (prov.onboarded) return (json(res, 409, { error: 'already_onboarded' }), true)

    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return (json(res, 400, { error: 'bad_json' }), true)
    }
    const username = String(body.username || '').trim()
    const password = String(body.password || '')
    const email = String(body.email || '').trim()
    if (!username || !password) {
      return (json(res, 400, { error: 'missing_credentials' }), true)
    }

    // Check ABS init state. There are three cases:
    //   a) not initialised        -> create the service root now.
    //   b) initialised by US       -> a prior attempt created the service root but
    //      (stored service pw)        the user-account step didn't finish; reuse
    //                                 the stored password and continue (no dead end).
    //   c) initialised, not by us  -> a pre-existing/foreign ABS root; we can't
    //      (no stored service pw)     know its password. Tell the admin to sign in.
    let status
    try {
      const statusRes = await fetch(`${ABS_URL}/status`)
      status = statusRes.ok ? await statusRes.json() : null
    } catch {
      return (json(res, 503, { error: 'abs_unreachable' }), true)
    }
    if (status?.isInit && !prov.servicePassword) {
      await setProvisioning({ absInitialized: true })
      return (json(res, 409, { error: 'already_initialized' }), true)
    }

    // Two-account model:
    //  1. ABS /init creates the ROOT user, which we use as HearthShelf's own
    //     service/backup admin - the identity the backend uses for admin API
    //     calls (federation, library ops). ABS forbids deleting root, so it can't
    //     be removed by accident. The user never logs in as this; we generate its
    //     password and keep only the resulting token (in hosted_config).
    //  2. We then create the user's OWN admin account with their chosen username
    //     and email, and sign THEM in. Their email is what app.hearthshelf.com
    //     matches on, so federated login lands on this account (not a new one).
    let servicePassword = prov.servicePassword
    if (!status?.isInit) {
      servicePassword = crypto.randomBytes(24).toString('base64url')
      const initRes = await fetch(`${ABS_URL}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newRoot: { username: SERVICE_USERNAME, password: servicePassword } }),
      }).catch(() => null)
      if (!initRes || !initRes.ok) {
        return (json(res, 502, { error: 'init_failed' }), true)
      }
      // Persist the service state now so an interrupted run can recover on retry.
      await setProvisioning({
        absInitialized: true,
        rootUsername: SERVICE_USERNAME,
        servicePassword,
      })
    }

    // Log in as the service root to get an admin token for the next call.
    const svcLogin = await fetch(`${ABS_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: SERVICE_USERNAME, password: servicePassword }),
    }).catch(() => null)
    const svcData = svcLogin && svcLogin.ok ? await svcLogin.json() : null
    const serviceToken = svcData?.user?.token || null
    if (!serviceToken) {
      return (json(res, 502, { error: 'service_login_failed' }), true)
    }

    // Create the user's personal admin account (with their email for federation).
    const createRes = await fetch(`${ABS_URL}/api/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        email: email || null,
        type: 'admin',
        isActive: true,
      }),
    }).catch(() => null)
    if (!createRes || !createRes.ok) {
      // Username taken or other ABS rejection - surface it so the wizard can ask
      // for a different one rather than failing opaquely. The service root is
      // already created + recorded, so a retry resumes from here cleanly.
      const absStatus = createRes ? createRes.status : 0
      return (json(res, 422, { error: 'user_create_failed', absStatus }), true)
    }

    // Sign the user in to hand the SPA a working bearer token for THEIR account.
    const userLogin = await fetch(`${ABS_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).catch(() => null)
    const userData = userLogin && userLogin.ok ? await userLogin.json() : null
    const token = userData?.user?.token || null

    // Persist: ABS is set up, the service username (so the UI can hide it), and
    // the service token as the backend's admin token for federation/admin ops.
    await setProvisioning({ absInitialized: true, rootUsername: SERVICE_USERNAME })
    await setHostedConfig({ absAdminToken: serviceToken })

    return (json(res, 200, { token, username }), true)
  }

  // Report the box's public IP to the onboarding wizard so the Connect step can
  // work from the real public address instead of the LAN one the browser sees.
  // Gated to the AIO first-run window (no admin token exists yet on that step);
  // returns { ip: null } when detection fails (advisory only, never blocks).
  if (url.pathname === '/hs/runtime/public-ip' && req.method === 'GET') {
    const onboarding = getMode() === 'aio' && !(await getProvisioning()).onboarded
    if (!onboarding && !isAdmin(ctx)) return (json(res, 404, { error: 'not_found' }), true)
    const ip = await detectPublicIp().catch(() => null)
    return (json(res, 200, { ip }), true)
  }

  if (url.pathname !== '/hs/runtime' || req.method !== 'GET') return false

  const mode = getMode()
  const prov = await getProvisioning()
  const hosted = await getHostedConfig().catch(() => null)
  const serverName = await getServerName().catch(() => null)

  // On AIO we are the source of truth for ABS setup (we provisioned it), so trust
  // our own record - it's also available before ABS finishes booting. On slim we
  // ask ABS directly, since the admin owns that server.
  const absInitialized = mode === 'aio' ? prov.absInitialized : await absInitializedFromAbs()

  json(res, 200, {
    mode,
    absInitialized,
    paired: Boolean(hosted?.issuer && hosted?.jwksUrl),
    onboarded: prov.onboarded,
    publicUrl: PUBLIC_URL,
    controlPlaneUrl: CONTROL_PLANE,
    // The auto-created HearthShelf service root, so the Config UI can mark it as
    // a machine account. Only AIO provisions one; null on slim/hosted.
    serviceUsername: mode === 'aio' ? prov.rootUsername || SERVICE_USERNAME : null,
    // Admin-chosen server name (how it's referred to + the pairing default).
    serverName,
  })
  return true
}
