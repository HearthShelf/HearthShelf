// Single source of truth for AudiobookShelf (ABS) API response shapes.
// Verified against ABS 2.35.1 by direct observation - do not guess fields.
// Only the subset of fields used in v0.1 is typed; ABS returns more.

// --- Auth ---

export interface ABSUser {
  id: string
  username: string
  email: string | null
  type: string
  token: string
  isActive: boolean
  isLocked: boolean
  createdAt: number
  librariesAccessible: string[]
  hasOpenIDLink: boolean
}

// /login and /api/authorize return the same envelope.
export interface ABSAuthResponse {
  user: ABSUser
  userDefaultLibraryId: string
  serverSettings: ABSServerSettings
  Source: string
}

export interface ABSServerSettings {
  id: string
  version: string
  language: string
  authActiveAuthMethods: string[]
  authOpenIDButtonText: string
  authLoginCustomMessage: string | null
}

// /status (unauthenticated) - used to discover available auth methods.
export interface ABSStatusResponse {
  app: string
  serverVersion: string
  isInit: boolean
  language: string
  authMethods: string[]
  authFormData: {
    authLoginCustomMessage: string
    authOpenIDButtonText: string
    authOpenIDAutoLaunch: boolean
  }
}

// --- Libraries ---

export interface ABSLibrary {
  id: string
  name: string
  icon: string
  mediaType: string
  displayOrder: number
  createdAt: number
  lastUpdate: number
}

export interface ABSLibrariesResponse {
  libraries: ABSLibrary[]
}

// --- Library items ---

export interface ABSBookMetadata {
  title: string | null
  titleIgnorePrefix: string
  subtitle: string | null
  authorName: string
  narratorName: string
  seriesName: string
  publishedYear: string | null
  description: string | null
  genres: string[]
  language: string | null
  explicit: boolean
}

export interface ABSBookMedia {
  id: string
  metadata: ABSBookMetadata
  coverPath: string | null
  tags: string[]
  numTracks: number
  numAudioFiles: number
  numChapters: number
  duration: number
  size: number
}

export interface ABSLibraryItem {
  id: string
  libraryId: string
  folderId: string
  path: string
  mediaType: string
  media: ABSBookMedia
  addedAt: number
  updatedAt: number
  isMissing: boolean
  isInvalid: boolean
}

// /api/libraries/:id/items - paginated.
export interface ABSLibraryItemsResponse {
  results: ABSLibraryItem[]
  total: number
  limit: number
  page: number
  sortDesc: boolean
  mediaType: string
  minified: boolean
}

// --- Single item detail (/api/items/:id) ---

export interface ABSChapter {
  id: number
  start: number
  end: number
  title: string
}

export interface ABSAuthor {
  id: string
  name: string
}

// /api/libraries/:id/authors - library author list.
export interface ABSLibraryAuthor {
  id: string
  name: string
  description: string | null
  imagePath: string | null
  numBooks: number
  addedAt: number
}

export interface ABSAuthorsResponse {
  authors: ABSLibraryAuthor[]
}

export interface ABSNarrator {
  id: string
  name: string
  numBooks: number
}

export interface ABSNarratorsResponse {
  narrators: ABSNarrator[]
}

// /api/authors/:id?include=items - author detail with books.
export interface ABSAuthorDetail extends ABSLibraryAuthor {
  asin: string | null
  libraryItems: ABSLibraryItem[]
}

export interface ABSAudioFileMetadata {
  filename: string
  ext: string
  size: number
}

export interface ABSAudioFile {
  index: number
  ino: string
  duration: number
  codec?: string
  bitRate?: number
  metadata: ABSAudioFileMetadata
}

export interface ABSSeriesRef {
  id: string
  name: string
  sequence: string | null
}

// The detail endpoint (/api/items/:id) is NOT minified, and differs from the
// items list: it omits the flattened authorName, media.duration, and
// media.numChapters, instead exposing metadata.authors[], media.audioFiles[],
// and media.chapters[]. Derive the flattened values from these.
export interface ABSBookMetadataDetail extends ABSBookMetadata {
  authors: ABSAuthor[]
  narrators: string[]
  series: ABSSeriesRef[]
  isbn: string | null
  asin: string | null
  publisher: string | null
  rating?: number | null
}

export interface ABSBookMediaDetail
  extends Omit<ABSBookMedia, 'metadata' | 'duration' | 'numChapters'> {
  metadata: ABSBookMetadataDetail
  audioFiles: ABSAudioFile[]
  chapters: ABSChapter[]
}

export interface ABSLibraryItemDetail extends Omit<ABSLibraryItem, 'media'> {
  media: ABSBookMediaDetail
}

// --- Progress (/api/me/items-in-progress) ---

export interface ABSItemsInProgressResponse {
  libraryItems: ABSLibraryItem[]
}

// --- Podcasts (podcast-type libraries) ---
// Shapes per podcasts.md / ABS 2.35.1. Several fields are @needs-verify against a
// live podcast library; this ABS instance has only book libraries.

export interface ABSPodcastEpisode {
  id: string
  title: string
  description: string | null
  publishedAt: number | null
  duration: number | null
  audioFile?: { ino: string } | null
}

export interface ABSPodcastMetadata {
  title: string | null
  author: string | null
  description: string | null
  feedUrl: string | null
  genres: string[]
}

export interface ABSPodcastMedia {
  metadata: ABSPodcastMetadata
  episodes: ABSPodcastEpisode[]
  autoDownloadEpisodes?: boolean
  numEpisodes?: number
}

export interface ABSPodcastItem {
  id: string
  libraryId: string
  media: ABSPodcastMedia
}

export interface ABSPodcastItemsResponse {
  results: ABSPodcastItem[]
  total: number
}

// A recent episode carries its parent podcast's identity for the flat feed.
export interface ABSRecentEpisode extends ABSPodcastEpisode {
  libraryItemId: string
  podcast?: { title: string | null }
}

export interface ABSRecentEpisodesResponse {
  episodes: ABSRecentEpisode[]
}

// --- Admin / config (admin-only) ---

export interface ABSAdminUser {
  id: string
  username: string
  email: string | null
  type: string
  isActive: boolean
  isLocked: boolean
  lastSeen: number | null
  createdAt: number
  permissions?: Record<string, boolean>
  librariesAccessible?: string[]
}

export interface ABSUsersResponse {
  users: ABSAdminUser[]
}

export interface ABSApiKey {
  id: string
  name: string
  description: string | null
  expiresAt: number | null
  lastUsedAt: number | null
  isActive: boolean
  createdAt: string
  userId: string
}

export interface ABSApiKeysResponse {
  apiKeys: ABSApiKey[]
}

export interface ABSBackup {
  id: string
  datePretty: string
  filename: string
  fileSize: number
  createdAt: number
  serverVersion: string
}

export interface ABSBackupsResponse {
  backups: ABSBackup[]
  backupLocation: string
}

// --- Collections (/api/libraries/:id/collections) ---

export interface ABSCollection {
  id: string
  libraryId: string
  name: string
  description: string | null
  books: ABSLibraryItem[]
}

export interface ABSCollectionsResponse {
  results: ABSCollection[]
  total: number
}

// --- Playlists (/api/libraries/:id/playlists) ---

export interface ABSPlaylistItem {
  libraryItemId: string
  episodeId: string | null
  libraryItem: ABSLibraryItem
}

export interface ABSPlaylist {
  id: string
  libraryId: string
  userId: string
  name: string
  description: string | null
  items: ABSPlaylistItem[]
}

export interface ABSPlaylistsResponse {
  results: ABSPlaylist[]
  total: number
}

// --- Series (/api/libraries/:id/series) ---

export interface ABSSeries {
  id: string
  name: string
  nameIgnorePrefix: string
  description: string | null
  books: ABSLibraryItem[]
}

export interface ABSSeriesResponse {
  results: ABSSeries[]
  total: number
  limit: number
  page: number
}

// --- Search (/api/libraries/:id/search) ---

export interface ABSSearchAuthor {
  id: string
  name: string
  numBooks: number
}

export interface ABSSearchNarrator {
  name: string
  numBooks: number
}

export interface ABSSearchSeriesResult {
  series: { id: string; name: string }
  books: ABSLibraryItem[]
}

export interface ABSSearchResponse {
  book: { libraryItem: ABSLibraryItem }[]
  series: ABSSearchSeriesResult[]
  authors: ABSSearchAuthor[]
  narrators: ABSSearchNarrator[]
}

// --- Personalized home shelves (/api/libraries/:id/personalized) ---
// A discriminated union by shelf type; v0.1 renders only book + series shelves.

interface ABSShelfBase {
  id: string
  label: string
}
export interface ABSBookShelf extends ABSShelfBase {
  type: 'book'
  entities: ABSLibraryItem[]
}
export interface ABSSeriesShelf extends ABSShelfBase {
  type: 'series'
  entities: ABSSeries[]
}
export interface ABSOtherShelf extends ABSShelfBase {
  type: 'authors' | 'podcast' | 'episode'
  entities: unknown[]
}
export type ABSShelf = ABSBookShelf | ABSSeriesShelf | ABSOtherShelf

// --- Playback session (POST /api/items/:id/play) ---

export interface ABSAudioTrack {
  index: number
  // Server-relative path, e.g. /api/items/:id/file/:ino - prefix with /abs-api
  // and append ?token=... to load it natively in <audio>.
  contentUrl: string
  mimeType: string
  duration: number
  // Seconds into the whole book where this track begins (multi-file books).
  startOffset: number
}

export interface ABSPlaybackSession {
  id: string
  libraryItemId: string
  displayTitle: string
  displayAuthor: string | null
  coverPath: string | null
  duration: number
  currentTime: number
  chapters: ABSChapter[]
  audioTracks: ABSAudioTrack[]
}

// Entry in user.mediaProgress[] - drives tile progress bars + resume.
export interface ABSMediaProgress {
  libraryItemId: string
  duration: number
  progress: number
  currentTime: number
  isFinished: boolean
}

export interface ABSBookmark {
  libraryItemId: string
  title: string
  time: number
  createdAt: number
}

// --- Listening sessions (/api/me/listening-sessions) ---

export interface ABSDeviceInfo {
  browserName?: string
  osName?: string
  deviceName?: string
  clientName?: string
}

export interface ABSListeningSession {
  id: string
  libraryItemId: string
  displayTitle: string
  displayAuthor: string
  duration: number
  timeListening: number
  startTime: number
  currentTime: number
  startedAt: number
  updatedAt: number
  dayOfWeek: string
  deviceInfo?: ABSDeviceInfo
}

export interface ABSListeningSessionsResponse {
  total: number
  numPages: number
  page: number
  itemsPerPage: number
  sessions: ABSListeningSession[]
}

// --- Listening stats (/api/me/listening-stats) ---

export interface ABSStatsItem {
  id: string
  mediaMetadata: ABSBookMetadataDetail
  timeListening: number
}

export interface ABSListeningStats {
  totalTime: number
  items: Record<string, ABSStatsItem>
  days: Record<string, number>
  dayOfWeek: Record<string, number>
  today: number
}
