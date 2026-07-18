import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import type { HSServiceHealth } from '@hearthshelf/core'

// A blocking, app-level alert for a BROKEN server admin credential. When the
// provisioning credential dies, invited people silently cannot join - an admin
// must know immediately, not discover it buried in a settings sub-tab. This
// interrupts the whole app (portal above everything) with what's wrong, the
// one-click fix, and links to the full controls + logs.
//
// Prop-driven so the SAME component serves the self-hosted SPA and the hosted
// WebApp (which reach the server differently). The parent watcher decides when
// to render it (admin + state === 'broken') and supplies the actions + nav.
export function ServerHealthAlert({
  health,
  serverName,
  onReset,
  onGoToConnect,
  onGoToLogs,
  onSnooze,
}: {
  health: HSServiceHealth
  serverName?: string | null
  onReset: () => Promise<{ ok: true; status: string }>
  onGoToConnect: () => void
  onGoToLogs: () => void
  onSnooze: () => void
}) {
  const [msg, setMsg] = useState<string | null>(null)
  const [fixed, setFixed] = useState(false)

  const reset = useMutation({
    mutationFn: onReset,
    onSuccess: () => {
      setFixed(true)
      setMsg('Fixed. New members can be added again.')
    },
    onError: () =>
      setMsg(
        "That didn't work automatically. Open Connect for more options (new service password or a pasted admin token).",
      ),
  })

  const who = serverName || 'This server'

  return createPortal(
    <div className="modal-scrim open" style={{ zIndex: 1000 }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <Icon name={fixed ? 'check_circle' : 'error'} />
          <h2>{fixed ? 'Server fixed' : 'New members can’t join this server'}</h2>
        </div>

        <div className="modal-body">
          {fixed ? (
            <p className="sr-d">
              {who} can add invited people again. You can close this and carry on.
            </p>
          ) : (
            <>
              <p className="sr-d" style={{ marginBottom: 'var(--s3)' }}>
                <strong>{who}</strong> has lost the credential it uses to create accounts for the
                people you invite. Until it’s fixed, <strong>new invitations silently fail</strong>{' '}
                - invited people accept, sign in, and then can’t reach your library. Everyone who
                already has access is unaffected.
              </p>
              <p className="sr-d" style={{ marginBottom: 'var(--s3)' }}>
                This happens when the server’s admin credential expires or is removed. The quickest
                fix is to let HearthShelf mint a fresh one from your current admin session:
              </p>
              {health.state === 'broken' && !health.canSelfHeal && (
                <p className="sr-d" style={{ marginBottom: 'var(--s3)', color: 'var(--text-muted)' }}>
                  Automatic recovery isn’t possible here (the service account’s saved password no
                  longer matches), so <strong>Fix now</strong> re-mints the credential from your
                  session instead.
                </p>
              )}
              {msg && (
                <div className="banner warn" style={{ marginTop: 'var(--s2)' }}>
                  <Icon name="info" />
                  {msg}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot" style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>
          {fixed ? (
            <button className="btn btn-primary" onClick={onSnooze}>
              <Icon name="check" /> Done
            </button>
          ) : (
            <>
              <button
                className="btn btn-primary"
                disabled={reset.isPending}
                onClick={() => reset.mutate()}
              >
                <Icon name="key" /> {reset.isPending ? 'Fixing…' : 'Fix now'}
              </button>
              <button className="btn" onClick={onGoToConnect}>
                <Icon name="hub" /> Open Connect
              </button>
              <button className="btn-sm btn-ghost" onClick={onGoToLogs}>
                <Icon name="terminal" /> View logs
              </button>
              <button
                className="btn-sm btn-ghost"
                onClick={onSnooze}
                style={{ marginLeft: 'auto' }}
                title="Hide until next sign-in or reload"
              >
                Remind me later
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
