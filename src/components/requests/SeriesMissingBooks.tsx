import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { RequestTile, type CatalogResult } from '@/components/requests/RequestTile'
import { RequestConfirmModal } from '@/components/requests/RequestConfirmModal'
import { WatchSeriesButton } from '@/components/requests/WatchButton'
import { fetchAudibleSeries, audibleKeys } from '@/api/audible'
import { useRmabEnabled } from '@/hooks/useRmab'
import { useAudplexusEnabled } from '@/hooks/useAudplexus'

interface SeriesMissingBooksProps {
  seriesName: string
  // Owned-title keys ("title|author" lowercased) for the books already in this
  // series, to dedupe against the Audible listing.
  ownedKeys: Set<string>
}

// "Complete the series" - lists Audible entries in this series that aren't in
// the library, as requestable (RMAB) or buyable (Audible) tiles. Resolves the
// series ASIN via the backend (ABS exposes none); renders nothing if no match
// or no fulfillment path. Also surfaces the per-series Watch toggle.
export function SeriesMissingBooks({ seriesName, ownedKeys }: SeriesMissingBooksProps) {
  const canRequest = useRmabEnabled()
  const canBuy = useAudplexusEnabled()
  const [confirm, setConfirm] = useState<CatalogResult | null>(null)

  // Only fetch when there's a fulfillment path - otherwise the rows dead-end.
  const enabled = canRequest || canBuy

  const { data } = useQuery({
    queryKey: audibleKeys.series(seriesName),
    queryFn: () => fetchAudibleSeries(seriesName),
    enabled: enabled && seriesName.length >= 2,
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  if (!enabled || !data?.seriesAsin) return null

  const missing = data.books.filter(
    (b) => b.title && !ownedKeys.has((b.title + '|' + b.author).toLowerCase())
  )
  if (missing.length === 0) return null

  return (
    <div className="section">
      <div className="rmab-lane-head">
        <Icon name="travel_explore" />
        <h2>Complete the series</h2>
        <WatchSeriesButton asin={data.seriesAsin} title={data.seriesTitle ?? seriesName} />
      </div>
      <p className="rmab-lane-sub">
        {missing.length} {missing.length === 1 ? 'entry' : 'entries'} not in your library.
      </p>
      <div className="req-grid">
        {missing.map((b) => (
          <RequestTile key={b.asin} result={b} canRequest={canRequest} onRequest={setConfirm} />
        ))}
      </div>
      {confirm && <RequestConfirmModal book={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
