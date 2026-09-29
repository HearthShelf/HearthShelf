import { useAuthStore } from '@/store/authStore'
import { parseBookParts, type BookParts } from '@/lib/bookParts'

// Quick-start parts for very long single-file books (GET /hs/parts/:itemId).
// See lib/bookParts.ts for why they exist.
//
// Best-effort by design: an older server (404/405), a network error, a slow
// reply or a malformed body all resolve to null, and the player streams the
// original file exactly as before.

// Long enough for the server to read a big file's index on first request,
// short enough that a stuck server can't hold playback hostage.
const PARTS_TIMEOUT_MS = 8000

export async function getBookParts(itemId: string): Promise<BookParts | null> {
  const token = useAuthStore.getState().token
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PARTS_TIMEOUT_MS)
  try {
    const res = await fetch(`/hs/parts/${encodeURIComponent(itemId)}`, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return parseBookParts(await res.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
