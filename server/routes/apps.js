// Third-party app connections - the box's endpoints. Mounted under /hs/apps/*.
//
// This is the half that matters at runtime. The control plane introduces an app
// once; from then on the app talks only to here, which is what makes revocation
// immediate and lets a connection survive the control plane being unreachable.
//
//   POST   /hs/apps/introduce   - redeem a CP introduction token (app-facing)
//   POST   /hs/apps/token       - refresh -> access token (app-facing)
//   POST   /hs/apps/revoke      - CP-forwarded revocation (CP-facing)
//   GET    /hs/apps/me          - who am I, as an app (app-facing)
//   GET    /hs/apps             - Connected Apps admin view (admin-only)
//   DELETE /hs/apps/:appId/:sub - revoke locally (admin-only)
//
// The admin endpoints deliberately work WITHOUT the control plane: an admin who
// wants to cut off a misbehaving app must be able to do it from the box itself,
// including when the box has no internet.

import { json, readBody } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { resolveHostedContext, getHostedConfig } from '../lib/hosted.js'
import {
  APP_SCOPES,
  verifyIntroduction,
  createInstallation,
  refreshInstallation,
  revokeInstallation,
  listInstallations,
  resolveAccessToken,
} from '../lib/appConnections.js'

function bearer(req) {
  const h = req.headers?.authorization
  if (typeof h !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1] : null
}

export async function handleApps(req, res, url, ctx) {
  const p = url.pathname

  // --- RFC 9728 protected-resource metadata -------------------------------
  //
  // The discovery entry point, and what makes this framework generic rather than
  // a HearthShelf-specific integration: an app pointed at ANY box learns where to
  // authorize without knowing anything about us in advance. Same mechanism MCP
  // clients use to find an authorization server.
  //
  // Unauthenticated by design (a client must be able to read it before it has
  // any credential), and it discloses nothing about users, libraries, or content
  // - only where to go and what may be asked for.
  if (p === '/.well-known/oauth-protected-resource') {
    const cfg = await getHostedConfig()
    const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || ''}`
    return (
      json(res, 200, {
        resource: origin,
        // Absent until the box is paired: an unpaired box has no authorization
        // server to name, and inventing one would send apps somewhere useless.
        ...(cfg?.issuer ? { authorization_servers: [cfg.issuer] } : {}),
        scopes_supported: APP_SCOPES,
        bearer_methods_supported: ['header'],
        resource_documentation: 'https://docs.hearthshelf.com/apps',
      }),
      true
    )
  }

  if (!p.startsWith('/hs/apps')) return false

  // --- introduce: redeem a control-plane introduction token ---------------
  //
  // The app arrives holding a token the CP minted after its user consented. We
  // verify it on the SAME trust path as a browser grant (pinned JWKS, this
  // server as the audience), then resolve the ABS identity the app will act as -
  // through resolveHostedContext, so the app is bound to the authorizing user
  // and can never exceed them.
  if (p === '/hs/apps/introduce' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const introToken = String(body?.introduction_token || '')
    if (!introToken) return (json(res, 400, { error: 'missing_token' }), true)

    const verified = await verifyIntroduction(introToken)
    if (!verified.ok) {
      const status = verified.reason === 'not_paired' ? 409 : 401
      return (json(res, status, { error: verified.reason }), true)
    }
    const claims = verified.claims

    // Resolve (and if needed provision) the ABS user this app acts for, reusing
    // the hosted path so an app gets exactly the identity a browser session for
    // the same person would get - no more.
    const hosted = await resolveHostedContext(introToken)
    if (!hosted?.absToken) {
      return (json(res, 502, { error: 'abs_unreachable' }), true)
    }

    const issued = await createInstallation({
      appId: claims.appId,
      appName: claims.appName,
      appKind: claims.appKind,
      family: claims.family,
      subject: claims.subject,
      scopes: claims.scopes,
      absUserId: hosted.userId,
      absApiKey: hosted.absToken,
    })

    return (
      json(res, 200, {
        access_token: issued.access,
        refresh_token: issued.refresh,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        scope: issued.scopes.join(' '),
      }),
      true
    )
  }

  // --- token: rotate a refresh token --------------------------------------
  if (p === '/hs/apps/token' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const appId = String(body?.app_id || '')
    const refresh = String(body?.refresh_token || '')
    if (!appId || !refresh) return (json(res, 400, { error: 'invalid_request' }), true)

    const out = await refreshInstallation(appId, refresh)
    if (!out.ok) {
      // token_replayed is deliberately reported as invalid_grant: the app learns
      // it must reconnect, and a thief learns nothing about why.
      return (json(res, 401, { error: 'invalid_grant' }), true)
    }
    return (
      json(res, 200, {
        access_token: out.access,
        // Null on a benign in-grace retry - the app keeps the token it has.
        ...(out.refresh ? { refresh_token: out.refresh } : {}),
        token_type: 'Bearer',
        expires_in: out.expiresIn,
        scope: out.scopes.join(' '),
      }),
      true
    )
  }

  // --- revoke: forwarded by the control plane -----------------------------
  //
  // Authenticated by the same CP signature as an introduction: only the control
  // plane can mint one, so only it can drive this. The box remains able to
  // revoke locally without the CP (see the admin endpoint below) - this path
  // exists so a revoke started in the hosted UI reaches the box that holds the
  // credential.
  if (p === '/hs/apps/revoke' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const revToken = String(body?.revocation_token || '')
    const verified = await verifyIntroduction(revToken)
    if (!verified.ok) return (json(res, 401, { error: verified.reason }), true)

    await revokeInstallation(verified.claims.appId, verified.claims.subject)
    return (json(res, 200, { ok: true }), true)
  }

  // --- me: the app's own view of its connection ---------------------------
  if (p === '/hs/apps/me' && req.method === 'GET') {
    const install = await resolveAccessToken(bearer(req))
    if (!install) return (json(res, 401, { error: 'invalid_token' }), true)
    return (
      json(res, 200, {
        app_id: install.appId,
        app_name: install.appName,
        family: install.family,
        scopes: install.scopes,
        abs_user_id: install.absUserId,
      }),
      true
    )
  }

  // --- admin: Connected Apps ----------------------------------------------
  if (p === '/hs/apps' && req.method === 'GET') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    return (json(res, 200, { installations: await listInstallations() }), true)
  }

  const m = /^\/hs\/apps\/([^/]+)\/([^/]+)$/.exec(p)
  if (m && req.method === 'DELETE') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    await revokeInstallation(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
    return (json(res, 200, { ok: true }), true)
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
