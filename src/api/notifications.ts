import { useAuthStore } from '@/store/authStore'

export interface HSNotification {
  id: string
  kind: string
  entityId: string
  title: string
  body: string
  data: Record<string, unknown>
  createdAt: number
  readAt: number | null
  actionStatus: string | null
}

export interface NotificationsResponse {
  notifications: HSNotification[]
  unreadCount: number
}

const EMPTY: NotificationsResponse = { notifications: [], unreadCount: 0 }

function authHeaders(): HeadersInit {
  const token = useAuthStore.getState().token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function getNotifications(): Promise<NotificationsResponse> {
  try {
    const response = await fetch('/hs/notifications', { headers: authHeaders() })
    if (!response.ok) return EMPTY
    const data = (await response.json()) as Partial<NotificationsResponse>
    return {
      notifications: Array.isArray(data.notifications) ? data.notifications : [],
      unreadCount: Number(data.unreadCount) || 0,
    }
  } catch {
    return EMPTY
  }
}

async function mark(path: string): Promise<void> {
  const response = await fetch(path, { method: 'PUT', headers: authHeaders() })
  if (!response.ok) throw new Error(`notifications ${response.status}`)
}

export function markNotificationRead(id: string): Promise<void> {
  return mark(`/hs/notifications/${encodeURIComponent(id)}/read`)
}

export function markAllNotificationsRead(): Promise<void> {
  return mark('/hs/notifications/read-all')
}
