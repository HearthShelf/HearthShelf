// The ABS admin credential HearthShelf uses for server-side admin work in hosted
// mode: provisioning invited users, minting per-user keys, brokering connect,
// username sync, admin recovery. Historically this was a perishable ABS /login
// SESSION token captured at onboarding/pairing time. Session tokens die when the
// user they belong to is deleted, the token secret rotates, or (newer ABS) they
// expire - and when this one died, every NEW-user provision started returning
// ABS 401 while existing users (who hold their own cached per-user API keys) kept
// working. The failure was silent and easy to misread as a per-user problem.
//
// This module makes the credential DURABLE and SELF-HEALING:
//
//   - Durable: we store an ABS API KEY (POST /api/api-keys), not a login token.
//     API keys survive restarts, password changes, and session expiry.
//   - Self-healing: getServiceToken() validates the stored credential and, on a
//     401/invalid, re-mints a fresh API key by logging in as the service root
//     (hearthshelf-service) with the password seed in `provisioning`. The new key
//     is persisted back to hosted_config so the next call is a fast hit.
//   - Honest when it can't: if re-minting also fails (the service password has
//     desynced from ABS, or ABS is down), we report BROKEN so the Web UI can ask
//     an operator to reset it, instead of failing opaquely in the logs.
//
// State machine (see getCredentialHealth):
//   valid  - stored credential authenticates as an ABS admin/root. Nothing to do.
//   stale  - stored credential is missing/rejected BUT we hold a service password
//            that still logs in, so a re-mint recovers automatically.
//   broken - stored credential is rejected AND we cannot re-mint (no/!working
//            service password). Needs operator input via the Fix UI.
//   absent - hosted mode isn't set up here (no admin credential expected).
//
// Everything is best-effort and never throws to the caller: admin paths degrade
// to "couldn't get a credential" (null) rather than crashing a request.

import { getHostedConfig, setHostedConfig } from './hosted.js'
import { getProvisioning } from './provisioning.js'
import { appLog } from './appLog.js'

const ABS_URL = (process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378').replace(/\/$/, '')
const SERVICE_USERNAME = process.env.AIO_SERVICE_USERNAME || 'hearthshelf-service'

// Validate a token against ABS /api/me. Returns the ABS user (with .type) on
// success, or null on any rejection/unreachable. Used to tell "valid" from
// "stale" without guessing.
export async function whoAmI(token) {
  if (!token) return null
  try {
    const res = await fetch(`${ABS_URL}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function isAdminUser(me) {
  return me?.type === 'admin' || me?.type === 'root'
}

// Log in to ABS with the service-root username/password and return a session
// token, or null. Only used as the seed to mint a durable API key - we never
// STORE this token.
async function serviceLogin(password) {
  if (!password) return null
  try {
    const res = await fetch(`${ABS_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: SERVICE_USERNAME, password }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.user?.token || null
  } catch {
    return null
  }
}

// Extract the raw API-key STRING from ABS's create response. ABS 2.35.1 nests it
// under apiKey.apiKey (the outer `apiKey` is an object), so check the nested
// string first; fall back to flatter shapes for older builds. Mirrors the reader
// in hosted.js:mintAbsApiKey so both agree on the shape.
function extractApiKey(data) {
  const k =
    (typeof data?.apiKey === 'object' ? data.apiKey?.apiKey : data?.apiKey) || data?.key || null
  return typeof k === 'string' && k ? k : null
}

// Mint a durable ABS API key for a given ABS user id, using an admin token. The
// key acts AS that user on subsequent calls. Returns the raw key string or null.
export async function mintApiKeyFor(adminToken, absUserId, name) {
  try {
    const res = await fetch(`${ABS_URL}/api/api-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name || `hearthshelf-service:${absUserId}`,
        userId: absUserId,
        isActive: true,
      }),
    })
    if (!res.ok) return null
    return extractApiKey(await res.json())
  } catch {
    return null
  }
}

// Find the ABS service-root user's id using an admin token. The service account
// is the durable, undeletable identity we want the API key to belong to.
async function findServiceUserId(adminToken) {
  try {
    const res = await fetch(`${ABS_URL}/api/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    const users = Array.isArray(data) ? data : data?.users || []
    const svc =
      users.find((u) => u.username === SERVICE_USERNAME) ||
      users.find((u) => u.type === 'root') ||
      null
    return svc?.id ? String(svc.id) : null
  } catch {
    return null
  }
}

// Mint a durable API key for the service root and persist it as the admin
// credential. Requires a working admin token to authenticate the mint (the
// caller supplies one: a fresh service-root login, or an operator's admin token
// from the Fix UI). Returns the new key, or null if minting failed.
export async function remintServiceKey(adminToken) {
  const svcId = await findServiceUserId(adminToken)
  if (!svcId) return null
  const key = await mintApiKeyFor(adminToken, svcId, `hearthshelf-service:${svcId}`)
  if (!key) return null
  // Confirm the freshly minted key actually authenticates before we store it, so
  // we never persist a dud.
  if (!isAdminUser(await whoAmI(key))) return null
  await setHostedConfig({ absAdminToken: key, adminCredStatus: 'valid' })
  return key
}

// Try to automatically recover a working credential from the stored service
// password: log in as the service root, mint a durable API key, persist it.
// Returns the new key or null. This is the "stale -> valid" transition.
async function selfHeal() {
  const prov = await getProvisioning().catch(() => null)
  const sessionToken = await serviceLogin(prov?.servicePassword)
  if (!sessionToken || !isAdminUser(await whoAmI(sessionToken))) return null
  const key = await remintServiceKey(sessionToken)
  if (key) {
    appLog.warn(
      'hosted',
      'admin credential was stale; automatically re-minted a durable API key from the service account',
    )
  }
  return key
}

// The main entry point for server-side admin work. Returns a WORKING ABS admin
// token (a durable API key), self-healing if the stored one is dead, or null if
// no working credential can be obtained (BROKEN - needs an operator reset).
// Callers use this instead of reading cfg.absAdminToken directly.
export async function getServiceToken() {
  const cfg = await getHostedConfig().catch(() => null)
  const stored = cfg?.absAdminToken || null

  // Fast path: the stored credential still authenticates as an admin. Repair a
  // stale/broken status marker if the token is actually fine (e.g. ABS was
  // briefly down at the last check).
  if (stored && isAdminUser(await whoAmI(stored))) {
    if (cfg?.adminCredStatus && cfg.adminCredStatus !== 'valid') {
      await setHostedConfig({ adminCredStatus: 'valid' }).catch(() => {})
    }
    return stored
  }

  // Stored credential is missing or dead - try to self-heal from the service
  // password. On success this also persists the new key for next time.
  const healed = await selfHeal()
  if (healed) return healed

  // Can't recover automatically. Persist the broken state so the UI surfaces the
  // fix flow, and surface it once in the logs so the reason is visible.
  if (stored) {
    await setHostedConfig({ adminCredStatus: 'broken' }).catch(() => {})
    appLog.error(
      'hosted',
      'admin credential is invalid and could not be re-minted (service password may have desynced); reset it under Connect',
    )
  }
  return null
}

// Boot hook: if this box is paired, proactively validate + self-heal the admin
// credential on startup so an existing box carrying a stale session token (from
// before durable keys) recovers automatically, rather than only on the first new
// invitee. Best-effort and background - never blocks serving, never throws. On
// an unrecoverable credential it leaves the 'broken' marker for the UI to surface.
export async function healAdminCredentialOnStartup() {
  try {
    const cfg = await getHostedConfig().catch(() => null)
    // Only relevant when paired for hosted federation. An unpaired box does no
    // server-side admin work, so there's nothing to heal.
    if (!cfg?.issuer || !cfg?.jwksUrl) return
    const token = await getServiceToken()
    if (token) {
      appLog.info('hosted', 'admin credential verified on startup')
    } else {
      appLog.error(
        'hosted',
        'admin credential is broken on startup - new invited users cannot be provisioned until it is reset under Connect',
      )
    }
  } catch {
    // best-effort; a boot-time probe failure must never crash startup
  }
}

// Compute credential health for the Web UI. Never throws; every branch degrades
// to a best-effort state. `absUserId`/`username` describe whose credential the
// stored token currently is, when we can tell.
export async function getCredentialHealth() {
  const cfg = await getHostedConfig().catch(() => null)
  const paired = Boolean(cfg?.issuer && cfg?.jwksUrl)
  const stored = cfg?.absAdminToken || null

  // Not set up for hosted admin work here.
  if (!paired && !stored) {
    return { state: 'absent', paired, hasCredential: false }
  }

  const me = stored ? await whoAmI(stored) : null
  if (isAdminUser(me)) {
    if (cfg?.adminCredStatus !== 'valid') {
      await setHostedConfig({ adminCredStatus: 'valid' }).catch(() => {})
    }
    return {
      state: 'valid',
      paired,
      hasCredential: true,
      absUserId: me?.id ? String(me.id) : null,
      username: me?.username ?? null,
      isService: me?.username === SERVICE_USERNAME || me?.type === 'root',
    }
  }

  // Stored credential is dead (or absent). Can we re-mint from the service pw?
  const prov = await getProvisioning().catch(() => null)
  const sessionToken = await serviceLogin(prov?.servicePassword)
  const canSelfHeal = Boolean(sessionToken && isAdminUser(await whoAmI(sessionToken)))
  const state = canSelfHeal ? 'stale' : 'broken'
  if (cfg?.adminCredStatus !== state) {
    await setHostedConfig({ adminCredStatus: state }).catch(() => {})
  }

  return {
    state,
    paired,
    hasCredential: Boolean(stored),
    canSelfHeal,
    hasServicePassword: Boolean(prov?.servicePassword),
  }
}
