import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getListeningSessions, meKeys } from '@/api/me'
import { usePlayer } from '@/hooks/usePlayer'
import { formatTimestamp, fmtSessDate, groupByDay } from '@/lib/format'
import type { ABSListeningSession } from '@/api/types'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

function deviceIcon(s: ABSListeningSession): string {
  const os = (s.deviceInfo?.osName ?? '').toLowerCase()
  if (os.includes('android') || os.includes('ios')) return 'smartphone'
  if (s.deviceInfo?.browserName) return 'language'
  return 'computer'
}

export function SessionsPage() {
  const navigate = useNavigate()
  const { playItem } = usePlayer()

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: meKeys.sessions(0),
    queryFn: () => getListeningSessions(0, 100),
    staleTime: 60 * 1000,
  })

  const sessions = data?.sessions ?? []

  // Summary tiles (client-derived from the loaded sessions).
  const totalListened = sessions.reduce((s, x) => s + (x.timeListening ?? 0), 0)
  const uniqueBooks = new Set(sessions.map((s) => s.libraryItemId)).size
  const longest = sessions.reduce((m, s) => Math.max(m, s.timeListening ?? 0), 0)

  // Group sessions by day (array is already newest-first). Shared with the
  // hosted app and mobile so all three group history identically.
  const groups = groupByDay(sessions, (s) => s.startedAt)

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">Insights</div>
        <h1 className="title-xl">Listening history</h1>
        <p className="page-sub">
          Every session, newest first. Jump straight back to where any one started.
        </p>
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading history..." />}
      {isError && <ErrorState message="Could not load your history." onRetry={refetch} />}

      {data && sessions.length === 0 && (
        <div className="empty-state">
          <Icon name="history" />
          <h3>No listening yet</h3>
          <p>Your sessions will appear here as you listen.</p>
        </div>
      )}

      {sessions.length > 0 && (
        <>
          <div className="stat-tiles">
            <div className="tile">
              <div className="t-ico">
                <Icon name="history" />
              </div>
              <div className="t-num">{sessions.length}</div>
              <div className="t-cap">Sessions</div>
            </div>
            <div className="tile">
              <div className="t-ico">
                <Icon name="schedule" />
              </div>
              <div className="t-num">{Math.round(totalListened / 3600)}h</div>
              <div className="t-cap">Listened</div>
            </div>
            <div className="tile">
              <div className="t-ico">
                <Icon name="menu_book" />
              </div>
              <div className="t-num">{uniqueBooks}</div>
              <div className="t-cap">Books</div>
            </div>
            <div className="tile">
              <div className="t-ico">
                <Icon name="timer" />
              </div>
              <div className="t-num" style={{ fontFamily: 'var(--font-mono)' }}>
                {formatTimestamp(longest)}
              </div>
              <div className="t-cap">Longest session</div>
            </div>
          </div>

          {groups.map((g) => (
            <div className="section" key={g.title}>
              <div className="sh-day">{g.title}</div>
              <div className="sh-list">
                {g.data.map((s) => {
                  const when = fmtSessDate(s.startedAt)
                  return (
                    <div
                      className="sh-row"
                      key={s.id}
                      data-cv={tintFor(s.displayTitle)}
                      onClick={() => navigate(`/book/${s.libraryItemId}`)}
                      title="Open book"
                    >
                      <Cover itemId={s.libraryItemId} title={s.displayTitle} fs={3} />
                      <div className="sh-meta">
                        <div className="ll-title">{s.displayTitle}</div>
                        <div className="ll-sub">{s.displayAuthor}</div>
                      </div>
                      <span className="sh-span">
                        {formatTimestamp(s.startTime)}
                        <Icon name="arrow_right_alt" style={{ fontSize: 16, opacity: 0.5 }} />
                        {formatTimestamp(s.currentTime)}
                      </span>
                      <span className="sh-dur">{formatTimestamp(s.timeListening)}</span>
                      <span className="sh-when">
                        <Icon name={deviceIcon(s)} style={{ fontSize: 15 }} />
                        {when.time}
                      </span>
                      <button
                        className="sh-play"
                        title="Play from where this session started"
                        onClick={(e) => {
                          e.stopPropagation()
                          void playItem(s.libraryItemId, s.startTime)
                        }}
                      >
                        <Icon name="play_arrow" fill />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
