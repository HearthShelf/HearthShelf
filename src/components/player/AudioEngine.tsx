import { useEffect, useRef } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { streamUrl } from '@/api/playback'
import { useProgress } from '@/hooks/useProgress'
import { useQueueAdvance, consumeAdvancedByEnd } from '@/hooks/useQueueAdvance'
import { useSettingsStore } from '@/store/settingsStore'
import { useQueueStore } from '@/store/queueStore'
import { recomputeServerQueue } from '@/api/queue'
import { setAudioElement } from '@/lib/audioRef'

// Real playback seconds a newly-started book must accrue before its Auto queue
// rebuilds. Long enough to ignore an accidental tap; short enough that up-next
// isn't stale for long after a legit book change.
const QUEUE_RECOMPUTE_COOLDOWN_SEC = 120

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
  const queueAutoRules = useSettingsStore((s) => s.queueAutoRules)
  const defaultSpeed = useSettingsStore((s) => s.defaultSpeed)
  const libraryItemId = usePlayerStore((s) => s.libraryItemId)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const { advance } = useQueueAdvance()

  const { syncEnded } = useProgress()

  // Play-cooldown refs. A newly-loaded book arms a cooldown (unless it came from
  // a book-end auto-advance); once it accrues enough real playback, the Auto
  // queue rebuilds. Deferring the rebuild is what keeps a book-end (or an
  // accidental tap) from reshuffling up-next in the ambiguous just-started window.
  const cooldownArmedRef = useRef(false)
  const cooldownAccruedRef = useRef(0)
  const cooldownLastTimeRef = useRef(0)
  const cooldownFiredRef = useRef(false)

  // Settings (synced, durable) is the source of truth for the queue mode; mirror
  // it into the session-scoped queue store the player reads from.
  useEffect(() => {
    useQueueStore.getState().setMode(queueMode)
  }, [queueMode])

  // When the queue mode OR the Auto rules change (via settings sync), ask the
  // server to rebuild the queue and adopt it - a rules toggle takes effect
  // immediately. On app load useQueueSync already pulls, so we only recompute
  // here when the settings actually changed (skip the initial mount).
  const settingsHydratedRef = useRef(false)
  useEffect(() => {
    if (!sessionId) return
    if (!settingsHydratedRef.current) {
      settingsHydratedRef.current = true
      return
    }
    void recomputeServerQueue()
      .then((q) => useQueueStore.setState({ items: q.items, manual: q.manual, playlistId: q.playlistId, updatedAt: q.updatedAt }))
      .catch(() => {})
  }, [sessionId, queueMode, queueAutoRules])

  // Play-cooldown, part 1: a new book loaded. Reset accrual and arm the cooldown
  // unless this book arrived via a book-end auto-advance (which must not recompute).
  useEffect(() => {
    cooldownArmedRef.current = !consumeAdvancedByEnd()
    cooldownAccruedRef.current = 0
    cooldownLastTimeRef.current = usePlayerStore.getState().currentTime
    cooldownFiredRef.current = false
  }, [libraryItemId])

  // Play-cooldown, part 2: accrue real playback seconds each tick; once past the
  // threshold, ask the server to recompute the Auto queue once (stamping this
  // book as current) and adopt it. Deferring the recompute is what keeps a
  // book-end / accidental tap from reshuffling up-next in the just-started window.
  useEffect(() => {
    if (!cooldownArmedRef.current || cooldownFiredRef.current) return
    if (useQueueStore.getState().mode !== 'auto') return
    const armedItem = libraryItemId
    if (isPlaying) {
      const delta = currentTime - cooldownLastTimeRef.current
      if (delta > 0 && delta < 5) cooldownAccruedRef.current += delta
    }
    cooldownLastTimeRef.current = currentTime
    if (cooldownAccruedRef.current >= QUEUE_RECOMPUTE_COOLDOWN_SEC) {
      cooldownFiredRef.current = true
      void recomputeServerQueue(armedItem)
        .then((q) => {
          if (usePlayerStore.getState().sessionId && useQueueStore.getState().mode !== 'manual') {
            useQueueStore.setState({ items: q.items, manual: q.manual, playlistId: q.playlistId, updatedAt: q.updatedAt })
          }
        })
        .catch(() => {})
    }
  }, [currentTime, isPlaying, libraryItemId])

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
      // Pin the final position at the book's full duration before advancing, so
      // the book we're leaving can't be left a few seconds short of finished.
      onEnded={() => void syncEnded().then(() => advance())}
    />
  )
}
