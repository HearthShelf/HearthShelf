// ReadMeABook request layer. Talks to the HearthShelf backend at /qg/rmab/*,
// which proxies to an internal ReadMeABook server with a server-side token. All
// request shapes mirror RMAB's API (verified against the RMAB source).

import { useAuthStore } from '@/store/authStore'

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

export interface RmabConfig {
  configured: boolean
}

async function rmabFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/qg/rmab${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`RMAB ${res.status}`)
  return res.json() as Promise<T>
}

export const requestKeys = {
  config: ['rmab', 'config'] as const,
  list: (group: string) => ['rmab', 'requests', group] as const,
  search: (q: string) => ['rmab', 'search', q] as const,
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
  const qs = group && group !== 'all' ? `?status=${encodeURIComponent(group)}&take=100` : '?take=100'
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
  coverArtUrl?: string
  durationMinutes?: number
}): Promise<{ success: boolean; request?: RmabRequest; error?: string }> {
  return rmabFetch('/requests', {
    method: 'POST',
    body: JSON.stringify({ audiobook }),
  })
}
