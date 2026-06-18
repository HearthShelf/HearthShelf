import { NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Library, Headphones, LogOut } from 'lucide-react'
import { getLibraries, libraryKeys } from '@/api/libraries'
import { useAuth } from '@/hooks/useAuth'
import { Wordmark } from '@/components/common/Wordmark'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function Sidebar() {
  const { user, signOut } = useAuth()
  const { data } = useQuery({
    queryKey: libraryKeys.all,
    queryFn: getLibraries,
    staleTime: 5 * 60 * 1000,
  })

  const libraries = data?.libraries ?? []

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
      isActive
        ? 'bg-secondary text-secondary-foreground'
        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
    )

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="px-5 py-5">
        <Wordmark className="text-2xl" />
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        <NavLink to="/continue" className={linkClass}>
          <Headphones className="size-4" />
          Continue Listening
        </NavLink>

        <p className="mt-4 px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Libraries
        </p>
        {libraries.map((lib) => (
          <NavLink key={lib.id} to={`/library/${lib.id}`} className={linkClass}>
            <Library className="size-4" />
            <span className="truncate">{lib.name}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user?.username}</p>
            <p className="truncate text-xs text-muted-foreground">
              {user?.type}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={signOut}
            aria-label="Sign out"
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </aside>
  )
}
