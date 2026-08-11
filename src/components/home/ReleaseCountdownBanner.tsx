/**
 * Home countdown banner: "X days until <book>" for followed books whose release
 * is within the reader's countdown window (notifyCountdownWindowDays, default
 * 14). Renders nothing when nothing qualifies, so it's safe to always mount.
 *
 * Core does the filtering/sorting (bannerSubscriptions) and the label
 * (countdownLabel), so web, mobile and the release-notify job agree on what
 * "coming soon" means.
 */
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { bannerSubscriptions, countdownLabel } from '@hearthshelf/core'
import { getSubscriptions, subscriptionKeys } from '@/api/subscriptions'
import { useSettingsStore } from '@/store/settingsStore'
import { Icon } from '@/components/common/Icon'

export function ReleaseCountdownBanner() {
  const navigate = useNavigate()
  const windowDays = useSettingsStore((s) => s.notifyCountdownWindowDays)

  const { data: subscriptions } = useQuery({
    queryKey: subscriptionKeys.list,
    queryFn: getSubscriptions,
    staleTime: 10 * 60 * 1000,
  })

  // Date.now() at render is fine - the banner is not a hot path, and core does
  // the pure filtering.
  const upcoming = bannerSubscriptions(
    subscriptions ?? [],
    { countdownWindowDays: windowDays },
    Date.now(),
  )

  if (upcoming.length === 0) return null

  const soonest = upcoming[0]
  const label = countdownLabel(soonest, Date.now())
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
