import { Navigate } from 'react-router-dom'
import { useQgConfig } from '@/hooks/useQuestGiver'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { QuestGiverPage } from '@/pages/QuestGiverPage'

// Route guard: QuestGiver is admin-gated (independent of the AI provider). A
// stale link to /questgiver redirects home when the feature is off.
export function QuestGiverGate() {
  const { data, isLoading } = useQgConfig()
  if (isLoading) return <LoadingSpinner />
  if (data && data.featureEnabled === false) return <Navigate to="/" replace />
  return <QuestGiverPage />
}
