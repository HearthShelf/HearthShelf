import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useQuestGiverEnabled } from '@/hooks/useQuestGiver'
import { useRmabEnabled } from '@/hooks/useRmab'
import { Wordmark } from '@/components/common/Wordmark'
import { Icon } from '@/components/common/Icon'

// Browse surfaces (series, authors, narrators, search, item detail) keep the
// Library entry lit, matching the design reference.
function groupForPath(path: string): string {
  if (path === '/') return 'home'
  if (
    path.startsWith('/library') ||
    path.startsWith('/series') ||
    path.startsWith('/book') ||
    path.startsWith('/authors') ||
    path.startsWith('/narrators') ||
    path.startsWith('/search') ||
    path.startsWith('/podcast/')
  )
    return 'library'
  if (path.startsWith('/collections')) return 'collections'
  if (path.startsWith('/playlists')) return 'playlists'
  if (path.startsWith('/podcasts/latest')) return 'podcastLatest'
  if (path.startsWith('/podcasts/add')) return 'podcastAdd'
  if (path.startsWith('/podcasts/queue')) return 'podcastQueue'
  if (path.startsWith('/questgiver')) return 'questgiver'
  if (path.startsWith('/requests')) return 'requests'
  if (path.startsWith('/stats')) return 'stats'
  if (path.startsWith('/sessions')) return 'sessions'
  if (path.startsWith('/player')) return 'player'
  if (path.startsWith('/config')) return 'config'
  if (path.startsWith('/settings') || path.startsWith('/account')) return 'settings'
  return path.slice(1)
}

interface NavItemDef {
  id: string
  icon: string
  label: string
  to: string
  badge?: number | null
  badgeWarn?: boolean
}

function UserMenu() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  const initial = (user?.username ?? '?').trim()[0]?.toUpperCase()
  const isAdmin = user?.type === 'admin' || user?.type === 'root'
  const go = (to: string) => {
    setOpen(false)
    navigate(to)
  }

  return (
    <div className="user-wrap" onClick={(e) => e.stopPropagation()}>
      {open && (
        <div className="user-menu">
          <button onClick={() => go('/account')}>
            <Icon name="person" /> Account settings
          </button>
          <button onClick={() => go('/stats')}>
            <Icon name="insights" /> Your stats
          </button>
          {isAdmin && (
            <button onClick={() => go('/config')}>
              <Icon name="manage_accounts" /> Server &amp; admin
            </button>
          )}
          <div className="sep" />
          <button className="danger" onClick={signOut}>
            <Icon name="logout" /> Log out
          </button>
        </div>
      )}
      <button
        className={'user-chip' + (open ? ' on' : '')}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sb-avatar">{initial}</span>
        <span className="u-meta">
          <span className="u-name">{user?.username}</span>
          <span className="u-sub">{window.location.host}</span>
        </span>
        <Icon name="expand_less" className="u-chev" />
      </button>
    </div>
  )
}

export function Sidebar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { user } = useAuth()
  const { itemCount, active: activeLib } = useActiveLibrary()
  const group = groupForPath(pathname)
  const isAdmin = user?.type === 'admin' || user?.type === 'root'
  const isPodcast = activeLib?.mediaType === 'podcast'
  const qgEnabled = useQuestGiverEnabled()
  const rmabEnabled = useRmabEnabled()

  const Item = ({ id, icon, label, to, badge, badgeWarn }: NavItemDef) => {
    const active = group === id
    return (
      <button
        className={'nav-item' + (active ? ' active' : '')}
        onClick={() => navigate(to)}
      >
        <Icon name={icon} fill={active} />
        {label}
        {badge != null && (
          <span className={'ni-badge' + (badgeWarn ? ' warn' : '')}>{badge}</span>
        )}
      </button>
    )
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <Icon name="local_fire_department" fill className="mark" />
        <Wordmark />
      </div>

      <nav className="nav">
        <Item id="home" icon="home" label="Home" to="/" />
        <Item
          id="library"
          icon="grid_view"
          label="Library"
          to="/library"
          badge={itemCount}
        />

        {!isPodcast ? (
          <>
            <div className="nav-label">Shelves</div>
            <Item id="collections" icon="folder_special" label="Collections" to="/collections" />
            <Item id="playlists" icon="queue_music" label="Playlists" to="/playlists" />
            {rmabEnabled && (
              <Item id="requests" icon="cloud_download" label="Requests" to="/requests" />
            )}
          </>
        ) : (
          <>
            <Item id="podcastLatest" icon="podcasts" label="Latest" to="/podcasts/latest" />
            {isAdmin && (
              <>
                <Item id="podcastAdd" icon="add_circle" label="Add podcast" to="/podcasts/add" />
                <Item id="podcastQueue" icon="download" label="Download queue" to="/podcasts/queue" />
              </>
            )}
          </>
        )}

        <div className="nav-label">Insights</div>
        {qgEnabled && !isPodcast && (
          <Item id="questgiver" icon="explore" label="QuestGiver" to="/questgiver" />
        )}
        <Item id="stats" icon="insights" label="Stats" to="/stats" />
        <Item id="sessions" icon="history" label="History" to="/sessions" />
        <Item id="player" icon="graphic_eq" label="Now playing" to="/player" />

        <div className="nav-sep" />
        {isAdmin && (
          <Item id="config" icon="dns" label="Server" to="/config" />
        )}
        <Item id="settings" icon="tune" label="Settings" to="/settings" />
      </nav>

      <UserMenu />
    </aside>
  )
}
