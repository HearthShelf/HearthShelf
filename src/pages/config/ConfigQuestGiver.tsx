import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useQgConfig } from '@/hooks/useQuestGiver'

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

// QuestGiver is HearthShelf's own backend, configured by env vars at container
// start (QG_ENABLED, QG_PROVIDER, QG_MODEL, QG_API_KEY, QG_LIMIT) - not editable
// from the UI, mirroring how the other env-driven admin pages read-only display
// their state. This panel surfaces the live status the backend reports.
export function ConfigQuestGiver() {
  const { data, isLoading } = useQgConfig()

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">QuestGiver</h1>
        <p className="page-sub">
          The next-listen matchmaker. Configured via environment variables at container start.
        </p>
      </div>

      {isLoading || !data ? (
        <LoadingSpinner className="py-12" label="Loading..." />
      ) : (
        <>
          <div className="section-head">
            <Icon name="toggle_on" />
            <h2>Feature</h2>
          </div>
          <div className="cfg-card">
            <Row
              icon="explore"
              label="QuestGiver enabled"
              value={data.featureEnabled ? 'On' : 'Off (QG_ENABLED)'}
            />
            <Row
              icon="tune"
              label="Recommender"
              value={data.enabled ? 'AI provider' : 'Built-in heuristic (no AI)'}
            />
          </div>

          <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
            <Icon name="smart_toy" />
            <h2>AI provider</h2>
          </div>
          {data.enabled ? (
            <div className="cfg-card">
              <Row icon="hub" label="Provider" value={data.provider ?? '—'} />
              <Row icon="memory" label="Model" value={data.model ?? '—'} />
              <Row icon="key" label="API key" value="Set (held server-side)" />
            </div>
          ) : (
            <div className="empty-state">
              <Icon name="smart_toy" />
              <h3>No AI provider configured</h3>
              <p>
                Set QG_PROVIDER, QG_MODEL and QG_API_KEY to use an AI model. Without them, QuestGiver
                still works using its built-in heuristic recommender.
              </p>
            </div>
          )}

          <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
            <Icon name="speed" />
            <h2>Rate limit</h2>
          </div>
          <div className="cfg-card">
            <Row
              icon="bolt"
              label="Per-user cap"
              value={
                data.limit == null
                  ? 'Unlimited (QG_LIMIT=off)'
                  : `${data.limit} per ${data.period ?? 'period'}`
              }
            />
            {data.limit != null && data.remaining != null && (
              <Row icon="schedule" label="Your remaining" value={String(data.remaining)} />
            )}
          </div>
        </>
      )}
    </>
  )
}
