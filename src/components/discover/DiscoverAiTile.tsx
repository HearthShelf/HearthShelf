import { Icon } from '@/components/common/Icon'
import { StarRating } from '@/components/common/StarRating'
import { BookTile } from '@/components/library/BookTile'
import type { ABSLibraryItem } from '@/api/types'
import type { DiscoverFeedbackEntry, DiscoverVote } from '@/api/discover'

interface DiscoverAiTileProps {
  item: ABSLibraryItem
  reason?: string
  progress?: number
  finished?: boolean
  feedback?: DiscoverFeedbackEntry
  /** The user's own rating for this book, from /hs/ratings. */
  rating?: number
  onVote: (itemKey: string, vote: DiscoverVote | null) => void
  onRate: (itemKey: string, rating: number | null) => void
  onNotInterested: (itemKey: string) => void
}

// An AI-shelf tile: the standard BookTile plus a compact feedback bar (thumb
// up/down, 1-5 stars, not-interested) that drives next month's generation.
// The stars are the same site-wide rating shown on the book page, not a
// Discover-local one - rating here shows up there and vice versa.
export function DiscoverAiTile({
  item,
  reason,
  progress,
  finished,
  feedback,
  rating,
  onVote,
  onRate,
  onNotInterested,
}: DiscoverAiTileProps) {
  const fb = feedback ?? {}
  const toggle = (v: DiscoverVote) => onVote(item.id, fb.vote === v ? null : v)

  return (
    <div className="disc-ai-tile">
      <BookTile item={item} progress={progress ?? 0} finished={finished} />
      {reason && <p className="disc-ai-why">{reason}</p>}
      <div className="disc-fb">
        <button
          className={'qg-vote' + (fb.vote === 'like' ? ' up' : '')}
          title="Like"
          onClick={() => toggle('like')}
          type="button"
        >
          <Icon name="thumb_up" fill={fb.vote === 'like'} />
        </button>
        <button
          className={'qg-vote' + (fb.vote === 'dislike' ? ' down' : '')}
          title="Dislike"
          onClick={() => toggle('dislike')}
          type="button"
        >
          <Icon name="thumb_down" fill={fb.vote === 'dislike'} />
        </button>
        <StarRating value={rating ?? null} onChange={(n) => onRate(item.id, n)} />
        <button
          className="disc-not"
          title="Not interested - hide and stop suggesting"
          onClick={() => onNotInterested(item.id)}
          type="button"
        >
          <Icon name="block" /> Not for me
        </button>
      </div>
    </div>
  )
}
