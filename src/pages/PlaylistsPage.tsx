import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getPlaylists, libraryKeys } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

export function PlaylistsPage() {
  const navigate = useNavigate()
  const { activeId } = useActiveLibrary()

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

      {isLoading && <LoadingSpinner className="py-12" label="Loading playlists..." />}
      {isError && (
        <ErrorState message="Could not load playlists." onRetry={refetch} />
      )}

      {data && playlists.length === 0 && (
        <div className="empty-state">
          <Icon name="queue_music" />
          <h3>No playlists yet</h3>
          <p>Playlists you build in AudiobookShelf show up here.</p>
        </div>
      )}

      {playlists.length > 0 && (
        <div className="coll-grid">
          {playlists.map((pl) => {
            const items = pl.items ?? []
            const extra = items.length - 4
            const cv = tintFor(
              items[0]?.libraryItem.media.metadata.title ?? pl.name
            )
            return (
              <div
                key={pl.id}
                className="coll-card"
                data-cv={cv}
                onClick={() =>
                  navigate(`/playlists/${pl.id}`, { state: { playlist: pl } })
                }
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
    </div>
  )
}
