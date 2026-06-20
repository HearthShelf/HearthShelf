import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { RmabBadge, RmabProgress } from '@/components/requests/RmabBadge'
import { listRequests, requestKeys, statusMeta } from '@/api/requests'
import { useRmabEnabled } from '@/hooks/useRmab'

// "Your requests in progress" - shown on Home only when RMAB is connected and
// the user has active/waiting requests. Polls every 5s while anything is live.
export function HomeRequestsShelf() {
  const navigate = useNavigate()
  const enabled = useRmabEnabled()

  const { data } = useQuery({
    queryKey: requestKeys.list('inflight'),
    queryFn: () => listRequests(),
    enabled,
    refetchInterval: (query) => {
      const counts = query.state.data?.counts
      const inflight = (counts?.active ?? 0) + (counts?.waiting ?? 0)
      return inflight > 0 ? 5000 : false
    },
  })

  if (!enabled) return null

  const inflight = (data?.requests ?? [])
    .filter((r) => {
      const g = statusMeta(r.status).group
      return g === 'active' || g === 'waiting'
    })
    .slice(0, 6)

  if (inflight.length === 0) return null

  return (
    <div className="section">
      <div className="section-head">
        <Icon name="cloud_download" />
        <h2>Your requests in progress</h2>
        <button className="more" onClick={() => navigate('/requests')}>
          See all
        </button>
      </div>
      <div className="home-req-shelf">
        {inflight.map((r) => {
          const meta = statusMeta(r.status)
          const b = r.audiobook
          return (
            <div className="home-req-card" key={r.id}>
              {b.coverArtUrl ? (
                <img className="cover" src={b.coverArtUrl} alt="" />
              ) : (
                <div className="cover" style={{ background: 'var(--c-highest)' }} />
              )}
              <div className="hrc-meta">
                <div className="hrc-title">{b.title}</div>
                <div className="hrc-author">{b.author}</div>
                <div className="hrc-status">
                  {r.status === 'downloading' ? (
                    <RmabProgress progress={r.progress} color={meta.color} />
                  ) : (
                    <RmabBadge status={r.status} progress={r.progress} />
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
