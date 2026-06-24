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

import { json } from '../lib/http.js'
import { getMode, isAdmin } from '../lib/context.js'
import { getProvisioning, setProvisioning, revealRootCredentials } from '../lib/provisioning.js'
import { getHostedConfig } from '../lib/hosted.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''
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

  // Reveal the auto-generated root credentials to the AIO onboarding wizard.
  // This cannot require an ABS token (the admin needs these credentials to GET
  // one), so it is gated structurally instead: it only ever returns on an AIO
  // box that hasn't completed onboarding, and the password self-clears after the
  // first read. Once onboarded, or on slim, it returns 404.
  if (url.pathname === '/hs/runtime/root-credentials' && req.method === 'POST') {
    if (getMode() !== 'aio') return (json(res, 404, { error: 'not_found' }), true)
    const prov = await getProvisioning()
    if (prov.onboarded) return (json(res, 404, { error: 'not_found' }), true)
    const creds = await revealRootCredentials()
    if (!creds) return (json(res, 404, { error: 'not_found' }), true)
    return (json(res, 200, creds), true)
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
