import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { searchLibrary } from '@/api/libraries'
import type { ABSLibraryItem } from '@/api/types'
import { Modal } from '@/components/common/Modal'
import { Cover } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'

export type PickerKind = 'collection' | 'playlist'

interface BookPickerModalProps {
  kind: PickerKind
  libraryId: string
  /**
   * Create mode asks for a name alongside the books; add mode names the list it
   * is adding to. ABS refuses a collection with no books, so create mode keeps
   * its confirm disabled until at least one book is picked.
   */
  mode: 'create' | 'add'
  /** Add mode only - the list being added to, for the title and confirm label. */
  listName?: string
  /** Books already in the list; shown as picked-and-locked so they can't double-add. */
  existingIds?: string[]
  onSubmit: (books: string[], name: string) => Promise<void>
  onClose: () => void
}

/**
 * Pick books by search, with multi-select and a single confirming action.
 *
 * Both entry points share this: "New collection/playlist" on the browse pages
 * (create mode) and "Add books" on a detail page (add mode). Selection survives
 * changing the query - you can search "dune", tick two, search something else,
 * and still add all of them in one batch call.
 */
export function BookPickerModal({
  kind,
  libraryId,
  mode,
  listName,
  existingIds = [],
  onSubmit,
  onClose,
}: BookPickerModalProps) {
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [picked, setPicked] = useState<Map<string, ABSLibraryItem>>(new Map())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // Debounce so typing doesn't fire a search per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 250)
    return () => window.clearTimeout(t)
  }, [query])

  const { data, isFetching } = useQuery({
    queryKey: ['book-picker-search', libraryId, debounced],
    queryFn: () => searchLibrary(libraryId, debounced),
    // ABS 400s on an empty q, so only search once there is something to search.
    enabled: debounced.length > 0,
    staleTime: 60 * 1000,
  })

  const already = useMemo(() => new Set(existingIds), [existingIds])
  const results = useMemo(
    () => (data?.book ?? []).map((b) => b.libraryItem).filter(Boolean),
    [data],
  )

  const toggle = (item: ABSLibraryItem) => {
    setPicked((prev) => {
      const next = new Map(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.set(item.id, item)
      return next
    })
  }

  const count = picked.size
  const canSubmit = !busy && count > 0 && (mode === 'add' || name.trim().length > 0)

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setFailure(null)
    try {
      await onSubmit([...picked.keys()], name.trim())
      onClose()
    } catch {
      setFailure(
        mode === 'create'
          ? `Could not create that ${kind}.`
          : `Could not add ${count === 1 ? 'that book' : 'those books'}.`,
      )
      setBusy(false)
    }
  }

  const title =
    mode === 'create'
      ? `New ${kind}`
      : `Add books to ${listName ?? (kind === 'collection' ? 'collection' : 'playlist')}`

  const confirmLabel =
    mode === 'create'
      ? 'Create'
      : count > 0
        ? `Add ${count} ${count === 1 ? 'book' : 'books'}`
        : 'Add books'

  return (
    <Modal
      title={title}
      onClose={onClose}
      foot={
        <>
          <span className="count-badge">
            {count} {count === 1 ? 'book' : 'books'} selected
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn-sm btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-sm btn-green" disabled={!canSubmit} onClick={() => void submit()}>
            <Icon name={mode === 'create' ? 'add' : 'library_add'} /> {confirmLabel}
          </button>
        </>
      }
    >
      {mode === 'create' && (
        <>
          <label className="fld-label" htmlFor="picker-name">
            Name
          </label>
          <input
            id="picker-name"
            className="fld"
            placeholder={`My ${kind}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {/* ABS will not create a collection with no books, so say so up front
              rather than letting the create fail server-side. */}
          <p className="page-sub" style={{ margin: 'var(--s2) 0 var(--s4)' }}>
            Pick at least one book to start this {kind} off.
          </p>
        </>
      )}

      <label className="fld-label" htmlFor="picker-search">
        Find books
      </label>
      <input
        id="picker-search"
        className="fld"
        placeholder="Search by title or author…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus={mode === 'add'}
      />

      {failure && (
        <p className="page-sub" role="alert" style={{ marginTop: 'var(--s3)' }}>
          {failure}
        </p>
      )}

      <div className="pop-scroll" style={{ maxHeight: 320, marginTop: 'var(--s3)' }}>
        {!debounced ? (
          <div className="pop-empty">Search your library to add books.</div>
        ) : isFetching ? (
          <LoadingSpinner className="py-8" label="Searching..." />
        ) : results.length === 0 ? (
          <div className="pop-empty">No books match "{debounced}".</div>
        ) : (
          results.map((b) => {
            const inList = already.has(b.id)
            const on = picked.has(b.id)
            return (
              <button
                key={b.id}
                className="list-row"
                disabled={inList || busy}
                onClick={() => toggle(b)}
                aria-pressed={on}
              >
                <span className="lr-ico">
                  <Cover itemId={b.id} title={b.media.metadata.title ?? 'Untitled'} fs={5} />
                </span>
                <span className="lr-t" style={{ minWidth: 0 }}>
                  <span className="ll-title">{b.media.metadata.title ?? 'Untitled'}</span>
                  <span className="ll-sub">{b.media.metadata.authorName ?? ''}</span>
                </span>
                <span className="lr-check">
                  {inList ? (
                    <span className="ll-sub">Added</span>
                  ) : (
                    <Icon name={on ? 'check_circle' : 'add_circle'} fill={on} />
                  )}
                </span>
              </button>
            )
          })
        )}
      </div>

      {/* Selections persist across searches, so show what is queued up - it is
          otherwise invisible once the query moves on. */}
      {count > 0 && (
        <div className="sh-list" style={{ marginTop: 'var(--s4)' }}>
          {[...picked.values()].map((b) => (
            <div className="sh-row" key={b.id}>
              <div className="sh-meta">
                <div className="ll-title">{b.media.metadata.title ?? 'Untitled'}</div>
                <div className="ll-sub">{b.media.metadata.authorName ?? ''}</div>
              </div>
              <button className="btn-sm btn-ghost" onClick={() => toggle(b)} disabled={busy}>
                <Icon name="close" /> Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
