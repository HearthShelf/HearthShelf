import { absRequest } from '@/api/client'
import type {
  ABSUsersResponse,
  ABSApiKeysResponse,
  ABSApiKey,
  ABSBackupsResponse,
  ABSListeningSessionsResponse,
} from '@/api/types'

export const adminKeys = {
  users: ['admin', 'users'] as const,
  apiKeys: ['admin', 'apikeys'] as const,
  backups: ['admin', 'backups'] as const,
  sessions: (page: number) => ['admin', 'sessions', page] as const,
}

// --- Users ---
export function getUsers(): Promise<ABSUsersResponse> {
  return absRequest<ABSUsersResponse>('/api/users')
}

export function setUserActive(
  userId: string,
  isActive: boolean
): Promise<void> {
  return absRequest<void>(`/api/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  })
}

export function deleteUser(userId: string): Promise<void> {
  return absRequest<void>(`/api/users/${userId}`, { method: 'DELETE' })
}

// --- API keys ---
export function getApiKeys(): Promise<ABSApiKeysResponse> {
  return absRequest<ABSApiKeysResponse>('/api/api-keys')
}

// ABS requires the owning userId on create; returns the new key plus its raw
// token (shown once). The token rides on apiKey.apiKey in the response.
export function createApiKey(
  name: string,
  userId: string
): Promise<{ apiKey: ABSApiKey & { apiKey?: string } }> {
  return absRequest<{ apiKey: ABSApiKey & { apiKey?: string } }>(
    '/api/api-keys',
    {
      method: 'POST',
      // isActive defaults to false server-side (!!req.body.isActive) - pass true.
      body: JSON.stringify({ name, userId, isActive: true }),
    }
  )
}

export function deleteApiKey(keyId: string): Promise<void> {
  return absRequest<void>(`/api/api-keys/${keyId}`, { method: 'DELETE' })
}

// --- Backups ---
export function getBackups(): Promise<ABSBackupsResponse> {
  return absRequest<ABSBackupsResponse>('/api/backups')
}

export function runBackup(): Promise<void> {
  return absRequest<void>('/api/backups', { method: 'POST' })
}

// --- Sessions (all users, admin) ---
export function getAllSessions(
  page = 0,
  itemsPerPage = 50
): Promise<ABSListeningSessionsResponse> {
  return absRequest<ABSListeningSessionsResponse>(
    `/api/sessions?page=${page}&itemsPerPage=${itemsPerPage}`
  )
}
