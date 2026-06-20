import { WatchToggle } from '@/components/requests/WatchToggle'
import {
  useRmabEnabled,
  useWatchedAuthors,
  useWatchedSeries,
  useWatchAuthorMutation,
  useWatchSeriesMutation,
} from '@/hooks/useRmab'

interface WatchAuthorButtonProps {
  asin: string | null | undefined
  name: string
  coverArtUrl?: string
}

// Watch an author for new releases. Renders only when RMAB is connected AND ABS
// has matched this author to an Audible ASIN (RMAB watches by ASIN). Hidden
// otherwise - no dead control.
export function WatchAuthorButton({ asin, name, coverArtUrl }: WatchAuthorButtonProps) {
  const enabled = useRmabEnabled()
  const { data } = useWatchedAuthors(enabled && !!asin)
  const { add, remove } = useWatchAuthorMutation()

  if (!enabled || !asin) return null
  const watched = data?.authors.find((a) => a.authorAsin === asin)
  const busy = add.isPending || remove.isPending

  const toggle = () => {
    if (watched) remove.mutate(watched.id)
    else add.mutate({ authorAsin: asin, authorName: name, coverArtUrl })
  }
  return <WatchToggle on={!!watched} busy={busy} onToggle={toggle} />
}

interface WatchSeriesButtonProps {
  asin: string | null | undefined
  title: string
  coverArtUrl?: string
}

// Watch a series for new releases. Same ASIN + RMAB gating as the author button.
export function WatchSeriesButton({ asin, title, coverArtUrl }: WatchSeriesButtonProps) {
  const enabled = useRmabEnabled()
  const { data } = useWatchedSeries(enabled && !!asin)
  const { add, remove } = useWatchSeriesMutation()

  if (!enabled || !asin) return null
  const watched = data?.series.find((s) => s.seriesAsin === asin)
  const busy = add.isPending || remove.isPending

  const toggle = () => {
    if (watched) remove.mutate(watched.id)
    else add.mutate({ seriesAsin: asin, seriesTitle: title, coverArtUrl })
  }
  return <WatchToggle on={!!watched} busy={busy} onToggle={toggle} />
}
