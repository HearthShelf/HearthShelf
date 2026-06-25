// Hosted-mode admin client: talks to the in-container backend at /hs/hosted/*.
// These endpoints connect this self-hosted instance to app.hearthshelf.com
// (pairing) and let an admin invite people to it from here.
import { useAuthStore } from '@/store/authStore'
import type { HSMode } from '@/api/runtime'

async function hostedFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/hosted${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = (data as { detail?: string; error?: string }).detail
    const error = (data as { error?: string }).error
    throw new Error(detail || error || `hosted ${res.status}`)
  }
  return data as T
}

export interface HostedStatus {
  mode: HSMode
  paired: boolean
  hasAbsAdminToken: boolean
  issuer: string | null
}

export function getHostedStatus(): Promise<HostedStatus> {
  return hostedFetch<HostedStatus>('/config', { method: 'GET' })
}

export interface PairResult {
  code: string
  expires_at: number
  control_plane: string
  issuer: string
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

export interface ConfigureOidcResult {
  ok: boolean
  issuer: string
}

/**
 * Configure ABS for OIDC federation, after the admin has redeemed the pairing
 * code on app.hearthshelf.com. Pulls this server's dedicated OAuth client from
 * the control plane and writes it into ABS. Returns 409 if the code hasn't been
 * redeemed yet, 410 if the one-time secret was already used (re-pair to rotate).
 */
export function configureOidc(): Promise<ConfigureOidcResult> {
  return hostedFetch<ConfigureOidcResult>('/configure-oidc', { method: 'POST' })
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
