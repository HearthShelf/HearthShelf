import { useState } from 'react'
import { useQueueStore } from '@/store/queueStore'
import { Cover } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'

// Shared editor for the durable hand-queued list, used by the player Up-next
// panel and the Queue settings page. In Auto mode it also shows the current
// Auto queue (read-only, grayed) above the editable manual list, so the user
// sees what Auto picked plus the hand-queued fallback they can reorder/remove.
//
// `onPlay` is optional: Settings has no player to jump to, so it omits it and
// the rows aren't click-to-play there.
//
// `showAutoPicks` controls the read-only Auto-picks preview (Auto mode only).
// Settings shows it (the point is to see what Auto queued); the player panel
// already lists the merged queue below, so it passes false to avoid a
// double-listing.
export function ManualQueueEditor({
  mode,
  onPlay,
  showAutoPicks = true,
}: {
  mode: 'manual' | 'auto'
  onPlay?: (id: string) => void
  showAutoPicks?: boolean
}) {
  const items = useQueueStore((s) => s.items)
  const manual = useQueueStore((s) => s.manual)
  const remove = useQueueStore((s) => s.remove)
  const reorder = useQueueStore((s) => s.reorder)
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  const sectionLabel = (text: string) => (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        padding: '4px 4px 6px',
      }}
    >
      {text}
    </div>
  )

  return (
    <div>
      {mode === 'auto' && showAutoPicks && (
        <div style={{ marginBottom: 12 }}>
          {sectionLabel('Auto picks')}
          {items.length === 0 ? (
            <div className="pop-empty" style={{ padding: '4px 4px 8px' }}>
              Auto hasn't picked anything yet.
            </div>
          ) : (
            items.map((q) => (
              <div className="queue-row" key={q.libraryItemId} style={{ opacity: 0.5 }}>
                <span className="q-handle" style={{ opacity: 0.4, cursor: 'default' }}>
                  <Icon name="auto_awesome" />
                </span>
                <Cover itemId={q.libraryItemId} title={q.title} fs={3} />
                <div className="q-meta">
                  <div className="q-t">{q.title}</div>
                  <div className="q-s">{q.author}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
      <div>
        {mode === 'auto' && sectionLabel('Books you queued by hand')}
        {manual.length === 0 ? (
          <div className="pop-empty" style={{ padding: '4px 4px 8px' }}>
            {mode === 'auto'
              ? 'Nothing queued by hand. Add books with "Add to list" - they play after your Auto picks.'
              : 'Nothing queued. Add books with "Add to list".'}
          </div>
        ) : (
          manual.map((q, i) => (
            <div
              className={'queue-row' + (dragIdx === i ? ' dragging' : '')}
              key={q.libraryItemId}
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIdx !== null && dragIdx !== i) reorder(dragIdx, i)
                setDragIdx(null)
              }}
              onDragEnd={() => setDragIdx(null)}
            >
              <span className="q-handle" title="Drag to reorder">
                <Icon name="drag_indicator" />
              </span>
              <Cover itemId={q.libraryItemId} title={q.title} fs={3} />
              <div
                className="q-meta"
                style={onPlay ? { cursor: 'pointer' } : undefined}
                onClick={onPlay ? () => onPlay(q.libraryItemId) : undefined}
              >
                <div className="q-t">{q.title}</div>
                <div className="q-s">{q.author}</div>
              </div>
              <span className="bm-x" title="Remove" onClick={() => remove(q.libraryItemId)}>
                <Icon name="close" />
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
