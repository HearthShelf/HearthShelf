/**
 * The user's own star ratings. Hits /hs/ratings on the HearthShelf backend
 * (ABS-bearer like the other /hs calls).
 *
 * Unlike discover.ts, failures are NOT swallowed into a neutral value: a rating
 * write that quietly failed would leave the optimistic UI showing a score the
 * server never stored. The mutation's rollback depends on this throwing.
 */
import { useAuthStore } from '@/store/authStore'
import type { HSRatingMap } from '@hearthshelf/core'

async function rFetch<T>(options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch('/hs/ratings', {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) {
    let error = `Ratings ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) error = body.error
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new Error(error)
  }
  return res.json() as Promise<T>
}

export const ratingKeys = {
  map: ['ratings', 'map'] as const,
}

export type RatingMap = HSRatingMap

export async function getRatings(): Promise<RatingMap> {
  const r = await rFetch<{ ratings: RatingMap }>()
  return r.ratings ?? {}
}

/** `rating: null` clears. Returns the full server map to adopt. */
export async function setRating(itemKey: string, rating: number | null): Promise<RatingMap> {
  const r = await rFetch<{ ratings: RatingMap }>({
    method: 'PUT',
    body: JSON.stringify({ itemKey, rating }),
  })
  return r.ratings ?? {}
}
