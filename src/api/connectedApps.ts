// Client for the box's connected-app registry (admin-only).
//
// These are third-party applications a USER authorized against this server -
// Audplexus filing finished audiobooks, a Home Assistant integration, anything
// that went through the connect flow. See server/routes/apps.js.
//
// Deliberately talks to THIS BOX, not the control plane. The box issues and
// revokes the credential an app actually lives on, so it is the authority on
// what has access - and revoking here works even when the control plane is
// unreachable, which is exactly when an admin most needs it to.

import { useAuthStore } from '@/store/authStore'

export const connectedAppKeys = {
  all: ['connected-apps'] as const,
}

/** One app authorized against this server. Never carries the credential. */
export interface ConnectedApp {
  appId: string
  /** Control-plane subject (Clerk user id) the app acts for. */
  subject: string
  appName: string
  /** 'instance' = one deployment per user (self-hosted); 'cloud' = one hosted
   *  service serving many users. */
  appKind: string
  /** Software family for self-registering apps, e.g. 'audplexus'. */
  family: string | null
  scopes: string[]
  /** The ABS user the app acts as - its permissions bound the app's. */
  absUserId: string
  createdAt: number
  lastUsedAt: number | null
  /** True when the app has been hitting its rate limit persistently. */
  throttled: boolean
}

async function hsFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/apps${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`apps ${res.status}`)
  return res.json() as Promise<T>
}

export function getConnectedApps(): Promise<{ installations: ConnectedApp[] }> {
  return hsFetch<{ installations: ConnectedApp[] }>('')
}

/**
 * Cut an app off. Immediate: this deletes the row its tokens resolve against,
 * so the app's very next request to this server fails. No waiting out a TTL, and
 * no round trip to the control plane.
 */
export function revokeConnectedApp(appId: string, subject: string): Promise<{ ok: boolean }> {
  return hsFetch<{ ok: boolean }>(
    `/${encodeURIComponent(appId)}/${encodeURIComponent(subject)}`,
    { method: 'DELETE' },
  )
}
