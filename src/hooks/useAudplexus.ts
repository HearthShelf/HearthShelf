import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/store/authStore'

// Audplexus connection status. Audplexus is an admin-facing library-sync
// diagnostics service; when configured, HearthShelf surfaces a "Buy on Audible"
// affordance on catalog results that aren't requestable through RMAB.
//
// The backend integration (a JSON sync-status endpoint + /hs/audplexus proxy)
// is not built yet, so this currently resolves to not-configured. The hook
// exists now so the gate is in place; wiring it later is a one-file change.
interface AudplexusConfig {
  configured: boolean
}

async function getAudplexusConfig(): Promise<AudplexusConfig> {
  const token = useAuthStore.getState().token
  try {
    const res = await fetch('/hs/audplexus/config', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return { configured: false }
    return (await res.json()) as AudplexusConfig
  } catch {
    return { configured: false }
  }
}

export function useAudplexusConfig() {
  return useQuery({
    queryKey: ['audplexus', 'config'],
    queryFn: getAudplexusConfig,
    staleTime: 5 * 60 * 1000,
  })
}

export function useAudplexusEnabled(): boolean {
  const { data } = useAudplexusConfig()
  return data?.configured === true
}

// Sync-status + library-health summary from Audplexus (admin only). Shape
// mirrors Audplexus GET /api/sync/status.json.
export interface AudplexusStatus {
  running: boolean
  status: string
  message?: string
  error?: string
  startedAt?: string
  completedAt?: string
  booksTotal: number
  booksFailed: number
  statusCounts: Record<string, number>
  hasIssues: boolean
}

async function getAudplexusStatus(): Promise<AudplexusStatus | null> {
  const token = useAuthStore.getState().token
  try {
    const res = await fetch('/hs/audplexus/status', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return null
    const r = (await res.json()) as Record<string, unknown>
    return {
      running: Boolean(r.running),
      status: String(r.status ?? ''),
      message: (r.message as string) || undefined,
      error: (r.error as string) || undefined,
      startedAt: (r.started_at as string) || undefined,
      completedAt: (r.completed_at as string) || undefined,
      booksTotal: Number(r.books_total ?? 0),
      booksFailed: Number(r.books_failed ?? 0),
      statusCounts: (r.status_counts as Record<string, number>) ?? {},
      hasIssues: Boolean(r.has_issues),
    }
  } catch {
    return null
  }
}

export function useAudplexusStatus(enabled = true) {
  return useQuery({
    queryKey: ['audplexus', 'status'],
    queryFn: getAudplexusStatus,
    enabled,
    staleTime: 60 * 1000,
  })
}
