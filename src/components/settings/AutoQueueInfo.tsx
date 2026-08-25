import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AUTO_QUEUE_TRIGGERS,
  AUTO_QUEUE_NIGHTLY_NOTE,
  formatNextRebuild,
  formatQueueUpdated,
} from '@hearthshelf/core'
import { getQueueStatus, recomputeServerQueue } from '@/api/queue'
import { useQueueStore } from '@/store/queueStore'
import { Icon } from '@/components/common/Icon'

// Explains when the Auto queue rebuilds. Shown only in Auto mode, and written to
// answer the question people actually arrive with: "I started a new series and
// the rest of it isn't in my queue yet." The triggers lead (starting a book
// rebuilds within a couple of minutes); the nightly run is framed as the
// catch-up it is, so nobody waits overnight for something already in motion.
export function AutoQueueInfo() {
  const [open, setOpen] = useState(false)

  const { data, refetch } = useQuery({
    queryKey: ['queue-status'],
    queryFn: () => getQueueStatus(),
    enabled: open,
    // The countdown only needs minute resolution; refetch while the panel is open.
    refetchInterval: open ? 60_000 : false,
  })

  const updated = formatQueueUpdated(data?.updatedAt ?? null)
  const next = formatNextRebuild(data?.nextRebuildAt ?? null)

  return (
    <div className="cfg-card" style={{ marginBottom: 0 }}>
      <button
        type="button"
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}
      >
        <Icon name="info" />
        <span style={{ flex: 1, textAlign: 'left' }}>When does my queue update?</span>
        <Icon name={open ? 'expand_less' : 'expand_more'} />
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {updated && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
              Your queue last changed <strong>{updated}</strong>.
            </div>
          )}

          <div style={{ fontSize: 13, marginBottom: 6 }}>Your Auto queue rebuilds when:</div>
          <ul style={{ margin: '0 0 12px', paddingLeft: 20, fontSize: 13, lineHeight: 1.7 }}>
            {AUTO_QUEUE_TRIGGERS.map((t: string) => (
              <li key={t}>{t}</li>
            ))}
          </ul>

          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            {AUTO_QUEUE_NIGHTLY_NOTE}
            {next && (
              <>
                {' '}
                Next catch-up <strong>{next}</strong>.
              </>
            )}
          </div>
        </div>
      )}

      <RecomputeQueueButton onRecomputed={() => void refetch()} />
    </div>
  )
}

export function RecomputeQueueButton({ onRecomputed }: { onRecomputed?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const qc = useQueryClient()
  const setItems = useQueueStore((s) => s.setItems)

  const recompute = async () => {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const q = await recomputeServerQueue()
      // bump=false: this is a server-computed queue we're adopting, not a local
      // edit, so it must not look newer than what the server already stored -
      // otherwise the sync hook would push it straight back. Only `items` is
      // adopted: the recompute never rewrites the durable hand-queued list, and
      // setManual() unconditionally stamps updatedAt (a local-edit signal).
      setItems(q.items, false)
      onRecomputed?.()
      void qc.invalidateQueries({ queryKey: ['queue'] })
      setResult(
        q.recomputed === false
          ? `Could not rebuild: ${q.recomputeError ?? q.recomputeReason ?? 'the server kept the stored queue'}.`
          : `Rebuilt ${q.items.length} Auto Queue item${q.items.length === 1 ? '' : 's'}.`,
      )
    } catch {
      setResult('Could not reach the server to rebuild the Auto Queue.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-ghost"
        onClick={() => void recompute()}
        disabled={busy}
        style={{ marginTop: 12 }}
      >
        <Icon name="refresh" /> {busy ? 'Recomputing...' : 'Recompute Auto Queue'}
      </button>
      {result && (
        <div role="status" style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
          {result}
        </div>
      )}
    </>
  )
}
