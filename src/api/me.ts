import { absRequest, ABSRequestError } from '@/api/client'
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
  itemsPerPage = 100,
): Promise<ABSListeningSessionsResponse> {
  return absRequest<ABSListeningSessionsResponse>(
    `/api/me/listening-sessions?page=${page}&itemsPerPage=${itemsPerPage}`,
  )
}

export function getListeningStats(): Promise<ABSListeningStats> {
  return absRequest<ABSListeningStats>('/api/me/listening-stats')
}

// Full user payload including mediaProgress[] and bookmarks[].
interface ABSMeResponse extends ABSUser {
  mediaProgress: ABSMediaProgress[]
  bookmarks: ABSBookmark[]
  permissions?: Record<string, boolean>
}

// Every reader of mediaProgress gets a `progress` fraction worked out from the
// live position (see progressFraction), never ABS's separately stored value.
export async function getMe(): Promise<ABSMeResponse> {
  const me = await absRequest<ABSMeResponse>('/api/me')
  return {
    ...me,
    mediaProgress: (me.mediaProgress ?? []).map((p) => ({ ...p, progress: progressFraction(p) })),
  }
}

/**
 * How far through an item a progress row is, 0..1, from its live position.
 *
 * ABS stores `progress` separately from `currentTime` and only rewrites it when a
 * writer sends a `progress` value. A position-only update (another client's
 * PATCH) moves `currentTime` and leaves `progress` where it was, so a book 18h in
 * could still report the fraction from where its session started. The position
 * is what every writer keeps current, so derive from it whenever it is usable.
 */
export function progressFraction(p: {
  duration?: number
  progress?: number
  currentTime?: number
  isFinished?: boolean
}): number {
  if (p.isFinished) return 1
  const duration = p.duration ?? 0
  const position = p.currentTime ?? 0
  if (duration > 0 && position > 0) return Math.min(1, position / duration)
  return Math.min(1, Math.max(0, p.progress ?? 0))
}

export function getItemsInProgress(): Promise<ABSItemsInProgressResponse> {
  return absRequest<ABSItemsInProgressResponse>('/api/me/items-in-progress')
}

// Mark an item finished / not finished. PATCH /api/me/progress/:id.
export function updateProgress(
  libraryItemId: string,
  body: { isFinished?: boolean; currentTime?: number },
): Promise<void> {
  return absRequest<void>(`/api/me/progress/${libraryItemId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

// Reset means removing the media-progress row, not retaining a 0% row. DELETE
// uses the row's own ID and is user-owned; it does not require library delete.
export async function resetProgress(libraryItemId: string): Promise<void> {
  let progress: { id?: string }
  try {
    progress = await absRequest<{ id?: string }>(
      `/api/me/progress/${encodeURIComponent(libraryItemId)}`,
    )
  } catch (e) {
    if (e instanceof ABSRequestError && e.status === 404) return
    throw e
  }
  if (!progress.id) throw new Error('media_progress_id_missing')
  await absRequest<void>(`/api/me/progress/${encodeURIComponent(progress.id)}`, {
    method: 'DELETE',
  })
}

// --- Bookmarks (user-scoped, per item) ---

export function createBookmark(
  libraryItemId: string,
  time: number,
  title: string,
): Promise<ABSBookmark> {
  return absRequest<ABSBookmark>(`/api/me/item/${libraryItemId}/bookmark`, {
    method: 'POST',
    body: JSON.stringify({ time: Math.round(time), title }),
  })
}

export function deleteBookmark(libraryItemId: string, time: number): Promise<void> {
  return absRequest<void>(`/api/me/item/${libraryItemId}/bookmark/${Math.round(time)}`, {
    method: 'DELETE',
  })
}

// Change the current user's password. { password, newPassword }.
export function changePassword(password: string, newPassword: string): Promise<void> {
  return absRequest<void>('/api/me/password', {
    method: 'PATCH',
    body: JSON.stringify({ password, newPassword }),
  })
}
