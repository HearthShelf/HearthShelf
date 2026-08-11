import { Icon } from '@/components/common/Icon'
import { useFollowLookup, useFollow, useUnfollow } from '@/hooks/useSubscriptions'

interface FollowSeriesButtonProps {
  // Audible series ASIN - what a series follow keys on. The button hides when
  // the series hasn't resolved against Audible, since there'd be nothing to
  // follow (and no way to learn about its future books).
  seriesAsin: string | null | undefined
  seriesTitle: string
  author?: string
  // Artwork to stand for the series in the Following list. A series has no cover
  // of its own, so callers pass a representative book's - without it the row
  // renders an empty grey tile.
  coverArtUrl?: string
}

// Follow a whole series: every future book in it is tracked, so a new release
// notifies without having to spot it and follow it by hand.
//
// Distinct from WatchSeriesButton, which is RMAB's auto-REQUEST watch list and
// only exists when the request backend is connected. A follow only notifies, and
// is always available.
export function FollowSeriesButton({
  seriesAsin,
  seriesTitle,
  author,
  coverArtUrl,
}: FollowSeriesButtonProps) {
  const { seriesSub } = useFollowLookup()
  const follow = useFollow()
  const unfollow = useUnfollow()

  if (!seriesAsin) return null

  const sub = seriesSub(seriesAsin)
  const following = Boolean(sub)
  const busy = follow.isPending || unfollow.isPending

  const onClick = () => {
    if (busy) return
    if (sub) {
      unfollow.mutate(sub.id)
      return
    }
    follow.mutate({
      kind: 'series',
      seriesAsin,
      title: seriesTitle,
      seriesTitle,
      author,
      coverArtUrl,
    })
  }

  return (
    <button
      className={'pill' + (following ? ' on' : '')}
      onClick={onClick}
      disabled={busy}
      title={
        following
          ? 'You get notified when a new book in this series is released'
          : 'Get notified when a new book in this series is released'
      }
    >
      <Icon name={following ? 'notifications_active' : 'notifications'} fill={following} />{' '}
      {following ? 'Following series' : 'Follow series'}
    </button>
  )
}
