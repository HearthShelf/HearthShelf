import { absRequest } from '@/api/client'
import type {
  ABSItemsInProgressResponse,
  ABSUser,
  ABSMediaProgress,
  ABSBookmark,
  ABSListeningSessionsResponse,
  ABSListeningStats,
} from '@/api/types'

export const meKeys = {
  me: ['me'] as const,
  itemsInProgress: ['items-in-progress'] as const,
  sessions: (page: number) => ['listening-sessions', page] as const,
  stats: ['listening-stats'] as const,
}

export function getListeningSessions(
  page = 0,
  itemsPerPage = 100
): Promise<ABSListeningSessionsResponse> {
  return absRequest<ABSListeningSessionsResponse>(
    `/api/me/listening-sessions?page=${page}&itemsPerPage=${itemsPerPage}`
  )
}

export function getListeningStats(): Promise<ABSListeningStats> {
  return absRequest<ABSListeningStats>('/api/me/listening-stats')
}

// Full user payload including mediaProgress[] and bookmarks[].
interface ABSMeResponse extends ABSUser {
  mediaProgress: ABSMediaProgress[]
  bookmarks: ABSBookmark[]
}

export function getMe(): Promise<ABSMeResponse> {
  return absRequest<ABSMeResponse>('/api/me')
}

export function getItemsInProgress(): Promise<ABSItemsInProgressResponse> {
  return absRequest<ABSItemsInProgressResponse>('/api/me/items-in-progress')
}

// Mark an item finished / not finished. PATCH /api/me/progress/:id.
export function updateProgress(
  libraryItemId: string,
  body: { isFinished?: boolean; currentTime?: number }
): Promise<void> {
  return absRequest<void>(`/api/me/progress/${libraryItemId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

// --- Bookmarks (user-scoped, per item) ---

export function createBookmark(
  libraryItemId: string,
  time: number,
  title: string
): Promise<ABSBookmark> {
  return absRequest<ABSBookmark>(`/api/me/item/${libraryItemId}/bookmark`, {
    method: 'POST',
    body: JSON.stringify({ time: Math.round(time), title }),
  })
}

export function deleteBookmark(
  libraryItemId: string,
  time: number
): Promise<void> {
  return absRequest<void>(
    `/api/me/item/${libraryItemId}/bookmark/${Math.round(time)}`,
    { method: 'DELETE' }
  )
}
