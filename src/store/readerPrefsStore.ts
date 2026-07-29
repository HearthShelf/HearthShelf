import { useMemo } from 'react'
import { READER_SETTING_KEYS, readerPrefsFrom, type ReaderPrefs } from '@hearthshelf/core'
import { useSettingsStore } from '@/store/settingsStore'

// Reader display preferences. The model (themes, font stacks, widths,
// line-heights, size/brightness bounds, defaults) lives in @hearthshelf/core so
// every reader surface shares it; this file is the web binding.
//
// The values now live in the settings store under the catalogued `reader*` keys
// (READER_SETTING_KEYS), so they persist and sync like every other setting
// instead of sitting in a private localStorage blob that could never follow a
// user to another browser or machine. They stay device-scoped - a type size that
// suits a laptop rarely suits a phone - which still means they are stored
// server-side and restored onto a new install.
//
// Re-export the core model so existing `from '@/store/readerPrefsStore'` imports
// keep working unchanged.
export {
  READER_THEMES,
  READER_FONT_STACKS,
  READER_WIDTHS,
  READER_LINE_HEIGHTS,
  READER_SIZE_MIN,
  READER_SIZE_MAX,
  READER_BRIGHTNESS_MIN,
  READER_BRIGHTNESS_MAX,
  READER_DEFAULTS,
} from '@hearthshelf/core'
export type {
  ReaderPrefs,
  ReaderTheme,
  ReaderFont,
  ReaderWidth,
  ReaderLh,
  ReaderAlign,
  ReaderLayout,
  ReaderThemeTokens,
} from '@hearthshelf/core'

interface ReaderPrefsStore extends ReaderPrefs {
  set: <K extends keyof ReaderPrefs>(key: K, value: ReaderPrefs[K]) => void
}

/** The reader's prefs, projected out of the synced settings store. */
export function useReaderPrefs(): ReaderPrefsStore {
  const settings = useSettingsStore()
  return useMemo(
    () => ({
      ...readerPrefsFrom(settings as unknown as Record<string, unknown>),
      // READER_SETTING_KEYS pairs each reader field with the catalog key holding
      // the same type (theme -> readerTheme), so the value always fits its
      // target; the cast is only needed because the mapping is a lookup.
      set: (key, value) => settings.set(READER_SETTING_KEYS[key] as never, value as never),
    }),
    [settings],
  )
}

// One-time import of the pre-catalog `hearthshelf:reader-prefs` blob. Written
// through the settings store's set(), so the values are stamped and pushed -
// a reader setup chosen before this change gets backed up rather than dropped.
const LEGACY_KEY = 'hearthshelf:reader-prefs'

function importLegacyReaderPrefs(): void {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { state?: Partial<ReaderPrefs> }
    const saved = parsed?.state ?? {}
    const set = useSettingsStore.getState().set
    for (const field of Object.keys(READER_SETTING_KEYS) as (keyof ReaderPrefs)[]) {
      const value = saved[field]
      if (value === undefined) continue
      set(READER_SETTING_KEYS[field] as never, value as never)
    }
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // Corrupt/unavailable storage - the catalog defaults stand.
  }
}

importLegacyReaderPrefs()
