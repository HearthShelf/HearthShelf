import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getLibraries, getSeries, libraryKeys } from '@/api/libraries'
import { renameSeries } from '@/api/admin'
import { useAuth } from '@/hooks/useAuth'
import { SeriesCard } from '@/components/library/SeriesCard'
import { MergeModal, type MergeItem } from '@/components/common/MergeModal'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

export function SeriesPage() {
  const { defaultLibraryId } = useAuth()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [merging, setMerging] = useState(false)

  const { data: librariesData } = useQuery({
    queryKey: libraryKeys.all,
    queryFn: getLibraries,
    staleTime: 5 * 60 * 1000,
  })
  const libraryId = defaultLibraryId ?? librariesData?.libraries[0]?.id ?? null

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: libraryKeys.series(libraryId ?? ''),
    queryFn: () => getSeries(libraryId!),
    enabled: libraryId !== null,
    staleTime: 2 * 60 * 1000,
  })

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedItems: MergeItem[] = useMemo(
    () =>
      (data?.results ?? [])
        .filter((s) => selected.has(s.id))
        .map((s) => ({ id: s.id, name: s.name, numBooks: s.books?.length ?? 0 })),
    [data, selected]
  )

  const doMerge = async (canonicalName: string) => {
    for (const item of selectedItems) {
      if (item.name === canonicalName) continue
      await renameSeries(item.id, canonicalName)
    }
    await qc.invalidateQueries({ queryKey: libraryKeys.series(libraryId ?? '') })
    setSelected(new Set())
  }

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">Collected works</div>
        <h1 className="title-xl">Series</h1>
        {data && (
          <p className="page-sub">{data.total} series · grouped by metadata</p>
        )}
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading series..." />}
      {isError && (
        <ErrorState message="Could not load series." onRetry={refetch} />
      )}

      {data && (
        <>
          {(selected.size > 0 || data.results.length > 0) && (
            <div className="toolbar2">
              <div className="tb-spacer" />
              {selected.size >= 2 && (
                <button className="btn-sm btn-primary" onClick={() => setMerging(true)}>
                  <Icon name="merge" />
                  Merge {selected.size}
                </button>
              )}
              {selected.size > 0 && (
                <button className="btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              )}
            </div>
          )}
          <div className="series-grid">
            {data.results.map((s) => (
              <div
                key={s.id}
                className={'selectable-card' + (selected.has(s.id) ? ' selected' : '')}
                onClick={() => toggle(s.id)}
              >
                {selected.has(s.id) && (
                  <div className="selectable-check">
                    <Icon name="check" />
                  </div>
                )}
                <SeriesCard series={s} selectionActive={selected.size > 0} />
              </div>
            ))}
          </div>
        </>
      )}

      {merging && (
        <MergeModal
          kind="series"
          items={selectedItems}
          onMerge={doMerge}
          onClose={() => setMerging(false)}
        />
      )}
    </div>
  )
}
