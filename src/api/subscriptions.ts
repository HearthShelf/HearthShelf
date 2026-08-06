// Release subscriptions client (/hs/subscriptions on the HearthShelf backend,
// ABS-bearer). The server owns the durable follow list; this is the read side,
// which is all Home's countdown banner needs.
//
// Degrades to an empty list on any failure (older server without the route,
// offline) so the banner quietly hides rather than breaking Home.

import { useAuthStore } from '@/store/authStore'
import type { HSSubscription, HSSubscriptionsResponse } from '@hearthshelf/core'

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
