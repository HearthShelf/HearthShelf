import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import {
  revealRootCredentials,
  markOnboarded,
  type RootCredentials,
} from '@/api/runtime'
import { startPairing } from '@/api/hosted'
import { useAuth } from '@/hooks/useAuth'
import { Wordmark } from '@/components/common/Wordmark'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// The setup wizard a fresh install lands on. Two variants share this page:
//
//   aio  - HearthShelf already provisioned the bundled ABS. We reveal the
//          generated root credentials, sign the admin in with them, and DEFAULT
//          to connecting to app.hearthshelf.com (the most frictionless path),
//          with an opt-out to stay local-only.
//
//   slim - the admin already runs their own ABS and has signed in. We don't
//          assume they want app.hearthshelf.com; we offer it, opt-IN.
//
// 'hosted' instances never reach here (the control plane manages onboarding).
export function OnboardingPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: config, isLoading } = useRuntimeConfig()
  const { isAuthenticated, signIn, user } = useAuth()

  const [creds, setCreds] = useState<RootCredentials | null>(null)
  // AIO defaults the connect choice ON; slim defaults it OFF.
  const [connect, setConnect] = useState<boolean | null>(null)
  const [pairCode, setPairCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revealRan = useRef(false)

  const isAio = config?.mode === 'aio'

  // Default the connect choice once we know the mode.
  useEffect(() => {
    if (config && connect === null) setConnect(isAio)
  }, [config, connect, isAio])

  // AIO: reveal the generated root credentials once and sign in with them so the
  // admin never has to hunt for a password. Guarded against StrictMode double-run
  // and against re-revealing (the endpoint self-clears after the first read).
  useEffect(() => {
    if (!isAio || isAuthenticated || revealRan.current) return
    revealRan.current = true
    void (async () => {
      const revealed = await revealRootCredentials()
      if (!revealed) return // already revealed / claimed; admin signs in manually
      setCreds(revealed)
      try {
        await signIn(revealed.username, revealed.password)
      } catch {
        // Sign-in failed; leave the credentials on screen so the admin can use
        // the normal login form.
      }
    })()
  }, [isAio, isAuthenticated, signIn])

  const isAdmin = user?.type === 'admin' || user?.type === 'root'

  async function finish() {
    setError(null)
    setBusy(true)
    try {
      if (connect) {
        const result = await startPairing({
          publicUrl: config?.publicUrl || window.location.origin,
        })
        setPairCode(result.code)
        // Pairing is finished by the admin on app.hearthshelf.com; we still mark
        // onboarding complete so the box stops routing here.
      }
      await markOnboarded()
      await queryClient.invalidateQueries({ queryKey: ['runtime-config'] })
      if (!connect) navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup step failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (isLoading || connect === null) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    )
  }

  // Slim, not signed in yet: send them to the normal login first, then back.
  if (!isAio && !isAuthenticated) {
    navigate('/login', { replace: true })
    return null
  }

  // After pairing started: show the code to redeem on app.hearthshelf.com.
  if (pairCode) {
    return (
      <Shell>
        <CardTitle className="text-center text-lg">Almost there</CardTitle>
        <p className="text-sm text-muted-foreground">
          Finish connecting on app.hearthshelf.com by entering this pairing code.
          It expires shortly.
        </p>
        <div className="rounded-md border bg-muted/40 px-4 py-3 text-center font-mono text-2xl tracking-widest">
          {pairCode}
        </div>
        <Button
          className="w-full"
          onClick={() => {
            window.open(`${config?.controlPlaneUrl}/pair?code=${pairCode}`, '_blank')
          }}
        >
          Open app.hearthshelf.com
        </Button>
        <Button variant="outline" className="w-full" onClick={() => navigate('/', { replace: true })}>
          Continue to HearthShelf
        </Button>
      </Shell>
    )
  }

  return (
    <Shell>
      <CardTitle className="text-center text-lg">
        {isAio ? 'Your library is ready' : 'Connect HearthShelf'}
      </CardTitle>

      {isAio && creds && (
        <div className="space-y-2 rounded-md border bg-muted/40 px-4 py-3 text-sm">
          <p className="text-muted-foreground">
            We set up your audiobook server and signed you in. Save these admin
            credentials, then change the password in Settings.
          </p>
          <div className="font-mono">
            <div>user: {creds.username}</div>
            <div>pass: {creds.password}</div>
          </div>
        </div>
      )}

      {(isAio || isAdmin) && (
        <label className="flex items-start gap-3 rounded-md border px-4 py-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={connect}
            onChange={(e) => setConnect(e.target.checked)}
          />
          <span>
            <span className="font-medium">Connect to app.hearthshelf.com</span>
            <span className="block text-muted-foreground">
              Reach your library from anywhere and invite people by email.
              {isAio ? ' Recommended.' : ' Optional.'} You can change this later.
            </span>
          </span>
        </label>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <Button className="w-full" onClick={() => void finish()} disabled={busy}>
        {busy ? 'Setting up…' : connect ? 'Connect and continue' : 'Continue to HearthShelf'}
      </Button>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <Wordmark className="text-3xl" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </div>
  )
}
