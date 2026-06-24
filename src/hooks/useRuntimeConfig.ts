// Loads the HearthShelf runtime config once and caches it for the app lifetime.
// Used to decide whether to route a fresh install into onboarding and which
// onboarding variant (slim vs aio) to show.

import { useQuery } from '@tanstack/react-query'
import { getRuntimeConfig } from '@/api/runtime'

export function useRuntimeConfig() {
  return useQuery({
    queryKey: ['runtime-config'],
    queryFn: getRuntimeConfig,
    staleTime: Infinity,
    // The backend may be briefly unreachable while the bundled ABS boots; retry
    // a few times so onboarding doesn't flash a failure on a cold AIO start.
    retry: 3,
  })
}
