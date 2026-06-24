import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import { AppShell } from '@/components/layout/AppShell'

export function ProtectedLayout() {
  const { isAuthenticated, isHydrating, hydrate, user } = useAuth()
  const { data: runtime } = useRuntimeConfig()

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  if (isHydrating) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  // First-run setup: a slim/aio box that hasn't finished onboarding routes its
  // admin to the wizard. Non-admins just use the app (they can't run setup), and
  // 'hosted' instances are managed by the control plane, never here.
  const isAdmin = user?.type === 'admin' || user?.type === 'root'
  const needsOnboarding =
    runtime && !runtime.onboarded && (runtime.mode === 'slim' || runtime.mode === 'aio')
  if (needsOnboarding && isAdmin) {
    return <Navigate to="/onboarding" replace />
  }

  return <AppShell />
}
