import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { RequestTile } from '@/components/requests/RequestTile'
import { RequestConfirmModal } from '@/components/requests/RequestConfirmModal'
import { searchCatalog, requestKeys, type RmabSearchResult } from '@/api/requests'
import { useRmabEnabled } from '@/hooks/useRmab'

interface RmabSearchLaneProps {
  query: string
  // Owned-title keys ("title|author", lowercased) to dedupe against the library.
  ownedKeys: Set<string>
}

// "Available to request" lane. Only renders when RMAB is configured; fails soft
// (an info banner) if the backend is unreachable, leaving library results intact.
export function RmabSearchLane({ query, ownedKeys }: RmabSearchLaneProps) {
  const enabled = useRmabEnabled()
  const [confirm, setConfirm] = useState<RmabSearchResult | null>(null)
  const q = query.trim()

  const { data, isError } = useQuery({
    queryKey: requestKeys.search(q),
    queryFn: () => searchCatalog(q),
    enabled: enabled && q.length >= 2,
    staleTime: 60 * 1000,
    retry: false,
  })

  if (!enabled || q.length < 2) return null

  if (isError) {
    return (
      <div className="rmab-lane">
        <div className="rmab-lane-head">
          <Icon name="travel_explore" />
          <h2>Available to request</h2>
          <span className="rmab-via">
            <Icon name="bolt" fill /> via ReadMeABook
          </span>
        </div>
        <div className="banner info">
          <Icon name="cloud_off" /> Couldn't reach ReadMeABook. Your library results are still shown
          above.
        </div>
      </div>
    )
  }

  const results = (data?.results ?? []).filter(
    (r) => !ownedKeys.has((r.title + '|' + r.author).toLowerCase())
  )
  if (results.length === 0) return null

  return (
    <div className="rmab-lane">
      <SectionHead icon="travel_explore" title={`Available to request · ${results.length}`} />
      <p className="rmab-lane-sub">
        Not in your library - request and ReadMeABook will fetch it.
      </p>
      <div className="req-grid">
        {results.map((r) => (
          <RequestTile key={r.asin} result={r} onRequest={setConfirm} />
        ))}
      </div>
      {confirm && <RequestConfirmModal book={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
