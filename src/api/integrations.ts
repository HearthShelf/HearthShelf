// Admin integrations config client: talks to /hs/integrations/config. Holds the
// editable connection settings for the external services HearthShelf talks to
// (ReadMeABook, Audplexus) plus the Audible catalog region. Secrets are never
// returned by the backend - the GET only reports whether each is set.

import { useAuthStore } from '@/store/authStore'
import type {
  HSIntegrationsEnvLocks,
  HSIntegrationsConfig,
  HSIntegrationsPatch,
} from '@hearthshelf/core'

// Per-field env locks: true = the value is pinned by an environment variable, so
// it overrides the database and is read-only in the UI.
export type IntegrationsEnvLocks = HSIntegrationsEnvLocks
export type IntegrationsConfig = HSIntegrationsConfig
export type IntegrationsConfigPatch = HSIntegrationsPatch

export const integrationsKeys = {
  config: ['integrations', 'config'] as const,
}

export function parseRmabLoginTokenInput(value: string): {
  token: string
  baseUrl: string | null
} {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return { token: value, baseUrl: null }
  try {
    const parsed = new URL(trimmed)
    const marker = '/auth/token/login'
    const markerAt = parsed.pathname.indexOf(marker)
    const token = parsed.searchParams.get('token')?.trim()
    if (markerAt < 0 || !token) return { token: value, baseUrl: null }
    const basePath = parsed.pathname.slice(0, markerAt)
    return { token, baseUrl: `${parsed.origin}${basePath}`.replace(/\/$/, '') }
  } catch {
    return { token: value, baseUrl: null }
  }
}

async function intFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/integrations${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const message = typeof body?.message === 'string' ? body.message : `Integrations ${res.status}`
    throw new Error(message)
  }
  return body as T
}

export function getIntegrationsConfig(): Promise<IntegrationsConfig> {
  return intFetch<IntegrationsConfig>('/config')
}

export function saveIntegrationsConfig(
  patch: IntegrationsConfigPatch,
): Promise<IntegrationsConfig> {
  return intFetch<IntegrationsConfig>('/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}
