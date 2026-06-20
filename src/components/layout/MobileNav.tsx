import { useState, Fragment } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useQuestGiverEnabled, useDiscoverEnabled } from '@/hooks/useQuestGiver'
import { useRmabEnabled } from '@/hooks/useRmab'
import { Icon } from '@/components/common/Icon'

// Which nav group a path belongs to, so the matching bottom-bar tab lights up.
// Mirrors the sidebar grouping but only for the five primary destinations.
function tabForPath(path: string): string {
  if (path === '/') return 'home'
  if (path.startsWith('/player')) return 'player'
  if (path.startsWith('/discover')) return 'discover'
  if (
    path.startsWith('/library') ||
    path.startsWith('/series') ||
    path.startsWith('/book') ||
    path.startsWith('/authors') ||
    path.startsWith('/narrators') ||
    path.startsWith('/search')
  )
    return 'library'
  return 'more'
}

interface PrimaryTab {
  id: string
  icon: string
  label: string
  to: string
}

const PRIMARY: PrimaryTab[] = [
  { id: 'home', icon: 'home', label: 'Home', to: '/' },
  { id: 'library', icon: 'grid_view', label: 'Library', to: '/library' },
  { id: 'player', icon: 'graphic_eq', label: 'Now Playing', to: '/player' },
  { id: 'discover', icon: 'travel_explore', label: 'Discover', to: '/discover' },
]

function MoreRow({
  icon,
  label,
  to,
  onGo,
}: {
  icon: string
  label: string
  to: string
  onGo: (to: string) => void
}) {
  return (
    <button className="ms-row" onClick={() => onGo(to)}>
      <Icon name={icon} />
      <span>{label}</span>
      <Icon name="chevron_right" className="ms-chev" />
    </button>
  )
}

// Full-screen overflow sheet for everything that doesn't fit the bottom bar.
function MoreSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const isAdmin = user?.type === 'admin' || user?.type === 'root'
  const { active: activeLib } = useActiveLibrary()
  const isPodcast = activeLib?.mediaType === 'podcast'
  const qgEnabled = useQuestGiverEnabled()
  const rmabEnabled = useRmabEnabled()

  const go = (to: string) => {
    onClose()
    navigate(to)
  }

  // Built as data so the rows aren't components declared during render.
  const items: { icon: string; label: string; to: string; sep?: boolean }[] = [
    ...(isPodcast
      ? []
      : [
          { icon: 'folder_special', label: 'Collections', to: '/collections' },
          { icon: 'queue_music', label: 'Playlists', to: '/playlists' },
        ]),
    { icon: 'insights', label: 'Stats', to: '/stats' },
    { icon: 'history', label: 'History', to: '/sessions' },
    ...(qgEnabled && !isPodcast
      ? [{ icon: 'favorite', label: 'QuestGiver', to: '/questgiver' }]
      : []),
    ...(rmabEnabled && !isPodcast
      ? [{ icon: 'cloud_download', label: 'Requests', to: '/requests' }]
      : []),
    { icon: 'person', label: 'Account settings', to: '/account', sep: true },
    ...(isAdmin
      ? [{ icon: 'dns', label: 'Server & admin', to: '/config' }]
      : []),
    { icon: 'settings', label: 'Settings', to: '/settings' },
  ]

  return (
    <div className="more-sheet-backdrop" onClick={onClose}>
      <div className="more-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="ms-grab" />
        <div className="ms-head">
          <span className="sb-avatar">
            {(user?.username ?? '?').trim()[0]?.toUpperCase()}
          </span>
          <div className="ms-user">
            <div className="ms-name">{user?.username}</div>
            <div className="ms-sub">{window.location.host}</div>
          </div>
          <button className="ms-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="ms-list">
          {items.map((it) => (
            <Fragment key={it.to}>
              {it.sep && <div className="ms-sep" />}
              <MoreRow icon={it.icon} label={it.label} to={it.to} onGo={go} />
            </Fragment>
          ))}
          <div className="ms-sep" />
          <button className="ms-row danger" onClick={signOut}>
            <Icon name="logout" />
            <span>Log out</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export function MobileNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const discoverEnabled = useDiscoverEnabled()
  const [moreOpen, setMoreOpen] = useState(false)
  const active = tabForPath(pathname)

  // A primary-tab tap navigates and dismisses the sheet; the sheet's own rows
  // close it before navigating. Closing on a path change is handled there, so
  // no navigation effect is needed.
  const tabs = PRIMARY.filter((t) => t.id !== 'discover' || discoverEnabled)

  return (
    <>
      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
      <nav className="mobile-nav">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={'mn-tab' + (active === t.id ? ' on' : '')}
            onClick={() => {
              setMoreOpen(false)
              navigate(t.to)
            }}
          >
            <Icon name={t.icon} fill={active === t.id} />
            <span>{t.label}</span>
          </button>
        ))}
        <button
          className={'mn-tab' + (active === 'more' || moreOpen ? ' on' : '')}
          onClick={() => setMoreOpen((o) => !o)}
        >
          <Icon name="menu" />
          <span>More</span>
        </button>
      </nav>
    </>
  )
}
