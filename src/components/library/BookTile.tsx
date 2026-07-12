import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ABSLibraryItem } from '@/api/types'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { AddToListMenu } from '@/components/library/AddToListMenu'
import { BookContextMenu } from '@/components/library/BookContextMenu'
import { usePlayer } from '@/hooks/usePlayer'
import { useMarkFinished } from '@/hooks/useMarkFinished'
import { useIsMobile } from '@/hooks/useMediaQuery'

interface BookTileProps {
  item: ABSLibraryItem
  fs?: number
  progress?: number
  finished?: boolean
  compact?: boolean
  selected?: boolean
  anySelected?: boolean
  onToggleSelect?: () => void
  // When the parent can resolve the author to an ID, the name becomes a link
  // to the author page. Falls back to plain text otherwise.
  authorId?: string
  // Continue-* shelf context, forwarded to the context menu so it can offer the
  // hide/reset actions. Pass `series` on a Continue-Series tile so "Hide this
  // series" targets the right series id (the tile shows the next book).
  source?: 'series' | 'listening' | 'browse'
  seriesId?: string
  seriesName?: string
  // Surface a confirmation toast (e.g. after adding to the queue).
  onToast?: (msg: string) => void
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
  authorId,
  source,
  seriesId,
  seriesName,
  onToast,
}: BookTileProps) {
  const navigate = useNavigate()
  const { playItem } = usePlayer()
  const { markFinished } = useMarkFinished()
  const [menuOpen, setMenuOpen] = useState(false)
  // Touch UIs can't hover, so the reveal-on-hover action buttons are dropped -
  // tapping the tile opens the book detail page instead.
  const isMobile = useIsMobile()
  const { title, authorName } = item.media.metadata
  const hasEbook = !!item.media.ebookFormat
  const ebookOnly = hasEbook && item.media.numAudioFiles === 0
  const open = () => navigate(`/book/${item.id}`)
  const read = () => navigate(`/reader/${item.id}`)
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
    <BookContextMenu
      item={item}
      progress={progress}
      finished={finished}
      authorId={authorId}
      source={source}
      seriesId={seriesId}
      seriesName={seriesName}
      onToast={onToast}
    >
      <div
        className={'book fade-in' + (compact ? ' compact' : '') + (selected ? ' sel' : '')}
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
              {hasEbook && !anySelected && (
                <button
                  className={'cv-fmt' + (ebookOnly ? ' solo' : '')}
                  title={ebookOnly ? 'Read - ebook' : 'Audiobook + ebook'}
                  onClick={stop(ebookOnly ? read : open)}
                >
                  <Icon name={ebookOnly ? 'menu_book' : 'auto_stories'} fill />
                  {ebookOnly ? 'Read' : null}
                </button>
              )}
              {onToggleSelect && (
                <button
                  className={'b-check' + (selected ? ' on' : '')}
                  onClick={stop(onToggleSelect)}
                  title={selected ? 'Deselect' : 'Select'}
                >
                  <Icon name="check" fill style={{ opacity: selected ? 1 : 0 }} />
                </button>
              )}
              {!anySelected && !isMobile && (
                <div className={'hover-actions' + (menuOpen ? ' menu-open' : '')}>
                  <AddToListMenu
                    libraryItemId={item.id}
                    libraryId={item.libraryId}
                    title={title ?? 'Untitled'}
                    author={authorName}
                    onToast={onToast}
                    align="left"
                    onOpenChange={setMenuOpen}
                    trigger={(toggle) => (
                      <button className="ha-btn" title="Add to list" onClick={stop(toggle)}>
                        <Icon name="playlist_add" />
                      </button>
                    )}
                  />
                  <button
                    className="ha-play"
                    title={ebookOnly ? 'Read' : 'Play'}
                    onClick={stop(() => (ebookOnly ? read() : void playItem(item.id)))}
                  >
                    <Icon name={ebookOnly ? 'menu_book' : 'play_arrow'} fill />
                  </button>
                  <button
                    className="ha-btn"
                    title={finished ? 'Mark not finished' : 'Mark finished'}
                    onClick={stop(() => void markFinished([item.id], !finished))}
                  >
                    <Icon name="check" fill={finished} />
                  </button>
                </div>
              )}
            </>
          }
        />
        <div className="b-meta">
          <div className="b-title">{title ?? 'Untitled'}</div>
          {authorId ? (
            <div
              className="b-author b-author-link"
              onClick={stop(() => navigate(`/author/${authorId}`))}
            >
              {authorName || 'Unknown author'}
            </div>
          ) : (
            <div className="b-author">{authorName || 'Unknown author'}</div>
          )}
          {progress > 0 && !finished && (
            <div className="b-prog">
              <i style={{ width: Math.min(100, progress * 100) + '%' }} />
            </div>
          )}
        </div>
      </div>
    </BookContextMenu>
  )
}
