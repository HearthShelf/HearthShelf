// Release subscriptions client (/hs/subscriptions on the HearthShelf backend,
// ABS-bearer). The server owns the durable follow list.
//
// Reads degrade to an empty list on any failure (older server without the route,
// offline) so the countdown banner quietly hides rather than breaking Home.
// Writes throw, so the caller can surface the failure instead of silently
// showing an un-followed book as followed.

import { useAuthStore } from '@/store/authStore'
import type {
  HSSubscription,
  HSSubscriptionCreate,
  HSSubscriptionsResponse,
} from '@hearthshelf/core'

export const subscriptionKeys = {
  list: ['subscriptions'] as const,
}

export async function getSubscriptions(): Promise<HSSubscription[]> {
  const token = useAuthStore.getState().token
  try {
    const res = await fetch('/hs/subscriptions', {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    if (!res.ok) return []
    const data = (await res.json()) as HSSubscriptionsResponse
    return data.subscriptions ?? []
  } catch {
    return []
  }
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** Follow an upcoming book, or a whole series (every future book in it). The
 *  server upserts, so following twice is harmless. */
export async function createSubscription(
  body: HSSubscriptionCreate,
): Promise<HSSubscription> {
  const res = await fetch('/hs/subscriptions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Could not follow (${res.status})`)
  const data = (await res.json()) as { subscription: HSSubscription }
  return data.subscription
}

/** Unfollow, by subscription id. */
export async function deleteSubscription(id: string): Promise<void> {
  const res = await fetch(`/hs/subscriptions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`Could not unfollow (${res.status})`)
}
