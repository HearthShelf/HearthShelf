import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getUsers, deleteUser, setUserActive, adminKeys } from '@/api/admin'
import {
  getServiceAccountIds,
  serviceAccountKeys,
} from '@/api/serviceAccounts'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import { fmtSessDate } from '@/lib/format'
import type { ABSAdminUser } from '@/api/types'
import { Icon } from '@/components/common/Icon'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Modal } from '@/components/common/Modal'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase()
}

export function ConfigUsers() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [pendingDelete, setPendingDelete] = useState<ABSAdminUser | null>(null)
  const [adding, setAdding] = useState(false)

  const { data: runtime } = useRuntimeConfig()

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: adminKeys.users,
    queryFn: getUsers,
    staleTime: 60 * 1000,
  })
  const { data: trackedData } = useQuery({
    queryKey: serviceAccountKeys.ids,
    queryFn: getServiceAccountIds,
    staleTime: 60 * 1000,
  })

  // Service accounts (the HS service root + any tagged here) live on their own
  // Config page, so keep them out of this human-user list.
  const serviceUsername = runtime?.serviceUsername ?? null
  const trackedIds = useMemo(
    () => new Set(trackedData?.ids ?? []),
    [trackedData]
  )
  const allUsers = data?.users ?? []
  const users = allUsers.filter(
    (u) =>
      !trackedIds.has(u.id) &&
      !(serviceUsername != null && u.username === serviceUsername)
  )
  const serviceCount = allUsers.length - users.length

  const toggleActive = async (u: ABSAdminUser) => {
    await setUserActive(u.id, !u.isActive)
    qc.invalidateQueries({ queryKey: adminKeys.users })
  }
  const doDelete = async (u: ABSAdminUser) => {
    await deleteUser(u.id)
    qc.invalidateQueries({ queryKey: adminKeys.users })
  }

  return (
    <>
      <div className="page-head-row">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">Users</h1>
        </div>
        <button className="btn-sm btn-accent" onClick={() => setAdding(true)}>
          <Icon name="add" /> Add user
        </button>
      </div>

      {serviceCount > 0 && (
        <p
          style={{
            fontSize: 13,
            color: 'var(--text-muted)',
            margin: '0 0 16px',
          }}
        >
          <Icon name="smart_toy" style={{ verticalAlign: '-3px' }} />{' '}
          {serviceCount} machine{' '}
          {serviceCount === 1 ? 'account is' : 'accounts are'} hidden here.{' '}
          <span className="lnk" onClick={() => navigate('/config/service-accounts')}>
            Manage service accounts
          </span>
        </p>
      )}

      {isLoading && <LoadingSpinner className="py-12" label="Loading users..." />}
      {isError && <ErrorState message="Could not load users." onRetry={refetch} />}

      {data && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>User</th>
                <th>Type</th>
                <th>Last seen</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                    >
                      <span className="av">{initials(u.username)}</span>
                      <span
                        className="lnk"
                        onClick={() => navigate(`/config/users/${u.id}`)}
                      >
                        {u.username}
                      </span>
                    </div>
                  </td>
                  <td>{u.type}</td>
                  <td className="num">
                    {u.lastSeen ? fmtSessDate(u.lastSeen).day : 'never'}
                  </td>
                  <td>
                    {u.isActive ? (
                      <span style={{ color: '#a7c896' }}>
                        <span className="online-dot" /> Active
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-faint)' }}>Disabled</span>
                    )}
                  </td>
                  <td>
                    <div className="t-actions">
                      <button
                        className="tbl-icon"
                        title={u.isActive ? 'Disable' : 'Enable'}
                        onClick={() => void toggleActive(u)}
                      >
                        <Icon name={u.isActive ? 'block' : 'check_circle'} />
                      </button>
                      {u.type !== 'root' && (
                        <button
                          className="tbl-icon"
                          title="Delete user"
                          onClick={() => setPendingDelete(u)}
                        >
                          <Icon name="delete" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <Modal
          title="Add user"
          onClose={() => setAdding(false)}
          foot={
            <>
              <div style={{ flex: 1 }} />
              <button
                className="btn-sm btn-green"
                onClick={() => setAdding(false)}
              >
                Got it
              </button>
            </>
          }
        >
          <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 0 }}>
            New accounts are created in AudiobookShelf, the source of truth for
            users. Open the AudiobookShelf admin settings to add a user, then
            return here - the new account appears in this list automatically.
          </p>
        </Modal>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete user"
          message={`Permanently delete "${pendingDelete.username}"? This removes their account and progress. This cannot be undone.`}
          confirmLabel="Delete user"
          danger
          onConfirm={() => void doDelete(pendingDelete)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </>
  )
}
