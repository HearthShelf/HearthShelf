import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { getUsers, adminKeys } from '@/api/admin'
import {
  getQueueDebugReport,
  type QueueDebugReport,
  type QueueDebugRule,
  type QueueDebugTarget,
} from '@/api/queueDebug'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'

const RULE_LABELS: Record<string, string> = {
  'finish-series': 'Current series',
  'in-progress': 'In progress',
  'new-in-series': 'Started series',
  'new-in-series-all': 'All remaining series books',
  'book-club': 'Book Club',
  manual: 'Hand queued',
}

const REASON_LABELS: Record<string, string> = {
  added: 'Added here; this rule owns the queue position',
  duplicate: 'Already added by a higher-priority rule',
  current_item: 'This is the resolved current item',
  finished: 'ABS marks this item finished',
  dismissed_item: 'Durably hidden by “Not right now”',
  dismissed_series: 'Its series is ignored',
  missing_library_item: 'Not found in the visible library input',
  missing_guid: 'The source row has no library item GUID',
  no_current_item: 'No current item is available to seed this rule',
  not_after_current_item: 'Not after the current item in series order',
  not_in_current_series: 'Not in the resolved current item’s series',
  no_progress: 'No ABS progress row',
  progress_is_zero: 'ABS progress is zero',
  series_complete: 'Every visible book in the series is finished',
  series_not_started: 'No visible book in this series has been started',
  earlier_series_book_won_limit: 'An earlier unfinished book filled the one-book series limit',
  not_in_series_metadata: 'Not present in ABS series metadata',
  not_in_club_input: 'Not supplied by any active Book Club current/up-next list',
  not_hand_queued: 'Not in the durable hand-queued list',
  modifier_enabled: 'Modifier is enabled; it does not add books by itself',
  modifier_disabled: 'Modifier is disabled; it does not add books by itself',
}

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replaceAll('_', ' ')
}

function fmtDate(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : 'never'
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function StatusPill({ good, children }: { good: boolean; children: React.ReactNode }) {
  return (
    <span
      className="pill"
      style={{
        color: good ? '#83c77a' : '#e0a25b',
        borderColor: good ? 'rgba(131,199,122,.35)' : 'rgba(224,162,91,.35)',
      }}
    >
      {children}
    </span>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ minWidth: 150 }}>
      <div style={{ color: 'var(--text-faint)', fontSize: 11, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ marginTop: 3, overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  )
}

function RuleResult({ rule }: { rule: QueueDebugRule }) {
  return (
    <div className="cfg-card" style={{ marginBottom: 8, opacity: rule.enabled ? 1 : 0.55 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ flex: 1 }}>
          {rule.priority + 1}. {rule.label}
        </strong>
        <StatusPill good={rule.enabled}>
          {rule.enabled ? `${rule.added} added` : 'Disabled'}
        </StatusPill>
      </div>
      {rule.enabled && rule.attempts.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>
          No target evaluation recorded.
        </div>
      )}
      {rule.attempts.map((attempt, index) => (
        <div key={`${attempt.reason}-${index}`} style={{ fontSize: 13, marginTop: 8 }}>
          <Icon
            name={
              attempt.result === 'included'
                ? 'check_circle'
                : attempt.result === 'matched'
                  ? 'merge'
                  : 'cancel'
            }
            fill
            style={{
              color:
                attempt.result === 'included'
                  ? '#83c77a'
                  : attempt.result === 'matched'
                    ? '#76b8c8'
                    : '#d99068',
              marginRight: 6,
            }}
          />
          {reasonLabel(attempt.reason)}
          {attempt.seriesName ? ` · ${attempt.seriesName}` : ''}
          {attempt.clubs?.length ? ` · ${attempt.clubs.map((club) => club.name).join(', ')}` : ''}
        </div>
      ))}
    </div>
  )
}

function TargetReport({ target }: { target: QueueDebugTarget }) {
  const title = target.title ?? 'Unknown item'
  return (
    <section style={{ marginTop: 24 }}>
      <div className="eyebrow">GUID explanation</div>
      <h2 style={{ margin: '4px 0 6px' }}>{title}</h2>
      <div
        style={{ color: 'var(--text-muted)', fontFamily: 'monospace', overflowWrap: 'anywhere' }}
      >
        {target.libraryItemId}
      </div>

      <div style={{ marginTop: 14 }}>
        <StatusPill good={target.included}>
          {target.included
            ? `Included at position ${(target.position ?? 0) + 1}`
            : target.dismissedItem
              ? 'Excluded: Not right now dismissal'
              : target.isFinished
                ? 'Excluded: marked finished'
                : target.isCurrentItem
                  ? 'Excluded: current item'
                  : 'Not included'}
        </StatusPill>{' '}
        {target.winningRule && (
          <StatusPill good>
            Winner: {RULE_LABELS[target.winningRule] ?? target.winningRule}
          </StatusPill>
        )}
      </div>

      <div
        className="cfg-card"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 22, marginTop: 14 }}
      >
        <Fact label="Visible library item" value={target.inVisibleLibrary ? 'Yes' : 'No'} />
        <Fact label="Current item" value={target.isCurrentItem ? 'Yes' : 'No'} />
        <Fact label="Finished" value={target.isFinished ? 'Yes' : 'No'} />
        <Fact label="Dismissed" value={target.dismissedItem ? 'Yes — Not right now' : 'No'} />
        <Fact label="Progress" value={target.progress ? pct(target.progress.progress) : 'No row'} />
        <Fact
          label="Series"
          value={target.series.map((series) => series.name).join(', ') || 'None'}
        />
      </div>

      {target.hiddenByPermissions && (
        <div className="rr-err" style={{ marginTop: 10 }}>
          <Icon name="visibility_off" /> The item exists, but this user’s library/tag permissions
          hide it.
        </div>
      )}

      <h3 style={{ margin: '20px 0 10px' }}>Rule-by-rule evaluation</h3>
      {target.rules.map((rule) => (
        <RuleResult key={rule.id} rule={rule} />
      ))}
    </section>
  )
}

function Report({ report, inspect }: { report: QueueDebugReport; inspect: (id: string) => void }) {
  return (
    <>
      {report.warnings.map((warning) => (
        <div className="rr-err" style={{ marginTop: 10 }} key={warning}>
          <Icon name="warning" fill /> {warning}
        </div>
      ))}

      <div
        className="cfg-card"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 22, marginTop: 16 }}
      >
        <Fact label="User" value={`${report.user.username} · ${report.user.type}`} />
        <Fact label="Mode" value={report.mode} />
        <Fact label="Stored current" value={report.stored.currentItemId ?? 'None'} />
        <Fact
          label="Resolved current"
          value={`${report.current.id ?? 'None'} · ${report.current.source}`}
        />
        <Fact label="Stored update" value={fmtDate(report.stored.updatedAt)} />
        <Fact label="Core trace parity" value={report.result.parity ? 'Match' : 'MISMATCH'} />
      </div>

      <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {report.rules.map((rule, index) => (
          <span className="pill" key={rule.id} style={{ opacity: rule.on ? 1 : 0.45 }}>
            {index + 1}. {RULE_LABELS[rule.id] ?? rule.id} {rule.on ? '' : '(off)'}
          </span>
        ))}
      </div>

      <div
        className="cfg-card"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 22, marginTop: 14 }}
      >
        <Fact label="Libraries" value={report.inputs.libraries.length} />
        <Fact label="Library items" value={report.inputs.libraryItems} />
        <Fact label="Series" value={report.inputs.series} />
        <Fact label="Progress rows" value={report.inputs.progressRows} />
        <Fact
          label="Book Clubs"
          value={`${report.inputs.clubs.length} · ${report.inputs.clubBooks} books`}
        />
        <Fact label="Manual books" value={report.inputs.manualBooks} />
        <Fact label="Item dismissals" value={report.inputs.dismissals.items.length} />
        <Fact label="Series dismissals" value={report.inputs.dismissals.series.length} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 16,
          marginTop: 16,
        }}
      >
        <section className="cfg-card" style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ margin: 0, flex: 1 }}>Computed queue · {report.result.queue.length}</h3>
            <StatusPill good={report.result.sameOrder}>
              {report.result.sameOrder ? 'Matches stored' : 'Differs from stored'}
            </StatusPill>
          </div>
          <div style={{ maxHeight: 430, overflow: 'auto', marginTop: 10 }}>
            {report.result.queue.map((entry) => (
              <button
                key={entry.libraryItemId}
                type="button"
                className="btn-ghost"
                onClick={() => inspect(entry.libraryItemId)}
                style={{
                  display: 'flex',
                  width: '100%',
                  textAlign: 'left',
                  gap: 10,
                  padding: '8px 4px',
                }}
              >
                <span style={{ width: 28, color: 'var(--text-faint)' }}>{entry.position + 1}.</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{entry.title}</strong>
                  <span
                    style={{
                      display: 'block',
                      color: 'var(--text-faint)',
                      fontSize: 11,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {entry.libraryItemId}
                  </span>
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {RULE_LABELS[entry.winningRule ?? ''] ?? entry.winningRule ?? '—'}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="cfg-card" style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>Excluded by “Not right now”</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            These durable exclusions survive every recompute. Click one to explain it.
          </p>
          <div style={{ maxHeight: 365, overflow: 'auto' }}>
            {report.inputs.dismissals.items.length === 0 && (
              <span style={{ color: 'var(--text-faint)' }}>None</span>
            )}
            {report.inputs.dismissals.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="btn-ghost"
                onClick={() => inspect(item.id)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 4px' }}
              >
                <strong>{item.title ?? 'Unknown title'}</strong>
                <span
                  style={{
                    display: 'block',
                    color: 'var(--text-faint)',
                    fontSize: 11,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {item.id}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {report.target && <TargetReport target={report.target} />}
    </>
  )
}

export function ConfigQueueDebugger() {
  const [userId, setUserId] = useState('')
  const [itemId, setItemId] = useState('')
  const users = useQuery({ queryKey: adminKeys.users, queryFn: getUsers, staleTime: 60_000 })
  const debug = useMutation({
    mutationFn: ({ selectedUser, selectedItem }: { selectedUser: string; selectedItem: string }) =>
      getQueueDebugReport(selectedUser, selectedItem || undefined),
  })

  useEffect(() => {
    if (!userId && users.data?.users.length) setUserId(users.data.users[0].id)
  }, [userId, users.data])

  const load = (nextItem = itemId) => {
    if (!userId) return
    const cleaned = nextItem.trim()
    setItemId(cleaned)
    debug.mutate({ selectedUser: userId, selectedItem: cleaned })
  }

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Advanced · read only</div>
        <h1 className="title-xl">Auto Queue Debugger</h1>
        <p className="page-sub">
          Load any user’s server-owned queue inputs, then inspect a library item GUID to see every
          matching rule, exclusion, duplicate, and winning priority.
        </p>
      </div>

      <div className="cfg-card">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <label>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--text-muted)',
                marginBottom: 5,
              }}
            >
              User
            </span>
            <select
              className="input"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">Choose a user</option>
              {(users.data?.users ?? []).map((user) => (
                <option value={user.id} key={user.id}>
                  {user.username} · {user.type}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--text-muted)',
                marginBottom: 5,
              }}
            >
              Library item GUID <span style={{ color: 'var(--text-faint)' }}>(optional)</span>
            </span>
            <input
              className="input"
              value={itemId}
              onChange={(event) => setItemId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') load()
              }}
              placeholder="Paste a GUID, or click an item after loading"
              style={{ width: '100%' }}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={!userId || debug.isPending}
            onClick={() => load()}
          >
            <Icon name="troubleshoot" fill /> {debug.isPending ? 'Inspecting…' : 'Load diagnostics'}
          </button>
        </div>
      </div>

      {debug.isPending && <LoadingSpinner className="py-12" label="Building queue explanation…" />}
      {debug.error && (
        <div className="rr-err" style={{ marginTop: 14 }}>
          <Icon name="error" fill /> {debug.error.message}
        </div>
      )}
      {debug.data && !debug.isPending && <Report report={debug.data} inspect={load} />}
    </>
  )
}
