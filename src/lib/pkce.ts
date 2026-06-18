// PKCE (RFC 7636) + state helpers for the ABS OpenID flow. ABS requires
// code_challenge_method=S256 and a same-origin redirect_uri.

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

export interface PkcePair {
  verifier: string
  challenge: string
}

// Generate a PKCE verifier and its S256 challenge.
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomString(32)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  )
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

// Opaque anti-forgery value echoed back by the provider and re-checked.
export function createState(): string {
  return randomString(16)
}
