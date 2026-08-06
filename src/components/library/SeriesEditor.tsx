import { useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/common/Icon'
import type { ItemSeriesPatch } from '@/api/libraries'

interface SeriesEditorProps {
  series: ItemSeriesPatch[]
  onChange: (series: ItemSeriesPatch[]) => void
  // Series names already in this library, for type-ahead.
  suggestions?: string[]
}

const MAX_SUGGESTIONS = 8

// Edit a book's series memberships: a name plus its position in that series.
//
// A book can belong to several series (an omnibus, a crossover), so this is a
// list. ABS REPLACES the whole set on save - any series missing from this list
// is unlinked from the book - so the list always shows the complete truth.
//
// Sequence is a free-text string, not a number: ABS stores "2.5" for novellas
// and "" for unnumbered entries, and sending a real number wipes the value.
export function SeriesEditor({ series, onChange, suggestions = [] }: SeriesEditorProps) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const picking = useRef(false)

  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase()
    if (!q) return []
    const taken = new Set(series.map((s) => s.name.toLowerCase()))
    return suggestions
      .filter((s) => s.toLowerCase().includes(q) && !taken.has(s.toLowerCase()))
      .slice(0, MAX_SUGGESTIONS)
  }, [draft, suggestions, series])

  const addSeries = (name?: string) => {
    const v = (name ?? draft).trim()
    if (v && !series.some((s) => s.name.toLowerCase() === v.toLowerCase())) {
      onChange([...series, { name: v, sequence: null }])
    }
    setDraft('')
    setOpen(false)
  }

  const setAt = (i: number, patch: Partial<ItemSeriesPatch>) => {
    onChange(series.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }

  return (
    <div className="series-editor">
      {series.map((s, i) => (
        <div className="series-row" key={`${s.name}-${i}`}>
          <input
            className="fld"
            value={s.name}
            onChange={(e) => setAt(i, { name: e.target.value })}
            placeholder="Series name"
            aria-label="Series name"
          />
          <input
            className="fld se-seq"
            value={s.sequence ?? ''}
            onChange={(e) => setAt(i, { sequence: e.target.value || null })}
            placeholder="#"
            aria-label={`Position in ${s.name || 'series'}`}
          />
          <button
            className="btn-sm btn-ghost"
            onClick={() => onChange(series.filter((_, idx) => idx !== i))}
            aria-label={`Remove from ${s.name || 'series'}`}
          >
            <Icon name="close" style={{ fontSize: 16 }} />
          </button>
        </div>
      ))}

      <div className="suggest-wrap">
        <div className="series-row">
          <input
            className="fld"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addSeries()
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            onBlur={() => {
              if (picking.current) return
              setOpen(false)
              addSeries()
            }}
            placeholder={series.length ? 'Add another series…' : 'Add to a series…'}
            aria-label="Add series"
          />
        </div>
        {open && matches.length > 0 && (
          <div className="suggest-list">
            {matches.map((s) => (
              <button
                key={s}
                className="suggest-item"
                onMouseDown={() => {
                  picking.current = true
                }}
                onClick={() => {
                  addSeries(s)
                  picking.current = false
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
      {series.length > 0 && (
        <p className="se-hint">
          Leave the # blank for an unnumbered entry. Removing a series here takes this book out of
          it.
        </p>
      )}
    </div>
  )
}
