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
// The base path decides the callback. A stock ABS defaults ROUTER_BASE_PATH to
// '/audiobookshelf' and requires the callback beneath it; our AIO image runs ABS
// at the root (''), where the check is `startsWith('/')` and so accepts anything.
// The prefixed path therefore satisfies BOTH, and is what we always send - no
// discovery needed, and ABS exposes no way to ask anyway.
//
// Do NOT try to discover it by calling /auth/openid twice. Every call makes ABS
// mint a fresh PKCE verifier and state into its server-side session, so probing
// and then navigating leaves the session holding the SECOND state while the
// provider returns with the first. ABS rejects the callback and the user lands
// back on the login page with no error. That is exactly what a probe-based
// version of this function did.
export const OIDC_CALLBACK_PATH = '/audiobookshelf/oidc-land'

export function openIdInitUrl(): string {
  const params = new URLSearchParams({ callback: OIDC_CALLBACK_PATH })
  return `/abs-api/auth/openid?${params.toString()}`
}
