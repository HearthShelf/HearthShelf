// Request context resolution - the seam between deployment modes.
//
// Every route handler receives a `ctx` instead of reaching for a global
// ABS_URL or re-deriving the user. A ctx is:
//   { absUrl, absToken, serverId, userId, role }
// where role is 'user' | 'admin' | 'root' (mapped from ABS's user type).
//
// Self-hosted (today): one ABS server from the ABS_SERVER_URL env; the caller
// is identified by validating their bearer token against ABS /api/me; serverId
// is this instance's persisted id (see db.getServerId).
//
// Hosted (app.hearthshelf.com): the central app fronts many HearthShelf
// instances. The caller presents a short-lived signed GRANT from the control
// plane instead of an ABS token. We verify it offline (JWKS) and turn its
// verified email into a per-user ABS API key. See lib/hosted.js. Either mode
// returns the same ctx shape, so route handlers don't care which is active.

import { getServerId } from '../db.js'
import { resolveHostedContext } from './hosted.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''

// Deployment mode. Three values reach the rest of the app:
//   'slim'   - HearthShelf only; the admin points it at their own ABS server.
//   'aio'    - the all-in-one image; ABS is bundled in-container and HearthShelf
//              owns its setup (first-boot auto-provision + onboarding).
//   'hosted' - app.hearthshelf.com fronts many instances (control-plane grants).
// 'selfhosted' is the legacy spelling of 'slim' and is accepted as an alias so
// existing deployments keep working. Auth resolution treats slim and aio
// identically (both validate a real ABS bearer); only 'hosted' differs.
export function getMode() {
  const raw = (process.env.HS_MODE || 'slim').toLowerCase()
  if (raw === 'selfhosted') return 'slim'
  if (raw === 'aio' || raw === 'hosted' || raw === 'slim') return raw
  return 'slim'
}

const MODE = getMode()

function bearer(req) {
  const header = req.headers['authorization'] || ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

// Resolve the caller's context, or null if unauthenticated.
export async function resolveContext(req) {
  if (MODE === 'hosted') {
    // The bearer is a control-plane grant, not an ABS token.
    return resolveHostedContext(bearer(req))
  }
  return resolveSelfHosted(req)
}

async function resolveSelfHosted(req) {
  const token = bearer(req)
  if (!token || !ABS_URL) return null
  try {
    const res = await fetch(`${ABS_URL}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const me = await res.json()
    if (!me?.id) return null
    const serverId = await getServerId()
    return {
      absUrl: ABS_URL,
      absToken: token,
      serverId,
      userId: me.id,
      role: me.type ?? 'user',
    }
  } catch {
    return null
  }
}

export function isAdmin(ctx) {
  return ctx?.role === 'admin' || ctx?.role === 'root'
}
