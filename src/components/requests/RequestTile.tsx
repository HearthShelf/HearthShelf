import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/common/Icon'
import { RmabBadge } from '@/components/requests/RmabBadge'
import type { RmabSearchResult } from '@/api/requests'

// The per-result action: in-library link, live status, or a Request button.
// `requestStatus`/`isAvailable` come pre-enriched from RMAB's search response.
function RequestAction({
  result,
  onRequest,
}: {
  result: RmabSearchResult
  onRequest: (r: RmabSearchResult) => void
}) {
  const navigate = useNavigate()
  const status = result.requestStatus

  if (status === 'available' || status === 'downloaded') {
    return (
      <button
        className="req-btn ghost"
        onClick={() => result.asin && navigate('/library?q=' + encodeURIComponent(result.title))}
      >
        <Icon name="library_books" /> In library
      </button>
    )
  }
  if (result.isRequested && status) {
    return <RmabBadge status={status} releaseDate={result.releaseDate} showRelease />
  }
  return (
    <button className="req-btn" onClick={() => onRequest(result)}>
      <Icon name="add" /> Request
    </button>
  )
}

interface RequestTileProps {
  result: RmabSearchResult
  onRequest: (r: RmabSearchResult) => void
}

// BookTile-shaped card for a requestable catalog result.
export function RequestTile({ result, onRequest }: RequestTileProps) {
  const hours = result.durationMinutes ? Math.round(result.durationMinutes / 60) : null
  return (
    <div className="req-tile">
      {result.coverArtUrl ? (
        <img className="cover" src={result.coverArtUrl} alt="" />
      ) : (
        <div className="cover" style={{ background: 'var(--c-highest)' }} />
      )}
      <div className="rt-body">
        <div className="rt-title">{result.title}</div>
        <div className="rt-author">
          {result.author}
          {result.narrator ? ' · ' + result.narrator : ''}
        </div>
        <div className="rt-chips">
          {hours != null && (
            <span className="rt-chip">
              <Icon name="schedule" /> {hours}h
            </span>
          )}
          {result.rating != null && (
            <span className="rt-chip">
              <Icon name="star" fill /> {result.rating}
            </span>
          )}
        </div>
        <div className="rt-action">
          <RequestAction result={result} onRequest={onRequest} />
        </div>
      </div>
    </div>
  )
}
