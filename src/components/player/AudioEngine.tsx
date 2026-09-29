import { useEffect, useRef } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { streamUrl } from '@/api/playback'
import { useProgress } from '@/hooks/useProgress'
import { useQueueAdvance, consumeAdvancedByEnd } from '@/hooks/useQueueAdvance'
import { useMediaSession } from '@/hooks/useMediaSession'
import { useSettingsStore } from '@/store/settingsStore'
import { useQueueStore } from '@/store/queueStore'
import { recomputeServerQueue } from '@/api/queue'
import { setAudioElement } from '@/lib/audioRef'
import { NEXT_TRACK_PRELOAD_SEC, trackIndexForPosition } from '@/lib/bookParts'

// Real playback seconds a newly-started book must accrue before its Auto queue
// rebuilds. Long enough to ignore an accidental tap; short enough that up-next
// isn't stale for long after a legit book change.
const QUEUE_RECOMPUTE_COOLDOWN_SEC = 120

// Drop an element's source so it stops buffering and frees its memory.
function releaseElement(el: HTMLAudioElement) {
  el.pause()
  el.removeAttribute('src')
  el.load()
}

// The persistent audio engine. Mounted once by AppShell and never unmounted, so
// playback survives route changes. It bridges the player store to the media
// elements: store -> element (tracks, play/pause, speed, seek) and element ->
// store (book position, ended).
//
// A book is one or many tracks (audio files, or the server's quick-start parts
// of one huge file), each with a startOffset on one book timeline. The store
// only ever sees book seconds; this engine maps them to (track, local offset).
// Two <audio> elements take turns: the active one plays the current track while
// the standby one loads the next track shortly before the boundary, then takes
// over when the current track ends. Browsers that refuse to start a second
// element without a tap fall back to swapping the src on the active element.
export function AudioEngine() {
  const aRef = useRef<HTMLAudioElement>(null)
  const bRef = useRef<HTMLAudioElement>(null)
  const tracks = usePlayerStore((s) => s.tracks)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const speed = usePlayerStore((s) => s.playbackSpeed)
  const volume = usePlayerStore((s) => s.volume)
  const seekNonce = usePlayerStore((s) => s.seekNonce)
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime)
  const setDuration = usePlayerStore((s) => s.setDuration)
  const setPlaying = usePlayerStore((s) => s.setPlaying)
  const sessionId = usePlayerStore((s) => s.sessionId)
  const queueMode = useSettingsStore((s) => s.queueMode)
  const queueAutoRules = useSettingsStore((s) => s.queueAutoRules)
  const libraryItemId = usePlayerStore((s) => s.libraryItemId)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const { advance } = useQueueAdvance()

  const { syncEnded } = useProgress()
  useMediaSession()

  // The element playing the current track; the other one is the standby.
  const activeRef = useRef<HTMLAudioElement | null>(null)
  // Index of the track loaded in the active / standby element (-1 = none).
  const curIdxRef = useRef(-1)
  const spareIdxRef = useRef(-1)
  // False from the moment a track starts loading until its seek offset lands.
  // Load fires timeupdate at 0 first; recording that would clobber the resume point.
  const seekedRef = useRef(false)
  // Bumped per load so a late loadedmetadata can't apply a stale seek.
  const loadSeqRef = useRef(0)
  // Set once a browser refuses to start the standby element by itself.
  const noHandoffRef = useRef(false)
  // The seek request the tracks effect already applied as the initial load.
  const handledNonceRef = useRef(-1)

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
      .then((q) =>
        useQueueStore.setState({
          items: q.items,
          manual: q.manual,
          playlistId: q.playlistId,
          updatedAt: q.updatedAt,
        }),
      )
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
            useQueueStore.setState({
              items: q.items,
              manual: q.manual,
              playlistId: q.playlistId,
              updatedAt: q.updatedAt,
            })
          }
        })
        .catch(() => {})
    }
  }, [currentTime, isPlaying, libraryItemId])

  // The element that isn't active.
  const spareOf = (el: HTMLAudioElement | null) =>
    el === aRef.current ? bRef.current : aRef.current

  const setActive = (el: HTMLAudioElement | null) => {
    activeRef.current = el
    // Published so the sleep-timer fade reaches whichever element is playing.
    setAudioElement(el)
  }

  // Seek `el` to a local offset once its metadata is in, then play if the store
  // wants playback. Blocks position tracking until the seek lands.
  const startAt = (el: HTMLAudioElement, localSec: number, onPlayFailed?: (e: unknown) => void) => {
    const seq = ++loadSeqRef.current
    seekedRef.current = false
    const apply = () => {
      if (seq !== loadSeqRef.current || el !== activeRef.current) return
      el.currentTime = Math.max(0, Math.min(localSec, el.duration || localSec))
      el.playbackRate = usePlayerStore.getState().playbackSpeed
      seekedRef.current = true
      if (usePlayerStore.getState().isPlaying) {
        el.play().catch((e: unknown) => {
          if (onPlayFailed) onPlayFailed(e)
          else setPlaying(false)
        })
      }
    }
    if (el.readyState >= 1) apply()
    else el.addEventListener('loadedmetadata', apply, { once: true })
  }

  // Make track `idx` current at a local offset. When the standby element already
  // holds it, hand playback over instead of loading it from scratch.
  const loadTrack = (idx: number, localSec: number) => {
    const list = usePlayerStore.getState().tracks
    const track = list[idx]
    const active = activeRef.current
    const spare = spareOf(active)
    if (!track || !active) return
    if (spare && spareIdxRef.current === idx && !spare.error && !noHandoffRef.current) {
      spare.volume = active.volume // carries a sleep fade that is mid-ramp
      setActive(spare)
      curIdxRef.current = idx
      spareIdxRef.current = -1
      startAt(spare, localSec, (e) => {
        if (activeRef.current !== spare) return
        if (e instanceof DOMException && e.name === 'NotAllowedError') {
          // This browser won't start a second element without a tap: go back to
          // the first element and just swap its src, now and from here on.
          noHandoffRef.current = true
          releaseElement(spare)
          setActive(active)
          active.src = streamUrl(track.contentUrl)
          active.load()
          startAt(active, localSec)
          return
        }
        setPlaying(false)
      })
      // Free the finished track's buffers.
      releaseElement(active)
      return
    }
    curIdxRef.current = idx
    // The standby only helps when it holds the track right after this one.
    if (spare && spareIdxRef.current !== -1 && spareIdxRef.current !== idx + 1) {
      spareIdxRef.current = -1
      releaseElement(spare)
    }
    active.src = streamUrl(track.contentUrl)
    active.load()
    startAt(active, localSec)
  }

  // Load the track after the current one into the standby element.
  const preloadNext = (idx: number) => {
    const track = usePlayerStore.getState().tracks[idx]
    const spare = spareOf(activeRef.current)
    if (!track || !spare || noHandoffRef.current) return
    spareIdxRef.current = idx
    spare.src = streamUrl(track.contentUrl)
    spare.load()
  }

  // Jump to a book position: pick the track, then seek within it.
  const seekBook = (bookSec: number) => {
    const list = usePlayerStore.getState().tracks
    if (list.length === 0 || !Number.isFinite(bookSec)) return
    const idx = trackIndexForPosition(
      list.map((t) => t.startOffset ?? 0),
      Math.max(0, bookSec),
    )
    const local = Math.max(0, bookSec - (list[idx].startOffset ?? 0))
    const active = activeRef.current
    if (idx !== curIdxRef.current || !active) {
      loadTrack(idx, local)
    } else if (seekedRef.current) {
      active.currentTime = local
    } else {
      startAt(active, local) // still loading: re-aim the pending seek
    }
  }

  // Publish the first element as the active one.
  useEffect(() => {
    setActive(aRef.current)
    return () => setAudioElement(null)
  }, [])

  // A new track list (a new book, or the session closed): reset both elements
  // and load at the store's resume position.
  useEffect(() => {
    for (const el of [aRef.current, bRef.current]) {
      if (el && el.getAttribute('src')) releaseElement(el)
    }
    curIdxRef.current = -1
    spareIdxRef.current = -1
    seekedRef.current = false
    if (tracks.length === 0) return
    // Each new book starts at the default speed (read, not subscribed: changing
    // the setting mid-book must not reload the book).
    usePlayerStore.getState().setSpeed(useSettingsStore.getState().defaultSpeed)
    const { seekTarget, seekNonce: nonce } = usePlayerStore.getState()
    handledNonceRef.current = nonce
    seekBook(seekTarget)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks])

  // Apply the seek requests coming from the store (resume position, scrubber,
  // chapter jumps). Driven by the nonce so repeated seeks to the same time fire.
  useEffect(() => {
    if (seekNonce === handledNonceRef.current) return
    handledNonceRef.current = seekNonce
    seekBook(usePlayerStore.getState().seekTarget)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce])

  // Reflect play/pause intent onto the active element. While a track is still
  // loading, startAt plays it once its seek lands.
  useEffect(() => {
    const el = activeRef.current
    if (!el || tracks.length === 0) return
    if (isPlaying) {
      if (el.error) {
        // The track failed to load (the server was still preparing it, or the
        // connection dropped): reload it where we are; it plays once ready.
        curIdxRef.current = -1
        seekBook(usePlayerStore.getState().currentTime)
      } else if (seekedRef.current && el.paused) {
        el.play().catch(() => setPlaying(false))
      }
    } else {
      el.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, tracks, setPlaying])

  // Apply playback rate (both elements, so a handoff keeps the speed).
  useEffect(() => {
    for (const el of [aRef.current, bRef.current]) if (el) el.playbackRate = speed
  }, [speed, tracks])

  // Apply volume. The sleep-timer fade temporarily drives volume directly and
  // restores to this level when it finishes.
  useEffect(() => {
    for (const el of [aRef.current, bRef.current]) if (el) el.volume = volume
  }, [volume, tracks])

  // Only the active element's events count; the standby fires its own load
  // events while it preloads.
  const isActive = (e: React.SyntheticEvent<HTMLAudioElement>) =>
    e.currentTarget === activeRef.current

  const onTimeUpdate = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    if (!isActive(e) || !seekedRef.current) return
    const el = e.currentTarget
    const list = usePlayerStore.getState().tracks
    const idx = curIdxRef.current
    const track = list[idx]
    if (!track) return
    setCurrentTime((track.startOffset ?? 0) + el.currentTime)
    // Close to the end of this track (in listening time, so fast speeds start
    // earlier): get the next one loading in the standby element.
    const next = idx + 1
    if (
      next < list.length &&
      spareIdxRef.current !== next &&
      !el.paused &&
      el.duration - el.currentTime <= NEXT_TRACK_PRELOAD_SEC * Math.max(1, el.playbackRate)
    ) {
      preloadNext(next)
    }
  }

  const onPause = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    // A pause while a track is still loading is a side effect of swapping the
    // source (e.g. switching books), not the listener pausing.
    if (!isActive(e) || !seekedRef.current) return
    // A track reaching its end also fires 'pause'. Between two tracks of the
    // same book that's not a real pause: keep "playing" (no pause sync, no lock
    // screen flicker) and let 'ended' move on to the next track.
    const el = e.currentTarget
    if (el.ended && curIdxRef.current < usePlayerStore.getState().tracks.length - 1) return
    setPlaying(false)
  }

  const onEnded = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    if (!isActive(e)) return
    const next = curIdxRef.current + 1
    if (next < usePlayerStore.getState().tracks.length) {
      loadTrack(next, 0)
      return
    }
    // Pin the final position at the book's full duration before advancing, so
    // the book we're leaving can't be left a few seconds short of finished.
    void syncEnded().then(() => advance())
  }

  const onError = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    if (isActive(e)) {
      // Only a failure of the loaded track counts; an element with no source is idle.
      if (e.currentTarget.getAttribute('src')) setPlaying(false)
      return
    }
    // The standby failed to load: forget it, the boundary loads normally.
    spareIdxRef.current = -1
  }

  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    // The session's duration is the book's; a track's own length only fills in
    // when the session had none.
    const el = e.currentTarget
    if (isActive(e) && el.duration && usePlayerStore.getState().duration <= 0)
      setDuration(el.duration)
  }

  const handlers = {
    onTimeUpdate,
    onLoadedMetadata,
    onPlay: (e: React.SyntheticEvent<HTMLAudioElement>) => {
      if (isActive(e)) setPlaying(true)
    },
    onPause,
    onEnded,
    onError,
  }

  return (
    <>
      <audio ref={aRef} preload="metadata" {...handlers} />
      <audio ref={bRef} preload="auto" {...handlers} />
    </>
  )
}
