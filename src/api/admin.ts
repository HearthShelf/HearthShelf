import { absRequest } from '@/api/client'
import { useAuthStore } from '@/store/authStore'
import type {
  ABSUsersResponse,
  ABSAdminUser,
  ABSUserPermissions,
  ABSApiKeysResponse,
  ABSApiKey,
  ABSBackupsResponse,
  ABSListeningSessionsResponse,
  ABSServerSettings,
  ABSAuthResponse,
  ABSLibrary,
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

export type ABSUserType = 'admin' | 'user' | 'guest'

// Fields shared by create and edit. permissions is partial - only the toggles we
// expose are sent; ABS keeps its defaults for the rest. librariesAccessible /
// itemTagsSelected live inside permissions in the current ABS model.
export interface UserFormValues {
  username: string
  email?: string | null
  type: ABSUserType
  isActive: boolean
  permissions: Partial<ABSUserPermissions>
}

// Create an ABS user. ABS echoes back the created user on `user`. type defaults
// to 'admin' so the Service Accounts page (machine accounts) keeps working when
// it omits type.
export function createUser(
  opts: Partial<UserFormValues> & {
    username: string
    password: string
    type?: ABSUserType
  },
): Promise<{ user: ABSAdminUser }> {
  return absRequest<{ user: ABSAdminUser }>('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: opts.username,
      password: opts.password,
      email: opts.email || null,
      type: opts.type ?? 'admin',
      isActive: opts.isActive ?? true,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
  })
}

// Update an ABS user. Every field is optional - only what changed is sent. A
// non-empty `password` resets it; omit it to leave the password untouched. ABS
// returns { success, user }. Note: a non-root admin cannot edit a root user (403).
export function updateUser(
  userId: string,
  patch: Partial<UserFormValues> & { password?: string },
): Promise<{ success: boolean; user: ABSAdminUser }> {
  const body: Record<string, unknown> = {}
  if (patch.username !== undefined) body.username = patch.username
  if (patch.email !== undefined) body.email = patch.email || null
  if (patch.type !== undefined) body.type = patch.type
  if (patch.isActive !== undefined) body.isActive = patch.isActive
  if (patch.permissions !== undefined) body.permissions = patch.permissions
  // Only send a password when one was actually entered.
  if (patch.password) body.password = patch.password
  return absRequest<{ success: boolean; user: ABSAdminUser }>(`/api/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function setUserActive(userId: string, isActive: boolean): Promise<void> {
  return absRequest<void>(`/api/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  })
}

export function deleteUser(userId: string): Promise<void> {
  return absRequest<void>(`/api/users/${userId}`, { method: 'DELETE' })
}

// All tag names in the server, for the per-user tag-access picker.
export function getAllTagNames(): Promise<{ tags: string[] }> {
  return absRequest<{ tags: string[] }>('/api/tags')
}

// --- API keys ---
export function getApiKeys(): Promise<ABSApiKeysResponse> {
  return absRequest<ABSApiKeysResponse>('/api/api-keys')
}

// ABS requires the owning userId on create, so an admin can mint a key for any
// user (a non-root admin cannot target a root user - ABS 403s). Returns the new
// key plus its raw token (shown once). The token rides on apiKey.apiKey in the
// response. expiresIn is optional (seconds); omit for a non-expiring key.
export function createApiKey(
  name: string,
  userId: string,
  expiresIn?: number | null,
): Promise<{ apiKey: ABSApiKey & { apiKey?: string } }> {
  return absRequest<{ apiKey: ABSApiKey & { apiKey?: string } }>('/api/api-keys', {
    method: 'POST',
    // isActive defaults to false server-side (!!req.body.isActive) - pass true.
    body: JSON.stringify({
      name,
      userId,
      isActive: true,
      ...(expiresIn ? { expiresIn } : {}),
    }),
  })
}

export function deleteApiKey(keyId: string): Promise<void> {
  return absRequest<void>(`/api/api-keys/${keyId}`, { method: 'DELETE' })
}

// --- Backups (AudiobookShelf's own) ---
export function getBackups(): Promise<ABSBackupsResponse> {
  return absRequest<ABSBackupsResponse>('/api/backups')
}

export function runBackup(): Promise<void> {
  return absRequest<void>('/api/backups', { method: 'POST' })
}

export function deleteBackup(backupId: string): Promise<void> {
  return absRequest<void>(`/api/backups/${backupId}`, { method: 'DELETE' })
}

// ABS's apply route is a GET; the server replaces its database + metadata and
// reconnects (no process restart), so the response is best-effort.
export function applyBackup(backupId: string): Promise<void> {
  return absRequest<void>(`/api/backups/${backupId}/apply`)
}

// A same-origin URL for downloading a backup (used for a plain <a download>).
// The nginx /abs-api proxy forwards it; the bearer rides via the fetch below
// rather than the URL, so we fetch+blob instead of a bare link.
export async function downloadBackupBlob(backupId: string): Promise<Blob> {
  const res = await fetch(`/abs-api/api/backups/${backupId}/download`, {
    headers: authHeader(),
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  return res.blob()
}

// Upload a .audiobookshelf backup. POST /api/backups/upload is multipart; ABS
// reads it off req.files.file. absRequest serializes JSON, so hit the proxy
// directly with FormData.
export async function uploadBackup(file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/abs-api/api/backups/upload', {
    method: 'POST',
    headers: authHeader(),
    body: form,
  })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
}

// The bearer header for direct (non-absRequest) fetches.
function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// --- Sessions (all users, admin) ---
export function getAllSessions(page = 0, itemsPerPage = 50): Promise<ABSListeningSessionsResponse> {
  return absRequest<ABSListeningSessionsResponse>(
    `/api/sessions?page=${page}&itemsPerPage=${itemsPerPage}`,
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
export async function getHearthShelfLogs(): Promise<{ logs: ABSLogEntry[] }> {
  const res = await fetch('/hs/logs', { headers: authHeader() })
  if (!res.ok) throw new Error(`HearthShelf logs failed (${res.status})`)
  return res.json() as Promise<{ logs: ABSLogEntry[] }>
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
  // ms delay between firing notifications (ABS NotificationSettings model)
  notificationDelay: number
}
export function getNotifications(): Promise<{
  settings: ABSNotificationSettings
  data: { events: { name: string }[] }
}> {
  return absRequest('/api/notifications')
}
export function updateNotifications(settings: Partial<ABSNotificationSettings>): Promise<void> {
  return absRequest<void>('/api/notifications', {
    method: 'PATCH',
    body: JSON.stringify(settings),
  })
}
// Toggle a single notification rule on/off. The id rides in both the path and body.
export function updateNotificationRule(id: string, patch: { enabled?: boolean }): Promise<void> {
  return absRequest<void>(`/api/notifications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ id, ...patch }),
  })
}

// --- Email (admin) ---
export interface ABSEreaderDevice {
  name: string
  email: string
}
export interface ABSEmailSettings {
  host: string | null
  port: number | null
  secure: boolean
  rejectUnauthorized: boolean
  user: string | null
  fromAddress: string | null
  testAddress: string | null
  ereaderDevices: ABSEreaderDevice[]
}
export function getEmailSettings(): Promise<{ settings: ABSEmailSettings }> {
  return absRequest('/api/emails/settings')
}
// PATCH accepts a partial of the email settings model. `pass` is write-only on
// the server (never returned by GET), so only send it when the user enters one.
export function updateEmailSettings(
  patch: Partial<ABSEmailSettings> & { pass?: string },
): Promise<{ settings: ABSEmailSettings }> {
  return absRequest('/api/emails/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}
// Sends a test email to settings.testAddress using the saved SMTP config.
export function sendTestEmail(): Promise<void> {
  return absRequest<void>('/api/emails/test', { method: 'POST' })
}
// Replaces the full eReader device list (name + email per device).
export function updateEreaderDevices(
  ereaderDevices: ABSEreaderDevice[],
): Promise<{ ereaderDevices: ABSEreaderDevice[] }> {
  return absRequest('/api/emails/ereader-devices', {
    method: 'POST',
    body: JSON.stringify({ ereaderDevices }),
  })
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
// PATCH iterates over the keys provided and updates each in place, so a partial
// is safe. authOpenIDClientSecret is write-only (never returned by GET).
export function updateAuthSettings(
  patch: Partial<ABSAuthSettings> & { authOpenIDClientSecret?: string },
): Promise<{ authSettings: ABSAuthSettings }> {
  return absRequest('/api/auth-settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// --- Server settings (general: scanner / display) ---
// ABS has no dedicated GET for server settings; /api/authorize returns the full
// serverSettings blob, so we read it from there. PATCH /api/settings persists a
// partial and echoes the updated settings back.
export function getServerSettings(): Promise<ABSServerSettings> {
  return absRequest<ABSAuthResponse>('/api/authorize', { method: 'POST' }).then(
    (r) => r.serverSettings,
  )
}
export function updateServerSettings(
  patch: Partial<ABSServerSettings>,
): Promise<{ serverSettings: ABSServerSettings }> {
  return absRequest('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// --- Libraries (admin CRUD + scan) ---
export interface ABSLibrarySummary {
  id: string
  name: string
  folders: { id: string; fullPath: string }[]
  mediaType: 'book' | 'podcast'
  displayOrder: number
}

// A folder entry in a library update payload. Existing folders keep their id;
// new folders are sent with just fullPath. ABS treats the array as the complete
// desired set - any existing folder absent from it is REMOVED along with all its
// library items (destructive). See LibraryController.update.
export interface LibraryFolderInput {
  id?: string
  fullPath: string
}

// The editable library fields. All optional - only changed keys are sent. ABS
// only persists settings keys it knows about, so passing the full settings blob
// is safe.
export interface LibraryUpdatePayload {
  name?: string
  provider?: string
  icon?: string
  folders?: LibraryFolderInput[]
  settings?: Partial<import('@/api/types').ABSLibrarySettings>
}
// Create a library pointed at a folder. ABS auto-scans a newly created library,
// so the wizard does not need to call scanLibrary after this. Returns the new
// library (its `id` is used to confirm creation).
export function createLibrary(opts: {
  name: string
  mediaType: 'book' | 'podcast'
  fullPath: string
}): Promise<ABSLibrarySummary & { id: string }> {
  return absRequest<ABSLibrarySummary & { id: string }>('/api/libraries', {
    method: 'POST',
    body: JSON.stringify({
      name: opts.name,
      mediaType: opts.mediaType,
      icon: opts.mediaType === 'podcast' ? 'podcast' : 'audiobookshelf',
      folders: [{ fullPath: opts.fullPath }],
    }),
  })
}
// Validate a folder path exists on the server (inside the container). Uses ABS's
// admin filesystem endpoint, which 400s for a missing/non-absolute path and 200s
// when it exists. Returns a tri-state so the caller can distinguish "missing"
// (red) from "couldn't check" (neutral - a transient/permission failure must not
// be shown as "folder doesn't exist"). Admin-gated by ABS.
export async function checkFolderExists(
  fullPath: string,
): Promise<'exists' | 'missing' | 'unknown'> {
  const token = useAuthStore.getState().token
  try {
    const res = await fetch(
      `/abs-api/api/filesystem?path=${encodeURIComponent(fullPath)}&level=0`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    )
    if (res.ok) return 'exists'
    if (res.status === 400) return 'missing'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
export function scanLibrary(libraryId: string, force = false): Promise<void> {
  return absRequest<void>(`/api/libraries/${libraryId}/scan${force ? '?force=1' : ''}`, {
    method: 'POST',
  })
}
export function updateLibrary(libraryId: string, patch: LibraryUpdatePayload): Promise<unknown> {
  return absRequest(`/api/libraries/${libraryId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}
export function deleteLibrary(libraryId: string): Promise<void> {
  return absRequest<void>(`/api/libraries/${libraryId}`, { method: 'DELETE' })
}

// Quick-match every item in a book library against its metadata provider. ABS
// runs this as a fire-and-forget background task (returns 200 immediately) and
// rejects podcast libraries. Admin only.
export function matchAllLibraryItems(libraryId: string): Promise<void> {
  return absRequest<void>(`/api/libraries/${libraryId}/matchall`)
}

// Persist the display order of libraries. ABS wants the full list as
// [{ id, newOrder }]; newOrder is the 0-based position. Admin only.
export function reorderLibraries(
  order: { id: string; newOrder: number }[],
): Promise<{ libraries: ABSLibrary[] }> {
  return absRequest('/api/libraries/order', {
    method: 'POST',
    body: JSON.stringify(order),
  })
}

// Remove on-disk metadata sidecar files across a library. ext 'json' targets the
// legacy metadata.json files, 'abs' the .abs metadata files. Returns how many
// were found/removed. Destructive - confirm before calling. Admin only.
export function removeLibraryMetadata(
  libraryId: string,
  ext: 'json' | 'abs',
): Promise<{ found: number; removed: number }> {
  return absRequest(`/api/libraries/${libraryId}/remove-metadata?ext=${ext}`, {
    method: 'POST',
  })
}

// --- Author / Narrator / Series merge ---
// Authors are first-class records with IDs. Renaming one to match another causes
// ABS to merge them server-side (same-name dedup). We rename each "loser" to the
// canonical name in sequence; ABS collapses them.
export function renameAuthor(
  authorId: string,
  name: string,
): Promise<{ updated: boolean; author: { id: string; name: string } }> {
  return absRequest(`/api/authors/${authorId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

// Update an author's editable fields (name and/or description). ABS auto-merges
// when the new name matches another author in the same library.
export function updateAuthor(
  authorId: string,
  patch: { name?: string; description?: string },
): Promise<{ updated: boolean; author: { id: string; name: string } }> {
  return absRequest(`/api/authors/${authorId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// Remove an author record. ABS strips the author credit from each item's
// metadata but KEEPS the books and their audio files.
export function deleteAuthor(authorId: string): Promise<void> {
  return absRequest(`/api/authors/${authorId}`, { method: 'DELETE' })
}

// Quick-match an author against the metadata provider (Audible) by name. ABS
// downloads and stores the author photo (and bio/asin) server-side, then sets
// imagePath. It only overwrites the image when there was none before, so this is
// safe to fire for authors missing a photo. Returns updated:false when the
// provider had nothing to add.
export function matchAuthor(
  authorId: string,
  name: string,
  region = 'us',
): Promise<{
  updated: boolean
  author: { id: string; name: string; imagePath: string | null }
}> {
  return absRequest(`/api/authors/${authorId}/match`, {
    method: 'POST',
    body: JSON.stringify({ q: name, region }),
  })
}

// Narrators are string fields on items, not first-class records. ABS exposes a
// bulk-rename route that rewrites the narrator string across all items in a library.
export function renameNarrator(
  libraryId: string,
  oldName: string,
  newName: string,
): Promise<{ updated: boolean }> {
  return absRequest(`/api/libraries/${libraryId}/narrators`, {
    method: 'PATCH',
    body: JSON.stringify({ oldName, newName }),
  })
}

// Series are first-class records. PATCH renames; same-name dedup is handled by ABS.
export function renameSeries(
  seriesId: string,
  name: string,
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
