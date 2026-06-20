import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePlayerStore } from '@/store/playerStore'
import { syncSession, closeSessionBeacon } from '@/api/playback'
import { meKeys } from '@/api/me'

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

  const buildPayload = () => {
    const { currentTime, duration } = usePlayerStore.getState()
    const now = performance.now()
    const listened = lastSyncAt.current
      ? Math.max(0, (now - lastSyncAt.current) / 1000)
      : 0
    lastSyncAt.current = now
    return { currentTime, timeListened: listened, duration }
  }

  // Sync once and reflect the outcome on the player's sync-status pill.
  const syncOnce = (sid: string) =>
    syncSession(sid, buildPayload())
      .then(() => setSyncError(false))
      .catch(() => setSyncError(true))

  // Periodic sync while playing.
  useEffect(() => {
    if (!sessionId || !isPlaying) return
    lastSyncAt.current = performance.now()
    const id = setInterval(() => {
      const sid = usePlayerStore.getState().sessionId
      if (sid) void syncOnce(sid)
    }, SYNC_INTERVAL_MS)
    return () => clearInterval(id)
  }, [sessionId, isPlaying])

  // One sync when playback pauses (captures the position promptly), then
  // refresh progress-derived queries so tiles/shelves update.
  useEffect(() => {
    if (!sessionId || isPlaying) return
    if (lastSyncAt.current === null) return
    void syncOnce(sessionId).then(() => {
      queryClient.invalidateQueries({ queryKey: meKeys.itemsInProgress })
      queryClient.invalidateQueries({ queryKey: meKeys.me })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, sessionId])

  // Best-effort close on tab unload (sendBeacon survives the page teardown).
  useEffect(() => {
    const onUnload = () => {
      const sid = usePlayerStore.getState().sessionId
      if (sid) closeSessionBeacon(sid, buildPayload())
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])
}
