import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { updateItemChapters, libraryKeys } from '@/api/libraries'
import { formatTimestamp } from '@/lib/format'
import { selectionRange } from '@hearthshelf/core'
import type { ABSChapter } from '@/api/types'
import { Modal } from '@/components/common/Modal'
import { Icon } from '@/components/common/Icon'
import { ChapterBulkBar } from '@/components/library/ChapterBulkBar'

interface EditChapter {
  title: string
  start: number
  end: number
}

interface ChapterEditorModalProps {
  itemId: string
  chapters: ABSChapter[]
  duration: number
  onClose: () => void
}

// Edit chapter titles and start times, add/remove chapters. End times are
// derived from the next chapter's start (last chapter ends at the duration).
// The bulk bar retitles many rows at once; it stages into `rows` like a manual
// edit, so nothing reaches the server until Save.
export function ChapterEditorModal({
  itemId,
  chapters,
  duration,
  onClose,
}: ChapterEditorModalProps) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<EditChapter[]>(
    chapters.map((c) => ({ title: c.title, start: c.start, end: c.end })),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bulk, setBulk] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [anchor, setAnchor] = useState<number | null>(null)

  const setTitle = (i: number, title: string) =>
    setRows((r) => r.map((c, j) => (j === i ? { ...c, title } : c)))
  const setStart = (i: number, mmss: string) => {
    // accept H:MM:SS or M:SS or raw seconds
    const parts = mmss.split(':').map(Number)
    let sec = 0
    if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2]
    else if (parts.length === 2) sec = parts[0] * 60 + parts[1]
    else sec = parts[0] || 0
    setRows((r) => r.map((c, j) => (j === i ? { ...c, start: sec } : c)))
  }
  const removeRow = (i: number) => {
    setRows((r) => r.filter((_, j) => j !== i))
    // Rows below the removed one shift up, so the selection has to shift with
    // them or a later bulk edit lands on the wrong chapters.
    setSelected((s) => s.filter((j) => j !== i).map((j) => (j > i ? j - 1 : j)))
    setAnchor(null)
  }
  const addRow = () =>
    setRows((r) => [
      ...r,
      { title: `Chapter ${r.length + 1}`, start: r[r.length - 1]?.end ?? 0, end: duration },
    ])

  const toggleRow = (i: number, shift: boolean) => {
    setSelected((s) => {
      if (shift && anchor !== null) {
        const range = selectionRange(anchor, i)
        // Shift-click extends the selection rather than replacing it, so
        // several ranges can be combined.
        return [...new Set([...s, ...range])]
      }
      return s.includes(i) ? s.filter((j) => j !== i) : [...s, i]
    })
    setAnchor(i)
  }
  const allSelected = rows.length > 0 && selected.length === rows.length
  const toggleAll = () => {
    setSelected(allSelected ? [] : rows.map((_, i) => i))
    setAnchor(null)
  }

  const save = async () => {
    setError(null)
    // recompute end times from sorted starts
    const sorted = [...rows].filter((c) => c.title.trim()).sort((a, b) => a.start - b.start)
    if (sorted.length === 0) {
      setError('At least one chapter is required.')
      return
    }
    const finalized = sorted.map((c, i) => ({
      title: c.title.trim(),
      start: c.start,
      end: i < sorted.length - 1 ? sorted[i + 1].start : duration,
    }))
    setSaving(true)
    try {
      await updateItemChapters(itemId, finalized)
      qc.invalidateQueries({ queryKey: libraryKeys.item(itemId) })
      onClose()
    } catch {
      setError('Could not save chapters.')
    } finally {
      setSaving(false)
    }
  }

  const foot = (
    <>
      <button className="btn-sm btn-ghost" onClick={addRow}>
        <Icon name="add" /> Add chapter
      </button>
      <button
        className={'btn-sm ' + (bulk ? 'btn-green' : 'btn-ghost')}
        onClick={() => setBulk((b) => !b)}
      >
        <Icon name="format_list_numbered" /> Bulk edit
      </button>
      {error && <span style={{ color: 'var(--primary)', fontSize: 13 }}>{error}</span>}
      <div style={{ flex: 1 }} />
      <button className="btn-sm btn-ghost" onClick={onClose}>
        Cancel
      </button>
      <button className="btn-sm btn-green" disabled={saving} onClick={() => void save()}>
        <Icon name="save" /> Save chapters
      </button>
    </>
  )

  return (
    <Modal title="Edit chapters" onClose={onClose} foot={foot}>
      {bulk && (
        <>
          <ChapterBulkBar rows={rows} selected={selected} onApply={setRows} />
          <button className="ch-select-all" onClick={toggleAll}>
            {allSelected ? 'Clear selection' : 'Select all chapters'}
          </button>
        </>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {bulk && (
              <input
                type="checkbox"
                className="ch-sel"
                checked={selected.includes(i)}
                onChange={(e) => toggleRow(i, (e.nativeEvent as MouseEvent).shiftKey === true)}
              />
            )}
            <span
              className="num"
              style={{ width: 22, color: 'var(--text-faint)', textAlign: 'right' }}
            >
              {i + 1}
            </span>
            <input
              className="fld"
              style={{ flex: 1 }}
              value={c.title}
              onChange={(e) => setTitle(i, e.target.value)}
            />
            <input
              className="fld"
              style={{ width: 96, fontFamily: 'var(--font-mono)', textAlign: 'right' }}
              defaultValue={formatTimestamp(c.start)}
              onBlur={(e) => setStart(i, e.target.value)}
            />
            <button className="tbl-icon" title="Remove" onClick={() => removeRow(i)}>
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
