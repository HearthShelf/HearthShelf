import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSearchProviders } from '@/api/libraries'
import { checkFolderExists } from '@/api/admin'
import type {
  LibraryFolderInput,
  LibraryUpdatePayload,
} from '@/api/admin'
import type { ABSLibrary, ABSLibrarySettings } from '@/api/types'
import { Icon } from '@/components/common/Icon'
import { Modal } from '@/components/common/Modal'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'

// ABS's library icon names. HearthShelf can't render ABS's icon font, so we map
// every name to a Material Symbol for display, but the original name round-trips
// on save so the value stays meaningful to native ABS clients.
const ICON_OPTIONS: { value: string; symbol: string; label: string }[] = [
  { value: 'database', symbol: 'database', label: 'Database' },
  { value: 'audiobookshelf', symbol: 'menu_book', label: 'Audiobookshelf' },
  { value: 'books-1', symbol: 'auto_stories', label: 'Books 1' },
  { value: 'books-2', symbol: 'library_books', label: 'Books 2' },
  { value: 'book-1', symbol: 'book', label: 'Book' },
  { value: 'microphone-1', symbol: 'mic', label: 'Microphone 1' },
  { value: 'microphone-3', symbol: 'podcasts', label: 'Microphone 3' },
  { value: 'radio', symbol: 'radio', label: 'Radio' },
  { value: 'podcast', symbol: 'podcasts', label: 'Podcast' },
  { value: 'rss', symbol: 'rss_feed', label: 'RSS' },
  { value: 'headphones', symbol: 'headphones', label: 'Headphones' },
  { value: 'music', symbol: 'music_note', label: 'Music' },
  { value: 'file-picture', symbol: 'image', label: 'Picture' },
  { value: 'rocket', symbol: 'rocket_launch', label: 'Rocket' },
  { value: 'power', symbol: 'bolt', label: 'Power' },
  { value: 'star', symbol: 'star', label: 'Star' },
  { value: 'heart', symbol: 'favorite', label: 'Heart' },
]

// Podcast search regions ABS supports (subset matching its dropdown).
const PODCAST_REGIONS = ['us', 'ca', 'uk', 'au', 'de', 'fr', 'es', 'it', 'jp']

// Metadata precedence sources, in ABS's canonical default order (highest first
// when reversed for the payload). Labels mirror the ABS scanner tab.
const METADATA_SOURCES: { id: string; name: string }[] = [
  { id: 'folderStructure', name: 'Folder structure' },
  { id: 'audioMetatags', name: 'Audio file meta tags OR ebook metadata' },
  { id: 'nfoFile', name: 'NFO file' },
  { id: 'txtFiles', name: 'desc.txt & reader.txt files' },
  { id: 'opfFile', name: 'OPF file' },
  { id: 'absMetadata', name: 'Audiobookshelf metadata file' },
]
const DEFAULT_PRECEDENCE = METADATA_SOURCES.map((s) => s.id)

const ERR_STYLE: CSSProperties = {
  fontSize: 13,
  color: '#e8897f',
  background: 'color-mix(in oklab, #d8443a 14%, transparent)',
  border: '1px solid color-mix(in oklab, #d8443a 40%, transparent)',
  borderRadius: 10,
  padding: '8px 12px',
  margin: '0 0 14px',
}

function Toggle({
  on,
  onChange,
  label,
  hint,
  disabled,
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <div className="cfg-line">
      <div className="cl-meta" style={{ flex: 1 }}>
        <div className="cl-t">{label}</div>
        {hint && <div className="cl-d">{hint}</div>}
      </div>
      <button
        type="button"
        className={(on ? 'toggle on' : 'toggle') + (disabled ? ' disabled' : '')}
        aria-pressed={on}
        disabled={disabled}
        onClick={() => !disabled && onChange(!on)}
      >
        <i />
      </button>
    </div>
  )
}

function Field({
  label,
  children,
  width = 150,
}: {
  label: string
  children: React.ReactNode
  width?: number
}) {
  return (
    <div className="cfg-line" style={{ gap: 12 }}>
      <div className="cl-meta" style={{ width, flex: 'none' }}>
        <div className="cl-t">{label}</div>
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}

// One editable settings shape held in component state; mapped to the ABS
// settings payload on save. markAsFinishedWhen + value collapse the two
// mutually-exclusive ABS fields into one control.
interface DraftSettings {
  squareCovers: boolean
  enableWatcher: boolean
  skipAsin: boolean
  skipIsbn: boolean
  audiobooksOnly: boolean
  epubsScripted: boolean
  hideSingleBookSeries: boolean
  onlyLaterBooks: boolean
  podcastSearchRegion: string
  markAsFinishedWhen: 'timeRemaining' | 'percentComplete'
  markAsFinishedValue: string
  autoScanCron: string | null
  metadataPrecedence: string[]
}

function settingsFromLibrary(s: ABSLibrarySettings): DraftSettings {
  const timeRemaining = s.markAsFinishedTimeRemaining
  const percent = s.markAsFinishedPercentComplete
  const when: 'timeRemaining' | 'percentComplete' =
    percent != null && !timeRemaining ? 'percentComplete' : 'timeRemaining'
  return {
    squareCovers: s.coverAspectRatio === 1,
    enableWatcher: !s.disableWatcher,
    skipAsin: !!s.skipMatchingMediaWithAsin,
    skipIsbn: !!s.skipMatchingMediaWithIsbn,
    audiobooksOnly: !!s.audiobooksOnly,
    epubsScripted: !!s.epubsAllowScriptedContent,
    hideSingleBookSeries: !!s.hideSingleBookSeries,
    onlyLaterBooks: !!s.onlyShowLaterBooksInContinueSeries,
    podcastSearchRegion: s.podcastSearchRegion || 'us',
    markAsFinishedWhen: when,
    markAsFinishedValue: String(
      (when === 'timeRemaining' ? timeRemaining : percent) ?? 10
    ),
    autoScanCron: s.autoScanCronExpression ?? null,
    metadataPrecedence:
      s.metadataPrecedence && s.metadataPrecedence.length
        ? [...s.metadataPrecedence]
        : [...DEFAULT_PRECEDENCE],
  }
}

interface LibraryEditModalProps {
  library: ABSLibrary
  busy?: boolean
  error?: string | null
  onSave: (patch: LibraryUpdatePayload) => void
  onMatchAll: () => void
  onRemoveMetadata: (ext: 'json' | 'abs') => void
  onClose: () => void
}

// The full ABS "Update Library" modal: Details (name/provider/icon/folders),
// Settings (display + scan toggles + mark-as-finished), Scanner (metadata
// precedence reorder, book libraries only), Schedule (auto-scan cron), and Tools
// (match all books, remove metadata files). Only changed fields are sent.
export function LibraryEditModal({
  library,
  busy,
  error,
  onSave,
  onMatchAll,
  onRemoveMetadata,
  onClose,
}: LibraryEditModalProps) {
  const isBook = library.mediaType === 'book'
  const TABS = useMemo(
    () =>
      [
        'Details',
        'Settings',
        ...(isBook ? ['Scanner'] : []),
        'Schedule',
        'Tools',
      ] as const,
    [isBook]
  )
  const [tab, setTab] = useState<string>('Details')

  const { data: providersData } = useQuery({
    queryKey: ['admin', 'search-providers'],
    queryFn: getSearchProviders,
    staleTime: 5 * 60 * 1000,
  })
  const providers =
    (isBook
      ? providersData?.providers.books
      : providersData?.providers.podcasts) ?? []

  // --- Details ---
  const [name, setName] = useState(library.name)
  const [provider, setProvider] = useState(library.provider)
  const [icon, setIcon] = useState(library.icon)
  const [folders, setFolders] = useState<LibraryFolderInput[]>(
    library.folders.map((f) => ({ id: f.id, fullPath: f.fullPath }))
  )
  const [newFolder, setNewFolder] = useState('')
  const [newFolderState, setNewFolderState] = useState<
    'idle' | 'checking' | 'exists' | 'missing' | 'unknown'
  >('idle')
  const [removeFolderIdx, setRemoveFolderIdx] = useState<number | null>(null)

  // --- Settings + Scanner + Schedule (one draft blob) ---
  const [s, setS] = useState<DraftSettings>(() =>
    settingsFromLibrary(library.settings)
  )
  const patchS = (p: Partial<DraftSettings>) => setS((cur) => ({ ...cur, ...p }))

  // --- Tools confirms ---
  const [confirmMeta, setConfirmMeta] = useState<'json' | 'abs' | null>(null)
  const [confirmMatch, setConfirmMatch] = useState(false)

  // Drag state for folder + precedence reorder.
  const dragIdx = useRef<number | null>(null)

  const addNewFolder = async () => {
    const p = newFolder.trim()
    if (!p) return
    setNewFolderState('checking')
    const result = await checkFolderExists(p)
    setNewFolderState(result)
    setFolders((cur) => [...cur, { fullPath: p }])
    setNewFolder('')
    setNewFolderState('idle')
  }

  const moveFolder = (from: number, to: number) => {
    if (to < 0 || to >= folders.length) return
    setFolders((cur) => {
      const next = [...cur]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const movePrecedence = (from: number, to: number) => {
    if (to < 0 || to >= s.metadataPrecedence.length) return
    const next = [...s.metadataPrecedence]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    patchS({ metadataPrecedence: next })
  }

  const resetPrecedence = () =>
    patchS({ metadataPrecedence: [...DEFAULT_PRECEDENCE] })

  const submit = () => {
    const patch: LibraryUpdatePayload = {}
    if (name.trim() && name.trim() !== library.name) patch.name = name.trim()
    if (provider !== library.provider) patch.provider = provider
    if (icon !== library.icon) patch.icon = icon

    // Folders: send the whole list only if it changed (by path order/membership).
    const beforeKey = library.folders.map((f) => f.fullPath).join(',')
    const afterKey = folders.map((f) => f.fullPath).join(',')
    if (beforeKey !== afterKey) {
      patch.folders = folders.map((f) =>
        f.id ? { id: f.id, fullPath: f.fullPath } : { fullPath: f.fullPath }
      )
    }

    // Settings - build the full blob, then diff against the library's settings.
    const timeRemaining =
      s.markAsFinishedWhen === 'timeRemaining' ? Number(s.markAsFinishedValue) : null
    const percentComplete =
      s.markAsFinishedWhen === 'percentComplete' ? Number(s.markAsFinishedValue) : null
    const nextSettings: Partial<ABSLibrarySettings> = {
      coverAspectRatio: s.squareCovers ? 1 : 0,
      disableWatcher: !s.enableWatcher,
      autoScanCronExpression: s.autoScanCron,
      markAsFinishedTimeRemaining: timeRemaining,
      markAsFinishedPercentComplete: percentComplete,
    }
    if (isBook) {
      nextSettings.skipMatchingMediaWithAsin = s.skipAsin
      nextSettings.skipMatchingMediaWithIsbn = s.skipIsbn
      nextSettings.audiobooksOnly = s.audiobooksOnly
      nextSettings.epubsAllowScriptedContent = s.epubsScripted
      nextSettings.hideSingleBookSeries = s.hideSingleBookSeries
      nextSettings.onlyShowLaterBooksInContinueSeries = s.onlyLaterBooks
      nextSettings.metadataPrecedence = s.metadataPrecedence
    } else {
      nextSettings.podcastSearchRegion = s.podcastSearchRegion
    }

    const changedSettings: Partial<ABSLibrarySettings> = {}
    const before = library.settings as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(nextSettings)) {
      const prev = before[k]
      const differs = Array.isArray(v)
        ? JSON.stringify(v) !== JSON.stringify(prev)
        : v !== prev
      if (differs) {
        ;(changedSettings as Record<string, unknown>)[k] = v
      }
    }
    if (Object.keys(changedSettings).length) patch.settings = changedSettings

    onSave(patch)
  }

  return (
    <>
      <Modal
        title={`Edit ${library.name}`}
        onClose={onClose}
        tabs={[...TABS]}
        tab={tab}
        setTab={setTab}
        foot={
          <>
            <div style={{ flex: 1 }} />
            <button className="btn-sm btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-sm btn-green"
              disabled={busy}
              onClick={submit}
            >
              <Icon name="save" /> {busy ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        {error && <div style={ERR_STYLE}>{error}</div>}

        {/* --- Details --- */}
        {tab === 'Details' && (
          <>
            <Field label="Name">
              <input
                className="fld"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Metadata provider">
              <select
                className="fld"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                {providers.length === 0 && (
                  <option value={provider}>{provider}</option>
                )}
                {providers.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.text}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Icon">
              <select
                className="fld"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
              >
                {ICON_OPTIONS.every((o) => o.value !== icon) && (
                  <option value={icon}>{icon}</option>
                )}
                {ICON_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="section-head" style={{ marginTop: 'var(--s5)' }}>
              <Icon name="folder" />
              <h2>Folders</h2>
            </div>
            <div className="cfg-card">
              {folders.map((f, i) => (
                <div
                  className="cfg-line"
                  key={f.id ?? f.fullPath}
                  draggable
                  onDragStart={() => (dragIdx.current = i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx.current != null) moveFolder(dragIdx.current, i)
                    dragIdx.current = null
                  }}
                >
                  <Icon
                    name="drag_indicator"
                    style={{ color: 'var(--text-muted)', cursor: 'grab' }}
                  />
                  <Icon name="folder" style={{ color: '#d9c25a' }} />
                  <div
                    className="cl-meta"
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
                  >
                    <div
                      className="cl-t"
                      style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {f.fullPath}
                    </div>
                    {!f.id && <div className="cl-d">New folder</div>}
                  </div>
                  <button
                    className="tbl-icon"
                    title="Remove folder"
                    onClick={() =>
                      // Removing an existing folder deletes its items in ABS -
                      // confirm. A brand-new (unsaved) folder is removed inline.
                      f.id
                        ? setRemoveFolderIdx(i)
                        : setFolders((cur) => cur.filter((_, x) => x !== i))
                    }
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
              <div className="cfg-line" style={{ gap: 8 }}>
                <Icon name="add" style={{ color: 'var(--text-muted)' }} />
                <input
                  className="fld"
                  placeholder="/audiobooks/new-folder"
                  value={newFolder}
                  onChange={(e) => setNewFolder(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addNewFolder()
                  }}
                />
                <button
                  className="btn-sm"
                  style={{ flex: 'none' }}
                  disabled={!newFolder.trim() || newFolderState === 'checking'}
                  onClick={() => void addNewFolder()}
                >
                  <Icon name="add" /> Add
                </button>
              </div>
              <p className="hint" style={{ margin: '4px 2px 0', fontSize: 12 }}>
                Drag to reorder. The folder must exist on the server (inside the
                container). Removing a folder also removes its items from
                AudiobookShelf - the files on disk are kept.
              </p>
            </div>
          </>
        )}

        {/* --- Settings --- */}
        {tab === 'Settings' && (
          <div className="cfg-card">
            <Toggle
              label="Use square book covers"
              hint="Display covers as 1:1 squares instead of standard book shape."
              on={s.squareCovers}
              onChange={(v) => patchS({ squareCovers: v })}
            />
            <Toggle
              label="Enable folder watcher for this library"
              hint="Automatically scan new files as they are added."
              on={s.enableWatcher}
              onChange={(v) => patchS({ enableWatcher: v })}
            />
            {isBook && (
              <>
                <Toggle
                  label="Audiobooks only"
                  hint="Ignore ebook files when scanning this library."
                  on={s.audiobooksOnly}
                  onChange={(v) => patchS({ audiobooksOnly: v })}
                />
                <Toggle
                  label="Skip matching books with ASIN"
                  on={s.skipAsin}
                  onChange={(v) => patchS({ skipAsin: v })}
                />
                <Toggle
                  label="Skip matching books with ISBN"
                  on={s.skipIsbn}
                  onChange={(v) => patchS({ skipIsbn: v })}
                />
                <Toggle
                  label="Hide single book series"
                  hint="Do not show series that only have one book."
                  on={s.hideSingleBookSeries}
                  onChange={(v) => patchS({ hideSingleBookSeries: v })}
                />
                <Toggle
                  label="Only show later books in Continue Series"
                  hint="Skip books earlier than the max sequence you have read."
                  on={s.onlyLaterBooks}
                  onChange={(v) => patchS({ onlyLaterBooks: v })}
                />
                <Toggle
                  label="Allow scripted content in EPUBs"
                  hint="Permit JavaScript in the ebook reader (less safe)."
                  on={s.epubsScripted}
                  onChange={(v) => patchS({ epubsScripted: v })}
                />
              </>
            )}
            {!isBook && (
              <Field label="Podcast search region" width={180}>
                <select
                  className="fld"
                  value={s.podcastSearchRegion}
                  onChange={(e) => patchS({ podcastSearchRegion: e.target.value })}
                >
                  {PODCAST_REGIONS.map((r) => (
                    <option key={r} value={r}>
                      {r.toUpperCase()}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="cfg-line" style={{ gap: 12, alignItems: 'flex-end' }}>
              <div className="cl-meta" style={{ width: 180, flex: 'none' }}>
                <div className="cl-t">Mark as finished when</div>
              </div>
              <select
                className="fld"
                style={{ flex: 1 }}
                value={s.markAsFinishedWhen}
                onChange={(e) =>
                  patchS({
                    markAsFinishedWhen: e.target.value as
                      | 'timeRemaining'
                      | 'percentComplete',
                  })
                }
              >
                <option value="timeRemaining">Time remaining (seconds)</option>
                <option value="percentComplete">Percent complete (%)</option>
              </select>
              <input
                className="fld"
                style={{ width: 90, flex: 'none' }}
                inputMode="numeric"
                value={s.markAsFinishedValue}
                onChange={(e) =>
                  patchS({
                    markAsFinishedValue: e.target.value.replace(/[^0-9]/g, ''),
                  })
                }
              />
            </div>
          </div>
        )}

        {/* --- Scanner (metadata precedence, books only) --- */}
        {tab === 'Scanner' && isBook && (
          <>
            <div
              className="cfg-line"
              style={{ justifyContent: 'space-between', marginBottom: 4 }}
            >
              <div className="cl-meta">
                <div className="cl-t">Metadata order of precedence</div>
                <div className="cl-d">
                  Sources higher in the list win when metadata conflicts. Drag to
                  reorder.
                </div>
              </div>
              <button className="btn-sm" onClick={resetPrecedence}>
                Reset
              </button>
            </div>
            <div className="cfg-card">
              {s.metadataPrecedence.map((id, i) => {
                const src = METADATA_SOURCES.find((m) => m.id === id)
                return (
                  <div
                    className="cfg-line"
                    key={id}
                    draggable
                    onDragStart={() => (dragIdx.current = i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIdx.current != null)
                        movePrecedence(dragIdx.current, i)
                      dragIdx.current = null
                    }}
                  >
                    <Icon
                      name="drag_indicator"
                      style={{ color: 'var(--text-muted)', cursor: 'grab' }}
                    />
                    <div
                      style={{ width: 22, textAlign: 'center', color: 'var(--text-muted)' }}
                    >
                      {i + 1}
                    </div>
                    <div className="cl-meta" style={{ flex: 1 }}>
                      <div className="cl-t">{src?.name ?? id}</div>
                    </div>
                    <div className="t-actions">
                      <button
                        className="tbl-icon"
                        title="Move up"
                        disabled={i === 0}
                        onClick={() => movePrecedence(i, i - 1)}
                      >
                        <Icon name="arrow_upward" />
                      </button>
                      <button
                        className="tbl-icon"
                        title="Move down"
                        disabled={i === s.metadataPrecedence.length - 1}
                        onClick={() => movePrecedence(i, i + 1)}
                      >
                        <Icon name="arrow_downward" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* --- Schedule (auto-scan cron) --- */}
        {tab === 'Schedule' && (
          <div className="cfg-card">
            <Toggle
              label="Schedule automatic scans"
              hint="Periodically rescan this library on a cron schedule."
              on={s.autoScanCron != null}
              onChange={(v) =>
                patchS({ autoScanCron: v ? s.autoScanCron || '0 0 * * 1' : null })
              }
            />
            {s.autoScanCron != null && (
              <Field label="Cron expression" width={150}>
                <input
                  className="fld"
                  placeholder="0 0 * * 1"
                  value={s.autoScanCron}
                  onChange={(e) => patchS({ autoScanCron: e.target.value })}
                />
              </Field>
            )}
            <p className="hint" style={{ margin: '4px 2px 0', fontSize: 12 }}>
              Standard cron format (minute hour day month weekday). Example:{' '}
              <code>0 0 * * 1</code> runs every Monday at midnight.
            </p>
          </div>
        )}

        {/* --- Tools --- */}
        {tab === 'Tools' && (
          <>
            {isBook && (
              <div className="cfg-card" style={{ marginBottom: 'var(--s4)' }}>
                <div className="cfg-line">
                  <div className="cl-meta" style={{ flex: 1 }}>
                    <div className="cl-t">Match all books</div>
                    <div className="cl-d">
                      Quick-match every book in this library against the metadata
                      provider. Runs in the background.
                    </div>
                  </div>
                  <button
                    className="btn-sm"
                    onClick={() => setConfirmMatch(true)}
                  >
                    <Icon name="auto_fix_high" /> Match all
                  </button>
                </div>
              </div>
            )}
            <div className="cfg-card">
              <div className="cfg-line">
                <div className="cl-meta" style={{ flex: 1 }}>
                  <div className="cl-t">Remove metadata files</div>
                  <div className="cl-d">
                    Delete metadata sidecar files written into each {library.mediaType}{' '}
                    folder on disk.
                  </div>
                </div>
                <div className="t-actions" style={{ gap: 8 }}>
                  <button
                    className="btn-sm"
                    onClick={() => setConfirmMeta('json')}
                  >
                    metadata.json
                  </button>
                  <button
                    className="btn-sm"
                    onClick={() => setConfirmMeta('abs')}
                  >
                    .abs files
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </Modal>

      {removeFolderIdx != null && (
        <ConfirmDialog
          title="Remove folder?"
          message={`"${folders[removeFolderIdx]?.fullPath}" and all of its items will be removed from AudiobookShelf when you save. The files on disk are kept.`}
          confirmLabel="Remove"
          danger
          onConfirm={() => {
            setFolders((cur) => cur.filter((_, x) => x !== removeFolderIdx))
          }}
          onClose={() => setRemoveFolderIdx(null)}
        />
      )}

      {confirmMatch && (
        <ConfirmDialog
          title="Match all books?"
          message="Every book in this library will be quick-matched against the metadata provider. This runs as a background task and may overwrite existing metadata."
          confirmLabel="Match all"
          onConfirm={onMatchAll}
          onClose={() => setConfirmMatch(false)}
        />
      )}

      {confirmMeta && (
        <ConfirmDialog
          title="Remove metadata files?"
          message={`This permanently deletes the ${
            confirmMeta === 'json' ? 'metadata.json' : '.abs metadata'
          } files inside every item folder on disk. This cannot be undone.`}
          confirmLabel="Remove"
          danger
          onConfirm={() => onRemoveMetadata(confirmMeta)}
          onClose={() => setConfirmMeta(null)}
        />
      )}
    </>
  )
}
