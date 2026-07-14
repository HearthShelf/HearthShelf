import { useCallback } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { useQueueStore } from '@/store/queueStore'
import { usePlayer } from '@/hooks/usePlayer'
import { useMarkFinished } from '@/hooks/useMarkFinished'

// Set true for the one book-change that a book-end auto-advance causes, so the
// AudioEngine's play-cooldown does NOT recompute the queue for it (only explicit
// plays should). Read-and-cleared by the cooldown when the new book loads.
let advancedByEnd = false
export function markAdvancedByEnd(): void {
  advancedByEnd = true
}
export function consumeAdvancedByEnd(): boolean {
  const v = advancedByEnd
  advancedByEnd = false
  return v
}

// Encapsulates "what plays next when a book ends", honoring the queue mode.
// Returns a single advance() the AudioEngine calls from onEnded.
//
// The server owns the queue (Auto/Playlist are computed server-side by
// resolveQueue; see server/lib/computeQueue.js). This client is a pure consumer:
// it never builds the queue itself. It just marks the finished book and plays
// the head of the up-next list it already holds (kept current by useQueueSync +
// the play-cooldown recompute in AudioEngine).
export function useQueueAdvance() {
  const { playItem } = usePlayer()
  const { markFinished } = useMarkFinished()

  const advance = useCallback(async () => {
    const cur = usePlayerStore.getState().libraryItemId
    const { mode } = useQueueStore.getState()
    if (cur) await markFinished([cur], true).catch(() => {})

    if (mode === 'off') {
      usePlayerStore.getState().setPlaying(false)
      return
    }

    // Play the head of the queue we ALREADY hold - no rebuild here. Recomputing
    // at book-end would re-seed 'finish-series' from the just-ended book while
    // its progress is mid-invalidation and jump past the next book in the series
    // (the "book ended and it jumped away" bug). The new book's play-cooldown
    // recomputes once it's genuinely playing.
    const head = useQueueStore.getState().next()
    if (head) {
      // This play is a book-end advance: suppress the cooldown's recompute for it.
      markAdvancedByEnd()
      void playItem(head.libraryItemId)
    } else usePlayerStore.getState().setPlaying(false)
  }, [markFinished, playItem])

  return { advance }
}
