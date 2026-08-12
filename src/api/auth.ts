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
// The callback must pass isValidWebCallbackUrl: same-origin as ABS and under its
// router base path. We send a RELATIVE path on purpose: ABS resolves it against
// the origin IT saw on the request, which our nginx sets to the browser's own
// host (proxy_set_header Host $host). So this matches whatever address the user
// came in on - LAN IP, domain, or connect domain - with nothing to configure.
// An absolute URL would hard-code one origin and break the others.
//
// Caveat: ABS additionally requires the path to sit under its ROUTER_BASE_PATH.
// We assume the default (empty), which holds for every HearthShelf deployment -
// our nginx mounts ABS at the origin root. An ABS running under a subpath would
// reject this, but such a setup breaks the whole /abs-api proxy, not just SSO.
export const OIDC_CALLBACK_PATH = '/oidc-land'

export function openIdInitUrl(): string {
  const params = new URLSearchParams({ callback: OIDC_CALLBACK_PATH })
  return `/abs-api/auth/openid?${params.toString()}`
}
