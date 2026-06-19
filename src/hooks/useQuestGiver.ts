import { useQuery } from '@tanstack/react-query'
import { getQgConfig, type QgConfig } from '@/api/questgiver'

// Shared QuestGiver config query - drives the nav item, the route gate, and the
// page header. Cached for 5 minutes; the admin feature flag changes rarely.
export function useQgConfig() {
  return useQuery<QgConfig>({
    queryKey: ['qg-config'],
    queryFn: getQgConfig,
    staleTime: 5 * 60 * 1000,
  })
}

// True when QuestGiver should be shown. Treated as enabled until the config
// resolves, so the nav doesn't flicker; the gate hides it only on an explicit
// featureEnabled:false from the backend.
export function useQuestGiverEnabled(): boolean {
  const { data } = useQgConfig()
  return data?.featureEnabled !== false
}
