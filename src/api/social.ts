// Social client: the cross-user leaderboard and per-book "finished by" counts.
// All hit /hs/social/* on the HearthShelf backend (ABS-bearer like the other /hs
// calls). The backend reads ABS's database directly, so this works for every
// logged-in user, not just admins. Failures degrade to a neutral "unavailable"
// value so the page never breaks - the UI hides the leaderboard when that
// happens (e.g. ABS's db isn't mapped on a slim deploy).

import { useAuthStore } from '@/store/authStore'
import type {
  HSLeaderboardResponse,
  HSFinishedCount,
  HSFinishedByResponse,
  HSListeningNowResponse,
  HSListeningNowUser,
  LeaderboardWindow,
} from '@hearthshelf/core'

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
  leaderboard: (window: LeaderboardWindow) => ['social', 'leaderboard', window] as const,
  finishedCount: (id: string) => ['social', 'finished-count', id] as const,
  finishedBy: (id: string) => ['social', 'finished-by', id] as const,
  listeningNow: (id: string) => ['social', 'listening-now', id] as const,
  communityConfig: ['social', 'community-config'] as const,
}

// Instance-wide community config. `defaultShare` is the server's default for
// whether a user appears on the leaderboard when they haven't chosen for
// themselves. `defaultShareListening` is the (default-OFF) presence default.
// `notesEnabled` / `clubsEnabled` are admin kill-switches. `canEdit` is true for
// admins (PUT is admin-only).
// NOTE: kept local (not HSCommunityConfig). Core's HSCommunityConfig only has
// `defaultShare` + `canEdit`; this shape has grown three more server-returned
// fields (defaultShareListening, notesEnabled, clubsEnabled). Reconcile in core.
export interface CommunityConfig {
  defaultShare: boolean
  defaultShareListening: boolean
  notesEnabled: boolean
  clubsEnabled: boolean
  // Whether clubs may make AI recommendation calls. Ships OFF (admin opt-in).
  clubsAiEnabled: boolean
  canEdit: boolean
}

const DEFAULT_COMMUNITY: CommunityConfig = {
  defaultShare: true,
  defaultShareListening: false,
  notesEnabled: true,
  clubsEnabled: true,
  clubsAiEnabled: false,
  canEdit: false,
}

export async function getCommunityConfig(): Promise<CommunityConfig> {
  try {
    const r = await sFetch<Partial<CommunityConfig>>('/community-config')
    // Older servers omit the new fields; fill them defensively.
    return { ...DEFAULT_COMMUNITY, ...r }
  } catch {
    return DEFAULT_COMMUNITY
  }
}

// Patch one or more community-config fields (admin only). The server merges the
// patch, so callers can send just the field they changed.
export async function setCommunityConfig(
  patch: Partial<Pick<
    CommunityConfig,
    'defaultShare' | 'defaultShareListening' | 'notesEnabled' | 'clubsEnabled' | 'clubsAiEnabled'
  >>,
): Promise<CommunityConfig> {
  const r = await sFetch<Partial<CommunityConfig>>('/community-config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  return { ...DEFAULT_COMMUNITY, ...r }
}

const EMPTY_LEADERBOARD: HSLeaderboardResponse = {
  available: false,
  me: null,
  entries: [],
}

export async function getLeaderboard(
  window: LeaderboardWindow = 'all',
): Promise<HSLeaderboardResponse> {
  try {
    return await sFetch<HSLeaderboardResponse>(
      `/leaderboard?window=${encodeURIComponent(window)}`,
    )
  } catch {
    return EMPTY_LEADERBOARD
  }
}

const EMPTY_FINISHED_BY: HSFinishedByResponse = { available: false, users: [] }

export async function getFinishedBy(libraryItemId: string): Promise<HSFinishedByResponse> {
  if (!libraryItemId) return EMPTY_FINISHED_BY
  try {
    return await sFetch<HSFinishedByResponse>(
      `/finished-by?libraryItemId=${encodeURIComponent(libraryItemId)}`,
    )
  } catch {
    return EMPTY_FINISHED_BY
  }
}

export async function getFinishedCount(libraryItemId: string): Promise<HSFinishedCount> {
  try {
    return await sFetch<HSFinishedCount>(
      `/finished-count?libraryItemId=${encodeURIComponent(libraryItemId)}`,
    )
  } catch {
    return { available: false, count: 0 }
  }
}

export async function getFinishedCountsBulk(
  libraryItemIds: string[],
): Promise<Record<string, number>> {
  if (!libraryItemIds.length) return {}
  try {
    const r = await sFetch<{ available: boolean; counts: Record<string, number> }>(
      '/finished-count',
      { method: 'POST', body: JSON.stringify({ libraryItemIds }) },
    )
    return r.counts ?? {}
  } catch {
    return {}
  }
}

// Who is listening to this book right now-ish (server filters by the
// shareCurrentlyListening privacy resolution, default OFF). Degrades to
// unavailable so the UI hides the row. Label the chips "Listening recently".
const EMPTY_LISTENING: HSListeningNowResponse = { available: false, users: [] }

export async function getListeningNow(libraryItemId: string): Promise<HSListeningNowResponse> {
  if (!libraryItemId) return EMPTY_LISTENING
  try {
    return await sFetch<HSListeningNowResponse>(
      `/listening-now?libraryItemId=${encodeURIComponent(libraryItemId)}`,
    )
  } catch {
    return EMPTY_LISTENING
  }
}

// Bulk listening-now for a shelf of items (capped 100 server-side). Returns a
// map keyed by libraryItemId; degrades to an empty map.
export async function getListeningNowBulk(
  libraryItemIds: string[],
): Promise<Record<string, HSListeningNowUser[]>> {
  if (!libraryItemIds.length) return {}
  try {
    const r = await sFetch<{ available: boolean; byItem: Record<string, HSListeningNowUser[]> }>(
      '/listening-now',
      { method: 'POST', body: JSON.stringify({ libraryItemIds }) },
    )
    return r.byItem ?? {}
  } catch {
    return {}
  }
}
