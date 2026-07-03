// Discover backend client: the monthly AI shelf, per-item feedback, and the
// server-wide popular signals. All hit /hs/discover* (ABS-bearer like the other
// /hs calls). Every call swallows errors into a neutral value so the page never
// breaks - Discover degrades to its deterministic base shelves when the backend
// is down (see docs/pages/discover.md).

import { useAuthStore } from '@/store/authStore'
import type { DiscoverSummary, DiscoverCandidate } from '@/lib/discover'
import type {
  HSDiscoverVote,
  HSDiscoverFeedback,
  HSDiscoverFeedbackMap,
  HSDiscoverPick,
  HSDiscoverShelf,
  HSDiscoverPopularItem,
} from '@hearthshelf/core'

export type DiscoverVote = HSDiscoverVote
export type DiscoverFeedbackEntry = HSDiscoverFeedback
export type DiscoverFeedbackMap = HSDiscoverFeedbackMap
export type MonthlyPick = HSDiscoverPick
export type MonthlyShelf = HSDiscoverShelf
export type PopularItem = HSDiscoverPopularItem

async function dFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/discover${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`Discover ${res.status}`)
  return res.json() as Promise<T>
}

export const discoverKeys = {
  monthly: ['discover', 'monthly'] as const,
  feedback: ['discover', 'feedback'] as const,
  popular: ['discover', 'popular'] as const,
}

const EMPTY_SHELF: MonthlyShelf = { month: '', engine: 'none', intro: '', picks: [] }

// Fetch-or-generate the month's AI shelf. The backend returns the cached shelf if
// one exists for this user+month, otherwise generates from the posted summary +
// candidates (once per month). Returns an empty shelf on any failure.
export async function getMonthlyShelf(
  summary: DiscoverSummary,
  candidates: DiscoverCandidate[],
): Promise<MonthlyShelf> {
  if (!candidates.length) return EMPTY_SHELF
  try {
    return await dFetch<MonthlyShelf>('', {
      method: 'POST',
      body: JSON.stringify({ summary, candidates }),
    })
  } catch {
    return EMPTY_SHELF
  }
}

export async function getDiscoverFeedback(): Promise<DiscoverFeedbackMap> {
  try {
    const r = await dFetch<{ feedback: DiscoverFeedbackMap }>('/feedback')
    return r.feedback ?? {}
  } catch {
    return {}
  }
}

export async function setDiscoverFeedback(
  itemKey: string,
  fb: { vote?: DiscoverVote | null; rating?: number | null },
): Promise<DiscoverFeedbackMap> {
  const r = await dFetch<{ feedback: DiscoverFeedbackMap }>('/feedback', {
    method: 'POST',
    body: JSON.stringify({ itemKey, ...fb }),
  })
  return r.feedback ?? {}
}

export async function getPopular(): Promise<PopularItem[]> {
  try {
    const r = await dFetch<{ items: PopularItem[] }>('/popular')
    return r.items ?? []
  } catch {
    return []
  }
}
