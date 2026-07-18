import { useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'
import { AppBar } from '@/components/layout/AppBar'
import { MobileNav } from '@/components/layout/MobileNav'
import { PlayerBar } from '@/components/player/PlayerBar'
import { AudioEngine } from '@/components/player/AudioEngine'
import { NotePopWatcher } from '@/components/social/NotePopWatcher'
import { ServerHealthWatcher } from '@/components/hosted/ServerHealthWatcher'
import { useApplySettings } from '@/hooks/useApplySettings'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { useQueueSync } from '@/hooks/useQueueSync'
import { useSettingsStore } from '@/store/settingsStore'
import { useIsMobile } from '@/hooks/useMediaQuery'

// Persistent app frame (design: .app grid + cover-glow bloom). The PlayerBar
// sits outside the routed Outlet so it stays mounted across navigation -
// playback never interrupts on route change.
export function AppShell() {
  const appRef = useRef<HTMLDivElement>(null)
  const { pathname } = useLocation()
  const isPlayerRoute = pathname === '/player'
  // The reader is full-bleed like the player: no app bar, no bottom tab bar.
  const isReaderRoute = pathname.startsWith('/reader/')
  const immersive = isPlayerRoute || isReaderRoute
  const coverStyle = useSettingsStore((s) => s.coverStyle)
  // User can hide the docked player bar; the full player stays reachable from
  // the player nav / a book's Play button.
  const hideMiniPlayer = useSettingsStore((s) => s.hideMiniPlayer)
  const isMobile = useIsMobile()

  useApplySettings()
  useSettingsSync()
  useQueueSync()

  return (
    <div
      ref={appRef}
      className={
        'app' +
        (coverStyle === 'cards' ? ' cards' : '') +
        (immersive ? ' player-mode' : '') +
        (isMobile ? ' has-mobile-nav' : '')
      }
    >
      <div className="app-glow" />
      <Sidebar />
      <div className="main">
        {!immersive && !isMobile && <AppBar />}
        <div className="content">
          <Outlet />
        </div>
        {isMobile && !immersive && <MobileNav />}
      </div>
      {!hideMiniPlayer && <PlayerBar />}
      <AudioEngine />
      <NotePopWatcher />
      <ServerHealthWatcher />
    </div>
  )
}
