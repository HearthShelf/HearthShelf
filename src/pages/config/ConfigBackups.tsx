import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getBackups,
  runBackup,
  deleteBackup,
  applyBackup,
  uploadBackup,
  downloadBackupBlob,
  getServerSettings,
  updateServerSettings,
  adminKeys,
} from '@/api/admin'
import {
  getHsBackups,
  runHsBackup,
  setHsBackupConfig,
  deleteHsBackup,
  downloadHsBackup,
  uploadHsBackup,
  restoreHsBackup,
  downloadArchive,
  restoreArchive,
  saveBlob,
  backupKeys,
} from '@/api/backups'
import { Icon } from '@/components/common/Icon'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useToast } from '@/hooks/useToast'

function fmtBytes(b: number): string {
  const mb = b / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  if (mb >= 1) return `${mb.toFixed(0)} MB`
  return `${Math.max(1, Math.round(b / 1024))} KB`
}

function fmtDate(ms: number): string {
  if (!ms) return '-'
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

// Cron presets the schedule dropdown offers. 'custom' lets the admin type one.
const SCHEDULE_PRESETS: { value: string; label: string }[] = [
  { value: '', label: 'Off - no automatic backups' },
  { value: '0 1 * * *', label: 'Every day at 1:00 AM' },
  { value: '30 1 * * *', label: 'Every day at 1:30 AM' },
  { value: '0 3 * * *', label: 'Every day at 3:00 AM' },
  { value: '0 1 * * 0', label: 'Every Sunday at 1:00 AM' },
]

// A schedule control shared by both sections: a preset dropdown plus a custom
// cron field when the current value isn't a preset. `locked` disables it (env).
function ScheduleField({
  value,
  onChange,
  locked,
}: {
  value: string
  onChange: (cron: string) => void
  locked?: boolean
}) {
  const isPreset = SCHEDULE_PRESETS.some((p) => p.value === value)
  const [custom, setCustom] = useState(!isPreset && value !== '')
  return (
    <div className="field full">
      <label>Automatic backup schedule</label>
      <select
        className="fld"
        disabled={locked}
        value={custom ? 'custom' : value}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustom(true)
          } else {
            setCustom(false)
            onChange(e.target.value)
          }
        }}
      >
        {SCHEDULE_PRESETS.map((p) => (
          <option key={p.value || 'off'} value={p.value}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom schedule...</option>
      </select>
      {custom && (
        <input
          className="fld"
          style={{ marginTop: 'var(--s3)', fontFamily: 'var(--font-mono)' }}
          disabled={locked}
          placeholder="minute hour day month weekday (e.g. 0 1 * * *)"
          defaultValue={isPreset ? '' : value}
          onBlur={(e) => onChange(e.target.value.trim())}
        />
      )}
      {locked && <p className="field-hint">Set by environment - edit the env var to change this.</p>}
    </div>
  )
}

export function ConfigBackups() {
  const qc = useQueryClient()
  const { toast, show } = useToast()
  const absFileRef = useRef<HTMLInputElement>(null)
  const hsFileRef = useRef<HTMLInputElement>(null)
  const archiveFileRef = useRef<HTMLInputElement>(null)

  // Confirm-dialog state (one at a time), tagged by action.
  const [confirm, setConfirm] = useState<null | {
    title: string
    message: string
    danger?: boolean
    confirmLabel: string
    run: () => Promise<void>
  }>(null)
  const [busy, setBusy] = useState('')

  // --- ABS side ---
  const absQ = useQuery({ queryKey: adminKeys.backups, queryFn: getBackups, staleTime: 60_000 })
  const settingsQ = useQuery({
    queryKey: ['admin', 'serverSettings'],
    queryFn: getServerSettings,
    staleTime: 60_000,
  })
  // --- HS side ---
  const hsQ = useQuery({ queryKey: backupKeys.list, queryFn: getHsBackups, staleTime: 60_000 })

  const absBackups = absQ.data?.backups ?? []
  const hsBackups = hsQ.data?.backups ?? []
  const hsConfig = hsQ.data?.config
  const settings = settingsQ.data

  const absSchedule = settings?.backupSchedule
  const absScheduleOff = !absSchedule
  const hsScheduleOff = !hsConfig?.schedule

  const withBusy = async (tag: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(tag)
    try {
      await fn()
      if (ok) show(ok)
    } catch (e) {
      show(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy('')
    }
  }

  // ABS actions
  const patchAbsSchedule = (backupSchedule: string) =>
    withBusy('abs-sched', async () => {
      await updateServerSettings({ backupSchedule })
      await settingsQ.refetch()
    }, 'Schedule saved')

  const patchAbsKeep = (backupsToKeep: number) =>
    withBusy('abs-keep', async () => {
      await updateServerSettings({ backupsToKeep })
      await settingsQ.refetch()
    }, 'Saved')

  // HS actions
  const patchHsConfig = (patch: { schedule?: string; keep?: number }) =>
    withBusy('hs-cfg', async () => {
      await setHsBackupConfig(patch)
      await hsQ.refetch()
    }, 'Saved')

  const runHs = () =>
    withBusy('hs-run', async () => {
      await runHsBackup()
      // The job runs in the background; poll once shortly after.
      setTimeout(() => qc.invalidateQueries({ queryKey: backupKeys.list }), 1500)
    }, 'Backup started')

  const runAbs = () =>
    withBusy('abs-run', async () => {
      await runBackup()
      await absQ.refetch()
    }, 'Backup created')

  return (
    <>
      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}

      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Backups</h1>
        <p className="page-sub">
          Two separate backups protect your server: one for your AudiobookShelf library and one for
          HearthShelf's own data. Both are set up here.
        </p>
      </div>

      {/* Off-schedule warning - this banner alone catches "0 backups". */}
      {(absScheduleOff || hsScheduleOff) && (
        <div className="banner warn" style={{ marginBottom: 'var(--s5)' }}>
          <Icon name="warning" />
          <span>
            Automatic backups are off for{' '}
            {absScheduleOff && hsScheduleOff
              ? 'both AudiobookShelf and HearthShelf'
              : absScheduleOff
                ? 'AudiobookShelf'
                : 'HearthShelf'}
            . Turn on a schedule below so your data is protected without remembering to run it.
          </span>
        </div>
      )}

      {/* ================= AudiobookShelf ================= */}
      <div className="section-head">
        <Icon name="menu_book" />
        <h2>AudiobookShelf backups</h2>
      </div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Your library database, book and author metadata, users, and listening progress. Does not
        include your audio files.
      </p>

      {settings && (
        <div className="cfg-card">
          <ScheduleField
            value={absSchedule || ''}
            onChange={patchAbsSchedule}
          />
          <div className="field full" style={{ marginTop: 'var(--s4)' }}>
            <label>How many backups to keep</label>
            <input
              className="fld"
              type="number"
              min={1}
              max={99}
              defaultValue={settings.backupsToKeep ?? 2}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10)
                if (Number.isFinite(n) && n > 0) patchAbsKeep(n)
              }}
            />
          </div>
        </div>
      )}

      <div className="tbl-wrap" style={{ marginTop: 'var(--s4)' }}>
        <div className="row-between" style={{ marginBottom: 'var(--s3)' }}>
          <div className="section-sub">Existing AudiobookShelf backups</div>
          <div style={{ display: 'flex', gap: 'var(--s2)' }}>
            <input
              ref={absFileRef}
              type="file"
              accept=".audiobookshelf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f)
                  void withBusy(
                    'abs-upload',
                    async () => {
                      await uploadBackup(f)
                      await absQ.refetch()
                    },
                    'Uploaded',
                  )
                e.target.value = ''
              }}
            />
            <button
              className="btn-sm btn-ghost"
              disabled={!!busy}
              onClick={() => absFileRef.current?.click()}
            >
              <Icon name="upload" /> Upload
            </button>
            <button className="btn-sm btn-accent" disabled={!!busy} onClick={() => void runAbs()}>
              <Icon name="cloud_sync" /> {busy === 'abs-run' ? 'Backing up...' : 'Back up now'}
            </button>
          </div>
        </div>
        {absQ.isLoading ? (
          <LoadingSpinner className="py-8" label="Loading..." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Backup</th>
                <th>Version</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {absBackups.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No backups yet.
                  </td>
                </tr>
              )}
              {absBackups.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontWeight: 600 }}>{b.datePretty}</td>
                  <td className="num">{b.serverVersion}</td>
                  <td className="num">{fmtBytes(b.fileSize)}</td>
                  <td className="row-actions">
                    <button
                      className="icon-btn"
                      title="Download"
                      onClick={() =>
                        void withBusy('', async () => {
                          const blob = await downloadBackupBlob(b.id)
                          saveBlob(blob, b.filename)
                        })
                      }
                    >
                      <Icon name="download" />
                    </button>
                    <button
                      className="icon-btn"
                      title="Restore this backup"
                      onClick={() =>
                        setConfirm({
                          title: 'Restore AudiobookShelf backup',
                          message:
                            'This replaces ALL AudiobookShelf data (library, users, progress) with this backup’s contents. HearthShelf data is separate and is not touched. Continue?',
                          danger: true,
                          confirmLabel: 'Restore',
                          run: () =>
                            withBusy('', async () => {
                              await applyBackup(b.id)
                            }, 'AudiobookShelf is restoring...'),
                        })
                      }
                    >
                      <Icon name="restore" />
                    </button>
                    <button
                      className="icon-btn danger"
                      title="Delete"
                      onClick={() =>
                        setConfirm({
                          title: 'Delete backup',
                          message: `Delete ${b.datePretty}? This cannot be undone.`,
                          danger: true,
                          confirmLabel: 'Delete',
                          run: () =>
                            withBusy('', async () => {
                              await deleteBackup(b.id)
                              await absQ.refetch()
                            }, 'Deleted'),
                        })
                      }
                    >
                      <Icon name="delete" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ================= HearthShelf ================= */}
      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="favorite" />
        <h2>HearthShelf backups</h2>
      </div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        HearthShelf's own data: settings, clubs, notes, reading history, profile photos, and
        integration config.
      </p>
      <div className="banner info" style={{ marginBottom: 'var(--s4)' }}>
        <Icon name="lock" />
        <span>Contains server secrets (API keys, tokens). Store a downloaded copy like a password.</span>
      </div>

      {hsConfig && (
        <div className="cfg-card">
          <ScheduleField
            value={hsConfig.schedule}
            locked={hsConfig.env.schedule}
            onChange={(schedule) => patchHsConfig({ schedule })}
          />
          <div className="field full" style={{ marginTop: 'var(--s4)' }}>
            <label>How many backups to keep</label>
            <input
              className="fld"
              type="number"
              min={1}
              max={99}
              disabled={hsConfig.env.keep}
              defaultValue={hsConfig.keep}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10)
                if (Number.isFinite(n) && n > 0 && n !== hsConfig.keep) patchHsConfig({ keep: n })
              }}
            />
            {hsConfig.env.keep && (
              <p className="field-hint">Set by environment - edit the env var to change this.</p>
            )}
          </div>
          {hsConfig.offBoxPath && (
            <p className="field-hint" style={{ marginTop: 'var(--s3)' }}>
              Also copying each backup to <code>{hsConfig.offBoxPath}</code>.
            </p>
          )}
        </div>
      )}

      <div className="tbl-wrap" style={{ marginTop: 'var(--s4)' }}>
        <div className="row-between" style={{ marginBottom: 'var(--s3)' }}>
          <div className="section-sub">Existing HearthShelf backups</div>
          <div style={{ display: 'flex', gap: 'var(--s2)' }}>
            <input
              ref={hsFileRef}
              type="file"
              accept=".hsbackup,.zip"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f)
                  void withBusy(
                    'hs-upload',
                    async () => {
                      await uploadHsBackup(f)
                      await hsQ.refetch()
                    },
                    'Uploaded',
                  )
                e.target.value = ''
              }}
            />
            <button
              className="btn-sm btn-ghost"
              disabled={!!busy}
              onClick={() => hsFileRef.current?.click()}
            >
              <Icon name="upload" /> Upload
            </button>
            <button className="btn-sm btn-accent" disabled={!!busy} onClick={() => void runHs()}>
              <Icon name="cloud_sync" /> {busy === 'hs-run' ? 'Backing up...' : 'Back up now'}
            </button>
          </div>
        </div>
        {hsQ.isLoading ? (
          <LoadingSpinner className="py-8" label="Loading..." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Backup</th>
                <th>Version</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hsBackups.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No backups yet.
                  </td>
                </tr>
              )}
              {hsBackups.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontWeight: 600 }}>{fmtDate(b.createdAt)}</td>
                  <td className="num">{b.hsVersion ?? '-'}</td>
                  <td className="num">{fmtBytes(b.size)}</td>
                  <td className="row-actions">
                    <button
                      className="icon-btn"
                      title="Download"
                      onClick={() =>
                        void withBusy('', async () => {
                          const blob = await downloadHsBackup(b.id)
                          saveBlob(blob, b.filename)
                        })
                      }
                    >
                      <Icon name="download" />
                    </button>
                    <button
                      className="icon-btn"
                      title="Restore this backup"
                      onClick={() =>
                        setConfirm({
                          title: 'Restore HearthShelf backup',
                          message:
                            'This replaces HearthShelf’s data (settings, clubs, notes, reading history, photos) with this backup’s contents. Your current data is saved to a pre-restore folder first. AudiobookShelf is not touched. Continue?',
                          danger: true,
                          confirmLabel: 'Restore',
                          run: () =>
                            withBusy('', async () => {
                              const r = await restoreHsBackup(b.id)
                              await hsQ.refetch()
                              if (r.crossServer)
                                show('Restored from a different server - some links may need attention')
                            }, 'HearthShelf data restored'),
                        })
                      }
                    >
                      <Icon name="restore" />
                    </button>
                    <button
                      className="icon-btn danger"
                      title="Delete"
                      onClick={() =>
                        setConfirm({
                          title: 'Delete backup',
                          message: `Delete this backup from ${fmtDate(b.createdAt)}? This cannot be undone.`,
                          danger: true,
                          confirmLabel: 'Delete',
                          run: () =>
                            withBusy('', async () => {
                              await deleteHsBackup(b.id)
                              await hsQ.refetch()
                            }, 'Deleted'),
                        })
                      }
                    >
                      <Icon name="delete" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ================= Full archive ================= */}
      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="inventory_2" />
        <h2>Full-server archive</h2>
      </div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        One file holding both backups from the same moment - the easiest way to move your whole
        server to new hardware or restore after a crash.
      </p>
      <div className="cfg-card">
        <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
          <button
            className="btn-sm btn-accent"
            disabled={!!busy}
            onClick={() =>
              void withBusy(
                'archive-dl',
                async () => {
                  const { blob, filename } = await downloadArchive()
                  saveBlob(blob, filename)
                },
                'Archive downloaded',
              )
            }
          >
            <Icon name="archive" /> {busy === 'archive-dl' ? 'Building...' : 'Download full archive'}
          </button>
          <input
            ref={archiveFileRef}
            type="file"
            accept=".hsarchive,.zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f)
                setConfirm({
                  title: 'Restore full archive',
                  message:
                    'This replaces BOTH AudiobookShelf and HearthShelf data with the archive’s contents. Your current HearthShelf data is saved to a pre-restore folder first. Continue?',
                  danger: true,
                  confirmLabel: 'Restore everything',
                  run: () =>
                    withBusy('', async () => {
                      const r = await restoreArchive(f, 'replace')
                      await Promise.all([absQ.refetch(), hsQ.refetch()])
                      if (r.crossServer)
                        show('Restored from a different server - some links may need attention')
                    }, 'Archive restored'),
                })
              e.target.value = ''
            }}
          />
          <button
            className="btn-sm btn-ghost"
            disabled={!!busy}
            onClick={() => archiveFileRef.current?.click()}
          >
            <Icon name="restore" /> Restore archive
          </button>
        </div>
      </div>

      <div className="banner info" style={{ marginTop: 'var(--s5)' }}>
        <Icon name="info" />
        <span>
          Audio files are not in either backup. Protect the folder holding your audiobooks at the
          host level (a separate volume backup or copy).
        </span>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          danger={confirm.danger}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => void confirm.run()}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  )
}
