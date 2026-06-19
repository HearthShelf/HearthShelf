import { useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'
import { AppBar } from '@/components/layout/AppBar'
import { PlayerBar } from '@/components/player/PlayerBar'
import { AudioEngine } from '@/components/player/AudioEngine'
import { useApplySettings } from '@/hooks/useApplySettings'
import { useSettingsStore } from '@/store/settingsStore'

// Persistent app frame (design: .app grid + cover-glow bloom). The PlayerBar
// sits outside the routed Outlet so it stays mounted across navigation -
// playback never interrupts on route change.
export function AppShell() {
  const appRef = useRef<HTMLDivElement>(null)
  const isPlayerRoute = useLocation().pathname === '/player'
  const coverStyle = useSettingsStore((s) => s.coverStyle)

  useApplySettings(appRef, isPlayerRoute)

  return (
    <div
      ref={appRef}
      className={
        'app' +
        (coverStyle === 'cards' ? ' cards' : '') +
        (isPlayerRoute ? ' player-mode' : '')
      }
    >
      <div className="app-glow" />
      <Sidebar />
      <div className="main">
        {!isPlayerRoute && <AppBar />}
        <div className="content">
          <Outlet />
        </div>
      </div>
      <PlayerBar />
      <AudioEngine />
    </div>
  )
}
