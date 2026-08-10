import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getConnectedApps,
  revokeConnectedApp,
  connectedAppKeys,
  type ConnectedApp,
} from '@/api/connectedApps'
import { fmtSessDate } from '@/lib/format'
import { Icon } from '@/components/common/Icon'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

/**
 * Connected Apps - third-party applications authorized against THIS server.
 *
 * WHY THIS LIVES ON THE BOX AND NOT ONLY IN THE HOSTED APP. The box issues and
 * revokes the credential an app actually runs on, so it is the authority on what
 * has access. That also means revoking here works with the control plane
 * unreachable - which is precisely when an admin most needs to cut something
 * off. The hosted app's connections page is a convenience view across servers;
 * this one is the real thing.
 *
 * Read-only apart from revoke, on purpose: an admin should be able to SEE and
 * STOP anything reaching their server, but granting is the user's decision made
 * on the consent screen, not something an admin does on their behalf.
 */

// Plain-language scope copy. Mirrors @hearthshelf/core's descriptions so the
// admin reads the same words the user saw when they approved.
const SCOPE_TEXT: Record<string, string> = {
  'library:read': 'Read library',
  'library:write': 'Add and update books',
  'progress:read': 'Read progress',
  'progress:write': 'Update progress',
  admin: 'Administer server',
}

function scopeLabel(scope: string): string {
  return SCOPE_TEXT[scope] ?? scope
}

function kindLabel(app: ConnectedApp): string {
  return app.appKind === 'cloud' ? 'Hosted service' : 'Self-hosted'
}

export function ConfigConnectedApps() {
  const qc = useQueryClient()
  const [pendingRevoke, setPendingRevoke] = useState<ConnectedApp | null>(null)
  const [revoking, setRevoking] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: connectedAppKeys.all,
    queryFn: getConnectedApps,
    staleTime: 30 * 1000,
  })

  const apps = data?.installations ?? []

  const revoke = async (app: ConnectedApp) => {
    setRevoking(true)
    try {
      await revokeConnectedApp(app.appId, app.subject)
      await qc.invalidateQueries({ queryKey: connectedAppKeys.all })
      setPendingRevoke(null)
    } finally {
      setRevoking(false)
    }
  }

  return (
    <>
      <div className="page-head-row">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">Connected Apps</h1>
        </div>
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px' }}>
        Apps your users have authorized against this server. Each one acts as the user who
        connected it and can never do more than that user could. Disconnecting takes effect
        immediately.
      </p>

      {isLoading && <LoadingSpinner className="py-12" label="Loading connected apps..." />}
      {isError && <ErrorState message="Could not load connected apps." onRetry={refetch} />}

      {data && apps.length === 0 && (
        <div
          style={{
            padding: 24,
            border: '1px solid var(--border)',
            borderRadius: 10,
            fontSize: 13,
            color: 'var(--text-muted)',
          }}
        >
          No apps are connected. A user connects one from inside the app itself - it shows them a
          code, which they approve on app.hearthshelf.com.
        </div>
      )}

      {data && apps.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>App</th>
                <th>Kind</th>
                <th>Can do</th>
                <th>Acting as</th>
                <th>Connected</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={`${app.appId}:${app.subject}`}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{app.appName || app.appId}</div>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                        color: 'var(--text-muted)',
                      }}
                    >
                      {app.appId}
                    </div>
                    {app.throttled && (
                      // Surfaced because a persistently throttled app is usually
                      // a misbehaving one, and this is the page where someone can
                      // do something about it.
                      <div
                        style={{
                          fontSize: 11.5,
                          color: 'var(--warning, #d08700)',
                          marginTop: 2,
                        }}
                      >
                        <Icon name="speed" /> Being rate limited
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                    {kindLabel(app)}
                    {app.family ? ` · ${app.family}` : ''}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {app.scopes.map((s) => (
                        <span
                          key={s}
                          className="chip"
                          style={
                            s === 'admin'
                              ? { color: 'var(--danger)', borderColor: 'var(--danger)' }
                              : undefined
                          }
                        >
                          {scopeLabel(s)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11.5,
                      color: 'var(--text-muted)',
                    }}
                  >
                    {app.absUserId}
                  </td>
                  <td className="num">{fmtSessDate(app.createdAt).day}</td>
                  <td className="num">
                    {app.lastUsedAt ? fmtSessDate(app.lastUsedAt).day : 'never'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn-sm btn-ghost"
                      onClick={() => setPendingRevoke(app)}
                      title="Disconnect this app"
                    >
                      <Icon name="link_off" /> Disconnect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title="Disconnect this app?"
          message={
            `${pendingRevoke.appName || pendingRevoke.appId} will lose access to this server ` +
            'immediately. The user who connected it can connect it again from the app.'
          }
          confirmLabel={revoking ? 'Disconnecting...' : 'Disconnect'}
          danger
          onConfirm={() => void revoke(pendingRevoke)}
          onClose={() => setPendingRevoke(null)}
        />
      )}
    </>
  )
}
