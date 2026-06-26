import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import { initAdmin, InitAdminError, markOnboarded, getPublicIp } from '@/api/runtime'
import { createLibrary } from '@/api/admin'
import { startPairing, checkReachability, type ReachabilityResult } from '@/api/hosted'
import { useAuth } from '@/hooks/useAuth'
import { Wordmark } from '@/components/common/Wordmark'
import { Icon } from '@/components/common/Icon'
import { ReachabilityHelp } from '@/components/hosted/ReachabilityHelp'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'

// Map the control plane's machine reason for an invalid URL to a short sentence.
function invalidReason(r: ReachabilityResult['validReason']): string {
  switch (r) {
    case 'not_https':
    case 'not_absolute':
      return 'Must be a full https:// web address.'
    case 'ip_host':
      return 'Use a hostname, not a bare IP address.'
    case 'bad_host':
      return 'Use a public hostname with a domain (not a LAN name).'
    default:
      return 'This address can’t be used.'
  }
}

// The default mount point the AIO image documents for the audiobook volume.
const DEFAULT_LIBRARY_PATH = '/audiobooks'

// AIO wizard step labels, shown in the step rail. Order matches the flow:
// create account -> add a library -> connect.
const AIO_STEPS = ['Account', 'Library', 'Connect']

// The setup wizard a fresh install lands on. Two shapes share this page:
//
//   aio  - HearthShelf bundles ABS in-container. ABS starts uninitialised; the
//          admin CREATES their own account here (we drive ABS /init), then sets
//          up a library, then optionally connects to app.hearthshelf.com. Steps:
//          Account -> Library -> Connect -> Pair -> Done. Connect is its OWN late
//          step (not folded into Account) so we never promise "reach from
//          anywhere" before the reachability test has actually passed.
//
//   slim - the admin already runs their own ABS and signs in first. We don't
//          assume they want app.hearthshelf.com; we offer it, opt-IN. Steps:
//          (login) -> Connect -> Pair.
//
// 'hosted' instances never reach here (the control plane manages onboarding).
type AioStep = 'account' | 'library' | 'connect-aio' | 'pairing' | 'done'

export function OnboardingPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: config, isLoading } = useRuntimeConfig()
  const { isAuthenticated, signIn } = useAuth()

  const isAio = config?.mode === 'aio'

  // ----- shared state -----
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ----- account step (aio) -----
  const [step, setStep] = useState<AioStep>('account')
  const [adminUser, setAdminUser] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [adminPass, setAdminPass] = useState('')
  const [adminPass2, setAdminPass2] = useState('')

  // ----- connect decision -----
  // null = the admin hasn't touched the toggle, so it shows its default (aio:on,
  // slim:off) without an effect syncing state. The effective value is derived
  // below as `connect`.
  const [connectChoice, setConnectChoice] = useState<boolean | null>(null)
  const connect = connectChoice ?? isAio
  // The box's detected public IP, fetched when the Connect step opens. We seed
  // the address field from a real public address, never the LAN origin the
  // browser sees (which can never work from the internet).
  const [detectedIp, setDetectedIp] = useState<string | null>(null)
  // null = the field hasn't been edited, so it shows the seeded value. The seed
  // prefers an explicit PUBLIC_URL, else the detected public IP as an https host
  // - NOT window.location.origin, which is the LAN address.
  const [publicUrlInput, setPublicUrlInput] = useState<string | null>(null)
  const seededUrl = config?.publicUrl ?? (detectedIp ? `https://${detectedIp}` : '')
  const publicUrl = publicUrlInput ?? seededUrl
  const [reach, setReach] = useState<ReachabilityResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  // ----- library step (aio) -----
  const [libName, setLibName] = useState('Audiobooks')
  const [libType, setLibType] = useState<'book' | 'podcast'>('book')
  const [libPath, setLibPath] = useState(DEFAULT_LIBRARY_PATH)

  // ----- pairing step -----
  const [pairCode, setPairCode] = useState<string | null>(null)

  const setPublicUrl = (v: string) => setPublicUrlInput(v)

  // Ask the control plane (via our backend) whether the URL is a reachable HTTPS
  // host. Advisory only - the result never blocks pairing.
  async function runCheck() {
    const url = publicUrl.trim()
    if (!url) {
      setReach(null)
      setCheckError(null)
      return
    }
    setChecking(true)
    setCheckError(null)
    try {
      setReach(await checkReachability({ publicUrl: url }))
    } catch (e) {
      // The check is advisory, so a failure must not block setup - but it should
      // SAY something rather than silently render nothing.
      setReach(null)
      setCheckError(
        e instanceof Error && e.message
          ? `Couldn’t run the check: ${e.message}. You can still connect.`
          : 'Couldn’t reach the checker. You can still connect.'
      )
    } finally {
      setChecking(false)
    }
  }

  function setConnectChecked(next: boolean) {
    setConnectChoice(next)
    if (next && publicUrl && reach === null && !checking) void runCheck()
  }

  // AIO step 1: create the admin account with the user's chosen credentials,
  // then sign in. On success advance to the library step.
  async function submitAccount() {
    setError(null)
    if (adminUser.trim().length < 1) return setError('Choose a username.')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail.trim()))
      return setError('Enter a valid email address.')
    if (adminPass.length < 8) return setError('Password must be at least 8 characters.')
    if (adminPass !== adminPass2) return setError('Passwords don’t match.')

    setBusy(true)
    try {
      await initAdmin({
        username: adminUser.trim(),
        password: adminPass,
        email: adminEmail.trim(),
      })
      // Account created; sign in to populate the full session.
      await signIn(adminUser.trim(), adminPass)
      setStep('library')
    } catch (e) {
      if (e instanceof InitAdminError && e.code === 'already_initialized') {
        setError(
          'This server is already set up. Sign in instead from the login page.'
        )
      } else if (e instanceof InitAdminError && e.code === 'user_create_failed') {
        setError('That username is taken or invalid. Try a different one.')
      } else if (e instanceof InitAdminError && e.code === 'abs_unreachable') {
        setError('Your audiobook server isn’t responding yet. Wait a moment and try again.')
      } else {
        setError('Couldn’t create your account. Please try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  // AIO step 2: create the library (ABS auto-scans it). Advance to the Connect
  // step, where we detect/test reachability BEFORE offering remote access.
  async function submitLibrary() {
    setError(null)
    if (!libName.trim()) return setError('Give your library a name.')
    if (!libPath.trim()) return setError('Enter the folder your audiobooks are in.')

    setBusy(true)
    try {
      await createLibrary({
        name: libName.trim(),
        mediaType: libType,
        fullPath: libPath.trim(),
      })
      await goToConnect()
    } catch {
      setError('Couldn’t create the library. Check the folder path and try again.')
    } finally {
      setBusy(false)
    }
  }

  // Open the Connect step: detect the public IP first so the address field is
  // seeded with a real public address (best-effort; null just leaves it blank).
  async function goToConnect() {
    if (detectedIp === null) {
      const ip = await getPublicIp()
      if (ip) setDetectedIp(ip)
    }
    setStep('connect-aio')
  }

  // Start pairing and show the code. Used by both aio (after library) and slim.
  async function beginPairing() {
    setError(null)
    setBusy(true)
    try {
      const result = await startPairing({
        publicUrl: publicUrl.trim() || config?.publicUrl || window.location.origin,
      })
      setPairCode(result.code)
      await markOnboarded()
      await queryClient.invalidateQueries({ queryKey: ['runtime-config'] })
      setStep('pairing')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t start connecting. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  // Finish a local-only setup: mark onboarded and go straight into the app.
  async function finishLocal() {
    setError(null)
    setBusy(true)
    try {
      await markOnboarded()
      await queryClient.invalidateQueries({ queryKey: ['runtime-config'] })
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup step failed. Please try again.')
      setBusy(false)
    }
  }

  if (isLoading || !config) {
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

  // ----- pairing code screen (shared) -----
  if (step === 'pairing' && pairCode) {
    return (
      <Shell>
        <h1 className="text-center text-lg font-semibold">Almost there</h1>
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

  // ===== AIO step 1: create admin (no connect promise here yet) =====
  if (isAio && step === 'account') {
    return (
      <Shell>
        <StepRail steps={AIO_STEPS} active={0} />
        <Eyebrow>First-run setup</Eyebrow>
        <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Your audiobook server is ready. Set up the account you’ll sign in with.
          Your email is how you’ll log in from anywhere once connected.
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-user">Username</Label>
            <Input
              id="admin-user"
              autoComplete="username"
              value={adminUser}
              onChange={(e) => setAdminUser(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-email">Email</Label>
            <Input
              id="admin-email"
              type="email"
              autoComplete="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-pass">Password</Label>
            <Input
              id="admin-pass"
              type="password"
              autoComplete="new-password"
              value={adminPass}
              onChange={(e) => setAdminPass(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-pass2">Confirm password</Label>
            <Input
              id="admin-pass2"
              type="password"
              autoComplete="new-password"
              value={adminPass2}
              onChange={(e) => setAdminPass2(e.target.value)}
            />
          </div>
        </div>

        <ErrorLine error={error} />

        <Button className="w-full" disabled={busy} onClick={() => void submitAccount()}>
          {busy ? 'Creating account…' : 'Create account and continue'}
        </Button>
      </Shell>
    )
  }

  // ===== AIO step 2: library =====
  if (isAio && step === 'library') {
    return (
      <Shell>
        <StepRail steps={AIO_STEPS} active={1} />
        <Eyebrow>Set up your library</Eyebrow>
        <h1 className="text-2xl font-bold tracking-tight">Add your audiobooks</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Point your server at the folder you mounted. HearthShelf creates the
          library and scans it in the background - you can start browsing right away.
        </p>

        <div className="flex flex-col gap-2">
          <Label htmlFor="lib-name">Library name</Label>
          <Input
            id="lib-name"
            value={libName}
            onChange={(e) => setLibName(e.target.value)}
            placeholder="Audiobooks"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Content type</Label>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={libType === 'book' ? 'default' : 'outline'}
              onClick={() => setLibType('book')}
            >
              Audiobooks
            </Button>
            <Button
              type="button"
              variant={libType === 'podcast' ? 'default' : 'outline'}
              onClick={() => setLibType('podcast')}
            >
              Podcasts
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="lib-path">Folder location</Label>
          <Input
            id="lib-path"
            value={libPath}
            onChange={(e) => setLibPath(e.target.value)}
            className="font-mono text-sm"
          />
          <p className="text-xs leading-snug text-muted-foreground">
            The volume mounted into your container (default{' '}
            <span className="font-mono">/audiobooks</span>). Drop your files here
            from the host.
          </p>
        </div>

        <ErrorLine error={error} />

        <Button className="w-full" disabled={busy || !libName.trim()} onClick={() => void submitLibrary()}>
          {busy ? 'Creating library…' : 'Create library and continue'}
        </Button>
      </Shell>
    )
  }

  // ===== AIO step 3: connect (detect -> test -> confirm) =====
  // We only reach here AFTER the account + library exist, and we never promise
  // "reach from anywhere" until the reachability test has actually passed - so
  // the admin doesn't think setup is done and then hit a firewall wall.
  if (isAio && step === 'connect-aio') {
    const reachable = reach?.valid && reach?.reachable
    return (
      <Shell>
        <StepRail steps={AIO_STEPS} active={2} />
        <Eyebrow>Optional</Eyebrow>
        <h1 className="text-2xl font-bold tracking-tight">Reach your library from anywhere</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Connecting to app.hearthshelf.com lets you open your library away from
          home and invite people by email. First, let’s check your server can be
          reached from the internet - this needs a port open on your router.
        </p>

        <label className="flex items-start gap-3 rounded-md border px-4 py-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={connect}
            onChange={(e) => setConnectChecked(e.target.checked)}
          />
          <span>
            <span className="font-medium">Connect to app.hearthshelf.com</span>
            <span className="block text-muted-foreground">
              Recommended. After connecting we set up a secure web address for you
              automatically (hs.direct) - no domain needed. You can change this later.
            </span>
          </span>
        </label>

        {connect && (
          <div className="space-y-2 rounded-md border px-4 py-3 text-sm">
            <Label htmlFor="public-url">Your server’s public address</Label>
            <div className="flex gap-2">
              <Input
                id="public-url"
                value={publicUrl}
                placeholder="https://books.example.com"
                onChange={(e) => {
                  setPublicUrl(e.target.value)
                  setReach(null)
                  setCheckError(null)
                }}
                onBlur={() => void runCheck()}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={checking || !publicUrl.trim()}
                onClick={() => void runCheck()}
              >
                {checking ? 'Checking…' : 'Test'}
              </Button>
            </div>
            {detectedIp && (
              <p className="text-xs text-muted-foreground">
                Detected your public address from <span className="font-mono">{detectedIp}</span>.
                If you use your own domain or reverse proxy, enter it instead.
              </p>
            )}

            {checkError && <p className="text-amber-500">{checkError}</p>}

            {checking && (
              <p className="text-muted-foreground">
                Checking whether app.hearthshelf.com can reach your server…
              </p>
            )}

            {!checking && reach && reach.valid && reach.reachable && (
              <p className="text-primary">Reachable from the internet. You’re good to connect.</p>
            )}

            {!checking && reach && reach.valid && !reach.reachable && (
              <p className="text-amber-500">
                Your address looks right, but app.hearthshelf.com couldn’t reach it
                ({reach.probeDetail || 'unreachable'}). Open the port on your router,
                or use the guidance below. This is common behind CGNAT or before DNS
                finishes updating.
              </p>
            )}

            {!checking && reach && !reach.valid && (
              <p className="text-amber-500">
                {invalidReason(reach.validReason)} Connecting won’t work until this
                is a public https address - the guidance below covers the easy paths.
              </p>
            )}

            {!checking && reach && !(reach.valid && reach.reachable) && <ReachabilityHelp />}
          </div>
        )}

        <ErrorLine error={error} />

        {connect ? (
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => void beginPairing()}
          >
            {busy ? 'Setting up…' : reachable ? 'Connect and continue' : 'Connect anyway'}
          </Button>
        ) : (
          <Button className="w-full" disabled={busy} onClick={() => void finishLocal()}>
            {busy ? 'Finishing…' : 'Skip - keep it local'}
          </Button>
        )}
      </Shell>
    )
  }

  // ===== Slim: connect decision (admin already signed in) =====
  return (
    <Shell>
      <Eyebrow>Connected to your server</Eyebrow>
      <h1 className="text-2xl font-bold tracking-tight">Connect HearthShelf</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Signed in as admin on your audiobook server. One optional step before
        you’re in.
      </p>

      <ConnectToggle
        connect={connect}
        recommended={false}
        onToggle={setConnectChecked}
        publicUrl={publicUrl}
        setPublicUrl={setPublicUrl}
        reach={reach}
        setReach={setReach}
        checking={checking}
        checkError={checkError}
        clearCheckError={() => setCheckError(null)}
        runCheck={runCheck}
      />

      <ErrorLine error={error} />

      <Button
        className="w-full"
        disabled={busy}
        onClick={() => void (connect ? beginPairing() : finishLocal())}
      >
        {busy ? 'Setting up…' : connect ? 'Connect and continue' : 'Continue to HearthShelf'}
      </Button>
    </Shell>
  )
}

// The app.hearthshelf.com opt-in plus the public-URL reachability check, used by
// the slim connect step. (AIO inlines its own copy with public-IP detection.)
function ConnectToggle({
  connect,
  recommended,
  onToggle,
  publicUrl,
  setPublicUrl,
  reach,
  setReach,
  checking,
  checkError,
  clearCheckError,
  runCheck,
}: {
  connect: boolean
  recommended: boolean
  onToggle: (next: boolean) => void
  publicUrl: string
  setPublicUrl: (v: string) => void
  reach: ReachabilityResult | null
  setReach: (r: ReachabilityResult | null) => void
  checking: boolean
  checkError: string | null
  clearCheckError: () => void
  runCheck: () => void
}) {
  return (
    <div className="space-y-3">
      <label className="flex items-start gap-3 rounded-md border px-4 py-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={connect}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>
          <span className="font-medium">Connect to app.hearthshelf.com</span>
          <span className="block text-muted-foreground">
            Reach your library from anywhere and invite people by email.
            {recommended ? ' Recommended.' : ' Optional.'} You can change this later.
          </span>
        </span>
      </label>

      {connect && (
        <div className="space-y-2 rounded-md border px-4 py-3 text-sm">
          <Label htmlFor="public-url">Your server’s public address</Label>
          <div className="flex gap-2">
            <Input
              id="public-url"
              value={publicUrl}
              placeholder="https://books.example.com"
              onChange={(e) => {
                setPublicUrl(e.target.value)
                setReach(null)
                clearCheckError()
              }}
              onBlur={() => void runCheck()}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={checking || !publicUrl.trim()}
              onClick={() => void runCheck()}
            >
              {checking ? 'Checking…' : 'Check'}
            </Button>
          </div>

          {checkError && <p className="text-amber-500">{checkError}</p>}

          {checking && (
            <p className="text-muted-foreground">
              Checking whether app.hearthshelf.com can reach your server…
            </p>
          )}

          {!checking && reach && reach.valid && reach.reachable && (
            <p className="text-primary">Reachable from the internet. You’re good to connect.</p>
          )}

          {!checking && reach && reach.valid && !reach.reachable && (
            <p className="text-amber-500">
              Your address looks right, but app.hearthshelf.com couldn’t reach it
              ({reach.probeDetail || 'unreachable'}). This is common behind CGNAT
              or before DNS finishes updating - you can connect now and fix it later.
            </p>
          )}

          {!checking && reach && !reach.valid && (
            <p className="text-amber-500">
              {invalidReason(reach.validReason)} Pairing on app.hearthshelf.com
              won’t work until this is a public https address.
            </p>
          )}

          {!checking && reach && !(reach.valid && reach.reachable) && <ReachabilityHelp />}
        </div>
      )}
    </div>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-light uppercase tracking-[0.32em] text-muted-foreground">
      {children}
    </div>
  )
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p className="text-sm text-destructive" role="alert">
      {error}
    </p>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-5 pb-28 pt-12">
      {/* Ambient page glow - two stacked radial blobs behind everything. */}
      <div
        aria-hidden
        className="hs-onboard-glow pointer-events-none absolute left-1/2 top-[-260px] h-[560px] w-[820px] -translate-x-1/2"
        style={{
          background:
            'radial-gradient(ellipse at center, color-mix(in oklab, var(--primary) 40%, transparent), transparent 66%)',
          filter: 'blur(46px)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-190px] h-[360px] w-[460px] -translate-x-1/2"
        style={{
          background:
            'radial-gradient(ellipse at center, color-mix(in oklab, var(--brand-hearth) 30%, transparent), transparent 64%)',
          filter: 'blur(40px)',
        }}
      />

      {/* Flame + wordmark, above the card (matches the sidebar brand lockup). */}
      <div className="relative z-10 mb-7 flex items-center gap-3">
        <img
          src="/flame.png"
          alt=""
          className="h-[30px] w-[30px] object-contain"
          style={{
            filter: 'drop-shadow(0 0 14px color-mix(in oklab, var(--brand-hearth) 55%, transparent))',
          }}
        />
        <Wordmark className="text-[25px]" />
      </div>

      <Card className="relative z-10 w-full max-w-md shadow-[var(--shadow-lift)]">
        <CardContent className="flex flex-col gap-4 pt-6">{children}</CardContent>
      </Card>
    </div>
  )
}

// The numbered step rail shown at the top of each wizard card. `steps` are the
// labels in order; `active` is the zero-based index of the current step. Done
// steps show a check, the active one is ringed, upcoming ones are muted.
function StepRail({ steps, active }: { steps: string[]; active: number }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-1.5">
      {steps.map((label, i) => {
        const done = i < active
        const current = i === active
        return (
          <div key={label} className="flex min-w-0 flex-none items-center gap-2">
            <span
              className={
                'grid h-[25px] w-[25px] flex-none place-items-center rounded-full text-xs font-bold ' +
                (done
                  ? 'bg-primary text-primary-foreground'
                  : current
                    ? 'border-[1.5px] border-primary bg-primary/15 text-primary'
                    : 'border-[1.5px] border-border bg-muted text-muted-foreground')
              }
            >
              {done ? <Icon name="check" fill className="text-[15px]" /> : i + 1}
            </span>
            <span
              className={
                'whitespace-nowrap text-xs font-semibold tracking-tight ' +
                (current ? 'text-foreground' : 'text-muted-foreground')
              }
            >
              {label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
