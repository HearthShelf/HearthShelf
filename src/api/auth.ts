import { absRequest } from '@/api/client'
import type { ABSAuthResponse } from '@/api/types'

// Username/password auth. ABS exposes this at the origin root (/login), not
// under /api, so the path passed to absRequest is /login.
export function login(
  username: string,
  password: string
): Promise<ABSAuthResponse> {
  return absRequest<ABSAuthResponse>('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

// Validate a persisted token and rehydrate user state. POST, not GET.
export function authorize(): Promise<ABSAuthResponse> {
  return absRequest<ABSAuthResponse>('/api/authorize', { method: 'POST' })
}

// ABS OpenID is OAuth2 + PKCE (RFC 7636), client-driven. The client name ABS
// sees as client_id; the redirect_uri must be whitelisted in ABS's OpenID
// config and must be same-origin with ABS (which, via the /abs-api proxy, means
// our own origin).
const OIDC_CLIENT_ID = 'HearthShelf'

export function openIdRedirectUri(): string {
  return `${window.location.origin}/oauth/callback`
}

// Build the /auth/openid initiation URL. The browser is sent here (full
// navigation, not fetch) so ABS can set its session cookies and 302 to the
// provider. Returns through the /abs-api proxy so it stays same-origin.
export function openIdInitUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OIDC_CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: openIdRedirectUri(),
    state,
  })
  return `/abs-api/auth/openid?${params.toString()}`
}

// Finalize the flow: exchange the provider's code (+ our PKCE verifier) for an
// ABS session. With redirect_uri present, ABS returns the same envelope as
// /login (user.token + libraries + settings).
export function openIdCallback(
  code: string,
  state: string,
  codeVerifier: string
): Promise<ABSAuthResponse> {
  const params = new URLSearchParams({
    code,
    state,
    code_verifier: codeVerifier,
    redirect_uri: openIdRedirectUri(),
  })
  return absRequest<ABSAuthResponse>(
    `/auth/openid/callback?${params.toString()}`
  )
}
