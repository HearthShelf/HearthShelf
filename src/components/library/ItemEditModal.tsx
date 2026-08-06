import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  updateItemMetadata,
  getLibraryFilterData,
  libraryKeys,
  itemFileDownloadUrl,
  itemDownloadUrl,
  deleteLibraryFile,
  reorderItemTracks,
  embedItemMetadata,
  type ItemMetadataPatch,
  type ItemSeriesPatch,
} from '@/api/libraries'
import type { ABSLibraryItemDetail } from '@/api/types'
import { formatTimestamp } from '@/lib/format'
import { Modal } from '@/components/common/Modal'
import { SuggestChips } from '@/components/common/SuggestChips'
import { SeriesEditor } from '@/components/library/SeriesEditor'
import { Icon } from '@/components/common/Icon'
import { ItemMatchTab } from '@/components/library/ItemMatchTab'
import { ItemCoverTab } from '@/components/library/ItemCoverTab'
import { ChapterEditorModal } from '@/components/library/ChapterEditorModal'

function Field({ label, full, children }: { label: string; full?: boolean; children: ReactNode }) {
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

// Editing modal. Details saves metadata via PATCH /api/items/:id/media; Cover and
// Match find/apply artwork and provider matches; Chapters opens the chapter editor
// (POST /api/items/:id/chapters); Files downloads/deletes individual files; Tools
// embeds metadata back into the audio (POST /api/tools/item/:id/embed-metadata).
export function ItemEditModal({ item, onClose }: ItemEditModalProps) {
  const qc = useQueryClient()
  const m = item.media.metadata
  const authorName = m.authors?.[0]?.name ?? ''
  const audioFiles = item.media.audioFiles ?? []
  const hasAudio = audioFiles.length > 0

  const [tab, setTab] = useState('Details')
  const [editingChapters, setEditingChapters] = useState(false)
  const [appliedNote, setAppliedNote] = useState<string | null>(null)
  const [title, setTitle] = useState(m.title ?? '')
  const [subtitle, setSubtitle] = useState(m.subtitle ?? '')
  const [publishedYear, setPublishedYear] = useState(m.publishedYear ?? '')
  const [publishedDate, setPublishedDate] = useState(m.publishedDate ?? '')
  const [publisher, setPublisher] = useState(m.publisher ?? '')
  const [isbn, setIsbn] = useState(m.isbn ?? '')
  const [asin, setAsin] = useState(m.asin ?? '')
  const [language, setLanguage] = useState(m.language ?? '')
  const [genres, setGenres] = useState<string[]>(m.genres ?? [])
  const [tags, setTags] = useState<string[]>(item.media.tags ?? [])
  const [authors, setAuthors] = useState<string[]>(() => (m.authors ?? []).map((a) => a.name))
  const [narrators, setNarrators] = useState<string[]>(m.narrators ?? [])
  const [series, setSeries] = useState<ItemSeriesPatch[]>(() =>
    (m.series ?? []).map((s) => ({ name: s.name, sequence: s.sequence })),
  )
  const [description, setDescription] = useState(m.description ?? '')
  const [explicit, setExplicit] = useState(Boolean(m.explicit))
  const [abridged, setAbridged] = useState(Boolean(m.abridged))
  const [saving, setSaving] = useState(false)
  const [savedNote, setSavedNote] = useState<string | null>(null)

  // Existing library values, to suggest the established spelling instead of
  // letting a typo create a near-duplicate author/series. Optional: the form
  // works fully without it, so a failure just means no suggestions.
  const { data: filterData } = useQuery({
    queryKey: libraryKeys.filterData(item.libraryId),
    queryFn: () => getLibraryFilterData(item.libraryId),
    enabled: Boolean(item.libraryId),
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  const save = async (thenClose: boolean) => {
    setSaving(true)
    // Series, authors and narrators are REPLACE on ABS's side - it unlinks
    // anything absent from these arrays - so always send the complete list the
    // form is showing, never a delta.
    const patch: ItemMetadataPatch = {
      title,
      subtitle,
      description,
      publishedYear,
      publishedDate,
      publisher,
      language,
      isbn,
      asin,
      genres,
      narrators,
      series,
      authors: authors.map((name) => ({ name })),
      explicit,
      abridged,
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
      <button className="btn-sm btn-ghost" disabled={saving} onClick={() => void save(false)}>
        Save
      </button>
      <button className="btn-sm btn-green" disabled={saving} onClick={() => void save(true)}>
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
    <>
      <Modal
        title={`Edit · ${title}`}
        onClose={onClose}
        tabs={['Details', 'Cover', ...(hasAudio ? ['Chapters', 'Files', 'Tools'] : []), 'Match']}
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
        {tab === 'Chapters' && (
          <ChaptersTab
            chapterCount={item.media.chapters?.length ?? 0}
            onEdit={() => setEditingChapters(true)}
          />
        )}
        {tab === 'Files' && (
          <FilesTab
            item={item}
            onDeleted={() => qc.invalidateQueries({ queryKey: libraryKeys.item(item.id) })}
          />
        )}
        {tab === 'Tools' && <ToolsTab itemId={item.id} />}
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
              <input className="fld" value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Subtitle" full>
              <input
                className="fld"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
              />
            </Field>
            <Field label="Authors" full>
              <SuggestChips
                items={authors}
                onChange={setAuthors}
                suggestions={(filterData?.authors ?? []).map((a) => a.name)}
                placeholder="Add author…"
              />
            </Field>
            <Field label="Series" full>
              <SeriesEditor
                series={series}
                onChange={setSeries}
                suggestions={(filterData?.series ?? []).map((s) => s.name)}
              />
            </Field>
            <Field label="Narrators" full>
              <SuggestChips
                items={narrators}
                onChange={setNarrators}
                suggestions={filterData?.narrators ?? []}
                placeholder="Add narrator…"
              />
            </Field>
            <Field label="Publish year">
              <input
                className="fld"
                value={publishedYear}
                onChange={(e) => setPublishedYear(e.target.value)}
              />
            </Field>
            <Field label="Publish date">
              <input
                className="fld"
                type="date"
                value={publishedDate}
                onChange={(e) => setPublishedDate(e.target.value)}
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
              <input className="fld" value={isbn} onChange={(e) => setIsbn(e.target.value)} />
            </Field>
            <Field label="ASIN">
              <input className="fld" value={asin} onChange={(e) => setAsin(e.target.value)} />
            </Field>
            <Field label="Language">
              <input
                className="fld"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </Field>
            <Field label="Genres">
              <SuggestChips
                items={genres}
                onChange={setGenres}
                suggestions={filterData?.genres ?? []}
                placeholder="Add genre…"
              />
            </Field>
            <Field label="Tags" full>
              <SuggestChips
                items={tags}
                onChange={setTags}
                suggestions={filterData?.tags ?? []}
                placeholder="Add tag…"
              />
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
            <div className="field-row" style={{ borderTop: 'none' }}>
              <div className="fr-meta">
                <div className="fr-t">Abridged</div>
              </div>
              <div
                className={'toggle' + (abridged ? ' on' : '')}
                role="switch"
                aria-checked={abridged}
                onClick={() => setAbridged((v) => !v)}
              >
                <i />
              </div>
            </div>
          </div>
        )}
      </Modal>
      {editingChapters && (
        <ChapterEditorModal
          itemId={item.id}
          chapters={item.media.chapters ?? []}
          duration={(item.media.audioFiles ?? []).reduce((sum, f) => sum + (f.duration ?? 0), 0)}
          onClose={() => {
            setEditingChapters(false)
            qc.invalidateQueries({ queryKey: libraryKeys.item(item.id) })
          }}
        />
      )}
    </>
  )
}

function ChaptersTab({ chapterCount, onEdit }: { chapterCount: number; onEdit: () => void }) {
  return (
    <div style={{ padding: '8px 2px' }}>
      <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        This book has {chapterCount} {chapterCount === 1 ? 'chapter' : 'chapters'}. Open the chapter
        editor to rename them or adjust their start times.
      </p>
      <button className="btn-sm btn-green" style={{ marginTop: 12 }} onClick={onEdit}>
        <Icon name="edit" /> Edit chapters
      </button>
    </div>
  )
}

function FilesTab({ item, onDeleted }: { item: ABSLibraryItemDetail; onDeleted: () => void }) {
  const [files, setFiles] = useState(item.media.audioFiles ?? [])
  const [deleting, setDeleting] = useState<string | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)

  const remove = async (ino: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? The file is removed from disk.`)) return
    setDeleting(ino)
    try {
      await deleteLibraryFile(item.id, ino)
      setFiles((cur) => cur.filter((f) => f.ino !== ino))
      onDeleted()
    } finally {
      setDeleting(null)
    }
  }

  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...files]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setFiles(next)
    setSavingOrder(true)
    try {
      await reorderItemTracks(
        item.id,
        next.map((f) => f.ino),
      )
      onDeleted()
    } finally {
      setSavingOrder(false)
    }
  }

  const canReorder = files.length > 1

  return (
    <div className="tbl-wrap">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <a className="btn-sm" href={itemDownloadUrl(item.id)} target="_blank" rel="noreferrer">
          <Icon name="download" /> Download all
        </a>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>File</th>
            <th>Length</th>
            <th style={{ textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f, i) => (
            <tr key={f.ino}>
              <td style={{ fontWeight: 600 }}>{f.metadata.filename}</td>
              <td className="mono">{formatTimestamp(f.duration)}</td>
              <td>
                <div className="t-actions">
                  {canReorder && (
                    <>
                      <button
                        className="tbl-icon"
                        title="Move up"
                        disabled={i === 0 || savingOrder}
                        onClick={() => void move(i, -1)}
                      >
                        <Icon name="arrow_upward" />
                      </button>
                      <button
                        className="tbl-icon"
                        title="Move down"
                        disabled={i === files.length - 1 || savingOrder}
                        onClick={() => void move(i, 1)}
                      >
                        <Icon name="arrow_downward" />
                      </button>
                    </>
                  )}
                  <a
                    className="tbl-icon"
                    title="Download file"
                    href={itemFileDownloadUrl(item.id, f.ino)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="download" />
                  </a>
                  <button
                    className="tbl-icon"
                    title="Delete file"
                    disabled={deleting === f.ino}
                    onClick={() => void remove(f.ino, f.metadata.filename)}
                  >
                    <Icon name="delete" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ToolsTab({ itemId }: { itemId: string }) {
  const [chapters, setChapters] = useState(false)
  const [backup, setBackup] = useState(true)
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const embed = async () => {
    setRunning(true)
    setMsg(null)
    try {
      await embedItemMetadata(itemId, { forceEmbedChapters: chapters, backup })
      setMsg('Started - AudiobookShelf is embedding metadata in the background.')
    } catch {
      setMsg('Could not start. The item may already be queued or processing.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{ padding: '8px 2px' }}>
      <div className="section-head">
        <Icon name="save_as" />
        <h2>Embed metadata</h2>
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        Write the current title, author, and cover back into the audio files so other players read
        them too. Runs as a background task.
      </p>
      <label
        style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 14 }}
      >
        <input type="checkbox" checked={chapters} onChange={(e) => setChapters(e.target.checked)} />
        Also embed chapter markers
      </label>
      <label
        style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 14 }}
      >
        <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
        Keep a backup of the original files
      </label>
      <button
        className="btn-sm btn-green"
        style={{ marginTop: 16 }}
        disabled={running}
        onClick={() => void embed()}
      >
        <Icon name="save_as" /> {running ? 'Starting...' : 'Embed metadata'}
      </button>
      {msg && <p style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>{msg}</p>}
    </div>
  )
}
