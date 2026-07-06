import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getJobs,
  runJobNow,
  cancelJob,
  getRunLogs,
  jobKeys,
  type JobSummary,
  type JobRun,
} from '@/api/jobs'
import { useAdvancedMode } from '@/pages/config/AdvancedMode'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'

const STATUS_META: Record<string, { color: string; label: string }> = {
  running: { color: '#4f9db0', label: 'Running' },
  ok: { color: '#5a9c52', label: 'Success' },
  error: { color: '#d8443a', label: 'Failed' },
}

function fmtWhen(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function fmtInterval(ms: number): string {
  const h = ms / 3_600_000
  if (h % 24 === 0) return h / 24 === 1 ? 'Daily' : `Every ${h / 24} days`
  return h === 1 ? 'Hourly' : `Every ${h}h`
}

function fmtDuration(run: JobRun): string {
  if (!run.finishedAt) return ''
  const s = Math.round((run.finishedAt - run.startedAt) / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function RunLogs({ runId }: { runId: string }) {
  const { data } = useQuery({
    queryKey: jobKeys.logs(runId),
    queryFn: () => getRunLogs(runId),
    // Poll while a run may still be writing lines.
    refetchInterval: 3000,
  })
  const logs = data?.logs ?? []
  if (!logs.length) return <div className="job-logs empty">No log lines yet.</div>
  return (
    <div className="job-logs log-box">
      {logs.map((l) => (
        <div className="log-line" key={l.seq}>
          <span style={{ color: 'var(--text-faint)' }}>
            {new Date(l.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>{' '}
          {l.level !== 'info' && (
            <span style={{ color: l.level === 'error' ? '#d8443a' : '#d9a45a' }}>
              [{l.level.toUpperCase()}]
            </span>
          )}{' '}
          {l.message}
        </div>
      ))}
    </div>
  )
}

function JobCard({ job }: { job: JobSummary }) {
  const qc = useQueryClient()
  const { advanced } = useAdvancedMode()
  const [showLogs, setShowLogs] = useState(false)
  const run = job.lastRun
  const running = job.running || run?.status === 'running'

  const trigger = useMutation({
    mutationFn: () => runJobNow(job.id),
    onSuccess: () => {
      setShowLogs(true)
      // Refresh the list (status -> running) and poll for a bit.
      void qc.invalidateQueries({ queryKey: jobKeys.list })
    },
  })

  const kill = useMutation({
    mutationFn: () => cancelJob(job.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: jobKeys.list }),
  })

  const meta = run ? STATUS_META[run.status] : null
  const pct =
    running && run && run.itemsTotal > 0
      ? Math.round((run.itemsProcessed / run.itemsTotal) * 100)
      : null

  return (
    <div className="job-card">
      <div className="job-head">
        <div style={{ minWidth: 0 }}>
          <div className="job-name">{job.name}</div>
          <div className="job-desc">{job.description}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
          {advanced && running && (
            <button
              className="btn btn-danger"
              disabled={kill.isPending}
              onClick={() => kill.mutate()}
              title="Stop this running job"
            >
              <Icon name="stop_circle" fill />
              {kill.isPending ? 'Stopping...' : 'Kill'}
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={running || trigger.isPending}
            onClick={() => trigger.mutate()}
          >
            <Icon name={running ? 'hourglass_top' : 'play_arrow'} fill />
            {running ? 'Running...' : 'Run now'}
          </button>
        </div>
      </div>

      <div className="job-meta">
        <span>
          <Icon name="schedule" /> {fmtInterval(job.intervalMs)}
        </span>
        {run && meta && (
          <span style={{ color: meta.color }}>
            <Icon name="circle" fill /> {meta.label}
          </span>
        )}
        <span style={{ color: 'var(--text-muted)' }}>
          Last run: {fmtWhen(run?.startedAt ?? null)}
        </span>
        {run?.finishedAt && <span style={{ color: 'var(--text-faint)' }}>{fmtDuration(run)}</span>}
        {pct != null && <span style={{ color: 'var(--text-muted)' }}>{pct}%</span>}
      </div>

      {run?.summary && run.status === 'ok' && <div className="job-summary">{run.summary}</div>}
      {run?.error && (
        <div className="rr-err" style={{ marginTop: 8 }}>
          <Icon name="error" fill /> {run.error}
        </div>
      )}

      {run && (
        <button className="job-logs-toggle" onClick={() => setShowLogs((v) => !v)}>
          <Icon name={showLogs ? 'expand_less' : 'expand_more'} /> {showLogs ? 'Hide' : 'View'} logs
        </button>
      )}
      {showLogs && run && <RunLogs runId={run.id} />}
    </div>
  )
}

export function ConfigJobs() {
  const { data, isLoading } = useQuery({
    queryKey: jobKeys.list,
    queryFn: getJobs,
    // Keep last-run status fresh while a job may be running.
    refetchInterval: 5000,
  })

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Tasks</h1>
        <p className="page-sub">
          Background jobs that keep your library data fresh. They run on a schedule; you can also
          run one now and watch its log.
        </p>
      </div>

      {isLoading ? (
        <LoadingSpinner className="py-12" label="Loading tasks..." />
      ) : (
        <div className="job-list">
          {(data?.jobs ?? []).map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </>
  )
}
