import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getPlaylists, createPlaylist, libraryKeys } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'
import { BookPickerModal } from '@/components/library/BookPickerModal'
import { useToast } from '@/hooks/useToast'

export function PlaylistsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { activeId } = useActiveLibrary()
  const { toast, show } = useToast()
  const [creating, setCreating] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: libraryKeys.playlists(activeId ?? ''),
    queryFn: () => getPlaylists(activeId as string),
    enabled: activeId !== null,
    staleTime: 2 * 60 * 1000,
  })

  const playlists = data?.results ?? []

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">Your queues</div>
        <h1 className="title-xl">Playlists</h1>
        {data && (
          <p className="page-sub">
            {playlists.length} {playlists.length === 1 ? 'playlist' : 'playlists'}
          </p>
        )}
      </div>

      <div className="toolbar2">
        <span className="count-badge">
          {playlists.length} {playlists.length === 1 ? 'playlist' : 'playlists'}
        </span>
        <div className="tb-spacer" />
        <button className="pill" onClick={() => setCreating(true)} disabled={!activeId}>
          <Icon name="add" /> New playlist
        </button>
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading playlists..." />}
      {isError && <ErrorState message="Could not load playlists." onRetry={refetch} />}

      {data && playlists.length === 0 && (
        <div className="empty-state">
          <Icon name="queue_music" />
          <h3>No playlists yet</h3>
          <p>Line up books to listen to in order. Start one with New playlist.</p>
        </div>
      )}

      {playlists.length > 0 && (
        <div className="coll-grid">
          {playlists.map((pl) => {
            const items = pl.items ?? []
            const extra = items.length - 4
            const cv = tintFor(items[0]?.libraryItem.media.metadata.title ?? pl.name)
            return (
              <div
                key={pl.id}
                className="coll-card"
                data-cv={cv}
                onClick={() => navigate(`/playlists/${pl.id}`, { state: { playlist: pl } })}
              >
                <div className="coll-stack">
                  {items.slice(0, 4).map((it) => (
                    <Cover
                      key={it.libraryItemId}
                      itemId={it.libraryItemId}
                      title={it.libraryItem.media.metadata.title ?? 'Untitled'}
                      fs={6}
                    />
                  ))}
                  {extra > 0 && <div className="stack-more">+{extra}</div>}
                </div>
                <div className="coll-meta">
                  <h3>{pl.name}</h3>
                  {pl.description && <p>{pl.description}</p>}
                  <div className="coll-count">
                    <Icon name="queue_music" /> {items.length}{' '}
                    {items.length === 1 ? 'item' : 'items'}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {creating && activeId && (
        <BookPickerModal
          kind="playlist"
          libraryId={activeId}
          mode="create"
          onSubmit={async (books, name) => {
            const made = await createPlaylist(
              activeId,
              name,
              books.map((libraryItemId) => ({ libraryItemId })),
            )
            qc.invalidateQueries({ queryKey: libraryKeys.playlists(activeId) })
            show(`Created ${name}`)
            navigate(`/playlists/${made.id}`)
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
