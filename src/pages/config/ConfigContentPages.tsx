import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import {
  getEmailSettings,
  updateEmailSettings,
  sendTestEmail,
  updateEreaderDevices,
  getRssFeeds,
  closeRssFeed,
  getAuthSettings,
  updateAuthSettings,
  getCustomProviders,
  type ABSAuthSettings,
  type ABSEmailSettings,
  type ABSEreaderDevice,
} from '@/api/admin'
import {
  getIntegrationsConfig,
  saveIntegrationsConfig,
  integrationsKeys,
  type IntegrationsConfig,
  type IntegrationsConfigPatch,
} from '@/api/integrations'
import { getEmailRelayStatus, enableEmailRelay, type EmailRelayStatus } from '@/api/hosted'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { requestKeys } from '@/api/requests'
import { useAudplexusStatus } from '@/hooks/useAudplexus'

const REGION_LABELS: Record<string, string> = {
  us: 'United States (.com)',
  ca: 'Canada (.ca)',
  uk: 'United Kingdom (.co.uk)',
  au: 'Australia (.com.au)',
  in: 'India (.in)',
  de: 'Germany (.de)',
  es: 'Spain (.es)',
  fr: 'France (.fr)',
}

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

// --- Email (editable SMTP form + eReader devices) ---
// Thin wrapper: fetches settings, then mounts the form keyed on the loaded data
// so form state initializes directly from props (no setState-in-effect sync).
export function ConfigEmail() {
  const { data } = useQuery({
    queryKey: ['admin', 'email'],
    queryFn: getEmailSettings,
    staleTime: 60 * 1000,
  })

  if (!data) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">Email</h1>
        </div>
        <LoadingSpinner className="py-12" label="Loading..." />
      </>
    )
  }

  return <EmailForm key={JSON.stringify(data.settings)} settings={data.settings} />
}

function EmailForm({ settings }: { settings: ABSEmailSettings }) {
  const qc = useQueryClient()

  const [host, setHost] = useState(settings.host ?? '')
  const [port, setPort] = useState(settings.port != null ? String(settings.port) : '465')
  const [secure, setSecure] = useState(settings.secure)
  const [user, setUser] = useState(settings.user ?? '')
  const [pass, setPass] = useState('')
  const [fromAddress, setFromAddress] = useState(settings.fromAddress ?? '')
  const [testAddress, setTestAddress] = useState(settings.testAddress ?? '')
  const [devices, setDevices] = useState<ABSEreaderDevice[]>(settings.ereaderDevices ?? [])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    try {
      await updateEmailSettings({
        host: host || null,
        port: port ? Number(port) : null,
        secure,
        user: user || null,
        fromAddress: fromAddress || null,
        testAddress: testAddress || null,
        // pass is write-only; only send when the admin typed a new one
        ...(pass ? { pass } : {}),
      })
      setPass('')
      qc.invalidateQueries({ queryKey: ['admin', 'email'] })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestMsg(null)
    try {
      await sendTestEmail()
      setTestMsg('Test email sent.')
    } catch {
      setTestMsg('Test failed - check the SMTP settings and save first.')
    } finally {
      setTesting(false)
      window.setTimeout(() => setTestMsg(null), 4000)
    }
  }

  const saveDevices = async (next: ABSEreaderDevice[]) => {
    setDevices(next)
    await updateEreaderDevices(next)
    qc.invalidateQueries({ queryKey: ['admin', 'email'] })
  }

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Email</h1>
        <p className="page-sub">SMTP server used to send ebooks to e-readers.</p>
      </div>

      <EmailRelayCard onEnabled={() => qc.invalidateQueries({ queryKey: ['admin', 'email'] })} />

      <div className="cfg-card">
        <Field label="SMTP host">
          <input
            className="fld"
            placeholder="smtp.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Field label="Port">
          <input
            className="fld"
            inputMode="numeric"
            placeholder="465"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </Field>
        <div className="cfg-line">
          <Icon name="lock" style={{ color: 'var(--text-muted)' }} />
          <div className="cl-meta" style={{ flex: 1 }}>
            <div className="cl-t">Use TLS</div>
            <div className="cl-d">Secure connection (recommended for port 465).</div>
          </div>
          <button
            className={secure ? 'toggle on' : 'toggle'}
            aria-pressed={secure}
            onClick={() => setSecure((v) => !v)}
          >
            <i />
          </button>
        </div>
        <Field label="Username">
          <input
            className="fld"
            placeholder="user@example.com"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            className="fld"
            type="password"
            placeholder={settings.host ? 'Leave blank to keep current' : ''}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </Field>
        <Field label="From address">
          <input
            className="fld"
            placeholder="library@example.com"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
          />
        </Field>
        <Field label="Test recipient">
          <input
            className="fld"
            placeholder="you@example.com"
            value={testAddress}
            onChange={(e) => setTestAddress(e.target.value)}
          />
        </Field>
        <div className="cfg-line" style={{ gap: 8, justifyContent: 'flex-end' }}>
          {testMsg && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12.5, marginRight: 'auto' }}>
              {testMsg}
            </span>
          )}
          <button className="btn-sm" disabled={testing || !testAddress} onClick={() => void test()}>
            <Icon name="send" /> {testing ? 'Sending...' : 'Send test'}
          </button>
          <button className="btn-sm btn-green" disabled={saving} onClick={() => void save()}>
            {saved ? <Icon name="check" /> : <Icon name="save" />} {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>

      <EreaderDevices devices={devices} onChange={saveDevices} />
    </>
  )
}

// "Use HearthShelf email" - the 1-click alternative to standing up your own
// SMTP. Only shown on a paired box (the relay refuses unpaired sends); on an
// unpaired/self-managed box it renders nothing so the SMTP form is the whole
// story. When active, the SMTP fields below are pointed at the loopback relay.
function EmailRelayCard({ onEnabled }: { onEnabled: () => void }) {
  const qc = useQueryClient()
  const { data } = useQuery<EmailRelayStatus>({
    queryKey: ['admin', 'email-relay'],
    queryFn: getEmailRelayStatus,
    staleTime: 30 * 1000,
    // A self-hosted box with no backend / not in hosted build returns an error;
    // treat that as "no relay" and just don't show the card.
    retry: false,
  })

  const enable = useMutation({
    mutationFn: enableEmailRelay,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'email-relay'] })
      onEnabled()
    },
  })

  // Not paired (or status unavailable): nothing to offer here.
  if (!data || (!data.available && !data.active)) return null

  return (
    <div className="cfg-card" style={{ marginBottom: 'var(--s5)' }}>
      <div className="cfg-line">
        <Icon
          name="mark_email_read"
          fill
          style={{ color: data.active ? '#7fbd6f' : 'var(--accent)' }}
        />
        <div className="cl-meta" style={{ flex: 1 }}>
          <div className="cl-t">Use HearthShelf email</div>
          <div className="cl-d">
            {data.active
              ? 'Sending through HearthShelf - no SMTP setup needed. The fields below are managed for you.'
              : 'Send ebooks and test mail through HearthShelf instead of setting up your own SMTP server.'}
          </div>
        </div>
        {data.active ? (
          <StatusPill on />
        ) : (
          <button
            className="btn-sm btn-green"
            style={{ flex: 'none' }}
            disabled={enable.isPending}
            onClick={() => enable.mutate()}
          >
            <Icon name="bolt" /> {enable.isPending ? 'Setting up...' : 'Turn on'}
          </button>
        )}
      </div>
      {enable.isError && (
        <div className="cfg-line">
          <Icon name="warning" style={{ color: '#d9a45a' }} />
          <div className="cl-d">Could not enable - check that the box is online and try again.</div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="cfg-line" style={{ gap: 12 }}>
      <div className="cl-meta" style={{ width: 150, flex: 'none' }}>
        <div className="cl-t">{label}</div>
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}

function EreaderDevices({
  devices,
  onChange,
}: {
  devices: ABSEreaderDevice[]
  onChange: (next: ABSEreaderDevice[]) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  const add = () => {
    if (!name.trim() || !email.trim()) return
    void onChange([...devices, { name: name.trim(), email: email.trim() }])
    setName('')
    setEmail('')
  }
  const remove = (idx: number) => {
    void onChange(devices.filter((_, i) => i !== idx))
  }

  return (
    <>
      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="tablet" />
        <h2>E-reader devices · {devices.length}</h2>
      </div>
      <div className="cfg-card">
        {devices.map((d, i) => (
          <div className="cfg-line" key={`${d.email}-${i}`}>
            <Icon name="tablet" style={{ color: 'var(--text-muted)' }} />
            <div className="cl-meta" style={{ flex: 1 }}>
              <div className="cl-t">{d.name}</div>
              <div className="cl-d">{d.email}</div>
            </div>
            <button className="tbl-icon" title="Remove device" onClick={() => remove(i)}>
              <Icon name="delete" />
            </button>
          </div>
        ))}
        <div className="cfg-line" style={{ gap: 8 }}>
          <input
            className="fld"
            placeholder="Device name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="fld"
            placeholder="device@kindle.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            className="btn-sm"
            style={{ flex: 'none' }}
            disabled={!name.trim() || !email.trim()}
            onClick={add}
          >
            <Icon name="add" /> Add
          </button>
        </div>
      </div>
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

// --- Authentication (editable: method toggles + OIDC form) ---
export function ConfigAuth() {
  const { data } = useQuery({
    queryKey: ['admin', 'auth'],
    queryFn: getAuthSettings,
    staleTime: 60 * 1000,
  })

  if (!data) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">Authentication</h1>
        </div>
        <LoadingSpinner className="py-12" label="Loading..." />
      </>
    )
  }

  return <AuthForm key={JSON.stringify(data)} settings={data} />
}

function AuthForm({ settings }: { settings: ABSAuthSettings }) {
  const qc = useQueryClient()

  const [methods, setMethods] = useState<string[]>(settings.authActiveAuthMethods ?? ['local'])
  const [oidc, setOidc] = useState({
    authOpenIDIssuerURL: settings.authOpenIDIssuerURL ?? '',
    authOpenIDClientID: settings.authOpenIDClientID ?? '',
    authOpenIDButtonText: settings.authOpenIDButtonText ?? '',
    authOpenIDAutoLaunch: settings.authOpenIDAutoLaunch ?? false,
    authOpenIDAutoRegister: settings.authOpenIDAutoRegister ?? false,
  })
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const openidOn = methods.includes('openid')
  const toggleMethod = (m: string) => {
    setMethods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]))
  }

  const save = async () => {
    setSaving(true)
    try {
      const patch: Partial<ABSAuthSettings> & { authOpenIDClientSecret?: string } = {
        authActiveAuthMethods: methods.length ? methods : ['local'],
        ...oidc,
        authOpenIDIssuerURL: oidc.authOpenIDIssuerURL || null,
        authOpenIDClientID: oidc.authOpenIDClientID || null,
        authOpenIDButtonText: oidc.authOpenIDButtonText || null,
        ...(clientSecret ? { authOpenIDClientSecret: clientSecret } : {}),
      }
      await updateAuthSettings(patch)
      setClientSecret('')
      qc.invalidateQueries({ queryKey: ['admin', 'auth'] })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Authentication</h1>
      </div>

      <div className="cfg-card">
        <div className="cfg-line">
          <Icon name="password" style={{ color: 'var(--text-muted)' }} />
          <div className="cl-meta" style={{ flex: 1 }}>
            <div className="cl-t">Local accounts</div>
            <div className="cl-d">Username and password sign-in.</div>
          </div>
          <button
            className={methods.includes('local') ? 'toggle on' : 'toggle'}
            aria-pressed={methods.includes('local')}
            onClick={() => toggleMethod('local')}
          >
            <i />
          </button>
        </div>
        <div className="cfg-line">
          <Icon name="key" style={{ color: 'var(--text-muted)' }} />
          <div className="cl-meta" style={{ flex: 1 }}>
            <div className="cl-t">OpenID Connect</div>
            <div className="cl-d">Single sign-on through an identity provider.</div>
          </div>
          <button
            className={openidOn ? 'toggle on' : 'toggle'}
            aria-pressed={openidOn}
            onClick={() => toggleMethod('openid')}
          >
            <i />
          </button>
        </div>
      </div>

      {openidOn && (
        <>
          <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
            <Icon name="key" />
            <h2>OpenID Connect</h2>
          </div>
          <div className="cfg-card">
            <Field label="Issuer URL">
              <input
                className="fld"
                placeholder="https://idp.example.com"
                value={oidc.authOpenIDIssuerURL}
                onChange={(e) => setOidc((o) => ({ ...o, authOpenIDIssuerURL: e.target.value }))}
              />
            </Field>
            <Field label="Client ID">
              <input
                className="fld"
                value={oidc.authOpenIDClientID}
                onChange={(e) => setOidc((o) => ({ ...o, authOpenIDClientID: e.target.value }))}
              />
            </Field>
            <Field label="Client secret">
              <input
                className="fld"
                type="password"
                placeholder={settings.authOpenIDClientID ? 'Leave blank to keep current' : ''}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </Field>
            <Field label="Button text">
              <input
                className="fld"
                placeholder="Sign in with SSO"
                value={oidc.authOpenIDButtonText}
                onChange={(e) => setOidc((o) => ({ ...o, authOpenIDButtonText: e.target.value }))}
              />
            </Field>
            <div className="cfg-line">
              <Icon name="rocket_launch" style={{ color: 'var(--text-muted)' }} />
              <div className="cl-meta" style={{ flex: 1 }}>
                <div className="cl-t">Auto-launch</div>
                <div className="cl-d">Skip the login screen and go straight to the provider.</div>
              </div>
              <button
                className={oidc.authOpenIDAutoLaunch ? 'toggle on' : 'toggle'}
                aria-pressed={oidc.authOpenIDAutoLaunch}
                onClick={() =>
                  setOidc((o) => ({ ...o, authOpenIDAutoLaunch: !o.authOpenIDAutoLaunch }))
                }
              >
                <i />
              </button>
            </div>
            <div className="cfg-line">
              <Icon name="person_add" style={{ color: 'var(--text-muted)' }} />
              <div className="cl-meta" style={{ flex: 1 }}>
                <div className="cl-t">Auto-register</div>
                <div className="cl-d">Create an account on first sign-in.</div>
              </div>
              <button
                className={oidc.authOpenIDAutoRegister ? 'toggle on' : 'toggle'}
                aria-pressed={oidc.authOpenIDAutoRegister}
                onClick={() =>
                  setOidc((o) => ({ ...o, authOpenIDAutoRegister: !o.authOpenIDAutoRegister }))
                }
              >
                <i />
              </button>
            </div>
          </div>
        </>
      )}

      <div
        className="cfg-line"
        style={{ gap: 8, justifyContent: 'flex-end', marginTop: 'var(--s5)' }}
      >
        <button className="btn-sm btn-green" disabled={saving} onClick={() => void save()}>
          {saved ? <Icon name="check" /> : <Icon name="save" />} {saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </>
  )
}

// A connected/off status pill used by the integration section headers.
function StatusPill({ on }: { on: boolean }) {
  return (
    <span
      className="badge-pill"
      style={{
        marginLeft: 'auto',
        background: on ? 'color-mix(in oklab, #5a9c52 20%, transparent)' : 'var(--fill)',
        color: on ? '#7fbd6f' : 'var(--text-muted)',
      }}
    >
      {on ? 'Connected' : 'Off'}
    </span>
  )
}

// Inline marker on a field whose value is pinned by an environment variable.
// The field is rendered read-only by the caller; this just labels why.
function EnvLockTag() {
  return (
    <span
      title="This value is set by an environment variable and overrides the database. Remove the env var to edit it here."
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11.5,
        fontWeight: 600,
        color: 'var(--text-muted)',
        marginLeft: 8,
      }}
    >
      <Icon name="lock" style={{ fontSize: 14 }} /> Set by environment
    </span>
  )
}

// A labeled field that shows an env-lock tag and dims when env-managed.
function EnvField({
  label,
  locked,
  children,
}: {
  label: string
  locked: boolean
  children: React.ReactNode
}) {
  return (
    <Field
      label={
        <>
          {label}
          {locked && <EnvLockTag />}
        </>
      }
    >
      <div style={locked ? { opacity: 0.6, pointerEvents: 'none' } : undefined}>{children}</div>
    </Field>
  )
}

// ReadMeABook connection. URL + login token are stored in the HearthShelf
// database and editable here; the token is held server-side and never sent back,
// so it shows a masked placeholder once set. The login token comes from an RMAB
// admin (Users > Login Token) - give that service account the admin role.
function RmabIntegrationCard({ cfg }: { cfg: IntegrationsConfig }) {
  const qc = useQueryClient()
  const [url, setUrl] = useState(cfg.rmabUrl ?? '')
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: (patch: IntegrationsConfigPatch) => saveIntegrationsConfig(patch),
    onSuccess: (next) => {
      qc.setQueryData(integrationsKeys.config, next)
      qc.invalidateQueries({ queryKey: requestKeys.config }) // Requests nav gate
      setToken('')
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    },
  })

  const allLocked = cfg.env.rmabUrl && cfg.env.rmabLoginToken

  const onSave = () => {
    const patch: IntegrationsConfigPatch = {}
    if (!cfg.env.rmabUrl) patch.rmabUrl = url.trim() || null
    if (!cfg.env.rmabLoginToken && token.trim()) patch.rmabLoginToken = token.trim()
    save.mutate(patch)
  }

  return (
    <div style={{ marginBottom: 'var(--s7)' }}>
      <div className="section-head">
        <Icon name="bolt" />
        <h2>ReadMeABook</h2>
        <StatusPill on={cfg.rmabConfigured} />
      </div>
      <div className="cfg-card">
        <p className="sr-d" style={{ marginBottom: 'var(--s4)' }}>
          The audiobook request backend. When connected, requesting is available across HearthShelf.
        </p>
        <EnvField label="Server URL" locked={cfg.env.rmabUrl}>
          <input
            className="fld"
            placeholder="https://audiobooks.example.com"
            value={cfg.env.rmabUrl ? (cfg.rmabUrl ?? '') : url}
            disabled={cfg.env.rmabUrl}
            onChange={(e) => setUrl(e.target.value)}
          />
        </EnvField>
        <EnvField label="Login token" locked={cfg.env.rmabLoginToken}>
          <input
            className="fld"
            type="password"
            autoComplete="off"
            placeholder={
              cfg.env.rmabLoginToken
                ? '•••••••• (from environment)'
                : cfg.rmabHasToken
                  ? '•••••••• (leave blank to keep)'
                  : 'rmab_...'
            }
            value={token}
            disabled={cfg.env.rmabLoginToken}
            onChange={(e) => setToken(e.target.value)}
          />
        </EnvField>
        {!allLocked && (
          <div className="cfg-line" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn-sm btn-green" disabled={save.isPending} onClick={onSave}>
              {saved ? <Icon name="check" /> : <Icon name="save" />}{' '}
              {save.isPending ? 'Saving...' : saved ? 'Saved' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// Audplexus connection + library-sync health. URL + key are DB-backed and
// editable here (key held server-side, masked once set). When connected,
// surfaces a sync-issue alert so admins know when owned books don't line up
// with what's actually in ABS.
function AudplexusIntegrationCard({ cfg }: { cfg: IntegrationsConfig }) {
  const qc = useQueryClient()
  const [url, setUrl] = useState(cfg.audplexusUrl ?? '')
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)

  const connected = cfg.audplexusConfigured
  const { data: status } = useAudplexusStatus(connected)
  const issues = status?.booksFailed ?? 0
  const alert = status?.hasIssues === true

  const save = useMutation({
    mutationFn: (patch: IntegrationsConfigPatch) => saveIntegrationsConfig(patch),
    onSuccess: (next) => {
      qc.setQueryData(integrationsKeys.config, next)
      qc.invalidateQueries({ queryKey: ['audplexus'] })
      setKey('')
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    },
  })

  const allLocked = cfg.env.audplexusUrl && cfg.env.audplexusKey

  const onSave = () => {
    const patch: IntegrationsConfigPatch = {}
    if (!cfg.env.audplexusUrl) patch.audplexusUrl = url.trim() || null
    if (!cfg.env.audplexusKey && key.trim()) patch.audplexusKey = key.trim()
    save.mutate(patch)
  }

  return (
    <div style={{ marginBottom: 'var(--s7)' }}>
      <div className="section-head">
        <Icon name="sync" />
        <h2>Audplexus</h2>
        <StatusPill on={connected} />
      </div>
      <div className="cfg-card">
        <p className="sr-d" style={{ marginBottom: 'var(--s4)' }}>
          Watches your library for sync issues with AudiobookShelf.
        </p>
        <EnvField label="Server URL" locked={cfg.env.audplexusUrl}>
          <input
            className="fld"
            placeholder="https://audplexus.example.com"
            value={cfg.env.audplexusUrl ? (cfg.audplexusUrl ?? '') : url}
            disabled={cfg.env.audplexusUrl}
            onChange={(e) => setUrl(e.target.value)}
          />
        </EnvField>
        <EnvField label="API key" locked={cfg.env.audplexusKey}>
          <input
            className="fld"
            type="password"
            autoComplete="off"
            placeholder={
              cfg.env.audplexusKey
                ? '•••••••• (from environment)'
                : cfg.audplexusHasKey
                  ? '•••••••• (leave blank to keep)'
                  : 'Paste API key'
            }
            value={key}
            disabled={cfg.env.audplexusKey}
            onChange={(e) => setKey(e.target.value)}
          />
        </EnvField>
        {!allLocked && (
          <div className="cfg-line" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn-sm btn-green" disabled={save.isPending} onClick={onSave}>
              {saved ? <Icon name="check" /> : <Icon name="save" />}{' '}
              {save.isPending ? 'Saving...' : saved ? 'Saved' : 'Save'}
            </button>
          </div>
        )}

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

// Audible catalog region. DB-backed; controls which Audible marketplace
// HearthShelf's own catalog search queries.
function AudibleIntegrationCard({ cfg }: { cfg: IntegrationsConfig }) {
  const qc = useQueryClient()
  const [region, setRegion] = useState(cfg.audibleRegion)
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: (patch: IntegrationsConfigPatch) => saveIntegrationsConfig(patch),
    onSuccess: (next) => {
      qc.setQueryData(integrationsKeys.config, next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    },
  })

  return (
    <div style={{ marginBottom: 'var(--s7)' }}>
      <div className="section-head">
        <Icon name="travel_explore" />
        <h2>Audible catalog</h2>
      </div>
      <div className="cfg-card">
        <p className="sr-d" style={{ marginBottom: 'var(--s4)' }}>
          The Audible marketplace HearthShelf searches for discovery and requests.
        </p>
        <EnvField label="Region" locked={cfg.env.audibleRegion}>
          <select
            className="fld"
            value={cfg.env.audibleRegion ? cfg.audibleRegion : region}
            disabled={cfg.env.audibleRegion}
            onChange={(e) => setRegion(e.target.value as typeof region)}
          >
            {cfg.validRegions.map((r) => (
              <option key={r} value={r}>
                {REGION_LABELS[r] ?? r}
              </option>
            ))}
          </select>
        </EnvField>
        {!cfg.env.audibleRegion && (
          <div className="cfg-line" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button
              className="btn-sm btn-green"
              disabled={save.isPending || region === cfg.audibleRegion}
              onClick={() => save.mutate({ audibleRegion: region })}
            >
              {saved ? <Icon name="check" /> : <Icon name="save" />}{' '}
              {save.isPending ? 'Saving...' : saved ? 'Saved' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// --- Integrations (editable) ---
export function ConfigIntegrations() {
  const { data: integrations } = useQuery({
    queryKey: integrationsKeys.config,
    queryFn: getIntegrationsConfig,
    staleTime: 30 * 1000,
  })
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
        <p className="page-sub">
          Connect the external services HearthShelf works with. Settings are saved in HearthShelf
          and seeded from environment variables on first run.
        </p>
      </div>

      {!integrations ? (
        <LoadingSpinner className="py-12" label="Loading..." />
      ) : (
        <>
          <RmabIntegrationCard key={`rmab-${integrations.rmabHasToken}`} cfg={integrations} />
          <AudplexusIntegrationCard
            key={`apx-${integrations.audplexusHasKey}`}
            cfg={integrations}
          />
          <AudibleIntegrationCard key={`aud-${integrations.audibleRegion}`} cfg={integrations} />
        </>
      )}

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
