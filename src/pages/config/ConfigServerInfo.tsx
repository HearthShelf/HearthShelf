import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { absRequest } from '@/api/client'
import type { ABSStatusResponse, ABSServerSettings } from '@/api/types'
import { getServerSettings, updateServerSettings } from '@/api/admin'
import { setServerName } from '@/api/runtime'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import { useToast } from '@/hooks/useToast'
import { useAdvancedMode } from '@/pages/config/AdvancedMode'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'

export function ConfigServerInfo() {
  const { advanced } = useAdvancedMode()
  const { data } = useQuery({
    queryKey: ['server-status'],
    queryFn: () => absRequest<ABSStatusResponse>('/status'),
    staleTime: 5 * 60 * 1000,
    enabled: advanced,
  })

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">General</h1>
      </div>

      <ServerNameSetting />

      {advanced &&
        (!data ? (
          <LoadingSpinner className="py-12" label="Loading server info..." />
        ) : (
          <>
            <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
              <Icon name="code" />
              <h2>Advanced</h2>
            </div>
            <div className="cfg-card">
              {(
                [
                  ['dns', 'Server', data.app ?? 'audiobookshelf', false],
                  ['info', 'Version', data.serverVersion ?? '—', true],
                  ['language', 'Language', data.language ?? '—', false],
                  ['lock', 'Auth methods', (data.authMethods ?? []).join(', ') || '—', false],
                ] as [string, string, string, boolean][]
              ).map(([icon, label, value, mono]) => (
                <div className="cfg-line" key={label}>
                  <Icon name={icon} style={{ color: 'var(--text-muted)' }} />
                  <div className="cl-meta">
                    <div className="cl-t">{label}</div>
                  </div>
                  <span
                    style={{
                      color: 'var(--text-muted)',
                      fontFamily: mono ? 'var(--font-mono)' : undefined,
                    }}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </>
        ))}

      <ScannerDisplaySettings />
    </>
  )
}

// Editable server name - how the server is referred to (and the default name
// sent when connecting to app.hearthshelf.com). Source of truth for the name.
function ServerNameSetting() {
  const qc = useQueryClient()
  const { toast, show } = useToast()
  const { data: runtime } = useRuntimeConfig()
  const [name, setName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Seed from runtime once, then let the field own the value (no effect needed -
  // null means "not yet edited", fall back to the loaded name).
  const value = name ?? runtime?.serverName ?? ''

  async function save() {
    if (value.trim().length < 2) {
      show('Give your server a name (at least 2 characters)')
      return
    }
    setSaving(true)
    try {
      await setServerName(value.trim())
      await qc.invalidateQueries({ queryKey: ['runtime-config'] })
      show('Server name saved')
    } catch {
      show('Could not save the server name')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="section-head">
        <Icon name="badge" />
        <h2>Server name</h2>
      </div>
      <div className="cfg-card">
        <div className="field full">
          <label htmlFor="server-name">How your server is referred to</label>
          <input
            id="server-name"
            className="fld"
            value={value}
            placeholder="Living Room Library"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={() => void save()}
          style={{ marginTop: 'var(--s2)' }}
        >
          <Icon name="save" /> {saving ? 'Saving…' : 'Save name'}
        </button>
      </div>
      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </>
  )
}

const SCANNER_TOGGLES: {
  key:
    | 'scannerFindCovers'
    | 'scannerParseSubtitle'
    | 'scannerPreferMatchedMetadata'
    | 'scannerDisableWatcher'
    | 'storeCoverWithItem'
  label: string
  desc: string
}[] = [
  {
    key: 'scannerFindCovers',
    label: 'Find covers',
    desc: 'Search for a cover online when an item has none.',
  },
  {
    key: 'scannerParseSubtitle',
    label: 'Parse subtitles',
    desc: 'Pull a subtitle from the folder name after a dash.',
  },
  {
    key: 'scannerPreferMatchedMetadata',
    label: 'Prefer matched metadata',
    desc: 'Let matched provider data override existing details.',
  },
  {
    key: 'scannerDisableWatcher',
    label: 'Disable folder watcher',
    desc: 'Stop scanning automatically when files change on disk.',
  },
  {
    key: 'storeCoverWithItem',
    label: 'Store covers with item',
    desc: 'Save the cover alongside the audio files instead of in metadata.',
  },
]

function ScannerDisplaySettings() {
  const { data } = useQuery({
    queryKey: ['admin', 'server-settings'],
    queryFn: getServerSettings,
    staleTime: 60 * 1000,
  })

  if (!data) return null
  return <ScannerDisplayForm key={JSON.stringify(data)} settings={data} />
}

function ScannerDisplayForm({ settings }: { settings: ABSServerSettings }) {
  const qc = useQueryClient()

  const [toggles, setToggles] = useState<Record<string, boolean>>({
    scannerFindCovers: !!settings.scannerFindCovers,
    scannerParseSubtitle: !!settings.scannerParseSubtitle,
    scannerPreferMatchedMetadata: !!settings.scannerPreferMatchedMetadata,
    scannerDisableWatcher: !!settings.scannerDisableWatcher,
    storeCoverWithItem: !!settings.storeCoverWithItem,
  })
  const [dateFormat, setDateFormat] = useState(settings.dateFormat ?? '')
  const [timeFormat, setTimeFormat] = useState(settings.timeFormat ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await updateServerSettings({
        ...toggles,
        dateFormat: dateFormat || undefined,
        timeFormat: timeFormat || undefined,
      })
      qc.invalidateQueries({ queryKey: ['admin', 'server-settings'] })
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="manage_search" />
        <h2>Scanner</h2>
      </div>
      <div className="cfg-card">
        {SCANNER_TOGGLES.map((t) => (
          <div className="cfg-line" key={t.key}>
            <Icon name="tune" style={{ color: 'var(--text-muted)' }} />
            <div className="cl-meta" style={{ flex: 1 }}>
              <div className="cl-t">{t.label}</div>
              <div className="cl-d">{t.desc}</div>
            </div>
            <button
              className={toggles[t.key] ? 'toggle on' : 'toggle'}
              aria-pressed={!!toggles[t.key]}
              onClick={() => setToggles((cur) => ({ ...cur, [t.key]: !cur[t.key] }))}
            >
              <i />
            </button>
          </div>
        ))}
      </div>

      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="calendar_today" />
        <h2>Display</h2>
      </div>
      <div className="cfg-card">
        <div className="cfg-line" style={{ gap: 12 }}>
          <div className="cl-meta" style={{ width: 150, flex: 'none' }}>
            <div className="cl-t">Date format</div>
          </div>
          <input
            className="fld"
            placeholder="MM/dd/yyyy"
            value={dateFormat}
            onChange={(e) => setDateFormat(e.target.value)}
          />
        </div>
        <div className="cfg-line" style={{ gap: 12 }}>
          <div className="cl-meta" style={{ width: 150, flex: 'none' }}>
            <div className="cl-t">Time format</div>
          </div>
          <input
            className="fld"
            placeholder="HH:mm"
            value={timeFormat}
            onChange={(e) => setTimeFormat(e.target.value)}
          />
        </div>
      </div>

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
