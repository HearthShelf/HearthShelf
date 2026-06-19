import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getPlaylist } from '@/api/libraries'
import { usePlayer } from '@/hooks/usePlayer'
import { formatDuration } from '@/lib/format'
import type { ABSPlaylist } from '@/api/types'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

function PlaylistDetail({ playlist }: { playlist: ABSPlaylist }) {
  const navigate = useNavigate()
  const { playItem } = usePlayer()
  const items = playlist.items ?? []
  const totalH = items.reduce(
    (s, it) => s + (it.libraryItem.media.duration ?? 0),
    0
  )
  const cv = tintFor(items[0]?.libraryItem.media.metadata.title ?? playlist.name)

  return (
    <div className="page fade-in" style={{ ['--glow-accent' as string]: cv }}>
      <div className="crumb">
        <Link className="lnk" to="/playlists">
          Playlists
        </Link>
        <Icon name="chevron_right" />
        {playlist.name}
      </div>

      <div className="page-head">
        <div className="eyebrow">Playlist</div>
        <h1 className="title-xl">{playlist.name}</h1>
        {playlist.description && <p className="page-sub">{playlist.description}</p>}
      </div>

      <div className="toolbar2">
        <span className="count-badge">
          {items.length} {items.length === 1 ? 'item' : 'items'} ·{' '}
          {formatDuration(totalH)}
        </span>
        <div className="tb-spacer" />
        {items[0] && (
          <button
            className="btn btn-primary"
            onClick={() => void playItem(items[0].libraryItemId)}
          >
            <Icon name="play_arrow" fill /> Play
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <Icon name="queue_music" />
          <h3>This playlist is empty</h3>
        </div>
      ) : (
        <div className="pl-list">
          {items.map((it, i) => {
            const b = it.libraryItem
            const m = b.media.metadata
            const hours = b.media.duration
              ? Math.round(b.media.duration / 360) / 10
              : 0
            return (
              <div
                className="pl-row"
                key={it.libraryItemId}
                data-cv={tintFor(m.title ?? 'Untitled')}
                onClick={() => navigate(`/book/${it.libraryItemId}`)}
              >
                <span className="pl-idx">{i + 1}</span>
                <Cover
                  itemId={it.libraryItemId}
                  title={m.title ?? 'Untitled'}
                  fs={5}
                />
                <div style={{ minWidth: 0 }}>
                  <div className="ll-title">{m.title}</div>
                  <div className="ll-sub">
                    {[m.authorName, m.narratorName].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span
                  className="ll-col mono"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {hours}h
                </span>
                <button
                  className="ll-play"
                  onClick={(e) => {
                    e.stopPropagation()
                    void playItem(it.libraryItemId)
                  }}
                  aria-label="Play"
                >
                  <Icon name="play_arrow" fill />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function PlaylistDetailPage() {
  const { playlistId } = useParams()
  const location = useLocation()
  const passed = (location.state as { playlist?: ABSPlaylist } | null)?.playlist

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['playlist', playlistId],
    queryFn: () => getPlaylist(playlistId as string),
    enabled: Boolean(playlistId) && !passed,
    staleTime: 5 * 60 * 1000,
  })

  if (passed) return <PlaylistDetail playlist={passed} />
  if (isLoading) {
    return (
      <div className="page">
        <LoadingSpinner className="py-12" label="Loading playlist..." />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="page">
        <ErrorState message="Could not load this playlist." onRetry={refetch} />
      </div>
    )
  }
  return <PlaylistDetail playlist={data} />
}
