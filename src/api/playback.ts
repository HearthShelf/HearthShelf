import { absRequest } from '@/api/client'
import { useAuthStore } from '@/store/authStore'
import type { ABSPlaybackSession } from '@/api/types'
import { getBookParts } from '@/api/parts'
import { inoFromContentUrl, partsFitSession, type BookParts } from '@/lib/bookParts'

const BASE = '/abs-api'

const DEVICE = {
  deviceId: 'hearthshelf-web',
  clientName: 'HearthShelf',
  clientVersion: '0.1.0',
}

// Start (or resume) a playback session. ABS returns the session with audio
// tracks, chapters, and the server-side resume position.
export function startPlay(itemId: string): Promise<ABSPlaybackSession> {
  return absRequest<ABSPlaybackSession>(`/api/items/${itemId}/play`, {
    method: 'POST',
    body: JSON.stringify({
      deviceInfo: DEVICE,
      supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg'],
    }),
  })
}

// Swap a very long single-file book's one huge file for the server's small
// quick-start parts (phones and car browsers stall on the huge file's index).
// Same book timeline and same play session - only the audio source changes.
// Anything that doesn't fit the session exactly keeps the original tracks.
export function withBookParts(
  session: ABSPlaybackSession,
  parts: BookParts | null,
): ABSPlaybackSession {
  const tracks = session.audioTracks ?? []
  if (
    !parts ||
    !partsFitSession(parts, {
      durationSec: session.duration,
      trackCount: tracks.length,
      trackIno: inoFromContentUrl(tracks[0]?.contentUrl),
    })
  ) {
    return session
  }
  return {
    ...session,
    audioTracks: parts.parts.map((p, i) => ({
      index: i + 1,
      contentUrl: p.url,
      mimeType: 'audio/mp4',
      duration: p.duration,
      startOffset: p.start,
    })),
  }
}

// Start a book, asking for its quick-start parts alongside the play session so
// the extra request adds no wait of its own.
export async function startPlayBook(itemId: string): Promise<ABSPlaybackSession> {
  const [session, parts] = await Promise.all([startPlay(itemId), getBookParts(itemId)])
  return withBookParts(session, parts)
}

// Episode-scoped play for podcasts. @needs-verify against a live podcast library
// - this ABS instance has only book libraries.
export function startPlayEpisode(itemId: string, episodeId: string): Promise<ABSPlaybackSession> {
  return absRequest<ABSPlaybackSession>(`/api/items/${itemId}/play/${episodeId}`, {
    method: 'POST',
    body: JSON.stringify({
      deviceInfo: DEVICE,
      supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg'],
    }),
  })
}

interface SyncPayload {
  currentTime: number
  timeListened: number
  duration: number
}

// Periodic progress sync during playback. Returns void - the body is ignored.
export async function syncSession(sessionId: string, payload: SyncPayload): Promise<void> {
  const token = useAuthStore.getState().token
  await fetch(`${BASE}/api/session/${sessionId}/sync`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  })
}

// Close the session (on stop / unload). Final position is persisted.
export async function closeSession(sessionId: string, payload: SyncPayload): Promise<void> {
  const token = useAuthStore.getState().token
  await fetch(`${BASE}/api/session/${sessionId}/close`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  })
}

// Synchronous best-effort close for `beforeunload`. sendBeacon can't set an
// Authorization header, so the token rides as a query param (same trick as
// stream/cover URLs).
export function closeSessionBeacon(sessionId: string, payload: SyncPayload): void {
  const token = useAuthStore.getState().token
  const params = token ? `?token=${encodeURIComponent(token)}` : ''
  const url = `${BASE}/api/session/${sessionId}/close${params}`
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
  navigator.sendBeacon(url, blob)
}

// Build a natively-loadable stream URL from a track's contentUrl. ABS paths go
// through the /abs-api proxy; quick-start parts (/hs/parts/...) are served by
// the HearthShelf backend on this same origin.
export function streamUrl(contentUrl: string): string {
  const token = useAuthStore.getState().token
  const sep = contentUrl.includes('?') ? '&' : '?'
  const auth = token ? `${sep}token=${encodeURIComponent(token)}` : ''
  const base = contentUrl.startsWith('/hs/') ? '' : BASE
  return `${base}${contentUrl}${auth}`
}
