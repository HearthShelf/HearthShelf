// Hosted-mode OIDC setup: configure this server's ABS to trust the control
// plane's per-server Clerk OAuth client as its OIDC provider.
//
// This is the corrected, canonical hosted-auth path (see the WebApp repo's
// docs/hosted-oidc-design.md). At pairing the control plane provisions a
// DEDICATED Clerk OAuth client for this server. Here we pull that client's
// config (server-to-server, authenticated with our stored server secret) and
// write it into ABS via PATCH /api/auth-settings, so a hosted user logging in
// through app.hearthshelf.com is federated straight into ABS (matched by
// verified email) and gets an ABS-native token. No passwords stored.
//
// The control plane returns the client_secret ONCE; we apply it immediately and
// it is cleared on the control plane. If apply fails, re-pair to rotate.

import { getHostedConfig } from './hosted.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''

// The control plane lives at the issuer origin (it serves JWKS + the OIDC
// config pull there too). We reuse the stored issuer rather than a separate env.
function controlPlaneBase(cfg) {
  return (cfg.issuer || '').replace(/\/$/, '')
}

/**
 * Pull the OIDC client config for this server from the control plane.
 * Returns { issuer, authorization_url, token_url, userinfo_url, jwks_url,
 *           client_id, client_secret, redirect_uri, scopes } or throws.
 */
export async function fetchOidcConfig(serverId) {
  const cfg = await getHostedConfig()
  if (!cfg?.issuer || !cfg?.serverSecret) {
    throw new Error('not_paired: pair with app.hearthshelf.com first')
  }
  const base = controlPlaneBase(cfg)
  const res = await fetch(`${base}/servers/oidc-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server_id: serverId, server_secret: cfg.serverSecret }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = data?.detail || data?.error || `oidc-config ${res.status}`
    throw new Error(detail)
  }
  return data
}

/**
 * Write the OIDC config into ABS. Requires an ABS admin token (the one captured
 * at pairing). Sets local+openid active so the un/pw fallback still works, and
 * matches existing users by verified email with auto-register on. ABS strips
 * 'openid' from active methods if the config is incomplete, so we send the full
 * set in one PATCH. Field names verified against ABS 2.35.1.
 */
export async function applyOidcToAbs(adminToken, oidc) {
  if (!ABS_URL) throw new Error('ABS_SERVER_URL not set')
  if (!adminToken) throw new Error('no_abs_admin_token')

  const fields = {
    authOpenIDIssuerURL: oidc.issuer,
    authOpenIDAuthorizationURL: oidc.authorization_url,
    authOpenIDTokenURL: oidc.token_url,
    authOpenIDUserInfoURL: oidc.userinfo_url,
    authOpenIDJwksURL: oidc.jwks_url,
    authOpenIDClientID: oidc.client_id,
    authOpenIDClientSecret: oidc.client_secret,
    authOpenIDTokenSigningAlgorithm: 'RS256',
    authOpenIDButtonText: 'Sign in with HearthShelf',
    authOpenIDAutoLaunch: false,
    authOpenIDAutoRegister: true,
    authOpenIDMatchExistingBy: 'email',
    // Redirect callback lives at <origin>/auth/openid/callback (default subfolder).
    authOpenIDSubfolderForRedirectURLs: '',
  }

  // ABS caches the openid client and only REBUILDS it when authActiveAuthMethods
  // *transitions* (MiscController re-inits the strategy on use/unuse, not on a
  // field-only change). If openid was already active, a single PATCH persists the
  // new client_id/secret but ABS keeps serving the OLD cached client -> Clerk 401
  // at token exchange. So we PATCH in TWO steps to force a clean rebuild:
  //   1) write the new fields with openid OFF  -> unuse() drops the stale client
  //   2) turn openid ON                        -> use() rebuilds from the new creds
  await patchAuthSettings(adminToken, { ...fields, authActiveAuthMethods: ['local'] })
  await patchAuthSettings(adminToken, { ...fields, authActiveAuthMethods: ['local', 'openid'] })
  return true
}

async function patchAuthSettings(adminToken, body) {
  const res = await fetch(`${ABS_URL}/api/auth-settings`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`abs_auth_settings_failed ${res.status}: ${detail.slice(0, 200)}`)
  }
}

/**
 * Tell the control plane we've applied the OIDC config, so it clears the one-time
 * client_secret. Only called AFTER applyOidcToAbs succeeds - until then the pull
 * stays idempotent (the secret is re-pullable), so a failed apply never strands
 * the server. Best-effort: a failure here just means the secret isn't cleared yet
 * (harmless - it's cleared on the next successful apply confirm).
 */
async function confirmOidcApplied(serverId) {
  const cfg = await getHostedConfig()
  if (!cfg?.serverSecret) return
  try {
    await fetch(`${controlPlaneBase(cfg)}/servers/oidc-applied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: serverId, server_secret: cfg.serverSecret }),
    })
  } catch { /* best-effort */ }
}

/**
 * End-to-end: pull the per-server OIDC client from the control plane and apply
 * it to ABS, then confirm so the CP clears the one-time secret. Returns
 * { ok, issuer, clientId } on success.
 */
export async function configureHostedOidc(serverId, adminToken) {
  const oidc = await fetchOidcConfig(serverId)
  // Refuse to write a half-config: an empty client_secret would PATCH ABS into a
  // permanent Clerk 401 (and would mean the secret was already consumed upstream).
  if (!oidc.client_secret) {
    throw new Error('secret_consumed: re-pair to rotate the OIDC client secret')
  }
  await applyOidcToAbs(adminToken, oidc)
  await confirmOidcApplied(serverId) // clears the CP one-time secret now that ABS has it
  return { ok: true, issuer: oidc.issuer, clientId: oidc.client_id }
}
