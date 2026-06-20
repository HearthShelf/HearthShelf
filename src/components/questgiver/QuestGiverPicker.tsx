import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/common/Icon'
import { Cover } from '@/components/common/Cover'
import type { QgBook } from '@/lib/questgiver'

interface QuestGiverPickerProps {
  books: QgBook[]
  picked: Set<string>
  onToggle: (id: string) => void
}

// How many unselected covers to show in the grid when not searching.
const GRID_LIMIT = 18

// QuestGiver "A list I pick" selector. Unselected books live in a searchable
// grid; picking one flies it down into the selected list below (and vice
// versa) with a FLIP animation so the move reads as the same cover relocating.
export function QuestGiverPicker({ books, picked, onToggle }: QuestGiverPickerProps) {
  const [query, setQuery] = useState('')

  const byId = useMemo(() => new Map(books.map((b) => [b.id, b])), [books])

  // Selected books, in pick order is fine - we keep insertion order via the Set.
  const selected = useMemo(
    () => [...picked].map((id) => byId.get(id)).filter((b): b is QgBook => !!b),
    [picked, byId],
  )

  const q = query.trim().toLowerCase()
  const grid = useMemo(() => {
    const unpicked = books.filter((b) => !picked.has(b.id))
    const matched = q
      ? unpicked.filter(
          (b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q),
        )
      : unpicked
    return q ? matched.slice(0, 24) : matched.slice(0, GRID_LIMIT)
  }, [books, picked, q])

  // FLIP: remember each tile's screen rect by book id before a render, then
  // animate from the old position to the new one after it commits.
  const tileRefs = useRef(new Map<string, HTMLElement>())
  const prevRects = useRef(new Map<string, DOMRect>())

  const setTileRef = (id: string) => (el: HTMLElement | null) => {
    if (el) tileRefs.current.set(id, el)
    else tileRefs.current.delete(id)
  }

  // Capture positions synchronously before the DOM paints the new layout.
  const captureRects = () => {
    const map = new Map<string, DOMRect>()
    tileRefs.current.forEach((el, id) => map.set(id, el.getBoundingClientRect()))
    prevRects.current = map
  }

  useLayoutEffect(() => {
    const prev = prevRects.current
    if (!prev.size) return
    tileRefs.current.forEach((el, id) => {
      const before = prev.get(id)
      if (!before) return
      const after = el.getBoundingClientRect()
      const dx = before.left - after.left
      const dy = before.top - after.top
      const ds = before.width ? before.width / after.width : 1
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(ds - 1) < 0.01) return
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${ds})`, opacity: 0.85 },
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        ],
        { duration: 360, easing: 'cubic-bezier(.2, .8, .2, 1)' },
      )
    })
    prevRects.current = new Map()
  })

  const toggle = (id: string) => {
    captureRects()
    onToggle(id)
  }

  return (
    <div className="qg-pick">
      <div className="qg-pick-head">
        Pick a few books to match <span>{picked.size} selected</span>
      </div>

      <label className="qg-pick-search">
        <Icon name="search" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your library by title or author..."
        />
        {query && (
          <button type="button" className="qg-pick-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <Icon name="close" />
          </button>
        )}
      </label>

      {selected.length > 0 && (
        <div className="qg-pick-chosen">
          <div className="qg-pick-chosen-label">Matching the vibe of</div>
          <div className="qg-pick-row">
            {selected.map((b) => (
              <button
                key={b.id}
                ref={setTileRef(b.id)}
                type="button"
                className="qg-pick-item on chosen"
                onClick={() => toggle(b.id)}
                title={`${b.title} - tap to remove`}
              >
                <Cover itemId={b.id} title={b.title} author={b.author} fs={3} />
                <span className="qg-pick-remove">
                  <Icon name="close" />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {grid.length > 0 ? (
        <div className="qg-pick-grid">
          {grid.map((b) => (
            <button
              key={b.id}
              ref={setTileRef(b.id)}
              type="button"
              className="qg-pick-item"
              onClick={() => toggle(b.id)}
              title={b.title}
            >
              <Cover itemId={b.id} title={b.title} author={b.author} fs={4} />
              <span className="qg-pick-check">
                <Icon name="add_circle" fill />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="qg-pick-empty">
          {q ? `No books match "${query.trim()}".` : 'No more books to pick.'}
        </div>
      )}
    </div>
  )
}
