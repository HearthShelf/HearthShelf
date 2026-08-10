// Request context resolution - the seam between deployment modes.
//
// Every route handler receives a `ctx` instead of reaching for a global
// ABS_URL or re-deriving the user. A ctx is:
//   { absUrl, absToken, serverId, userId, username, role }
// where role is 'user' | 'admin' | 'root' (mapped from ABS's user type) and
// username is the caller's ABS username (snapshotted into notes/club rows at
// write time so those HS-db-only features render names without an absdb mount).
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
//
// Three kinds of caller, checked in this order:
//   1. A third-party APP presenting a box-issued access token (any mode).
//   2. Hosted: a control-plane grant.
//   3. Self-hosted: a real ABS bearer.
//
// Apps come first because their token is ours and cheap to recognise, and
// because the alternative - trying it against ABS first - would send a token ABS
// has never seen to ABS on every app request.
export async function resolveContext(req) {
  const app = await resolveAppContext(req)
  if (app) return app
  if (MODE === 'hosted') {
    // The bearer is a control-plane grant, not an ABS token.
    return resolveHostedContext(bearer(req))
  }
  return resolveSelfHosted(req)
}

/**
 * Resolve a third-party app's access token into a normal ctx.
 *
 * THIS IS THE SCOPE ENFORCEMENT POINT, and it is here rather than in each route
 * for a reason: a per-route check is exactly what the next route someone adds
 * will forget, and the failure mode is an app silently gaining access it was
 * never granted. Everything an app can reach flows through resolveContext, so
 * enforcing here cannot be bypassed by adding a handler.
 *
 * Two guards, both necessary:
 *
 *   SCOPE. The request's required scope must be covered by what the user
 *   approved. Refused with 403 semantics (a null ctx surfaces as 401/403 at the
 *   route, which is the existing contract).
 *
 *   INTERSECTION. The ctx carries the AUTHORIZING USER's ABS key, so ABS itself
 *   applies that user's real permissions on top. An app holding 'library:write'
 *   for a user who cannot delete still cannot delete, because ABS refuses the
 *   underlying call. This is the confused-deputy guard and it is why the app
 *   acts AS the user rather than as the server - never substitute an admin key
 *   here, however convenient it looks.
 *
 * Returns null (not an error) when the bearer is not an app token, so the normal
 * paths still get their turn.
 */
async function resolveAppContext(req) {
  const token = bearer(req)
  if (!token) return null

  // Lazy import: context.js is loaded on every boot path, and appConnections
  // pulls in jose + the DB. Only pay for it when a request actually presents
  // something app-token-shaped.
  const { resolveAccessToken, requiredScope, hasScope, checkRateLimit, touchInstallation } =
    await import('./appConnections.js')

  const install = await resolveAccessToken(token)
  if (!install) return null

  const url = new URL(req.url, 'http://localhost')
  // A null requirement means the endpoint needs no scope at all (the
  // connection-management routes - see requiredScope). Everything else must be
  // covered by what the user approved.
  const needed = requiredScope(req.method, url.pathname)
  if (needed && !hasScope(install.scopes, needed)) {
    return { appDenied: 'insufficient_scope', requiredScope: needed }
  }

  const kind = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write'
  const limit = await checkRateLimit(install.appId, install.subject, kind)
  if (!limit.allowed) {
    return { appDenied: 'rate_limited', retryAfter: limit.retryAfter }
  }

  touchInstallation(install.appId, install.subject).catch(() => {})

  const serverId = await getServerId()
  return {
    absUrl: ABS_URL,
    absToken: install.absApiKey,
    serverId,
    userId: install.absUserId,
    username: '',
    // An app NEVER inherits admin. Scopes are the ceiling and 'admin' as a scope
    // governs which HS routes it may call; the ctx role stays 'user' so nothing
    // downstream mistakes an app for a human administrator.
    role: 'user',
    app: {
      appId: install.appId,
      appName: install.appName,
      family: install.family,
      scopes: install.scopes,
    },
  }
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
      username: typeof me.username === 'string' ? me.username : '',
      role: me.type ?? 'user',
    }
  } catch {
    return null
  }
}

export function isAdmin(ctx) {
  return ctx?.role === 'admin' || ctx?.role === 'root'
}
