import { Outlet } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { PlayerBar } from '@/components/player/PlayerBar'

// Persistent app frame. The PlayerBar sits outside the routed Outlet so it
// stays mounted across navigation - playback never interrupts on route change.
export function AppShell() {
  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
      <PlayerBar />
    </div>
  )
}
