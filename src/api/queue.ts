// Listening-queue sync client. The up-next item list lives server-side (keyed
// by ABS user id) so it follows the user across devices; the local store is
// the fast write-through cache. Talks to the HearthShelf backend at /hs/queue.
// Queue MODE and auto-rules are NOT here - see @/api/settings.

import { useAuthStore } from '@/store/authStore'
import type { QueueEntry, QueueState } from '@hearthshelf/core'

export interface ServerQueue extends QueueState {
  // Present on PUT responses: false when the write was rejected as stale (an
  // older updatedAt than what's already stored) - the caller should adopt the
  // returned state instead of assuming its write landed.
  applied?: boolean
}

async function queueFetch<T>(options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch('/hs/queue', {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`queue ${res.status}`)
  return res.json() as Promise<T>
}

export function getServerQueue(): Promise<ServerQueue> {
  return queueFetch<ServerQueue>()
}

export function putServerQueue(
  items: QueueEntry[],
  manual: QueueEntry[],
  playlistId: string | null,
  updatedAt: number,
): Promise<ServerQueue> {
  return queueFetch<ServerQueue>({
    method: 'PUT',
    body: JSON.stringify({ items, manual, playlistId, updatedAt }),
  })
}
