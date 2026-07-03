import { useEffect, useRef } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { streamUrl } from '@/api/playback'
import { useProgress } from '@/hooks/useProgress'
import { useQueueAdvance } from '@/hooks/useQueueAdvance'
import { useSettingsStore } from '@/store/settingsStore'
import { useQueueStore } from '@/store/queueStore'
import { setAudioElement } from '@/lib/audioRef'

// The single, persistent <audio> element. Mounted once by AppShell and never
// unmounted, so playback survives route changes. It bridges the DOM media
// element to the player store: store -> element (src, play/pause, speed, seek)
// and element -> store (currentTime, duration, ended).
export function AudioEngine() {
  const ref = useRef<HTMLAudioElement>(null)
  const tracks = usePlayerStore((s) => s.tracks)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const speed = usePlayerStore((s) => s.playbackSpeed)
  const volume = usePlayerStore((s) => s.volume)
  const seekTarget = usePlayerStore((s) => s.seekTarget)
  const seekNonce = usePlayerStore((s) => s.seekNonce)
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime)
  const setDuration = usePlayerStore((s) => s.setDuration)
  const setPlaying = usePlayerStore((s) => s.setPlaying)
  const sessionId = usePlayerStore((s) => s.sessionId)
  const queueMode = useSettingsStore((s) => s.queueMode)
  const defaultSpeed = useSettingsStore((s) => s.defaultSpeed)
  const { advance, refresh } = useQueueAdvance()

  useProgress()

  // Settings (synced, durable) is the source of truth for the queue mode; mirror
  // it into the session-scoped queue store the player reads from.
  useEffect(() => {
    useQueueStore.getState().setMode(queueMode)
  }, [queueMode])

  // On app load (and whenever the mode could have changed via settings sync),
  // populate the up-next list for Auto/Playlist modes once a session is active.
  useEffect(() => {
    if (sessionId) void refresh()
  }, [sessionId, queueMode, refresh])

  // Publish the element so the sleep-timer fade can reach its volume.
  useEffect(() => {
    setAudioElement(ref.current)
    return () => setAudioElement(null)
  }, [])

  // v0.1 books are single-file; use the first track. Multi-track stitching is
  // a later concern.
  const src = tracks[0] ? streamUrl(tracks[0].contentUrl) : ''

  // Load a new source when the track changes.
  useEffect(() => {
    const el = ref.current
    if (!el || !src) return
    el.src = src
    el.load()
    usePlayerStore.getState().setSpeed(defaultSpeed)
  }, [src, defaultSpeed])

  // Apply the seek requests coming from the store (resume position, scrubber,
  // chapter jumps). Driven by the nonce so repeated seeks to the same time fire.
  useEffect(() => {
    const el = ref.current
    if (!el || !src) return
    if (Number.isFinite(seekTarget)) el.currentTime = seekTarget
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce, src])

  // Reflect play/pause intent onto the element.
  useEffect(() => {
    const el = ref.current
    if (!el || !src) return
    if (isPlaying) {
      el.play().catch(() => setPlaying(false))
    } else {
      el.pause()
    }
  }, [isPlaying, src, setPlaying])

  // Apply playback rate.
  useEffect(() => {
    const el = ref.current
    if (el) el.playbackRate = speed
  }, [speed, src])

  // Apply volume. The sleep-timer fade temporarily drives volume directly and
  // restores to this level when it finishes.
  useEffect(() => {
    const el = ref.current
    if (el) el.volume = volume
  }, [volume, src])

  return (
    <audio
      ref={ref}
      preload="metadata"
      onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
      onLoadedMetadata={(e) => {
        const el = e.currentTarget
        if (el.duration) setDuration(el.duration)
        // Apply any pending resume/seek now that seeking is possible.
        const target = usePlayerStore.getState().seekTarget
        if (target > 0 && Number.isFinite(target)) el.currentTime = target
      }}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => void advance()}
    />
  )
}
