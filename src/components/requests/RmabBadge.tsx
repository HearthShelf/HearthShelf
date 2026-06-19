import { statusMeta } from '@/api/requests'

interface RmabBadgeProps {
  status: string
  progress?: number
  releaseDate?: string | null
  showRelease?: boolean
}

// dot | pulse | spin, derived from the status (matches the design reference).
function indicator(status: string, progress?: number): 'dot' | 'pulse' | 'spin' {
  if (status === 'downloading') return !progress || progress <= 0 ? 'spin' : 'pulse'
  if (status === 'searching' || status === 'processing' || status === 'awaiting_import') return 'spin'
  return 'dot'
}

export function RmabBadge({ status, progress, releaseDate, showRelease }: RmabBadgeProps) {
  const meta = statusMeta(status)
  const mode = indicator(status, progress)
  const label =
    status === 'downloading' && (!progress || progress <= 0) ? 'Initializing...' : meta.label
  const bg = `color-mix(in oklab, ${meta.color} 20%, transparent)`
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span className="rmab-badge" style={{ background: bg, color: meta.color }}>
        {mode === 'spin' ? (
          <span className="rmab-spin" />
        ) : (
          <span className={'dot' + (mode === 'pulse' ? ' pulse' : '')} style={{ background: meta.color }} />
        )}
        {label}
      </span>
      {showRelease && releaseDate && <span className="rmab-release">Releases {releaseDate}</span>}
    </span>
  )
}

interface RmabProgressProps {
  progress: number
  color?: string
}

export function RmabProgress({ progress, color }: RmabProgressProps) {
  const p = Math.max(0, Math.min(100, Math.round(progress || 0)))
  return (
    <div className="rmab-prog" style={{ ['--rmc' as string]: color || 'var(--accent)' }}>
      <div className="bar">
        <i style={{ width: p + '%' }} />
      </div>
      <span className="pct">{p}%</span>
    </div>
  )
}
