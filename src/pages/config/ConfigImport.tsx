import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ImportReport, ImportResult, ImportMode, UserMatch } from '@hearthshelf/core'
import { inspectUpload, executeImport } from '@/api/import'
import { getUsers } from '@/api/admin'
import { Icon } from '@/components/common/Icon'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useToast } from '@/hooks/useToast'

const MODES: { value: ImportMode; label: string; help: string }[] = [
  {
    value: 'import',
    label: 'Import another server',
    help: 'Bring users and their history in from a different server’s backup or archive.',
  },
  {
    value: 'restore-as-import',
    label: 'Recover users from a backup',
    help: 'Restore selected users from a backup of THIS server, leaving everyone else untouched.',
  },
  {
    value: 'relink',
    label: 'Re-link after moving files',
    help: 'Re-attach this server’s history to books that got new ids after moving audio to a new disk.',
  },
]

// The editable user-mapping row.
type Override = Pick<UserMatch, 'sourceUserId' | 'action' | 'targetUserId'>

// A stat tile, matching the Library/Server Stats pages' idiom.
function Tile({ num, cap }: { num: number | string; cap: string }) {
  return (
    <div className="tile">
      <div className="t-num">{num}</div>
      <div className="t-cap">{cap}</div>
    </div>
  )
}

export function ConfigImport() {
  const { toast, show } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<ImportMode>('import')
  const [allowInode, setAllowInode] = useState(false)
  const [busy, setBusy] = useState('')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [result, setResult] = useState<ImportResult | null>(null)
  const [confirmExec, setConfirmExec] = useState(false)

  const usersQ = useQuery({ queryKey: ['admin', 'users'], queryFn: getUsers, staleTime: 60_000 })
  const targetUsers = usersQ.data?.users ?? []

  const runInspect = async (file: File) => {
    setBusy('inspect')
    setReport(null)
    setResult(null)
    setOverrides({})
    try {
      const r = await inspectUpload(file, { mode, allowInode })
      setReport(r)
      // Seed overrides from the report's proposals so the table is editable.
      const seed: Record<string, Override> = {}
      for (const u of r.users) {
        seed[u.sourceUserId] = {
          sourceUserId: u.sourceUserId,
          action: u.action,
          targetUserId: u.targetUserId,
        }
      }
      setOverrides(seed)
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not read that file')
    } finally {
      setBusy('')
    }
  }

  const runExecute = async () => {
    if (!report) return
    setBusy('execute')
    try {
      const res = await executeImport(report.reportId, Object.values(overrides))
      setResult(res)
      show('Import complete')
    } catch (e) {
      show(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setBusy('')
    }
  }

  const setOverride = (sourceUserId: string, patch: Partial<Override>) => {
    setOverrides((prev) => ({
      ...prev,
      [sourceUserId]: { ...prev[sourceUserId], sourceUserId, ...patch },
    }))
  }

  const totals = report
    ? {
        users: report.users.filter((u) => (overrides[u.sourceUserId]?.action ?? u.action) !== 'skip').length,
        progress: Object.values(report.perUser).reduce((n, p) => n + p.progress, 0),
        bookmarks: Object.values(report.perUser).reduce((n, p) => n + p.bookmarks, 0),
      }
    : null

  return (
    <>
      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}

      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Import &amp; Merge</h1>
        <p className="page-sub">
          Bring another server’s users and listening history into this one, recover users from a
          backup, or re-link books after moving files. Always shows a preview first - nothing is
          written until you run it.
        </p>
      </div>

      {/* ---- source + mode ---- */}
      {!result && (
        <div className="cfg-card">
          <div className="field full">
            <label>What are you doing?</label>
            <select className="fld" value={mode} onChange={(e) => setMode(e.target.value as ImportMode)}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="field-hint">{MODES.find((m) => m.value === mode)?.help}</p>
          </div>

          <label className="flex items-start gap-2" style={{ marginTop: 'var(--s4)' }}>
            <input type="checkbox" checked={allowInode} onChange={(e) => setAllowInode(e.target.checked)} />
            <span className="text-sm">
              These servers share the same audio files (same disk). Lets books match by file id -
              only tick this for a same-machine move.
            </span>
          </label>

          <input
            ref={fileRef}
            type="file"
            accept=".hsarchive,.audiobookshelf,.zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void runInspect(f)
              e.target.value = ''
            }}
          />
          <button
            className="btn-sm btn-accent"
            style={{ marginTop: 'var(--s4)' }}
            disabled={!!busy}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="upload_file" /> {busy === 'inspect' ? 'Reading…' : 'Choose a backup or archive'}
          </button>
        </div>
      )}

      {/* ---- dry-run report ---- */}
      {report && !result && (
        <>
          <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
            <Icon name="preview" />
            <h2>Preview</h2>
          </div>

          <div className="stat-tiles">
            <Tile num={report.items.matched} cap="books matched" />
            <Tile num={report.items.fuzzy} cap="by title (review)" />
            <Tile num={report.items.unmatched.length} cap="unmatched" />
            {totals && <Tile num={totals.progress} cap="progress to write" />}
            {totals && <Tile num={totals.bookmarks} cap="bookmarks" />}
          </div>

          {report.warnings.length > 0 && (
            <div className="banner warn" style={{ marginTop: 'var(--s4)' }}>
              <Icon name="warning" />
              <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
                {report.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* User mapping table */}
          <div className="tbl-wrap" style={{ marginTop: 'var(--s4)' }}>
            <div className="section-sub" style={{ marginBottom: 'var(--s3)' }}>
              How each account maps here
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>From the source</th>
                  <th>Action</th>
                  <th>Maps to</th>
                </tr>
              </thead>
              <tbody>
                {report.users.map((u) => {
                  const ov = overrides[u.sourceUserId] ?? u
                  return (
                    <tr key={u.sourceUserId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{u.sourceLabel}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {u.sourceEmail || u.sourceType}
                          {report.perUser[u.sourceUserId]
                            ? ` · ${report.perUser[u.sourceUserId].progress} books`
                            : ''}
                        </div>
                      </td>
                      <td>
                        <select
                          className="fld"
                          value={ov.action}
                          onChange={(e) =>
                            setOverride(u.sourceUserId, {
                              action: e.target.value as Override['action'],
                              // switching to create clears the target
                              targetUserId: e.target.value === 'map' ? ov.targetUserId : null,
                            })
                          }
                        >
                          <option value="map">Merge into…</option>
                          <option value="create">Create new</option>
                          <option value="skip">Skip</option>
                        </select>
                      </td>
                      <td>
                        {ov.action === 'map' ? (
                          <select
                            className="fld"
                            value={ov.targetUserId ?? ''}
                            onChange={(e) =>
                              setOverride(u.sourceUserId, { targetUserId: e.target.value || null })
                            }
                          >
                            <option value="">Choose a user…</option>
                            {targetUsers.map((tu) => (
                              <option key={tu.id} value={tu.id}>
                                {tu.username}
                                {tu.email ? ` (${tu.email})` : ''}
                              </option>
                            ))}
                          </select>
                        ) : ov.action === 'create' ? (
                          <span className="muted">a new account</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Fuzzy / unmatched review */}
          {report.items.unmatched.length > 0 && (
            <details style={{ marginTop: 'var(--s4)' }}>
              <summary className="section-sub" style={{ cursor: 'pointer' }}>
                {report.items.unmatched.length} books with no match here (their progress is skipped)
              </summary>
              <ul style={{ marginTop: 'var(--s2)', fontSize: 13 }}>
                {report.items.unmatched.slice(0, 100).map((m) => (
                  <li key={m.sourceItemId} className="muted">
                    {m.sourceLabel}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s5)' }}>
            <button
              className="btn-sm btn-accent"
              disabled={!!busy}
              onClick={() => setConfirmExec(true)}
            >
              <Icon name="merge" /> {busy === 'execute' ? 'Importing…' : 'Run the import'}
            </button>
            <button className="btn-sm btn-ghost" disabled={!!busy} onClick={() => setReport(null)}>
              Cancel
            </button>
          </div>
          <p className="field-hint" style={{ marginTop: 'var(--s3)' }}>
            A backup is taken automatically before anything is written. Running it again is safe -
            nothing gets duplicated.
          </p>
        </>
      )}

      {/* ---- result ---- */}
      {result && (
        <>
          <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
            <Icon name="task_alt" />
            <h2>Import complete</h2>
          </div>
          <div className="stat-tiles">
            <Tile num={result.usersCreated} cap="users created" />
            <Tile num={result.usersMerged} cap="users merged" />
            <Tile num={result.progressWritten} cap="progress written" />
            <Tile num={result.bookmarksWritten} cap="bookmarks" />
          </div>

          {result.createdUserInvites.length > 0 && (
            <div className="banner info" style={{ marginTop: 'var(--s4)' }}>
              <Icon name="mail" />
              <span>
                {result.createdUserInvites.length} new{' '}
                {result.createdUserInvites.length === 1 ? 'account was' : 'accounts were'} created.
                Set passwords or send invites from Settings &gt; Users so they can sign in.
              </span>
            </div>
          )}
          {result.warnings.length > 0 && (
            <div className="banner warn" style={{ marginTop: 'var(--s4)' }}>
              <Icon name="warning" />
              <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <button
            className="btn-sm btn-ghost"
            style={{ marginTop: 'var(--s5)' }}
            onClick={() => {
              setResult(null)
              setReport(null)
            }}
          >
            Import another
          </button>
        </>
      )}

      {confirmExec && report && (
        <ConfirmDialog
          title="Run the import"
          message={`This writes ${totals?.progress ?? 0} progress records and creates ${
            report.users.filter((u) => (overrides[u.sourceUserId]?.action ?? u.action) === 'create').length
          } new users. A backup is taken first. Continue?`}
          confirmLabel="Run import"
          onConfirm={() => void runExecute()}
          onClose={() => setConfirmExec(false)}
        />
      )}
    </>
  )
}
