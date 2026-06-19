import { Navigate } from 'react-router-dom'
import { useQgConfig, useDiscoverEnabled } from '@/hooks/useQuestGiver'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { DiscoverPage } from '@/pages/DiscoverPage'

// Route guard: Discover is admin-gated (independent of QuestGiver and RMAB). A
// stale /discover link redirects home when the feature is off.
export function DiscoverGate() {
  const { isLoading } = useQgConfig()
  const enabled = useDiscoverEnabled()
  if (isLoading) return <LoadingSpinner />
  if (!enabled) return <Navigate to="/" replace />
  return <DiscoverPage />
}
