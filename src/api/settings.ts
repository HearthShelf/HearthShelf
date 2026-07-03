// Per-key settings sync client. Settings live server-side (keyed by ABS user id)
// so they follow the user across devices; localStorage is just a fast local
// cache. Talks to the HearthShelf backend at /hs/settings.

import type {
  StoredSetting,
  SettingChange,
  SettingsPullResult,
  SettingsPushResult,
} from '@hearthshelf/core'
import { useAuthStore } from '@/store/authStore'

export type { StoredSetting, SettingChange }
export type ServerSettings = SettingsPullResult
export type PushResult = SettingsPushResult

async function settingsFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`settings ${res.status}`)
  return res.json() as Promise<T>
}

// Pull account + device (for this device) settings and the non-secret connection.
export function getServerSettings(deviceId: string): Promise<ServerSettings> {
  const q = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''
  return settingsFetch<ServerSettings>(`/hs/settings${q}`)
}

// Push a batch of changed keys. The server validates + applies per-key LWW and
// reports which landed (applied), were stale (rejected, adopt the returned
// value), or failed validation (invalid).
export function putServerSettings(deviceId: string, changes: SettingChange[]): Promise<PushResult> {
  return settingsFetch<PushResult>('/hs/settings', {
    method: 'PUT',
    body: JSON.stringify({ deviceId, changes }),
  })
}
