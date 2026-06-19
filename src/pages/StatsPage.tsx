import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getListeningStats, meKeys } from '@/api/me'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function StatsPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: meKeys.stats,
    queryFn: getListeningStats,
    staleTime: 60 * 1000,
  })

  // Top items by listening time, resolved with cover + metadata.
  const mostListened = useMemo(() => {
    if (!data) return []
    return Object.values(data.items)
      .map((it) => ({
        id: it.id,
        title: it.mediaMetadata.title ?? 'Untitled',
        author: it.mediaMetadata.authors?.[0]?.name ?? '',
        narrator: it.mediaMetadata.narrators?.[0] ?? '',
        hours: it.timeListening / 3600,
      }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 8)
  }, [data])
  const mlMax = mostListened[0]?.hours || 1

  // Last 7 calendar days from the days map (date string -> seconds).
  const week = useMemo(() => {
    if (!data) return []
    const out: { d: string; v: number }[] = []
    const now = new Date()
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      out.push({
        d: DAY_LABELS[day.getDay()],
        v: Math.round(((data.days[key] ?? 0) / 3600) * 10) / 10,
      })
    }
    return out
  }, [data])
  const weekMax = Math.max(0.1, ...week.map((d) => d.v))
  const hotIdx = week.reduce((m, d, i) => (d.v > week[m].v ? i : m), 0)

  if (isLoading) {
    return (
      <div className="page">
        <LoadingSpinner className="py-12" label="Loading stats..." />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="page">
        <ErrorState message="Could not load your stats." onRetry={refetch} />
      </div>
    )
  }

  const totalH = Math.floor(data.totalTime / 3600)
  const totalM = Math.floor((data.totalTime % 3600) / 60)
  const bookCount = Object.keys(data.items).length
  const todayMin = Math.round(data.today / 60)
  const activeDays = Object.keys(data.days).length

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">Insights</div>
        <h1 className="title-xl">Your stats</h1>
      </div>

      <div className="hero-stat">
        <div className="label">Total listening time</div>
        <div className="big-num">
          {totalH}
          <u>h</u>
          {totalM}
          <u>m</u>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          across {bookCount} {bookCount === 1 ? 'book' : 'books'}
        </div>
      </div>

      <div className="stat-tiles">
        <div className="tile">
          <div className="t-ico">
            <Icon name="menu_book" />
          </div>
          <div className="t-num">{bookCount}</div>
          <div className="t-cap">Books listened</div>
        </div>
        <div className="tile">
          <div className="t-ico">
            <Icon name="calendar_today" />
          </div>
          <div className="t-num">{activeDays}</div>
          <div className="t-cap">Active days</div>
        </div>
        <div className="tile">
          <div
            className="t-ico"
            style={
              todayMin > 0
                ? {
                    background: 'color-mix(in oklab, var(--accent) 22%, transparent)',
                    color: 'var(--accent)',
                  }
                : {}
            }
          >
            <Icon name="local_fire_department" fill={todayMin > 0} />
          </div>
          <div className="t-num">{todayMin}m</div>
          <div className="t-cap">Today</div>
        </div>
      </div>

      {mostListened.length > 0 && (
        <div className="section">
          <SectionHead icon="trending_up" title="Most listened to" />
          <div className="chart-card" style={{ marginTop: 0 }}>
            <div className="ml-list">
              {mostListened.map((b, i) => (
                <div className="ml-row" key={b.id} data-cv={tintFor(b.title)}>
                  <span className="ml-rank">{i + 1}</span>
                  <Cover itemId={b.id} title={b.title} fs={4} />
                  <div className="ml-meta">
                    <div className="ml-t">{b.title}</div>
                    <div className="ml-s">
                      {[b.author, b.narrator].filter(Boolean).join(' · ')}
                    </div>
                    <div className="ml-bar">
                      <i style={{ width: (b.hours / mlMax) * 100 + '%' }} />
                    </div>
                  </div>
                  <span className="ml-h">
                    {b.hours.toFixed(1)}
                    <small>h</small>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="chart-card">
        <SectionHead icon="bar_chart" title="Last 7 days" />
        <div className="bars">
          {week.map((d, i) => (
            <div className={'bar-col' + (i === hotIdx ? ' hot' : '')} key={i}>
              <span className="v">{d.v}h</span>
              <div className="bar" style={{ height: (d.v / weekMax) * 100 + '%' }} />
              <span className="d">{d.d}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="banner info" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="groups" />
        Community comparisons and the server leaderboard are coming once cross-user
        stats are available.
      </div>
    </div>
  )
}
