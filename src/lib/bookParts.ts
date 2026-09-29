/**
 * Book "parts": small, quick-to-start audio files the HearthShelf server cuts
 * from one very long single-file book (GET /hs/parts/:itemId).
 *
 * A 70-hour .m4b carries a ~40 MB index that a browser must fetch and parse
 * before it can play a single second; phones and car browsers often never get
 * there. The parts cover the same book timeline, so the player just treats them
 * as consecutive tracks. The ABS play session is unchanged - only where the
 * audio bytes come from.
 *
 * Pure logic, no I/O. The same file lives in the HearthShelf-WebApp repo
 * (src/lib/bookParts.ts); it is a candidate for @hearthshelf/core.
 */

export interface BookPart {
  index: number
  /** Seconds on the book timeline where this part begins. */
  start: number
  duration: number
  /** Server-relative path, e.g. /hs/parts/<itemId>/<index>. Add ?token= to load. */
  url: string
}

export interface BookParts {
  parts: BookPart[]
  /** The single audio file the parts were cut from. */
  source: { ino: string; duration: number } | null
}

/** Start loading the next track this many BOOK seconds before the boundary. */
export const NEXT_TRACK_PRELOAD_SEC = 45

// Parts are contiguous by contract; allow a little slack for encoder rounding.
const CONTIGUITY_TOLERANCE_SEC = 1

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Validate a /hs/parts response. Returns null for `{ parts: null }`, anything
 * malformed, or a list that doesn't form one contiguous timeline - the caller
 * then plays the original file(s) exactly as before.
 *
 * Part URLs must be same-server paths ("/..."), never absolute URLs: the player
 * appends the user's token to them, and that token must not leave the server.
 */
export function parseBookParts(raw: unknown): BookParts | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as { parts?: unknown; source?: unknown }
  if (!Array.isArray(body.parts) || body.parts.length === 0) return null

  const parts: BookPart[] = []
  for (const p of body.parts as unknown[]) {
    if (!p || typeof p !== 'object') return null
    const { index, start, duration, url } = p as Record<string, unknown>
    if (!isFiniteNumber(index) || !isFiniteNumber(start) || !isFiniteNumber(duration)) return null
    if (start < 0 || duration <= 0) return null
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null
    parts.push({ index, start, duration, url })
  }
  parts.sort((a, b) => a.start - b.start)
  if (parts[0].start > CONTIGUITY_TOLERANCE_SEC) return null
  for (let i = 1; i < parts.length; i++) {
    const prevEnd = parts[i - 1].start + parts[i - 1].duration
    if (Math.abs(parts[i].start - prevEnd) > CONTIGUITY_TOLERANCE_SEC) return null
  }

  let source: BookParts['source'] = null
  if (body.source && typeof body.source === 'object') {
    const s = body.source as Record<string, unknown>
    if (isFiniteNumber(s.duration)) {
      source = { ino: s.ino == null ? '' : String(s.ino), duration: s.duration }
    }
  }
  return { parts, source }
}

/** The file id ("ino") in an ABS track contentUrl like /api/items/:id/file/:ino. */
export function inoFromContentUrl(contentUrl: string | null | undefined): string | null {
  const m = /\/file\/([^/?#]+)/.exec(contentUrl ?? '')
  return m ? decodeURIComponent(m[1]) : null
}

/**
 * Whether a parts list can stand in for what the play session returned. Parts
 * only replace a single-file book, must come from that same file when both
 * sides name it, and must cover the whole book (within a small tolerance).
 */
export function partsFitSession(
  parts: BookParts,
  session: { durationSec: number; trackCount: number; trackIno: string | null },
): boolean {
  if (session.trackCount !== 1) return false
  const { source } = parts
  if (source?.ino && session.trackIno && source.ino !== session.trackIno) return false
  const last = parts.parts[parts.parts.length - 1]
  const covered = last.start + last.duration
  const expected = session.durationSec > 0 ? session.durationSec : (source?.duration ?? 0)
  if (expected <= 0) return false
  return Math.abs(covered - expected) <= Math.max(5, expected * 0.001)
}

/** Index of the track that covers a book position (clamped to first/last). */
export function trackIndexForPosition(starts: readonly number[], pos: number): number {
  for (let i = starts.length - 1; i >= 0; i--) {
    if (pos >= starts[i]) return i
  }
  return 0
}
