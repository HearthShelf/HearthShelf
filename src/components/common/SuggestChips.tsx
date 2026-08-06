import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/components/common/Icon'

interface SuggestChipsProps {
  items: string[]
  onChange: (items: string[]) => void
  // Existing values elsewhere in the library, offered as you type so you pick
  // the established spelling instead of creating a near-duplicate.
  suggestions?: string[]
  placeholder?: string
}

const MAX_SUGGESTIONS = 8

// Chips input with type-ahead against the library's existing values. Free entry
// is still allowed - a suggestion is a shortcut, never a restriction.
export function SuggestChips({
  items,
  onChange,
  suggestions = [],
  placeholder = 'Add…',
}: SuggestChipsProps) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  // Suppress the blur-commit when a click lands on a suggestion.
  const picking = useRef(false)

  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase()
    if (!q) return []
    const taken = new Set(items.map((i) => i.toLowerCase()))
    return suggestions
      .filter((s) => s.toLowerCase().includes(q) && !taken.has(s.toLowerCase()))
      .slice(0, MAX_SUGGESTIONS)
  }, [draft, suggestions, items])

  const add = (value?: string) => {
    const v = (value ?? draft).trim().replace(/,$/, '').trim()
    // Case-insensitive dedupe: ABS matches names case-insensitively, so adding
    // both "Sci-Fi" and "sci-fi" would collapse server-side anyway.
    if (v && !items.some((i) => i.toLowerCase() === v.toLowerCase())) onChange([...items, v])
    setDraft('')
    setOpen(false)
    setActive(0)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && matches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' && matches[active]) {
        e.preventDefault()
        add(matches[active])
        return
      }
    }
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add()
    } else if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Backspace' && !draft && items.length) {
      onChange(items.slice(0, -1))
    }
  }

  return (
    <div className="suggest-wrap">
      <div className="chip-input">
        {items.map((it) => (
          <span className="tag-pill" key={it}>
            {it}
            <button onClick={() => onChange(items.filter((x) => x !== it))}>
              <Icon name="close" style={{ fontSize: 14 }} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onKeyDown={onKey}
          onBlur={() => {
            if (picking.current) return
            setOpen(false)
            add()
          }}
          placeholder={items.length ? '' : placeholder}
        />
      </div>
      {open && matches.length > 0 && (
        <div className="suggest-list">
          {matches.map((s, i) => (
            <button
              key={s}
              className={'suggest-item' + (i === active ? ' on' : '')}
              onMouseDown={() => {
                picking.current = true
              }}
              onClick={() => {
                add(s)
                picking.current = false
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
