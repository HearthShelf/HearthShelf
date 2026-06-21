import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Reader display preferences (theme, typeface, size, spacing, margins, layout,
// brightness). Client-only and persisted locally - HearthShelf's reader is not
// known to ABS, so these never sync to the server. Ported from the Rev 4
// reader.jsx RD_DEFAULTS / value maps.

export type ReaderTheme = 'dark' | 'sepia' | 'light' | 'paper'
export type ReaderFont = 'serif' | 'sans' | 'dyslexic'
export type ReaderWidth = 'narrow' | 'medium' | 'wide'
export type ReaderLh = 'compact' | 'normal' | 'relaxed'
export type ReaderAlign = 'left' | 'justify'
export type ReaderLayout = 'scroll' | 'paged'

export interface ReaderThemeTokens {
  bg: string
  ink: string
  faint: string
  line: string
  fill: string
  surface: string
}

// reader.jsx RD_THEMES
export const READER_THEMES: Record<ReaderTheme, ReaderThemeTokens> = {
  dark: {
    bg: '#1b1a18',
    ink: '#e9e3d7',
    faint: '#8c8478',
    line: 'rgba(255,255,255,0.10)',
    fill: 'rgba(255,255,255,0.06)',
    surface: '#2a2825',
  },
  sepia: {
    bg: '#f1e6d1',
    ink: '#473b2c',
    faint: '#9a8a6e',
    line: 'rgba(70,50,20,0.16)',
    fill: 'rgba(70,50,20,0.06)',
    surface: '#f7eedc',
  },
  light: {
    bg: '#faf8f4',
    ink: '#26221d',
    faint: '#8a8278',
    line: 'rgba(0,0,0,0.10)',
    fill: 'rgba(0,0,0,0.05)',
    surface: '#ffffff',
  },
  paper: {
    bg: '#e7e0d2',
    ink: '#322d25',
    faint: '#8a7f6c',
    line: 'rgba(40,30,15,0.14)',
    fill: 'rgba(40,30,15,0.05)',
    surface: '#efe9dd',
  },
}

// reader.jsx RD_FONTS stacks
export const READER_FONT_STACKS: Record<ReaderFont, string> = {
  serif: '"Libre Baskerville", Georgia, serif',
  sans: 'var(--font)',
  dyslexic: '"OpenDyslexic", "Comic Sans MS", var(--font)',
}

// reader.jsx RD_WIDTHS / RD_LH
export const READER_WIDTHS: Record<ReaderWidth, number> = {
  narrow: 540,
  medium: 660,
  wide: 820,
}
export const READER_LINE_HEIGHTS: Record<ReaderLh, number> = {
  compact: 1.5,
  normal: 1.78,
  relaxed: 2.06,
}

export const READER_SIZE_MIN = 15
export const READER_SIZE_MAX = 26

export interface ReaderPrefs {
  theme: ReaderTheme
  font: ReaderFont
  size: number
  lh: ReaderLh
  width: ReaderWidth
  align: ReaderAlign
  brightness: number // 35-100
  layout: ReaderLayout
}

interface ReaderPrefsStore extends ReaderPrefs {
  set: <K extends keyof ReaderPrefs>(key: K, value: ReaderPrefs[K]) => void
}

export const useReaderPrefs = create<ReaderPrefsStore>()(
  persist(
    (set) => ({
      theme: 'sepia',
      font: 'serif',
      size: 19,
      lh: 'normal',
      width: 'medium',
      align: 'left',
      brightness: 100,
      layout: 'scroll',
      set: (key, value) => set({ [key]: value } as Partial<ReaderPrefs>),
    }),
    { name: 'hearthshelf:reader-prefs' }
  )
)
