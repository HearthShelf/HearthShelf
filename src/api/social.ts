// Social client: the cross-user leaderboard and per-book "finished by" counts.
// All hit /hs/social/* on the HearthShelf backend (ABS-bearer like the other /hs
// calls). The backend reads ABS's database directly, so this works for every
// logged-in user, not just admins. Failures degrade to a neutral "unavailable"
// value so the page never breaks - the UI hides the leaderboard when that
// happens (e.g. ABS's db isn't mapped on a slim deploy).

import { useAuthStore } from '@/store/authStore'
import type { HSLeaderboardResponse, HSFinishedCount } from '@/api/types'

async function sFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/social${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`Social ${res.status}`)
  return res.json() as Promise<T>
}

export const socialKeys = {
  leaderboard: ['social', 'leaderboard'] as const,
  finishedCount: (id: string) => ['social', 'finished-count', id] as const,
  communityConfig: ['social', 'community-config'] as const,
}

// Instance-wide community config. `defaultShare` is the server's default for
// whether a user appears on the leaderboard when they haven't chosen for
// themselves. `canEdit` is true for admins (PUT is admin-only).
export interface CommunityConfig {
  defaultShare: boolean
  canEdit: boolean
}

export async function getCommunityConfig(): Promise<CommunityConfig> {
  try {
    return await sFetch<CommunityConfig>('/community-config')
  } catch {
    return { defaultShare: true, canEdit: false }
  }
}

export async function setCommunityConfig(
  defaultShare: boolean
): Promise<CommunityConfig> {
  return sFetch<CommunityConfig>('/community-config', {
    method: 'PUT',
    body: JSON.stringify({ defaultShare }),
  })
}

const EMPTY_LEADERBOARD: HSLeaderboardResponse = {
  available: false,
  me: null,
  entries: [],
}

export async function getLeaderboard(): Promise<HSLeaderboardResponse> {
  try {
    return await sFetch<HSLeaderboardResponse>('/leaderboard')
  } catch {
    return EMPTY_LEADERBOARD
  }
}

export async function getFinishedCount(
  libraryItemId: string
): Promise<HSFinishedCount> {
  try {
    return await sFetch<HSFinishedCount>(
      `/finished-count?libraryItemId=${encodeURIComponent(libraryItemId)}`
    )
  } catch {
    return { available: false, count: 0 }
  }
}

export async function getFinishedCountsBulk(
  libraryItemIds: string[]
): Promise<Record<string, number>> {
  if (!libraryItemIds.length) return {}
  try {
    const r = await sFetch<{ available: boolean; counts: Record<string, number> }>(
      '/finished-count',
      { method: 'POST', body: JSON.stringify({ libraryItemIds }) }
    )
    return r.counts ?? {}
  } catch {
    return {}
  }
}
