import { useQuery } from '@tanstack/react-query'
import { getAllSessions, adminKeys } from '@/api/admin'
import { formatTimestamp, fmtSessDate } from '@/lib/format'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

// All-users listening sessions (admin view).
export function ConfigSessions() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: adminKeys.sessions(0),
    queryFn: () => getAllSessions(0, 50),
    staleTime: 60 * 1000,
  })

  const sessions = data?.sessions ?? []

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Listening Sessions</h1>
        {data && <p className="page-sub">{data.total} sessions server-wide</p>}
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading sessions..." />}
      {isError && (
        <ErrorState message="Could not load sessions." onRetry={refetch} />
      )}

      {data && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Book</th>
                <th>Listened</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const when = fmtSessDate(s.startedAt)
                return (
                  <tr key={s.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{s.displayTitle}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {s.displayAuthor}
                      </div>
                    </td>
                    <td className="num">{formatTimestamp(s.timeListening)}</td>
                    <td className="num">
                      {when.day} · {when.time}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
