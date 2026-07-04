import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { READER_DEFAULTS, type ReaderPrefs } from '@hearthshelf/core'

// Reader display preferences store. The model (themes, font stacks, widths,
// line-heights, size/brightness bounds, defaults) lives in @hearthshelf/core so
// every reader surface shares it; this file is just the web binding: zustand +
// localStorage persistence. Client-only - the reader is not known to ABS, so
// these never sync to the server.
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

export const useReaderPrefs = create<ReaderPrefsStore>()(
  persist(
    (set) => ({
      ...READER_DEFAULTS,
      set: (key, value) => set({ [key]: value } as Partial<ReaderPrefs>),
    }),
    { name: 'hearthshelf:reader-prefs' },
  ),
)
