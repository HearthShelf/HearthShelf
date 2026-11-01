import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { RequestTile, type CatalogResult } from '@/components/requests/RequestTile'
import { RequestConfirmModal } from '@/components/requests/RequestConfirmModal'
import { searchAudible, audibleKeys } from '@/api/audible'
import { useRmabEnabled } from '@/hooks/useRmab'
import { isOwnedExternalResult, type OwnedIndex } from '@hearthshelf/core'

interface DiscoverSearchProps {
  // Ownership lookup over the whole library - ASIN first, then normalized
  // title+author. See core's lib/ownedMatch.ts.
  ownedIndex: OwnedIndex
}

// Audible catalog search on Discover. HearthShelf owns this search (our own
// backend), independent of any connector. Each result is Requestable when RMAB
// is connected; otherwise it links out to buy on Audible (always available).
export function DiscoverSearch({ ownedIndex }: DiscoverSearchProps) {
  const [q, setQ] = useState('')
  const [confirm, setConfirm] = useState<CatalogResult | null>(null)
  const canRequest = useRmabEnabled()
  const query = q.trim()

  const { data, isFetching, isError } = useQuery({
    queryKey: audibleKeys.search(query),
    queryFn: () => searchAudible(query),
    enabled: query.length >= 2,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  const results = (data?.results ?? []).filter((r) => !isOwnedExternalResult(ownedIndex, r))

  return (
    <div className="section">
      <form
        className="ab-search"
        onSubmit={(e) => e.preventDefault()}
        style={{ maxWidth: 560, marginBottom: 22 }}
      >
        <span style={{ display: 'grid', placeItems: 'center' }}>
          <Icon name="search" />
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search Audible for any title..."
        />
        {query && (
          <button type="button" className="ab-clear" onClick={() => setQ('')} title="Clear">
            <Icon name="close" />
          </button>
        )}
      </form>

      {query.length >= 2 && (
        <>
          <SectionHead
            icon="travel_explore"
            title={
              isFetching
                ? 'Searching Audible...'
                : `Audible · ${results.length} result${results.length === 1 ? '' : 's'}`
            }
          />
          {isError ? (
            <div className="banner info">
              <Icon name="cloud_off" /> Audible search is unavailable right now.
            </div>
          ) : results.length === 0 && !isFetching ? (
            <div className="empty-state">
              <Icon name="search_off" />
              <h3>Nothing found</h3>
              <p>No Audible titles match "{query}".</p>
            </div>
          ) : (
            <div className="req-grid">
              {results.map((r) => (
                <RequestTile
                  key={r.asin}
                  result={r}
                  canRequest={canRequest}
                  onRequest={setConfirm}
                />
              ))}
            </div>
          )}
          {!canRequest && results.length > 0 && (
            <p className="rmab-lane-sub" style={{ marginTop: 10 }}>
              Connect ReadMeABook to request titles straight to your library.
            </p>
          )}
        </>
      )}

      {confirm && <RequestConfirmModal book={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
