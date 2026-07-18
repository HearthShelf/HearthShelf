import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import { getServiceHealth, resetServiceCredential } from '@/api/hosted'
import { ServerHealthAlert } from '@/components/hosted/ServerHealthAlert'

// App-level watcher: for admins, polls the server's provisioning-credential
// health and interrupts with a blocking alert when it's BROKEN (invited people
// can't join). Mounted once in AppShell, like NotePopWatcher. Non-admins and
// healthy servers render nothing.
export function ServerHealthWatcher() {
  const { user } = useAuth()
  const { data: runtime } = useRuntimeConfig()
  const navigate = useNavigate()
  const [snoozed, setSnoozed] = useState(false)

  const isAdmin = user?.type === 'admin' || user?.type === 'root'
  // Only relevant on a paired (hosted-capable) server; an unpaired self-hosted
  // box never provisions invited users, so there's no credential to break.
  const paired = Boolean(runtime?.paired)

  const { data: health } = useQuery({
    queryKey: ['server-health'],
    queryFn: getServiceHealth,
    enabled: isAdmin && paired,
    // Re-check periodically so a credential that dies mid-session surfaces, and
    // so the alert clears once it's fixed elsewhere.
    refetchInterval: 60 * 1000,
    staleTime: 30 * 1000,
  })

  // __DEV_FORCE__ (temporary): visualize the broken alert without a live backend.
  const DEV_FORCE = true
  const effective = DEV_FORCE
    ? ({ state: 'broken', paired: true, hasCredential: true, canSelfHeal: false } as const)
    : health
  if (!DEV_FORCE && (!isAdmin || !health || health.state !== 'broken' || snoozed)) return null
  if (snoozed) return null

  return (
    <ServerHealthAlert
      health={effective as typeof health & object}
      serverName={runtime?.serverName || 'Jeremy’s Library'}
      onReset={resetServiceCredential}
      onGoToConnect={() => {
        setSnoozed(true)
        navigate('/config/connect')
      }}
      onGoToLogs={() => {
        setSnoozed(true)
        navigate('/config/logs')
      }}
      onSnooze={() => setSnoozed(true)}
    />
  )
}
