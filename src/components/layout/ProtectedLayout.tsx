import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { AppShell } from '@/components/layout/AppShell'

export function ProtectedLayout() {
  const { isAuthenticated, isHydrating, hydrate } = useAuth()

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

  return <AppShell />
}
