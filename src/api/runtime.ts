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

export interface RootCredentials {
  username: string
  password: string
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

// AIO only: reveal the auto-generated root credentials once. Returns null when
// there's nothing to reveal (slim, already onboarded, or already read).
export async function revealRootCredentials(): Promise<RootCredentials | null> {
  try {
    return await runtimeFetch<RootCredentials>('/root-credentials', { method: 'POST' })
  } catch {
    return null
  }
}

export function markOnboarded(): Promise<{ onboarded: boolean }> {
  return runtimeFetch<{ onboarded: boolean }>('/onboarded', { method: 'POST' })
}
