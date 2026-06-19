import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getApiKeys,
  createApiKey,
  deleteApiKey,
  adminKeys,
} from '@/api/admin'
import { fmtSessDate } from '@/lib/format'
import { useAuthStore } from '@/store/authStore'
import type { ABSApiKey } from '@/api/types'
import { Icon } from '@/components/common/Icon'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Modal } from '@/components/common/Modal'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

export function ConfigApiKeys() {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<ABSApiKey | null>(null)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: adminKeys.apiKeys,
    queryFn: getApiKeys,
    staleTime: 60 * 1000,
  })

  const keys = data?.apiKeys ?? []

  const create = async () => {
    const name = newName.trim()
    if (!name || !me?.id) return
    const res = await createApiKey(name, me.id)
    setCreatedToken(res.apiKey.apiKey ?? null)
    setNewName('')
    setCreating(false)
    qc.invalidateQueries({ queryKey: adminKeys.apiKeys })
  }
  const revoke = async (k: ABSApiKey) => {
    await deleteApiKey(k.id)
    qc.invalidateQueries({ queryKey: adminKeys.apiKeys })
  }

  return (
    <>
      <div className="page-head-row">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">API Keys</h1>
        </div>
        <button className="btn-sm btn-accent" onClick={() => setCreating(true)}>
          <Icon name="add" /> New key
        </button>
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading keys..." />}
      {isError && <ErrorState message="Could not load API keys." onRetry={refetch} />}

      {data && (
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
                        title="Revoke key"
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
          title="New API key"
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
                <Icon name="key" /> Create key
              </button>
            </>
          }
        >
          <div className="field full">
            <label>Key name</label>
            <input
              className="fld"
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. My script"
            />
          </div>
        </Modal>
      )}

      {createdToken && (
        <Modal
          title="API key created"
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
            Copy this key now - it won't be shown again.
          </p>
          <div
            className="fld"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {createdToken}
          </div>
        </Modal>
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title="Revoke API key"
          message={`Revoke "${pendingRevoke.name}"? Anything using this key will stop working immediately.`}
          confirmLabel="Revoke key"
          danger
          onConfirm={() => void revoke(pendingRevoke)}
          onClose={() => setPendingRevoke(null)}
        />
      )}
    </>
  )
}
