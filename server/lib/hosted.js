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
import { jwtVerify } from 'jose'
import { db, initDb, getServerId } from '../db.js'
import { appLog } from './appLog.js'
import { getServiceToken } from './serviceCredential.js'
import { resolveJwks, JWKS_STALE_EXPIRED } from './jwksCache.js'
import { isKeyRevoked } from './keyRevocation.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''

/**
 * How often to re-verify a cached per-user ABS key against ABS (12h).
 *
 * A tradeoff: too eager and every request pays an ABS round-trip (defeating the
 * cache); too lax and a revoked key keeps working for longer than it should.
 * 12h keeps the steady state free while bounding how long a revoked user retains
 * access - and any 401 the client surfaces will re-connect anyway.
 */
const CACHED_KEY_RECHECK_MS = 12 * 60 * 60 * 1000

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
  try {
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
  } catch (err) {
    // The admin_cred_status column is added by a migration; on a box where that
    // migration hasn't landed yet (partial deploy, older image), writing it
    // throws "no such column". The status marker is cosmetic - the credential
    // itself (abs_admin_token) is what matters - so fall back to a write WITHOUT
    // that column rather than lose a freshly minted key. This keeps the Reset /
    // recovery flow working even before the migration runs.
    if (String(err?.message || err).includes('admin_cred_status')) {
      await db.execute({
        sql: `INSERT INTO hosted_config (id, issuer, jwks_url, server_secret, abs_admin_token, updated_at)
              VALUES (1, ?, ?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET
                issuer = excluded.issuer,
                jwks_url = excluded.jwks_url,
                server_secret = excluded.server_secret,
                abs_admin_token = excluded.abs_admin_token,
                updated_at = excluded.updated_at`,
        args: [next.issuer, next.jwksUrl, next.serverSecret, next.absAdminToken, Date.now()],
      })
    } else {
      throw err
    }
  }
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

// --- grant verification (offline, JWKS pinned to disk) ---------------------

// Verification failure reasons. These MUST stay distinguishable: "I could not
// check this grant" and "this grant is forged" look identical to a caller that
// only sees null, which is exactly how the cold-boot outage stayed invisible - a
// CP-unreachable restart made every hosted-mode request answer 401, reading as a
// rejected sign-in. The connect route maps the transient reasons to 503 so a
// client retries instead of sending the user to re-authenticate.
export const GRANT_ERR_INVALID = 'grant_invalid'
export const GRANT_ERR_NOT_PAIRED = 'not_paired'
export const GRANT_ERR_KEYS_UNAVAILABLE = 'keys_unavailable'
export const GRANT_ERR_KEYS_EXPIRED = 'keys_expired'
export const GRANT_ERR_KEY_REVOKED = 'key_revoked'

/** True for reasons that are OUR problem, not the caller's - safe to retry. */
export function isTransientGrantError(reason) {
  return reason === GRANT_ERR_KEYS_UNAVAILABLE || reason === GRANT_ERR_KEYS_EXPIRED
}

/**
 * Verify a control-plane grant.
 *
 * Returns { ok: true, claims } or { ok: false, reason }.
 *
 * Keys come from jwksCache.js, which pins them to the config volume, so this is
 * genuinely offline after pairing - no network on the request path. Previously
 * the only cache was jose's in-process one, so a restart while the control plane
 * was unreachable broke ALL request serving in hosted mode.
 */
export async function verifyGrantDetailed(token) {
  if (!token) return { ok: false, reason: GRANT_ERR_INVALID }
  const cfg = await getHostedConfig()
  if (!cfg?.jwksUrl || !cfg?.issuer) return { ok: false, reason: GRANT_ERR_NOT_PAIRED }

  const { status, keySet } = await resolveJwks(cfg.jwksUrl)
  if (status === JWKS_STALE_EXPIRED) return { ok: false, reason: GRANT_ERR_KEYS_EXPIRED }
  if (!keySet) return { ok: false, reason: GRANT_ERR_KEYS_UNAVAILABLE }

  const serverId = await getServerId()
  let payload
  let protectedHeader
  try {
    const verified = await jwtVerify(token, keySet, {
      issuer: cfg.issuer,
      audience: serverId, // grant must be minted FOR this server
    })
    payload = verified.payload
    protectedHeader = verified.protectedHeader
  } catch (err) {
    // A signature/claim failure is the caller's problem; a failure reaching a
    // remote key set is ours. Separate them so a transient outage is never
    // reported as a forged grant.
    const name = String(err?.code || err?.name || '')
    if (name.includes('JWKS') || name.includes('Fetch') || name.includes('Timeout')) {
      return { ok: false, reason: GRANT_ERR_KEYS_UNAVAILABLE }
    }
    return { ok: false, reason: GRANT_ERR_INVALID }
  }

  // Signature is proven, so the `kid` in the header is authentic and safe to
  // judge. Checking it before verification would let a caller name any kid.
  if (await isKeyRevoked(protectedHeader?.kid, payload.key_gen)) {
    return { ok: false, reason: GRANT_ERR_KEY_REVOKED }
  }

  // The grant is the gate: only a verified email may be federated, because ABS
  // user-matching keys on it.
  if (payload.email_verified !== true) return { ok: false, reason: GRANT_ERR_INVALID }
  if (typeof payload.email !== 'string' || !payload.email)
    return { ok: false, reason: GRANT_ERR_INVALID }
  if (typeof payload.sub !== 'string' || !payload.sub)
    return { ok: false, reason: GRANT_ERR_INVALID }

  return {
    ok: true,
    claims: {
      subject: payload.sub,
      email: payload.email,
      username: typeof payload.username === 'string' ? payload.username : '',
      role: payload.role === 'admin' ? 'admin' : 'user',
    },
  }
}

// Back-compat wrapper: most callers only need claims-or-null.
export async function verifyGrant(token) {
  const r = await verifyGrantDetailed(token)
  return r.ok ? r.claims : null
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
  // last_checked_at is added by a migration; select it defensively so a box that
  // hasn't migrated yet still resolves keys (it just re-checks more often).
  let r
  try {
    r = await db.execute({
      sql: `SELECT abs_user_id, abs_api_key, role, synced_username, last_checked_at, created_at
            FROM hosted_user_keys WHERE server_id = ? AND cp_subject = ?`,
      args: [serverId, subject],
    })
  } catch {
    r = await db.execute({
      sql: `SELECT abs_user_id, abs_api_key, role, synced_username, created_at
            FROM hosted_user_keys WHERE server_id = ? AND cp_subject = ?`,
      args: [serverId, subject],
    })
  }
  const row = r.rows[0]
  if (!row) return null
  return {
    absUserId: String(row.abs_user_id),
    absApiKey: String(row.abs_api_key),
    role: row.role,
    syncedUsername: row.synced_username ?? null,
    lastCheckedAt: Number(row.last_checked_at ?? row.created_at ?? 0) || 0,
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

// Drop a cached per-user key that ABS no longer accepts, so the next request
// takes the cold path and mints a fresh one.
//
// Without this, an invalidated key is a PERMANENT lockout: the fast path returned
// the cached value unconditionally, so once ABS stopped honouring it (expiry,
// admin revocation, ABS-side key purge) every request failed forever and the only
// recovery was deleting the ABS user. The admin credential already self-heals
// this way via getServiceToken(); this is the missing per-user equivalent.
async function forgetCachedKey(serverId, subject) {
  await db.execute({
    sql: `DELETE FROM hosted_user_keys WHERE server_id = ? AND cp_subject = ?`,
    args: [serverId, subject],
  })
}

/**
 * Is this per-user ABS key still accepted by ABS?
 *
 * Cheap authenticated probe against /api/me. Only called when the cached row
 * looks due for a check (see CACHED_KEY_RECHECK_MS) - not on every request,
 * which would put an ABS round-trip in front of all traffic and undo the whole
 * point of the cache.
 *
 * Returns true (assume good) on a NETWORK failure: if ABS is unreachable we
 * cannot conclude the key is bad, and discarding a probably-valid credential
 * because ABS blipped would be a self-inflicted outage. Only an explicit
 * 401/403 counts as invalid.
 */
async function absKeyStillValid(absApiKey) {
  try {
    const res = await fetch(`${ABS_URL}/api/me`, {
      headers: { Authorization: `Bearer ${absApiKey}` },
      signal: AbortSignal.timeout(5000),
    })
    if (res.status === 401 || res.status === 403) return false
    return true
  } catch {
    return true // inconclusive - do not throw away a working key
  }
}

// Record when we last confirmed a cached key works.
async function markKeyChecked(serverId, subject) {
  try {
    await db.execute({
      sql: `UPDATE hosted_user_keys SET last_checked_at = ? WHERE server_id = ? AND cp_subject = ?`,
      args: [Date.now(), serverId, subject],
    })
  } catch {
    // Column added by migration; a pre-migration box just re-checks more often.
  }
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

// Drop the cached per-user key for a removed ABS user. Without this the stale
// key survives their deletion, and a re-invite would reuse a row pointing at an
// ABS user id that no longer exists.
export async function forgetHostedUserByAbsId(serverId, absUserId) {
  await ensure()
  await db.execute({
    sql: `DELETE FROM hosted_user_keys WHERE server_id = ? AND abs_user_id = ?`,
    args: [serverId, String(absUserId)],
  })
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
  let cached = await getCachedKey(serverId, claims.subject)

  // Periodically confirm the cached key still works. ABS keys can be revoked or
  // expire out from under us, and the fast path used to return them forever - a
  // permanent lockout with no recovery short of deleting the ABS user. Re-check
  // at most once per CACHED_KEY_RECHECK_MS so this stays off the hot path.
  if (cached && Date.now() - cached.lastCheckedAt > CACHED_KEY_RECHECK_MS) {
    if (await absKeyStillValid(cached.absApiKey)) {
      await markKeyChecked(serverId, claims.subject)
    } else {
      appLog.warn(
        'hosted',
        `cached ABS key for user ${cached.absUserId} was rejected; re-minting`,
      )
      await forgetCachedKey(serverId, claims.subject)
      cached = null // fall through to the cold path, which mints a fresh key
    }
  }

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
