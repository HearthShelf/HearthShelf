import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import type { HSServiceHealth, HSServiceCredentialOverrideRequest } from '@hearthshelf/core'

// Health + repair panel for the ABS admin credential the box uses to provision
// invited users. This credential is a durable API key that self-heals when it
// goes stale; this panel surfaces its state and, when auto-repair can't recover,
// gives an admin a way to fix it without the CLI.
//
// The API calls are passed in as props so the SAME component serves both the
// self-hosted SPA (same-origin /hs/hosted/*) and the hosted WebApp (per-server
// AbsTarget) without either reimplementing the UI.
export function ServiceAccountHealth({
  getHealth,
  onReset,
  onOverride,
  onChanged,
}: {
  getHealth: () => Promise<HSServiceHealth>
  onReset: () => Promise<{ ok: true; status: string }>
  onOverride: (b: HSServiceCredentialOverrideRequest) => Promise<{ ok: true; status: string }>
  onChanged?: () => void
}) {
  const {
    data: health,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['hosted-service-health'],
    queryFn: getHealth,
    staleTime: 15 * 1000,
  })

  const [showManual, setShowManual] = useState(false)
  const [pw, setPw] = useState('')
  const [token, setToken] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const done = (text: string) => {
    setMsg(text)
    setShowManual(false)
    setPw('')
    setToken('')
    void refetch()
    onChanged?.()
  }

  const reset = useMutation({
    mutationFn: onReset,
    onSuccess: () => done('Credential reset - invited users can be added again.'),
    onError: () => setMsg('Could not reset automatically. Try the manual options below.'),
  })

  const override = useMutation({
    mutationFn: (b: HSServiceCredentialOverrideRequest) => onOverride(b),
    onSuccess: () => done('Credential updated - invited users can be added again.'),
    onError: (e: Error) => {
      const code = e.message
      if (code === 'bad_service_password') setMsg('That service password did not work.')
      else if (code === 'token_not_admin') setMsg('That token is not an admin/root token.')
      else setMsg('Could not update the credential. Check the value and try again.')
    },
  })

  if (isLoading || !health) return null

  // A valid, healthy credential: a quiet confirmation, nothing to do.
  if (health.state === 'valid') {
    return (
      <div className="banner success" style={{ marginTop: 'var(--s4)' }}>
        <Icon name="verified_user" />
        <div>
          Service account is healthy - invited users are created automatically
          {health.username ? ` (as ${health.username})` : ''}.
        </div>
      </div>
    )
  }

  // 'absent' means hosted admin work isn't set up here; show nothing.
  if (health.state === 'absent') return null

  const stale = health.state === 'stale'

  return (
    <div className={`banner ${stale ? 'warn' : 'error'}`} style={{ marginTop: 'var(--s4)' }}>
      <Icon name={stale ? 'sync_problem' : 'error'} />
      <div style={{ width: '100%' }}>
        <div className="sr-t">
          {stale
            ? 'Service account needs reconnecting'
            : 'Service account is broken - invited users cannot be added'}
        </div>
        <div className="sr-d" style={{ marginTop: 4 }}>
          {stale
            ? 'The credential HearthShelf uses to create invited accounts has expired. It can be reconnected automatically.'
            : 'The saved credential no longer works and could not be restored automatically. Reset it, or supply a new one below.'}
        </div>

        <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap', marginTop: 'var(--s3)' }}>
          <button className="btn btn-primary" disabled={reset.isPending} onClick={() => reset.mutate()}>
            <Icon name="key" /> {reset.isPending ? 'Resetting…' : 'Reset service credential'}
          </button>
          <button className="btn-sm btn-ghost" onClick={() => setShowManual((v) => !v)}>
            <Icon name="tune" /> {showManual ? 'Hide manual options' : 'Manual options'}
          </button>
        </div>

        {msg && (
          <div className="sr-d" style={{ marginTop: 'var(--s3)' }}>
            {msg}
          </div>
        )}

        {showManual && (
          <div
            style={{
              marginTop: 'var(--s4)',
              borderTop: '1px solid var(--hairline)',
              paddingTop: 'var(--s3)',
            }}
          >
            <div className="field full">
              <label>New service account password</label>
              <input
                className="fld"
                type="password"
                placeholder="Re-sync the hearthshelf-service password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="off"
              />
            </div>
            <button
              className="btn"
              disabled={override.isPending || !pw.trim()}
              onClick={() => override.mutate({ servicePassword: pw })}
              style={{ marginTop: 'var(--s2)' }}
            >
              <Icon name="lock_reset" /> Use this password
            </button>

            <div className="field full" style={{ marginTop: 'var(--s4)' }}>
              <label>…or paste an admin API key / token</label>
              <input
                className="fld"
                type="password"
                placeholder="A known-good admin or root token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
            </div>
            <button
              className="btn"
              disabled={override.isPending || !token.trim()}
              onClick={() => override.mutate({ absAdminToken: token })}
              style={{ marginTop: 'var(--s2)' }}
            >
              <Icon name="content_paste" /> Use this token
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
