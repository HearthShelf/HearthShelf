// Shared note-rendering helpers for the web social surfaces (BookDetailPage
// notes section, PlayerPage notes pop, club chat). Pure functions - the chapter
// label and thread grouping used wherever notes render.

import { formatTimestamp } from '@/lib/format'
import type { ABSChapter } from '@/api/types'
import type { HSNote } from '@hearthshelf/core'

// A human label for a timestamped note. With chapters, "Chapter 3 - 1:02:05";
// without, just "1:02:05". A general (ungated) note returns '' (no stamp).
export function noteTimeLabel(timeSec: number | null, chapters: ABSChapter[]): string {
  if (timeSec == null) return ''
  const ts = formatTimestamp(timeSec)
  if (!chapters.length) return ts
  let idx = chapters.findIndex((c) => timeSec < c.end)
  if (idx === -1) idx = chapters.length - 1
  const ch = chapters[idx]
  const name = ch?.title?.trim()
  const prefix = name ? name : `Chapter ${idx + 1}`
  return `${prefix} - ${ts}`
}

// A top-level note with its (one-level) replies attached, for rendering threads.
export interface NoteThread {
  note: HSNote
  replies: HSNote[]
}

// Group a flat note list into top-level threads with their replies. Top-level
// notes keep server order (created_at asc); replies attach to their parent in
// order. Orphan replies (parent not in the list) are dropped - the server only
// returns replies whose parent unlocked, so this is defensive.
export function buildThreads(notes: HSNote[]): NoteThread[] {
  const threads: NoteThread[] = []
  const byId = new Map<string, NoteThread>()
  for (const n of notes) {
    if (n.parentId === '') {
      const t: NoteThread = { note: n, replies: [] }
      threads.push(t)
      byId.set(n.id, t)
    }
  }
  for (const n of notes) {
    if (n.parentId !== '') {
      const parent = byId.get(n.parentId)
      if (parent) parent.replies.push(n)
    }
  }
  return threads
}
