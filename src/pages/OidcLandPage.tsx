import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authorize } from '@/api/auth'
import { useAuthStore } from '@/store/authStore'
import { Wordmark } from '@/components/common/Wordmark'

// Landing for the ABS OpenID (self-hosted SSO) flow. ABS ran its WEB flow: it
// handled PKCE and state server-side, then 302'd back here with the token in the
// QUERY STRING - `accessToken` plus a legacy `setToken` it still sends for older
// clients (ABS server/Auth.js handleLoginSuccessBasedOnCookie).
//
// We take the token, stage it, and hydrate the session the same way the hosted
// connect-land flow does. The token is stripped from the URL immediately so it
// doesn't sit in history or get copy-pasted out of the address bar.
export function OidcLandPage() {
  const navigate = useNavigate()
  const setToken = useAuthStore((s) => s.setToken)
  const login = useAuthStore((s) => s.login)
  const [error, setError] = useState<string | null>(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const params = new URLSearchParams(window.location.search)
    // Prefer the current token param; fall back to the legacy one.
    const token = params.get('accessToken') || params.get('setToken') || ''
    window.history.replaceState(null, '', window.location.pathname)

    async function complete() {
      if (!token) {
        return setError('Single sign-on did not return a token. Please try again.')
      }
      try {
        setToken(token)
        const me = await authorize()
        login(me.user, token, me.userDefaultLibraryId)
        navigate('/', { replace: true })
      } catch {
        setError('We could not complete single sign-on. Please try again.')
      }
    }

    void complete()
  }, [navigate, setToken, login])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <Wordmark className="text-3xl" />
      {error ? (
        <>
          <p className="max-w-sm text-sm text-destructive" role="alert">
            {error}
          </p>
          <button className="pill" onClick={() => navigate('/login', { replace: true })}>
            Back to sign in
          </button>
        </>
      ) : (
        <p className="text-muted-foreground">Completing sign in…</p>
      )}
    </div>
  )
}
