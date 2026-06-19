import { Navigate } from 'react-router-dom'
import { useRmabConfig } from '@/hooks/useRmab'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { RequestsPage } from '@/pages/RequestsPage'

// Route guard: the request layer only exists when an admin has connected
// ReadMeABook. A stale /requests link redirects home when RMAB is off.
export function RequestsGate() {
  const { data, isLoading } = useRmabConfig()
  if (isLoading) return <LoadingSpinner />
  if (!data?.configured) return <Navigate to="/" replace />
  return <RequestsPage />
}
