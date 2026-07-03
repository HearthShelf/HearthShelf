/**
 * Reading-history client: the unified finished-books store, the Goodreads
 * import review flow, and Hardcover sync. All hit /hs/finished-books/* on the
 * HearthShelf backend (ABS-bearer like the other /hs calls) - same-origin
 * fetch pattern as social.ts's sFetch.
 */
import { useAuthStore } from '@/store/authStore'
import type {
  HSFinishedBook,
  HSMatchCandidate,
  HSFinishedBookMatch,
  HSFinishedBookImportRow,
  HSHardcoverAccount,
  HSHardcoverSyncResult,
} from '@hearthshelf/core'

async function fbFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/finished-books${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) {
    let error = `FinishedBooks ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) error = body.error
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new Error(error)
  }
  return res.json() as Promise<T>
}

export const finishedBooksKeys = {
  list: ['finished-books', 'list'] as const,
  hardcover: ['finished-books', 'hardcover'] as const,
}

export type FinishedBook = HSFinishedBook
export type MatchCandidate = HSMatchCandidate
export type MatchRow = HSFinishedBookMatch
export type ImportRow = HSFinishedBookImportRow
export type HardcoverAccountStatus = HSHardcoverAccount
export type HardcoverSyncResult = HSHardcoverSyncResult

export function getFinishedBooks(): Promise<{ books: FinishedBook[] }> {
  return fbFetch('')
}

export function matchRows(
  libraryId: string,
  rows: { title: string; author: string; isbn: string | null }[],
): Promise<{ matches: MatchRow[] }> {
  return fbFetch('/match', {
    method: 'POST',
    body: JSON.stringify({ libraryId, rows }),
  })
}

export function importRows(rows: ImportRow[]): Promise<{ inserted: number; updated: number }> {
  return fbFetch('/import', {
    method: 'POST',
    body: JSON.stringify({ rows }),
  })
}

export function syncAbsFinished(): Promise<{ inserted: number }> {
  return fbFetch('/sync-abs', { method: 'POST' })
}

export function getHardcoverAccount(): Promise<HardcoverAccountStatus> {
  return fbFetch('/hardcover')
}

export function connectHardcover(token: string): Promise<HardcoverAccountStatus> {
  return fbFetch('/hardcover', {
    method: 'PUT',
    body: JSON.stringify({ token }),
  })
}

export function disconnectHardcover(): Promise<void> {
  return fbFetch('/hardcover', { method: 'DELETE' })
}

export function triggerHardcoverSync(): Promise<HardcoverSyncResult> {
  return fbFetch('/hardcover/sync', { method: 'POST' })
}
