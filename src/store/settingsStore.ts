import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  QueueMode,
  AutoRulePref,
  SettingScope,
  SettingValue,
  NoteVisibility,
} from '@hearthshelf/core'
import {
  DEFAULT_AUTO_RULES as CORE_DEFAULT_AUTO_RULE_PREFS,
  SETTINGS_CATALOG,
  settingDefault,
  normalizeAutoRules,
} from '@hearthshelf/core'

// Client-only user preferences (appearance, playback, library, sleep). Rendered
// from localStorage for an instant first paint, then reconciled with the server
// (per-key) by useSettingsSync so a user's settings follow them across devices.
//
// The store keeps flat fields (s.theme, s.skipForward) as the read surface every
// component uses, and tracks a per-key updatedAt in `meta` alongside so sync can
// merge at the setting level (per-key last-writer-wins). set() stamps meta; the
// catalog in @hearthshelf/core defines each key's scope + default.

export const EMBER = '#e0654a'

export interface AccentPreset {
  name: string
  hex: string
}

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

// Readable ink/cream over an accent hex, chosen by relative luminance.
export function onColor(hex: string): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return L > 0.42 ? '#1a1509' : '#fff'
}

export type Theme = 'dark' | 'light' | 'flat' | 'oled'
export type AccentMode = 'dynamic' | 'manual'
export type CoverStyle = 'floating' | 'cards'
export type ScrubberScope = 'chapter' | 'book'

export type { AutoRulePref } from '@hearthshelf/core'

// The default order/priority of the Auto-queue rules, all on. Owned by
// @hearthshelf/core so web and mobile agree on the same defaults.
export const DEFAULT_AUTO_RULE_PREFS: AutoRulePref[] = CORE_DEFAULT_AUTO_RULE_PREFS

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
  defaultSpeed: number
  skipForward: number
  skipForwardCustom: number
  skipBack: number
  skipBackCustom: number
  chapterBarrier: boolean
  // When a book counts as finished. See @hearthshelf/core lib/completion.ts for
  // how these combine; 0 disables the credits + percent rules.
  creditsChapterMaxSec: number
  chapterEndGraceSec: number
  finishedPercent: number
  // Hide the docked player bar. Off (default) keeps it; on hides it and the full
  // player is reached from the player nav / a book's Play button.
  hideMiniPlayer: boolean

  // Queue
  queueMode: QueueMode
  queueAutoRules: AutoRulePref[]

  // Library
  libraryFill: boolean
  unifiedHome: boolean
  showOthersBooks: boolean
  // When on, Search also looks up titles you don't own via the Audible catalog
  // and shows them in a "Not in your library" section.
  searchExternalSources: boolean
  // Per-provider toggles for the search-link icons on a book's detail page.
  externalLinkGoodreads: boolean
  externalLinkAudible: boolean
  externalLinkHardcover: boolean
  // Tri-state: null = no explicit choice (follow the server's default sharing
  // setting); true/false = the user's own choice, which the admin default never
  // overrides. Only written once the user actually toggles it.
  shareReadBooks: boolean | null
  // Tri-state: null = never chose (follow the server's presence default, which
  // ships OFF - real-time presence is more sensitive than a reading list).
  shareCurrentlyListening: boolean | null
  // When no photo is uploaded, fall back to the user's Gravatar (by their email).
  // Tri-state: null = never chose (the default is ON - Gravatar shows), true/false
  // = the user's own choice. A row is only written when the user toggles it, so no
  // client owns a default and the choice persists as one account-wide setting.
  useGravatar: boolean | null

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

  // Device-scoped: show a toast when playback crosses a club note. Off silences
  // pops on this device without leaving any club.
  notePops: boolean

  // Device-scoped: the composer's remembered last Public/Personal choice for a
  // general (non-club) note. Written on each general post so it sticks.
  noteDefaultVisibility: NoteVisibility

  // Device-scoped: when false, this device ignores account settings pulled from
  // the server and runs on its local values only (see useSettingsSync).
  useSharedSettings: boolean

  // Per-key updatedAt (ms) for sync conflict resolution. Not a user setting.
  meta: Record<string, number>
  // Stable per-install id for device-scoped settings. Generated once, persisted.
  deviceId: string

  set: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void
  // Apply per-key values pulled from the server with their server updatedAt,
  // resolving each against the local value via last-writer-wins. Returns nothing;
  // only newer server values overwrite. Unknown keys are ignored.
  applyServerKeys: (rows: Record<string, { value: SettingValue; updatedAt: number }>) => void
}

// The persisted user-facing value subset (the settings, not the sync machinery).
type SettingsValues = Omit<SettingsState, 'set' | 'applyServerKeys' | 'meta' | 'deviceId'>

// Keys that sync to the server (present in the catalog). sleepRewind is a
// deprecated local-only flag not in the catalog, so it never syncs.
export const SYNCED_KEYS = Object.keys(SETTINGS_CATALOG) as (keyof SettingsValues)[]

function newDeviceId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `dev-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Appearance
      theme: 'dark',
      accentMode: 'manual',
      accentHex: EMBER,
      glow: 60,
      coverStyle: 'cards',
      colorEverywhere: true,
      hearthBgPlayer: true,

      // Playback
      scrubber: 'chapter',
      defaultSpeed: 1,
      skipForward: 30,
      skipForwardCustom: 45,
      skipBack: 15,
      skipBackCustom: 20,
      chapterBarrier: true,
      creditsChapterMaxSec: 60,
      chapterEndGraceSec: 15,
      finishedPercent: 0,
      hideMiniPlayer: false,

      // Queue
      queueMode: 'manual',
      queueAutoRules: DEFAULT_AUTO_RULE_PREFS,

      // Library
      libraryFill: false,
      unifiedHome: false,
      showOthersBooks: true,
      searchExternalSources: true,
      externalLinkGoodreads: true,
      externalLinkAudible: true,
      externalLinkHardcover: true,
      shareReadBooks: null,
      shareCurrentlyListening: null,
      useGravatar: null,

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

      notePops: true,
      noteDefaultVisibility: 'public',

      useSharedSettings: true,

      meta: {},
      deviceId: newDeviceId(),

      set: (key, value) =>
        set((state) => {
          const meta = { ...state.meta }
          // Only catalogued keys carry sync metadata.
          if (key in SETTINGS_CATALOG) meta[key as string] = Date.now()
          return { [key]: value, meta } as Partial<SettingsState>
        }),

      applyServerKeys: (rows) => {
        const state = get()
        const patch: Record<string, unknown> = {}
        const meta = { ...state.meta }
        for (const key of Object.keys(rows)) {
          if (!(key in SETTINGS_CATALOG)) continue
          const remote = rows[key]
          const localAt = state.meta[key] ?? -1
          // Per-key last-writer-wins: server wins ties.
          if (remote.updatedAt >= localAt) {
            // Backfill rules added since the value was stored (book-club,
            // manual) so the picker never hides a rule the shared set defines.
            patch[key] = key === 'queueAutoRules' ? normalizeAutoRules(remote.value) : remote.value
            meta[key] = remote.updatedAt
          }
        }
        if (Object.keys(patch).length) set({ ...patch, meta } as Partial<SettingsState>)
      },
    }),
    {
      name: 'hearthshelf:settings',
      // Backfill rules added since a value was persisted (book-club, manual) as
      // soon as localStorage rehydrates, so the picker shows the full rule set
      // without waiting for a server pull.
      onRehydrateStorage: () => (state) => {
        if (state) state.queueAutoRules = normalizeAutoRules(state.queueAutoRules)
      },
    },
  ),
)

// The scope of a synced key from the catalog ('account' | 'device').
export function scopeOf(key: string): SettingScope | null {
  const d = SETTINGS_CATALOG[key]
  return d ? d.scope : null
}

// The catalog default for a key (used when resetting).
export function defaultOf(key: string): SettingValue | undefined {
  return settingDefault(key)
}
