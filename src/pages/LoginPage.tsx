import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/hooks/useAuth'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import { absRequest } from '@/api/client'
import { openIdInitUrl } from '@/api/auth'
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
  // back to /connect-land with a grant. Admins who want a paired box to sign
  // people in through ABS alone can hide it (Config > Authentication); absent
  // means enabled, so an older backend keeps offering it.
  const hostedSsoUrl =
    runtime?.paired &&
    runtime.serverId &&
    runtime.controlPlaneUrl &&
    runtime.hostedLoginEnabled !== false
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

  // Both SSO paths can run at once. Pairing no longer suppresses the admin's own
  // identity provider: the two flows are interchangeable to everything
  // downstream (ABS OIDC returns an ABS session token, hosted connect returns a
  // per-user ABS API key, and resolveContext validates either against ABS
  // /api/me), so the only real objection was two unlabelled buttons looking
  // alike. They're captioned below instead of one hiding the other.
  const openIdEnabled = status?.authMethods?.includes('openid') ?? false
  const openIdLabel = status?.authFormData?.authOpenIDButtonText || 'Sign in with OpenID'

  // ABS can deactivate password login (authActiveAuthMethods, edited on
  // Config > Authentication); we used to render the form regardless. Default to
  // true so a slow or failed /status never hides the only way in.
  const localEnabled = status ? status.authMethods.includes('local') : true

  // Last-resort guard: never render a login card with no way to sign in. An
  // SSO-only server whose provider breaks (or a paired box with the HearthShelf
  // button hidden) would otherwise leave its admin locked out with no recourse
  // but editing the database.
  const passwordEnabled = localEnabled || (!hostedSsoUrl && !openIdEnabled)

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
          {passwordEnabled && (
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
          )}

          {/* Both SSO options can appear together, so each carries a caption
              saying which account it wants. Without them a default
              authOpenIDButtonText ("Sign in with OpenID") sitting under "Sign in
              with HearthShelf" gives no clue which is which. */}
          {(hostedSsoUrl || openIdEnabled) && (
            <div className="mt-6 flex flex-col gap-4">
              {passwordEnabled && (
                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-xs text-muted-foreground">or continue with</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}

              {/* Hosted SSO: bounce to app.hearthshelf.com, which authenticates the
                  user and redirects back to /connect-land with a grant the box
                  redeems for a per-user ABS token. */}
              {hostedSsoUrl && (
                <div className="flex flex-col gap-1">
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
                  <p className="text-center text-xs text-muted-foreground">
                    Your account at hearthshelf.com
                  </p>
                </div>
              )}

              {/* ABS OpenID. Full navigation (not fetch): ABS needs to set its own
                  session cookies and 302 out to the provider. */}
              {openIdEnabled && (
                <div className="flex flex-col gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      window.location.href = openIdInitUrl()
                    }}
                  >
                    {openIdLabel}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    Single sign-on for this server
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
