import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { RequestTile, type CatalogResult } from '@/components/requests/RequestTile'
import { RequestConfirmModal } from '@/components/requests/RequestConfirmModal'
import { WatchSeriesButton } from '@/components/requests/WatchButton'
import { fetchAudibleSeries, audibleKeys } from '@/api/audible'
import { useRmabEnabled } from '@/hooks/useRmab'

interface SeriesMissingBooksProps {
  seriesName: string
  // Owned-title keys ("title|author" lowercased) for the books already in this
  // series, to dedupe against the Audible listing.
  ownedKeys: Set<string>
  // When true, render the missing entries as inline list rows (sl-row-missing)
  // meant to sit at the end of a series-list, instead of a separate section.
  inline?: boolean
  // Starting sequence number for inline rows (continues the owned-book numbering).
  startSeq?: number
}

// Audible entries in this series that aren't in the library. Each is requestable
// when RMAB is connected, and always buyable on Audible. Resolves the series ASIN
// via the backend (ABS exposes none); renders nothing if no series match.
// Inline mode folds the missing rows into the series list (DS sl-row-missing);
// the default renders the standalone "Complete the series" section.
export function SeriesMissingBooks({
  seriesName,
  ownedKeys,
  inline,
  startSeq = 0,
}: SeriesMissingBooksProps) {
  const canRequest = useRmabEnabled()
  const [confirm, setConfirm] = useState<CatalogResult | null>(null)

  const { data } = useQuery({
    queryKey: audibleKeys.series(seriesName),
    queryFn: () => fetchAudibleSeries(seriesName),
    enabled: seriesName.length >= 2,
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  if (!data?.seriesAsin) return null

  const missing = data.books.filter(
    (b) => b.title && !ownedKeys.has((b.title + '|' + b.author).toLowerCase()),
  )
  if (missing.length === 0) return null

  if (inline) {
    return (
      <>
        {missing.map((b, i) => (
          <div key={b.asin} className="sl-row sl-row-missing" onClick={() => setConfirm(b)}>
            <div className="sl-num">{startSeq + i + 1}</div>
            {b.coverArtUrl ? (
              <img className="sl-cover" src={b.coverArtUrl} alt="" />
            ) : (
              <div className="sl-cover" style={{ background: 'var(--c-highest)' }} />
            )}
            <div className="sl-meta">
              <div className="sl-title">{b.title}</div>
              <div className="sl-sub">{[b.author, b.narrator].filter(Boolean).join(' · ')}</div>
            </div>
            <span className="sl-missing-tag">
              <Icon name={canRequest ? 'bolt' : 'shopping_cart'} fill={canRequest} />
              {canRequest ? 'Request' : 'Not in library'}
            </span>
          </div>
        ))}
        {confirm && (
          <RequestConfirmModal
            book={confirm}
            canRequest={canRequest}
            intro
            onClose={() => setConfirm(null)}
          />
        )}
      </>
    )
  }

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
