import { usePlayerStore } from '@/store/playerStore'
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Persistent across route changes - rendered once by ProtectedLayout, never
// unmounted on navigation. Gray-box for now; seek bar + speed land with the
// player wiring phase.
export function PlayerBar() {
  const title = usePlayerStore((s) => s.title)
  const author = usePlayerStore((s) => s.author)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const setPlaying = usePlayerStore((s) => s.setPlaying)

  const hasSession = title !== null

  return (
    <footer className="flex h-20 shrink-0 items-center gap-4 border-t bg-card px-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="size-12 shrink-0 rounded bg-muted" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {hasSession ? title : 'Nothing playing'}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {hasSession ? author : 'Pick a book to start listening'}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" disabled={!hasSession} aria-label="Previous chapter">
          <SkipBack className="size-5" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          disabled={!hasSession}
          onClick={() => setPlaying(!isPlaying)}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause className="size-5" /> : <Play className="size-5" />}
        </Button>
        <Button variant="ghost" size="icon" disabled={!hasSession} aria-label="Next chapter">
          <SkipForward className="size-5" />
        </Button>
      </div>

      <div className="hidden flex-1 md:block" />
    </footer>
  )
}
