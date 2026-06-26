// Client for HearthShelf's service-account tracking (admin-only). The accounts
// and their API keys live in ABS - this only persists which ABS user ids the
// admin has tagged as service accounts, so the Config UI can group them apart
// from human users. See server/routes/serviceAccounts.js.

import { useAuthStore } from '@/store/authStore'

export const serviceAccountKeys = {
  ids: ['service-accounts', 'ids'] as const,
}

async function hsFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/service-accounts${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`service-accounts ${res.status}`)
  return res.json() as Promise<T>
}

// The ABS user ids HearthShelf has tagged as service accounts (does not include
// the auto-created service root - that one comes from the runtime config).
export function getServiceAccountIds(): Promise<{ ids: string[] }> {
  return hsFetch<{ ids: string[] }>('')
}

export function tagServiceAccount(userId: string): Promise<{ ids: string[] }> {
  return hsFetch<{ ids: string[] }>('', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}

export function untagServiceAccount(userId: string): Promise<{ ids: string[] }> {
  return hsFetch<{ ids: string[] }>(`/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}
