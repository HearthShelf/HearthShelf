// App-settings sync client. Settings live server-side (keyed by ABS user id) so
// they follow the user across devices; localStorage is just a fast local cache.
// Talks to the HearthShelf backend at /qg/settings.

import { useAuthStore } from '@/store/authStore'

export interface ServerSettings {
  values: Record<string, unknown> | null
  updatedAt: number
}

async function settingsFetch<T>(options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch('/qg/settings', {
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

export function getServerSettings(): Promise<ServerSettings> {
  return settingsFetch<ServerSettings>()
}

export function putServerSettings(
  values: Record<string, unknown>
): Promise<ServerSettings> {
  return settingsFetch<ServerSettings>({
    method: 'PUT',
    body: JSON.stringify({ values }),
  })
}
