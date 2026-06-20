import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useToast } from '@/hooks/useToast'
import {
  getQgAdminConfig,
  saveQgAdminConfig,
  type QgAdminConfig,
  type QgAdminConfigPatch,
} from '@/api/questgiver'

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI (or compatible)',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
}

// QuestGiver's AI settings are stored in the HearthShelf database and edited
// here. On first run they're seeded from the QG_* env vars; after that, what you
// save below wins. The API key is held server-side and never sent back to the
// browser - leave it blank to keep the current one.
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
      })
      setKeyInput('')
    }
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

  const set = <K extends keyof QgAdminConfigPatch>(
    key: K,
    value: QgAdminConfigPatch[K]
  ) => setForm((f) => ({ ...f, [key]: value }))

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

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">QuestGiver</h1>
        <p className="page-sub">
          The next-listen matchmaker. Settings are stored in HearthShelf and
          seeded from your QG_* environment variables on first run.
        </p>
      </div>

      <div className="section-head">
        <Icon name="toggle_on" />
        <h2>Feature</h2>
      </div>
      <div className="cfg-card">
        <div className="set-row">
          <div className="sr-meta">
            <div className="sr-t">QuestGiver enabled</div>
            <div className="sr-d">
              Turn the AI recommender on or off. The built-in heuristic still
              works when no AI provider is set.
            </div>
          </div>
          <div
            className={'toggle' + (form.enabled ? ' on' : '')}
            role="switch"
            aria-checked={!!form.enabled}
            onClick={() => set('enabled', !form.enabled)}
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
          <label>Provider</label>
          <select
            className="fld"
            value={form.provider ?? ''}
            onChange={(e) => set('provider', e.target.value)}
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
          <label>Model</label>
          <input
            className="fld"
            placeholder="e.g. claude-sonnet-4-6"
            value={form.model ?? ''}
            onChange={(e) => set('model', e.target.value)}
          />
        </div>
        <div className="field full">
          <label>API key</label>
          <input
            className="fld"
            type="password"
            autoComplete="off"
            placeholder={data.hasKey ? '•••••••• (leave blank to keep)' : 'Paste API key'}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
        </div>
        <div className="field full">
          <label>Base URL (optional)</label>
          <input
            className="fld"
            placeholder="For OpenAI-compatible endpoints (OpenRouter, Ollama, …)"
            value={form.baseUrl ?? ''}
            onChange={(e) => set('baseUrl', e.target.value)}
          />
        </div>
      </div>

      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="speed" />
        <h2>Rate limit</h2>
      </div>
      <div className="cfg-card">
        <div className="field full">
          <label>Per-user cap</label>
          <input
            className="fld"
            placeholder="off, or N/day · N/week · N/month"
            value={form.limit ?? 'off'}
            onChange={(e) => set('limit', e.target.value)}
          />
          <p className="sr-d" style={{ marginTop: 6 }}>
            Examples: <code>off</code>, <code>5/day</code>, <code>20/week</code>,{' '}
            <code>50/month</code>.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 'var(--s5)' }}>
        <button
          className="btn btn-primary"
          disabled={save.isPending}
          onClick={onSave}
        >
          <Icon name="save" /> {save.isPending ? 'Saving…' : 'Save settings'}
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
