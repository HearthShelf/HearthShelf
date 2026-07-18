// Hosted mode: trust app.hearthshelf.com to vouch for who the caller is, then
// act on ABS as that specific user.
//
// In self-hosted mode the caller proves identity by presenting an ABS bearer
// token directly (context.js validates it against ABS /api/me). In hosted mode
// the caller instead presents a short-lived GRANT issued by the control plane
// (the central app.hearthshelf.com Worker). The grant is a signed JWT that says
// "Clerk user X, verified email E, is linked to this server, role R". We verify
// that signature OFFLINE against the control plane's published keys (JWKS) - no
// callback, so this works even when the control plane is briefly down or this
// box is firewalled from it.
//
// A verified grant tells us the user's verified EMAIL, not an ABS token. ABS
// scopes all data per user, so we must turn that email into a per-user ABS
// credential. We do it the way ABS intends: holding an ABS admin token
// (configured at pairing time), we look the user up by email and mint a
// per-user ABS API key (POST /api/api-keys), which authenticates subsequent
// calls AS that user. The key is cached so we mint it once per user. No user
// passwords are ever stored.
//
// All trust config + the key cache live in the hosted_config / hosted_user_keys
// tables (see db.js). This module is only exercised when HS_MODE=hosted.

import crypto from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { db, initDb, getServerId } from '../db.js'
import { appLog } from './appLog.js'
import { getServiceToken } from './serviceCredential.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

// --- hosted config ---------------------------------------------------------

export async function getHostedConfig() {
  await ensure()
  const r = await db.execute('SELECT * FROM hosted_config WHERE id = 1')
  const row = r.rows[0]
  if (!row) return null
  return {
    issuer: row.issuer ?? null,
    jwksUrl: row.jwks_url ?? null,
    serverSecret: row.server_secret ?? null,
    absAdminToken: row.abs_admin_token ?? null,
    adminCredStatus: row.admin_cred_status ?? null,
  }
}

export async function setHostedConfig(patch) {
  await ensure()
  const cur = (await getHostedConfig()) || {}
  const next = {
    issuer: patch.issuer ?? cur.issuer ?? null,
    jwksUrl: patch.jwksUrl ?? cur.jwksUrl ?? null,
    serverSecret: patch.serverSecret ?? cur.serverSecret ?? null,
    absAdminToken: patch.absAdminToken ?? cur.absAdminToken ?? null,
    // Unlike the other fields, adminCredStatus is allowed to be set back to null
    // (meaning "unknown, re-check"), so honour an explicit patch value including
    // null; only fall back to the current value when the key is absent entirely.
    adminCredStatus:
      patch.adminCredStatus !== undefined ? patch.adminCredStatus : cur.adminCredStatus ?? null,
  }
  await db.execute({
    sql: `INSERT INTO hosted_config (id, issuer, jwks_url, server_secret, abs_admin_token, admin_cred_status, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            issuer = excluded.issuer,
            jwks_url = excluded.jwks_url,
            server_secret = excluded.server_secret,
            abs_admin_token = excluded.abs_admin_token,
            admin_cred_status = excluded.admin_cred_status,
            updated_at = excluded.updated_at`,
    args: [
      next.issuer,
      next.jwksUrl,
      next.serverSecret,
      next.absAdminToken,
      next.adminCredStatus,
      Date.now(),
    ],
  })
  return next
}

// Clear all hosted trust state - used by disconnect. After this the box no longer
// trusts the control plane or federates users (issuer/jwks/secret/admin token all
// null), effectively unpairing it. setHostedConfig can't null fields (it merges
// with ??), so disconnect needs this explicit reset.
export async function clearHostedConfig() {
  await ensure()
  await db.execute({
    sql: `INSERT INTO hosted_config (id, issuer, jwks_url, server_secret, abs_admin_token, admin_cred_status, updated_at)
          VALUES (1, NULL, NULL, NULL, NULL, NULL, ?)
          ON CONFLICT (id) DO UPDATE SET
            issuer = NULL, jwks_url = NULL, server_secret = NULL,
            abs_admin_token = NULL, admin_cred_status = NULL, updated_at = excluded.updated_at`,
    args: [Date.now()],
  })
}

// --- grant verification (offline, JWKS-cached) -----------------------------

// One JWKS set per jwks_url, reused across requests (jose caches the fetched
// keys internally and refreshes them as needed - this is the "pin + cache"
// behaviour: HS follows the control plane's key rotation without manual steps).
const jwksByUrl = new Map()
function jwksFor(url) {
  let set = jwksByUrl.get(url)
  if (!set) {
    set = createRemoteJWKSet(new URL(url))
    jwksByUrl.set(url, set)
  }
  return set
}

// Verify a control-plane grant. Returns the trusted claims, or null if the
// grant is missing/invalid/expired or hosted mode isn't configured.
export async function verifyGrant(token) {
  if (!token) return null
  const cfg = await getHostedConfig()
  if (!cfg?.jwksUrl || !cfg?.issuer) return null

  const serverId = await getServerId()
  try {
    const { payload } = await jwtVerify(token, jwksFor(cfg.jwksUrl), {
      issuer: cfg.issuer,
      audience: serverId, // grant must be minted FOR this server
    })
    // The grant is the gate: only a verified email may be federated, because
    // ABS user-matching keys on it.
    if (payload.email_verified !== true) return null
    if (typeof payload.email !== 'string' || !payload.email) return null
    if (typeof payload.sub !== 'string' || !payload.sub) return null
    return {
      subject: payload.sub,
      email: payload.email,
      username: typeof payload.username === 'string' ? payload.username : '',
      role: payload.role === 'admin' ? 'admin' : 'user',
    }
  } catch {
    return null
  }
}

// --- ABS per-user credential resolution ------------------------------------

// Look up the ABS user whose (case-insensitive) email matches, using the admin
// token. ABS has no by-email query endpoint, so we list and match.
async function findAbsUserByEmail(adminToken, email) {
  const res = await fetch(`${ABS_URL}/api/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  if (!res.ok) return null
  const data = await res.json()
  const users = Array.isArray(data) ? data : data?.users || []
  const want = email.toLowerCase()
  return users.find((u) => (u.email || '').toLowerCase() === want) || null
}

// Pre-provision an ABS user for an invited account that doesn't exist yet.
// ABS requires username + password on create, so we generate a strong temp
// password the user never sees (they sign in via app.hearthshelf.com; the temp
// just satisfies ABS and lets us mint their per-user key). If they later want a
// direct ABS login, that's the backup-password flow - separate from this.
// Username comes from Clerk; we fall back to the email local-part, and on a
// username collision retry with a short suffix. Returns the created user or null.
async function provisionAbsUser(adminToken, email, desiredUsername) {
  const base = (desiredUsername || email.split('@')[0] || 'user').trim() || 'user'
  const tempPassword = crypto.randomBytes(24).toString('base64url')

  for (let attempt = 0; attempt < 3; attempt++) {
    const username = attempt === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`
    const res = await fetch(`${ABS_URL}/api/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        email,
        password: tempPassword,
        type: 'user',
        isActive: true,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      // ABS returns the created user (shape has varied; accept common spellings).
      return data?.user || data || null
    }
    // 500/409-style "username taken" -> retry with a suffix; other errors -> bail.
    if (res.status !== 500 && res.status !== 409 && res.status !== 400) {
      // A 401 here means the stored admin credential is dead (stale/deleted) -
      // call it out explicitly so the admin can re-mint it, rather than reading
      // it as "this one user failed".
      const hint =
        res.status === 401
          ? ' - the saved admin credential is invalid; reset it under Connect'
          : ''
      appLog.warn('hosted', `provision failed for ${email}: ABS ${res.status}${hint}`)
      return null
    }
  }
  appLog.warn('hosted', `provision gave up for ${email}: username collisions`)
  return null
}

// Mint a per-user ABS API key (acts AS that user on every subsequent call).
// The raw key is only returned by ABS at creation, so we capture and cache it.
async function mintAbsApiKey(adminToken, absUserId) {
  const res = await fetch(`${ABS_URL}/api/api-keys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: `hearthshelf-app:${absUserId}`,
      userId: absUserId,
      isActive: true,
    }),
  })
  if (!res.ok) return null
  const data = await res.json()
  // ABS 2.35.1 returns { apiKey: { apiKey: "<JWT>", ... } } - the raw key STRING
  // is nested under apiKey.apiKey. The outer `apiKey` is an OBJECT, so check the
  // nested string FIRST (a bare `data.apiKey` would otherwise return the object).
  // ApiKeyController.create:97-102. Fall back to flatter shapes for older builds.
  const k =
    (typeof data?.apiKey === 'object' ? data.apiKey?.apiKey : data?.apiKey) || data?.key || null
  return typeof k === 'string' && k ? k : null
}

async function getCachedKey(serverId, subject) {
  const r = await db.execute({
    sql: `SELECT abs_user_id, abs_api_key, role, synced_username FROM hosted_user_keys
          WHERE server_id = ? AND cp_subject = ?`,
    args: [serverId, subject],
  })
  const row = r.rows[0]
  if (!row) return null
  return {
    absUserId: String(row.abs_user_id),
    absApiKey: String(row.abs_api_key),
    role: row.role,
    syncedUsername: row.synced_username ?? null,
  }
}

async function cacheKey(serverId, subject, email, absUserId, absApiKey, role, syncedUsername) {
  await db.execute({
    sql: `INSERT INTO hosted_user_keys
            (server_id, cp_subject, email, abs_user_id, abs_api_key, role, synced_username, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (server_id, cp_subject) DO UPDATE SET
            email = excluded.email,
            abs_user_id = excluded.abs_user_id,
            abs_api_key = excluded.abs_api_key,
            role = excluded.role,
            synced_username = excluded.synced_username`,
    args: [
      serverId,
      subject,
      email,
      absUserId,
      absApiKey,
      role,
      syncedUsername ?? null,
      Date.now(),
    ],
  })
}

// Record the latest synced username without touching the key/role.
async function updateSyncedUsername(serverId, subject, username) {
  await db.execute({
    sql: `UPDATE hosted_user_keys SET synced_username = ? WHERE server_id = ? AND cp_subject = ?`,
    args: [username, serverId, subject],
  })
}

// Reconcile the ABS username to the Clerk username. Best-effort: a collision or
// any ABS error must NOT break the user's access - we just log and carry on, and
// it will retry on the next request. ABS accepts the new name via PATCH
// /api/users/:id { username }. Returns the username that is now in effect.
async function syncUsername(adminToken, absUserId, desired, current) {
  if (!desired || desired === current) return current
  try {
    const res = await fetch(`${ABS_URL}/api/users/${absUserId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: desired }),
    })
    if (!res.ok) {
      appLog.warn('hosted', `username sync skipped for ${absUserId}: ABS returned ${res.status}`)
      return current
    }
    return desired
  } catch (err) {
    appLog.warn('hosted', `username sync failed for ${absUserId}: ${String(err).slice(0, 120)}`)
    return current
  }
}

// The ABS user ids that have signed in via app.hearthshelf.com on this server,
// i.e. have a cached per-user key in hosted_user_keys. Used by the admin Users
// UI to show "linked to hs.com" - purely local, no control-plane call.
export async function getLinkedAbsUserIds(serverId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT abs_user_id, email FROM hosted_user_keys WHERE server_id = ?`,
    args: [serverId],
  })
  return r.rows.map((row) => ({ absUserId: String(row.abs_user_id), email: String(row.email) }))
}

// Resolve a verified grant into the standard ctx the rest of the backend uses:
//   { absUrl, absToken, serverId, userId, username, role }
// absToken is a per-user ABS API key (minted once, cached). username is the
// caller's ABS username (the Clerk username kept in sync, falling back to the
// last synced/cached value) so notes/clubs can snapshot it at write time.
// Returns null if the user can't be matched or a key can't be obtained.
export async function resolveHostedContext(token) {
  const claims = await verifyGrant(token)
  if (!claims) return null
  if (!ABS_URL) return null

  const serverId = await getServerId()

  // Fast path: cached per-user key. Reconcile the username only when the grant's
  // Clerk username differs from what we last pushed (avoids an ABS write per
  // request); on success record the new value. Username sync is best-effort, so
  // we only resolve an admin token for it lazily and skip silently if none.
  const cached = await getCachedKey(serverId, claims.subject)
  if (cached) {
    if (claims.username && claims.username !== cached.syncedUsername) {
      const adminToken = await getServiceToken()
      if (adminToken) {
        const now = await syncUsername(
          adminToken,
          cached.absUserId,
          claims.username,
          cached.syncedUsername,
        )
        if (now === claims.username)
          await updateSyncedUsername(serverId, claims.subject, claims.username)
      }
    }
    return {
      absUrl: ABS_URL,
      absToken: cached.absApiKey,
      serverId,
      userId: cached.absUserId,
      username: claims.username || cached.syncedUsername || '',
      role: claims.role || cached.role || 'user',
    }
  }

  // Cold path: this is where a new invitee is provisioned, so it MUST have a
  // working admin credential. getServiceToken self-heals a stale one (re-mints a
  // durable API key from the service account); if it returns null the credential
  // is broken and needs an operator reset - fail cleanly rather than 401-looping.
  const adminToken = await getServiceToken()
  if (!adminToken) return null

  // Match the ABS user by verified email; if none exists yet (an invited account
  // onboarding for the first time), pre-provision one. Then mint + cache a key
  // and bring the ABS username in line with Clerk's.
  let absUser = await findAbsUserByEmail(adminToken, claims.email)
  let provisioned = false
  if (!absUser?.id) {
    absUser = await provisionAbsUser(adminToken, claims.email, claims.username)
    provisioned = true
  }
  if (!absUser?.id) return null
  const apiKey = await mintAbsApiKey(adminToken, absUser.id)
  if (!apiKey) return null
  // A freshly provisioned user already carries the Clerk username; an existing
  // matched user may need reconciling.
  const effectiveUsername = provisioned
    ? absUser.username || claims.username || ''
    : await syncUsername(adminToken, absUser.id, claims.username, absUser.username || '')
  await cacheKey(
    serverId,
    claims.subject,
    claims.email,
    absUser.id,
    apiKey,
    claims.role,
    effectiveUsername,
  )

  return {
    absUrl: ABS_URL,
    absToken: apiKey,
    serverId,
    userId: String(absUser.id),
    username: effectiveUsername || claims.username || '',
    role: claims.role || 'user',
  }
}
