import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import {
  initAdmin,
  InitAdminError,
  markOnboarded,
  getPublicIp,
  setServerName as saveServerName,
  restoreFromBackup,
  type RestoreSummary,
} from '@/api/runtime'
import { createLibrary, checkFolderExists, updateUser, updateServerSettings } from '@/api/admin'
import {
  startPairing,
  checkReachability,
  getHsDirectState,
  pollPairStatus,
  type HsDirectState,
  type PairStatus,
  HostedError,
  type ReachabilityResult,
} from '@/api/hosted'
import { useAuth } from '@/hooks/useAuth'
import { Wordmark } from '@/components/common/Wordmark'
import { Icon } from '@/components/common/Icon'
import { ReachabilityHelp } from '@/components/hosted/ReachabilityHelp'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'

// Turn a hosted/pairing failure into a sentence a person can act on. We never
// surface the raw machine code (e.g. "pairing_start_failed") to the user.
function pairingErrorMessage(e: unknown): string {
  const code = e instanceof HostedError ? e.code : ''
  switch (code) {
    case 'network':
    case 'control_plane_unreachable':
      return 'Couldn’t reach app.hearthshelf.com. Check your internet connection and try again.'
    case 'public_url_required':
      return 'Enter your server’s public web address before connecting.'
    case 'reachability_check_failed':
      return 'app.hearthshelf.com couldn’t check your address right now. You can still connect.'
    case 'pairing_start_failed':
      return 'app.hearthshelf.com couldn’t start connecting right now. Please try again in a moment.'
    case 'address_setup_failed':
    case 'address_update_failed':
      return 'Couldn’t set up your secure web address. Make sure your server is reachable from the internet (forward the port), then try again.'
    default:
      return 'Something went wrong connecting to app.hearthshelf.com. Please try again.'
  }
}

// The default mount point the AIO image documents for the audiobook volume.
const DEFAULT_LIBRARY_PATH = '/audiobooks'

// Step-rail labels per mode. AIO: name -> account -> library -> connect. Slim:
// (the admin already has an account) name -> connect, with an email step folded
// in only when their ABS account is missing one.
const AIO_STEPS = ['Name', 'Account', 'Library', 'Connect']
const SLIM_STEPS = ['Name', 'Connect']
const SLIM_STEPS_EMAIL = ['Email', 'Name', 'Connect']

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
// Wizard steps. AIO uses name -> account -> library -> connect-aio -> pairing.
// Slim uses (email if missing) -> name -> connect-aio -> pairing. 'connect-aio'
// + 'pairing' are shared across modes despite the name.
type AioStep =
  | 'name'
  | 'slim-email'
  | 'account'
  | 'restore'
  | 'library'
  | 'connect-aio'
  | 'pairing'
  | 'done'

export function OnboardingPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: config, isLoading } = useRuntimeConfig()
  const { isAuthenticated, signIn, user } = useAuth()

  const isAio = config?.mode === 'aio'

  // ----- shared state -----
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ----- step machine (aio) -----
  // The dev rerun hatch (/hs/rerun-onboarding) lands on ?step=connect so we can
  // iterate on the connect step without re-walking the earlier steps. Maps the
  // friendly 'connect' param to the internal 'connect-aio' step.
  const [step, setStep] = useState<AioStep>(() => {
    const p = new URLSearchParams(window.location.search).get('step')
    if (p === 'connect') return 'connect-aio'
    if (p === 'name' || p === 'library' || p === 'account') return p
    return 'name'
  })
  // ----- name step (aio): how the server is referred to everywhere (Plex-style) -----
  const [serverName, setServerName] = useState('')
  const [adminUser, setAdminUser] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [adminPass, setAdminPass] = useState('')
  const [adminPass2, setAdminPass2] = useState('')
  // Slim: set once we've saved an email this session, so the email guard doesn't
  // re-trap the name step (the cached user object won't reflect the new email).
  const [emailJustSet, setEmailJustSet] = useState(false)

  // ----- restore-from-backup step (aio first-run) -----
  const [restoreSummary, setRestoreSummary] = useState<RestoreSummary | null>(null)

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
  // Folder-exists check: idle until validated; tri-state result is advisory and
  // never blocks creation (a missing folder just warns - ABS will also reject it).
  const [pathState, setPathState] = useState<
    'idle' | 'checking' | 'exists' | 'missing' | 'unknown'
  >('idle')

  // ----- backups (final step opt-in) -----
  // On AIO we own the bundled ABS, so nightly auto-backups are enabled by
  // default (opt-out) when the wizard finishes. On Slim we never silently touch
  // a foreign ABS's settings - we only recommend it (see the connect step card).
  const [enableBackups, setEnableBackups] = useState(true)

  // ----- pairing / verify step -----
  const [pairCode, setPairCode] = useState<string | null>(null)
  // hs.direct provisioning, polled after pairing until the cert is ready.
  const [hsDirect, setHsDirect] = useState<HsDirectState | null>(null)
  // Claim state, polled until a signed-in user redeems the code on the web app.
  const [pairStatus, setPairStatus] = useState<PairStatus | null>(null)

  const setPublicUrl = (v: string) => setPublicUrlInput(v)

  // While on the pairing screen, poll hs.direct until it goes 'active' (or the
  // user opts out / it's an own-domain setup). The interval is the legitimate
  // effect use - the setState happens in the async callback, not in the body.
  const onPairingScreen = step === 'pairing' && !!pairCode
  const ownDomain = !!publicUrlInput?.trim()
  useEffect(() => {
    if (!onPairingScreen || ownDomain) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const state = await getHsDirectState().catch(() => null)
      if (cancelled) return
      if (state) setHsDirect(state)
      if (!state || state.status !== 'active') timer = setTimeout(poll, 4000)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [onPairingScreen, ownDomain])

  // While showing the code, poll the control plane until a signed-in user claims
  // the server. Once claimed we stop polling and the screen shows the connected
  // state + diagnostics (referring to the server by name).
  const claimed = pairStatus?.claimed ?? false
  useEffect(() => {
    if (!onPairingScreen || !pairCode || claimed) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const s = await pollPairStatus(pairCode).catch(() => null)
      if (cancelled) return
      if (s) setPairStatus(s)
      if (!s || !s.claimed) timer = setTimeout(poll, 4000)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [onPairingScreen, pairCode, claimed])

  // Ask the control plane (via our backend) whether a URL is reachable. Advisory.
  // Defaults to the connect field's URL; the Verify step passes the hs.direct
  // address explicitly (a real hostname the probe accepts, unlike a bare IP).
  async function runCheck(target?: string) {
    const url = (target ?? publicUrl).trim()
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
      // SAY something (in plain language, never the raw code) rather than
      // silently render nothing.
      setReach(null)
      setCheckError(pairingErrorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  function setConnectChecked(next: boolean) {
    setConnectChoice(next)
  }

  // Name the server: persist it (HS's own state + the pairing default) and
  // advance. AIO goes on to create the account; slim (already signed in) goes
  // straight to connect.
  async function submitName() {
    setError(null)
    if (serverName.trim().length < 2) return setError('Give your server a name.')
    setBusy(true)
    try {
      await saveServerName(serverName.trim())
      await queryClient.invalidateQueries({ queryKey: ['runtime-config'] })
      setStep(isAio ? 'account' : 'connect-aio')
    } catch {
      setError('Couldn’t save the name. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  // Slim only: the admin's ABS account has no email, which hosted login matches
  // on. Set it before naming/connecting.
  async function submitEmail() {
    setError(null)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail.trim()))
      return setError('Enter a valid email address.')
    if (!user?.id) return setError('Couldn’t read your account. Try signing in again.')
    setBusy(true)
    try {
      await updateUser(user.id, { email: adminEmail.trim() })
      setEmailJustSet(true)
      setStep('name')
    } catch {
      setError('Couldn’t save your email. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  // AIO step 2: create the admin account with the user's chosen credentials,
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
        setError('This server is already set up. Sign in instead from the login page.')
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

  // Validate the audiobook folder exists inside the container. Advisory: a
  // 'missing'/'unknown' result warns but never blocks creating the library.
  async function validatePath() {
    const p = libPath.trim()
    if (!p) {
      setPathState('idle')
      return
    }
    setPathState('checking')
    setPathState(await checkFolderExists(p))
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
      // Only send a public URL when the admin explicitly entered their own domain.
      // Otherwise leave it to the backend, which provisions + supplies the
      // hs.direct address. (Sending the seeded bare IP here was the bug that made
      // pairing demand a domain.)
      const result = await startPairing({
        publicUrl: publicUrlInput?.trim() || undefined,
        name: serverName.trim() || undefined,
      })
      setPairCode(result.code)
      await applyBackupOptIn()
      await markOnboarded()
      await queryClient.invalidateQueries({ queryKey: ['runtime-config'] })
      setStep('pairing')
    } catch (e) {
      setError(pairingErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  // On AIO, turn on nightly ABS auto-backups (ABS's own conventions: 1:30 AM,
  // keep 2) if the admin left the opt-in checked. Best-effort - a backup-schedule
  // failure must never block finishing onboarding. No-op on Slim (we don't touch
  // a foreign ABS's settings; the connect step only recommends it there).
  async function applyBackupOptIn() {
    if (!isAio || !enableBackups) return
    try {
      await updateServerSettings({ backupSchedule: '30 1 * * *', backupsToKeep: 2 })
    } catch {
      // non-fatal; the admin can turn backups on later from Config > Backups
    }
  }

  // AIO restore-from-backup: upload the file, run the restore, and show the
  // summary. On success the box is set up; the admin signs in with the RESTORED
  // credentials (the ABS restore replaced the users table), so we route to login
  // from the summary rather than trying to auto-sign-in.
  async function submitRestore(file: File) {
    setError(null)
    setBusy(true)
    try {
      const summary = await restoreFromBackup(file)
      setRestoreSummary(summary)
      await queryClient.invalidateQueries({ queryKey: ['runtime-config'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed. Please check the file and try again.')
    } finally {
      setBusy(false)
    }
  }

  // Finish a local-only setup: mark onboarded and go straight into the app.
  async function finishLocal() {
    setError(null)
    setBusy(true)
    try {
      await applyBackupOptIn()
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

  // Slim flow uses a shorter rail; email step only when the admin has no email
  // (hosted login matches on it). connect-aio + pairing are shared across modes.
  const needsEmail = !isAio && !user?.email && !emailJustSet
  const stepsForMode = isAio ? AIO_STEPS : needsEmail ? SLIM_STEPS_EMAIL : SLIM_STEPS
  // Index of the current step within the active rail, for the StepRail highlight.
  const railIndex = (s: AioStep): number => {
    const map: Partial<Record<AioStep, number>> = isAio
      ? { name: 0, account: 1, library: 2, 'connect-aio': 3 }
      : needsEmail
        ? { 'slim-email': 0, name: 1, 'connect-aio': 2 }
        : { name: 0, 'connect-aio': 1 }
    return map[s] ?? 0
  }

  // ----- pairing screen: phase 1 (waiting for the claim) then phase 2 (claimed
  // -> plain-language reachability). We never show the technical hs.direct host;
  // the server is referred to by its name. -----
  if (step === 'pairing' && pairCode) {
    const label = serverName.trim() || pairStatus?.name || 'your server'

    // Phase 2: a signed-in user has claimed the server. Show the connected state
    // and, for the auto-address path, whether it's reachable from outside.
    if (claimed) {
      const hsReady = ownDomain || hsDirect?.status === 'active'
      const reachUrl = ownDomain ? publicUrlInput?.trim() : (hsDirect?.publicUrl ?? undefined)
      const reachOk = reach?.reachable
      return (
        <Shell>
          <div className="flex flex-col items-center gap-2 text-center">
            <Icon name="check_circle" fill className="text-[32px] text-primary" />
            <h1 className="text-xl font-semibold">{label} is connected</h1>
            <p className="text-sm text-muted-foreground">
              {pairStatus?.claimedByEmail
                ? `Linked to ${pairStatus.claimedByEmail}. You can now reach it from the HearthShelf app.`
                : 'You can now reach it from the HearthShelf app.'}
            </p>
          </div>

          {!ownDomain && hsDirect?.status === 'pending' && (
            <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <span className="hs-onboard-glow inline-block h-2 w-2 rounded-full bg-primary" />
              Finishing the secure connection…
            </p>
          )}

          {hsReady && (
            <div className="space-y-2 rounded-md border px-4 py-3 text-sm">
              <div className="font-medium">Can people reach {label} from outside your home?</div>
              {!reach && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={checking || !reachUrl}
                  onClick={() => void runCheck(reachUrl)}
                >
                  {checking ? 'Checking…' : 'Check now'}
                </Button>
              )}
              {checkError && <p className="text-amber-500">{checkError}</p>}
              {reach && reachOk && (
                <p className="flex items-center gap-1.5 text-primary">
                  <Icon name="check_circle" fill className="text-[15px]" />
                  Yes - {label} is reachable from anywhere.
                </p>
              )}
              {reach && !reachOk && (
                <>
                  <p className="text-amber-500">
                    Not yet. {label} works on your home network, but to reach it from outside, your
                    router needs to send incoming connections to this machine (forward port 443).
                  </p>
                  <ReachabilityHelp />
                </>
              )}
            </div>
          )}

          <Button className="w-full" onClick={() => navigate('/', { replace: true })}>
            Continue to HearthShelf
          </Button>
        </Shell>
      )
    }

    // Phase 1: waiting for the admin to enter the code + sign in on the web app.
    return (
      <Shell>
        <h1 className="text-center text-lg font-semibold">Almost there</h1>
        <p className="text-sm text-muted-foreground">
          Open the HearthShelf app, sign in, and enter this code to connect <strong>{label}</strong>{' '}
          to your account.
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
          Open the HearthShelf app
        </Button>
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <span className="hs-onboard-glow inline-block h-2 w-2 rounded-full bg-primary" />
          Waiting for you to confirm in the app…
        </p>
        <Button variant="ghost" className="w-full" onClick={() => navigate('/', { replace: true })}>
          I’ll finish this later
        </Button>
      </Shell>
    )
  }

  // ===== Slim email step: set the admin's email if missing (hosted login key) =====
  if (!isAio && needsEmail && step !== 'connect-aio' && step !== 'pairing') {
    return (
      <Shell>
        <StepRail steps={stepsForMode} active={railIndex('slim-email')} />
        <Eyebrow>Connect setup</Eyebrow>
        <h1 className="text-2xl font-bold tracking-tight">Add your email</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Connecting lets you sign in from anywhere by email. Add one to your admin account to
          continue.
        </p>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void submitEmail()
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="slim-email">Email</Label>
            <Input
              id="slim-email"
              type="email"
              autoFocus
              autoComplete="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <ErrorLine error={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Continue'}
          </Button>
        </form>
      </Shell>
    )
  }

  // ===== Name the server (shared: AIO step 1, slim after email) =====
  if (step === 'name') {
    return (
      <Shell>
        <StepRail steps={stepsForMode} active={railIndex('name')} />
        <Eyebrow>{isAio ? 'First-run setup' : 'Connect setup'}</Eyebrow>
        <h1 className="text-2xl font-bold tracking-tight">Name your server</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Give your library a name. This is how it shows up for you and anyone you invite - like
          “Living Room Library” or “The Smith Family Shelf.”
        </p>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void submitName()
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="server-name">Server name</Label>
            <Input
              id="server-name"
              autoFocus
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="Living Room Library"
            />
          </div>
          <ErrorLine error={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Continue'}
          </Button>
        </form>
      </Shell>
    )
  }

  // ===== AIO step 2: create admin (no connect promise here yet) =====
  if (isAio && step === 'account') {
    return (
      <Shell>
        <StepRail steps={stepsForMode} active={railIndex('account')} />
        <Eyebrow>First-run setup</Eyebrow>
        <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Your audiobook server is ready. Set up the account you’ll sign in with. Your email is how
          you’ll log in from anywhere once connected.
        </p>

        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void submitAccount()
          }}
        >
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

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account and continue'}
          </Button>
        </form>

        {config?.restoreAvailable && (
          <p className="text-center text-sm text-muted-foreground">
            Moving from another server or recovering from a crash?{' '}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                setError(null)
                setStep('restore')
              }}
            >
              Restore from a backup instead
            </button>
          </p>
        )}
      </Shell>
    )
  }

  // ===== AIO first-run: restore from a backup (M1 / M2) =====
  if (isAio && step === 'restore') {
    // After a successful restore, show the honest summary + next actions.
    if (restoreSummary) {
      const s = restoreSummary
      const rec = s.reconcile
      return (
        <Shell>
          <Eyebrow>Restored</Eyebrow>
          <h1 className="text-2xl font-bold tracking-tight">Here’s what came back</h1>

          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex items-start gap-2">
              <Icon
                name={s.absRestored ? 'check_circle' : 'cancel'}
                className={`mt-0.5 text-[18px] ${s.absRestored ? 'text-green-500' : 'text-muted-foreground'}`}
              />
              <span>
                {s.absRestored
                  ? 'Your library, users, and listening progress are restored.'
                  : 'AudiobookShelf data was not restored.'}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Icon
                name={s.hsRestored ? 'check_circle' : 'info'}
                className={`mt-0.5 text-[18px] ${s.hsRestored ? 'text-green-500' : 'text-muted-foreground'}`}
              />
              <span>
                {s.hsRestored
                  ? 'HearthShelf’s data (clubs, notes, reading history, settings) is restored.'
                  : 'HearthShelf features (clubs, notes, settings sync) start fresh - the backup had no HearthShelf data.'}
              </span>
            </li>
          </ul>

          {/* Sharp-edge warnings from the reconcile step. */}
          {rec?.serviceRootMissing && (
            <div className="rounded-md border px-4 py-3 text-sm">
              <p className="font-medium">HearthShelf’s service account needs to be recreated</p>
              <p className="text-muted-foreground">
                The restore replaced the user list, so some HearthShelf background features
                (recommendations, downloads) won’t work until it’s recreated. You can do this from
                Settings &gt; Users after signing in.
              </p>
            </div>
          )}
          {rec?.items?.zeroMatch && (
            <div className="rounded-md border border-amber-500/40 px-4 py-3 text-sm">
              <p className="font-medium">Your audiobook files may be in a new location</p>
              <p className="text-muted-foreground">
                None of the restored library items matched files on disk. If you moved your audio to
                a new drive, HearthShelf history may not line up until the library is re-linked.
              </p>
            </div>
          )}
          {s.warnings.map((w, i) => (
            <p key={i} className="text-sm text-muted-foreground">
              {w}
            </p>
          ))}

          <div className="rounded-md bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
            {s.userCount != null && s.userCount > 0 ? (
              <>
                All{' '}
                <span className="font-medium text-foreground">{s.userCount}</span> restored{' '}
                {s.userCount === 1 ? 'account keeps its' : 'accounts keep their'} original password.
                Sign in with the username and password from{' '}
                <span className="font-medium text-foreground">the server you backed up</span>.
              </>
            ) : (
              <>
                Sign in with the username and password from{' '}
                <span className="font-medium text-foreground">the server you backed up</span> - not
                the temporary setup account.
              </>
            )}
          </div>

          <Button className="w-full" onClick={() => navigate('/login', { replace: true })}>
            Go to sign in
          </Button>
        </Shell>
      )
    }

    // Upload form.
    return (
      <Shell>
        <Eyebrow>First-run setup</Eyebrow>
        <h1 className="text-2xl font-bold tracking-tight">Restore from a backup</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Upload a HearthShelf archive (<code>.hsarchive</code>) or an AudiobookShelf backup
          (<code>.audiobookshelf</code>). We’ll rebuild your server from it. Make sure your audiobook
          files are mounted first - they aren’t inside the backup.
        </p>

        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 text-center text-sm">
          <Icon name="upload_file" className="text-2xl text-muted-foreground" />
          <span className="font-medium">Choose a backup file</span>
          <span className="text-muted-foreground">.hsarchive or .audiobookshelf</span>
          <input
            type="file"
            accept=".hsarchive,.audiobookshelf,.zip"
            hidden
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void submitRestore(f)
              e.target.value = ''
            }}
          />
        </label>

        {busy && (
          <p className="text-center text-sm text-muted-foreground">
            Restoring… this can take a minute for a large library.
          </p>
        )}
        <ErrorLine error={error} />

        <button
          type="button"
          className="text-center text-sm text-muted-foreground underline underline-offset-2"
          disabled={busy}
          onClick={() => {
            setError(null)
            setStep('account')
          }}
        >
          Back to creating an account
        </button>
      </Shell>
    )
  }

  // ===== AIO step 2: library =====
  if (isAio && step === 'library') {
    return (
      <Shell>
        <StepRail steps={stepsForMode} active={railIndex('library')} />
        <Eyebrow>Set up your library</Eyebrow>
        <h1 className="text-2xl font-bold tracking-tight">Add your audiobooks</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Point your server at the folder you mounted. HearthShelf creates the library and scans it
          in the background - you can start browsing right away.
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
            onChange={(e) => {
              setLibPath(e.target.value)
              setPathState('idle')
            }}
            onBlur={() => void validatePath()}
            className="font-mono text-sm"
          />
          {pathState === 'checking' && (
            <p className="text-xs text-muted-foreground">Checking folder…</p>
          )}
          {pathState === 'exists' && (
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <Icon name="check_circle" fill className="text-[14px]" />
              Folder found.
            </p>
          )}
          {pathState === 'missing' && (
            <p className="flex items-center gap-1.5 text-xs text-amber-500">
              <Icon name="error" className="text-[14px]" />
              No folder at that path inside the container. Check your volume mount.
            </p>
          )}
          <p className="text-xs leading-snug text-muted-foreground">
            The volume mounted into your container (default{' '}
            <span className="font-mono">/audiobooks</span>). Drop your files here from the host.
          </p>
        </div>

        <ErrorLine error={error} />

        <Button
          className="w-full"
          disabled={busy || !libName.trim()}
          onClick={() => void submitLibrary()}
        >
          {busy ? 'Creating library…' : 'Create library and continue'}
        </Button>
      </Shell>
    )
  }

  // ===== AIO step 3: connect (detect -> test -> confirm) =====
  // We only reach here AFTER the account + library exist, and we never promise
  // "reach from anywhere" until the reachability test has actually passed - so
  // the admin doesn't think setup is done and then hit a firewall wall.
  if (step === 'connect-aio') {
    return (
      <Shell>
        <StepRail steps={stepsForMode} active={railIndex('connect-aio')} />
        <Eyebrow>Optional</Eyebrow>
        <h1 className="text-2xl font-bold tracking-tight">Reach your library from anywhere</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Connecting to app.hearthshelf.com lets you open your library away from home and invite
          people by email. We set up a secure web address for you automatically - you don’t need a
          domain.
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
              Recommended. You can turn this off later in Settings.
            </span>
          </span>
        </label>

        {connect && (
          <div className="space-y-3 rounded-md border px-4 py-3 text-sm">
            {/* hs.direct handles the address + certificate after pairing, so we
                don't ask for a URL here. The one thing the user may need to do is
                forward a port - stated up front, then verified after pairing
                against the real hs.direct hostname (the IP can't be probed). */}
            <div className="flex items-start gap-2.5">
              <Icon name="lan" className="mt-0.5 text-[18px] text-muted-foreground" />
              <p className="text-muted-foreground">
                For access from outside your home, your router needs to forward
                <span className="font-medium text-foreground"> port 443</span> to this machine.
                We’ll check it for you right after connecting.
              </p>
            </div>

            {/* Advanced: a reverse-proxy / own-domain user can override the
                address hs.direct would otherwise provide. Tucked away so the
                common path never has to think about URLs. */}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Use my own domain instead
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <Input
                  id="public-url"
                  value={publicUrlInput ?? ''}
                  placeholder="https://books.example.com"
                  onChange={(e) => setPublicUrl(e.target.value)}
                />
                <p className="text-muted-foreground">
                  Only if you run a reverse proxy with your own HTTPS certificate. Leave blank to
                  use the address we set up for you.
                </p>
              </div>
            </details>
          </div>
        )}

        {/* Backups: AIO owns the bundled ABS, so offer an opt-OUT toggle that
            turns on nightly auto-backups. Slim points at a foreign ABS we won't
            silently change, so show a recommendation instead of a toggle. */}
        {isAio ? (
          <label className="flex items-start gap-3 rounded-md border px-4 py-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={enableBackups}
              onChange={(e) => setEnableBackups(e.target.checked)}
            />
            <span>
              <span className="font-medium">Back up my library every night</span>
              <span className="block text-muted-foreground">
                Recommended. Keeps the last 2 automatic backups of your AudiobookShelf data. You can
                change this any time in Settings &gt; Backups.
              </span>
            </span>
          </label>
        ) : (
          <div className="flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm">
            <Icon name="cloud_sync" className="mt-0.5 text-[18px] text-muted-foreground" />
            <p className="text-muted-foreground">
              Tip: turn on automatic backups in Settings &gt; Backups so your data is protected.
              AudiobookShelf ships with them off.
            </p>
          </div>
        )}

        <ErrorLine error={error} />

        {connect ? (
          <Button className="w-full" disabled={busy} onClick={() => void beginPairing()}>
            {busy ? 'Setting up…' : 'Connect and continue'}
          </Button>
        ) : (
          <Button className="w-full" disabled={busy} onClick={() => void finishLocal()}>
            {busy ? 'Finishing…' : 'Skip - keep it local'}
          </Button>
        )}
      </Shell>
    )
  }

  // Fallback: every real step is handled above (slim flows name -> connect-aio,
  // AIO name -> account -> library -> connect-aio). If state is briefly between
  // steps, show a neutral loading frame rather than a blank screen.
  return (
    <div className="flex min-h-screen items-center justify-center text-muted-foreground">
      Loading…
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
            filter:
              'drop-shadow(0 0 14px color-mix(in oklab, var(--brand-hearth) 55%, transparent))',
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
