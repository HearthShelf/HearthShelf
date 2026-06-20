import { useState } from 'react'
import { Modal } from '@/components/common/Modal'

export interface MergeItem {
  id: string
  name: string
  numBooks: number
}

interface MergeModalProps {
  kind: string
  items: MergeItem[]
  onMerge: (canonicalName: string) => Promise<void>
  onClose: () => void
}

export function MergeModal({ kind, items, onMerge, onClose }: MergeModalProps) {
  const best = items.reduce((a, b) => (b.numBooks > a.numBooks ? b : a), items[0])
  const [name, setName] = useState(best?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doMerge = async () => {
    const canonical = name.trim()
    if (!canonical) return
    setBusy(true)
    setError(null)
    try {
      await onMerge(canonical)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Merge ${kind}s`}
      onClose={() => !busy && onClose()}
      foot={
        <>
          <div style={{ flex: 1 }} />
          <button className="btn-sm btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-sm btn-primary"
            onClick={() => void doMerge()}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Merging…' : 'Merge'}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        Merging {items.length} {kind}s into one name:
      </p>
      <ul style={{ marginBottom: '1rem', paddingLeft: '1.25rem', fontSize: 13 }}>
        {items.map((it) => (
          <li key={it.id} style={{ marginBottom: 4 }}>
            <strong>{it.name}</strong>
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}· {it.numBooks} {it.numBooks === 1 ? 'book' : 'books'}
            </span>
          </li>
        ))}
      </ul>
      <div className="field full">
        <label>Keep this name</label>
        <input
          className="fld"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Canonical name"
        />
      </div>
      {error && (
        <p style={{ fontSize: 13, color: 'var(--color-danger)', marginTop: 8 }}>{error}</p>
      )}
    </Modal>
  )
}
