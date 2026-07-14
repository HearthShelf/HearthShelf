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

async function queueFetch<T>(path = '/hs/queue', options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(path, {
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

// Ask the server to rebuild the Auto queue now (POST /hs/queue/recompute) and
// return it. A plain GET no longer recomputes - recompute is trigger-based
// (play-cooldown, settings/manual/dismissal edits, nightly job). `currentItemId`
// is the book now playing; the server seeds finish-series from it and stores it
// for the nightly rebuild. Omit for a plain recompute using the stored current.
export function recomputeServerQueue(currentItemId?: string | null): Promise<ServerQueue> {
  return queueFetch<ServerQueue>('/hs/queue/recompute', {
    method: 'POST',
    body: JSON.stringify(currentItemId === undefined ? {} : { currentItemId }),
  })
}

export function putServerQueue(
  items: QueueEntry[],
  manual: QueueEntry[],
  playlistId: string | null,
  updatedAt: number,
): Promise<ServerQueue> {
  return queueFetch<ServerQueue>('/hs/queue', {
    method: 'PUT',
    body: JSON.stringify({ items, manual, playlistId, updatedAt }),
  })
}
