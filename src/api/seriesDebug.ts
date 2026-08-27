import { useAuthStore } from '@/store/authStore'

// Admin-only series-matching diagnostics. Mirrors server/lib/seriesDebug.js -
// keep the two in step. Every field here is a FACT the matching pipeline
// produced, not a summary: the point of this surface is to show which stage
// decided a book's fate, so nothing is pre-digested.

export interface SeriesDebugPick {
  seriesId: string
  name: string
}

/** One raw Audible child, plus what roster filtering did to it. */
export interface SeriesDebugRosterBook {
  asin: string | null
  title: string
  /** The title the matcher actually compares. When this reads as the series
   *  name plus a number rather than the book's own name, the prefix strip
   *  missed - that exact bug hid whole series. */
  normalizedTitle: string
  sequence: string
  sequenceKey: string
  releaseDate: string | null
  durationMinutes: number | null
  narrator: string | null
  hasCover: boolean
  isPlaceholder: boolean
  editionScore: number
  kept: boolean
  droppedBy: 'phantom-placeholder' | 'unsequenced-placeholder' | 'duplicate-edition' | null
  /** ASIN of the entry that superseded this one. */
  droppedFor: string | null
}

export interface SeriesDebugAttempt {
  signal: 'asin' | 'title' | 'sequence'
  outcome: 'matched' | 'no-match' | 'refused' | 'skipped'
  detail: string
}

export interface SeriesDebugMatch {
  asin: string | null
  title: string
  normalizedTitle: string
  sequence: string
  sequenceKey: string
  owned: boolean
  matchedBy: 'asin' | 'title' | 'sequence' | null
  matchedOwned: string | null
  attempts: SeriesDebugAttempt[]
}

export interface SeriesDebugOwnedBook {
  asin: string
  title: string
  normalizedTitle: string
  sequence: string
  sequenceKey: string
  author: string
  /** A delisted ASIN is not evidence, so it must not veto title/sequence. */
  asinIsLive: boolean
  eligibleFor: string[]
  claimedBy: string | null
}

export interface SeriesDebugDrift {
  asin: string
  title: string
  kind: 'only-live' | 'only-stored' | 'owned-differs'
  stored?: boolean
  live?: boolean
}

export interface SeriesDebugReport {
  seriesId: string
  name: string
  ownedCount: number
  resolution: {
    query: string
    ownedAuthors: string[]
    matched: { asin: string; title: string } | null
    votes: number
    authorHits: number
  } | null
  roster: {
    seriesAsin: string | null
    rawCount: number
    keptCount: number
    books: SeriesDebugRosterBook[]
  }
  matching: {
    results: SeriesDebugMatch[]
    owned: SeriesDebugOwnedBook[]
  }
  stored: {
    present: boolean
    resolvedAt: number | null
    seriesAsin: string | null
    seriesTitle?: string | null
    name?: string
    bookCount: number
    drift: SeriesDebugDrift[]
  } | null
  generatedAt: number
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function unwrap<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: string
      error?: string
    } | null
    throw new Error(body?.detail ?? body?.error ?? `${what} failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export async function getDebuggableSeries(): Promise<SeriesDebugPick[]> {
  const response = await fetch('/hs/admin/series-debug/list', { headers: authHeaders() })
  const body = await unwrap<{ series: SeriesDebugPick[] }>(response, 'Series list')
  return body.series
}

export async function getSeriesDebugReport(seriesId: string): Promise<SeriesDebugReport> {
  const query = new URLSearchParams({ seriesId })
  const response = await fetch(`/hs/admin/series-debug?${query}`, { headers: authHeaders() })
  return unwrap<SeriesDebugReport>(response, 'Series debugger')
}

/** Re-resolve and re-store ONE series' roster now, rather than waiting for the
 *  nightly sweep. The only write on this surface. */
export async function resweepSeries(seriesId: string): Promise<{
  resolved: boolean
  books: number
}> {
  const query = new URLSearchParams({ seriesId })
  const response = await fetch(`/hs/admin/series-debug/resweep?${query}`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return unwrap<{ resolved: boolean; books: number }>(response, 'Series re-sweep')
}
