import { useState, useEffect, type ReactNode } from 'react'
import { Icon } from '@/components/common/Icon'
import { AddToListModal } from '@/components/library/AddToListModal'
import { useQueueStore } from '@/store/queueStore'

interface AddToListMenuProps {
  libraryItemId: string
  // The book's library, needed to open the collection/playlist picker. When
  // unknown (null), those two rows are disabled and only Queue is offered.
  libraryId: string | null
  title: string
  author: string
  onToast?: (msg: string) => void
  // The clickable trigger. Receives the open() handler + open state so callers
  // can style their own button (tile hover action, pill, etc.).
  trigger: (open: () => void, isOpen: boolean) => ReactNode
  align?: 'left' | 'right'
  // Notified when the popover opens/closes (e.g. so a tile can stay hovered).
  onOpenChange?: (open: boolean) => void
}

// Unified "Add to list" control used everywhere a book can be filed away. Opens
// a small popover with three choices: Queue (instant), Collection, Playlist.
// Collection/Playlist hand off to the existing AddToListModal on the right tab.
export function AddToListMenu({
  libraryItemId,
  libraryId,
  title,
  author,
  onToast,
  trigger,
  align = 'right',
  onOpenChange,
}: AddToListMenuProps) {
  const [open, setOpen] = useState(false)
  const [modalTab, setModalTab] = useState<'collection' | 'playlist' | null>(
    null
  )
  const addToQueue = useQueueStore((s) => s.add)

  const setOpenNotify = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    if (!open) return
    const close = () => setOpenNotify(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const queue = () => {
    addToQueue({ libraryItemId, title, author })
    onToast?.(`Added "${title}" to queue`)
  }

  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      {trigger(() => setOpenNotify(!open), open)}
      {open && (
        <div
          className={'menu-pop' + (align === 'left' ? ' left' : '')}
          onClick={() => setOpenNotify(false)}
        >
          <button className="mp-item" onClick={queue}>
            <Icon name="reorder" /> Queue
          </button>
          <button
            className="mp-item"
            disabled={!libraryId}
            onClick={() => setModalTab('collection')}
          >
            <Icon name="folder_special" /> Collection
          </button>
          <button
            className="mp-item"
            disabled={!libraryId}
            onClick={() => setModalTab('playlist')}
          >
            <Icon name="queue_music" /> Playlist
          </button>
        </div>
      )}
      {modalTab && libraryId && (
        <AddToListModal
          libraryItemId={libraryItemId}
          libraryId={libraryId}
          initialTab={modalTab}
          onClose={() => setModalTab(null)}
          onToast={onToast}
        />
      )}
    </div>
  )
}
