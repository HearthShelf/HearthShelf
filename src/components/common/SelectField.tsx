import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/components/common/Icon'

export interface SelectOption {
  value: string
  label: ReactNode
  /** Plain-text form of `label`, for the collapsed trigger and type-ahead when
   *  the label is rich. Falls back to `label` when it is already a string. */
  text?: string
  disabled?: boolean
}

export interface SelectGroup {
  label: string
  options: SelectOption[]
}

interface SelectFieldProps {
  value: string
  onChange: (value: string) => void
  options?: SelectOption[]
  groups?: SelectGroup[]
  /** Shown when `value` matches no option. Renders as a real, selectable row
   *  only if it is also present in `options` - this is just the empty label. */
  placeholder?: string
  disabled?: boolean
  id?: string
  /** Extra classes on the trigger, alongside the default `.fld` box. */
  className?: string
  /** Replaces `.fld` entirely, for triggers with their own shape (a pill, a
   *  compact toolbar control). The popover styling is unaffected. */
  triggerClassName?: string
  style?: React.CSSProperties
  'aria-label'?: string
}

function optionText(option: SelectOption): string {
  if (option.text !== undefined) return option.text
  return typeof option.label === 'string' ? option.label : ''
}

// A select that keeps the app's own skin all the way down. A native <select>
// renders its list with the OS, so the popup ignores every token in design.css
// and reads as a foreign white menu in a dark UI. This keeps the .fld trigger
// look and draws the list with the same menu-pop / mp-item styling the toolbar
// dropdowns use.
//
// Keyboard behaviour matches a native select closely enough to be unsurprising:
// Up/Down move the highlight, Home/End jump, Enter/Space commit, Escape closes,
// and typing letters jumps to the next matching option.
export function SelectField({
  value,
  onChange,
  options,
  groups,
  placeholder = 'Select…',
  disabled,
  id,
  className,
  triggerClassName,
  style,
  'aria-label': ariaLabel,
}: SelectFieldProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ buffer: '', at: 0 })
  const listId = useId()

  const flat: SelectOption[] = groups ? groups.flatMap((group) => group.options) : (options ?? [])
  const selected = flat.find((option) => option.value === value)
  const selectable = (index: number) => !!flat[index] && !flat[index].disabled

  // Close on outside click or on any scroll that would leave the popover
  // stranded away from its trigger.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // Opening focuses the current value so Up/Down continues from there.
  useEffect(() => {
    if (!open) return
    const index = flat.findIndex((option) => option.value === value)
    setActive(index >= 0 ? index : flat.findIndex((_, i) => selectable(i)))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || active < 0) return
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const commit = (index: number) => {
    const option = flat[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  const step = (from: number, delta: number) => {
    let next = from
    for (let guard = 0; guard < flat.length; guard++) {
      next += delta
      if (next < 0 || next >= flat.length) return from
      if (selectable(next)) return next
    }
    return from
  }

  const edge = (fromEnd: boolean) => {
    const order = flat.map((_, index) => index)
    if (fromEnd) order.reverse()
    return order.find(selectable) ?? -1
  }

  const jumpToTyped = (key: string) => {
    const now = Date.now()
    const buffer = now - typeahead.current.at > 800 ? key : typeahead.current.buffer + key
    typeahead.current = { buffer, at: now }
    const match = flat.findIndex(
      (option, index) =>
        selectable(index) && optionText(option).toLowerCase().startsWith(buffer.toLowerCase()),
    )
    if (match < 0) return
    if (open) setActive(match)
    else commit(match)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        setOpen(false)
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setActive((current) => step(current, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open) return
      event.preventDefault()
      setActive(edge(event.key === 'End'))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) setOpen(true)
      else commit(active)
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      jumpToTyped(event.key)
    }
  }

  let cursor = -1

  return (
    <div className="menu-wrap sel-wrap" ref={wrapRef} style={style}>
      <button
        type="button"
        id={id}
        className={
          (triggerClassName ?? 'fld') +
          ' sel-trigger' +
          (open ? ' on' : '') +
          (className ? ' ' + className : '')
        }
        onClick={() => !disabled && setOpen((wasOpen) => !wasOpen)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
      >
        <span className={'sel-value' + (selected ? '' : ' is-placeholder')}>
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="expand_more" className="sel-caret" />
      </button>
      {open && (
        <div className="menu-pop left sel-pop" id={listId} role="listbox" ref={listRef}>
          {(groups ?? [{ label: '', options: options ?? [] }]).map((group, groupIndex) => (
            <div key={group.label || groupIndex}>
              {group.label && <div className="mp-label">{group.label}</div>}
              {group.options.map((option) => {
                cursor++
                const index = cursor
                return (
                  <button
                    type="button"
                    key={option.value}
                    data-index={index}
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    className={
                      'mp-item' +
                      (option.value === value ? ' on' : '') +
                      (index === active ? ' active' : '')
                    }
                    onMouseEnter={() => setActive(index)}
                    onClick={() => commit(index)}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
