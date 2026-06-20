import { useState, useEffect, useRef, useCallback } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { useSettingsStore } from '@/store/settingsStore'
import { getAudioElement } from '@/lib/audioRef'

export type SleepTab = 'duration' | 'chapter' | 'time'
type StopAt = 'start' | 'end'

export interface SleepCtl {
  tab: SleepTab
  setTab: (t: SleepTab) => void
  // active = a stop point is armed (duration countdown, chapter, or clock)
  active: boolean
  sleeping: boolean // a live countdown is running (duration/time)
  left: number // seconds remaining on a countdown
  endsAt: string // human label for the stop point
  curIdx: number
  bounds: { id: number; start: number; end: number; title: string }[]
  // chapter mode
  eoc: { idx: number; at: StopAt } | null
  setDuration: (mins: number) => void
  setChapter: (idx: number, at: StopAt) => void
  setClock: (hhmm: string) => void
  addTime: (mins: number) => void
  cancel: () => void
  // stop-behavior settings (mirrored to the settings store)
  rewind: boolean
  setRewind: (v: boolean) => void
  chapterBarrier: boolean
  setBarrier: (v: boolean) => void
  fade: boolean
  setFade: (v: boolean) => void
  fadeLen: number
  setFadeLen: (v: number) => void
  chime: boolean
  setChime: (v: boolean) => void
  // auto-sleep banner context
  auto: boolean
  autoDur: number
  autoStart: string
  autoEnd: string
}

function clockLabel(addSeconds: number): string {
  const d = new Date(Date.now() + addSeconds * 1000)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// The client-only sleep timer. Drives three stop modes and a stop sequence
// (rewind / fade / chime) using the player + settings stores and the shared
// <audio> element. Defaults for the stop behaviours come from Settings.
export function useSleepTimer(): SleepCtl {
  const chapters = usePlayerStore((s) => s.chapters)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const setPlaying = usePlayerStore((s) => s.setPlaying)
  const seek = usePlayerStore((s) => s.seek)

  const s = useSettingsStore()
  const set = s.set

  const [tab, setTab] = useState<SleepTab>('duration')
  const [left, setLeft] = useState(0) // duration/time countdown seconds
  const [eoc, setEoc] = useState<{ idx: number; at: StopAt } | null>(null)
  const tickRef = useRef<number | null>(null)
  const chimedRef = useRef(false)

  const sleeping = left > 0
  const active = sleeping || eoc !== null

  // Current chapter index for the chapter-mode default selection.
  let curIdx = chapters.findIndex((c) => currentTime < c.end)
  if (curIdx === -1) curIdx = Math.max(0, chapters.length - 1)

  // The actual stop sequence: optional chime warning (handled in tick), then
  // rewind, then fade-or-cut, then pause.
  const fireStop = useCallback(() => {
    const audio = getAudioElement()
    const finish = () => {
      if (s.sleepRewind) {
        const back = Math.max(0, usePlayerStore.getState().currentTime - 30)
        if (s.chapterBarrier) {
          const cur = chapters.find(
            (c) => usePlayerStore.getState().currentTime < c.end
          )
          seek(cur ? Math.max(cur.start, back) : back)
        } else {
          seek(back)
        }
      }
      setPlaying(false)
      if (audio) audio.volume = usePlayerStore.getState().volume
    }
    if (s.sleepFade && audio) {
      const steps = Math.max(1, s.sleepFadeLen)
      const startVol = usePlayerStore.getState().volume
      let elapsed = 0
      const fade = window.setInterval(() => {
        elapsed += 1
        audio.volume = Math.max(0, startVol * (1 - elapsed / steps))
        if (elapsed >= steps) {
          window.clearInterval(fade)
          finish()
        }
      }, 1000)
    } else {
      finish()
    }
  }, [s.sleepRewind, s.sleepFade, s.sleepFadeLen, s.chapterBarrier, chapters, seek, setPlaying])

  // Countdown tick for duration / time modes.
  useEffect(() => {
    if (!sleeping) return
    tickRef.current = window.setInterval(() => {
      setLeft((l) => {
        if (s.sleepChime && !chimedRef.current && l <= 61 && l > 60) {
          chimedRef.current = true
        }
        if (l <= 1) {
          fireStop()
          return 0
        }
        return l - 1
      })
    }, 1000)
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current)
    }
  }, [sleeping, s.sleepChime, fireStop])

  // Chapter-mode stop: watch position and stop when we cross the target.
  useEffect(() => {
    if (!eoc) return
    const target = chapters[eoc.idx]
    if (!target) return
    const stopAt = eoc.at === 'start' ? target.start : target.end
    if (currentTime >= stopAt) {
      setEoc(null)
      fireStop()
    }
  }, [eoc, currentTime, chapters, fireStop])

  const endsAt = sleeping
    ? clockLabel(left)
    : eoc
      ? `ch ${eoc.idx + 1} ${eoc.at}`
      : ''

  return {
    tab,
    setTab,
    active,
    sleeping,
    left,
    endsAt,
    curIdx,
    bounds: chapters,
    eoc,
    setDuration: (mins) => {
      chimedRef.current = false
      setEoc(null)
      setLeft(mins * 60)
    },
    setChapter: (idx, at) => {
      setLeft(0)
      setEoc({ idx, at })
    },
    setClock: (hhmm) => {
      if (!hhmm) return
      const [h, m] = hhmm.split(':').map(Number)
      const now = new Date()
      const target = new Date()
      target.setHours(h, m, 0, 0)
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
      chimedRef.current = false
      setEoc(null)
      setLeft(Math.round((target.getTime() - now.getTime()) / 1000))
    },
    addTime: (mins) => setLeft((l) => l + mins * 60),
    cancel: () => {
      setLeft(0)
      setEoc(null)
    },
    rewind: s.sleepRewind,
    setRewind: (v) => set('sleepRewind', v),
    chapterBarrier: s.chapterBarrier,
    setBarrier: (v) => set('chapterBarrier', v),
    fade: s.sleepFade,
    setFade: (v) => set('sleepFade', v),
    fadeLen: s.sleepFadeLen,
    setFadeLen: (v) => set('sleepFadeLen', v),
    chime: s.sleepChime,
    setChime: (v) => set('sleepChime', v),
    auto: s.autoSleep,
    autoDur: s.autoSleepDur,
    autoStart: s.autoSleepStart,
    autoEnd: s.autoSleepEnd,
  }
}
