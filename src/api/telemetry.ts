import { useAuthStore } from '@/store/authStore'

/**
 * Anonymous usage stats (opt-out), instance-wide and admin-owned.
 *
 * `chosen` is false until an admin actually answers - that is how the onboarding
 * wizard knows whether to ask, and it is what keeps a stored decision safe from
 * any future change to the default.
 */
export interface TelemetryStatus {
  enabled: boolean
  chosen: boolean
  canEdit: boolean
  payloadPreview?: unknown
}

async function telemetryFetch<T>(options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch('/hs/telemetry', {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`telemetry ${res.status}`)
  return res.json() as Promise<T>
}

export function getTelemetryStatus(): Promise<TelemetryStatus> {
  return telemetryFetch<TelemetryStatus>()
}

/** Record the admin's choice. Writing it marks the question as answered. */
export function setTelemetryEnabled(enabled: boolean): Promise<TelemetryStatus> {
  return telemetryFetch<TelemetryStatus>({
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}
