import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/hooks/useAuth'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import { absRequest } from '@/api/client'
import { resolveOpenIdInitUrl } from '@/api/auth'
import type { ABSStatusResponse } from '@/api/types'
import { Wordmark } from '@/components/common/Wordmark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function LoginPage() {
  const navigate = useNavigate()
  const { signIn } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [startingOpenId, setStartingOpenId] = useState(false)

  const { data: runtime } = useRuntimeConfig()

  // A fresh AIO box that hasn't finished setup belongs in the onboarding wizard,
  // not this bare login form: the wizard reveals the generated root credentials
  // and signs the admin in. Without this redirect a first-run AIO visitor lands
  // here with no idea what to type. Slim is intentionally NOT redirected - its
  // onboarding runs AFTER the admin signs into their own ABS (the wizard sends an
  // unauthenticated slim visitor back here), so redirecting would loop. 'hosted'
  // is control-plane managed and never onboards locally.
  const needsOnboarding = runtime && !runtime.onboarded && runtime.mode === 'aio'

  // Hosted SSO bounce target: only when the box is paired to the control plane and
  // we know our server id. The app authenticates the user (Clerk) and redirects
  // back to /connect-land with a grant. Replaces the old ABS-OIDC button.
  const hostedSsoUrl =
    runtime?.paired && runtime.serverId && runtime.controlPlaneUrl
      ? `${runtime.controlPlaneUrl.replace(/\/$/, '')}/connect-box` +
        `?server=${encodeURIComponent(runtime.serverId)}` +
        // Return to the EXACT origin the user is on (e.g. the LAN IP) so on-box
        // sign-in keeps them where they started, Plex-style. connect-box validates
        // this against the server before honoring it.
        `&return=${encodeURIComponent(window.location.origin)}`
      : null

  // ABS OpenID, for self-hosted boxes. /status is unauthenticated, so this is
  // safe to call on the login page; it tells us whether the admin configured an
  // identity provider and what to label the button.
  const { data: status } = useQuery({
    queryKey: ['server-status'],
    queryFn: () => absRequest<ABSStatusResponse>('/status'),
    staleTime: 5 * 60 * 1000,
  })

  // Show ABS SSO only on an UNPAIRED box. A paired box gets the hosted button
  // above instead: two SSO buttons side by side is the ambiguity that got the
  // ABS one pulled in the first place, and on a paired box the hosted flow is
  // the one that mints the per-user token we expect.
  const openIdEnabled =
    !hostedSsoUrl && (status?.authMethods?.includes('openid') ?? false)
  const openIdLabel = status?.authFormData?.authOpenIDButtonText || 'Sign in with OpenID'

  // Ask ABS which callback path it accepts, then full-navigate (not fetch) so
  // ABS can set its session cookies and 302 out to the identity provider.
  async function startOpenId() {
    setError(null)
    setStartingOpenId(true)
    try {
      window.location.href = await resolveOpenIdInitUrl()
    } catch {
      setError('Could not start single sign-on. Please try again.')
      setStartingOpenId(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signIn(username, password)
      navigate('/', { replace: true })
    } catch {
      setError('Login failed. Check your username and password.')
    } finally {
      setSubmitting(false)
    }
  }

  if (needsOnboarding) {
    return <Navigate to="/onboarding" replace />
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Wordmark className="text-3xl" />
          <CardTitle className="mt-2 text-sm font-normal text-muted-foreground">
            Sign in to continue
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>

          {/* Hosted SSO: a paired box lets users sign in with their HearthShelf
              (Clerk) account. We bounce to app.hearthshelf.com, which authenticates
              the user and redirects back here (/connect-land) with a grant the box
              redeems. Shown only when paired AND we know our server id. */}
          {hostedSsoUrl && (
            <div className="mt-4">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  window.location.href = hostedSsoUrl
                }}
              >
                Sign in with HearthShelf
              </Button>
            </div>
          )}

          {/* ABS OpenID for self-hosted boxes. Full navigation (not fetch): ABS
              needs to set its own session cookies and 302 out to the provider. */}
          {openIdEnabled && (
            <div className="mt-4">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={startingOpenId}
                onClick={() => void startOpenId()}
              >
                {startingOpenId ? 'Redirecting...' : openIdLabel}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
