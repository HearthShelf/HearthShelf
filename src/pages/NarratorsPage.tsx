import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getNarrators } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { Dropdown, MItem } from '@/components/common/Dropdown'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

type NarratorSort = 'Name' | 'Books'

export function NarratorsPage() {
  const navigate = useNavigate()
  const { activeId } = useActiveLibrary()
  const [sort, setSort] = useState<NarratorSort>('Books')

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
            <Dropdown icon="swap_vert" label={`Sort: ${sort}`} align="left">
              <div className="mp-label">Sort by</div>
              {(['Name', 'Books'] as NarratorSort[]).map((s) => (
                <MItem
                  key={s}
                  label={s}
                  on={s === sort}
                  onClick={() => setSort(s)}
                />
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
                      <th>Name</th>
                      <th style={{ width: 100 }}>Books</th>
                    </tr>
                  </thead>
                  <tbody>
                    {narrators.map((n) => (
                      <tr key={n.id}>
                        <td>
                          <span
                            className="lnk"
                            onClick={() =>
                              navigate(
                                `/library?narrator=${encodeURIComponent(n.name)}`
                              )
                            }
                          >
                            {n.name}
                          </span>
                        </td>
                        <td className="num">{n.numBooks}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
