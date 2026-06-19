import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'
import { RmabBadge, RmabProgress } from '@/components/requests/RmabBadge'
import {
  listRequests,
  requestKeys,
  statusMeta,
  RMAB_GROUPS,
  type RmabRequest,
  type RmabGroup,
} from '@/api/requests'

const GROUP_COLOR: Record<RmabGroup, string> = {
  active: '#9b6fb8',
  waiting: '#d9a45a',
  completed: '#5a9c52',
  failed: '#d8443a',
  cancelled: '#8a847a',
}

type Tab = 'all' | RmabGroup

function RequestRow({ req, onView }: { req: RmabRequest; onView: (absItemId: string) => void }) {
  const meta = statusMeta(req.status)
  const b = req.audiobook
  const cover = b.coverArtUrl
  return (
    <div className="req-row">
      {cover ? (
        <img className="cover" src={cover} alt="" />
      ) : (
        <div className="cover" style={{ background: 'var(--c-highest)' }} />
      )}
      <div className="rr-mid">
        <div className="rr-title">{b.title}</div>
        <div className="rr-sub">
          {b.author}
          {b.narrator ? ' · ' + b.narrator : ''}
        </div>
        <div className="rr-status">
          <RmabBadge status={req.status} progress={req.progress} />
          {req.status === 'downloading' && <RmabProgress progress={req.progress} color={meta.color} />}
        </div>
        {req.errorMessage && (
          <div className="rr-err">
            <Icon name="error" fill /> {req.errorMessage}
          </div>
        )}
      </div>
      <div className="rr-right">
        {req.status === 'available' && b.absItemId && (
          <button className="req-btn ghost" onClick={() => onView(b.absItemId as string)}>
            <Icon name="library_books" /> View
          </button>
        )}
      </div>
    </div>
  )
}

export function RequestsPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('all')

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: requestKeys.list(tab),
    queryFn: () => listRequests(tab),
    // Poll while anything is in flight so progress + status transitions show live.
    refetchInterval: (query) => {
      const counts = query.state.data?.counts
      const inflight = (counts?.active ?? 0) + (counts?.waiting ?? 0)
      return inflight > 0 ? 5000 : false
    },
  })

  const requests = useMemo(() => data?.requests ?? [], [data])
  const counts = data?.counts
  const inflight = (counts?.active ?? 0) + (counts?.waiting ?? 0)

  if (isLoading) return <LoadingSpinner />
  if (isError) return <ErrorState onRetry={() => void refetch()} />

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'all', label: 'All', icon: 'inbox' },
    ...RMAB_GROUPS,
  ]
  const countFor = (id: Tab): number =>
    id === 'all' ? counts?.all ?? 0 : counts?.[id] ?? 0

  return (
    <div className="page fade-in">
      <div className="req-head-row">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">ReadMeABook</div>
          <h1 className="title-xl">Requests</h1>
          <p className="page-sub">Audiobooks you've asked ReadMeABook to find.</p>
        </div>
        <span className="req-live">
          <span
            className={inflight ? 'dot pulse' : 'dot'}
            style={{ background: inflight ? '#5a9c52' : 'var(--text-faint)' }}
          />
          {inflight ? 'Live · updates every 5s' : 'Up to date'}
        </span>
      </div>

      <div className="req-summary">
        {RMAB_GROUPS.map((g) => (
          <div className="req-sum" key={g.id}>
            <span className="ind" style={{ background: GROUP_COLOR[g.id] }} />
            <span className="num">{counts?.[g.id] ?? 0}</span>
            <span className="cap">{g.label}</span>
          </div>
        ))}
      </div>

      <div className="req-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={'req-tab' + (tab === t.id ? ' on' : '')}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} /> {t.label} <span className="n">{countFor(t.id)}</span>
          </button>
        ))}
      </div>

      {requests.length === 0 ? (
        <div className="empty-state">
          <Icon name="inbox" />
          <h3>Nothing here</h3>
          <p>No requests in this group.</p>
        </div>
      ) : (
        <div className="req-list">
          {requests.map((r) => (
            <RequestRow key={r.id} req={r} onView={(id) => navigate('/book/' + id)} />
          ))}
        </div>
      )}
    </div>
  )
}
