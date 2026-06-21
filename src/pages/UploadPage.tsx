import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useToast } from '@/hooks/useToast'
import { getLibraries, libraryKeys } from '@/api/libraries'
import { getMe, meKeys } from '@/api/me'
import {
  acceptFor,
  classifyFile,
  fileExt,
  uploadItem,
  SUPPORTED_AUDIO,
} from '@/api/upload'
import type { ABSLibrary } from '@/api/types'

// Allow directory selection on the folder picker. Non-standard attributes need
// a typed shim to satisfy strict mode.
const dirProps = {
  webkitdirectory: '',
  directory: '',
} as unknown as React.InputHTMLAttributes<HTMLInputElement>

type ItemStatus = 'pending' | 'uploading' | 'success' | 'error'

interface QueuedItem {
  index: number
  title: string
  author: string
  series: string
  files: File[]
  status: ItemStatus
  progress: number // 0..1
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes / 1024
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`
}

function itemKind(files: File[]): string {
  return files.some((f) => SUPPORTED_AUDIO.includes(fileExt(f.name)))
    ? 'audio_file'
    : 'book'
}

// Derive a clean title from a file's relative path (folder name) or its base
// filename, mirroring the ABS uploader's cleanBook heuristic.
function deriveTitle(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  if (rel) {
    const parts = rel.split('/').filter(Boolean)
    if (parts.length > 1) return parts[parts.length - 2]
  }
  const base = file.name
  const dot = base.lastIndexOf('.')
  return dot === -1 ? base : base.slice(0, dot)
}

export function UploadPage() {
  const qc = useQueryClient()
  const { toast, show } = useToast()

  const { data: librariesData, isLoading: librariesLoading } = useQuery({
    queryKey: libraryKeys.all,
    queryFn: getLibraries,
    staleTime: 5 * 60 * 1000,
  })
  const { data: me, isLoading: meLoading } = useQuery({
    queryKey: meKeys.me,
    queryFn: getMe,
    staleTime: 5 * 60 * 1000,
  })

  const libraries = useMemo<ABSLibrary[]>(
    () => librariesData?.libraries ?? [],
    [librariesData]
  )

  const [selectedLibraryId, setSelectedLibraryId] = useState('')
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [items, setItems] = useState<QueuedItem[]>([])
  const [ignoredCount, setIgnoredCount] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const filePicker = useRef<HTMLInputElement>(null)
  const folderPicker = useRef<HTMLInputElement>(null)
  const nextIndex = useRef(1)

  const selectedLibrary = libraries.find((l) => l.id === selectedLibraryId)
  const isPodcast = selectedLibrary?.mediaType === 'podcast'
  const folders = selectedLibrary?.folders ?? []
  const locked = items.length > 0

  const onLibraryChange = (id: string) => {
    setSelectedLibraryId(id)
    const lib = libraries.find((l) => l.id === id)
    setSelectedFolderId(lib?.folders[0]?.id ?? '')
  }

  // Group an incoming FileList into queue items. With a folder picker each
  // sub-directory becomes one item; loose files each become their own item.
  const addFiles = (fileList: FileList | null) => {
    if (!fileList || !fileList.length) return
    const accepted: File[] = []
    let ignored = 0
    for (const file of Array.from(fileList)) {
      const kind = classifyFile(file.name)
      const usable =
        kind === 'audio' ||
        kind === 'image' ||
        kind === 'other' ||
        (kind === 'ebook' && !isPodcast)
      if (usable) accepted.push(file)
      else ignored++
    }
    if (ignored) setIgnoredCount((c) => c + ignored)
    if (!accepted.length) return

    // Bucket by the file's parent directory (folder uploads); loose files share
    // the '' bucket and each become a standalone item.
    const buckets = new Map<string, File[]>()
    for (const file of accepted) {
      const rel = (file as File & { webkitRelativePath?: string })
        .webkitRelativePath
      const dir = rel ? rel.split('/').slice(0, -1).join('/') : ''
      const arr = buckets.get(dir) ?? []
      arr.push(file)
      buckets.set(dir, arr)
    }

    const newItems: QueuedItem[] = []
    for (const [dir, files] of buckets) {
      if (dir === '') {
        // Loose files: one item each (matches ABS treating bare audio drops as
        // individual books).
        for (const file of files) {
          newItems.push(makeItem([file]))
        }
      } else {
        newItems.push(makeItem(files))
      }
    }
    setItems((prev) => [...prev, ...newItems])
  }

  const makeItem = (files: File[]): QueuedItem => ({
    index: nextIndex.current++,
    title: deriveTitle(files[0]),
    author: '',
    series: '',
    files,
    status: 'pending',
    progress: 0,
  })

  const patchItem = (index: number, patch: Partial<QueuedItem>) =>
    setItems((prev) =>
      prev.map((it) => (it.index === index ? { ...it, ...patch } : it))
    )

  const removeItem = (index: number) =>
    setItems((prev) => prev.filter((it) => it.index !== index))

  const reset = () => {
    setItems([])
    setIgnoredCount(0)
    nextIndex.current = 1
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (locked) return
    addFiles(e.dataTransfer.files)
  }

  const submit = async () => {
    if (!selectedLibraryId || !selectedFolderId) {
      show('Pick a library and folder first')
      return
    }
    const pending = items.filter(
      (it) => it.status === 'pending' || it.status === 'error'
    )
    if (!pending.length) return

    setSubmitting(true)
    let ok = 0
    for (const it of pending) {
      if (!it.title.trim()) {
        patchItem(it.index, { status: 'error' })
        continue
      }
      patchItem(it.index, { status: 'uploading', progress: 0 })
      try {
        await uploadItem(
          {
            libraryId: selectedLibraryId,
            folderId: selectedFolderId,
            title: it.title.trim(),
            author: it.author.trim() || null,
            series: it.series.trim() || null,
            isPodcast,
            files: it.files,
          },
          (loaded, total) =>
            patchItem(it.index, { progress: total ? loaded / total : 0 })
        )
        patchItem(it.index, { status: 'success', progress: 1 })
        ok++
      } catch {
        patchItem(it.index, { status: 'error' })
      }
    }
    setSubmitting(false)
    show(
      ok === pending.length
        ? `Uploaded ${ok} item${ok === 1 ? '' : 's'}`
        : `Uploaded ${ok} of ${pending.length} - some failed`
    )
    if (ok) {
      // New items appear after the next ABS scan; nudge the library caches.
      qc.invalidateQueries({ queryKey: libraryKeys.all })
    }
  }

  if (librariesLoading || meLoading) {
    return (
      <div className="page fade-in">
        <div className="page-head">
          <div className="eyebrow">Add to library</div>
          <h1 className="title-xl">Upload</h1>
        </div>
        <LoadingSpinner className="py-12" label="Loading..." />
      </div>
    )
  }

  const canUpload = me?.permissions?.upload !== false
  if (!canUpload) {
    return (
      <div className="page fade-in">
        <div className="page-head">
          <div className="eyebrow">Add to library</div>
          <h1 className="title-xl">Upload</h1>
        </div>
        <div className="empty-state">
          <Icon name="lock" />
          <h3>Upload isn&apos;t enabled for your account</h3>
          <p>Ask a server admin to grant the upload permission.</p>
        </div>
      </div>
    )
  }

  const pendingCount = items.filter(
    (it) => it.status === 'pending' || it.status === 'error'
  ).length

  return (
    <div className="page fade-in">
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div className="page-head">
          <div className="eyebrow">Add to library</div>
          <h1 className="title-xl">Upload</h1>
          <p className="page-sub">
            Send audio and ebook files straight to a library folder.
            AudiobookShelf scans them into items on its next pass.
          </p>
        </div>

        <div className="cfg-card">
          <div className="form-grid">
            <div className="field">
              <label>Library</label>
              <select
                className="fld"
                value={selectedLibraryId}
                disabled={locked}
                onChange={(e) => onLibraryChange(e.target.value)}
              >
                <option value="">Select a library…</option>
                {libraries.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Folder</label>
              <select
                className="fld"
                value={selectedFolderId}
                disabled={locked || !selectedLibrary}
                onChange={(e) => setSelectedFolderId(e.target.value)}
              >
                {folders.length === 0 && <option value="">No folders</option>}
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.fullPath}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="fr-meta">
              <div className="fr-t">Media type</div>
              <div className="fr-d">
                {selectedLibrary
                  ? isPodcast
                    ? 'Podcast - audio files only'
                    : 'Book - audio and ebook files'
                  : 'Pick a library to continue'}
              </div>
            </div>
            <span className="ll-col mono">
              {selectedLibrary?.mediaType ?? '—'}
            </span>
          </div>
        </div>

        {items.length === 0 && (
          <div
            className="cfg-card"
            style={{
              border: '2px dashed var(--hairline)',
              textAlign: 'center',
              padding: 40,
              background: isDragging
                ? 'color-mix(in oklab, var(--accent) 14%, transparent)'
                : 'transparent',
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
          >
            <Icon
              name="cloud_upload"
              style={{ fontSize: 44, color: 'var(--text-faint)' }}
            />
            <div style={{ fontSize: 15, fontWeight: 600, margin: '12px 0 4px' }}>
              {isDragging ? 'Drop files to queue them' : 'Drag files here'}
            </div>
            <div
              style={{
                fontSize: 13,
                color: 'var(--text-muted)',
                marginBottom: 16,
              }}
            >
              or choose files / a folder · .m4b .mp3 .m4a .flac
              {!isPodcast && ' .epub .pdf'}
            </div>
            <div
              style={{ display: 'flex', gap: 10, justifyContent: 'center' }}
            >
              <button
                className="btn-sm btn-accent"
                disabled={!selectedLibraryId}
                onClick={() => filePicker.current?.click()}
              >
                <Icon name="upload_file" /> Choose files
              </button>
              <button
                className="btn-sm btn-ghost"
                disabled={!selectedLibraryId}
                onClick={() => folderPicker.current?.click()}
              >
                <Icon name="folder" /> Choose folder
              </button>
            </div>
            {!selectedLibraryId && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-faint)',
                  marginTop: 12,
                }}
              >
                Select a library above to enable the picker.
              </div>
            )}
          </div>
        )}

        <input
          ref={filePicker}
          type="file"
          multiple
          accept={acceptFor(isPodcast)}
          hidden
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={folderPicker}
          type="file"
          multiple
          hidden
          {...dirProps}
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {ignoredCount > 0 && (
          <div className="banner info">
            <Icon name="info" />
            {ignoredCount} file{ignoredCount === 1 ? '' : 's'} skipped -
            unsupported type for this library.
            <span
              className="b-x"
              onClick={() => setIgnoredCount(0)}
              role="button"
            >
              <Icon name="close" />
            </span>
          </div>
        )}

        {items.length > 0 && (
          <>
            <div className="section-head">
              <Icon name="queue" />
              <h2>Queued · {items.length}</h2>
              <button
                className="btn-sm btn-ghost more"
                disabled={submitting}
                onClick={reset}
                style={{ marginLeft: 'auto' }}
              >
                Clear
              </button>
            </div>
            <div className="pl-list">
              {items.map((it) => {
                const totalBytes = it.files.reduce((s, f) => s + f.size, 0)
                return (
                  <div
                    className="pl-row"
                    key={it.index}
                    style={{ cursor: 'default', alignItems: 'start' }}
                  >
                    <Icon name={itemKind(it.files)} className="drag" />
                    <div
                      style={{
                        width: 50,
                        height: 50,
                        borderRadius: 7,
                        display: 'grid',
                        placeItems: 'center',
                        background: 'var(--fill)',
                      }}
                    >
                      <Icon
                        name={
                          it.status === 'success'
                            ? 'check_circle'
                            : it.status === 'error'
                              ? 'error'
                              : 'menu_book'
                        }
                        style={{
                          color:
                            it.status === 'success'
                              ? '#7fa86b'
                              : it.status === 'error'
                                ? '#b85c4a'
                                : 'var(--text-faint)',
                        }}
                      />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <input
                        className="fld"
                        value={it.title}
                        placeholder="Title"
                        disabled={submitting || it.status === 'success'}
                        onChange={(e) =>
                          patchItem(it.index, { title: e.target.value })
                        }
                        style={{ padding: '6px 10px', fontSize: 13.5 }}
                      />
                      {!isPodcast && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <input
                            className="fld"
                            value={it.author}
                            placeholder="Author"
                            disabled={submitting || it.status === 'success'}
                            onChange={(e) =>
                              patchItem(it.index, { author: e.target.value })
                            }
                            style={{ padding: '6px 10px', fontSize: 12.5 }}
                          />
                          <input
                            className="fld"
                            value={it.series}
                            placeholder="Series (optional)"
                            disabled={submitting || it.status === 'success'}
                            onChange={(e) =>
                              patchItem(it.index, { series: e.target.value })
                            }
                            style={{ padding: '6px 10px', fontSize: 12.5 }}
                          />
                        </div>
                      )}
                      <div
                        className="ll-sub"
                        style={{ marginTop: 4, fontFamily: 'var(--font-mono)' }}
                      >
                        {it.files.length} file
                        {it.files.length === 1 ? '' : 's'}
                        {it.status === 'uploading' &&
                          ` · ${Math.round(it.progress * 100)}%`}
                        {it.status === 'error' && ' · failed'}
                      </div>
                    </div>
                    <span className="ll-col mono">{humanSize(totalBytes)}</span>
                    <button
                      className="tbl-icon"
                      disabled={submitting}
                      onClick={() => removeItem(it.index)}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="action-bar">
              <button
                className="btn-sm btn-ghost"
                disabled={submitting}
                onClick={() => filePicker.current?.click()}
              >
                <Icon name="add" /> Add more
              </button>
              <button
                className="btn-sm btn-green"
                style={{ marginLeft: 'auto' }}
                disabled={submitting || pendingCount === 0 || !selectedFolderId}
                onClick={submit}
              >
                <Icon name="upload" />
                {submitting
                  ? 'Uploading…'
                  : `Upload ${pendingCount} item${pendingCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}
      </div>

      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </div>
  )
}
