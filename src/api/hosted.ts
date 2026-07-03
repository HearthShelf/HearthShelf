// Hosted-mode admin client: talks to the in-container backend at /hs/hosted/*.
// These endpoints connect this self-hosted instance to app.hearthshelf.com
// (pairing) and let an admin invite people to it from here.
import { useAuthStore } from '@/store/authStore'
import type {
  HSHostedConfigStatus,
  HSHostedHsDirectState,
  HSHostedPairResponse,
  HSHostedPortCheckResult,
  HSHostedEmailRelayStatus,
} from '@hearthshelf/core'

// Carries the backend's machine-readable error code + HTTP status so callers can
// map them to friendly copy instead of surfacing the raw code. `detail` is the
// optional technical note (kept for logs / debugging, not for users).
export class HostedError extends Error {
  code: string
  status: number
  detail: string | null
  constructor(code: string, status: number, detail: string | null) {
    super(code)
    this.name = 'HostedError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

async function hostedFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  let res: Response
  try {
    res = await fetch(`/hs/hosted${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    })
  } catch {
    // Network-level failure (backend unreachable).
    throw new HostedError('network', 0, null)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = (data as { error?: string }).error || `http_${res.status}`
    const detail = (data as { detail?: string }).detail || null
    throw new HostedError(error, res.status, detail)
  }
  return data as T
}

export type HostedStatus = HSHostedConfigStatus

export function getHostedStatus(): Promise<HostedStatus> {
  return hostedFetch<HostedStatus>('/config', { method: 'GET' })
}

// hs.direct provisioning state, polled by the onboarding Verify step after
// pairing. 'pending' = paired but the cert isn't installed yet; 'active' = the
// publicUrl is usable and reachability can be tested against it.
export type HsDirectState = HSHostedHsDirectState

export function getHsDirectState(): Promise<HsDirectState> {
  return hostedFetch<HsDirectState>('/hsdirect', { method: 'GET' })
}

export type PairResult = HSHostedPairResponse

// Claim state for a pairing code, polled after pairing so the wizard can detect
// when a signed-in user has redeemed it (claimed the server).
export interface PairStatus {
  claimed: boolean
  expired: boolean
  name: string | null
  claimedByEmail: string | null
}

export function pollPairStatus(code: string): Promise<PairStatus> {
  return hostedFetch<PairStatus>('/pair-status', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

/** Start pairing with the control plane; returns the code to enter on app.hs.com. */
export function startPairing(opts?: {
  controlPlaneUrl?: string
  publicUrl?: string
  name?: string
}): Promise<PairResult> {
  return hostedFetch<PairResult>('/pair', {
    method: 'POST',
    body: JSON.stringify({
      controlPlaneUrl: opts?.controlPlaneUrl,
      publicUrl: opts?.publicUrl,
      name: opts?.name,
    }),
  })
}

/** Machine-readable reason a public URL is unusable, from the control plane. */
export type ReachabilityReason = 'not_absolute' | 'not_https' | 'ip_host' | 'bad_host'

export interface ReachabilityResult {
  /** The URL is an absolute HTTPS host (not a bare IP / dotless name). */
  valid: boolean
  validReason: ReachabilityReason | null
  /** Whether the control plane could reach it over HTTPS. null when !valid. */
  reachable: boolean | null
  probeStatus: 'online' | 'offline' | null
  probeDetail: string | null
  httpStatus: number | null
}

/**
 * Ask the control plane (via our backend) whether a public URL is a valid HTTPS
 * host and reachable from the internet, before committing to pairing. Advisory:
 * the answer never blocks pairing, it only warns the admin early.
 */
export function checkReachability(opts: {
  publicUrl: string
  controlPlaneUrl?: string
}): Promise<ReachabilityResult> {
  return hostedFetch<ReachabilityResult>('/reachability', {
    method: 'POST',
    body: JSON.stringify({
      publicUrl: opts.publicUrl,
      controlPlaneUrl: opts.controlPlaneUrl,
    }),
  })
}

/** Disconnect from app.hearthshelf.com: deregister on the control plane and clear
 *  local trust state. The server vanishes from the hosted app. */
export function disconnectHosted(): Promise<{ ok: boolean }> {
  return hostedFetch<{ ok: boolean }>('/disconnect', { method: 'POST' })
}

/** Port reachability via the hs.direct VPS: it connects back to this box's public
 *  IP on the port we're exposed on. Works even before the cert is ready (no
 *  hostname needed). `port` is the actual port tested. */
export type PortCheckResult = HSHostedPortCheckResult
export function checkPort(): Promise<PortCheckResult> {
  return hostedFetch<PortCheckResult>('/port-check', { method: 'GET' })
}

export interface InviteResult {
  ok: boolean
  email: string
  role: 'admin' | 'user'
  emailed: boolean
}

/** Invite someone by email to this server (forwarded to the control plane). */
export function inviteFromServer(email: string, role: 'admin' | 'user'): Promise<InviteResult> {
  return hostedFetch<InviteResult>('/invite', {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  })
}

export type EmailRelayStatus = HSHostedEmailRelayStatus

/** Whether this box can send email through HearthShelf, and if it's enabled. */
export function getEmailRelayStatus(): Promise<EmailRelayStatus> {
  return hostedFetch<EmailRelayStatus>('/email-relay', { method: 'GET' })
}

/** Point ABS's SMTP at the loopback relay (the 1-click "use HearthShelf email"). */
export function enableEmailRelay(): Promise<{ ok: boolean; host: string; port: number }> {
  return hostedFetch('/email-relay/apply', { method: 'POST' })
}
