/**
 * Home's dashboard band: an "Up next" queue peek beside the listening streak.
 * The left card opens the player's queue panel, the right goes to Stats.
 *
 * The streak card calls out a streak on the line (a run going, but nothing
 * listened today) since that's the one moment the number is actionable.
 *
 * ABS's /api/me/listening-stats has no streak of its own - core's
 * computeListeningStats derives it from the per-day map, the same way the Stats
 * page and mobile do, so all three agree on what counts as a day.
 */
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { computeListeningStats, formatDuration } from '@hearthshelf/core'
import { getListeningStats, meKeys } from '@/api/me'
import { usePlayerStore } from '@/store/playerStore'
import { useQueueStore } from '@/store/queueStore'
import { useSettingsStore } from '@/store/settingsStore'
import { Cover } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'

const QUEUE_MODE_LABELS: Record<string, string> = {
  off: 'Off',
  manual: 'Manual',
  series: 'Series',
  auto: 'Auto',
}

export function DashboardRow() {
  const navigate = useNavigate()
  const requestPanel = usePlayerStore((s) => s.requestPanel)
  const items = useQueueStore((s) => s.items)
  const queueMode = useSettingsStore((s) => s.queueMode)

  // Shares the Stats page's cache entry, so this is free once Stats is visited.
  const { data: raw } = useQuery({
    queryKey: meKeys.stats,
    queryFn: getListeningStats,
    staleTime: 60 * 1000,
  })
  const stats = raw ? computeListeningStats(raw, new Date()) : null

  const preview = items.slice(0, 3)
  const modeLabel = QUEUE_MODE_LABELS[queueMode] ?? 'Off'
  // Streak nudge: nothing listened today, but there's a run to protect.
  const streakAtRisk = stats != null && stats.todaySec === 0 && stats.dayStreak > 0

  const openQueue = () => {
    requestPanel('queue')
    navigate('/player')
  }

  return (
    <div className="dash-row">
      <button type="button" className="dash-card" onClick={openQueue}>
        <div className="dash-head">
          <span>Up next</span>
          <Icon name="queue_music" />
        </div>
        {preview.length > 0 && (
          <div className="dash-covers">
            {preview.map((e, i) => (
              <span key={e.libraryItemId} style={{ marginLeft: i > 0 ? -8 : 0 }}>
                <Cover
                  itemId={e.libraryItemId}
                  title={e.title}
                  fs={5}
                  style={{ width: 26, borderRadius: 4, display: 'block' }}
                />
              </span>
            ))}
          </div>
        )}
        <div className="dash-cap">
          {items.length > 0
            ? `${items.length} queued · ${modeLabel}`
            : `Nothing queued · ${modeLabel}`}
        </div>
      </button>

      <button type="button" className="dash-card" onClick={() => navigate('/stats')}>
        <div className="dash-stat">
          <Icon name="local_fire_department" fill style={{ color: 'var(--brand-hearth)' }} />
          <b className="dash-big">{stats ? String(stats.dayStreak) : '–'}</b>
          <span>days</span>
        </div>
        {streakAtRisk ? (
          <div className="dash-cap">streak on the line - listen today to keep it</div>
        ) : (
          <div className="dash-stat" style={{ marginTop: 8 }}>
            <Icon name="schedule" />
            <b>{stats ? formatDuration(stats.weekSec) : '–'}</b>
            <span>this week</span>
          </div>
        )}
      </button>
    </div>
  )
}
