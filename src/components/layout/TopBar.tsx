import { Search } from 'lucide-react'

// Gray-box. Search is out of scope for v0.1 (shown disabled as a placeholder);
// the library switcher lives in the Sidebar for now.
export function TopBar() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-background px-6">
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground">
        <Search className="size-4" />
        <span>Search (coming soon)</span>
      </div>
    </header>
  )
}
