import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { QueueMode, AutoRuleId } from '@/store/queueStore'

// The default order/priority of the Auto-queue rules. All on by default.
export const DEFAULT_AUTO_RULES: AutoRuleId[] = [
  'finish-series',
  'in-progress',
  'new-in-series',
]

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

// An Auto-queue rule with its enabled flag. The array order is the priority.
export interface AutoRulePref {
  id: AutoRuleId
  on: boolean
}

export const DEFAULT_AUTO_RULE_PREFS: AutoRulePref[] = DEFAULT_AUTO_RULES.map(
  (id) => ({ id, on: true })
)

export interface SettingsState {
  // Appearance
  theme: Theme
  accentMode: AccentMode
  accentHex: string
  glow: number // 0-60
  coverStyle: CoverStyle
  colorEverywhere: boolean
  hearthBgPlayer: boolean

  // Playback
  scrubber: ScrubberScope
  skipForward: number
  skipBack: number
  chapterBarrier: boolean

  // Queue
  queueMode: QueueMode
  queueAutoRules: AutoRulePref[]

  // Library
  libraryFill: boolean
  unifiedHome: boolean
  showOthersBooks: boolean
  // Tri-state: null = no explicit choice (follow the server's default sharing
  // setting); true/false = the user's own choice, which the admin default never
  // overrides. Only written once the user actually toggles it.
  shareReadBooks: boolean | null
  // When no photo is uploaded, fall back to the user's Gravatar (by their email).
  // On by default (opt-out); false hides the Gravatar so initials show instead.
  useGravatar: boolean

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
  // Bulk-merge values pulled from the server (device-sync). Only known keys are
  // applied; unknown keys from a newer client are ignored.
  applyServer: (values: Partial<SettingsValues>) => void
}

// The persisted value subset (everything but the actions), used to type set().
type SettingsValues = Omit<SettingsState, 'set' | 'applyServer'>

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
      hearthBgPlayer: false,

      // Playback
      scrubber: 'chapter',
      skipForward: 30,
      skipBack: 15,
      chapterBarrier: true,

      // Queue
      queueMode: 'manual',
      queueAutoRules: DEFAULT_AUTO_RULE_PREFS,

      // Library
      libraryFill: false,
      unifiedHome: false,
      showOthersBooks: true,
      shareReadBooks: null,
      useGravatar: true,

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
      applyServer: (values) => set(values as Partial<SettingsState>),
    }),
    { name: 'hearthshelf:settings' }
  )
)

// The keys that make up a user's syncable settings - everything but the
// actions. Used to extract a clean values object for the server.
const SETTINGS_KEYS: (keyof SettingsValues)[] = [
  'theme',
  'accentMode',
  'accentHex',
  'glow',
  'coverStyle',
  'colorEverywhere',
  'hearthBgPlayer',
  'scrubber',
  'skipForward',
  'skipBack',
  'chapterBarrier',
  'queueMode',
  'queueAutoRules',
  'libraryFill',
  'unifiedHome',
  'showOthersBooks',
  'shareReadBooks',
  'useGravatar',
  'sleepRewind',
  'sleepRewindSec',
  'sleepFade',
  'sleepFadeLen',
  'sleepChime',
  'autoSleep',
  'autoSleepStart',
  'autoSleepEnd',
  'autoSleepDur',
]

// Snapshot the current settings values (no actions) for sending to the server.
export function settingsValues(s: SettingsState): SettingsValues {
  const out = {} as SettingsValues
  for (const k of SETTINGS_KEYS) (out as Record<string, unknown>)[k] = s[k]
  return out
}
