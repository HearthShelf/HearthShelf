import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authorize } from '@/api/auth'
import { useAuthStore } from '@/store/authStore'
import { Wordmark } from '@/components/common/Wordmark'

// Landing for the on-box "Sign in with HearthShelf" flow. app.hearthshelf.com
// redirected the (now Clerk-signed-in) user back here with a control-plane GRANT
// in the URL FRAGMENT. We POST it to this server's own /hs/hosted/connect, which
// verifies it offline and returns a per-user ABS token, then hydrate the session.
// No ABS OIDC, no popup. The grant rides the fragment (never the query) so it
// isn't logged; we strip it from the URL immediately.
export function ConnectLandPage() {
  const navigate = useNavigate()
  const setToken = useAuthStore((s) => s.setToken)
  const login = useAuthStore((s) => s.login)
  const [error, setError] = useState<string | null>(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const frag = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const grant = frag.get('grant') || ''
    window.history.replaceState(null, '', window.location.pathname)

    async function complete() {
      if (!grant) {
        return setError('Sign-in is missing its grant. Please try again from the app.')
      }
      try {
        // Same-origin POST to our own backend; returns the per-user ABS token.
        const res = await fetch('/hs/hosted/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant }),
        })
        if (!res.ok) {
          return setError('We could not sign you in to this server. Please try again.')
        }
        const { token } = (await res.json()) as { token?: string }
        if (!token) return setError('Sign-in did not return a token. Please try again.')

        // Stage the token so authorize() can use it, then hydrate the full user.
        setToken(token)
        const me = await authorize()
        login(me.user, token, me.userDefaultLibraryId)
        navigate('/', { replace: true })
      } catch {
        setError('Sign-in could not be completed. Please try again.')
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
