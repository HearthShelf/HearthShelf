import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  countdownLabel,
  daysUntilRelease,
  isUpcoming,
  releaseMs,
  formatDuration,
} from '@hearthshelf/core'
import { fetchAudibleProduct, audibleKeys } from '@/api/audible'
import { getSeries } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useFollowLookup, useFollow, useUnfollow } from '@/hooks/useSubscriptions'
import { useDismissalsStore } from '@/store/dismissalsStore'
import { useSettingsStore } from '@/store/settingsStore'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

/** The ABS series with this name, so we can link to the local series page. */
function useLocalSeriesId(seriesTitle: string | undefined) {
  const { activeId } = useActiveLibrary()
  return useQuery({
    queryKey: ['series-lookup', activeId, seriesTitle],
    queryFn: async () => {
      // NOT limit=0: ABS's series endpoint treats that as "return nothing".
      const res = await getSeries(activeId as string, 0, 1000)
      const want = (seriesTitle ?? '').trim().toLowerCase()
      return res.results.find((s) => s.name.trim().toLowerCase() === want)?.id ?? null
    },
    enabled: Boolean(activeId) && Boolean(seriesTitle),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

// A book the library does not have, rendered like the item detail page so it
// reads as part of the app rather than a dead end. Everything that needs a
// local file is necessarily absent - no play, no chapters, no progress, no
// bookmarks - so the page leads with the release date and a follow toggle.
//
// Data comes from Audible via the backend (ABS knows nothing about a book that
// isn't in the library).
export function UpcomingDetailPage() {
  const { asin = '' } = useParams()
  const navigate = useNavigate()
  const goodreads = useSettingsStore((s) => s.externalLinkGoodreads)
  const audibleOn = useSettingsStore((s) => s.externalLinkAudible)
  const hardcover = useSettingsStore((s) => s.externalLinkHardcover)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: audibleKeys.product(asin),
    queryFn: () => fetchAudibleProduct(asin),
    enabled: Boolean(asin),
    staleTime: 30 * 60 * 1000,
  })

  const { bookSub } = useFollowLookup()
  const follow = useFollow()
  const unfollow = useUnfollow()
  const { data: seriesId } = useLocalSeriesId(data?.series)
  const isRosterIgnored = useDismissalsStore((st) => st.isRosterIgnored)
  const dismiss = useDismissalsStore((st) => st.dismiss)
  const restore = useDismissalsStore((st) => st.restore)

  if (isLoading) return <LoadingSpinner />
  if (isError || !data) {
    return (
      <div className="page">
        <ErrorState message="Could not load this book." onRetry={refetch} />
      </div>
    )
  }

  const now = Date.now()
  const upcoming = data.upcoming ?? isUpcoming(data, now)
  const days = daysUntilRelease(data, now)
  const dated = releaseMs(data) !== null
  const releaseText = dated
    ? new Date(releaseMs(data)!).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null

  const sub = bookSub(data.asin)
  const following = Boolean(sub)
  const busy = follow.isPending || unfollow.isPending
  const toggleFollow = () => {
    if (busy) return
    if (sub) {
      unfollow.mutate(sub.id)
      return
    }
    follow.mutate({
      kind: 'book',
      asin: data.asin,
      seriesAsin: data.seriesAsin,
      title: data.title,
      author: data.author,
      seriesTitle: data.series,
      coverArtUrl: data.coverArtUrl,
      narrator: data.narrator,
      durationMinutes: data.durationMinutes,
      releaseDate: data.releaseDate,
      publicationDatetime: data.publicationDatetime,
    })
  }

  const q = encodeURIComponent(`${data.title ?? ''} ${data.author ?? ''}`.trim())
  const isIgnored = isRosterIgnored(data.asin)

  const links: { key: string; icon: string; label: string; href: string }[] = []
  if (goodreads)
    links.push({
      key: 'goodreads',
      icon: 'menu_book',
      label: 'Goodreads',
      href: `https://www.goodreads.com/search?q=${q}`,
    })
  if (audibleOn)
    links.push({
      key: 'audible',
      icon: 'headphones',
      label: 'Audible',
      href: data.asin
        ? `https://www.audible.com/pd/${data.asin}`
        : `https://www.audible.com/search?keywords=${q}`,
    })
  if (hardcover)
    links.push({
      key: 'hardcover',
      icon: 'auto_stories',
      label: 'Hardcover',
      href: `https://hardcover.app/search?q=${q}`,
    })

  return (
    <div className="page fade-in">
      <div className="crumb">
        <Link className="lnk" to="/upcoming">
          Upcoming
        </Link>
        <Icon name="chevron_right" />
        <span>{data.title}</span>
      </div>

      <div className="detail-top">
        <div className="detail-cover">
          {data.coverArtUrl ? (
            <img className="ud-detail-cover" src={data.coverArtUrl} alt="" />
          ) : (
            <div className="ud-detail-cover up-cover-ph" />
          )}
        </div>

        <div className="detail-main">
          <h1>{data.title}</h1>

          {/* The headline fact for a book you can't listen to yet. */}
          {upcoming && dated && (
            <div className="udp-release">
              <Icon name="event_upcoming" fill />
              <span>
                Coming {releaseText}
                {days !== null && days > 0 ? ` · ${countdownLabel(data, now)}` : ''}
              </span>
            </div>
          )}
          {upcoming && !dated && (
            <div className="udp-release">
              <Icon name="event_upcoming" />
              <span>Release date not announced yet</span>
            </div>
          )}
          {!upcoming && (
            <div className="udp-release out">
              <Icon name="inventory_2" />
              <span>Out now · not in your library</span>
            </div>
          )}

          {data.series && (
            <div className="detail-series-links">
              <span
                className="d-series-chip"
                onClick={() => seriesId && navigate(`/series/${seriesId}`)}
                style={{ cursor: seriesId ? 'pointer' : 'default' }}
              >
                <Icon name="auto_awesome_motion" /> {data.series}
              </span>
            </div>
          )}

          {data.author && <div className="d-sub">By {data.author}</div>}
          {data.narrator && (
            <div className="d-sub" style={{ marginTop: 4 }}>
              Narrated by {data.narrator}
            </div>
          )}
          {data.durationMinutes ? (
            <div className="d-sub" style={{ marginTop: 4 }}>
              {formatDuration(data.durationMinutes * 60)}
            </div>
          ) : null}

          <div className="detail-actions">
            <button
              className={following ? 'btn' : 'btn btn-primary'}
              onClick={toggleFollow}
              disabled={busy}
            >
              <Icon name={following ? 'notifications_active' : 'notifications'} fill={following} />{' '}
              {following ? 'Following' : 'Notify me'}
            </button>
            {seriesId && (
              <button className="pill" onClick={() => navigate(`/series/${seriesId}`)}>
                <Icon name="auto_awesome_motion" /> Series page
              </button>
            )}
            {/* Some series entries are ebook-only side stories or print
                editions that will never be audiobooks. Ignoring one drops it
                from the series count, Upcoming, and the Home countdown. */}
            <button
              className={'pill' + (isIgnored ? ' on' : '')}
              title={
                isIgnored
                  ? 'Stop ignoring - this book will count toward the series again'
                  : "Ignore this book - it won't count toward the series"
              }
              onClick={() =>
                void (isIgnored
                  ? restore('roster', data.asin)
                  : dismiss('roster', data.asin, data.title)
                ).catch(() => {})
              }
            >
              <Icon name={isIgnored ? 'visibility' : 'visibility_off'} />{' '}
              {isIgnored ? 'Ignored' : 'Ignore'}
            </button>
          </div>

          {/* Why the usual actions aren't here. */}
          <p className="udp-note">
            <Icon name="info" />
            {upcoming
              ? "This book isn't out yet, so there's nothing to play. We'll tell you when it lands in your library."
              : "This book isn't in your library, so there's nothing to play."}
          </p>
        </div>
      </div>

      {data.description && (
        <div className="detail-section">
          <h2>Description</h2>
          <p className="udp-desc">{data.description.replace(/<[^>]*>/g, '')}</p>
        </div>
      )}

      {links.length > 0 && (
        <div className="detail-section">
          <h2>Find it elsewhere</h2>
          <div className="detail-ext">
            {links.map((l) => (
              <a key={l.key} href={l.href} target="_blank" rel="noopener noreferrer">
                <Icon name={l.icon} /> {l.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
