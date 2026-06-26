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
//   }

import { json, readBody } from '../lib/http.js'
import { getMode, isAdmin } from '../lib/context.js'
import { getProvisioning, setProvisioning } from '../lib/provisioning.js'
import { getHostedConfig } from '../lib/hosted.js'
import { detectPublicIp } from '../lib/hsdirect.js'

// On AIO the bundled ABS is co-located; ABS_SERVER_URL is set in the image but
// fall back to the in-container default so the init-admin step always has a
// target. On slim this env points at the admin's own ABS.
const ABS_URL = process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378'
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '') || null
const CONTROL_PLANE = (process.env.HS_CONTROL_PLANE_URL || 'https://app.hearthshelf.com').replace(/\/$/, '')

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
  // Mark the onboarding wizard finished so the SPA stops redirecting to it. An
  // admin-only write; the flag is read back via GET /hs/runtime.
  if (url.pathname === '/hs/runtime/onboarded' && req.method === 'POST') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    await setProvisioning({ onboarded: true })
    return (json(res, 200, { onboarded: true }), true)
  }

  // Create the bundled ABS admin account from the AIO onboarding wizard, using
  // the admin's CHOSEN username and password (replicating ABS's own first-run
  // rather than a generated password). This cannot require an ABS token (there
  // is no account yet), so it is gated structurally: AIO only, before onboarding
  // completes, and ABS must not already have a root user. On success it inits
  // ABS, signs in, records absInitialized, and returns the bearer token so the
  // SPA can authenticate the new admin without a second round-trip.
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
    if (!username || !password) {
      return (json(res, 400, { error: 'missing_credentials' }), true)
    }

    // Refuse if ABS already has a root user - ABS /init returns 500 in that case,
    // but we check first so we can return a clear, actionable error instead.
    try {
      const statusRes = await fetch(`${ABS_URL}/status`)
      const status = statusRes.ok ? await statusRes.json() : null
      if (status?.isInit) {
        await setProvisioning({ absInitialized: true })
        return (json(res, 409, { error: 'already_initialized' }), true)
      }
    } catch {
      return (json(res, 503, { error: 'abs_unreachable' }), true)
    }

    const initRes = await fetch(`${ABS_URL}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newRoot: { username, password } }),
    }).catch(() => null)
    if (!initRes || !initRes.ok) {
      return (json(res, 502, { error: 'init_failed' }), true)
    }

    // Sign in as the new admin to hand the SPA a working bearer token.
    const loginRes = await fetch(`${ABS_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).catch(() => null)
    const loginData = loginRes && loginRes.ok ? await loginRes.json() : null
    const token = loginData?.user?.token || null

    await setProvisioning({ absInitialized: true })
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
  })
  return true
}
