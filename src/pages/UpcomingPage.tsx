import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
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
import {
  UpcomingDestinationModal,
  type UpcomingTarget,
} from '@/components/requests/UpcomingDestinationModal'

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
function rosterQuery(seriesAsin: string | undefined, seriesTitle: string) {
  return {
    queryKey: audibleKeys.seriesByAsin(seriesAsin ?? ''),
    queryFn: async (): Promise<HSAudibleSeriesResponse> => {
      const byAsin = await fetchAudibleSeriesByAsin(seriesAsin!)
      if (byAsin.seriesAsin) return byAsin
      if (!seriesTitle) return byAsin
      const byName = await fetchAudibleSeries('', seriesTitle)
      return byName.seriesAsin === seriesAsin ? byName : byAsin
    },
    enabled: Boolean(seriesAsin),
    staleTime: 30 * 60 * 1000,
    retry: false,
  }
}

// The hero: whatever lands next, given the whole stage. Everything else on the
// page is a list; this is the one thing the page exists to answer.
function NextRelease({
  release,
  onView,
  onUnfollow,
  busy,
}: {
  release: Release
  onView: () => void
  onUnfollow: () => void
  busy: boolean
}) {
  const now = Date.now()
  const days = daysUntilRelease(release.dates, now)
  const mon = monthAbbr(release.dates)
  const day = dayNum(release.dates)
  const fromSeries = release.sub.kind === 'series'

  return (
    <article className="up-spotlight" aria-label={`Next book: ${release.title}`}>
      {release.cover ? (
        <img className="up-hero-cover" src={release.cover} alt="" />
      ) : (
        <div className="up-hero-cover up-cover-ph" />
      )}

      <div className="up-hero-copy">
        <div className="up-next-label">
          <span className="up-pulse" />
          Your next release
        </div>
        <h2>{release.title}</h2>
        {release.author && <div className="up-book-meta">{release.author}</div>}
        {release.seriesTitle && (
          <div className="up-series-name">
            {release.seriesTitle}
            {release.sequence ? ` · Book ${release.sequence}` : ''}
          </div>
        )}
        <div className="up-hero-actions">
          <button className="up-primary-btn" onClick={onView}>
            <Icon name="menu_book" /> View book
          </button>
          {/* Says what it actually stops: a hero drawn from a series follow
              unfollows the whole series, not this one book. */}
          <button
            className="up-quiet-btn"
            onClick={onUnfollow}
            disabled={busy}
            title={fromSeries ? 'Stop following this series' : 'Stop following this book'}
          >
            <Icon name="notifications_active" fill />{' '}
            {fromSeries ? 'Following series' : 'Following'}
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
        {/* Announced but unscheduled: there's no day to count to, so say that
            rather than showing a dash where a number belongs. */}
        {days === null ? (
          <div>
            <strong className="tbd">TBD</strong>
            <small>no date yet</small>
          </div>
        ) : (
          <div>
            <strong>{days}</strong>
            <small>{days === 1 ? 'day away' : 'days away'}</small>
          </div>
        )}
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

/** A followed series paired with whatever its roster resolved to. */
interface ResolvedSeries {
  sub: HSSubscription
  next: HSAudibleSeriesBook | null
  cover?: string
}

/** One thing with a release ahead of it, flattened from either source: a book
 *  followed directly, or the next book of a followed series. `sub` is the
 *  subscription it came from, so unfollowing from the hero still works. */
interface Release {
  key: string
  title: string
  author?: string
  cover?: string
  seriesTitle?: string
  sequence?: string
  asin?: string
  dates: Dated
  upcoming: boolean
  sub: HSSubscription
}

function toTarget(r: Release): UpcomingTarget {
  return {
    title: r.title,
    author: r.author,
    cover: r.cover,
    asin: r.asin,
    seriesTitle: r.seriesTitle,
  }
}

// A followed series, as a slim bar whose HEADLINE is the next book - the series
// name is demoted to the label above it. Falls back to a plain "not announced"
// state when the roster resolves with nothing left.
function SeriesRow({
  resolved,
  onUnfollow,
  busy,
  onOpen,
}: {
  resolved: ResolvedSeries
  onUnfollow: (id: string) => void
  busy: boolean
  onOpen: (next: HSAudibleSeriesBook | null) => void
}) {
  const { sub, next, cover } = resolved
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
  // A book that isn't in the library has no page of its own here, so opening
  // one asks where to go rather than dead-ending.
  const [dest, setDest] = useState<UpcomingTarget | null>(null)

  const all = subs ?? []
  const series = all.filter((s) => s.kind === 'series')
  const books = all.filter((s) => s.kind === 'book')

  // Resolve every followed series' roster in ONE hook, so the count of hooks
  // never depends on the list length (a .map() of useQuery would break the
  // rules of hooks the moment a follow is added or removed).
  const rosters = useQueries({
    queries: series.map((s) => rosterQuery(s.seriesAsin, s.seriesTitle ?? s.title)),
  })
  const resolved: ResolvedSeries[] = series.map((sub, i) => {
    const roster = rosters[i]?.data
    return {
      sub,
      next: roster?.seriesAsin ? nextSeriesBook(roster.books, Date.now()) : null,
      cover: sub.coverArtUrl ?? roster?.books.find((b) => b.coverArtUrl)?.coverArtUrl,
    }
  })

  // One list of everything with a real release ahead of it, from BOTH sources:
  // a book you followed directly, and the next book of a series you follow.
  // Without the series half, following only series (the common case) left the
  // page with no hero and an empty "After that".
  const releases: Release[] = [
    ...books
      .filter((s) => !s.available)
      .map((s) => ({
        key: s.id,
        title: s.title,
        author: s.author,
        cover: s.coverArtUrl,
        seriesTitle: s.seriesTitle,
        sequence: s.sequence ?? undefined,
        asin: s.asin,
        dates: s as Dated,
        upcoming: releaseMs(s) !== null,
        sub: s,
      })),
    ...resolved
      .filter((r) => r.next && (r.next.upcoming ?? false))
      .map((r) => ({
        key: `${r.sub.id}:${r.next!.asin}`,
        title: r.next!.title,
        author: r.next!.author || r.sub.author,
        cover: r.next!.coverArtUrl ?? r.cover,
        seriesTitle: r.sub.seriesTitle ?? r.sub.title,
        sequence: r.next!.sequence ?? undefined,
        asin: r.next!.asin,
        dates: r.next as Dated,
        upcoming: true,
        sub: r.sub,
      })),
  ].sort((a, b) => (releaseMs(a.dates) ?? Infinity) - (releaseMs(b.dates) ?? Infinity))

  const landed = books
    .filter((s) => s.available)
    .sort((a, b) => (releaseMs(a) ?? Infinity) - (releaseMs(b) ?? Infinity))

  // The hero is the soonest release that actually has a date - an undated
  // follow can't fill a countdown, so it belongs in the list instead.
  const hero = releases.find((r) => releaseMs(r.dates) !== null)
  const rest = releases.filter((r) => r !== hero)

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
  const datedRest = rest.filter((r) => releaseMs(r.dates) !== null).length

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
              release={hero}
              busy={busy}
              onView={() => setDest(toTarget(hero))}
              onUnfollow={() => onUnfollow(hero.sub.id)}
            />
          )}

          {rest.length > 0 && (
            <>
              <div className="up-section-row">
                <h3>After that</h3>
                <span>
                  {datedRest} dated release{datedRest === 1 ? '' : 's'}
                </span>
              </div>
              <div className="up-card-list">
                {rest.map((r) => {
                  const mon = monthAbbr(r.dates)
                  const day = dayNum(r.dates)
                  return (
                    <UpCard
                      key={r.key}
                      title={r.title}
                      author={r.author}
                      cover={r.cover}
                      when={
                        mon && day ? { top: mon, bottom: day } : { top: 'DATE', bottom: 'TBD' }
                      }
                      onClick={() => setDest(toTarget(r))}
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
                    onClick={() =>
                      setDest({
                        title: s.title,
                        author: s.author,
                        cover: s.coverArtUrl,
                        asin: s.asin,
                        seriesTitle: s.seriesTitle,
                      })
                    }
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
                {resolved.map((r) => (
                  <SeriesRow
                    key={r.sub.id}
                    resolved={r}
                    busy={busy}
                    onUnfollow={onUnfollow}
                    onOpen={(next) =>
                      setDest({
                        title: next?.title ?? r.sub.seriesTitle ?? r.sub.title,
                        author: next?.author ?? r.sub.author,
                        cover: next?.coverArtUrl ?? r.cover,
                        asin: next?.asin,
                        seriesTitle: r.sub.seriesTitle ?? r.sub.title,
                      })
                    }
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {dest && <UpcomingDestinationModal item={dest} onClose={() => setDest(null)} />}
    </div>
  )
}
