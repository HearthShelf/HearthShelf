import { useEffect, useState } from 'react'
import { useSettingsStore, onColor, EMBER } from '@/store/settingsStore'
import { usePlayerStore } from '@/store/playerStore'
import { useAuthStore } from '@/store/authStore'
import { tintFor } from '@/components/common/Cover'
import { coverAccent } from '@/lib/coverColor'

// Applies the appearance settings to the document root: the effect that sets the
// --accent / --glow-* tokens. The signature bloom derives from the now-playing
// book's real cover artwork - we sample its dominant hue and feed it to
// --glow-accent. Until the image resolves (or if it can't be read), we fall back
// to the book's typeset tint, and with no session at all to the ember default.
export function useApplySettings() {
  const theme = useSettingsStore((s) => s.theme)
  const accentHex = useSettingsStore((s) => s.accentHex)
  const glow = useSettingsStore((s) => s.glow)

  const libraryItemId = usePlayerStore((s) => s.libraryItemId)
  const nowTitle = usePlayerStore((s) => s.title)
  const token = useAuthStore((s) => s.token)

  // Per-book typeset tint, used as the immediate/fallback glow colour.
  const tint = nowTitle ? tintFor(nowTitle) : null

  // Dominant colour sampled from the now-playing cover artwork. The sample is
  // tagged with the item it came from so a stale colour from a previous book is
  // never applied to the next one (no synchronous reset needed on item change).
  const [art, setArt] = useState<{ id: string; hex: string | null } | null>(null)
  useEffect(() => {
    if (!libraryItemId) return
    let cancelled = false
    const params = token ? `?token=${encodeURIComponent(token)}` : ''
    const src = `/abs-api/api/items/${libraryItemId}/cover${params}`
    void coverAccent(src).then((hex) => {
      if (!cancelled) setArt({ id: libraryItemId, hex })
    })
    return () => { cancelled = true }
  }, [libraryItemId, token])

  const artHex = art && art.id === libraryItemId ? art.hex : null

  // Accent is a fixed, user-chosen colour (default ember). The signature glow
  // blooms from the cover: real artwork first, typeset tint while it loads.
  const effectiveAccent = accentHex || EMBER
  const glowBase = artHex ?? tint ?? effectiveAccent

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    root.style.setProperty('--accent', effectiveAccent)
    root.style.setProperty('--on-accent', onColor(effectiveAccent))
    root.style.setProperty('--glow-strength', String(glow))
    root.style.setProperty('--glow-accent', glowBase)
  }, [theme, glow, effectiveAccent, glowBase])
}
