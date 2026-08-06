// HearthShelf's own Audible catalog search. Talks to /hs/audible/search, which
// queries Audible's public catalog directly - works regardless of whether RMAB
// is connected (RMAB is only the request/download executor). Discovery is ours.

import { useAuthStore } from '@/store/authStore'
import type {
  HSAudibleSearchResult,
  HSAudibleSearchResponse,
  HSAudibleSeriesBook,
  HSAudibleSeriesResponse,
} from '@hearthshelf/core'

export type AudibleResult = HSAudibleSearchResult
export type AudibleSearchResponse = HSAudibleSearchResponse
export type AudibleSeriesBook = HSAudibleSeriesBook
export type AudibleSeriesResponse = HSAudibleSeriesResponse

export const audibleKeys = {
  search: (q: string, page = 1) => ['audible', 'search', q, page] as const,
  // Keyed by ABS series id, not name - two distinct series can share a name, and
  // a name-only key made them collide in the cache.
  series: (seriesId: string, name: string) => ['audible', 'series', seriesId, name] as const,
}

export async function searchAudible(query: string, page = 1): Promise<AudibleSearchResponse> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/audible/search?q=${encodeURIComponent(query)}&page=${page}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Audible ${res.status}`)
  return res.json() as Promise<AudibleSearchResponse>
}

// Fetch a series' books from Audible. The backend resolves the series ASIN (ABS
// exposes none) and returns the child books ordered by sequence; seriesAsin is
// null when no confident match was found.
//
// seriesId is ABS's own series id and is what identifies the series - the name
// is passed too because it's the Audible search term, but two distinct series
// can share a name, so the id is what keeps their rosters apart.
export async function fetchAudibleSeries(
  seriesId: string,
  name: string,
): Promise<AudibleSeriesResponse> {
  const token = useAuthStore.getState().token
  const params = new URLSearchParams({ q: name, seriesId })
  const res = await fetch(`/hs/audible/series?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Audible series ${res.status}`)
  return res.json() as Promise<AudibleSeriesResponse>
}

// A plain Audible store link for a result, used by the "Buy on Audible" action
// when the request backend isn't the path (e.g. Audplexus-only setups).
export function audibleStoreUrl(r: { title: string; author: string }): string {
  return 'https://www.audible.com/search?keywords=' + encodeURIComponent(`${r.title} ${r.author}`)
}
