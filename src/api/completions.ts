/**
 * The caller's finished-books log. Hits GET /hs/completions on the HearthShelf
 * backend (ABS-bearer like the other /hs calls).
 *
 * This is HearthShelf's own durable record, not derivable from ABS: ABS keeps a
 * single finishedAt per (user, book) that is overwritten on a re-finish, so it
 * can answer neither "when" reliably nor "how many times" at all.
 */
import { useAuthStore } from '@/store/authStore'
import type { HSCompletion, HSCompletionsResponse } from '@hearthshelf/core'

export type Completion = HSCompletion
export type CompletionsPage = HSCompletionsResponse

export const completionKeys = {
  list: ['completions', 'list'] as const,
}

export const COMPLETIONS_PAGE_SIZE = 25

export async function getCompletions(
  limit = COMPLETIONS_PAGE_SIZE,
  offset = 0,
): Promise<CompletionsPage> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/completions?limit=${limit}&offset=${offset}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) throw new Error(`Completions ${res.status}`)
  return res.json() as Promise<CompletionsPage>
}
