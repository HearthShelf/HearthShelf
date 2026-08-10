// Third-party app connections - the box's half, and the authoritative one.
//
// WHAT THIS OWNS. The control plane verifies who a Clerk user is and that they
// consented, then hands the app a single-use INTRODUCTION token. Everything from
// that moment on lives here: the app's refresh token, its access tokens, its
// scopes, and its revocation. Two properties fall out of that split and both are
// the reason for it:
//
//   * Revocation is IMMEDIATE. Revoking deletes the row the token resolves
//     against, and this box is the thing being asked - so the app's very next
//     request fails. There is no cloud TTL to wait out.
//   * An established connection survives the control plane being unreachable.
//     A LAN app talking to a LAN box should not need the internet, which is the
//     same principle behind the pinned JWKS and the LAN address path.
//
// THE TRAP TO NOT FALL INTO. A scope is a CEILING, never a grant. An app
// authorized for 'library:write' by a user who cannot delete must not be able to
// delete. Only this box knows the user's real ABS permissions, so the
// intersection has to happen here - and it happens where the ABS credential is
// resolved (resolveAppContext), NOT per-route, because a per-route check is
// exactly what the next route someone adds will forget.

import crypto from 'node:crypto'
import { jwtVerify } from 'jose'
import { db, initDb, getServerId } from '../db.js'
import { getHostedConfig } from './hosted.js'
import { resolveJwks } from './jwksCache.js'
import { appLog } from './appLog.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

/** Access-token lifetime. Short: an app refreshes, and short means a revoked
 *  app's in-flight token dies quickly even though the refresh already failed. */
const ACCESS_TTL_MS = 15 * 60 * 1000
/** How long a just-rotated refresh token stays usable. Covers an app that
 *  exchanged, crashed before persisting, and retried - a legitimate retry that
 *  would otherwise look identical to a replay. */
const PREV_GRACE_MS = 2 * 60 * 1000

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex')
const token = () => crypto.randomBytes(32).toString('base64url')

// --- scopes ----------------------------------------------------------------

export const APP_SCOPES = [
  'library:read',
  'library:write',
  'progress:read',
  'progress:write',
  'admin',
]

export function parseScopes(raw) {
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/)
  return list.map((s) => String(s).trim()).filter((s) => APP_SCOPES.includes(s))
}

export function hasScope(scopes, wanted) {
  return scopes.includes(wanted) || scopes.includes('admin')
}

/**
 * Which scope does an HTTP request need?
 *
 * Deliberately coarse and deny-by-default: an unrecognised path requires
 * 'admin', so a route added later is refused for ordinary apps until someone
 * classifies it. The failure mode of guessing wrong here is an app silently
 * gaining access it was never granted, so the default must be the strict one.
 */
export function requiredScope(method, pathname) {
  const write = method !== 'GET' && method !== 'HEAD'
  const p = pathname

  // The connection-management endpoints themselves. An app must be able to ask
  // who it is and to refresh, whatever scopes it holds - gating these behind a
  // scope would mean an app with only 'library:read' got a 403 from its OWN
  // identity endpoint, and (worse) could never refresh its way out of it.
  //
  // This is not a hole: /introduce and /token authenticate with a
  // control-plane introduction token or a refresh token rather than an access
  // token, /me only reflects the caller's own installation back at it, and
  // /revoke only ever REMOVES access. None of them read or write library data.
  if (
    p === '/hs/apps/introduce' ||
    p === '/hs/apps/token' ||
    p === '/hs/apps/me' ||
    p === '/hs/apps/revoke' ||
    p === '/.well-known/oauth-protected-resource'
  ) {
    return null
  }

  // Listening progress and sessions.
  if (
    p.startsWith('/api/me/progress') ||
    p.startsWith('/api/session') ||
    p.startsWith('/api/sessions') ||
    p.includes('/progress')
  ) {
    return write ? 'progress:write' : 'progress:read'
  }

  // Library content: items, libraries, series, authors, collections, playlists,
  // plus the HearthShelf-native reads that are library data by another name.
  if (
    p.startsWith('/api/items') ||
    p.startsWith('/api/libraries') ||
    p.startsWith('/api/series') ||
    p.startsWith('/api/authors') ||
    p.startsWith('/api/collections') ||
    p.startsWith('/api/playlists') ||
    p.startsWith('/api/search') ||
    p.startsWith('/api/me') ||
    p.startsWith('/hs/narrators') ||
    p.startsWith('/hs/stats') ||
    p.startsWith('/hs/finished-books')
  ) {
    return write ? 'library:write' : 'library:read'
  }

  return 'admin'
}

// --- introduction ----------------------------------------------------------

/**
 * Verify a control-plane introduction token.
 *
 * Same trust path as a user grant - pinned JWKS, this server's id as the
 * audience - plus two extra requirements:
 *
 *   typ === 'app_introduction'  so a user grant and an app introduction are not
 *     interchangeable. Without this an app introduction would verify anywhere a
 *     browser grant does, and vice versa.
 *   jti single-use             so an intercepted introduction cannot be replayed
 *     into a second installation.
 */
export async function verifyIntroduction(introToken) {
  if (!introToken) return { ok: false, reason: 'invalid_token' }
  const cfg = await getHostedConfig()
  if (!cfg?.jwksUrl || !cfg?.issuer) return { ok: false, reason: 'not_paired' }

  const { keySet } = await resolveJwks(cfg.jwksUrl)
  if (!keySet) return { ok: false, reason: 'keys_unavailable' }

  const serverId = await getServerId()
  let payload
  try {
    const verified = await jwtVerify(introToken, keySet, {
      issuer: cfg.issuer,
      audience: serverId,
    })
    payload = verified.payload
  } catch {
    return { ok: false, reason: 'invalid_token' }
  }

  if (payload.typ !== 'app_introduction') return { ok: false, reason: 'wrong_token_type' }
  if (payload.email_verified !== true) return { ok: false, reason: 'invalid_token' }
  if (typeof payload.sub !== 'string' || !payload.sub) return { ok: false, reason: 'invalid_token' }
  if (typeof payload.app_id !== 'string' || !payload.app_id) {
    return { ok: false, reason: 'invalid_token' }
  }

  if (payload.jti) {
    const spent = await isJtiSpent(payload.jti)
    if (spent) return { ok: false, reason: 'token_replayed' }
    await spendJti(payload.jti, Number(payload.exp || 0) * 1000)
  }

  return {
    ok: true,
    claims: {
      subject: payload.sub,
      email: payload.email,
      username: typeof payload.username === 'string' ? payload.username : '',
      role: payload.role === 'admin' ? 'admin' : 'user',
      appId: payload.app_id,
      appName: typeof payload.app_name === 'string' ? payload.app_name : '',
      appKind: payload.app_kind === 'cloud' ? 'cloud' : 'instance',
      family: typeof payload.app_family === 'string' ? payload.app_family : null,
      scopes: parseScopes(payload.scopes),
    },
  }
}

async function isJtiSpent(jti) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT jti FROM app_intro_jtis WHERE jti = ?`,
    args: [String(jti)],
  })
  return r.rows.length > 0
}

async function spendJti(jti, expiresAt) {
  await ensure()
  await db.execute({
    sql: `INSERT OR IGNORE INTO app_intro_jtis (jti, expires_at) VALUES (?, ?)`,
    args: [String(jti), expiresAt || Date.now() + 600_000],
  })
  // Opportunistic sweep - a jti only has to outlive the window in which its
  // token would still verify.
  await db.execute({ sql: `DELETE FROM app_intro_jtis WHERE expires_at < ?`, args: [Date.now()] })
}

// --- installations ---------------------------------------------------------

/**
 * Create (or refresh) an installation and issue the app's first token pair.
 *
 * `absUserId` / `absApiKey` come from the caller, which resolved them through
 * the SAME path a browser session uses. That is what guarantees an app can never
 * exceed the person who authorized it: it acts as them, not as the server.
 *
 * Re-introduction updates in place rather than duplicating, so reconnecting an
 * app does not leave a second dead installation behind.
 */
export async function createInstallation({
  appId,
  appName,
  appKind,
  family,
  subject,
  scopes,
  absUserId,
  absApiKey,
}) {
  await ensure()
  const serverId = await getServerId()
  const refresh = token()
  const at = Date.now()

  await db.execute({
    sql: `INSERT INTO app_installations
            (server_id, app_id, cp_subject, app_name, app_kind, app_family, scopes,
             abs_user_id, abs_api_key, refresh_hash, prev_hash, prev_expires_at,
             created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
          ON CONFLICT (server_id, app_id, cp_subject) DO UPDATE SET
            app_name = excluded.app_name,
            app_kind = excluded.app_kind,
            app_family = excluded.app_family,
            scopes = excluded.scopes,
            abs_user_id = excluded.abs_user_id,
            abs_api_key = excluded.abs_api_key,
            refresh_hash = excluded.refresh_hash,
            prev_hash = NULL,
            prev_expires_at = NULL,
            last_used_at = excluded.last_used_at`,
    args: [
      serverId,
      appId,
      subject,
      appName || '',
      appKind || 'instance',
      family,
      scopes.join(' '),
      String(absUserId),
      absApiKey,
      sha256(refresh),
      at,
      at,
    ],
  })

  appLog.info('app-connections', `connected ${appName || appId} for ${subject} (${scopes.join(' ') || 'no scopes'})`)
  return { refresh, ...(await issueAccess(appId, subject, scopes)) }
}

/**
 * Exchange a refresh token for a new pair. ROTATION with REUSE DETECTION, which
 * OAuth 2.1 requires and which is the whole value of rotation:
 *
 *   - a successful exchange retires the presented token and issues a new one;
 *   - presenting an ALREADY-RETIRED token (outside the grace window) means the
 *     token leaked - either the app's storage or the token in flight - so the
 *     entire installation is revoked rather than served.
 *
 * The grace window is what keeps that from being hair-trigger: an app that
 * exchanged, crashed before persisting, and retried is indistinguishable from a
 * replay except in timing, and disconnecting a working integration over a crash
 * would be its own bug.
 */
export async function refreshInstallation(appId, presentedRefresh) {
  await ensure()
  const serverId = await getServerId()
  const presented = sha256(presentedRefresh)

  const r = await db.execute({
    sql: `SELECT * FROM app_installations WHERE server_id = ? AND app_id = ?`,
    args: [serverId, appId],
  })

  const row = r.rows.find(
    (x) =>
      String(x.refresh_hash) === presented ||
      (x.prev_hash && String(x.prev_hash) === presented),
  )
  if (!row) return { ok: false, reason: 'invalid_grant' }

  // The retired-token path. Inside the grace window it is a benign retry; past
  // it, treat it as compromise and cut the connection entirely.
  if (String(row.refresh_hash) !== presented) {
    const graceOk = row.prev_expires_at && Number(row.prev_expires_at) > Date.now()
    if (!graceOk) {
      await revokeInstallation(appId, String(row.cp_subject))
      appLog.warn('app-connections', `refresh token replayed for ${appId} - installation revoked`)
      return { ok: false, reason: 'token_replayed' }
    }
    // Benign retry: re-issue against the CURRENT token without rotating again.
    const scopes = parseScopes(row.scopes)
    return {
      ok: true,
      refresh: null,
      absApiKey: String(row.abs_api_key),
      ...(await issueAccess(appId, String(row.cp_subject), scopes)),
    }
  }

  const next = token()
  const at = Date.now()
  await db.execute({
    sql: `UPDATE app_installations
          SET refresh_hash = ?, prev_hash = ?, prev_expires_at = ?, last_used_at = ?
          WHERE server_id = ? AND app_id = ? AND cp_subject = ?`,
    args: [sha256(next), presented, at + PREV_GRACE_MS, at, serverId, appId, row.cp_subject],
  })

  const scopes = parseScopes(row.scopes)
  return {
    ok: true,
    refresh: next,
    // Re-issued every refresh so an app that lost the ABS key, or whose key was
    // re-minted box-side, self-heals without the user reconnecting.
    absApiKey: String(row.abs_api_key),
    ...(await issueAccess(appId, String(row.cp_subject), scopes)),
  }
}

/**
 * Mint an access token.
 *
 * Deliberately an opaque handle over an HMAC of the installation identity rather
 * than a self-contained JWT: a JWT would remain valid until expiry even after
 * revocation, which would give back exactly the bounded-revocation problem this
 * whole design moved to the box to avoid. This resolves against the row, so a
 * deleted row means an immediately dead token.
 */
async function issueAccess(appId, subject, scopes) {
  const expiresAt = Date.now() + ACCESS_TTL_MS
  const payload = `${appId}.${subject}.${expiresAt}`
  const mac = crypto
    .createHmac('sha256', await accessSecret())
    .update(payload)
    .digest('base64url')
  return {
    access: `${Buffer.from(payload).toString('base64url')}.${mac}`,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
    scopes,
  }
}

/** Per-box HMAC key for access tokens, derived from the server's own identity so
 *  it needs no separate secret and rotates with a rebuild. */
let cachedSecret = null
async function accessSecret() {
  if (cachedSecret) return cachedSecret
  const serverId = await getServerId()
  const cfg = await getHostedConfig()
  cachedSecret = crypto
    .createHash('sha256')
    .update(`app-access:${serverId}:${cfg?.serverSecret || 'local'}`)
    .digest()
  return cachedSecret
}

/**
 * Resolve an access token to a live installation.
 *
 * Returns null for anything not currently valid - including a revoked
 * installation, because the row lookup is what makes revocation immediate.
 */
export async function resolveAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') return null
  const [body, mac] = accessToken.split('.')
  if (!body || !mac) return null

  let payload
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const expected = crypto
    .createHmac('sha256', await accessSecret())
    .update(payload)
    .digest('base64url')
  // Constant-time compare so a forged token cannot be tuned byte by byte.
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  const [appId, subject, expiresAt] = payload.split('.')
  if (!appId || !subject || Number(expiresAt) < Date.now()) return null

  await ensure()
  const serverId = await getServerId()
  const r = await db.execute({
    sql: `SELECT * FROM app_installations
          WHERE server_id = ? AND app_id = ? AND cp_subject = ?`,
    args: [serverId, appId, subject],
  })
  const row = r.rows[0]
  if (!row) return null // revoked - immediate, by construction

  return {
    appId,
    subject,
    appName: String(row.app_name || ''),
    family: row.app_family ? String(row.app_family) : null,
    scopes: parseScopes(row.scopes),
    absUserId: String(row.abs_user_id),
    absApiKey: String(row.abs_api_key),
  }
}

export async function touchInstallation(appId, subject) {
  await ensure()
  const serverId = await getServerId()
  await db.execute({
    sql: `UPDATE app_installations SET last_used_at = ?
          WHERE server_id = ? AND app_id = ? AND cp_subject = ?`,
    args: [Date.now(), serverId, appId, subject],
  })
}

/** Revoke. Immediate by construction: the row an access token resolves against
 *  is gone, so the next request fails - no TTL, and no control plane needed. */
export async function revokeInstallation(appId, subject) {
  await ensure()
  const serverId = await getServerId()
  await db.execute({
    sql: `DELETE FROM app_installations WHERE server_id = ? AND app_id = ? AND cp_subject = ?`,
    args: [serverId, appId, subject],
  })
  await db.execute({
    sql: `DELETE FROM app_rate_buckets WHERE server_id = ? AND app_id = ? AND cp_subject = ?`,
    args: [serverId, appId, subject],
  })
  appLog.info('app-connections', `revoked ${appId} for ${subject}`)
}

/** Every app authorized against this server (admin view). Never returns keys. */
export async function listInstallations() {
  await ensure()
  const serverId = await getServerId()
  const r = await db.execute({
    sql: `SELECT app_id, cp_subject, app_name, app_kind, app_family, scopes,
                 abs_user_id, created_at, last_used_at
          FROM app_installations WHERE server_id = ? ORDER BY created_at DESC`,
    args: [serverId],
  })
  const throttled = await db.execute({
    sql: `SELECT DISTINCT app_id, cp_subject FROM app_rate_buckets
          WHERE server_id = ? AND throttled_at IS NOT NULL AND throttled_at > ?`,
    args: [serverId, Date.now() - 24 * 60 * 60 * 1000],
  })
  const throttleKeys = new Set(
    throttled.rows.map((t) => `${String(t.app_id)}|${String(t.cp_subject)}`),
  )

  return r.rows.map((row) => ({
    appId: String(row.app_id),
    subject: String(row.cp_subject),
    appName: String(row.app_name || ''),
    appKind: String(row.app_kind || 'instance'),
    family: row.app_family ? String(row.app_family) : null,
    scopes: parseScopes(row.scopes),
    absUserId: String(row.abs_user_id),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
    throttled: throttleKeys.has(`${String(row.app_id)}|${String(row.cp_subject)}`),
  }))
}

// --- rate limiting ---------------------------------------------------------

const RATE_WINDOW_MS = 60_000
/** Writes get a tighter budget than reads: a write loop is both more damaging
 *  and less likely to be legitimate than a read loop. */
const RATE_LIMITS = { read: 300, write: 60 }

/**
 * Count one request against an app's budget. Returns { allowed, retryAfter }.
 *
 * Per (app, user) so one app cannot starve another, and one user's runaway
 * integration cannot degrade a housemate's listening.
 */
export async function checkRateLimit(appId, subject, kind) {
  await ensure()
  const serverId = await getServerId()
  const now = Date.now()
  const windowStart = now - (now % RATE_WINDOW_MS)
  const limit = RATE_LIMITS[kind] ?? RATE_LIMITS.read

  const r = await db.execute({
    sql: `SELECT window_start, count FROM app_rate_buckets
          WHERE server_id = ? AND app_id = ? AND cp_subject = ? AND kind = ?`,
    args: [serverId, appId, subject, kind],
  })
  const row = r.rows[0]
  const count = row && Number(row.window_start) === windowStart ? Number(row.count) + 1 : 1

  await db.execute({
    sql: `INSERT INTO app_rate_buckets
            (server_id, app_id, cp_subject, kind, window_start, count, throttled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (server_id, app_id, cp_subject, kind) DO UPDATE SET
            window_start = excluded.window_start,
            count = excluded.count,
            throttled_at = COALESCE(excluded.throttled_at, app_rate_buckets.throttled_at)`,
    args: [serverId, appId, subject, kind, windowStart, count, count > limit ? now : null],
  })

  if (count > limit) {
    return { allowed: false, retryAfter: Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000) }
  }
  return { allowed: true, retryAfter: 0 }
}
