import { useState } from 'react'
import { Icon } from '@/components/common/Icon'

interface StarRatingProps {
  /** The user's rating, 1-5, or null when they haven't rated it. */
  value: number | null
  /** Called with the new rating, or null to clear it. */
  onChange: (rating: number | null) => void
  /** Icon size in px. */
  size?: number
  label?: string
}

// The user's own 1-5 star rating, interactive. Distinct from Stars.tsx, which is
// the read-only display of ABS's scraped community rating (and renders halves) -
// a user rating is always a whole number.
//
// Clicking the currently selected star clears the rating, matching how the
// Discover tile has always behaved.
export function StarRating({ value, onChange, size = 16, label = 'Your rating' }: StarRatingProps) {
  const [hover, setHover] = useState<number | null>(null)
  const current = value ?? 0
  const shown = hover ?? current

  // Always stop propagation: this sits inside clickable rows (series list) whose
  // own onClick navigates.
  const pick = (e: React.MouseEvent, n: number) => {
    e.stopPropagation()
    onChange(current === n ? null : n)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      onChange(null)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      const next = Math.min(5, Math.max(1, current + (e.key === 'ArrowRight' ? 1 : -1)))
      onChange(next)
    }
  }

  return (
    <span
      className="star-rate"
      role="radiogroup"
      aria-label={label}
      style={{ ['--star-size' as string]: `${size}px` }}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHover(null)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={current === n}
          className={'star-rate-btn' + (n <= shown ? ' on' : '')}
          title={current === n ? 'Clear rating' : `${n} star${n > 1 ? 's' : ''}`}
          onMouseEnter={() => setHover(n)}
          onClick={(e) => pick(e, n)}
        >
          <Icon name="star" fill={n <= shown} />
        </button>
      ))}
    </span>
  )
}
