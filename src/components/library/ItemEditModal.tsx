import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  updateItemMetadata,
  libraryKeys,
  type ItemMetadataPatch,
} from '@/api/libraries'
import type { ABSLibraryItemDetail } from '@/api/types'
import { Modal } from '@/components/common/Modal'
import { Chips } from '@/components/common/Chips'
import { Icon } from '@/components/common/Icon'
import { ItemMatchTab } from '@/components/library/ItemMatchTab'
import { ItemCoverTab } from '@/components/library/ItemCoverTab'

function Field({
  label,
  full,
  children,
}: {
  label: string
  full?: boolean
  children: ReactNode
}) {
  return (
    <div className={'field' + (full ? ' full' : '')}>
      <label>{label}</label>
      {children}
    </div>
  )
}

interface ItemEditModalProps {
  item: ABSLibraryItemDetail
  onClose: () => void
}

// Editing modal. The Details tab saves real metadata via PATCH /api/items/:id/media.
// The remaining tabs (cover/match/chapters/files/tools) are documented in the spec
// but depend on endpoints not yet wired here; the Details tab is the working core.
export function ItemEditModal({ item, onClose }: ItemEditModalProps) {
  const qc = useQueryClient()
  const m = item.media.metadata
  const authorName = m.authors?.[0]?.name ?? ''

  const [tab, setTab] = useState('Details')
  const [appliedNote, setAppliedNote] = useState<string | null>(null)
  const [title, setTitle] = useState(m.title ?? '')
  const [subtitle, setSubtitle] = useState(m.subtitle ?? '')
  const [publishedYear, setPublishedYear] = useState(m.publishedYear ?? '')
  const [publisher, setPublisher] = useState(m.publisher ?? '')
  const [isbn, setIsbn] = useState(m.isbn ?? '')
  const [asin, setAsin] = useState(m.asin ?? '')
  const [language, setLanguage] = useState(m.language ?? '')
  const [genres, setGenres] = useState<string[]>(m.genres ?? [])
  const [tags, setTags] = useState<string[]>(item.media.tags ?? [])
  const [description, setDescription] = useState(m.description ?? '')
  const [explicit, setExplicit] = useState(Boolean(m.explicit))
  const [saving, setSaving] = useState(false)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  const save = async (thenClose: boolean) => {
    setSaving(true)
    const patch: ItemMetadataPatch = {
      title,
      subtitle,
      description,
      publishedYear,
      publisher,
      language,
      isbn,
      asin,
      genres,
      explicit,
    }
    try {
      await updateItemMetadata(item.id, patch, tags)
      qc.invalidateQueries({ queryKey: libraryKeys.item(item.id) })
      if (thenClose) onClose()
      else setSavedNote('Saved')
    } finally {
      setSaving(false)
    }
  }

  const foot = (
    <>
      <div className="spacer" style={{ flex: 1 }} />
      {savedNote && (
        <span style={{ color: '#a7c896', fontSize: 13, marginRight: 8 }}>
          <Icon name="check" /> {savedNote}
        </span>
      )}
      <button
        className="btn-sm btn-ghost"
        disabled={saving}
        onClick={() => void save(false)}
      >
        Save
      </button>
      <button
        className="btn-sm btn-green"
        disabled={saving}
        onClick={() => void save(true)}
      >
        <Icon name="save" /> Save &amp; close
      </button>
    </>
  )

  const onApplied = (msg: string) => {
    setAppliedNote(msg)
    setTab('Details')
    // Reflect the applied match in the form by closing+reopening is heavy; the
    // item query is invalidated, so reopening the modal shows fresh values. Keep
    // a note for now.
  }

  return (
    <Modal
      title={`Edit · ${title}`}
      onClose={onClose}
      tabs={['Details', 'Match', 'Cover']}
      tab={tab}
      setTab={setTab}
      foot={tab === 'Details' ? foot : undefined}
    >
      {tab === 'Match' && (
        <ItemMatchTab
          itemId={item.id}
          defaultTitle={title}
          defaultAuthor={authorName}
          onApplied={onApplied}
        />
      )}
      {tab === 'Cover' && (
        <ItemCoverTab
          itemId={item.id}
          defaultTitle={title}
          defaultAuthor={authorName}
          onApplied={onApplied}
        />
      )}
      {tab === 'Details' && (
      <div className="form-grid">
        {appliedNote && (
          <div className="field full">
            <span style={{ color: '#a7c896', fontSize: 13 }}>
              <Icon name="check" /> {appliedNote} - reopen to see updated fields
            </span>
          </div>
        )}
        {/* details fields below */}
        <Field label="Title" full>
          <input
            className="fld"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Subtitle" full>
          <input
            className="fld"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
          />
        </Field>
        <Field label="Publish year">
          <input
            className="fld"
            value={publishedYear}
            onChange={(e) => setPublishedYear(e.target.value)}
          />
        </Field>
        <Field label="Publisher">
          <input
            className="fld"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
          />
        </Field>
        <Field label="ISBN">
          <input
            className="fld"
            value={isbn}
            onChange={(e) => setIsbn(e.target.value)}
          />
        </Field>
        <Field label="ASIN">
          <input
            className="fld"
            value={asin}
            onChange={(e) => setAsin(e.target.value)}
          />
        </Field>
        <Field label="Language">
          <input
            className="fld"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          />
        </Field>
        <Field label="Genres">
          <Chips items={genres} onChange={setGenres} placeholder="Add genre…" />
        </Field>
        <Field label="Tags" full>
          <Chips items={tags} onChange={setTags} placeholder="Add tag…" />
        </Field>
        <Field label="Description" full>
          <textarea
            className="fld"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="field-row" style={{ borderTop: 'none' }}>
          <div className="fr-meta">
            <div className="fr-t">Explicit</div>
          </div>
          <div
            className={'toggle' + (explicit ? ' on' : '')}
            role="switch"
            aria-checked={explicit}
            onClick={() => setExplicit((v) => !v)}
          >
            <i />
          </div>
        </div>
      </div>
      )}
    </Modal>
  )
}
