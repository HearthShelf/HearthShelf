import { useNavigate } from 'react-router-dom'
import type { ABSLibraryItem } from '@/api/types'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { usePlayer } from '@/hooks/usePlayer'

interface BookTileProps {
  item: ABSLibraryItem
  fs?: number
  progress?: number
  finished?: boolean
  compact?: boolean
  selected?: boolean
  anySelected?: boolean
  onToggleSelect?: () => void
}

// Library/shelf tile: cover with hover-reveal actions, title, author, and a
// progress bar when the book is in progress. Supports compact sizing and a
// multi-select checkbox.
export function BookTile({
  item,
  fs = 15,
  progress = 0,
  finished,
  compact,
  selected,
  anySelected,
  onToggleSelect,
}: BookTileProps) {
  const navigate = useNavigate()
  const { playItem } = usePlayer()
  const { title, authorName } = item.media.metadata
  const open = () => navigate(`/book/${item.id}`)
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }

  // In selection mode the whole tile toggles selection instead of opening.
  const onClick = () => {
    if (anySelected && onToggleSelect) onToggleSelect()
    else open()
  }

  return (
    <div
      className={
        'book fade-in' + (compact ? ' compact' : '') + (selected ? ' sel' : '')
      }
      data-cv={tintFor(title ?? 'Untitled')}
      onClick={onClick}
    >
      <Cover
        itemId={item.id}
        title={title ?? 'Untitled'}
        author={authorName || undefined}
        fs={fs}
        finished={finished}
        overlay={
          <>
            {onToggleSelect && (
              <button
                className={'b-check' + (selected ? ' on' : '')}
                onClick={stop(onToggleSelect)}
                title={selected ? 'Deselect' : 'Select'}
              >
                <Icon name="check" fill style={{ opacity: selected ? 1 : 0 }} />
              </button>
            )}
            {!anySelected && (
              <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                <button className="ha-btn" title="Details" onClick={stop(open)}>
                  <Icon name="info" />
                </button>
                <button
                  className="ha-play"
                  title="Play"
                  onClick={stop(() => void playItem(item.id))}
                >
                  <Icon name="play_arrow" fill />
                </button>
                <button
                  className="ha-btn"
                  title="Add to list"
                  onClick={stop(() => {})}
                >
                  <Icon name="playlist_add" />
                </button>
              </div>
            )}
          </>
        }
      />
      <div className="b-meta">
        <div className="b-title">{title ?? 'Untitled'}</div>
        <div className="b-author">{authorName || 'Unknown author'}</div>
        {progress > 0 && !finished && (
          <div className="b-prog">
            <i style={{ width: Math.min(100, progress * 100) + '%' }} />
          </div>
        )}
      </div>
    </div>
  )
}
