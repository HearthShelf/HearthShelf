import { useState, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { ABSLibraryItem, ABSSeriesResponse } from '@/api/types'
import { Icon } from '@/components/common/Icon'
import { AddToListModal } from '@/components/library/AddToListModal'
import { usePlayer } from '@/hooks/usePlayer'
import { useMarkFinished } from '@/hooks/useMarkFinished'
import { useQueueStore } from '@/store/queueStore'
import { useAuthStore } from '@/store/authStore'

interface Pos { x: number; y: number }

interface BookContextMenuProps {
  item: ABSLibraryItem
  progress?: number
  finished?: boolean
  authorId?: string
  seriesId?: string
  seriesName?: string
  onToast?: (msg: string) => void
  children: ReactNode
}

// Wraps any book card child. Right-clicking opens a positioned context menu
// with all book actions: detail, play/read, queue, collection, playlist,
// mark finished, and (for admins) edit.
export function BookContextMenu({
  item,
  progress = 0,
  finished,
  authorId,
  seriesId,
  seriesName,
  onToast,
  children,
}: BookContextMenuProps) {
  const [pos, setPos] = useState<Pos | null>(null)
  const [modalTab, setModalTab] = useState<'collection' | 'playlist' | null>(null)
  const [showEdit, setShowEdit] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const onSeriesPage = pathname.startsWith('/series/')
  const qc = useQueryClient()

  // Resolve series ID from TanStack Query cache when not explicitly provided.
  // Uses the cached series list (populated when user visits Library → Series tab)
  // so this is zero-cost and silent when the cache is cold.
  const resolvedSeriesId = seriesId ?? (() => {
    const sn = item.media.metadata.seriesName
    if (!sn || !item.libraryId) return undefined
    const cached = qc.getQueryData<ABSSeriesResponse>(['series', item.libraryId])
    return cached?.results.find((s) => s.name === sn)?.id
  })()
  const { playItem } = usePlayer()
  const { markFinished } = useMarkFinished()
  const addToQueue = useQueueStore((s) => s.add)
  const user = useAuthStore((s) => s.user)

  const { title, authorName } = item.media.metadata
  const hasEbook = !!item.media.ebookFormat
  const hasAudio = item.media.numAudioFiles > 0
  const isAdmin = user?.type === 'admin' || user?.type === 'root'

  const open = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPos({ x: e.clientX, y: e.clientY })
  }

  const close = () => setPos(null)

  // Clamp menu to viewport and close on click-away / Escape
  useEffect(() => {
    if (!pos) return

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }

    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [pos])

  // Clamp to viewport after render so we know the menu dimensions
  useEffect(() => {
    if (!pos || !menuRef.current) return
    const { width, height } = menuRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nx = Math.min(pos.x, vw - width - 8)
    const ny = Math.min(pos.y, vh - height - 8)
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny })
  }, [pos])

  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    close()
    fn()
  }

  const menu = pos && (
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="ctx-header">
        <span className="ctx-title">{title ?? 'Untitled'}</span>
        {authorName && <span className="ctx-author">{authorName}</span>}
      </div>
      <div className="ctx-divider" />

      <button className="mp-item" onClick={act(() => navigate(`/book/${item.id}`))}>
        <Icon name="info" /> View details
      </button>

      {hasAudio && (
        <button className="mp-item" onClick={act(() => void playItem(item.id))}>
          <Icon name="play_arrow" fill /> Play
        </button>
      )}

      {hasEbook && (
        <button className="mp-item" onClick={act(() => navigate(`/reader/${item.id}`))}>
          <Icon name="menu_book" fill /> Read
        </button>
      )}

      <div className="ctx-divider" />

      <button
        className="mp-item"
        onClick={act(() => {
          addToQueue({ libraryItemId: item.id, title: title ?? 'Untitled', author: authorName })
          onToast?.(`Added "${title}" to queue`)
        })}
      >
        <Icon name="reorder" /> Add to queue
      </button>

      <button
        className="mp-item"
        disabled={!item.libraryId}
        onClick={act(() => setModalTab('collection'))}
      >
        <Icon name="folder_special" /> Add to collection
      </button>

      <button
        className="mp-item"
        disabled={!item.libraryId}
        onClick={act(() => setModalTab('playlist'))}
      >
        <Icon name="queue_music" /> Add to playlist
      </button>

      <div className="ctx-divider" />

      <button
        className={'mp-item' + (finished ? ' on' : '')}
        onClick={act(() => void markFinished([item.id], !finished))}
      >
        <Icon name="check_circle" fill={finished} />
        {finished ? 'Mark as unfinished' : 'Mark as finished'}
      </button>

      {progress > 0 && !finished && (
        <button
          className="mp-item"
          onClick={act(() => void markFinished([item.id], false))}
        >
          <Icon name="replay" /> Reset progress
        </button>
      )}

      {(authorId || (resolvedSeriesId && !onSeriesPage)) && (
        <>
          <div className="ctx-divider" />
          {resolvedSeriesId && !onSeriesPage && (
            <button className="mp-item" onClick={act(() => navigate(`/series/${resolvedSeriesId}`))}>
              <Icon name="collections_bookmark" /> Go to series
              {(seriesName ?? item.media.metadata.seriesName) && (
                <span className="mp-tail">{seriesName ?? item.media.metadata.seriesName}</span>
              )}
            </button>
          )}
          {authorId && (
            <button className="mp-item" onClick={act(() => navigate(`/author/${authorId}`))}>
              <Icon name="person" /> Go to author
            </button>
          )}
        </>
      )}

      {isAdmin && (
        <>
          <div className="ctx-divider" />
          <button className="mp-item" onClick={act(() => setShowEdit(true))}>
            <Icon name="edit" /> Edit metadata
          </button>
        </>
      )}
    </div>
  )

  return (
    <div onContextMenu={open} style={{ display: 'contents' }}>
      {children}
      {menu && createPortal(menu, document.body)}
      {modalTab && item.libraryId && (
        <AddToListModal
          libraryItemId={item.id}
          libraryId={item.libraryId}
          initialTab={modalTab}
          onClose={() => setModalTab(null)}
          onToast={onToast}
        />
      )}
      {showEdit && <EditModalLoader itemId={item.id} onClose={() => setShowEdit(false)} />}
    </div>
  )
}

// Fetches the full item detail then renders ItemEditModal. Keeps the tile bundle
// lean by dynamically importing the modal only when actually opened.
function EditModalLoader({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const [ready, setReady] = useState<{
    Comp: React.ComponentType<{ item: import('@/api/types').ABSLibraryItemDetail; onClose: () => void }>
    item: import('@/api/types').ABSLibraryItemDetail
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      import('@/components/library/ItemEditModal'),
      import('@/api/libraries').then((lib) => lib.getItem(itemId)),
    ]).then(([mod, item]) => {
      if (!cancelled) setReady({ Comp: mod.ItemEditModal, item })
    })
    return () => { cancelled = true }
  }, [itemId])

  if (!ready) return null
  return <ready.Comp item={ready.item} onClose={onClose} />
}
