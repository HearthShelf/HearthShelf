import { useState } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getCollection,
  deleteCollection,
  updateCollection,
  addBooksToCollection,
  libraryKeys,
} from '@/api/libraries'
import { RenameModal } from '@/components/common/RenameModal'
import { BookPickerModal } from '@/components/library/BookPickerModal'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { usePlayer } from '@/hooks/usePlayer'
import { formatDuration } from '@/lib/format'
import type { ABSCollection } from '@/api/types'
import { BookTile } from '@/components/library/BookTile'
import { Icon } from '@/components/common/Icon'
import { Dropdown, MItem } from '@/components/common/Dropdown'
import { tintFor } from '@/components/common/Cover'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

function CollectionDetail({ collection }: { collection: ABSCollection }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { activeId } = useActiveLibrary()
  const progressById = useMediaProgress()
  const { playItem } = usePlayer()

  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)

  const books = collection.books ?? []
  const totalH = books.reduce((s, b) => s + (b.media.duration ?? 0), 0)
  const cv = tintFor(books[0]?.media.metadata.title ?? collection.name)

  const onSaveEdit = async (patch: { name: string; description?: string }) => {
    await updateCollection(collection.id, patch)
    qc.invalidateQueries({ queryKey: libraryKeys.collection(collection.id) })
    if (activeId) qc.invalidateQueries({ queryKey: libraryKeys.collections(activeId) })
  }

  const onDelete = async () => {
    if (!window.confirm(`Delete the collection "${collection.name}"?`)) return
    await deleteCollection(collection.id)
    if (activeId) qc.invalidateQueries({ queryKey: libraryKeys.collections(activeId) })
    navigate('/collections')
  }

  return (
    <div className="page fade-in" style={{ ['--glow-accent' as string]: cv }}>
      <div className="crumb">
        <Link className="lnk" to="/collections">
          Collections
        </Link>
        <Icon name="chevron_right" />
        {collection.name}
      </div>

      <div className="page-head">
        <div className="eyebrow">Collection</div>
        <h1 className="title-xl">{collection.name}</h1>
        {collection.description && <p className="page-sub">{collection.description}</p>}
      </div>

      <div className="toolbar2">
        <span className="count-badge">
          {books.length} {books.length === 1 ? 'book' : 'books'} · {formatDuration(totalH)}
        </span>
        <div className="tb-spacer" />
        {books[0] && (
          <button className="pill" onClick={() => void playItem(books[0].id)}>
            <Icon name="play_arrow" fill /> Play all
          </button>
        )}
        <button className="pill" onClick={() => setAdding(true)}>
          <Icon name="library_add" /> Add books
        </button>
        <button className="pill" onClick={() => setEditing(true)}>
          <Icon name="edit" /> Edit
        </button>
        <Dropdown icon="more_horiz" label="">
          <MItem icon="rss_feed" label="Open RSS feed" />
          <MItem icon="download" label="Download" />
          <div className="mp-sep" />
          <MItem icon="delete" label="Delete collection" danger onClick={() => void onDelete()} />
        </Dropdown>
      </div>

      {books.length === 0 ? (
        <div className="empty-state">
          <Icon name="auto_stories" />
          <h3>This collection is empty</h3>
          <button
            className="btn-sm btn-ghost"
            style={{ margin: '0 auto' }}
            onClick={() => setAdding(true)}
          >
            <Icon name="library_add" /> Add books
          </button>
        </div>
      ) : (
        <div className="lib-grid">
          {books.map((b) => {
            const p = progressById.get(b.id)
            return (
              <BookTile key={b.id} item={b} progress={p?.progress ?? 0} finished={p?.isFinished} />
            )
          })}
        </div>
      )}

      {adding && activeId && (
        <BookPickerModal
          kind="collection"
          libraryId={activeId}
          mode="add"
          listName={collection.name}
          existingIds={books.map((b) => b.id)}
          onSubmit={async (ids) => {
            await addBooksToCollection(collection.id, ids)
            qc.invalidateQueries({ queryKey: libraryKeys.collection(collection.id) })
            qc.invalidateQueries({ queryKey: libraryKeys.collections(activeId) })
          }}
          onClose={() => setAdding(false)}
        />
      )}

      {editing && (
        <RenameModal
          title="Edit collection"
          initialName={collection.name}
          initialDescription={collection.description ?? ''}
          onSave={onSaveEdit}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

export function CollectionDetailPage() {
  const { collectionId } = useParams()
  const location = useLocation()
  const passed = (location.state as { collection?: ABSCollection } | null)?.collection

  // The grid passes the collection through router state so the page paints
  // instantly, but it stays the QUERY's seed rather than replacing it - editing
  // the collection has to re-render from fresh data, and a passed copy that
  // short-circuits the query would keep showing the pre-edit book list.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: libraryKeys.collection(collectionId ?? ''),
    queryFn: () => getCollection(collectionId as string),
    enabled: Boolean(collectionId),
    initialData: passed,
    staleTime: 5 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="page">
        <LoadingSpinner className="py-12" label="Loading collection..." />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="page">
        <ErrorState message="Could not load this collection." onRetry={refetch} />
      </div>
    )
  }
  return <CollectionDetail collection={data} />
}
