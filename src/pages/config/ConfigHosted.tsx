import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useToast } from '@/hooks/useToast'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import { ReachabilityHelp } from '@/components/hosted/ReachabilityHelp'
import { ConnectivityDiagram } from '@/components/hosted/ConnectivityDiagram'
import {
  getHostedStatus,
  startPairing,
  inviteFromServer,
  getHsDirectState,
  checkPort,
  pollPairStatus,
  disconnectHosted,
  type PairResult,
  type PortCheckResult,
} from '@/api/hosted'

// "12:34" style mm:ss left until the pairing code expires, or null once gone.
function timeLeft(expiresAt: number, nowMs: number): string | null {
  const ms = expiresAt - nowMs
  if (ms <= 0) return null
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Connect this self-hosted instance to app.hearthshelf.com so people can reach
// it from one place (like signing in to your Plex account), and invite people
// to it by email. The actual accounts and access live on the control plane;
// here we just pair and send invites.
export function ConfigHosted() {
  const qc = useQueryClient()
  const { toast, show } = useToast()
  const { data: runtime } = useRuntimeConfig()

  const { data: status, isLoading } = useQuery({
    queryKey: ['hosted-status'],
    queryFn: getHostedStatus,
    staleTime: 15 * 1000,
  })

  const [pairResult, setPairResult] = useState<PairResult | null>(null)
  // True once a signed-in user has redeemed the code on app.hearthshelf.com.
  const [claimed, setClaimed] = useState(false)

  // Tick once a second so the code's expiry countdown stays live. The interval
  // updates nowMs; no synchronous set in the effect body (it would re-render in a
  // loop and trips the lint rule).
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!pairResult) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [pairResult])

  const remaining = pairResult ? timeLeft(pairResult.expires_at, nowMs) : null

  function copyCode() {
    if (!pairResult) return
    void navigator.clipboard.writeText(pairResult.code)
    show('Code copied')
  }

  function openControlPlane() {
    if (!pairResult) return
    const base = (pairResult.control_plane || runtime?.controlPlaneUrl || '').replace(/\/$/, '')
    if (!base) return
    window.open(`${base}/pair?code=${encodeURIComponent(pairResult.code)}`, '_blank', 'noopener')
  }
  const pair = useMutation({
    mutationFn: () => startPairing(),
    onSuccess: (r) => {
      setClaimed(false)
      setPairResult(r)
      qc.invalidateQueries({ queryKey: ['hosted-status'] })
      show('Pairing started - enter the code on app.hearthshelf.com')
    },
    onError: (e: Error) => show(e.message || 'Could not start pairing'),
  })

  const disconnect = useMutation({
    mutationFn: () => disconnectHosted(),
    onSuccess: () => {
      setPairResult(null)
      setClaimed(false)
      qc.invalidateQueries({ queryKey: ['hosted-status'] })
      qc.invalidateQueries({ queryKey: ['hsdirect-state'] })
      show('Disconnected from app.hearthshelf.com')
    },
    onError: (e: Error) => show(e.message || 'Could not disconnect'),
  })

  // hs.direct provisioning: the assigned *.hs.direct address + cert state. Poll
  // while it's still coming up (pending) so the address appears once ready.
  const { data: hsDirect } = useQuery({
    queryKey: ['hsdirect-state'],
    queryFn: getHsDirectState,
    staleTime: 10 * 1000,
    refetchInterval: (q) =>
      q.state.data && q.state.data.status === 'pending' ? 4000 : false,
  })

  // Port reachability via the hs.direct VPS - it connects back to this box's
  // public IP on the port we're exposed on. Works even before the cert is ready
  // (no hostname needed), unlike the old control-plane hostname probe. Advisory.
  const [portResult, setPortResult] = useState<PortCheckResult | null>(null)
  const testPort = useMutation({
    mutationFn: () => checkPort(),
    onSuccess: (r) => setPortResult(r),
    onError: () => show('Could not run the connection check'),
  })

  // Auto-run the connection check on page load once the server is paired, so the
  // admin sees reachability without clicking Check. Fires only when we don't yet
  // have a known-good result this session (paired, no port result, not already in
  // flight). The mutate() lives in the async-safe effect body via a guard, not a
  // synchronous setState, so the set-state-in-effect lint rule is satisfied.
  const portChecked = portResult !== null
  useEffect(() => {
    if (!status?.paired) return
    if (portChecked || testPort.isPending) return
    testPort.mutate()
    // testPort is a stable mutation object; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.paired, portChecked])

  // Poll the control plane for the claim while a code is showing. As soon as the
  // admin redeems it on app.hearthshelf.com we detect it here and the server is
  // connected - no post-pair step needed (users get a per-user ABS token on demand
  // via /hs/hosted/connect; there's no OIDC to configure). On claim we dismiss the
  // whole pairing block; the top row then shows "Connected to app.hearthshelf.com".
  // The setState happens in the async callback (not the effect body), so the lint
  // rule is satisfied.
  useEffect(() => {
    const code = pairResult?.code
    if (!code || claimed) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const s = await pollPairStatus(code).catch(() => null)
      if (cancelled) return
      if (s?.claimed) {
        setClaimed(true)
        qc.invalidateQueries({ queryKey: ['hosted-status'] })
        setPairResult(null)
        show('Connected to app.hearthshelf.com')
        return // stop polling
      }
      if (!s || !s.expired) timer = setTimeout(poll, 4000)
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pairResult?.code, claimed, qc])

  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'user'>('user')
  const invite = useMutation({
    mutationFn: () => inviteFromServer(email.trim(), role),
    onSuccess: (r) => {
      show(r.emailed ? `Invited ${r.email} - email sent` : `Invited ${r.email}`)
      setEmail('')
    },
    onError: (e: Error) => show(e.message || 'Invite failed'),
  })

  if (isLoading || !status) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">HearthShelf Connect</h1>
        </div>
        <LoadingSpinner className="py-12" label="Loading..." />
      </>
    )
  }

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">HearthShelf Connect</h1>
        <p className="page-sub">
          Connect this server to app.hearthshelf.com so people can reach it from
          one place, and invite people to it by email.
        </p>
      </div>

      <div className="section-head">
        <Icon name="link" />
        <h2>Connection</h2>
      </div>
      <div className="cfg-card">
        <div className="set-row">
          <div className="sr-meta">
            <div className="sr-t">
              {status.paired ? 'Connected to app.hearthshelf.com' : 'Not connected'}
            </div>
            <div className="sr-d">
              {status.paired
                ? `${runtime?.serverName || 'This server'} is reachable from the HearthShelf app, and you can invite people by email.`
                : 'Connect this server so you and people you invite can reach it from app.hearthshelf.com.'}
            </div>
          </div>
          {status.paired ? (
            <button
              className="btn btn-danger"
              disabled={disconnect.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'Disconnect from app.hearthshelf.com? People you invited will lose access until you reconnect.'
                  )
                )
                  disconnect.mutate()
              }}
            >
              <Icon name="link_off" />
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : (
            <button className="btn" disabled={pair.isPending} onClick={() => pair.mutate()}>
              <Icon name="add_link" />
              {pair.isPending ? 'Starting…' : 'Connect'}
            </button>
          )}
        </div>

        {/* Re-pair demoted to a small advanced action when connected - it rotates
            the trust secret (recovery), not the primary control. */}
        {status.paired && (
          <div style={{ marginTop: 'var(--s2)' }}>
            <button
              className="btn-sm btn-ghost"
              disabled={pair.isPending}
              onClick={() => pair.mutate()}
            >
              <Icon name="sync" /> {pair.isPending ? 'Starting…' : 'Re-pair (reset the connection)'}
            </button>
          </div>
        )}

        {/* Waiting for the claim: show the code + auto-detect indicator. No
            manual "finish" button - the poll detects the redeem and finishes. */}
        {pairResult && !claimed && (
          <div className="banner info" style={{ marginTop: 'var(--s4)' }}>
            <Icon name="key" />
            <div style={{ width: '100%' }}>
              Enter this code on <strong>app.hearthshelf.com</strong> to finish
              connecting:
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--s3)',
                  flexWrap: 'wrap',
                  marginTop: 6,
                }}
              >
                <span
                  className="t-mono"
                  style={{ fontSize: '1.4rem', letterSpacing: '0.1em' }}
                >
                  {pairResult.code}
                </span>
                <button className="btn-sm btn-ghost" onClick={copyCode}>
                  <Icon name="content_copy" /> Copy
                </button>
                <button className="btn-sm btn-ghost" onClick={openControlPlane}>
                  <Icon name="open_in_new" /> Open app.hearthshelf.com
                </button>
                <span className="sr-d" style={{ marginLeft: 'auto' }}>
                  {remaining ? `Expires in ${remaining}` : 'Code expired - re-pair to get a new one'}
                </span>
              </div>
              <div style={{ marginTop: 'var(--s4)', borderTop: '1px solid var(--hairline)', paddingTop: 'var(--s3)' }}>
                <div className="sr-d" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)' }}>
                  <span className="hs-onboard-glow" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--primary)', display: 'inline-block' }} />
                  Waiting for you to enter the code - this finishes automatically
                  the moment you do.
                </div>
              </div>
            </div>
          </div>
        )}

        {!status.hasAbsAdminToken && status.paired && (
          <div className="banner warn" style={{ marginTop: 'var(--s4)' }}>
            <Icon name="warning" />
            No admin token saved for provisioning - invited users can't be created
            automatically until this is set.
          </div>
        )}

        {/* LAN -> WAN -> Cloud connectivity map, colored from real signals. */}
        {status.paired && (
          <ConnectivityDiagram
            paired={status.paired}
            reachable={portResult ? portResult.open : null}
            port={portResult?.port ?? null}
            certActive={hsDirect?.status === 'active'}
            serverName={runtime?.serverName || ''}
          />
        )}

        {/* Reachability: always available when paired (the VPS probes our public
            IP directly, so it works even before the cert is ready). Shows the
            assigned address when active, and the REAL port to forward. */}
        {status.paired && (
          <div className="set-row" style={{ marginTop: 'var(--s4)' }}>
            <div className="sr-meta" style={{ width: '100%' }}>
              <div className="sr-t">Reachable from outside your network?</div>
              {hsDirect?.status === 'active' && (
                <div className="sr-d" style={{ marginBottom: 6 }}>
                  {runtime?.serverName || 'Your server'} has a secure web address set
                  up by HearthShelf. People you invite reach it through the
                  HearthShelf app - there's nothing to copy or share.
                </div>
              )}
              {hsDirect?.status === 'pending' && (
                <div className="sr-d" style={{ marginBottom: 6 }}>
                  Setting up your secure address… you can still test the connection.
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s3)', flexWrap: 'wrap' }}>
                <button
                  className="btn-sm btn-ghost"
                  disabled={testPort.isPending}
                  onClick={() => testPort.mutate()}
                >
                  <Icon name="travel_explore" />
                  {testPort.isPending ? 'Checking…' : 'Check connection'}
                </button>
                {portResult?.open && (
                  <span className="sr-d" style={{ color: 'var(--primary)' }}>
                    Reachable on port {portResult.port}.
                  </span>
                )}
                {portResult && !portResult.open && (
                  <span className="sr-d" style={{ color: 'var(--warn, #d9a45a)' }}>
                    Not reachable - forward port {portResult.port} on your router to
                    this machine.
                  </span>
                )}
              </div>
              {portResult && !portResult.open && <ReachabilityHelp port={portResult.port} />}
            </div>
          </div>
        )}
      </div>

      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="person_add" />
        <h2>Invite people</h2>
      </div>
      <div className="cfg-card">
        {!status.paired ? (
          <div className="banner info">
            <Icon name="info" />
            Connect this server above before inviting people.
          </div>
        ) : (
          <>
            <div className="field full">
              <label>Email address</label>
              <input
                className="fld"
                type="email"
                placeholder="name@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field full">
              <label>Role</label>
              <select
                className="fld"
                value={role}
                onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button
              className="btn btn-primary"
              disabled={invite.isPending || !email.trim()}
              onClick={() => invite.mutate()}
              style={{ marginTop: 'var(--s2)' }}
            >
              <Icon name="send" /> {invite.isPending ? 'Sending…' : 'Send invite'}
            </button>
          </>
        )}
      </div>

      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </>
  )
}
