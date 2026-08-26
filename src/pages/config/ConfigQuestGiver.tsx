import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useToast } from '@/hooks/useToast'
import {
  getQgAdminConfig,
  getQgProviderModels,
  saveQgAdminConfig,
  type QgAdminConfig,
  type QgAdminConfigPatch,
} from '@/api/questgiver'

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI (or compatible)',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
  copilot: 'GitHub Copilot',
}

// Inline marker shown next to a field whose value is pinned by an environment
// variable (the env value overrides the database, so the field is read-only).
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

// QuestGiver's AI settings are stored in the HearthShelf database and edited
// here. Any field whose QG_* / DISCOVER_ENABLED environment variable is set
// overrides the database and shows as read-only ("Set by environment"). The API
// key is held server-side and never sent back to the browser - leave it blank to
// keep the current one.
export function ConfigQuestGiver() {
  const qc = useQueryClient()
  const { toast, show } = useToast()
  const { data, isLoading } = useQuery({
    queryKey: ['qg-admin-config'],
    queryFn: getQgAdminConfig,
    staleTime: 30 * 1000,
  })

  const [form, setForm] = useState<QgAdminConfigPatch>({})
  const [keyInput, setKeyInput] = useState('')

  const models = useMutation({
    mutationFn: getQgProviderModels,
  })

  // Hydrate the editable form when a *new* server config arrives (e.g. first
  // load or after an external refetch). Guarded by updated identity so typing in
  // the form - which doesn't change `data` - never clobbers user edits.
  const hydratedFrom = useRef<QgAdminConfig | null>(null)
  useEffect(() => {
    if (data && hydratedFrom.current !== data) {
      hydratedFrom.current = data
      setForm({
        provider: data.provider ?? '',
        model: data.model ?? '',
        baseUrl: data.baseUrl ?? '',
        limit: data.limit ?? 'off',
        enabled: data.enabled,
        discoverEnabled: data.discoverEnabled,
      })
      setKeyInput('')
      if (data.provider && data.hasKey) {
        models.mutate({ provider: data.provider, baseUrl: data.baseUrl ?? '' })
      } else {
        models.reset()
      }
    }
    // `models` is a stable mutation observer; only a new server config should
    // rehydrate the form and refresh the account-specific model list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const save = useMutation({
    mutationFn: (patch: QgAdminConfigPatch) => saveQgAdminConfig(patch),
    onSuccess: (next: QgAdminConfig) => {
      qc.setQueryData(['qg-admin-config'], next)
      qc.invalidateQueries({ queryKey: ['qg-config'] }) // live status pill
      show('QuestGiver settings saved')
      setKeyInput('')
    },
    onError: () => show('Could not save - admin permission required'),
  })

  const set = <K extends keyof QgAdminConfigPatch>(key: K, value: QgAdminConfigPatch[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const onSave = () => {
    const patch: QgAdminConfigPatch = { ...form }
    if (keyInput.trim()) patch.apiKey = keyInput.trim()
    save.mutate(patch)
  }

  if (isLoading || !data) {
    return (
      <>
        <div className="page-head">
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">QuestGiver</h1>
        </div>
        <LoadingSpinner className="py-12" label="Loading..." />
      </>
    )
  }

  const selectedProvider = data.env.provider ? (data.provider ?? '') : (form.provider ?? '')
  const isCopilot = selectedProvider === 'copilot'
  const hasCredential = selectedProvider === (data.provider ?? '') && data.hasKey
  const modelOptions = models.data?.models ?? []
  const loadModels = () => {
    const draft: QgAdminConfigPatch = {
      provider: selectedProvider,
      baseUrl: data.env.baseUrl ? (data.baseUrl ?? '') : (form.baseUrl ?? ''),
    }
    if (keyInput.trim()) draft.apiKey = keyInput.trim()
    models.mutate(draft)
  }

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">QuestGiver</h1>
        <p className="page-sub">
          The next-listen matchmaker. Settings are stored in HearthShelf; any field set by an
          environment variable overrides what you save here.
        </p>
      </div>

      <div className="section-head">
        <Icon name="toggle_on" />
        <h2>Feature</h2>
      </div>
      <div className="cfg-card">
        <div className="set-row">
          <div className="sr-meta">
            <div className="sr-t">
              QuestGiver enabled
              {data.env.enabled && <EnvLockTag />}
            </div>
            <div className="sr-d">
              Turn the AI recommender on or off. The built-in heuristic still works when no AI
              provider is set.
            </div>
          </div>
          <div
            className={'toggle' + ((data.env.enabled ? data.enabled : form.enabled) ? ' on' : '')}
            role="switch"
            aria-checked={data.env.enabled ? data.enabled : !!form.enabled}
            aria-disabled={data.env.enabled}
            style={data.env.enabled ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
            onClick={() => !data.env.enabled && set('enabled', !form.enabled)}
          >
            <i />
          </div>
        </div>
        <div className="set-row" style={{ marginTop: 'var(--s4)' }}>
          <div className="sr-meta">
            <div className="sr-t">
              Discover shelves
              {data.env.discoverEnabled && <EnvLockTag />}
            </div>
            <div className="sr-d">
              Show the ambient Discover page and its history-driven shelves, plus the QuestGiver
              prompt in the sidebar and on Discover.
            </div>
          </div>
          <div
            className={
              'toggle' +
              ((data.env.discoverEnabled ? data.discoverEnabled : form.discoverEnabled)
                ? ' on'
                : '')
            }
            role="switch"
            aria-checked={data.env.discoverEnabled ? data.discoverEnabled : !!form.discoverEnabled}
            aria-disabled={data.env.discoverEnabled}
            style={data.env.discoverEnabled ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
            onClick={() =>
              !data.env.discoverEnabled && set('discoverEnabled', !form.discoverEnabled)
            }
          >
            <i />
          </div>
        </div>
      </div>

      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="smart_toy" />
        <h2>AI provider</h2>
      </div>
      <div className="cfg-card">
        <div className="field full">
          <label>Provider{data.env.provider && <EnvLockTag />}</label>
          <select
            className="fld"
            value={data.env.provider ? (data.provider ?? '') : (form.provider ?? '')}
            disabled={data.env.provider}
            onChange={(e) => {
              set('provider', e.target.value)
              set('model', '')
              models.reset()
            }}
          >
            <option value="">None (use heuristic)</option>
            {data.validProviders.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p] ?? p}
              </option>
            ))}
          </select>
        </div>
        <div className="field full">
          <label>Model{data.env.model && <EnvLockTag />}</label>
          <input
            className="fld"
            list="questgiver-provider-models"
            placeholder={isCopilot ? 'auto' : 'Choose or enter a model'}
            value={data.env.model ? (data.model ?? '') : (form.model ?? '')}
            disabled={data.env.model}
            onChange={(e) => set('model', e.target.value)}
          />
          <datalist id="questgiver-provider-models">
            {modelOptions.map((option) => (
              <option key={option.id} value={option.id} label={option.name} />
            ))}
          </datalist>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                !selectedProvider || models.isPending || (!hasCredential && !keyInput.trim())
              }
              onClick={loadModels}
            >
              <Icon name="refresh" /> {models.isPending ? 'Loading models…' : 'Load models'}
            </button>
            {models.isSuccess && (
              <span className="sr-d">
                {modelOptions.length} model{modelOptions.length === 1 ? '' : 's'} available
              </span>
            )}
            {models.isError && (
              <span className="sr-d" style={{ color: 'var(--danger)' }}>
                Could not load models. Check the credential and provider URL.
              </span>
            )}
          </div>
          <p className="sr-d" style={{ marginTop: 6 }}>
            Models are loaded from the connected provider. You can still enter an exact model ID for
            a compatible server that does not publish a model list.
          </p>
        </div>
        <div className="field full">
          <label>
            {isCopilot ? 'GitHub token' : 'API key'}
            {data.env.apiKey && <EnvLockTag />}
          </label>
          <input
            className="fld"
            type="password"
            autoComplete="off"
            placeholder={
              data.env.apiKey
                ? '•••••••• (from environment)'
                : hasCredential
                  ? '•••••••• (leave blank to keep)'
                  : isCopilot
                    ? 'Fine-grained token with Copilot Requests access'
                    : 'Paste API key'
            }
            value={keyInput}
            disabled={data.env.apiKey}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          {isCopilot && (
            <p className="sr-d" style={{ marginTop: 6 }}>
              Uses the connected GitHub account's Copilot subscription. Fine-grained personal,
              OAuth, and GitHub App user tokens are supported; classic personal tokens are not.
            </p>
          )}
        </div>
        <div className="field full">
          <label>Base URL (optional){data.env.baseUrl && <EnvLockTag />}</label>
          <input
            className="fld"
            placeholder="For OpenAI-compatible endpoints (OpenRouter, Ollama, …)"
            value={data.env.baseUrl ? (data.baseUrl ?? '') : (form.baseUrl ?? '')}
            disabled={data.env.baseUrl || isCopilot}
            onChange={(e) => set('baseUrl', e.target.value)}
          />
          {isCopilot && (
            <p className="sr-d" style={{ marginTop: 6 }}>
              GitHub Copilot does not use a custom Base URL.
            </p>
          )}
        </div>
      </div>

      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="speed" />
        <h2>Rate limit</h2>
      </div>
      <div className="cfg-card">
        <div className="field full">
          <label>Per-user cap{data.env.limit && <EnvLockTag />}</label>
          <input
            className="fld"
            placeholder="off, or N/day · N/week · N/month"
            value={data.env.limit ? data.limit : (form.limit ?? 'off')}
            disabled={data.env.limit}
            onChange={(e) => set('limit', e.target.value)}
          />
          <p className="sr-d" style={{ marginTop: 6 }}>
            Examples: <code>off</code>, <code>5/day</code>, <code>20/week</code>,{' '}
            <code>50/month</code>.
          </p>
        </div>
      </div>

      {!Object.values(data.env).every(Boolean) && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 'var(--s5)' }}>
          <button className="btn btn-primary" disabled={save.isPending} onClick={onSave}>
            <Icon name="save" /> {save.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}

      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </>
  )
}
