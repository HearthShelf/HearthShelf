import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getEmailSettings,
  getRssFeeds,
  closeRssFeed,
  getAuthSettings,
  getCustomProviders,
} from '@/api/admin'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useRmabConfig } from '@/hooks/useRmab'
import { useAudplexusConfig, useAudplexusStatus } from '@/hooks/useAudplexus'

function Row({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="cfg-line">
      <Icon name={icon} style={{ color: 'var(--text-muted)' }} />
      <div className="cl-meta">
        <div className="cl-t">{label}</div>
      </div>
      <span style={{ color: 'var(--text-muted)' }}>{value}</span>
    </div>
  )
}

// --- Email (read) ---
export function ConfigEmail() {
  const { data } = useQuery({
    queryKey: ['admin', 'email'],
    queryFn: getEmailSettings,
    staleTime: 60 * 1000,
  })
  const s = data?.settings
  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Email</h1>
      </div>
      {!s ? (
        <LoadingSpinner className="py-12" label="Loading..." />
      ) : (
        <div className="cfg-card">
          <Row icon="dns" label="SMTP host" value={s.host || 'Not set'} />
          <Row icon="settings_ethernet" label="Port" value={s.port ? String(s.port) : '—'} />
          <Row icon="lock" label="Secure" value={s.secure ? 'Yes (TLS)' : 'No'} />
          <Row icon="person" label="User" value={s.user || '—'} />
          <Row icon="outgoing_mail" label="From address" value={s.fromAddress || '—'} />
          <Row
            icon="tablet"
            label="E-reader devices"
            value={String(s.ereaderDevices?.length ?? 0)}
          />
        </div>
      )}
    </>
  )
}

// --- RSS feeds (read + close) ---
export function ConfigRss() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['admin', 'rss'],
    queryFn: getRssFeeds,
    staleTime: 30 * 1000,
  })
  const feeds = data?.feeds ?? []
  const close = async (id: string) => {
    await closeRssFeed(id)
    qc.invalidateQueries({ queryKey: ['admin', 'rss'] })
  }
  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">RSS Feeds</h1>
        {data && <p className="page-sub">{feeds.length} open feeds</p>}
      </div>
      {!data ? (
        <LoadingSpinner className="py-12" label="Loading..." />
      ) : feeds.length === 0 ? (
        <div className="empty-state">
          <Icon name="rss_feed" />
          <h3>No open RSS feeds</h3>
          <p>Open a feed from a book, series, or collection to share it.</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Feed</th>
                <th>Type</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <tr key={f.id}>
                  <td style={{ fontWeight: 600 }}>{f.meta?.title ?? f.feedUrl}</td>
                  <td>{f.entityType}</td>
                  <td>
                    <div className="t-actions">
                      <button
                        className="tbl-icon"
                        title="Close feed"
                        onClick={() => void close(f.id)}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// --- Authentication (read) ---
export function ConfigAuth() {
  const { data } = useQuery({
    queryKey: ['admin', 'auth'],
    queryFn: getAuthSettings,
    staleTime: 60 * 1000,
  })
  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Authentication</h1>
      </div>
      {!data ? (
        <LoadingSpinner className="py-12" label="Loading..." />
      ) : (
        <>
          <div className="cfg-card">
            <Row
              icon="lock"
              label="Active methods"
              value={(data.authActiveAuthMethods ?? []).join(', ') || 'local'}
            />
          </div>
          {(data.authActiveAuthMethods ?? []).includes('openid') && (
            <>
              <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
                <Icon name="key" />
                <h2>OpenID Connect</h2>
              </div>
              <div className="cfg-card">
                <Row icon="link" label="Issuer URL" value={data.authOpenIDIssuerURL || '—'} />
                <Row icon="badge" label="Client ID" value={data.authOpenIDClientID || '—'} />
                <Row
                  icon="smart_button"
                  label="Button text"
                  value={data.authOpenIDButtonText || '—'}
                />
                <Row
                  icon="rocket_launch"
                  label="Auto-launch"
                  value={data.authOpenIDAutoLaunch ? 'Yes' : 'No'}
                />
                <Row
                  icon="person_add"
                  label="Auto-register"
                  value={data.authOpenIDAutoRegister ? 'Yes' : 'No'}
                />
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

// ReadMeABook connection status. Config is server-side (RMAB_URL +
// RMAB_LOGIN_TOKEN env); the token is never editable from the browser, so this
// card reports connection state and points admins at the env setup.
function RmabIntegrationCard() {
  const { data, isLoading } = useRmabConfig()
  const connected = data?.configured === true
  return (
    <div style={{ marginBottom: 'var(--s7)' }}>
      <div className="section-head">
        <Icon name="bolt" />
        <h2>ReadMeABook</h2>
      </div>
      <div className="cfg-card">
        <div className="cfg-line">
          <Icon
            name={connected ? 'check_circle' : 'cancel'}
            fill
            style={{ color: connected ? '#5a9c52' : 'var(--text-faint)' }}
          />
          <div className="cl-meta">
            <div className="cl-t">{connected ? 'Connected' : 'Not connected'}</div>
            <div className="cl-d">
              {isLoading
                ? 'Checking...'
                : connected
                  ? 'Requesting is available across HearthShelf.'
                  : 'Set RMAB_URL and RMAB_LOGIN_TOKEN to enable requesting. The login token comes from an RMAB admin (Users > Login Token); give that service account the admin role.'}
            </div>
          </div>
          <span
            className="badge-pill"
            style={{
              background: connected
                ? 'color-mix(in oklab, #5a9c52 20%, transparent)'
                : 'var(--fill)',
              color: connected ? '#7fbd6f' : 'var(--text-muted)',
            }}
          >
            {connected ? 'Active' : 'Off'}
          </span>
        </div>
      </div>
    </div>
  )
}

// Audplexus connection + library-sync health. Config is server-side (AUDPLEXUS_URL
// + AUDPLEXUS_KEY env). When connected, surfaces a sync-issue alert so admins know
// when owned books don't line up with what's actually in ABS.
function AudplexusIntegrationCard() {
  const { data: cfg, isLoading } = useAudplexusConfig()
  const connected = cfg?.configured === true
  const { data: status } = useAudplexusStatus(connected)

  const issues = status?.booksFailed ?? 0
  const alert = status?.hasIssues === true

  return (
    <div style={{ marginBottom: 'var(--s7)' }}>
      <div className="section-head">
        <Icon name="sync" />
        <h2>Audplexus</h2>
      </div>
      <div className="cfg-card">
        <div className="cfg-line">
          <Icon
            name={connected ? 'check_circle' : 'cancel'}
            fill
            style={{ color: connected ? '#5a9c52' : 'var(--text-faint)' }}
          />
          <div className="cl-meta">
            <div className="cl-t">{connected ? 'Connected' : 'Not connected'}</div>
            <div className="cl-d">
              {isLoading
                ? 'Checking...'
                : connected
                  ? 'Watching your library for sync issues with AudiobookShelf.'
                  : 'Set AUDPLEXUS_URL and AUDPLEXUS_KEY to monitor library sync health.'}
            </div>
          </div>
          <span
            className="badge-pill"
            style={{
              background: connected
                ? 'color-mix(in oklab, #5a9c52 20%, transparent)'
                : 'var(--fill)',
              color: connected ? '#7fbd6f' : 'var(--text-muted)',
            }}
          >
            {connected ? 'Active' : 'Off'}
          </span>
        </div>

        {connected && status && (
          <div className="cfg-line">
            <Icon
              name={alert ? 'warning' : 'task_alt'}
              fill
              style={{ color: alert ? '#d9a45a' : '#5a9c52' }}
            />
            <div className="cl-meta">
              <div className="cl-t">
                {status.running
                  ? 'Sync running...'
                  : alert
                    ? `${issues} book${issues === 1 ? '' : 's'} need attention`
                    : 'Library in sync'}
              </div>
              <div className="cl-d">
                {status.error
                  ? status.error
                  : `${status.booksTotal} books tracked${status.completedAt ? ' · last synced ' + new Date(status.completedAt).toLocaleString() : ''}`}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// --- Integrations (read) ---
export function ConfigIntegrations() {
  const { data } = useQuery({
    queryKey: ['admin', 'custom-providers'],
    queryFn: getCustomProviders,
    staleTime: 60 * 1000,
  })
  const providers = data?.providers ?? []
  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Integrations</h1>
      </div>

      <RmabIntegrationCard />

      <AudplexusIntegrationCard />

      <div className="section-head">
        <Icon name="travel_explore" />
        <h2>Custom metadata providers</h2>
      </div>
      {!data ? (
        <LoadingSpinner className="py-8" label="Loading..." />
      ) : providers.length === 0 ? (
        <div className="empty-state">
          <Icon name="extension_off" />
          <h3>No custom providers</h3>
          <p>Built-in providers (Audible, Google, iTunes, Open Library) are always available.</p>
        </div>
      ) : (
        <div className="cfg-card">
          {providers.map((p) => (
            <Row key={p.id} icon="travel_explore" label={p.name} value={p.url} />
          ))}
        </div>
      )}
    </>
  )
}
