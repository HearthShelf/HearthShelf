import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useActiveLibrary, libraryIcon } from '@/hooks/useActiveLibrary'
import { useQuestGiverEnabled, useDiscoverEnabled } from '@/hooks/useQuestGiver'
import { useRmabEnabled } from '@/hooks/useRmab'
import { Avatar } from '@/components/common/Avatar'
import { Icon } from '@/components/common/Icon'

// Which primary tab (or "more") a path belongs to, so the matching bottom-bar
// item lights up. Mirrors the sidebar grouping for the five destinations.
function tabForPath(path: string): string {
  if (path === '/') return 'home'
  if (path.startsWith('/player')) return 'player'
  if (path.startsWith('/discover')) return 'discover'
  if (
    path.startsWith('/library') ||
    path.startsWith('/series') ||
    path.startsWith('/book') ||
    path.startsWith('/author') ||
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
  { id: 'player', icon: 'graphic_eq', label: 'Now playing', to: '/player' },
  { id: 'discover', icon: 'explore', label: 'Discover', to: '/discover' },
]

interface DrawerRowDef {
  id: string
  icon: string
  label: string
  to: string
  badge?: number | null
  badgeWarn?: boolean
}

function DrawerRow({
  id,
  icon,
  label,
  to,
  badge,
  badgeWarn,
  activeTab,
  onGo,
}: DrawerRowDef & { activeTab: string; onGo: (to: string) => void }) {
  const active = activeTab === id
  return (
    <button className={'msheet-row' + (active ? ' active' : '')} onClick={() => onGo(to)}>
      <span className="msheet-ic">
        <Icon name={icon} fill={active} />
      </span>
      <span className="msheet-label">{label}</span>
      {badge != null && <span className={'ni-badge' + (badgeWarn ? ' warn' : '')}>{badge}</span>}
      <Icon name="chevron_right" className="msheet-chev" />
    </button>
  )
}

// The mobile-first "More" bottom sheet: library switcher + grouped overflow
// destinations, matching the Rev 4 mdrawer design.
function MobileDrawer({
  open,
  onClose,
  activeTab,
}: {
  open: boolean
  onClose: () => void
  activeTab: string
}) {
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const isAdmin = user?.type === 'admin' || user?.type === 'root'
  const { libraries, active, select } = useActiveLibrary()
  const isPodcast = active?.mediaType === 'podcast'
  const qgEnabled = useQuestGiverEnabled()
  const rmabEnabled = useRmabEnabled()

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const go = (to: string) => {
    onClose()
    navigate(to)
  }

  // Overflow rows as data, grouped by section, so no component is created
  // during render (and the list stays easy to gate per feature).
  const groups: { sec: string; rows: DrawerRowDef[] }[] = []
  if (!isPodcast)
    groups.push({
      sec: 'Shelves',
      rows: [
        { id: 'collections', icon: 'folder_special', label: 'Collections', to: '/collections' },
        { id: 'playlists', icon: 'queue_music', label: 'Playlists', to: '/playlists' },
      ],
    })
  if (isPodcast) {
    const pod: DrawerRowDef[] = [
      { id: 'podcastLatest', icon: 'podcasts', label: 'Latest episodes', to: '/podcasts/latest' },
    ]
    if (isAdmin) {
      pod.push({ id: 'podcastAdd', icon: 'add_circle', label: 'Add podcast', to: '/podcasts/add' })
      pod.push({
        id: 'podcastQueue',
        icon: 'download',
        label: 'Download queue',
        to: '/podcasts/queue',
      })
    }
    groups.push({ sec: 'Podcasts', rows: pod })
  }
  groups.push({
    sec: 'Insights',
    rows: [
      { id: 'stats', icon: 'insights', label: 'Stats', to: '/stats' },
      { id: 'finished', icon: 'check_circle', label: 'Finished', to: '/finished' },
      { id: 'sessions', icon: 'history', label: 'Listening history', to: '/sessions' },
    ],
  })
  const dr: DrawerRowDef[] = []
  if (qgEnabled && !isPodcast)
    dr.push({ id: 'questgiver', icon: 'favorite', label: 'QuestGiver', to: '/questgiver' })
  if (rmabEnabled && !isPodcast)
    dr.push({ id: 'requests', icon: 'cloud_download', label: 'Requests', to: '/requests' })
  if (dr.length) groups.push({ sec: 'Discover & requests', rows: dr })
  const account: DrawerRowDef[] = [
    { id: 'account', icon: 'person', label: 'Account settings', to: '/account' },
  ]
  if (isAdmin) account.push({ id: 'config', icon: 'dns', label: 'Server', to: '/config' })
  account.push({ id: 'settings', icon: 'settings', label: 'Settings', to: '/settings' })
  groups.push({ sec: 'Account', rows: account })

  const initial = (user?.username ?? '?').trim()[0]?.toUpperCase() ?? '?'

  return (
    <div className={'mdrawer-root' + (open ? ' open' : '')} aria-hidden={!open}>
      <div className={'mdrawer-scrim' + (open ? ' open' : '')} onClick={onClose} />
      <aside className={'mdrawer' + (open ? ' open' : '')} role="dialog" aria-label="More">
        <div className="msheet-grab" />
        <div className="msheet-user">
          {user ? (
            <Avatar userId={user.id} name={user.username} size={46} />
          ) : (
            <span className="msheet-av">{initial}</span>
          )}
          <div className="msheet-umeta">
            <div className="msheet-uname">{user?.username}</div>
            <div className="msheet-usub">{window.location.host}</div>
          </div>
          <button className="msheet-close" onClick={onClose} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        <div className="msheet-scroll">
          {libraries.length > 1 && (
            <>
              <div className="msheet-sec">Library</div>
              {libraries.map((l) => {
                const on = l.id === active?.id
                return (
                  <button
                    key={l.id}
                    className={'msheet-row' + (on ? ' active' : '')}
                    onClick={() => {
                      select(l.id)
                      onClose()
                      navigate('/library')
                    }}
                  >
                    <span className="msheet-ic">
                      <Icon name={libraryIcon(l)} fill={on} />
                    </span>
                    <span className="msheet-label">
                      {l.name}
                      <span className="msheet-sublabel">
                        {l.mediaType === 'podcast' ? 'Podcasts' : 'Audiobooks'}
                      </span>
                    </span>
                    {on && (
                      <Icon
                        name="check"
                        className="msheet-chev"
                        style={{ color: 'var(--accent)' }}
                      />
                    )}
                  </button>
                )
              })}
            </>
          )}

          {groups.map((g) => (
            <div key={g.sec}>
              <div className="msheet-sec">{g.sec}</div>
              {g.rows.map((r) => (
                <DrawerRow key={r.id} {...r} activeTab={activeTab} onGo={go} />
              ))}
            </div>
          ))}

          <button className="msheet-row danger" onClick={signOut}>
            <span className="msheet-ic">
              <Icon name="logout" />
            </span>
            <span className="msheet-label">Log out</span>
          </button>
        </div>
      </aside>
    </div>
  )
}

export function MobileNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const discoverEnabled = useDiscoverEnabled()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const tab = tabForPath(pathname)
  const onPrimary = PRIMARY.some((t) => t.id === tab)

  const tabs = PRIMARY.filter((t) => t.id !== 'discover' || discoverEnabled)

  return (
    <>
      <nav className="mtab" role="navigation" aria-label="Primary">
        {tabs.map((t) => {
          const active = !drawerOpen && tab === t.id
          return (
            <button
              key={t.id}
              className={'mtab-item' + (active ? ' active' : '')}
              onClick={() => {
                setDrawerOpen(false)
                navigate(t.to)
              }}
            >
              <Icon name={t.icon} fill={active} />
              <span>{t.label}</span>
            </button>
          )
        })}
        <button
          className={'mtab-item' + (drawerOpen || !onPrimary ? ' active' : '')}
          onClick={() => setDrawerOpen((o) => !o)}
        >
          <Icon name="menu" />
          <span>More</span>
        </button>
      </nav>
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} activeTab={tab} />
    </>
  )
}
