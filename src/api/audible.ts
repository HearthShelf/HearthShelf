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
  // Keyed by the Audible series ASIN, for callers that hold only that (a series
  // follow, which stores the ASIN rather than an ABS series id).
  seriesByAsin: (seriesAsin: string) => ['audible', 'series-asin', seriesAsin] as const,
  product: (asin: string) => ['audible', 'product', asin] as const,
  // Owned/total counts for every swept series, for the library grid.
  seriesSummary: () => ['audible', 'series-summary'] as const,
}

/** Owned/total counts for one series, as the library grid reads them. */
export interface SeriesGapSummary {
  seriesId: string
  /** Books in the series after phantom/duplicate filtering, released or not. */
  total: number
  /** Released books the library doesn't hold. Excludes unreleased ones - nobody
   *  could own those, and counting them would leave a caught-up series
   *  permanently incomplete. */
  missing: number
  /** Books announced but not out yet. */
  upcoming: number
  resolvedAt: number
}

/**
 * Gap counts for every series the nightly sweep has resolved, in one request.
 *
 * The series grid needs one fact per card for hundreds of cards, so this returns
 * counts only - the rosters themselves would be megabytes to render a badge.
 * Series the sweep hasn't reached are simply absent, and those cards render as
 * they did before. Degrades to an empty list: the counts are decoration, and the
 * page must still render without them.
 */
export async function fetchSeriesGapSummaries(): Promise<SeriesGapSummary[]> {
  const token = useAuthStore.getState().token
  try {
    const res = await fetch('/hs/audible/series-summary', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return []
    const body = (await res.json()) as { series?: SeriesGapSummary[] }
    return body.series ?? []
  } catch {
    return []
  }
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

// Fetch a series' roster by its Audible series ASIN. What a series follow holds
// is the ASIN, not an ABS series id, so this is how a "following" list learns
// which book is next in a series being tracked.
//
// Served from the precomputed roster only (no live Audible resolve), so a series
// the nightly sweep hasn't reached returns an unresolved result and the caller
// quietly shows the follow without a next-book line.
export async function fetchAudibleSeriesByAsin(seriesAsin: string): Promise<AudibleSeriesResponse> {
  const empty: AudibleSeriesResponse = { name: '', seriesAsin: null, books: [] }
  if (!seriesAsin) return empty
  const token = useAuthStore.getState().token
  try {
    const params = new URLSearchParams({ seriesAsin })
    const res = await fetch(`/hs/audible/series?${params.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return empty
    return (await res.json()) as AudibleSeriesResponse
  } catch {
    return empty
  }
}

// One Audible product by ASIN. Backs the upcoming-book page, which renders a
// book the library does not have (so ABS knows nothing about it). null on any
// failure or an unknown ASIN, so the page can show a not-found state.
export async function fetchAudibleProduct(asin: string): Promise<HSAudibleSearchResult | null> {
  if (!asin) return null
  const token = useAuthStore.getState().token
  try {
    const res = await fetch(`/hs/audible/product?asin=${encodeURIComponent(asin)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return null
    return (await res.json()) as HSAudibleSearchResult
  } catch {
    return null
  }
}

// A plain Audible store link for a result, used by the "Buy on Audible" action
// when the request backend isn't the path (e.g. Audplexus-only setups).
export function audibleStoreUrl(r: { title: string; author: string }): string {
  return 'https://www.audible.com/search?keywords=' + encodeURIComponent(`${r.title} ${r.author}`)
}
