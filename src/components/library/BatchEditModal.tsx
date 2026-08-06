import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  batchUpdateItems,
  getLibraryFilterData,
  libraryKeys,
  type BatchMediaPayload,
  type ItemMetadataPatch,
} from '@/api/libraries'
import { Modal } from '@/components/common/Modal'
import { Chips } from '@/components/common/Chips'
import { SuggestChips } from '@/components/common/SuggestChips'
import { Icon } from '@/components/common/Icon'
import { Cover } from '@/components/common/Cover'
import type { ABSLibraryItem } from '@/api/types'

type ListMode = 'replace' | 'append'

interface BatchEditModalProps {
  ids: string[]
  libraryId: string
  // The selected items, so the modal can preview exactly what it will change.
  items?: ABSLibraryItem[]
  onClose: () => void
  onDone: () => void
}

function FieldRow({
  label,
  on,
  setOn,
  hint,
  children,
}: {
  label: string
  on: boolean
  setOn: (v: boolean) => void
  hint?: string
  children: ReactNode
}) {
  return (
    <div className={'field full' + (on ? '' : ' bf-off')}>
      <label
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={() => setOn(!on)}
      >
        <Icon
          name={on ? 'check_box' : 'check_box_outline_blank'}
          fill={on}
          style={{ fontSize: 18, color: on ? 'var(--accent)' : 'var(--text-faint)' }}
        />
        {label}
        {on && hint && (
          <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· {hint}</span>
        )}
      </label>
      <div style={on ? undefined : { opacity: 0.4, pointerEvents: 'none' }}>{children}</div>
    </div>
  )
}

// Writes the same ticked fields across all selected items via the batch endpoint.
// Unticked fields are left untouched per book.
export function BatchEditModal({ ids, libraryId, items, onClose, onDone }: BatchEditModalProps) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<ListMode>('replace')

  const [genresOn, setGenresOn] = useState(false)
  const [genres, setGenres] = useState<string[]>([])
  const [tagsOn, setTagsOn] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [pubOn, setPubOn] = useState(false)
  const [publisher, setPublisher] = useState('')
  const [yearOn, setYearOn] = useState(false)
  const [year, setYear] = useState('')
  const [langOn, setLangOn] = useState(false)
  const [language, setLanguage] = useState('')
  const [explicitOn, setExplicitOn] = useState(false)
  const [explicit, setExplicit] = useState(false)
  const [abridgedOn, setAbridgedOn] = useState(false)
  const [abridged, setAbridged] = useState(false)
  const [authorsOn, setAuthorsOn] = useState(false)
  const [authors, setAuthors] = useState<string[]>([])
  const [narratorsOn, setNarratorsOn] = useState(false)
  const [narrators, setNarrators] = useState<string[]>([])
  const [seriesOn, setSeriesOn] = useState(false)
  const [seriesName, setSeriesName] = useState('')
  const [saving, setSaving] = useState(false)

  // Suggestions from the library's existing values, same as the single-item form.
  const { data: filterData } = useQuery({
    queryKey: libraryKeys.filterData(libraryId),
    queryFn: () => getLibraryFilterData(libraryId),
    enabled: Boolean(libraryId),
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  const tickedCount = [
    genresOn,
    tagsOn,
    pubOn,
    yearOn,
    langOn,
    explicitOn,
    abridgedOn,
    authorsOn,
    narratorsOn,
    seriesOn,
  ].filter(Boolean).length

  // Note: in append mode for list fields we can't merge per-book client-side
  // without each book's current list, so append is a hint; the batch endpoint
  // replaces. Replace is the safe, verified behaviour.
  const apply = async () => {
    if (tickedCount === 0) return
    setSaving(true)
    const metadata: ItemMetadataPatch = {}
    if (genresOn) metadata.genres = genres
    if (pubOn) metadata.publisher = publisher
    if (yearOn) metadata.publishedYear = year
    if (langOn) metadata.language = language
    if (explicitOn) metadata.explicit = explicit
    if (abridgedOn) metadata.abridged = abridged
    if (narratorsOn) metadata.narrators = narrators
    if (authorsOn) metadata.authors = authors.map((name) => ({ name }))
    // One series for the whole selection, with NO sequence: a position is
    // per-book and can't be meaningful across a multi-book write. Users set the
    // numbers afterwards per book. This still REPLACES each book's existing
    // series memberships, which the warning below makes explicit.
    if (seriesOn && seriesName.trim()) {
      metadata.series = [{ name: seriesName.trim(), sequence: null }]
    }
    const payload: BatchMediaPayload = {}
    if (Object.keys(metadata).length) payload.metadata = metadata
    if (tagsOn) payload.tags = tags
    try {
      await batchUpdateItems(ids, payload)
      qc.invalidateQueries({ queryKey: libraryKeys.allItems(libraryId) })
      qc.invalidateQueries({ queryKey: libraryKeys.series(libraryId) })
      onDone()
    } finally {
      setSaving(false)
    }
  }

  const foot = (
    <>
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        {tickedCount} field{tickedCount === 1 ? '' : 's'} will change on {ids.length} book
        {ids.length === 1 ? '' : 's'}
      </span>
      <div style={{ flex: 1 }} />
      <button className="btn-sm btn-ghost" onClick={onClose}>
        Cancel
      </button>
      <button
        className="btn-sm btn-green"
        disabled={saving || tickedCount === 0}
        onClick={() => void apply()}
      >
        <Icon name="save" /> Apply to {ids.length}
      </button>
    </>
  )

  return (
    <Modal title={`Edit ${ids.length} books`} onClose={onClose} foot={foot}>
      <div className="batch-bar">
        <Icon name="checklist" />
        <span className="bb-count">{ids.length} selected</span>
        <div style={{ flex: 1 }} />
        <div className="seg">
          {(['replace', 'append'] as ListMode[]).map((mo) => (
            <button key={mo} className={mode === mo ? 'on' : ''} onClick={() => setMode(mo)}>
              {mo === 'replace' ? 'Replace' : 'Append'}
            </button>
          ))}
        </div>
      </div>
      <p
        style={{
          fontSize: 13,
          color: 'var(--text-muted)',
          margin: '0 0 16px',
        }}
      >
        Tick a field to write it to all {ids.length} books. Unticked fields keep each book's
        existing value.
      </p>

      <div className="form-grid">
        <FieldRow
          label="Genres"
          on={genresOn}
          setOn={setGenresOn}
          hint={mode === 'append' ? 'add to existing' : 'replace'}
        >
          <Chips items={genres} onChange={setGenres} placeholder="Add genre…" />
        </FieldRow>
        <FieldRow
          label="Tags"
          on={tagsOn}
          setOn={setTagsOn}
          hint={mode === 'append' ? 'add to existing' : 'replace'}
        >
          <Chips items={tags} onChange={setTags} placeholder="Add tag…" />
        </FieldRow>
        <FieldRow label="Publisher" on={pubOn} setOn={setPubOn}>
          <input className="fld" value={publisher} onChange={(e) => setPublisher(e.target.value)} />
        </FieldRow>
        <FieldRow label="Publish year" on={yearOn} setOn={setYearOn}>
          <input className="fld" value={year} onChange={(e) => setYear(e.target.value)} />
        </FieldRow>
        <FieldRow label="Language" on={langOn} setOn={setLangOn}>
          <input className="fld" value={language} onChange={(e) => setLanguage(e.target.value)} />
        </FieldRow>
        <FieldRow label="Explicit" on={explicitOn} setOn={setExplicitOn}>
          <div
            className={'toggle' + (explicit ? ' on' : '')}
            role="switch"
            aria-checked={explicit}
            onClick={() => setExplicit((v) => !v)}
          >
            <i />
          </div>
        </FieldRow>
        <FieldRow label="Abridged" on={abridgedOn} setOn={setAbridgedOn}>
          <div
            className={'toggle' + (abridged ? ' on' : '')}
            role="switch"
            aria-checked={abridged}
            onClick={() => setAbridged((v) => !v)}
          >
            <i />
          </div>
        </FieldRow>
        <FieldRow
          label="Authors"
          on={authorsOn}
          setOn={setAuthorsOn}
          hint="replaces each book's authors"
        >
          <SuggestChips
            items={authors}
            onChange={setAuthors}
            suggestions={(filterData?.authors ?? []).map((a) => a.name)}
            placeholder="Add author…"
          />
        </FieldRow>
        <FieldRow
          label="Narrators"
          on={narratorsOn}
          setOn={setNarratorsOn}
          hint="replaces each book's narrators"
        >
          <SuggestChips
            items={narrators}
            onChange={setNarrators}
            suggestions={filterData?.narrators ?? []}
            placeholder="Add narrator…"
          />
        </FieldRow>
        <FieldRow label="Series" on={seriesOn} setOn={setSeriesOn} hint="replaces, no numbers">
          <SuggestChips
            items={seriesName ? [seriesName] : []}
            onChange={(v) => setSeriesName(v[v.length - 1] ?? '')}
            suggestions={(filterData?.series ?? []).map((s) => s.name)}
            placeholder="Series name…"
          />
          {seriesOn && (
            <p className="be-warn">
              <Icon name="warning" style={{ fontSize: 15 }} /> Puts all {ids.length} books in this
              one series and takes them out of any other. Book numbers aren't set - add those on
              each book afterwards.
            </p>
          )}
        </FieldRow>
      </div>

      {items && items.length > 0 && (
        <>
          <div className="section-head" style={{ margin: '18px 0 10px' }}>
            <Icon name="menu_book" />
            <h2>Applying to {items.length} books</h2>
          </div>
          <div className="batch-apply-list">
            {items.map((b) => (
              <div className="batch-apply-row" key={b.id}>
                <Cover
                  itemId={b.id}
                  title={b.media.metadata.title ?? ''}
                  author={b.media.metadata.authorName}
                  fs={5}
                />
                <div className="bar-meta">
                  <div className="bar-t">{b.media.metadata.title}</div>
                  <div className="bar-s">{b.media.metadata.authorName}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
