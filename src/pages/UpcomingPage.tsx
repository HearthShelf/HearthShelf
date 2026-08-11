import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  countdownLabel,
  releaseMs,
  nextSeriesBook,
  type HSSubscription,
  type HSAudibleSeriesBook,
} from '@hearthshelf/core'
import { useSubscriptions, useUnfollow } from '@/hooks/useSubscriptions'
import { fetchAudibleSeriesByAsin, audibleKeys } from '@/api/audible'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

// Takes the release fields alone, so it serves both a subscription and a roster
// book (the "next in series" line).
function releaseDateLabel(item: {
  publicationDatetime?: string
  releaseDate?: string
}): string | null {
  const ms = releaseMs(item)
  if (ms === null) return null
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// The next book to expect in a followed series, resolved from the series roster
// (a series follow stores only the ASIN, and carries no date of its own).
// Renders nothing while loading, on a server that can't answer, or when the
// series is fully owned with nothing announced.
function NextInSeries({ seriesAsin }: { seriesAsin: string }) {
  const { data } = useQuery({
    queryKey: audibleKeys.seriesByAsin(seriesAsin),
    queryFn: () => fetchAudibleSeriesByAsin(seriesAsin),
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  if (!data?.seriesAsin) return null
  const next: HSAudibleSeriesBook | null = nextSeriesBook(data.books, Date.now())
  if (!next) return null

  // "Next" is the first gap in reading order, which may already be out (a book
  // you haven't picked up) or still unreleased - say which.
  const now = Date.now()
  const upcoming = next.upcoming ?? false
  const countdown = upcoming ? countdownLabel(next, now) : null
  const when = upcoming
    ? `coming ${releaseDateLabel(next) ?? 'soon'}${countdown ? ` · ${countdown}` : ''}`
    : 'out now, not in your library'

  return (
    <div className="sl-release">
      <Icon name="arrow_forward" />
      Next: {next.title} · {when}
    </div>
  )
}

// One followed book or series. The unfollow button never navigates.
function FollowRow({
  sub,
  now,
  onUnfollow,
  busy,
  numberLabel,
}: {
  sub: HSSubscription
  now: number
  onUnfollow: (id: string) => void
  busy: boolean
  numberLabel: React.ReactNode
}) {
  const isSeries = sub.kind === 'series'
  const countdown = isSeries ? null : countdownLabel(sub, now)
  const dateLabel = isSeries ? null : releaseDateLabel(sub)

  // What this row says about itself, in priority order: already landed, then a
  // dated countdown, then a bare "coming soon" when the date is unknown.
  let status: string
  if (isSeries) status = 'Every new book tracked automatically'
  else if (sub.available) status = 'Available now - in your library'
  else if (dateLabel) status = `Coming ${dateLabel}${countdown ? ` · ${countdown}` : ''}`
  else status = 'Coming soon'

  const meta = [sub.author, !isSeries ? sub.seriesTitle : null].filter(Boolean).join(' · ')

  return (
    <div className={`sl-row sl-row-missing sl-row-upcoming${sub.available ? ' is-available' : ''}`}>
      <div className="sl-num">{numberLabel}</div>
      {sub.coverArtUrl ? (
        <img className="sl-cover" src={sub.coverArtUrl} alt="" />
      ) : (
        <div className="sl-cover" style={{ background: 'var(--c-highest)' }} />
      )}
      <div className="sl-meta">
        <div className="sl-title">{sub.title}</div>
        {meta && <div className="sl-sub">{meta}</div>}
        <div className="sl-release">
          <Icon
            name={
              sub.available ? 'check_circle' : isSeries ? 'auto_awesome_motion' : 'event_upcoming'
            }
          />
          {status}
        </div>
        {isSeries && sub.seriesAsin && <NextInSeries seriesAsin={sub.seriesAsin} />}
      </div>
      <button
        className="pill sl-unfollow"
        disabled={busy}
        title={isSeries ? 'Stop following this series' : 'Stop following this book'}
        onClick={() => onUnfollow(sub.id)}
      >
        <Icon name="notifications_off" /> Unfollow
      </button>
    </div>
  )
}

// Everything the listener is following: upcoming books with a countdown, books
// that have already landed, and whole series being tracked - each showing which
// book is next in it.
//
// The Home countdown banner only ever shows the single soonest book inside the
// reader's countdown window, so without this page a follow further out (or a
// series follow, which never has its own date) is invisible after you make it.
export function UpcomingPage() {
  const navigate = useNavigate()
  const { data: subs, isLoading, isError, refetch } = useSubscriptions()
  const unfollow = useUnfollow()

  if (isLoading) return <LoadingSpinner />
  if (isError) {
    return (
      <div className="page">
        <ErrorState message="Could not load what you're following." onRetry={refetch} />
      </div>
    )
  }

  const all = subs ?? []
  const now = Date.now()
  const byRelease = (a: HSSubscription, b: HSSubscription) =>
    (releaseMs(a) ?? Infinity) - (releaseMs(b) ?? Infinity)

  const books = all.filter((s) => s.kind === 'book')
  // Soonest first; a landed book is no longer a countdown, so it moves to its
  // own group rather than sitting at the top with a stale "0 days".
  const waiting = books.filter((s) => !s.available).sort(byRelease)
  const landed = books.filter((s) => s.available).sort(byRelease)
  const series = all.filter((s) => s.kind === 'series')

  const busy = unfollow.isPending
  const onUnfollow = (id: string) => unfollow.mutate(id)

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">HearthShelf</div>
        <h1 className="title-xl">Upcoming</h1>
        <p className="page-sub">
          {all.length > 0
            ? 'Books and series you follow. We tell you the moment one arrives.'
            : 'Follow a book or a series and it shows up here.'}
        </p>
      </div>

      {all.length === 0 ? (
        <div className="empty-state">
          <Icon name="notifications" />
          <h3>Nothing followed yet</h3>
          <p>
            Open a series and use <b>Follow series</b> to track every future book, or{' '}
            <b>Notify me</b> on a book that isn't out yet.
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/library?tab=series')}>
            <Icon name="menu_book" /> Browse series
          </button>
        </div>
      ) : (
        <>
          {waiting.length > 0 && (
            <div className="section">
              <SectionHead icon="event_upcoming" title="Counting down" />
              <div className="series-list">
                {waiting.map((s, i) => (
                  <FollowRow
                    key={s.id}
                    sub={s}
                    now={now}
                    busy={busy}
                    onUnfollow={onUnfollow}
                    numberLabel={i + 1}
                  />
                ))}
              </div>
            </div>
          )}

          {landed.length > 0 && (
            <div className="section">
              <SectionHead icon="check_circle" title="Arrived" />
              <div className="series-list">
                {landed.map((s) => (
                  <FollowRow
                    key={s.id}
                    sub={s}
                    now={now}
                    busy={busy}
                    onUnfollow={onUnfollow}
                    numberLabel={<Icon name="check_circle" fill />}
                  />
                ))}
              </div>
            </div>
          )}

          {series.length > 0 && (
            <div className="section">
              <SectionHead icon="auto_awesome_motion" title="Series you follow" />
              <div className="series-list">
                {series.map((s) => (
                  <FollowRow
                    key={s.id}
                    sub={s}
                    now={now}
                    busy={busy}
                    onUnfollow={onUnfollow}
                    numberLabel={<Icon name="auto_awesome_motion" />}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
