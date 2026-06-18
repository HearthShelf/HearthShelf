import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { openIdCallback } from '@/api/auth'
import { useAuthStore } from '@/store/authStore'
import { OIDC_VERIFIER_KEY, OIDC_STATE_KEY } from '@/pages/LoginPage'
import { Wordmark } from '@/components/common/Wordmark'

// Completes the ABS OpenID PKCE flow: the provider redirected back here with
// `code` + `state`. Validate state, exchange the code (with our stored PKCE
// verifier) for an ABS session, store the token, and enter the app.
export function OAuthCallbackPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const setSession = useAuthStore((s) => s.login)
  const [error, setError] = useState<string | null>(null)
  // React 18 StrictMode double-invokes effects in dev; guard the one-shot.
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    async function complete() {
      const code = params.get('code')
      const returnedState = params.get('state')
      const providerError = params.get('error')
      const verifier = sessionStorage.getItem(OIDC_VERIFIER_KEY)
      const savedState = sessionStorage.getItem(OIDC_STATE_KEY)
      sessionStorage.removeItem(OIDC_VERIFIER_KEY)
      sessionStorage.removeItem(OIDC_STATE_KEY)

      if (providerError) {
        return setError(`Sign-in was cancelled or failed (${providerError}).`)
      }
      if (!code || !returnedState || !verifier) {
        return setError('Sign-in is missing required parameters. Please try again.')
      }
      if (returnedState !== savedState) {
        return setError(
          'Sign-in could not be verified (state mismatch). Please try again.'
        )
      }

      try {
        const res = await openIdCallback(code, returnedState, verifier)
        setSession(res.user, res.user.token, res.userDefaultLibraryId)
        navigate('/', { replace: true })
      } catch {
        setError('Sign-in could not be completed. Please try again.')
      }
    }

    void complete()
  }, [params, navigate, setSession])

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
