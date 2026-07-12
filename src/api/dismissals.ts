// Auto-source dismissals sync client. A per-user "not right now" list of series
// and books hidden from the Auto queue and the Continue-* home shelves. Lives
// server-side (keyed by ABS user id) so it follows the user; the local store is
// the cache. Talks to /hs/dismissals. Same convention as @/api/queue.

import { useAuthStore } from '@/store/authStore'
import type { Dismissals } from '@hearthshelf/core'

async function dismissalsFetch(options: RequestInit = {}): Promise<Dismissals> {
  const token = useAuthStore.getState().token
  const res = await fetch('/hs/dismissals', {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`dismissals ${res.status}`)
  return res.json() as Promise<Dismissals>
}

export function getDismissals(): Promise<Dismissals> {
  return dismissalsFetch()
}

export function addDismissal(kind: 'series' | 'item', entityId: string): Promise<Dismissals> {
  return dismissalsFetch({ method: 'POST', body: JSON.stringify({ kind, entityId }) })
}

export function removeDismissal(kind: 'series' | 'item', entityId: string): Promise<Dismissals> {
  return dismissalsFetch({ method: 'DELETE', body: JSON.stringify({ kind, entityId }) })
}
