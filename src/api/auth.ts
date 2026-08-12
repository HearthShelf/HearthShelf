import { absRequest } from '@/api/client'
import type { ABSAuthResponse } from '@/api/types'

// Username/password auth. ABS exposes this at the origin root (/login), not
// under /api, so the path passed to absRequest is /login.
export function login(username: string, password: string): Promise<ABSAuthResponse> {
  return absRequest<ABSAuthResponse>('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

// Validate a persisted token and rehydrate user state. POST, not GET.
export function authorize(): Promise<ABSAuthResponse> {
  return absRequest<ABSAuthResponse>('/api/authorize', { method: 'POST' })
}

// --- ABS OpenID (self-hosted / unpaired boxes only) ---
//
// ABS has two OIDC flows and picks between them by sniffing query params:
// `response_type`, `redirect_uri`, or `code_challenge` on /auth/openid means the
// MOBILE flow, which additionally requires the URI to be whitelisted in the
// server's authOpenIDMobileRedirectURIs. We deliberately send NONE of them, so
// ABS runs its WEB flow: it generates the PKCE pair and state itself, keeps them
// server-side, and hands the token back to us as a query param.
// (ABS server/auth/OidcAuthStrategy.js getAuthorizationUrl.)
//
// The callback must pass isValidWebCallbackUrl: same-origin as ABS AND under
// ABS's ROUTER_BASE_PATH. We send a RELATIVE path on purpose: ABS resolves it
// against the origin IT saw on the request, which our nginx sets to the
// browser's own host (proxy_set_header Host $host). So this matches whatever
// address the user came in on - LAN IP, domain, or connect domain - with
// nothing to configure. An absolute URL would hard-code one origin.
//
// The base path is the wrinkle. A stock ABS defaults to ROUTER_BASE_PATH
// '/audiobookshelf', while our AIO image runs it at the root (''). ABS does not
// report which one it uses - /status has no such field - so we cannot compute
// the right prefix up front, and guessing wrong is a hard 400.
//
// So we PROBE: ask ABS to start the flow with the bare path, and if it refuses,
// retry under '/audiobookshelf'. ABS only validates the callback as a STRING;
// the browser then loads that path from OUR nginx, which serves the SPA at both
// (neither is an ABS-proxied prefix, so both hit the SPA fallback). The React
// route is registered at /oidc-land and matches either way.
export const OIDC_CALLBACK_PATH = '/oidc-land'

// Base paths to try, in order. '' covers AIO and any ABS run at the root;
// '/audiobookshelf' is the stock ABS default.
const OIDC_BASE_PATHS = ['', '/audiobookshelf'] as const

function initUrlFor(basePath: string): string {
  const params = new URLSearchParams({ callback: `${basePath}${OIDC_CALLBACK_PATH}` })
  return `/abs-api/auth/openid?${params.toString()}`
}

// Resolve the initiation URL ABS will actually accept.
//
// Probed with redirect: 'manual' so the browser does NOT follow the 302 to the
// identity provider - we only want to know whether ABS accepted the callback.
// An opaqueredirect response (or any non-400) means accepted; the caller then
// full-navigates there for real, so ABS can set its session cookies.
export async function resolveOpenIdInitUrl(): Promise<string> {
  for (const basePath of OIDC_BASE_PATHS) {
    const url = initUrlFor(basePath)
    try {
      const res = await fetch(url, { redirect: 'manual', credentials: 'same-origin' })
      // opaqueredirect = ABS issued its 302 to the provider: this one is good.
      if (res.type === 'opaqueredirect' || res.status === 0 || res.ok) return url
      if (res.status !== 400) return url
    } catch {
      // Network failure tells us nothing about the callback; try the next.
    }
  }
  // Everything rejected: fall back to the bare path so the user still gets a
  // real ABS error rather than a dead button.
  return initUrlFor('')
}
