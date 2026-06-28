// Runtime config the SPA reads once at boot from the HearthShelf backend
// (GET /hs/runtime). It tells the app which deployment mode it is in and how far
// setup has progressed, so a fresh install routes into onboarding instead of the
// bare ABS login form. See server/routes/runtime.js.

import { useAuthStore } from '@/store/authStore'

export type HSMode = 'slim' | 'aio' | 'hosted'

export interface RuntimeConfig {
  mode: HSMode
  absInitialized: boolean
  paired: boolean
  onboarded: boolean
  publicUrl: string | null
  controlPlaneUrl: string
  // The auto-created HearthShelf service root account (AIO only; null otherwise),
  // so the Config UI can flag it as a machine account it owns.
  serviceUsername: string | null
  // Admin-chosen server name (how it's referred to + the pairing default). Null
  // until set in onboarding or Server Settings.
  serverName: string | null
  // This server's control-plane id, for the on-box "Sign in with HearthShelf"
  // bounce (app.hearthshelf.com/connect-box?server=<serverId>).
  serverId: string | null
}

export interface InitAdminResult {
  // ABS bearer token for the freshly created admin, so the SPA can sign in
  // without re-prompting. Null if init succeeded but the follow-up login didn't
  // (the wizard then falls back to the normal sign-in form).
  token: string | null
  username: string
}

async function runtimeFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/runtime${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`runtime ${res.status}`)
  return res.json() as Promise<T>
}

export function getRuntimeConfig(): Promise<RuntimeConfig> {
  return runtimeFetch<RuntimeConfig>('')
}

// Raised by initAdmin so the wizard can react to specific backend conditions
// (e.g. ABS already has a root user) rather than a generic failure.
export class InitAdminError extends Error {
  code: string
  status: number
  constructor(code: string, status: number) {
    super(code)
    this.name = 'InitAdminError'
    this.code = code
    this.status = status
  }
}

// AIO only: set up the bundled ABS and create the user's own admin account
// (username + password + email). The backend also creates a service root account
// it owns. Returns a bearer token for the USER's account to sign in with. Throws
// InitAdminError with a machine code on failure.
export async function initAdmin(credentials: {
  username: string
  password: string
  email: string
}): Promise<InitAdminResult> {
  const token = useAuthStore.getState().token
  const res = await fetch('/hs/runtime/init-admin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(credentials),
  })
  if (!res.ok) {
    let code = `http_${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) code = body.error
    } catch {
      // non-JSON error body; keep the http_<status> fallback
    }
    throw new InitAdminError(code, res.status)
  }
  return res.json() as Promise<InitAdminResult>
}

export function markOnboarded(): Promise<{ onboarded: boolean }> {
  return runtimeFetch<{ onboarded: boolean }>('/onboarded', { method: 'POST' })
}

// Set the server's display name (onboarding name step + Server Settings edit).
export function setServerName(name: string): Promise<{ serverName: string | null }> {
  return runtimeFetch<{ serverName: string | null }>('/server-name', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

// The box's public IP, so the Connect step can work from the real public address
// instead of the LAN one the browser sees. Returns null when detection fails -
// it's advisory, never blocking.
export async function getPublicIp(): Promise<string | null> {
  try {
    const { ip } = await runtimeFetch<{ ip: string | null }>('/public-ip')
    return ip
  } catch {
    return null
  }
}
