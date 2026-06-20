import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAuthors, libraryKeys } from '@/api/libraries'
import { renameAuthor } from '@/api/admin'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { AuthorCard } from '@/components/library/AuthorCard'
import { MergeModal, type MergeItem } from '@/components/common/MergeModal'
import { Dropdown, MItem } from '@/components/common/Dropdown'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

type AuthorSort = 'Name' | 'Books' | 'Added'

export function AuthorsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { activeId } = useActiveLibrary()
  const [sort, setSort] = useState<AuthorSort>('Books')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [merging, setMerging] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: libraryKeys.authors(activeId ?? ''),
    queryFn: () => getAuthors(activeId as string),
    enabled: activeId !== null,
    staleTime: 5 * 60 * 1000,
  })

  const authors = useMemo(() => {
    const list = [...(data?.authors ?? [])]
    if (sort === 'Name') list.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'Books') list.sort((a, b) => b.numBooks - a.numBooks)
    else list.sort((a, b) => b.addedAt - a.addedAt)
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

  const selectedItems: MergeItem[] = authors
    .filter((a) => selected.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, numBooks: a.numBooks }))

  const doMerge = async (canonicalName: string) => {
    for (const item of selectedItems) {
      if (item.name === canonicalName) continue
      await renameAuthor(item.id, canonicalName)
    }
    await qc.invalidateQueries({ queryKey: libraryKeys.authors(activeId ?? '') })
    setSelected(new Set())
  }

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">Who wrote it</div>
        <h1 className="title-xl">Authors</h1>
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading authors..." />}
      {isError && (
        <ErrorState message="Could not load authors." onRetry={refetch} />
      )}

      {data && (
        <>
          <div className="toolbar2">
            <span className="count-badge">{authors.length} authors</span>
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
              {(['Name', 'Books', 'Added'] as AuthorSort[]).map((s) => (
                <MItem key={s} label={s} on={s === sort} onClick={() => setSort(s)} />
              ))}
            </Dropdown>
          </div>

          {authors.length === 0 ? (
            <div className="empty-state">
              <Icon name="person" />
              <h3>No authors found</h3>
            </div>
          ) : (
            <div className="author-grid">
              {authors.map((a) => (
                <div
                  key={a.id}
                  className={'selectable-card' + (selected.has(a.id) ? ' selected' : '')}
                  onClick={() => toggle(a.id)}
                >
                  {selected.has(a.id) && (
                    <div className="selectable-check">
                      <Icon name="check" />
                    </div>
                  )}
                  <AuthorCard
                    author={a}
                    onOpen={(id) => {
                      if (selected.size === 0) navigate(`/author/${id}`)
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {merging && (
        <MergeModal
          kind="author"
          items={selectedItems}
          onMerge={doMerge}
          onClose={() => setMerging(false)}
        />
      )}
    </div>
  )
}
