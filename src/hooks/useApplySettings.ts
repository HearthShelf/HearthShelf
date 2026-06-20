import { useEffect, useRef, type RefObject } from 'react'
import { useSettingsStore, onColor, EMBER } from '@/store/settingsStore'
import { usePlayerStore } from '@/store/playerStore'
import { tintFor } from '@/components/common/Cover'

// Applies the appearance settings to the document root and runs the cover-glow
// engine. Ported from the design reference (prototype/app.jsx): the two effects
// that set --accent / --glow-* tokens and the delegated data-cv hover swap.
//
// `appRef` is the .app root that scopes the hover delegation. Dynamic accent
// derives from the now-playing book's typeset hue (cv); sampling real artwork
// is deferred, so with no session the accent falls back to the ember default.
export function useApplySettings(appRef: RefObject<HTMLElement | null>) {
  const theme = useSettingsStore((s) => s.theme)
  const accentHex = useSettingsStore((s) => s.accentHex)
  const glow = useSettingsStore((s) => s.glow)

  const nowTitle = usePlayerStore((s) => s.title)
  const nowCv = nowTitle ? tintFor(nowTitle) : null

  // Accent is a fixed, user-chosen colour (default ember). The signature glow
  // still blooms from the now-playing cover, independent of the accent.
  const effectiveAccent = accentHex || EMBER
  const glowBase = nowCv ?? effectiveAccent

  // Keep the live glow base in a ref so the (mount-once) hover listener can
  // restore the right hue on mouse-out without re-binding on every change.
  const glowRef = useRef(glowBase)
  glowRef.current = glowBase

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    root.style.setProperty('--accent', effectiveAccent)
    root.style.setProperty('--on-accent', onColor(effectiveAccent))
    root.style.setProperty('--glow-strength', String(glow))
    root.style.setProperty('--glow-accent', glowBase)
  }, [theme, glow, effectiveAccent, glowBase])

  // Cover-glow engine: hovering any element carrying data-cv live-swaps the
  // bloom hue to that cover; mouse-out restores the now-playing hue.
  useEffect(() => {
    const el = appRef.current
    if (!el) return
    const setGlow = (v: string) =>
      document.documentElement.style.setProperty('--glow-accent', v)
    const over = (e: Event) => {
      const b = (e.target as Element).closest('[data-cv]')
      if (b) setGlow(b.getAttribute('data-cv') as string)
    }
    const out = (e: Event) => {
      const b = (e.target as Element).closest('[data-cv]')
      if (b) setGlow(glowRef.current)
    }
    el.addEventListener('mouseover', over)
    el.addEventListener('mouseout', out)
    return () => {
      el.removeEventListener('mouseover', over)
      el.removeEventListener('mouseout', out)
    }
  }, [appRef])
}
