/**
 * The answer-in-place controls on a "how was it?" notification row.
 *
 * The prompt is answered in the tray rather than by routing to the book: a
 * rating you have to navigate away to give is a rating most people abandon.
 * Five stars, Skip, and (behind the Skip) a way to turn the whole category off.
 *
 * The row auto-dismisses once a star lands - the question is answered, so
 * leaving it in the tray would just be one more thing to clear. The brief
 * confirmation before it goes is what makes the disappearance read as "saved"
 * rather than "lost".
 *
 * Mirrors the same component in HearthShelf-Mobile and HearthShelf-WebApp; the
 * copy and star values all come from @hearthshelf/core so they cannot drift.
 */
import { useState } from 'react'
import { RATING_PROMPT_VALUES, ratingStarLabel, ratingSavedMessage } from '@hearthshelf/core'
import { Icon } from '@/components/common/Icon'

export interface RatingPromptActionsProps {
  /** Title, for labels that would otherwise read "4 stars" with no indication
   *  of what is being rated. */
  bookTitle: string
  /** Persist the rating. Resolves false when the write failed, which keeps the
   *  row on screen rather than dismissing a rating that never saved. */
  onRate: (rating: number) => Promise<boolean>
  onSkip: () => void
  onStopAsking: () => void
}

export function RatingPromptActions({
  bookTitle,
  onRate,
  onSkip,
  onStopAsking,
}: RatingPromptActionsProps) {
  // The star being written, so it fills immediately while the request is in
  // flight - an optimistic fill is the whole feedback signal on a control that
  // is about to vanish.
  const [pending, setPending] = useState(0)
  const [saved, setSaved] = useState(0)
  const [hover, setHover] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirmingStop, setConfirmingStop] = useState(false)

  const rate = async (value: number) => {
    if (busy) return
    setBusy(true)
    setPending(value)
    const ok = await onRate(value)
    if (ok) {
      setSaved(value)
      return // Parent is dismissing the row; leave the fill in place.
    }
    // Failed: drop the optimistic fill so the row does not claim a score the
    // server never stored.
    setPending(0)
    setBusy(false)
  }

  if (saved) {
    return (
      <div className="notification-rating-saved" role="status">
        <Icon name="star" fill />
        <span>{ratingSavedMessage(saved)}</span>
      </div>
    )
  }

  const filled = pending || hover

  return (
    <div className="notification-rating" onClick={(event) => event.stopPropagation()}>
      <div className="notification-rating-stars" onMouseLeave={() => setHover(0)}>
        {RATING_PROMPT_VALUES.map((n) => (
          <button
            key={n}
            type="button"
            className={'notification-rating-star' + (n <= filled ? ' on' : '')}
            disabled={busy}
            aria-label={`Rate ${bookTitle} ${ratingStarLabel(n)}`}
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(n)}
            onBlur={() => setHover(0)}
            onClick={() => void rate(n)}
          >
            <Icon name="star" fill={n <= filled} />
          </button>
        ))}
      </div>

      {confirmingStop ? (
        <div className="notification-rating-stop">
          <span>Stop asking after you finish a book?</span>
          <div className="notification-actions">
            <button type="button" className="pill on" onClick={onStopAsking}>
              Stop asking
            </button>
            <button type="button" className="pill" onClick={() => setConfirmingStop(false)}>
              Keep
            </button>
          </div>
        </div>
      ) : (
        <div className="notification-rating-skip">
          <button type="button" disabled={busy} onClick={onSkip}>
            Skip rating
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirmingStop(true)}>
            Don’t ask again
          </button>
        </div>
      )}
    </div>
  )
}
