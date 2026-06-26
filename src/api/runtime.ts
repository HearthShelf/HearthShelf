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

// AIO only: create the bundled ABS admin account with the user's chosen
// credentials (drives ABS /init server-side) and return a bearer token to sign
// in with. Throws InitAdminError with a machine code on failure.
export async function initAdmin(credentials: {
  username: string
  password: string
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
