import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Client-only user preferences (appearance, playback, library, sleep). No ABS
// dependency - persisted to localStorage. Field names and defaults are ported
// verbatim from the design reference (prototype/app.jsx TWEAK_DEFAULTS), which
// is the source of truth where docs disagree.

export const EMBER = '#e0654a'

export interface AccentPreset {
  name: string
  hex: string
}

// prototype/data.js -> PRESETS
export const ACCENT_PRESETS: AccentPreset[] = [
  { name: 'Ember', hex: '#ea9648' },
  { name: 'Hearth', hex: '#e0654a' },
  { name: 'Cinder', hex: '#c4463a' },
  { name: 'Amber', hex: '#e8b54a' },
  { name: 'Sage', hex: '#7fa86b' },
  { name: 'Tide', hex: '#4f9db0' },
  { name: 'Dusk', hex: '#5e76c4' },
  { name: 'Plum', hex: '#9b6fb8' },
  { name: 'Rose', hex: '#d2689a' },
  { name: 'Slate', hex: '#6b7280' },
]

// prototype/components.jsx -> onColor(): readable ink/cream over an accent hex,
// chosen by relative luminance.
export function onColor(hex: string): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return L > 0.42 ? '#1a1509' : '#fff'
}

export type Theme = 'dark' | 'light' | 'flat' | 'oled'
export type AccentMode = 'dynamic' | 'manual'
export type CoverStyle = 'floating' | 'cards'
export type ScrubberScope = 'chapter' | 'book'

export interface SettingsState {
  // Appearance
  theme: Theme
  accentMode: AccentMode
  accentHex: string
  glow: number // 0-60
  coverStyle: CoverStyle
  colorEverywhere: boolean

  // Playback
  scrubber: ScrubberScope
  skipForward: number
  skipBack: number
  chapterBarrier: boolean

  // Library
  libraryFill: boolean
  unifiedHome: boolean
  showOthersBooks: boolean
  shareReadBooks: boolean

  // Sleep
  sleepRewind: boolean
  // Seconds to rewind when the sleep timer stops (0 = resume exactly where it
  // stopped). Supersedes the on/off sleepRewind toggle in the UI.
  sleepRewindSec: number
  sleepFade: boolean
  sleepFadeLen: number
  sleepChime: boolean
  autoSleep: boolean
  autoSleepStart: string
  autoSleepEnd: string
  autoSleepDur: number

  set: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void
}

// The persisted value subset (everything but the action), used to type set().
type SettingsValues = Omit<SettingsState, 'set'>

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      // Appearance
      theme: 'dark',
      accentMode: 'manual',
      accentHex: EMBER,
      glow: 60,
      coverStyle: 'cards',
      colorEverywhere: true,

      // Playback
      scrubber: 'chapter',
      skipForward: 30,
      skipBack: 15,
      chapterBarrier: true,

      // Library
      libraryFill: false,
      unifiedHome: false,
      showOthersBooks: true,
      shareReadBooks: true,

      // Sleep
      sleepRewind: true,
      sleepRewindSec: 30,
      sleepFade: true,
      sleepFadeLen: 20,
      sleepChime: false,
      autoSleep: false,
      autoSleepStart: '22:00',
      autoSleepEnd: '06:00',
      autoSleepDur: 30,

      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
    }),
    { name: 'hearthshelf:settings' }
  )
)
