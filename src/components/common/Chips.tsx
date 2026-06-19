import { useState, type KeyboardEvent } from 'react'
import { Icon } from '@/components/common/Icon'

interface ChipsProps {
  items: string[]
  onChange: (items: string[]) => void
  placeholder?: string
}

// Editable tag input: type + Enter (or comma) to add, click x to remove.
export function Chips({ items, onChange, placeholder = 'Add…' }: ChipsProps) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim().replace(/,$/, '').trim()
    if (v && !items.includes(v)) onChange([...items, v])
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add()
    } else if (e.key === 'Backspace' && !draft && items.length) {
      onChange(items.slice(0, -1))
    }
  }

  return (
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
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        placeholder={items.length ? '' : placeholder}
      />
    </div>
  )
}
