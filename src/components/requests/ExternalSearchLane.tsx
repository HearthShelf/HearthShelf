import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SectionHead } from '@/components/common/SectionHead'
import { RequestTile, type CatalogResult } from '@/components/requests/RequestTile'
import { RequestConfirmModal } from '@/components/requests/RequestConfirmModal'
import { searchAudible, audibleKeys } from '@/api/audible'
import { useRmabEnabled } from '@/hooks/useRmab'
import { useSettingsStore } from '@/store/settingsStore'
import { isOwnedExternalResult, type OwnedIndex } from '@hearthshelf/core'

interface ExternalSearchLaneProps {
  query: string
  // Ownership lookup over the WHOLE library - ASIN first, then normalized
  // title+author. Built by the caller; see core's lib/ownedMatch.ts for why it
  // must not be scoped to the current query's hits.
  ownedIndex: OwnedIndex
}

// "Not in your library" lane. Searches the Audible catalog (our own lookup, so it
// works whether or not the request backend is set up) and shows titles you don't
// own. Each result offers a Request button when RMAB is configured, otherwise a
// Buy-on-Audible link. Gated by the searchExternalSources setting; fails soft.
export function ExternalSearchLane({ query, ownedIndex }: ExternalSearchLaneProps) {
  const externalOn = useSettingsStore((s) => s.searchExternalSources)
  const canRequest = useRmabEnabled()
  const [confirm, setConfirm] = useState<CatalogResult | null>(null)
  const q = query.trim()
  const enabled = externalOn && q.length >= 2

  const { data, isError } = useQuery({
    queryKey: audibleKeys.search(q),
    queryFn: () => searchAudible(q),
    enabled,
    staleTime: 60 * 1000,
    retry: false,
  })

  if (!enabled || isError) return null

  const results: CatalogResult[] = (data?.results ?? []).filter(
    (r) => !isOwnedExternalResult(ownedIndex, r),
  )
  if (results.length === 0) return null

  return (
    <div className="rmab-lane">
      <SectionHead icon="travel_explore" title={`Not in your library · ${results.length}`} />
      <p className="rmab-lane-sub">
        {canRequest
          ? 'Found on Audible - request and ReadMeABook will fetch it.'
          : 'Found on Audible but not in your library yet.'}
      </p>
      <div className="req-grid">
        {results.map((r) => (
          <RequestTile key={r.asin} result={r} canRequest={canRequest} onRequest={setConfirm} />
        ))}
      </div>
      {confirm && <RequestConfirmModal book={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
