/**
 * Home countdown banner: "X days until <book>" for whatever the reader is
 * waiting on whose release falls within their countdown window
 * (notifyPrefs.countdownWindowDays, default 14). Renders nothing when nothing
 * qualifies, so it's safe to always mount.
 *
 * Fed from BOTH follow kinds: a book followed directly, and the next book of a
 * followed series. A series subscription carries no date of its own, so before
 * this the banner was empty for anyone who only follows series.
 *
 * Core does the flattening/windowing (pendingReleases + bannerReleases) and the
 * label (countdownLabel), so web, mobile and the release-notify job agree on
 * what "coming soon" means.
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  pendingReleases,
  bannerReleases,
  countdownLabel,
  nextSeriesBook,
  type HSAudibleSeriesBook,
  type HSAudibleSeriesResponse,
} from '@hearthshelf/core'
import { getSubscriptions, subscriptionKeys } from '@/api/subscriptions'
import { fetchAudibleSeriesByAsin, fetchAudibleSeries, audibleKeys } from '@/api/audible'
import { useDismissalsStore } from '@/store/dismissalsStore'
import { useSettingsStore } from '@/store/settingsStore'
import { Icon } from '@/components/common/Icon'

export function ReleaseCountdownBanner() {
  const navigate = useNavigate()
  const windowDays = useSettingsStore((s) => s.notifyPrefs.countdownWindowDays)

  const ignoredAsins = useDismissalsStore((st) => st.rosterAsins)

  const { data: subscriptions } = useQuery({
    queryKey: subscriptionKeys.list,
    queryFn: getSubscriptions,
    staleTime: 10 * 60 * 1000,
  })

  // Resolve each followed series' roster so its next book can reach the banner.
  // One useQueries call, so the hook count never depends on the list length.
  const series = (subscriptions ?? []).filter((s) => s.kind === 'series')
  const rosters = useQueries({
    queries: series.map((s) => ({
      queryKey: audibleKeys.seriesByAsin(s.seriesAsin ?? ''),
      queryFn: async (): Promise<HSAudibleSeriesResponse> => {
        const byAsin = await fetchAudibleSeriesByAsin(s.seriesAsin as string)
        if (byAsin.seriesAsin) return byAsin
        const name = s.seriesTitle ?? s.title
        if (!name) return byAsin
        const byName = await fetchAudibleSeries('', name)
        return byName.seriesAsin === s.seriesAsin ? byName : byAsin
      },
      enabled: Boolean(s.seriesAsin),
      staleTime: 30 * 60 * 1000,
      retry: false,
    })),
  })

  // Date.now() at render is fine - the banner is not a hot path, and core does
  // the pure filtering.
  const now = Date.now()
  const nextBySeries = new Map<string, HSAudibleSeriesBook | null>()
  series.forEach((s, i) => {
    const roster = rosters[i]?.data
    if (s.seriesAsin) {
      nextBySeries.set(
        s.seriesAsin,
        roster?.seriesAsin ? nextSeriesBook(roster.books, now, ignoredAsins) : null,
      )
    }
  })

  // Fed from BOTH follow kinds: a series subscription carries no date of its
  // own, so before this the banner was empty for anyone who only follows series.
  const upcoming = bannerReleases(
    pendingReleases(subscriptions ?? [], nextBySeries, ignoredAsins),
    { countdownWindowDays: windowDays },
    now,
  )

  if (upcoming.length === 0) return null

  const soonest = upcoming[0]
  const label = countdownLabel(soonest, now)
  const extra = upcoming.length - 1

  return (
    <div
      className="rc-banner is-link"
      role="link"
      tabIndex={0}
      title="See everything you're following"
      onClick={() => navigate('/upcoming')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') navigate('/upcoming')
      }}
    >
      {soonest.coverArtUrl ? (
        <img className="rc-cover" src={soonest.coverArtUrl} alt="" />
      ) : (
        <div className="rc-cover" style={{ background: 'var(--c-highest)' }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="rc-eyebrow">
          <Icon name="new_releases" fill />
          {label === 'Out today' ? 'Out today' : `${label} until release`}
        </div>
        <div className="rc-title">{soonest.title}</div>
        <div className="rc-sub">
          {extra > 0
            ? `and ${extra} more on the way`
            : (soonest.author ?? soonest.seriesTitle ?? 'Coming soon')}
        </div>
      </div>
    </div>
  )
}
