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

// --- Server / library stats ---
export interface ABSServerStatsBucket {
  numItems: number
  numAudioFiles: number
  totalSize: number
}
export interface ABSServerStats {
  books: ABSServerStatsBucket
  podcasts: ABSServerStatsBucket
  total: ABSServerStatsBucket
}
export function getServerStats(): Promise<ABSServerStats> {
  return absRequest<ABSServerStats>('/api/stats/server')
}

export interface ABSLibraryStats {
  totalItems: number
  totalAuthors: number
  totalGenres: number
  totalSize: number
  totalDuration: number
  numAudioTracks: number
  largestItems: { id: string; title: string; size: number }[]
  longestItems: { id: string; title: string; duration: number }[]
}
export function getLibraryStats(libraryId: string): Promise<ABSLibraryStats> {
  return absRequest<ABSLibraryStats>(`/api/libraries/${libraryId}/stats`)
}

// --- Logs ---
export interface ABSLogEntry {
  timestamp: string
  source: string
  message: string
  level?: number
}
export function getLoggerData(): Promise<{ currentDailyLogs: ABSLogEntry[] }> {
  return absRequest<{ currentDailyLogs: ABSLogEntry[] }>('/api/logger-data')
}

// --- Genres / tags (metadata utils) ---
export function getAllTags(): Promise<{ tags: string[] }> {
  return absRequest<{ tags: string[] }>('/api/tags')
}
export function getAllGenres(): Promise<{ genres: string[] }> {
  return absRequest<{ genres: string[] }>('/api/genres')
}
export function renameTag(tag: string, newTag: string): Promise<void> {
  return absRequest<void>('/api/tags/rename', {
    method: 'POST',
    body: JSON.stringify({ tag, newTag }),
  })
}
// ABS decodes the path param as base64 (Buffer.from(decoded, 'base64')), so the
// tag/genre name must be base64-encoded then URL-encoded.
function b64Param(value: string): string {
  return encodeURIComponent(btoa(unescape(encodeURIComponent(value))))
}
export function deleteTag(tag: string): Promise<void> {
  return absRequest<void>(`/api/tags/${b64Param(tag)}`, { method: 'DELETE' })
}
export function renameGenre(genre: string, newGenre: string): Promise<void> {
  return absRequest<void>('/api/genres/rename', {
    method: 'POST',
    body: JSON.stringify({ genre, newGenre }),
  })
}
export function deleteGenre(genre: string): Promise<void> {
  return absRequest<void>(`/api/genres/${b64Param(genre)}`, { method: 'DELETE' })
}

// --- Notifications (admin) ---
export interface ABSNotificationSettings {
  appriseType: string | null
  appriseApiUrl: string | null
  notifications: { id: string; eventName: string; enabled: boolean }[]
  maxFailedAttempts: number
  notificationDelay: number
}
export function getNotifications(): Promise<{
  settings: ABSNotificationSettings
  data: { events: { name: string }[] }
}> {
  return absRequest('/api/notifications')
}
export function updateNotifications(
  settings: Partial<ABSNotificationSettings>
): Promise<void> {
  return absRequest<void>('/api/notifications', {
    method: 'PATCH',
    body: JSON.stringify(settings),
  })
}

// --- Email (admin) ---
export interface ABSEmailSettings {
  host: string | null
  port: number | null
  secure: boolean
  user: string | null
  fromAddress: string | null
  ereaderDevices: { name: string; email: string }[]
}
export function getEmailSettings(): Promise<{ settings: ABSEmailSettings }> {
  return absRequest('/api/emails/settings')
}

// --- RSS feeds (admin) ---
export interface ABSRssFeed {
  id: string
  entityType: string
  entityId: string
  feedUrl: string
  meta?: { title?: string }
}
export function getRssFeeds(): Promise<{ feeds: ABSRssFeed[] }> {
  return absRequest('/api/feeds')
}
export function closeRssFeed(feedId: string): Promise<void> {
  return absRequest<void>(`/api/feeds/${feedId}/close`, { method: 'POST' })
}

// --- Auth settings (admin) ---
export interface ABSAuthSettings {
  authActiveAuthMethods: string[]
  authLoginCustomMessage: string | null
  authOpenIDIssuerURL: string | null
  authOpenIDClientID: string | null
  authOpenIDButtonText: string | null
  authOpenIDAutoLaunch: boolean
  authOpenIDAutoRegister: boolean
}
export function getAuthSettings(): Promise<ABSAuthSettings> {
  return absRequest('/api/auth-settings')
}

// --- Author / Narrator / Series merge ---
// Authors are first-class records with IDs. Renaming one to match another causes
// ABS to merge them server-side (same-name dedup). We rename each "loser" to the
// canonical name in sequence; ABS collapses them.
export function renameAuthor(
  authorId: string,
  name: string
): Promise<{ updated: boolean; author: { id: string; name: string } }> {
  return absRequest(`/api/authors/${authorId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

// Narrators are string fields on items, not first-class records. ABS exposes a
// bulk-rename route that rewrites the narrator string across all items in a library.
export function renameNarrator(
  libraryId: string,
  oldName: string,
  newName: string
): Promise<{ updated: boolean }> {
  return absRequest(`/api/libraries/${libraryId}/narrators`, {
    method: 'PATCH',
    body: JSON.stringify({ oldName, newName }),
  })
}

// Series are first-class records. PATCH renames; same-name dedup is handled by ABS.
export function renameSeries(
  seriesId: string,
  name: string
): Promise<{ id: string; name: string }> {
  return absRequest(`/api/series/${seriesId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

// --- Custom metadata providers (integrations) ---
export interface ABSCustomProvider {
  id: string
  name: string
  url: string
}
export function getCustomProviders(): Promise<{
  providers: ABSCustomProvider[]
}> {
  return absRequest('/api/custom-metadata-providers')
}
