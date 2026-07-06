import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { absRequest } from '@/api/client'
import type { ABSStatusResponse } from '@/api/types'
import { getLibraries, libraryKeys } from '@/api/libraries'
import { getUsers, adminKeys } from '@/api/admin'
import { useAuth } from '@/hooks/useAuth'
import { Icon } from '@/components/common/Icon'
import { ConfigUsers } from '@/pages/config/ConfigUsers'
import { ConfigUserDetail } from '@/pages/config/ConfigUserDetail'
import { ConfigServiceAccounts } from '@/pages/config/ConfigServiceAccounts'
import { ConfigApiKeys } from '@/pages/config/ConfigApiKeys'
import { ConfigBackups } from '@/pages/config/ConfigBackups'
import { ConfigImport } from '@/pages/config/ConfigImport'
import { ConfigSessions } from '@/pages/config/ConfigSessions'
import { ConfigLibraries } from '@/pages/config/ConfigLibraries'
import { ConfigServerInfo } from '@/pages/config/ConfigServerInfo'
import { ConfigServerStats, ConfigLibraryStats } from '@/pages/config/ConfigStats'
import { ConfigLogs } from '@/pages/config/ConfigLogs'
import { ConfigJobs } from '@/pages/config/ConfigJobs'
import { ConfigMeta } from '@/pages/config/ConfigMeta'
import { ConfigNotifications } from '@/pages/config/ConfigNotifications'
import {
  ConfigEmail,
  ConfigRss,
  ConfigAuth,
  ConfigIntegrations,
} from '@/pages/config/ConfigContentPages'
import { ConfigQuestGiver } from '@/pages/config/ConfigQuestGiver'
import { ConfigCommunity } from '@/pages/config/ConfigCommunity'
import { ConfigHosted } from '@/pages/config/ConfigHosted'
import { StatsPage } from '@/pages/StatsPage'
import { ConfigStub } from '@/pages/config/ConfigStub'
import { AdvancedModeProvider, AdvancedToggle } from '@/pages/config/AdvancedMode'

interface NavEntry {
  id: string
  icon: string
  label: string
  badge?: number | null
}
interface NavGroup {
  label: string
  items: NavEntry[]
}

export function ConfigShell({ menuMode = false }: { menuMode?: boolean }) {
  const { section = 'settings', userId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const isAdmin = user?.type === 'admin' || user?.type === 'root'
  // On a phone the two-pane layout drills down: the bare /config index shows
  // the section list (menu); picking a section shows its detail with a back
  // button. Desktop keeps both panes side by side.
  const mobileMenu = isMobile && menuMode

  const { data: libs } = useQuery({
    queryKey: libraryKeys.all,
    queryFn: getLibraries,
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  })
  const { data: usersData } = useQuery({
    queryKey: adminKeys.users,
    queryFn: getUsers,
    enabled: isAdmin,
    staleTime: 60 * 1000,
  })
  const { data: status } = useQuery({
    queryKey: ['server-status'],
    queryFn: () => absRequest<ABSStatusResponse>('/status'),
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  })

  if (!isAdmin) {
    return (
      <div className="page">
        <div className="empty-state">
          <Icon name="lock" />
          <h3>Admins only</h3>
          <p>You need an admin account to view server settings.</p>
        </div>
      </div>
    )
  }

  const groups: NavGroup[] = [
    {
      label: 'Server',
      items: [
        { id: 'settings', icon: 'tune', label: 'General' },
        {
          id: 'libraries',
          icon: 'video_library',
          label: 'Libraries',
          badge: libs?.libraries.length,
        },
        {
          id: 'users',
          icon: 'group',
          label: 'Users',
          badge: usersData?.users.length,
        },
        { id: 'service-accounts', icon: 'smart_toy', label: 'Service Accounts' },
        { id: 'apikeys', icon: 'key', label: 'API Keys' },
        { id: 'sessions', icon: 'graphic_eq', label: 'Listening Sessions' },
        { id: 'backups', icon: 'cloud_sync', label: 'Backups' },
        { id: 'import', icon: 'merge', label: 'Import & Merge' },
        { id: 'tasks', icon: 'schedule', label: 'Tasks' },
        { id: 'logs', icon: 'terminal', label: 'Logs' },
      ],
    },
    {
      label: 'Content',
      items: [
        { id: 'integrations', icon: 'extension', label: 'Integrations' },
        { id: 'notifications', icon: 'notifications', label: 'Notifications' },
        { id: 'email', icon: 'mail', label: 'Email' },
        { id: 'meta', icon: 'sell', label: 'Metadata Utils' },
        { id: 'rss', icon: 'rss_feed', label: 'RSS Feeds' },
        { id: 'auth', icon: 'lock', label: 'Authentication' },
      ],
    },
    {
      label: 'Features',
      items: [
        { id: 'questgiver', icon: 'explore', label: 'QuestGiver' },
        { id: 'connect', icon: 'hub', label: 'HearthShelf Connect' },
      ],
    },
    {
      label: 'Community',
      items: [{ id: 'community', icon: 'groups', label: 'Community' }],
    },
    {
      label: 'Insights',
      items: [
        { id: 'mystats', icon: 'person', label: 'Your Stats' },
        { id: 'serverstats', icon: 'leaderboard', label: 'Server Stats' },
        { id: 'libstats', icon: 'insights', label: 'Library Stats' },
      ],
    },
  ]

  // The Users nav item stays active on the user-detail sub-route.
  const activeId = userId ? 'users' : section

  const body = () => {
    if (userId) return <ConfigUserDetail userId={userId} />
    switch (section) {
      case 'users':
        return <ConfigUsers />
      case 'service-accounts':
        return <ConfigServiceAccounts />
      case 'apikeys':
        return <ConfigApiKeys />
      case 'backups':
        return <ConfigBackups />
      case 'import':
        return <ConfigImport />
      case 'sessions':
        return <ConfigSessions />
      case 'libraries':
        return <ConfigLibraries />
      case 'settings':
        return <ConfigServerInfo />
      case 'serverstats':
        return <ConfigServerStats />
      case 'libstats':
        return <ConfigLibraryStats />
      case 'mystats':
        return <StatsPage />
      case 'logs':
        return <ConfigLogs />
      case 'tasks':
        return <ConfigJobs />
      case 'meta':
        return <ConfigMeta />
      case 'notifications':
        return <ConfigNotifications />
      case 'email':
        return <ConfigEmail />
      case 'rss':
        return <ConfigRss />
      case 'auth':
        return <ConfigAuth />
      case 'integrations':
        return <ConfigIntegrations />
      case 'questgiver':
        return <ConfigQuestGiver />
      case 'community':
        return <ConfigCommunity />
      case 'connect':
        return <ConfigHosted />
      default:
        return <ConfigStub section={section} />
    }
  }

  const wrapMode = isMobile ? (mobileMenu ? ' cfg-menu' : ' cfg-detail') : ''

  return (
    <AdvancedModeProvider>
      <div className={'page config-wrap fade-in' + wrapMode}>
        <nav className="config-nav">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="cn-label">{g.label}</div>
              {g.items.map((it) => (
                <button
                  key={it.id}
                  className={'cn-item' + (activeId === it.id ? ' on' : '')}
                  onClick={() => navigate(`/config/${it.id}`)}
                >
                  <Icon name={it.icon} fill={activeId === it.id} />
                  {it.label}
                  {it.badge != null && <span className="cn-badge">{it.badge}</span>}
                  <Icon name="chevron_right" className="cn-chev" />
                </button>
              ))}
            </div>
          ))}
          <div className="config-foot">
            HearthShelf · server admin
            <br />
            {status?.app ?? 'audiobookshelf'} {status?.serverVersion ?? '—'}
            <br />
            {window.location.host}
          </div>
        </nav>
        {!mobileMenu && (
          <div className="config-body">
            {isMobile && (
              <button className="cfg-back" onClick={() => navigate('/config')}>
                <Icon name="arrow_back" /> All settings
              </button>
            )}
            <AdvancedToggle />
            {body()}
          </div>
        )}
      </div>
    </AdvancedModeProvider>
  )
}

// Bare /config: on desktop redirect to the default section (the two-pane view
// always shows a section); on a phone show the drill-down section list instead.
export function ConfigIndexRedirect() {
  const isMobile = useIsMobile()
  if (isMobile) return <ConfigShell menuMode />
  return <Navigate to="/config/settings" replace />
}
