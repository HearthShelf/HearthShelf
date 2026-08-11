import { useState } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getPlaylist, updatePlaylist, addBooksToPlaylist, libraryKeys } from '@/api/libraries'
import { BookPickerModal } from '@/components/library/BookPickerModal'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { usePlayer } from '@/hooks/usePlayer'
import { formatDuration } from '@/lib/format'
import { resolvePlaylistEntry } from '@hearthshelf/core'
import type { ABSPlaylist } from '@/api/types'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { RenameModal } from '@/components/common/RenameModal'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

function PlaylistDetail({ playlist }: { playlist: ABSPlaylist }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { activeId } = useActiveLibrary()
  const { playItem } = usePlayer()
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const items = playlist.items ?? []

  const onSaveEdit = async (patch: { name: string; description?: string }) => {
    await updatePlaylist(playlist.id, patch)
    qc.invalidateQueries({ queryKey: ['playlist', playlist.id] })
    if (activeId) qc.invalidateQueries({ queryKey: libraryKeys.playlists(activeId) })
  }
  // Resolve each entry before anything reads it. ABS emits two shapes and only
  // an episode entry carries `episode`; reading a row off `libraryItem`
  // regardless is what made every episode display its podcast.
  const rows = items.map(resolvePlaylistEntry)
  const totalH = rows.reduce((s, r) => s + r.seconds, 0)
  const cv = tintFor(rows[0]?.title ?? playlist.name)
  const firstBook = rows.find((r) => !r.isEpisode)

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
          {items.length} {items.length === 1 ? 'item' : 'items'} · {formatDuration(totalH)}
        </span>
        <div className="tb-spacer" />
        {/* Play starts the first BOOK - playback addresses a library item, so
            leading with an episode would start its whole podcast instead. */}
        {firstBook && (
          <button
            className="btn btn-primary"
            onClick={() => void playItem(firstBook.libraryItemId)}
          >
            <Icon name="play_arrow" fill /> Play
          </button>
        )}
        <button className="pill" onClick={() => setAdding(true)}>
          <Icon name="library_add" /> Add books
        </button>
        <button className="pill" onClick={() => setEditing(true)}>
          <Icon name="edit" /> Edit
        </button>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <Icon name="queue_music" />
          <h3>This playlist is empty</h3>
          <button
            className="btn-sm btn-ghost"
            style={{ margin: '0 auto' }}
            onClick={() => setAdding(true)}
          >
            <Icon name="library_add" /> Add books
          </button>
        </div>
      ) : (
        <div className="pl-list">
          {rows.map((r, i) => {
            const hours = r.seconds ? Math.round(r.seconds / 360) / 10 : 0
            return (
              <div
                className="pl-row"
                key={(r.episodeId ?? r.libraryItemId) + ':' + i}
                data-cv={tintFor(r.title)}
                // No episode route exists yet, so an episode row opens its
                // containing podcast - the honest destination available today.
                onClick={() => navigate(`/book/${r.libraryItemId}`)}
              >
                <Cover itemId={r.libraryItemId} title={r.title} fs={5} />
                <div style={{ minWidth: 0 }}>
                  <div className="ll-title">{r.title}</div>
                  <div className="ll-sub">
                    {r.isEpisode ? 'Episode · ' : ''}
                    {r.source}
                  </div>
                </div>
                <span className="ll-col mono" style={{ fontFamily: 'var(--font-mono)' }}>
                  {hours}h
                </span>
                {/* Playback addresses a library item, so a single episode has no
                    play control until podcast playback exists. */}
                {r.isEpisode ? (
                  <span className="ll-play" aria-hidden />
                ) : (
                  <button
                    className="ll-play"
                    onClick={(e) => {
                      e.stopPropagation()
                      void playItem(r.libraryItemId)
                    }}
                    aria-label="Play"
                  >
                    <Icon name="play_arrow" fill />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {adding && activeId && (
        <BookPickerModal
          kind="playlist"
          libraryId={activeId}
          mode="add"
          listName={playlist.name}
          existingIds={rows.map((r) => r.libraryItemId)}
          onSubmit={async (ids) => {
            await addBooksToPlaylist(playlist.id, ids)
            qc.invalidateQueries({ queryKey: ['playlist', playlist.id] })
            qc.invalidateQueries({ queryKey: libraryKeys.playlists(activeId) })
          }}
          onClose={() => setAdding(false)}
        />
      )}

      {editing && (
        <RenameModal
          title="Edit playlist"
          initialName={playlist.name}
          initialDescription={playlist.description ?? ''}
          onSave={onSaveEdit}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

export function PlaylistDetailPage() {
  const { playlistId } = useParams()
  const location = useLocation()
  const passed = (location.state as { playlist?: ABSPlaylist } | null)?.playlist

  // Router state seeds the query rather than replacing it - see the note in
  // CollectionDetailPage: a passed copy that skips the query would keep showing
  // the pre-edit item list after adding books.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['playlist', playlistId],
    queryFn: () => getPlaylist(playlistId as string),
    enabled: Boolean(playlistId),
    initialData: passed,
    staleTime: 5 * 60 * 1000,
  })

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
