import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  countdownLabel,
  daysUntilRelease,
  releaseMs,
  nextSeriesBook,
  type HSSubscription,
  type HSAudibleSeriesBook,
  type HSAudibleSeriesResponse,
} from '@hearthshelf/core'
import { useSubscriptions, useUnfollow } from '@/hooks/useSubscriptions'
import { fetchAudibleSeriesByAsin, fetchAudibleSeries, audibleKeys } from '@/api/audible'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

type Dated = { publicationDatetime?: string; releaseDate?: string }

function monthAbbr(item: Dated): string | null {
  const ms = releaseMs(item)
  if (ms === null) return null
  return new Date(ms).toLocaleDateString(undefined, { month: 'short' }).toUpperCase()
}

function dayNum(item: Dated): string | null {
  const ms = releaseMs(item)
  if (ms === null) return null
  return String(new Date(ms).getDate())
}

// The roster for a followed series, used for its artwork and for which book is
// next in it. A series follow stores only the ASIN and carries no date.
//
// Two lookups, because ?seriesAsin= is new: a server that predates it ignores
// the parameter and answers empty, which would silently leave every series row
// blank. So when the ASIN lookup comes back unresolved we fall back to the
// by-name lookup that every server has always supported, and keep only a roster
// whose ASIN actually matches this follow (a name can match two series).
function useSeriesRoster(seriesAsin: string | undefined, seriesTitle: string) {
  return useQuery<HSAudibleSeriesResponse>({
    queryKey: audibleKeys.seriesByAsin(seriesAsin ?? ''),
    queryFn: async () => {
      const byAsin = await fetchAudibleSeriesByAsin(seriesAsin!)
      if (byAsin.seriesAsin) return byAsin
      if (!seriesTitle) return byAsin
      const byName = await fetchAudibleSeries('', seriesTitle)
      return byName.seriesAsin === seriesAsin ? byName : byAsin
    },
    enabled: Boolean(seriesAsin),
    staleTime: 30 * 60 * 1000,
    retry: false,
  })
}

// The hero: whatever lands next, given the whole stage. Everything else on the
// page is a list; this is the one thing the page exists to answer.
function NextRelease({
  sub,
  cover,
  onView,
  onUnfollow,
  busy,
}: {
  sub: HSSubscription
  cover?: string
  onView: () => void
  onUnfollow: () => void
  busy: boolean
}) {
  const now = Date.now()
  const days = daysUntilRelease(sub, now)
  const mon = monthAbbr(sub)
  const day = dayNum(sub)

  return (
    <article className="up-spotlight" aria-label={`Next book: ${sub.title}`}>
      {cover ? (
        <img className="up-hero-cover" src={cover} alt="" />
      ) : (
        <div className="up-hero-cover up-cover-ph" />
      )}

      <div className="up-hero-copy">
        <div className="up-next-label">
          <span className="up-pulse" />
          Your next release
        </div>
        <h2>{sub.title}</h2>
        {sub.author && <div className="up-book-meta">{sub.author}</div>}
        {sub.seriesTitle && (
          <div className="up-series-name">
            {sub.seriesTitle}
            {sub.sequence ? ` · Book ${sub.sequence}` : ''}
          </div>
        )}
        <div className="up-hero-actions">
          <button className="up-primary-btn" onClick={onView}>
            <Icon name="menu_book" /> View book
          </button>
          <button className="up-quiet-btn" onClick={onUnfollow} disabled={busy}>
            <Icon name="notifications_active" fill /> Following
          </button>
        </div>
      </div>

      <div className="up-release-clock">
        {mon && day && (
          <div className="up-calendar">
            <b>{mon}</b>
            <span>{day}</span>
          </div>
        )}
        <div>
          <strong>{days ?? '—'}</strong>
          <small>{days === 1 ? 'day away' : 'days away'}</small>
        </div>
        <p>
          We'll let you know
          <br />
          the moment it arrives.
        </p>
      </div>
    </article>
  )
}

// A dated release that isn't the hero, and arrived books. Compact card: mini
// cover, title + author, and the date on its own rail.
function UpCard({
  title,
  author,
  cover,
  when,
  arrived,
  onClick,
}: {
  title: string
  author?: string
  cover?: string
  when: { top: string; bottom: string }
  arrived?: boolean
  onClick?: () => void
}) {
  return (
    <article className={'up-card' + (arrived ? ' arrived' : '')} onClick={onClick}>
      {cover ? (
        <img className="up-mini-cover" src={cover} alt="" />
      ) : (
        <div className="up-mini-cover up-cover-ph" />
      )}
      <div className="up-card-meta">
        <h4>{title}</h4>
        <p>{author || ' '}</p>
      </div>
      <time>
        {when.top}
        <br />
        {when.bottom}
      </time>
    </article>
  )
}

// A followed series, as a slim bar whose HEADLINE is the next book - the series
// name is demoted to the label above it. Falls back to a plain "not announced"
// state when the roster resolves with nothing left.
function SeriesRow({
  sub,
  onUnfollow,
  busy,
  onOpen,
}: {
  sub: HSSubscription
  onUnfollow: (id: string) => void
  busy: boolean
  onOpen: (next: HSAudibleSeriesBook | null) => void
}) {
  const { data: roster } = useSeriesRoster(sub.seriesAsin, sub.seriesTitle ?? sub.title)
  const next = roster?.seriesAsin ? nextSeriesBook(roster.books, Date.now()) : null
  const cover = sub.coverArtUrl ?? roster?.books.find((b) => b.coverArtUrl)?.coverArtUrl
  const upcoming = next ? (next.upcoming ?? false) : false
  const label = next?.sequence
    ? `${sub.seriesTitle ?? sub.title} · Book ${next.sequence}`
    : (sub.seriesTitle ?? sub.title)

  return (
    <div className="up-series-row" onClick={() => onOpen(next)}>
      {cover ? (
        <img className="up-series-cover" src={cover} alt="" />
      ) : (
        <div className="up-series-cover up-cover-ph" />
      )}
      <div className="up-series-meta">
        <div className="up-series-label">{label}</div>
        {next ? (
          <div className="up-series-next">{next.title}</div>
        ) : (
          <div className="up-series-next quiet">Next book not announced yet</div>
        )}
      </div>
      {next && (
        <span className={'up-date-pill' + (upcoming ? '' : ' out')}>
          {upcoming ? (
            <>
              <Icon name="bolt" fill /> {countdownLabel(next, Date.now()) ?? 'Coming soon'}
            </>
          ) : (
            <>
              <Icon name="inventory_2" /> Out now
            </>
          )}
        </span>
      )}
      <button
        className="up-row-btn"
        title="Stop following this series"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          onUnfollow(sub.id)
        }}
      >
        <Icon name="notifications_off" />
      </button>
      <Icon name="chevron_right" />
    </div>
  )
}

// Everything the listener is following. The single soonest dated book is the
// hero; the rest of the dated ones, the books that already landed, and the
// series being tracked follow as lists.
//
// The Home countdown banner only ever shows one book inside a 14-day window, so
// without this page a follow further out - or a series follow, which has no date
// of its own - is invisible after you make it.
export function UpcomingPage() {
  const navigate = useNavigate()
  const { data: subs, isLoading, isError, refetch } = useSubscriptions()
  const unfollow = useUnfollow()

  const all = subs ?? []
  const byRelease = (a: HSSubscription, b: HSSubscription) =>
    (releaseMs(a) ?? Infinity) - (releaseMs(b) ?? Infinity)

  const books = all.filter((s) => s.kind === 'book')
  const waiting = books.filter((s) => !s.available).sort(byRelease)
  const landed = books.filter((s) => s.available).sort(byRelease)
  const series = all.filter((s) => s.kind === 'series')

  // The hero is the soonest waiting book that actually has a date - an undated
  // follow can't fill a countdown, so it belongs in the list instead.
  const hero = waiting.find((s) => releaseMs(s) !== null)
  const rest = waiting.filter((s) => s !== hero)

  // The hero's cover, when the follow was saved without one.
  const heroRoster = useSeriesRoster(
    hero && !hero.coverArtUrl ? hero.seriesAsin : undefined,
    hero?.seriesTitle ?? hero?.title ?? '',
  ).data
  const heroCover =
    hero?.coverArtUrl ?? heroRoster?.books.find((b) => b.coverArtUrl)?.coverArtUrl

  if (isLoading) return <LoadingSpinner />
  if (isError) {
    return (
      <div className="page">
        <ErrorState message="Could not load what you're following." onRetry={refetch} />
      </div>
    )
  }

  const busy = unfollow.isPending
  const onUnfollow = (id: string) => unfollow.mutate(id)
  const datedCount = waiting.filter((s) => releaseMs(s) !== null).length

  return (
    <div className="page fade-in up-page">
      <header className="up-page-heading">
        <div>
          <div className="eyebrow">HearthShelf</div>
          <h1 className="up-h1">Upcoming</h1>
          <p>The books you're waiting for, in the order they arrive.</p>
        </div>
        {all.length > 0 && (
          <div className="up-following-count">
            <b>{all.length}</b> book{all.length === 1 ? '' : 's'} &amp; series followed
          </div>
        )}
      </header>

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
          {hero && (
            <NextRelease
              sub={hero}
              cover={heroCover}
              busy={busy}
              onView={() => hero.asin && navigate(`/upcoming/${encodeURIComponent(hero.asin)}`)}
              onUnfollow={() => onUnfollow(hero.id)}
            />
          )}

          {rest.length > 0 && (
            <>
              <div className="up-section-row">
                <h3>After that</h3>
                <span>
                  {datedCount - (hero ? 1 : 0)} dated release
                  {datedCount - (hero ? 1 : 0) === 1 ? '' : 's'}
                </span>
              </div>
              <div className="up-card-list">
                {rest.map((s) => {
                  const mon = monthAbbr(s)
                  const day = dayNum(s)
                  return (
                    <UpCard
                      key={s.id}
                      title={s.title}
                      author={s.author}
                      cover={s.coverArtUrl}
                      when={
                        mon && day
                          ? { top: mon, bottom: day }
                          : { top: 'DATE', bottom: 'TBA' }
                      }
                      onClick={() => s.asin && navigate(`/upcoming/${encodeURIComponent(s.asin)}`)}
                    />
                  )
                })}
              </div>
            </>
          )}

          {landed.length > 0 && (
            <>
              <div className="up-section-row">
                <h3>Arrived</h3>
                <span>In your library now</span>
              </div>
              <div className="up-card-list">
                {landed.map((s) => (
                  <UpCard
                    key={s.id}
                    title={s.title}
                    author={s.author}
                    cover={s.coverArtUrl}
                    arrived
                    when={{ top: 'OUT', bottom: 'NOW' }}
                    onClick={() => s.asin && navigate(`/upcoming/${encodeURIComponent(s.asin)}`)}
                  />
                ))}
              </div>
            </>
          )}

          {series.length > 0 && (
            <>
              <div className="up-section-row">
                <h3>Series you follow</h3>
                <span>New books are tracked automatically</span>
              </div>
              <div className="up-series-list">
                {series.map((s) => (
                  <SeriesRow
                    key={s.id}
                    sub={s}
                    busy={busy}
                    onUnfollow={onUnfollow}
                    onOpen={(next) => {
                      if (next?.asin) navigate(`/upcoming/${encodeURIComponent(next.asin)}`)
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
