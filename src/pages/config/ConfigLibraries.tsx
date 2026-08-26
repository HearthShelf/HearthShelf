import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getLibraries, libraryKeys } from '@/api/libraries'
import type { ABSLibrariesResponse } from '@/api/types'
import {
  scanLibrary,
  updateLibrary,
  deleteLibrary,
  matchAllLibraryItems,
  reorderLibraries,
  removeLibraryMetadata,
  createLibrary,
  type LibraryUpdatePayload,
} from '@/api/admin'
import type { ABSLibrary } from '@/api/types'
import { libraryIcon } from '@/hooks/useActiveLibrary'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LibraryEditModal } from '@/components/config/LibraryEditModal'
import { Modal } from '@/components/common/Modal'
import { SelectField } from '@/components/common/SelectField'

export function ConfigLibraries() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: libraryKeys.all,
    queryFn: getLibraries,
    staleTime: 5 * 60 * 1000,
  })

  // Order is derived straight from query data (sorted by displayOrder). Drag
  // reorder writes an optimistic, already-sorted list back into the cache, so the
  // query stays the single source of truth - no local copy, no effect.
  const order = useMemo(
    () =>
      data?.libraries ? [...data.libraries].sort((a, b) => a.displayOrder - b.displayOrder) : [],
    [data],
  )

  const [editId, setEditId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [scanning, setScanning] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // New library creation
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<'book' | 'podcast'>('book')
  const [newPath, setNewPath] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const dragIdx = useRef<number | null>(null)

  const editTarget = order.find((l) => l.id === editId)
  const deleteTarget = order.find((l) => l.id === deleteId)

  const flash = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3000)
  }

  const scan = async (id: string) => {
    setScanning(id)
    try {
      await scanLibrary(id)
    } finally {
      setScanning(null)
    }
  }

  const persistOrder = async (next: ABSLibrary[]) => {
    // Optimistically reflect the new order in the cache (rewrite displayOrder so
    // the memo re-sorts to match), then persist.
    const renumbered = next.map((l, i) => ({ ...l, displayOrder: i }))
    qc.setQueryData<ABSLibrariesResponse>(libraryKeys.all, (prev) =>
      prev ? { ...prev, libraries: renumbered } : prev,
    )
    try {
      await reorderLibraries(renumbered.map((l) => ({ id: l.id, newOrder: l.displayOrder })))
      qc.invalidateQueries({ queryKey: libraryKeys.all })
    } catch {
      flash('Could not save the new order.')
      qc.invalidateQueries({ queryKey: libraryKeys.all })
    }
  }

  const moveLibrary = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return
    const next = [...order]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    void persistOrder(next)
  }

  const saveEdit = async (patch: LibraryUpdatePayload) => {
    if (!editId) return
    if (!Object.keys(patch).length) {
      setEditId(null)
      flash('No changes to save.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await updateLibrary(editId, patch)
      qc.invalidateQueries({ queryKey: libraryKeys.all })
      setEditId(null)
      flash('Library saved.')
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save the library.')
    } finally {
      setSaving(false)
    }
  }

  const matchAll = async () => {
    if (!editId) return
    try {
      await matchAllLibraryItems(editId)
      flash('Matching started in the background.')
    } catch {
      flash('Could not start matching.')
    }
  }

  const removeMetadata = async (ext: 'json' | 'abs') => {
    if (!editId) return
    try {
      const res = await removeLibraryMetadata(editId, ext)
      flash(
        res.removed
          ? `Removed ${res.removed} ${ext} file${res.removed === 1 ? '' : 's'}.`
          : `No ${ext} files found to remove.`,
      )
    } catch {
      flash('Could not remove metadata files.')
    }
  }

  const confirmDelete = async () => {
    if (!deleteId) return
    await deleteLibrary(deleteId)
    qc.invalidateQueries({ queryKey: libraryKeys.all })
  }

  const submitCreate = async () => {
    if (!newName.trim() || !newPath.trim()) return
    setCreateBusy(true)
    setCreateError(null)
    try {
      await createLibrary({ name: newName.trim(), mediaType: newType, fullPath: newPath.trim() })
      qc.invalidateQueries({ queryKey: libraryKeys.all })
      setCreating(false)
      setNewName('')
      setNewPath('')
      setNewType('book')
      flash('Library created.')
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create library.')
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Libraries</h1>
        {data && <p className="page-sub">{order.length} libraries · drag to reorder</p>}
        <button
          className="btn-sm btn-primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            setCreateError(null)
            setCreating(true)
          }}
        >
          <Icon name="add" /> New library
        </button>
      </div>

      {toast && (
        <div
          className="cfg-card"
          style={{
            marginBottom: 'var(--s4)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Icon name="info" style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13.5 }}>{toast}</span>
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner className="py-12" label="Loading libraries..." />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>Name</th>
                <th>Type</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {order.map((l, i) => (
                <tr
                  key={l.id}
                  draggable
                  onDragStart={() => (dragIdx.current = i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx.current != null) moveLibrary(dragIdx.current, i)
                    dragIdx.current = null
                  }}
                >
                  <td>
                    <Icon
                      name="drag_indicator"
                      style={{ color: 'var(--text-muted)', cursor: 'grab' }}
                    />
                  </td>
                  <td>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 10,
                        fontWeight: 600,
                      }}
                    >
                      <Icon name={libraryIcon(l)} style={{ color: 'var(--accent)' }} />
                      {l.name}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {l.mediaType === 'podcast' ? 'Podcasts' : 'Audiobooks'}
                  </td>
                  <td>
                    <div className="t-actions">
                      <button
                        className="tbl-icon"
                        title="Scan library"
                        disabled={scanning === l.id}
                        onClick={() => void scan(l.id)}
                      >
                        <Icon name={scanning === l.id ? 'hourglass_empty' : 'sync'} />
                      </button>
                      <button
                        className="tbl-icon"
                        title="Edit library"
                        onClick={() => {
                          setSaveError(null)
                          setEditId(l.id)
                        }}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        className="tbl-icon"
                        title="Delete library"
                        onClick={() => setDeleteId(l.id)}
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
      )}

      {editTarget && (
        <LibraryEditModal
          key={editTarget.id}
          library={editTarget}
          busy={saving}
          error={saveError}
          onSave={(patch) => void saveEdit(patch)}
          onMatchAll={() => void matchAll()}
          onRemoveMetadata={(ext) => void removeMetadata(ext)}
          onClose={() => setEditId(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete library?"
          message={`"${deleteTarget.name}" will be removed from AudiobookShelf. Your audio files on disk are not deleted.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleteId(null)}
        />
      )}

      {creating && (
        <Modal
          title="New library"
          onClose={() => setCreating(false)}
          foot={
            <>
              <div style={{ flex: 1 }} />
              <button className="btn-sm btn-ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                className="btn-sm btn-primary"
                disabled={createBusy || !newName.trim() || !newPath.trim()}
                onClick={() => void submitCreate()}
              >
                <Icon name="add" /> {createBusy ? 'Creating…' : 'Create'}
              </button>
            </>
          }
        >
          {createError && (
            <div
              style={{
                fontSize: 13,
                color: '#e8897f',
                background: 'color-mix(in oklab, #d8443a 14%, transparent)',
                border: '1px solid color-mix(in oklab, #d8443a 40%, transparent)',
                borderRadius: 10,
                padding: '8px 12px',
                marginBottom: 14,
              }}
            >
              {createError}
            </div>
          )}
          <div className="cfg-line" style={{ gap: 12 }}>
            <div className="cl-meta" style={{ width: 130, flex: 'none' }}>
              <div className="cl-t">Name</div>
            </div>
            <input
              className="fld"
              style={{ flex: 1 }}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="My Audiobooks"
              autoFocus
            />
          </div>
          <div className="cfg-line" style={{ gap: 12, marginTop: 'var(--s3)' }}>
            <div className="cl-meta" style={{ width: 130, flex: 'none' }}>
              <div className="cl-t">Type</div>
            </div>
            <SelectField
              style={{ flex: 1 }}
              value={newType}
              onChange={(next) => setNewType(next as 'book' | 'podcast')}
              options={[
                { value: 'book', label: 'Audiobooks' },
                { value: 'podcast', label: 'Podcasts' },
              ]}
            />
          </div>
          <div className="cfg-line" style={{ gap: 12, marginTop: 'var(--s3)' }}>
            <div className="cl-meta" style={{ width: 130, flex: 'none' }}>
              <div className="cl-t">Folder path</div>
              <div className="cl-d">On the server</div>
            </div>
            <input
              className="fld"
              style={{ flex: 1 }}
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/audiobooks"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreate()
              }}
            />
          </div>
          <p className="hint" style={{ margin: '10px 2px 0', fontSize: 12 }}>
            The folder must exist inside the container. More folders and settings can be configured
            after creation.
          </p>
        </Modal>
      )}
    </>
  )
}
