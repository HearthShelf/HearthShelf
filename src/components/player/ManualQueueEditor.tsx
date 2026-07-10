import { useState } from 'react'
import { useQueueStore } from '@/store/queueStore'
import { Cover } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'

// Shared editor for the up-next queue, used by the player Up-next panel and the
// Queue settings page. In Manual mode it's the durable hand-queued list. In Auto
// mode it's ONE merged list: rule-generated picks carry a lightning bolt (read-
// only), hand-added books keep their drag handle + remove inline where they sit,
// and dragging a hand-added book reorders the manual books among themselves.
//
// `onPlay` is optional: Settings has no player to jump to, so it omits it and
// the rows aren't click-to-play there.
export function ManualQueueEditor({
  mode,
  onPlay,
}: {
  mode: 'manual' | 'auto'
  onPlay?: (id: string) => void
}) {
  const items = useQueueStore((s) => s.items)
  const manual = useQueueStore((s) => s.manual)
  const remove = useQueueStore((s) => s.remove)
  const reorder = useQueueStore((s) => s.reorder)
  const setManual = useQueueStore((s) => s.setManual)
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  // In Auto mode the list shown is the merged queue; in Manual mode the hand
  // list. A row is hand-added iff its id is in `manual`.
  const list = mode === 'auto' ? items : manual
  const manualIds = new Set(manual.map((m) => m.libraryItemId))

  // A drop in the merged Auto list reorders only the hand-added rows among
  // themselves: apply the move to the merged order, then persist the manual
  // subsequence in its new order. Manual mode: a plain reorder of the whole list.
  const applyDrop = (from: number, to: number) => {
    if (mode !== 'auto') {
      reorder(from, to)
      return
    }
    const merged = items.slice()
    const [moved] = merged.splice(from, 1)
    merged.splice(to, 0, moved)
    setManual(merged.filter((e) => manualIds.has(e.libraryItemId)))
  }

  if (list.length === 0) {
    return (
      <div className="pop-empty" style={{ padding: '4px 4px 8px' }}>
        {mode === 'auto'
          ? 'Nothing queued yet. Books you add with "Add to list" show up here too.'
          : 'Nothing queued. Add books with "Add to list".'}
      </div>
    )
  }

  return (
    <div>
      {list.map((q, i) => {
        // In Auto mode only hand-added rows are draggable/removable; the rest are
        // rule-generated (bolt marker). Manual mode: the whole list is editable.
        const editable = mode === 'manual' || manualIds.has(q.libraryItemId)
        return (
          <div
            className={'queue-row' + (editable && dragIdx === i ? ' dragging' : '')}
            key={q.libraryItemId}
            draggable={editable}
            onDragStart={editable ? () => setDragIdx(i) : undefined}
            onDragOver={editable ? (e) => e.preventDefault() : undefined}
            onDrop={
              editable
                ? () => {
                    if (dragIdx !== null && dragIdx !== i) applyDrop(dragIdx, i)
                    setDragIdx(null)
                  }
                : undefined
            }
            onDragEnd={editable ? () => setDragIdx(null) : undefined}
          >
            {editable ? (
              <span className="q-handle" title="Drag to reorder">
                <Icon name="drag_indicator" />
              </span>
            ) : (
              <span
                className="q-handle"
                style={{ cursor: 'default', color: 'var(--accent)' }}
                title="Added automatically by your Auto rules"
              >
                <Icon name="bolt" />
              </span>
            )}
            <Cover itemId={q.libraryItemId} title={q.title} fs={3} />
            <div
              className="q-meta"
              style={onPlay ? { cursor: 'pointer' } : undefined}
              onClick={onPlay ? () => onPlay(q.libraryItemId) : undefined}
            >
              <div className="q-t">{q.title}</div>
              <div className="q-s">{q.author}</div>
            </div>
            {editable ? (
              <span className="bm-x" title="Remove" onClick={() => remove(q.libraryItemId)}>
                <Icon name="close" />
              </span>
            ) : (
              <span className="q-handle" style={{ cursor: 'default', visibility: 'hidden' }}>
                <Icon name="close" />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
