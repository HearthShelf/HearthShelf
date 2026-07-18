// POC seam for unifying the admin surface across the self-hosted SPA and the
// hosted WebApp.
//
// The two apps' config pages diverged for ONE structural reason: how they reach
// a server. The self-hosted SPA talks to a single, same-origin ABS via
// `absRequest(path)`; the WebApp talks to any of several linked servers via
// `absGet(target, path)` where `target` is the ambient active server. The page
// bodies (JSX, formatting, download logic) are otherwise the same.
//
// `useAdminDataSource()` erases that difference. It returns the ambient server
// `target` plus a `request(path, init)` already bound to it. A config page reads
// its data through this hook and never imports a fixed client, so the SAME page
// body compiles in both apps - each app just provides the hook its own way.
//
// This is the self-hosted implementation: a fixed same-origin target and a
// request bound to the authStore token. See the WebApp's copy for the
// multi-server implementation backed by useActiveServer(). The two files are the
// only per-app glue; everything above the hook is shared.

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { absRequest } from '@/api/client'

/** Minimal identity of the server an admin page is acting on. */
export interface AdminTarget {
  serverId: string
  serverUrl: string
}

export interface AdminDataSource {
  /** The server this page is administering, or null while unresolved. */
  target: AdminTarget | null
  /** Whether more than one server exists (drives the server switcher's presence). */
  isMultiServer: boolean
  /** A JSON request bound to `target`. Same signature in both apps. */
  request: <T>(path: string, init?: RequestInit) => Promise<T>
}

const Ctx = createContext<AdminDataSource | null>(null)

// Self-hosted: exactly one server, reached same-origin. serverId 'local' matches
// the server-side default id, and serverUrl is this origin.
export function AdminDataSourceProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AdminDataSource>(
    () => ({
      target: { serverId: 'local', serverUrl: window.location.origin },
      isMultiServer: false,
      request: <T,>(path: string, init?: RequestInit) => absRequest<T>(path, init),
    }),
    [],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAdminDataSource(): AdminDataSource {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAdminDataSource must be used within AdminDataSourceProvider')
  return v
}
