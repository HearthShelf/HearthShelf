// Public + club notes client (/hs/notes on the HearthShelf backend, ABS-bearer).
// The server owns the spoiler gate: GET returns only unlocked notes plus
// anonymous locked stubs (club scope only) and a hiddenAhead count. Failures /
// older servers / the admin kill-switch degrade to { enabled:false } so the UI
// hides the surface instead of erroring. Follows the social.ts sFetch + as-const
// query-key conventions.

import { useAuthStore } from '@/store/authStore'
import type { HSNote, HSNotesResponse, NoteVisibility } from '@hearthshelf/core'

async function nFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/notes${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`Notes ${res.status}`)
  return res.json() as Promise<T>
}

export const notesKeys = {
  // Public notes for one item, keyed by item + integer position bucket so the
  // list re-fetches as the reader advances (see BookDetailPage / PlayerPage).
  forItem: (itemId: string) => ['notes', 'item', itemId] as const,
}

const EMPTY_NOTES: HSNotesResponse = {
  enabled: false,
  notes: [],
  locked: [],
  hiddenAhead: 0,
  now: Date.now(),
}

interface GetNotesArgs {
  libraryItemId: string
  clubId?: string
  position?: number
  finished?: boolean
  after?: number
}

// Fetch notes for a book (public scope by default; pass clubId for club chat).
// `position` (seconds) is the spoiler gate the server enforces; `finished`
// claims the caller finished the book (the server verifies when it can).
export async function getNotes(args: GetNotesArgs): Promise<HSNotesResponse> {
  const { libraryItemId, clubId, position, finished, after } = args
  if (!libraryItemId) return EMPTY_NOTES
  const qs = new URLSearchParams({ libraryItemId })
  if (clubId) qs.set('clubId', clubId)
  if (position != null && Number.isFinite(position)) qs.set('position', String(position))
  if (finished) qs.set('finished', '1')
  if (after != null && Number.isFinite(after)) qs.set('after', String(after))
  try {
    return await nFetch<HSNotesResponse>(`?${qs.toString()}`)
  } catch {
    return EMPTY_NOTES
  }
}

interface PostNoteArgs {
  libraryItemId: string
  clubId?: string
  parentId?: string
  timeSec?: number | null
  // General (non-club) top-level notes only: 'public' (default) or 'personal'.
  // The server forces 'club' when clubId is set, so omit it for club posts.
  visibility?: NoteVisibility
  // Author-declared spoiler-free: shows to everyone regardless of position. Only
  // honored on top-level notes (the server drops it on replies).
  safe?: boolean
  body: string
}

// Post a note. timeSec null/omitted = a general (ungated) note; a number stamps
// it to a playback position. parentId makes it a reply (gates at the parent).
// `visibility` / `safe` are omitted from the wire when unset so older servers
// (which ignore both fields) degrade cleanly. Throws on failure so mutations can
// surface an error toast.
export async function postNote(args: PostNoteArgs): Promise<HSNote> {
  const payload: Record<string, unknown> = {
    libraryItemId: args.libraryItemId,
    body: args.body,
  }
  if (args.clubId) payload.clubId = args.clubId
  if (args.parentId) payload.parentId = args.parentId
  if (args.timeSec != null) payload.timeSec = args.timeSec
  // Only send visibility for general posts (never for club/reply). A 'public'
  // value is the server default anyway, but sending it is harmless.
  if (args.visibility && !args.clubId && !args.parentId) payload.visibility = args.visibility
  // Safe is top-level only; the server ignores it on replies regardless.
  if (args.safe && !args.parentId) payload.safe = true
  return nFetch<HSNote>('', { method: 'POST', body: JSON.stringify(payload) })
}

// Soft-delete a note (author, club owner, or admin). Throws on failure.
export async function deleteNote(noteId: string): Promise<void> {
  await nFetch<{ ok: boolean }>(`/${encodeURIComponent(noteId)}`, { method: 'DELETE' })
}
