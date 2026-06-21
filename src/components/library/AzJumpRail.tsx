import { useMemo } from 'react'
import { letterOf } from '@/lib/letterBucket'

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

interface AzJumpRailProps {
  // Names in their current (alphabetical) display order.
  names: string[]
}

// A vertical A-Z rail pinned to the right edge. Tapping (or dragging a finger
// down) a letter jumps to the first card in that bucket. Only letters that have
// at least one entry are tappable; the rest are dimmed so the rail stays a
// complete, stable alphabet.
export function AzJumpRail({ names }: AzJumpRailProps) {
  const present = useMemo(() => {
    const s = new Set<string>()
    for (const n of names) s.add(letterOf(n))
    return s
  }, [names])

  const jump = (letter: string) => {
    if (!present.has(letter)) return
    const container = document.querySelector<HTMLElement>('.content')
    if (!container) return
    const target = container.querySelector<HTMLElement>(
      `[data-letter="${letter}"]`
    )
    if (!target) return
    // Offset by the sticky tab bar so the card lands below it, not under it.
    const top =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      72
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }

  // Drag across the rail to scrub through letters (native list-style behavior).
  const onMove = (clientY: number) => {
    const el = document
      .elementFromPoint(
        // rail hugs the right edge; sample slightly inside it
        window.innerWidth - 12,
        clientY
      )
      ?.closest<HTMLElement>('[data-az]')
    const letter = el?.getAttribute('data-az')
    if (letter) jump(letter)
  }

  return (
    <div
      className="az-rail"
      aria-label="Jump to letter"
      onTouchMove={(e) => onMove(e.touches[0].clientY)}
    >
      {ALPHABET.map((l) => (
        <button
          key={l}
          data-az={l}
          className={'az-key' + (present.has(l) ? '' : ' empty')}
          onClick={() => jump(l)}
          tabIndex={present.has(l) ? 0 : -1}
        >
          {l}
        </button>
      ))}
    </div>
  )
}
