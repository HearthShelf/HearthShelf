import { useEffect } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useAuthStore } from '@/store/authStore'
import { getAudioElement } from '@/lib/audioRef'

// Lock screen, notification, hardware media keys and in-car browser transport
// controls. Always on the whole book's timeline: a book played as several
// tracks (files, or the server's quick-start parts) must not show the current
// track's own 0:00-58:00 on the lock screen. Mounted once, by AudioEngine.
export function useMediaSession() {
  const libraryItemId = usePlayerStore((s) => s.libraryItemId)
  const title = usePlayerStore((s) => s.title)
  const author = usePlayerStore((s) => s.author)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const duration = usePlayerStore((s) => s.duration)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const speed = usePlayerStore((s) => s.playbackSpeed)
  const skipForward = useSettingsStore((s) => s.skipForward)
  const skipBack = useSettingsStore((s) => s.skipBack)

  // Title, author and cover art.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (!libraryItemId || !title) {
      navigator.mediaSession.metadata = null
      return
    }
    const token = useAuthStore.getState().token
    const params = token ? `?token=${encodeURIComponent(token)}` : ''
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: author ?? undefined,
      artwork: [{ src: `/abs-api/api/items/${libraryItemId}/cover${params}` }],
    })
  }, [libraryItemId, title, author])

  // Transport actions. Each handler is registered on its own: some browsers
  // (car browsers among them) throw for actions they don't know, and one throw
  // must not stop the rest from registering.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !libraryItemId) return
    const ms = navigator.mediaSession
    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler)
      } catch {
        // Unsupported on this browser.
      }
    }
    const skip = (delta: number) => {
      const { currentTime: t, duration: d, seek } = usePlayerStore.getState()
      seek(Math.max(0, Math.min(d, t + delta)))
    }
    setHandler('play', () => {
      // Start the element right here as well: some phones only honour play()
      // inside the lock-screen tap itself, not after a re-render.
      void getAudioElement()
        ?.play()
        .catch(() => {})
      usePlayerStore.getState().setPlaying(true)
    })
    setHandler('pause', () => {
      getAudioElement()?.pause()
      usePlayerStore.getState().setPlaying(false)
    })
    setHandler('seekbackward', (d) => skip(-(d.seekOffset ?? skipBack)))
    setHandler('seekforward', (d) => skip(d.seekOffset ?? skipForward))
    setHandler('seekto', (d) => {
      if (d.seekTime != null) usePlayerStore.getState().seek(d.seekTime)
    })
    // Some car widgets only show previous/next track buttons; make them skip.
    setHandler('previoustrack', () => skip(-skipBack))
    setHandler('nexttrack', () => skip(skipForward))
    return () => {
      for (const a of [
        'play',
        'pause',
        'seekbackward',
        'seekforward',
        'seekto',
        'previoustrack',
        'nexttrack',
      ] as const) {
        setHandler(a, null)
      }
    }
  }, [libraryItemId, skipForward, skipBack])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = libraryItemId
      ? isPlaying
        ? 'playing'
        : 'paused'
      : 'none'
  }, [libraryItemId, isPlaying])

  // The book-timeline position, so the lock screen / car scrubber shows and
  // seeks the whole book.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return
    if (!libraryItemId || !duration || !Number.isFinite(duration)) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.max(0, Math.min(currentTime, duration)),
        playbackRate: speed > 0 ? speed : 1,
      })
    } catch {
      // Position and duration can briefly disagree while a track loads.
    }
  }, [libraryItemId, duration, currentTime, speed])
}
