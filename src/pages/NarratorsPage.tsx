import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getNarrators } from '@/api/libraries'
import { renameNarrator } from '@/api/admin'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { MergeModal, type MergeItem } from '@/components/common/MergeModal'
import { Dropdown, MItem } from '@/components/common/Dropdown'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

type NarratorSort = 'Name' | 'Books'

export function NarratorsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { activeId } = useActiveLibrary()
  const [sort, setSort] = useState<NarratorSort>('Books')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [merging, setMerging] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['narrators', activeId],
    queryFn: () => getNarrators(activeId as string),
    enabled: activeId !== null,
    staleTime: 5 * 60 * 1000,
  })

  const narrators = useMemo(() => {
    const list = [...(data?.narrators ?? [])]
    list.sort(
      sort === 'Name'
        ? (a, b) => a.name.localeCompare(b.name)
        : (a, b) => b.numBooks - a.numBooks
    )
    return list
  }, [data, sort])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedItems: MergeItem[] = narrators
    .filter((n) => selected.has(n.id))
    .map((n) => ({ id: n.id, name: n.name, numBooks: n.numBooks }))

  const doMerge = async (canonicalName: string) => {
    if (!activeId) return
    for (const item of selectedItems) {
      if (item.name === canonicalName) continue
      await renameNarrator(activeId, item.name, canonicalName)
    }
    await qc.invalidateQueries({ queryKey: ['narrators', activeId] })
    setSelected(new Set())
  }

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">The voices</div>
        <h1 className="title-xl">Narrators</h1>
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading narrators..." />}
      {isError && (
        <ErrorState message="Could not load narrators." onRetry={refetch} />
      )}

      {data && (
        <>
          <div className="toolbar2">
            <span className="count-badge">{narrators.length} narrators</span>
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
            <Dropdown icon="swap_vert" label={`Sort: ${sort}`} align="left">
              <div className="mp-label">Sort by</div>
              {(['Name', 'Books'] as NarratorSort[]).map((s) => (
                <MItem key={s} label={s} on={s === sort} onClick={() => setSort(s)} />
              ))}
            </Dropdown>
          </div>

          {narrators.length === 0 ? (
            <div className="empty-state">
              <Icon name="mic" />
              <h3>No narrators found</h3>
            </div>
          ) : (
            <div style={{ maxWidth: 720, margin: '0 auto' }}>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }} />
                      <th>Name</th>
                      <th style={{ width: 100 }}>Books</th>
                    </tr>
                  </thead>
                  <tbody>
                    {narrators.map((n) => {
                      const on = selected.has(n.id)
                      return (
                        <tr
                          key={n.id}
                          className={on ? 'row-selected' : ''}
                          onClick={() => toggle(n.id)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td>
                            <div className={'merge-check' + (on ? ' on' : '')} role="checkbox" aria-checked={on}>
                              {on && <Icon name="check" />}
                            </div>
                          </td>
                          <td>
                            <span
                              style={{ fontWeight: 600 }}
                              onClick={(e) => {
                                if (selected.size === 0) {
                                  e.stopPropagation()
                                  navigate(`/library?narrator=${encodeURIComponent(n.name)}`)
                                }
                              }}
                            >
                              {n.name}
                            </span>
                          </td>
                          <td className="num">{n.numBooks}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {merging && (
        <MergeModal
          kind="narrator"
          items={selectedItems}
          onMerge={doMerge}
          onClose={() => setMerging(false)}
        />
      )}
    </div>
  )
}
