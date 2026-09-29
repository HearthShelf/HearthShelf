import { useCallback } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { startPlayBook, startPlayEpisode } from '@/api/playback'

const SPEEDS = [1, 1.25, 1.5, 1.75, 2]

export function usePlayer() {
  const openSession = usePlayerStore((s) => s.openSession)
  const togglePlaying = usePlayerStore((s) => s.togglePlaying)
  const seek = usePlayerStore((s) => s.seek)
  const setSpeed = usePlayerStore((s) => s.setSpeed)

  // Start (or resume) a book. ABS returns the server-side resume position,
  // which openSession applies as the initial seek. Pass startAt to override
  // that and jump to a specific second (e.g. replay a session from its start).
  const playItem = useCallback(
    async (itemId: string, startAt?: number) => {
      const session = await startPlayBook(itemId)
      openSession(session)
      if (startAt !== undefined) seek(startAt)
    },
    [openSession, seek],
  )

  // Episode-scoped play for podcasts.
  const playEpisode = useCallback(
    async (itemId: string, episodeId: string) => {
      const session = await startPlayEpisode(itemId, episodeId)
      openSession(session)
    },
    [openSession],
  )

  const skip = useCallback(
    (delta: number) => {
      const { currentTime, duration } = usePlayerStore.getState()
      seek(Math.max(0, Math.min(duration, currentTime + delta)))
    },
    [seek],
  )

  const cycleSpeed = useCallback(() => {
    const cur = usePlayerStore.getState().playbackSpeed
    const idx = SPEEDS.indexOf(cur)
    setSpeed(SPEEDS[(idx + 1) % SPEEDS.length])
  }, [setSpeed])

  // Jump to the previous / next chapter boundary.
  const chapterStep = useCallback(
    (dir: 1 | -1) => {
      const { chapters, currentTime } = usePlayerStore.getState()
      if (chapters.length === 0) return
      if (dir === 1) {
        const next = chapters.find((c) => c.start > currentTime + 0.5)
        if (next) seek(next.start)
      } else {
        // back to the start of the current chapter, or the previous one if
        // we're already near the start.
        const idx = chapters.findIndex((c) => c.start > currentTime)
        const curIdx = (idx === -1 ? chapters.length : idx) - 1
        const target =
          currentTime - (chapters[curIdx]?.start ?? 0) < 2
            ? chapters[Math.max(0, curIdx - 1)]
            : chapters[curIdx]
        if (target) seek(target.start)
      }
    },
    [seek],
  )

  return { playItem, playEpisode, togglePlaying, seek, skip, cycleSpeed, chapterStep }
}
