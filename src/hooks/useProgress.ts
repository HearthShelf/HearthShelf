import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePlayerStore } from '@/store/playerStore'
import { syncSession, closeSessionBeacon } from '@/api/playback'
import { meKeys, updateProgress } from '@/api/me'
import { notesKeys } from '@/api/notes'
import { evaluateCompletion } from '@hearthshelf/core'
import { useSettingsStore } from '@/store/settingsStore'

const SYNC_INTERVAL_MS = 30_000

// Drives progress sync for the active session: every 30s while playing, once on
// pause, and a best-effort close on tab unload. Mounted once (in AudioEngine).
export function useProgress() {
  const queryClient = useQueryClient()
  const sessionId = usePlayerStore((s) => s.sessionId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const setSyncError = usePlayerStore((s) => s.setSyncError)

  // Track the wall-clock of the last sync to report timeListened accurately.
  const lastSyncAt = useRef<number | null>(null)

  // Ask core whether the book counts as done, using the user's thresholds.
  // `ended` is passed by the AudioEngine on real end-of-audio.
  const completion = (ended = false) => {
    const { currentTime, duration, chapters } = usePlayerStore.getState()
    const s = useSettingsStore.getState()
    return evaluateCompletion({
      currentTime,
      duration,
      chapters,
      ended,
      thresholds: {
        creditsChapterMaxSec: s.creditsChapterMaxSec,
        chapterEndGraceSec: s.chapterEndGraceSec,
        percentComplete: s.finishedPercent > 0 ? s.finishedPercent / 100 : null,
      },
    })
  }

  // `settled` marks the syncs where playback has come to rest - pause, real
  // end-of-audio, tab unload. Only those snap the reported position to
  // `duration` when the book qualifies as finished, so ABS's own timeRemaining
  // check agrees with ours however its library is configured (MediaProgress.js).
  // Without the snap a book stopped in the end credits syncs 36s short and sits
  // at "100% - 0 chapters left" forever.
  //
  // The periodic mid-playback sync deliberately passes settled = false: someone
  // still listening through the credits would otherwise have their real position
  // overwritten with the end of the book while the audio is still rolling.
  const buildPayload = ({ settled = false, ended = false } = {}) => {
    const { currentTime, duration } = usePlayerStore.getState()
    const now = performance.now()
    const listened = lastSyncAt.current ? Math.max(0, (now - lastSyncAt.current) / 1000) : 0
    lastSyncAt.current = now
    const reported = settled ? completion(ended).reportedTime : currentTime
    return { currentTime: reported, timeListened: listened, duration }
  }

  // Sync once and reflect the outcome on the player's sync-status pill.
  const syncOnce = (sid: string, opts?: { settled?: boolean; ended?: boolean }) =>
    syncSession(sid, buildPayload(opts))
      .then(() => setSyncError(false))
      .catch(() => setSyncError(true))

  // Periodic sync while playing. Piggyback a refresh of the playing book's notes
  // on the same 30s cadence so seek-bar note markers and any open notes/club
  // surface stay fresh without their own timer while the book plays.
  useEffect(() => {
    if (!sessionId || !isPlaying) return
    lastSyncAt.current = performance.now()
    const id = setInterval(() => {
      const sid = usePlayerStore.getState().sessionId
      if (sid) void syncOnce(sid)
      const itemId = usePlayerStore.getState().libraryItemId
      if (itemId) {
        queryClient.invalidateQueries({ queryKey: notesKeys.forItem(itemId) })
      }
    }, SYNC_INTERVAL_MS)
    return () => clearInterval(id)
  }, [sessionId, isPlaying, queryClient])

  // One sync when playback pauses (captures the position promptly), then
  // refresh progress-derived queries so tiles/shelves update.
  //
  // If the stop position qualifies as finished, also PATCH isFinished
  // explicitly. The sync above reports currentTime = duration, which ABS would
  // usually convert to finished on its own - but only its own rules get a vote
  // there, and our chapter-aware rules are deliberately more generous (a 38s
  // credits chapter is not covered by any ABS setting). Stating it outright is
  // what makes "stopped in the credits" actually land as done.
  useEffect(() => {
    if (!sessionId || isPlaying) return
    if (lastSyncAt.current === null) return
    const itemId = usePlayerStore.getState().libraryItemId
    const done = completion().isFinished
    void syncOnce(sessionId, { settled: true })
      .then(async () => {
        if (done && itemId) {
          await updateProgress(itemId, { isFinished: true }).catch(() => {})
        }
      })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: meKeys.itemsInProgress })
        queryClient.invalidateQueries({ queryKey: meKeys.me })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, sessionId])

  // Best-effort close on tab unload (sendBeacon survives the page teardown).
  useEffect(() => {
    const onUnload = () => {
      const sid = usePlayerStore.getState().sessionId
      if (sid) closeSessionBeacon(sid, buildPayload({ settled: true }))
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  // Called by the AudioEngine when the audio actually reaches its end, BEFORE
  // the queue advances to the next book. Pins the final position at exactly
  // `duration` so the finished book can never be left a few seconds short by
  // the last periodic sync (this is what the mobile app does on completion).
  const syncEnded = async () => {
    const sid = usePlayerStore.getState().sessionId
    if (!sid) return
    await syncSession(sid, buildPayload({ settled: true, ended: true })).catch(() => {})
  }

  return { syncEnded }
}
