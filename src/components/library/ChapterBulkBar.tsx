import { useRef, useState } from 'react'
import {
  renumberChapters,
  shiftChapterNumbers,
  normalizeChapterNumbers,
  replaceInChapterTitles,
  countReplaceMatches,
  buildReplaceRegExp,
  minShiftDelta,
} from '@hearthshelf/core'
import { Icon } from '@/components/common/Icon'

type Mode = 'renumber' | 'shift' | 'replace'

interface ChapterBulkBarProps<T extends { title: string }> {
  rows: T[]
  selected: number[]
  onApply: (next: T[]) => void
}

// Bulk title edits for the chapter editor. Ripped books commonly number the
// front matter into the sequence (Intro 1, Forward 2, so Chapter 1 reads
// "Chapter 3"), which is dozens of hand edits to fix. Every operation here
// rewrites titles only and stages the result into the editor's rows, so the
// user previews the change before saving.
export function ChapterBulkBar<T extends { title: string }>({
  rows,
  selected,
  onApply,
}: ChapterBulkBarProps<T>) {
  const [mode, setMode] = useState<Mode>('renumber')
  const [pattern, setPattern] = useState('Chapter {n}')
  const [startAt, setStartAt] = useState('1')
  const [delta, setDelta] = useState('-1')
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [matchCase, setMatchCase] = useState(false)

  const patternRef = useRef<HTMLInputElement>(null)

  // The pattern tokens, named for what they put in the title rather than for
  // how they are written. Someone renaming a book should not have to learn a
  // syntax to use these, so they are clickable and self-describing.
  const tokens = [
    { insert: '{n}', label: 'Number', hint: 'Counts up: 1, 2, 3' },
    { insert: '{name}', label: 'Chapter name', hint: 'The name, without its old number' },
    { insert: '{n:2}', label: 'Number as 01', hint: 'Counts up padded: 01, 02, 03' },
  ]

  // Insert at the cursor rather than appending, so a token can be dropped into
  // the middle of a pattern the user has already typed.
  const insertToken = (text: string) => {
    const el = patternRef.current
    if (!el) {
      setPattern(pattern + text)
      return
    }
    const start = el.selectionStart ?? pattern.length
    const end = el.selectionEnd ?? pattern.length
    const next = pattern.slice(0, start) + text + pattern.slice(end)
    setPattern(next)
    // Restore focus and put the caret after what we just inserted.
    requestAnimationFrame(() => {
      el.focus()
      const caret = start + text.length
      el.setSelectionRange(caret, caret)
    })
  }

  const n = selected.length
  const none = n === 0

  const apply = () => {
    if (none) return
    if (mode === 'shift' && shiftTooFar) return
    if (mode === 'renumber') {
      onApply(renumberChapters(rows, selected, pattern, Number(startAt) || 0))
    } else if (mode === 'shift') {
      onApply(shiftChapterNumbers(rows, selected, Number(delta) || 0))
    } else {
      onApply(replaceInChapterTitles(rows, selected, find, replace, { regex: useRegex, matchCase }))
    }
  }

  const normalize = () => {
    if (none) return
    onApply(normalizeChapterNumbers(rows, selected, pattern))
  }

  // How far down this selection can shift before a chapter would fall below 1.
  const shiftFloor = minShiftDelta(rows, selected)
  const shiftTooFar = mode === 'shift' && shiftFloor !== null && (Number(delta) || 0) < shiftFloor

  const badRegex =
    mode === 'replace' && useRegex && find !== '' && !buildReplaceRegExp(find, { regex: true })
  const matches =
    mode === 'replace' && !badRegex
      ? countReplaceMatches(rows, selected, find, replace, { regex: useRegex, matchCase })
      : 0

  // What the first selected row will look like, so the effect is legible
  // before it is applied.
  const previewOf = (next: T[]) => {
    const i = selected[0]
    return i === undefined ? null : next[i]?.title
  }
  let preview: string | null = null
  if (!none && !badRegex) {
    if (mode === 'renumber')
      preview = previewOf(renumberChapters(rows, selected, pattern, Number(startAt) || 0))
    else if (mode === 'shift' && !shiftTooFar)
      preview = previewOf(shiftChapterNumbers(rows, selected, Number(delta) || 0))
    else if (find)
      preview = previewOf(
        replaceInChapterTitles(rows, selected, find, replace, { regex: useRegex, matchCase }),
      )
  }

  return (
    <div className="ch-bulk">
      <div className="ch-bulk-head">
        <div className="seg">
          <button className={mode === 'renumber' ? 'on' : ''} onClick={() => setMode('renumber')}>
            Number them 1, 2, 3
          </button>
          <button className={mode === 'shift' ? 'on' : ''} onClick={() => setMode('shift')}>
            Add or subtract
          </button>
          <button className={mode === 'replace' ? 'on' : ''} onClick={() => setMode('replace')}>
            Find &amp; replace
          </button>
        </div>
        <span className="ch-bulk-count">{none ? 'Select chapters below' : `${n} selected`}</span>
      </div>

      {mode === 'renumber' && (
        <>
          <div className="ch-bulk-row">
            <label className="ch-bulk-lbl">
              Title
              <input
                ref={patternRef}
                className="fld"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="Chapter {n}"
              />
            </label>
            <label className="ch-bulk-lbl" style={{ flex: '0 0 96px' }}>
              Start at
              <input
                className="fld"
                type="number"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
              />
            </label>
            <button
              className="btn-sm btn-ghost"
              disabled={none}
              title="Reuse the number each chapter already has, instead of counting up from Start at"
              onClick={normalize}
            >
              Keep each number
            </button>
            <button className="btn-sm btn-green" disabled={none} onClick={apply}>
              Apply
            </button>
          </div>
          <div className="ch-bulk-chips">
            <span className="ch-bulk-chips-lbl">Add:</span>
            {tokens.map((t) => (
              <button
                key={t.insert}
                type="button"
                className="ch-chip"
                title={t.hint}
                onClick={() => insertToken(t.insert)}
              >
                {t.label}
              </button>
            ))}
            <span className="ch-bulk-chips-hint">
              Click to add. Anything else you type stays as it is.
            </span>
          </div>
        </>
      )}

      {mode === 'shift' && (
        <div className="ch-bulk-row">
          <label className="ch-bulk-lbl" style={{ flex: '0 0 120px' }}>
            Change by
            <input
              className="fld"
              type="number"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
            />
          </label>
          <p className="ch-bulk-hint">
            Adds this to the number each chapter already has. Use a minus sign to count down, so
            -219 turns Chapter 220 into Chapter 1. Chapters with no number, like Intro, are left
            alone.
          </p>
          <button className="btn-sm btn-green" disabled={none || shiftTooFar} onClick={apply}>
            Apply
          </button>
        </div>
      )}

      {mode === 'replace' && (
        <div className="ch-bulk-row">
          <label className="ch-bulk-lbl">
            Find
            <input className="fld" value={find} onChange={(e) => setFind(e.target.value)} />
          </label>
          <label className="ch-bulk-lbl">
            Replace with
            <input className="fld" value={replace} onChange={(e) => setReplace(e.target.value)} />
          </label>
          <div className="ch-bulk-toggles">
            <label>
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(e) => setMatchCase(e.target.checked)}
              />
              Match case
            </label>
            <label>
              <input
                type="checkbox"
                checked={useRegex}
                onChange={(e) => setUseRegex(e.target.checked)}
              />
              Regex
            </label>
          </div>
          <button className="btn-sm btn-green" disabled={none || !find || badRegex} onClick={apply}>
            Apply
          </button>
        </div>
      )}

      <div className="ch-bulk-foot">
        {shiftTooFar ? (
          <span className="ch-bulk-warn">
            <Icon name="error" /> That would number a chapter below 1. The lowest you can go with
            these chapters selected is {shiftFloor}.
          </span>
        ) : badRegex ? (
          <span className="ch-bulk-warn">
            <Icon name="error" /> That search pattern isn&apos;t finished yet.
          </span>
        ) : mode === 'replace' && find ? (
          <span>
            {matches === 0 ? 'No chapters match.' : `${matches} of ${n} selected will change.`}
          </span>
        ) : preview ? (
          <span>
            First selected becomes <strong>{preview}</strong>
          </span>
        ) : null}
      </div>
    </div>
  )
}
