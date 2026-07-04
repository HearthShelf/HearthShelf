// Book Club client (/hs/clubs on the HearthShelf backend, ABS-bearer). Clubs are
// persistent multi-book groups; a club has one current book and a readable
// history of past books, per-book chat (notes), a member progress race, and an
// unread cursor. Failures / older servers / the admin kill-switch degrade to
// { enabled:false } so the UI hides the surface. Follows the social.ts sFetch +
// as-const query-key conventions.

import { useAuthStore } from '@/store/authStore'
import type {
  HSClub,
  HSClubsResponse,
  HSClubDetail,
  ClubRecBasis,
  ClubRecCandidate,
  ClubRecommendation,
} from '@hearthshelf/core'

async function cFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/clubs${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`Clubs ${res.status}`)
  return res.json() as Promise<T>
}

export const clubsKeys = {
  // My clubs + clubs joinable for one item. Item '' = my clubs only.
  forItem: (itemId: string) => ['clubs', 'item', itemId] as const,
  // One club's detail, keyed by club + viewed book so switching book refetches.
  detail: (clubId: string, bookId: string) => ['clubs', 'detail', clubId, bookId] as const,
}

const EMPTY_CLUBS: HSClubsResponse = { enabled: false, mine: [], joinable: [] }

function visibleClubs(res: HSClubsResponse): HSClubsResponse {
  if (!res.enabled) return EMPTY_CLUBS
  return {
    enabled: true,
    mine: res.mine.filter((club) => !club.archived),
    joinable: res.joinable.filter((club) => !club.archived),
  }
}

// The caller's clubs, plus open clubs whose current book is this item (joinable).
// Omit libraryItemId for just `mine`. Degrades to { enabled:false }.
export async function getClubs(libraryItemId?: string): Promise<HSClubsResponse> {
  const qs = libraryItemId ? `?libraryItemId=${encodeURIComponent(libraryItemId)}` : ''
  try {
    return visibleClubs(await cFetch<HSClubsResponse>(qs))
  } catch {
    return EMPTY_CLUBS
  }
}

const EMPTY_DETAIL: HSClubDetail = {
  enabled: false,
  club: {
    id: '',
    name: '',
    createdBy: '',
    isOpen: true,
    archived: false,
    createdAt: 0,
    memberCount: 0,
    currentBook: null,
    recBasis: 'club-history',
  },
  books: [],
  queue: [],
  members: [],
  notes: { notes: [], locked: [], hiddenAhead: 0 },
  unreadCount: 0,
}

interface GetClubArgs {
  clubId: string
  bookId?: string
  position?: number
}

// One club's full detail: book history, members with progress in the viewed
// book, that book's gated notes, and the unread count. bookId defaults to the
// current book. Degrades to { enabled:false }.
export async function getClub(args: GetClubArgs): Promise<HSClubDetail> {
  const { clubId, bookId, position } = args
  if (!clubId) return EMPTY_DETAIL
  const qs = new URLSearchParams()
  if (bookId) qs.set('bookId', bookId)
  if (position != null && Number.isFinite(position)) qs.set('position', String(position))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  try {
    return await cFetch<HSClubDetail>(`/${encodeURIComponent(clubId)}${suffix}`)
  } catch {
    return EMPTY_DETAIL
  }
}

// Create a club (creator becomes owner). Optional libraryItemId seeds the first
// current book. Throws on failure so the create modal can surface an error.
export async function createClub(name: string, libraryItemId?: string): Promise<HSClub> {
  const payload: Record<string, unknown> = { name }
  if (libraryItemId) payload.libraryItemId = libraryItemId
  return cFetch<HSClub>('', { method: 'POST', body: JSON.stringify(payload) })
}

// Advance a club to a new current book (owner only). The previous current book
// is archived into history.
export async function advanceClubBook(clubId: string, libraryItemId: string): Promise<HSClub> {
  return cFetch<HSClub>(`/${encodeURIComponent(clubId)}/books`, {
    method: 'POST',
    body: JSON.stringify({ libraryItemId }),
  })
}

// Add a book to the club's up-next queue (owner only). No-op server-side if the
// book is already in the club (returns { added:false }).
export async function addClubQueue(clubId: string, libraryItemId: string): Promise<boolean> {
  const r = await cFetch<{ ok: boolean; added: boolean }>(
    `/${encodeURIComponent(clubId)}/queue`,
    { method: 'POST', body: JSON.stringify({ libraryItemId }) },
  )
  return r.added
}

export async function joinClub(clubId: string): Promise<void> {
  await cFetch<{ ok: boolean }>(`/${encodeURIComponent(clubId)}/join`, { method: 'POST' })
}

export async function leaveClub(clubId: string): Promise<void> {
  await cFetch<{ ok: boolean }>(`/${encodeURIComponent(clubId)}/leave`, { method: 'POST' })
}

export async function kickMember(clubId: string, userId: string): Promise<void> {
  await cFetch<{ ok: boolean }>(`/${encodeURIComponent(clubId)}/kick`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}

// Bump the per-club unread cursor (server applies max(stored, incoming)).
export async function markClubRead(clubId: string, lastReadAt: number): Promise<number> {
  const r = await cFetch<{ lastReadAt: number }>(`/${encodeURIComponent(clubId)}/read`, {
    method: 'PUT',
    body: JSON.stringify({ lastReadAt }),
  })
  return r.lastReadAt
}

// Archive a club (owner or admin). Owners archive rather than leave.
export async function archiveClub(clubId: string): Promise<void> {
  await cFetch<{ ok: boolean }>(`/${encodeURIComponent(clubId)}`, { method: 'DELETE' })
}

// Permanently delete a club (owner or admin).
export async function deleteClub(clubId: string): Promise<void> {
  await cFetch<{ ok: boolean }>(`/${encodeURIComponent(clubId)}/hard`, { method: 'DELETE' })
}

// Set what the club's next-book recommendation is based on (owner only).
export async function setClubRecBasis(clubId: string, basis: ClubRecBasis): Promise<ClubRecBasis> {
  const r = await cFetch<{ recBasis: ClubRecBasis }>(`/${encodeURIComponent(clubId)}/rec-basis`, {
    method: 'PUT',
    body: JSON.stringify({ basis }),
  })
  return r.recBasis
}

// Ask for the club's next-book picks (owner only). The client posts its own
// unstarted library books as candidates and the genre lists of the club's read
// books (for the club-history basis); the server builds the taste and runs the
// AI or heuristic recommender. `unavailable` is true when the basis needs ABS's
// db and it isn't mounted. Throws on failure so the panel can surface an error.
export async function recommendClubBook(
  clubId: string,
  candidates: ClubRecCandidate[],
  historyGenres: string[][],
): Promise<ClubRecommendation & { unavailable?: boolean }> {
  return cFetch<ClubRecommendation & { unavailable?: boolean }>(
    `/${encodeURIComponent(clubId)}/recommend`,
    { method: 'POST', body: JSON.stringify({ candidates, historyGenres }) },
  )
}
