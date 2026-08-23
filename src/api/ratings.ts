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

async function rFetch<T>(options: RequestInit = {}, path = '/hs/ratings'): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(path, {
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

/**
 * Record "Skip rating" for a book so nothing asks about it again.
 *
 * Separate from dismissing the notification: the notification row is what the
 * prompt job dedupes against, so deleting it alone would let the next hourly
 * pass recreate the prompt. Best-effort - a failed skip costs at most one
 * repeat prompt, which is not worth blocking the dismissal over.
 */
export async function skipRatingPrompt(itemKey: string): Promise<void> {
  try {
    await rFetch<{ ok: boolean }>(
      { method: 'POST', body: JSON.stringify({ itemKey }) },
      '/hs/rating-prompts/skip',
    )
  } catch {
    // Swallowed on purpose; see above.
  }
}
