// Admin integrations config client: talks to /hs/integrations/config. Holds the
// editable connection settings for the external services HearthShelf talks to
// (ReadMeABook, Audplexus) plus the Audible catalog region. Secrets are never
// returned by the backend - the GET only reports whether each is set.

import { useAuthStore } from '@/store/authStore'
import type { HSIntegrationsEnvLocks, HSIntegrationsConfig } from '@hearthshelf/core'

// Per-field env locks: true = the value is pinned by an environment variable, so
// it overrides the database and is read-only in the UI.
export type IntegrationsEnvLocks = HSIntegrationsEnvLocks
export type IntegrationsConfig = HSIntegrationsConfig

// NOTE: kept local (not HSIntegrationsPatch). The client clears a URL by sending
// `null` (see ConfigContentPages: `patch.rmabUrl = url.trim() || null`), and the
// backend treats null and '' the same. Core's HSIntegrationsPatch types the URL
// fields as `string` only. Reconcile in core before switching.
export interface IntegrationsConfigPatch {
  rmabUrl?: string | null
  rmabLoginToken?: string | null // omit/'' to keep; null to clear
  audplexusUrl?: string | null
  audplexusKey?: string | null // omit/'' to keep; null to clear
  audibleRegion?: string
}

export const integrationsKeys = {
  config: ['integrations', 'config'] as const,
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
  if (!res.ok) throw new Error(`integrations ${res.status}`)
  return res.json() as Promise<T>
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
