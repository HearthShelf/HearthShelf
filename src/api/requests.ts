// ReadMeABook request layer. Talks to the HearthShelf backend at /hs/rmab/*,
// which proxies to an internal ReadMeABook server with a server-side token. All
// request shapes mirror RMAB's API (verified against the RMAB source).

import { useAuthStore } from '@/store/authStore'
import type { HSRmabConfig } from '@hearthshelf/core'

// Status model - colors + labels adopted verbatim from ReadMeABook.
export type RmabGroup = 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export interface RmabStatusMeta {
  color: string
  label: string
  group: RmabGroup
}

export const RMAB_STATUS: Record<string, RmabStatusMeta> = {
  pending: { color: '#d9a45a', label: 'Pending', group: 'active' },
  searching: { color: '#4f9db0', label: 'Searching', group: 'active' },
  downloading: { color: '#9b6fb8', label: 'Downloading', group: 'active' },
  processing: { color: '#c4663a', label: 'Processing', group: 'active' },
  awaiting_approval: { color: '#d9a45a', label: 'Awaiting approval', group: 'waiting' },
  awaiting_search: { color: '#d9a45a', label: 'Awaiting search', group: 'waiting' },
  awaiting_import: { color: '#c4663a', label: 'Awaiting import', group: 'waiting' },
  awaiting_release: { color: '#2f9d8f', label: 'Awaiting release', group: 'waiting' },
  warn: { color: '#c4663a', label: 'Needs attention', group: 'failed' },
  downloaded: { color: '#5a9c52', label: 'Downloaded', group: 'completed' },
  available: { color: '#5a9c52', label: 'In library', group: 'completed' },
  failed: { color: '#d8443a', label: 'Failed', group: 'failed' },
  denied: { color: '#d8443a', label: 'Denied', group: 'failed' },
  cancelled: { color: '#8a847a', label: 'Cancelled', group: 'cancelled' },
}

export const RMAB_GROUPS: { id: RmabGroup; label: string; icon: string }[] = [
  { id: 'active', label: 'Active', icon: 'downloading' },
  { id: 'waiting', label: 'Waiting', icon: 'hourglass_top' },
  { id: 'completed', label: 'Completed', icon: 'task_alt' },
  { id: 'failed', label: 'Failed', icon: 'error' },
  { id: 'cancelled', label: 'Cancelled', icon: 'block' },
]

export function statusMeta(status: string): RmabStatusMeta {
  return RMAB_STATUS[status] ?? RMAB_STATUS.pending
}

// The RMAB audiobook embedded in a request (subset we render).
export interface RmabAudiobook {
  id: string
  audibleAsin: string | null
  title: string
  author: string | null
  narrator: string | null
  coverArtUrl: string | null
  absItemId: string | null // links to an ABS library item once acquired
}

// A request row from RMAB's GET /api/requests.
export interface RmabRequest {
  id: string
  status: string
  type: 'audiobook' | 'ebook'
  progress: number
  errorMessage: string | null
  createdAt: string
  audiobook: RmabAudiobook
}

export interface RmabRequestsResponse {
  success: boolean
  requests: RmabRequest[]
  nextCursor: string | null
  counts: {
    all: number
    active: number
    waiting: number
    completed: number
    failed: number
    cancelled: number
  }
}

// A search result from RMAB's catalog (GET /api/audiobooks/search).
export interface RmabSearchResult {
  asin: string
  title: string
  author: string
  narrator?: string
  description?: string
  coverArtUrl?: string
  durationMinutes?: number
  releaseDate?: string
  rating?: number
  isRequested?: boolean
  requestStatus?: string
  requestId?: string
  availableIn?: 'plex' | 'audiobookshelf'
}

export type RmabConfig = HSRmabConfig

export class RmabRequestError extends Error {
  readonly status: number
  readonly code: string
  readonly detail?: string

  constructor(
    status: number,
    code: string,
    detail?: string,
  ) {
    super(detail || code || `ReadMeABook returned HTTP ${status}`)
    this.name = 'RmabRequestError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

async function rmabFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/rmab${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`
    const detail =
      typeof body?.detail === 'string'
        ? body.detail
        : typeof body?.message === 'string'
          ? body.message
          : undefined
    throw new RmabRequestError(res.status, code, detail)
  }
  return body as T
}

export const requestKeys = {
  config: ['rmab', 'config'] as const,
  list: (group: string) => ['rmab', 'requests', group] as const,
  search: (q: string) => ['rmab', 'search', q] as const,
  watchedAuthors: ['rmab', 'watched-authors'] as const,
  watchedSeries: ['rmab', 'watched-series'] as const,
}

// Is the RMAB backend configured? Returns { configured:false } if unreachable.
export async function getRmabConfig(): Promise<RmabConfig> {
  try {
    return await rmabFetch<RmabConfig>('/config')
  } catch {
    return { configured: false }
  }
}

export function listRequests(group?: string): Promise<RmabRequestsResponse> {
  const qs =
    group && group !== 'all' ? `?status=${encodeURIComponent(group)}&take=100` : '?take=100'
  return rmabFetch<RmabRequestsResponse>(`/requests${qs}`)
}

export function searchCatalog(query: string): Promise<{ results: RmabSearchResult[] }> {
  return rmabFetch<{ results: RmabSearchResult[] }>(`/search?q=${encodeURIComponent(query)}`)
}

// Submit a new acquisition request. The audiobook payload mirrors RMAB's schema.
export function submitRequest(audiobook: {
  asin: string
  title: string
  author: string
  narrator?: string
  description?: string
  coverArtUrl?: string
}): Promise<{ success: boolean; request?: RmabRequest; error?: string }> {
  return rmabFetch('/requests', {
    method: 'POST',
    body: JSON.stringify({ audiobook }),
  })
}

// Cancel an in-flight request (only cancellable statuses succeed server-side).
export function cancelRequest(id: string): Promise<{ success: boolean; message?: string }> {
  return rmabFetch(`/requests/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'cancel' }),
  })
}

// Retry a failed/stalled request (only retryable statuses succeed server-side).
export function retryRequest(id: string): Promise<{ success: boolean; message?: string }> {
  return rmabFetch(`/requests/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'retry' }),
  })
}

// Fetch the matching ebook for a completed audiobook request. Requires the
// service account to be an RMAB admin and ebook sources to be configured; the
// parent request must already be downloaded/available.
export function fetchEbook(
  requestId: string,
): Promise<{ success: boolean; message?: string; requestId?: string }> {
  return rmabFetch(`/requests/${encodeURIComponent(requestId)}/ebook`, { method: 'POST' })
}

// ---- Watch lists (auto-request new releases) -----------------------------
export interface WatchedAuthor {
  id: string
  authorAsin: string
  authorName: string
}
export interface WatchedSeries {
  id: string
  seriesAsin: string
  seriesTitle: string
}

export function listWatchedAuthors(): Promise<{ success: boolean; authors: WatchedAuthor[] }> {
  return rmabFetch('/watched-authors')
}

export function watchAuthor(input: {
  authorAsin: string
  authorName: string
  coverArtUrl?: string
}): Promise<{ success: boolean }> {
  return rmabFetch('/watched-authors', { method: 'POST', body: JSON.stringify(input) })
}

export function unwatchAuthor(id: string): Promise<{ success: boolean }> {
  return rmabFetch(`/watched-authors/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listWatchedSeries(): Promise<{ success: boolean; series: WatchedSeries[] }> {
  return rmabFetch('/watched-series')
}

export function watchSeries(input: {
  seriesAsin: string
  seriesTitle: string
  coverArtUrl?: string
}): Promise<{ success: boolean }> {
  return rmabFetch('/watched-series', { method: 'POST', body: JSON.stringify(input) })
}

export function unwatchSeries(id: string): Promise<{ success: boolean }> {
  return rmabFetch(`/watched-series/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ---- Ignore list (hide a catalog item from request surfaces) -------------
export function ignoreAudiobook(asin: string): Promise<{ success: boolean }> {
  return rmabFetch('/ignored', { method: 'POST', body: JSON.stringify({ asin }) })
}

export function unignoreAudiobook(id: string): Promise<{ success: boolean }> {
  return rmabFetch(`/ignored/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
