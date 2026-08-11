import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getCollections, createCollection, libraryKeys } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'
import { BookPickerModal } from '@/components/library/BookPickerModal'
import { useToast } from '@/hooks/useToast'

export function CollectionsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { activeId } = useActiveLibrary()
  const { toast, show } = useToast()
  const [creating, setCreating] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: libraryKeys.collections(activeId ?? ''),
    queryFn: () => getCollections(activeId as string),
    enabled: activeId !== null,
    staleTime: 2 * 60 * 1000,
  })

  const collections = data?.results ?? []

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">Hand-built shelves</div>
        <h1 className="title-xl">Collections</h1>
        {data && (
          <p className="page-sub">
            {collections.length} {collections.length === 1 ? 'collection' : 'collections'}
          </p>
        )}
      </div>

      <div className="toolbar2">
        <span className="count-badge">
          {collections.length} {collections.length === 1 ? 'collection' : 'collections'}
        </span>
        <div className="tb-spacer" />
        <button className="pill" onClick={() => setCreating(true)} disabled={!activeId}>
          <Icon name="add" /> New collection
        </button>
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading collections..." />}
      {isError && <ErrorState message="Could not load collections." onRetry={refetch} />}

      {data && collections.length === 0 && (
        <div className="empty-state">
          <Icon name="folder_special" />
          <h3>No collections yet</h3>
          <p>Group books into a shelf of your own. Start one with New collection.</p>
        </div>
      )}

      {collections.length > 0 && (
        <div className="coll-grid">
          {collections.map((c) => {
            const books = c.books ?? []
            const extra = books.length - 4
            const cv = tintFor(books[0]?.media.metadata.title ?? c.name)
            return (
              <div
                key={c.id}
                className="coll-card"
                data-cv={cv}
                onClick={() => navigate(`/collections/${c.id}`, { state: { collection: c } })}
              >
                <div className="coll-stack">
                  {books.slice(0, 4).map((b) => (
                    <Cover
                      key={b.id}
                      itemId={b.id}
                      title={b.media.metadata.title ?? 'Untitled'}
                      fs={6}
                    />
                  ))}
                  {extra > 0 && <div className="stack-more">+{extra}</div>}
                </div>
                <div className="coll-meta">
                  <h3>{c.name}</h3>
                  {c.description && <p>{c.description}</p>}
                  <div className="coll-count">
                    <Icon name="auto_stories" /> {books.length}{' '}
                    {books.length === 1 ? 'book' : 'books'}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {creating && activeId && (
        <BookPickerModal
          kind="collection"
          libraryId={activeId}
          mode="create"
          onSubmit={async (books, name) => {
            const made = await createCollection(activeId, name, books)
            qc.invalidateQueries({ queryKey: libraryKeys.collections(activeId) })
            show(`Created ${name}`)
            navigate(`/collections/${made.id}`)
          }}
          onClose={() => setCreating(false)}
        />
      )}

      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </div>
  )
}
