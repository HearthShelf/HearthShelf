import { Fragment, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getUsers,
  getApiKeys,
  createApiKey,
  deleteApiKey,
  createUser,
  updateUser,
  deleteUser,
  adminKeys,
} from '@/api/admin'
import type { UserFormSubmit } from '@/components/config/UserForm'
import {
  getServiceAccountIds,
  tagServiceAccount,
  untagServiceAccount,
  serviceAccountKeys,
} from '@/api/serviceAccounts'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import { useAuth } from '@/hooks/useAuth'
import { fmtSessDate } from '@/lib/format'
import type { ABSAdminUser, ABSApiKey } from '@/api/types'
import { Icon } from '@/components/common/Icon'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { UserForm } from '@/components/config/UserForm'
import { Modal } from '@/components/common/Modal'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase()
}

// A reveal-once secret block (API token or generated password). The value is
// shown plainly with select-all so the admin can copy it before dismissing -
// neither the token nor the password is ever retrievable again.
function SecretReveal({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked (insecure context); the select-all field still works.
    }
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
      <div
        className="fld"
        style={{
          flex: 1,
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          wordBreak: 'break-all',
          userSelect: 'all',
        }}
      >
        {value}
      </div>
      <button className="btn-sm btn-ghost" onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'content_copy'} /> {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// Per-account API key management, revealed when a service-account row is expanded.
// canCreate is false for a root account viewed by a non-root admin: ABS forbids
// minting a token under a root user unless the caller is root (matching how the
// ABS web client hides root from its "act on behalf" picker), so we don't offer
// it rather than letting the request 403.
function AccountKeys({
  account,
  canCreate,
}: {
  account: ABSAdminUser
  canCreate: boolean
}) {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<ABSApiKey | null>(null)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: adminKeys.apiKeys,
    queryFn: getApiKeys,
    staleTime: 60 * 1000,
  })

  const keys = (data?.apiKeys ?? []).filter((k) => k.userId === account.id)

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    setCreateError(null)
    try {
      const res = await createApiKey(name, account.id)
      setCreatedToken(res.apiKey.apiKey ?? null)
      setNewName('')
      setCreating(false)
      qc.invalidateQueries({ queryKey: adminKeys.apiKeys })
    } catch (e) {
      setCreateError(
        e instanceof Error ? e.message : 'Could not create token.'
      )
    }
  }
  const revoke = async (k: ABSApiKey) => {
    await deleteApiKey(k.id)
    qc.invalidateQueries({ queryKey: adminKeys.apiKeys })
  }

  return (
    <div style={{ padding: '4px 0 8px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          API tokens for {account.username}
        </span>
        {canCreate && (
          <button className="btn-sm btn-accent" onClick={() => setCreating(true)}>
            <Icon name="add" /> New token
          </button>
        )}
      </div>

      {!canCreate && (
        <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: '4px 0 10px' }}>
          <Icon name="info" style={{ verticalAlign: '-3px' }} /> This is a root
          account. Only a root user can mint tokens under it - sign in as root, or
          create a separate service account for app access.
        </p>
      )}

      {isLoading && <LoadingSpinner className="py-6" label="Loading tokens..." />}
      {isError && (
        <ErrorState message="Could not load tokens." onRetry={refetch} />
      )}

      {data && keys.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: '4px 0' }}>
          No tokens yet. Create one to let another app sign in as this account.
        </p>
      )}

      {data && keys.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td style={{ fontWeight: 600 }}>{k.name}</td>
                  <td className="num">
                    {fmtSessDate(new Date(k.createdAt).getTime()).day}
                  </td>
                  <td className="num">
                    {k.lastUsedAt ? fmtSessDate(k.lastUsedAt).day : 'never'}
                  </td>
                  <td>
                    {k.isActive ? (
                      <span style={{ color: '#a7c896' }}>Active</span>
                    ) : (
                      <span style={{ color: 'var(--text-faint)' }}>Inactive</span>
                    )}
                  </td>
                  <td>
                    <div className="t-actions">
                      <button
                        className="tbl-icon"
                        title="Revoke token"
                        onClick={() => setPendingRevoke(k)}
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

      {creating && (
        <Modal
          title="New API token"
          onClose={() => setCreating(false)}
          foot={
            <>
              <div style={{ flex: 1 }} />
              <button
                className="btn-sm btn-ghost"
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
              <button className="btn-sm btn-green" onClick={() => void create()}>
                <Icon name="key" /> Create token
              </button>
            </>
          }
        >
          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 0 }}>
            Mints a token under <strong>{account.username}</strong>. The app you
            give it to acts as this account.
          </p>
          {createError && (
            <p
              style={{
                fontSize: 13,
                color: '#e8897f',
                background: 'color-mix(in oklab, #d8443a 14%, transparent)',
                border: '1px solid color-mix(in oklab, #d8443a 40%, transparent)',
                borderRadius: 10,
                padding: '8px 12px',
              }}
            >
              {createError}
            </p>
          )}
          <div className="field full">
            <label>Token name</label>
            <input
              className="fld"
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Backup script"
            />
          </div>
        </Modal>
      )}

      {createdToken && (
        <Modal
          title="API token created"
          onClose={() => setCreatedToken(null)}
          foot={
            <>
              <div style={{ flex: 1 }} />
              <button
                className="btn-sm btn-green"
                onClick={() => setCreatedToken(null)}
              >
                Done
              </button>
            </>
          }
        >
          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 0 }}>
            Copy this token now - it won't be shown again.
          </p>
          <SecretReveal value={createdToken} />
        </Modal>
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title="Revoke API token"
          message={`Revoke "${pendingRevoke.name}"? Anything using this token will stop working immediately.`}
          confirmLabel="Revoke token"
          danger
          onConfirm={() => void revoke(pendingRevoke)}
          onClose={() => setPendingRevoke(null)}
        />
      )}
    </div>
  )
}

export function ConfigServiceAccounts() {
  const qc = useQueryClient()
  const { data: runtime } = useRuntimeConfig()
  const { user: me } = useAuth()
  const callerIsRoot = me?.type === 'root'
  const [expanded, setExpanded] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ username: '', password: '', email: '' })
  const [createdCreds, setCreatedCreds] = useState<{
    username: string
    password: string
  } | null>(null)
  const [pendingUntag, setPendingUntag] = useState<ABSAdminUser | null>(null)
  const [editing, setEditing] = useState<ABSAdminUser | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ABSAdminUser | null>(null)

  const {
    data: usersData,
    isLoading: usersLoading,
    isError: usersError,
    refetch,
  } = useQuery({
    queryKey: adminKeys.users,
    queryFn: getUsers,
    staleTime: 60 * 1000,
  })
  const { data: trackedData } = useQuery({
    queryKey: serviceAccountKeys.ids,
    queryFn: getServiceAccountIds,
    staleTime: 60 * 1000,
  })

  const serviceUsername = runtime?.serviceUsername ?? null
  const trackedIds = useMemo(
    () => new Set(trackedData?.ids ?? []),
    [trackedData]
  )

  // A service account is the auto-created HS service root (matched by username,
  // since its id isn't recorded) plus any account an admin tagged here.
  const accounts = useMemo(() => {
    const users = usersData?.users ?? []
    return users.filter(
      (u) =>
        (serviceUsername != null && u.username === serviceUsername) ||
        trackedIds.has(u.id)
    )
  }, [usersData, serviceUsername, trackedIds])

  const isOwnedRoot = (u: ABSAdminUser) =>
    serviceUsername != null && u.username === serviceUsername

  const submitCreate = async () => {
    const username = form.username.trim()
    const password = form.password
    if (!username || !password) return
    const res = await createUser({
      username,
      password,
      email: form.email.trim() || null,
      type: 'admin',
    })
    await tagServiceAccount(res.user.id)
    setCreatedCreds({ username, password })
    setForm({ username: '', password: '', email: '' })
    setAdding(false)
    qc.invalidateQueries({ queryKey: adminKeys.users })
    qc.invalidateQueries({ queryKey: serviceAccountKeys.ids })
  }

  const untag = async (u: ABSAdminUser) => {
    await untagServiceAccount(u.id)
    qc.invalidateQueries({ queryKey: serviceAccountKeys.ids })
  }

  const saveEdit = async (values: UserFormSubmit) => {
    if (!editing) return
    setEditBusy(true)
    setEditError(null)
    try {
      await updateUser(editing.id, values)
      qc.invalidateQueries({ queryKey: adminKeys.users })
      setEditing(null)
    } catch (e) {
      // ABS returns a plain-language reason (e.g. "Username already taken").
      setEditError(e instanceof Error ? e.message : 'Could not save changes')
    } finally {
      setEditBusy(false)
    }
  }

  // Permanently delete the underlying ABS account (and its tokens), then drop the
  // HS tag. ABS forbids deleting root, so the root service account never offers it.
  const doDelete = async (u: ABSAdminUser) => {
    await deleteUser(u.id)
    await untagServiceAccount(u.id).catch(() => {})
    qc.invalidateQueries({ queryKey: adminKeys.users })
    qc.invalidateQueries({ queryKey: serviceAccountKeys.ids })
  }

  return (
    <>
      <div className="page-head-row">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">Service Accounts</h1>
        </div>
        <button className="btn-sm btn-accent" onClick={() => setAdding(true)}>
          <Icon name="add" /> New service account
        </button>
      </div>

      <p
        style={{
          fontSize: 14,
          color: 'var(--text-muted)',
          margin: '0 0 18px',
          maxWidth: 620,
        }}
      >
        Service accounts are machine logins, not people. Use them to give another
        app its own API token instead of sharing your personal one. They are
        regular AudiobookShelf admin accounts - native ABS clients still see them
        in the full user list.
      </p>

      {usersLoading && (
        <LoadingSpinner className="py-12" label="Loading accounts..." />
      )}
      {usersError && (
        <ErrorState message="Could not load accounts." onRetry={refetch} />
      )}

      {usersData && accounts.length === 0 && (
        <div className="empty-state">
          <Icon name="smart_toy" />
          <h3>No service accounts</h3>
          <p>Create one to hand out a scoped API token to another app.</p>
        </div>
      )}

      {usersData && accounts.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Account</th>
                <th>Last seen</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((u) => {
                const owned = isOwnedRoot(u)
                const isRoot = u.type === 'root'
                const open = expanded === u.id
                return (
                  <Fragment key={u.id}>
                    <tr>
                      <td>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                          }}
                        >
                          <span className="av">{initials(u.username)}</span>
                          <span style={{ fontWeight: 600 }}>{u.username}</span>
                          <span className="tag-pill admin">
                            {owned ? 'HearthShelf' : 'Service'}
                          </span>
                        </div>
                      </td>
                      <td className="num">
                        {u.lastSeen ? fmtSessDate(u.lastSeen).day : 'never'}
                      </td>
                      <td>
                        {u.isActive ? (
                          <span style={{ color: '#a7c896' }}>
                            <span className="online-dot" /> Active
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-faint)' }}>
                            Disabled
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="t-actions">
                          <button
                            className={'tbl-icon' + (open ? ' on' : '')}
                            title="Manage API tokens"
                            onClick={() => setExpanded(open ? null : u.id)}
                          >
                            <Icon name="key" />
                          </button>
                          <button
                            className="tbl-icon"
                            title="Edit account"
                            onClick={() => {
                              setEditError(null)
                              setEditing(u)
                            }}
                          >
                            <Icon name="edit" />
                          </button>
                          {!owned && (
                            <button
                              className="tbl-icon"
                              title="Remove from service accounts"
                              onClick={() => setPendingUntag(u)}
                            >
                              <Icon name="playlist_remove" />
                            </button>
                          )}
                          {!isRoot && (
                            <button
                              className="tbl-icon"
                              title="Delete account"
                              onClick={() => setPendingDelete(u)}
                            >
                              <Icon name="delete" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={4} style={{ background: 'var(--fill)' }}>
                          <AccountKeys
                            account={u}
                            canCreate={!isRoot || callerIsRoot}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <Modal
          title="New service account"
          onClose={() => setAdding(false)}
          foot={
            <>
              <div style={{ flex: 1 }} />
              <button
                className="btn-sm btn-ghost"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button
                className="btn-sm btn-green"
                onClick={() => void submitCreate()}
              >
                <Icon name="smart_toy" /> Create account
              </button>
            </>
          }
        >
          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 0 }}>
            Creates an AudiobookShelf admin account dedicated to another app. Pick
            a password you can hand off - it is shown once here, then only the API
            tokens you mint under it matter.
          </p>
          <div className="field full">
            <label>Username</label>
            <input
              className="fld"
              value={form.username}
              autoFocus
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              placeholder="e.g. backup-bot"
            />
          </div>
          <div className="field full">
            <label>Password</label>
            <input
              className="fld"
              type="text"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="Choose a strong password"
            />
          </div>
          <div className="field full">
            <label>Email (optional)</label>
            <input
              className="fld"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="optional"
            />
          </div>
        </Modal>
      )}

      {createdCreds && (
        <Modal
          title="Service account created"
          onClose={() => setCreatedCreds(null)}
          foot={
            <>
              <div style={{ flex: 1 }} />
              <button
                className="btn-sm btn-green"
                onClick={() => setCreatedCreds(null)}
              >
                Done
              </button>
            </>
          }
        >
          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 0 }}>
            <strong>{createdCreds.username}</strong> is ready. Save its password
            now - it won't be shown again. Expand the account to mint API tokens.
          </p>
          <SecretReveal value={createdCreds.password} />
        </Modal>
      )}

      {pendingUntag && (
        <ConfirmDialog
          title="Remove from service accounts"
          message={`Move "${pendingUntag.username}" back to the Users list? The account and its tokens are not deleted - it just stops being grouped here.`}
          confirmLabel="Remove"
          onConfirm={() => void untag(pendingUntag)}
          onClose={() => setPendingUntag(null)}
        />
      )}

      {editing && (
        <UserForm
          user={editing}
          busy={editBusy}
          error={editError}
          onSubmit={(v) => void saveEdit(v)}
          onClose={() => {
            setEditing(null)
            setEditError(null)
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete service account"
          message={`Permanently delete "${pendingDelete.username}"? This removes the AudiobookShelf account and every API token under it. Apps using those tokens stop working immediately. This cannot be undone.`}
          confirmLabel="Delete account"
          danger
          onConfirm={() => void doDelete(pendingDelete)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </>
  )
}
