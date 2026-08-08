import { useInfiniteQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  getCompletions,
  completionKeys,
  COMPLETIONS_PAGE_SIZE,
  type CompletionsPage,
} from '@/api/completions'
import { useRatings, useSetRating } from '@/hooks/useRatings'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { StarRating } from '@/components/common/StarRating'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'
import { formatDuration } from '@/lib/format'

function finishedOn(ms: number | null): string {
  if (!ms) return 'Finished'
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// Every book the listener has finished, newest first, with how many times and a
// place to rate it. Backed by HearthShelf's own completion log rather than ABS
// progress, which cannot answer "how many times" (see api/completions.ts).
export function FinishedBooksPage() {
  const navigate = useNavigate()
  const { data: ratings } = useRatings()
  const setRating = useSetRating()

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery<CompletionsPage>({
      queryKey: completionKeys.list,
      queryFn: ({ pageParam }) => getCompletions(COMPLETIONS_PAGE_SIZE, pageParam as number),
      initialPageParam: 0,
      // Page by how many rows we already hold, stopping once they account for
      // the server's reported total.
      getNextPageParam: (_last, pages) => {
        const loaded = pages.reduce((n, p) => n + p.rows.length, 0)
        const total = pages[0]?.total ?? 0
        return loaded < total ? loaded : undefined
      },
      staleTime: 5 * 60 * 1000,
    })

  if (isLoading) return <LoadingSpinner />
  if (isError || !data) {
    return (
      <div className="page">
        <ErrorState message="Could not load your finished books." onRetry={refetch} />
      </div>
    )
  }

  const available = data.pages[0]?.available ?? false
  const rows = data.pages.flatMap((p) => p.rows)
  const total = data.pages[0]?.total ?? 0

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">HearthShelf</div>
        <h1 className="title-xl">Finished</h1>
        <p className="page-sub">
          {available && total > 0
            ? `${total} book${total === 1 ? '' : 's'} you have finished, newest first.`
            : 'Every book you have finished, and when.'}
        </p>
      </div>

      {/* An unavailable log is not an empty one: on a slim install the backend
          has no AudiobookShelf database to read, so say that rather than
          implying the listener has finished nothing. */}
      {!available ? (
        <div className="empty-state">
          <Icon name="database_off" />
          <h3>This server can't provide it</h3>
          <p>
            Your finished-books history needs read access to the AudiobookShelf database. Ask
            your admin to map it, and this page will fill in.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <Icon name="check_circle" />
          <h3>Nothing finished yet</h3>
          <p>Books show up here once you finish them.</p>
        </div>
      ) : (
        <>
          <div className="series-list-head">
            <SectionHead icon="history" title="Most recent first" />
          </div>
          <div className="series-list">
            {rows.map((r) => (
              <div
                key={r.libraryItemId}
                className="sl-row"
                data-cv={tintFor(r.title)}
                onClick={() => navigate(`/book/${r.libraryItemId}`)}
              >
                <div className="sl-num">
                  <Icon name="check_circle" fill />
                </div>
                <Cover itemId={r.libraryItemId} title={r.title} fs={6} className="sl-cover" />
                <div className="sl-meta">
                  <div className="sl-title">
                    {r.title}
                    {r.completions > 1 && (
                      <span className="badges">
                        <span className="badge-pill">Read {r.completions}x</span>
                      </span>
                    )}
                  </div>
                  <div className="sl-sub">
                    {[r.author, finishedOn(r.lastFinishedAt), formatDuration(r.durationSec)]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <div className="sl-rating">
                  <StarRating
                    value={ratings?.[r.libraryItemId] ?? null}
                    onChange={(n) => setRating.mutate({ itemKey: r.libraryItemId, rating: n })}
                    size={15}
                  />
                </div>
                <button
                  className="icon-btn sl-play"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/book/${r.libraryItemId}`)
                  }}
                  aria-label="Open"
                >
                  <Icon name="chevron_right" />
                </button>
              </div>
            ))}
          </div>
          {hasNextPage && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
              <button className="pill" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
                {isFetchingNextPage ? 'Loading...' : 'Show more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
