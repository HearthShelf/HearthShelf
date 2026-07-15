// ReadMeABook (RMAB) proxy. RMAB is HearthShelf's optional audiobook-acquisition
// backend - an internal-only service. HearthShelf authenticates to it as a single
// shared service account and forwards the small surface the app needs.
//
// Auth model: RMAB's static `rmab_` API tokens are restricted to a read/create
// allowlist (search + list/get/create requests). To also drive write actions
// (cancel, retry, watch author/series, ignore, ebook companion) HearthShelf holds
// a long-lived RMAB *login token* server-side and exchanges it for a short-lived
// JWT session (POST /api/auth/token/login). JWT auth is not allowlist-restricted,
// so the full user API is reachable. The access token lives ~1h and is refreshed
// via POST /api/auth/refresh; on any auth failure we re-exchange the login token.
//
// The service account is expected to hold the RMAB admin role so the ebook
// companion flow and admin read endpoints work; request/cancel/retry/watch work
// at any role.
//
// Neither the login token nor the JWT ever reaches the browser. The caller is
// already identified by their ABS token upstream (see authUser in index.js);
// RMAB sees one service account.
//
// Connection config (url + login token) lives in the integrations_config table,
// editable from Config > Integrations and seeded from RMAB_URL / RMAB_LOGIN_TOKEN
// on first boot. See server/integrations.js.

import { getIntegrations } from './integrations.js'

const TIMEOUT_MS = 20000
// Access tokens live ~1h; refresh a little early so a call never races expiry.
const ACCESS_TTL_MS = 55 * 60 * 1000

async function rmabUrl() {
  const { rmabUrl } = await getIntegrations()
  return rmabUrl || ''
}

async function loginToken() {
  const { rmabLoginToken } = await getIntegrations()
  return rmabLoginToken || ''
}

export async function isRmabConfigured() {
  const { rmabUrl, rmabLoginToken } = await getIntegrations()
  return Boolean(rmabUrl && rmabLoginToken)
}

// ---- JWT session ---------------------------------------------------------
// Cached across calls. `accessToken` is sent as the Bearer; `refreshToken`
// renews it; `expiresAt` triggers a proactive refresh. A single in-flight
// auth promise (`pending`) coalesces concurrent callers so we log in once.
const session = { accessToken: null, refreshToken: null, expiresAt: 0, pending: null }

// Drop the cached session so the next call re-authenticates. Called after the
// admin edits the RMAB url/token, since the old JWT was for the old service.
export function resetRmabSession() {
  session.accessToken = null
  session.refreshToken = null
  session.expiresAt = 0
  session.pending = null
}

async function rawFetch(method, path, { token, body, baseUrl } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const base = baseUrl ?? (await rmabUrl())
    const res = await fetch(`${base}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
    })
    let parsed = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  } finally {
    clearTimeout(t)
  }
}

// Validate a candidate connection before saving it. A ReadMeABook API token and
// Login Token share the same rmab_ prefix, so a failed login exchange is followed
// by /api/auth/me with Bearer auth to identify the limited API-token case.
export async function validateRmabCredentials(baseUrl, token) {
  try {
    const login = await rawFetch('POST', '/api/auth/token/login', {
      baseUrl,
      body: { token },
    })
    if (login.status === 200 && login.body?.accessToken) return { ok: true }

    const apiTokenCheck = await rawFetch('GET', '/api/auth/me', { baseUrl, token })
    if (apiTokenCheck.status === 200) {
      return {
        ok: false,
        code: 'rmab_limited_api_token',
        message:
          'This is a ReadMeABook API Token. HearthShelf needs the Login Token from Admin > Users so cancel, retry, watch, ignore, and ebook actions work.',
      }
    }

    const reason = login.body?.error || login.body?.message
    return {
      ok: false,
      code: 'rmab_invalid_login_token',
      message: reason
        ? `ReadMeABook rejected the Login Token: ${reason}`
        : `ReadMeABook rejected the Login Token (HTTP ${login.status}).`,
    }
  } catch (err) {
    return {
      ok: false,
      code: 'rmab_connection_failed',
      message: `Could not reach ReadMeABook at that URL: ${String(err).slice(0, 160)}`,
    }
  }
}

// Exchange the long-lived login token for a fresh JWT pair.
async function exchangeLoginToken() {
  const r = await rawFetch('POST', '/api/auth/token/login', { body: { token: await loginToken() } })
  if (r.status !== 200 || !r.body?.accessToken) {
    throw new Error(`rmab_login_failed_${r.status}`)
  }
  session.accessToken = r.body.accessToken
  session.refreshToken = r.body.refreshToken ?? null
  session.expiresAt = Date.now() + ACCESS_TTL_MS
  return session.accessToken
}

// Renew the access token from the refresh token; falls back to a full
// login-token exchange if the refresh token is missing or rejected.
async function renewAccessToken() {
  if (session.refreshToken) {
    const r = await rawFetch('POST', '/api/auth/refresh', {
      body: { refreshToken: session.refreshToken },
    })
    if (r.status === 200 && r.body?.accessToken) {
      session.accessToken = r.body.accessToken
      if (r.body.refreshToken) session.refreshToken = r.body.refreshToken
      session.expiresAt = Date.now() + ACCESS_TTL_MS
      return session.accessToken
    }
  }
  return exchangeLoginToken()
}

// Return a valid access token, establishing or renewing the session as needed.
// Concurrent callers share a single in-flight auth via `session.pending`.
async function getAccessToken(forceRenew = false) {
  if (!forceRenew && session.accessToken && Date.now() < session.expiresAt) {
    return session.accessToken
  }
  if (session.pending) return session.pending
  const work = (async () => {
    try {
      return session.accessToken && !forceRenew
        ? await renewAccessToken()
        : session.refreshToken
          ? await renewAccessToken()
          : await exchangeLoginToken()
    } finally {
      session.pending = null
    }
  })()
  session.pending = work
  return work
}

// Forward an authenticated request to RMAB. Returns { status, body }. On a
// 401/403 (token expired or revoked) it re-auths once and retries. Throws only
// on network/timeout.
export async function rmabFetch(method, path, body) {
  if (!(await isRmabConfigured())) throw new Error('rmab_not_configured')
  let token = await getAccessToken()
  let r = await rawFetch(method, path, { token, body })
  if (r.status === 401 || r.status === 403) {
    token = await getAccessToken(true)
    r = await rawFetch(method, path, { token, body })
  }
  return r
}
