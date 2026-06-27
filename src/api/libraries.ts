import { absRequest } from '@/api/client'
import { useAuthStore } from '@/store/authStore'
import type {
  ABSLibrariesResponse,
  ABSLibraryItemsResponse,
  ABSLibraryItemDetail,
  ABSShelf,
  ABSSeriesResponse,
  ABSSeries,
  ABSSearchResponse,
  ABSCollectionsResponse,
  ABSCollection,
  ABSPlaylistsResponse,
  ABSPlaylist,
  ABSAuthorsResponse,
  ABSAuthorDetail,
  ABSNarratorsResponse,
  ABSPodcastItemsResponse,
  ABSPodcastItem,
  ABSRecentEpisodesResponse,
} from '@/api/types'

export const libraryKeys = {
  all: ['libraries'] as const,
  items: (libraryId: string, page: number) =>
    ['library-items', libraryId, page] as const,
  allItems: (libraryId: string) => ['library-all-items', libraryId] as const,
  item: (itemId: string) => ['library-item', itemId] as const,
  personalized: (libraryId: string) => ['personalized', libraryId] as const,
  series: (libraryId: string) => ['series', libraryId] as const,
  collections: (libraryId: string) => ['collections', libraryId] as const,
  collection: (collectionId: string) => ['collection', collectionId] as const,
  playlists: (libraryId: string) => ['playlists', libraryId] as const,
  authors: (libraryId: string) => ['authors', libraryId] as const,
}

export function getItem(itemId: string): Promise<ABSLibraryItemDetail> {
  return absRequest<ABSLibraryItemDetail>(`/api/items/${itemId}`)
}

// Direct URL to an item's primary ebook file (epub/pdf). epub.js fetches this
// itself, so auth rides as a query token (matching the cover URL pattern) - the
// proxied ABS endpoint accepts ?token= for file serving.
export function ebookUrl(itemId: string, token: string | null): string {
  const params = token ? `?token=${encodeURIComponent(token)}` : ''
  return `/abs-api/api/items/${itemId}/ebook${params}`
}

// Editable subset of an item's metadata. PATCH /api/items/:id/media accepts a
// partial { metadata } payload and returns the updated libraryItem.
export interface ItemMetadataPatch {
  title?: string | null
  subtitle?: string | null
  description?: string | null
  publishedYear?: string | null
  publisher?: string | null
  language?: string | null
  isbn?: string | null
  asin?: string | null
  genres?: string[]
  explicit?: boolean
  abridged?: boolean
}

// A metadata-provider search result (POST applies it via matchItem).
export interface ABSMatchResult {
  title: string
  subtitle: string | null
  author: string | null
  narrator: string | null
  publisher: string | null
  publishedYear: string | null
  description: string | null
  cover: string | null
  asin: string | null
  isbn: string | null
  genres: string[]
  series: { series: string; sequence: string | null }[]
  duration: number | null
}

export interface MetadataProvider {
  text: string
  value: string
}
export function getSearchProviders(): Promise<{
  providers: {
    books: MetadataProvider[]
    booksCovers: MetadataProvider[]
    podcasts: MetadataProvider[]
  }
}> {
  return absRequest('/api/search/providers')
}

export function searchBookMetadata(
  provider: string,
  title: string,
  author = ''
): Promise<ABSMatchResult[]> {
  const p = new URLSearchParams({ provider, title, author })
  return absRequest<ABSMatchResult[]>(`/api/search/books?${p.toString()}`)
}

export function searchCovers(
  provider: string,
  title: string,
  author = ''
): Promise<{ results: string[] }> {
  const p = new URLSearchParams({ provider, title, author })
  return absRequest<{ results: string[] }>(`/api/search/covers?${p.toString()}`)
}

// Apply a provider match to an item (writes selected fields / cover).
export function matchItem(
  itemId: string,
  body: {
    provider: string
    title?: string
    author?: string
    asin?: string | null
    isbn?: string | null
    overrideCover?: boolean
    overrideDetails?: boolean
  }
): Promise<void> {
  return absRequest<void>(`/api/items/${itemId}/match`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// Set the item cover from an external image URL.
export function updateItemCover(itemId: string, url: string): Promise<void> {
  return absRequest<void>(`/api/items/${itemId}/cover`, {
    method: 'PATCH',
    body: JSON.stringify({ url }),
  })
}

// Replace the item's chapter list. Each chapter needs title/start/end (seconds).
export function updateItemChapters(
  itemId: string,
  chapters: { title: string; start: number; end: number }[]
): Promise<void> {
  return absRequest<void>(`/api/items/${itemId}/chapters`, {
    method: 'POST',
    body: JSON.stringify({ chapters }),
  })
}

// --- Item files & tools ---
// ABS serves files with the bearer token as a ?token= query param (anchors
// can't set headers). Same pattern as the ebook URL helper above.
export function itemFileDownloadUrl(itemId: string, fileId: string): string {
  const token = useAuthStore.getState().token
  const params = token ? `?token=${encodeURIComponent(token)}` : ''
  return `/abs-api/api/items/${itemId}/file/${fileId}/download${params}`
}
export function itemDownloadUrl(itemId: string): string {
  const token = useAuthStore.getState().token
  const params = token ? `?token=${encodeURIComponent(token)}` : ''
  return `/abs-api/api/items/${itemId}/download${params}`
}
// Zip-download several items at once. ABS takes a comma-joined ?ids= list.
export function libraryDownloadUrl(libraryId: string, itemIds: string[]): string {
  const token = useAuthStore.getState().token
  const p = new URLSearchParams({ ids: itemIds.join(',') })
  if (token) p.set('token', token)
  return `/abs-api/api/libraries/${libraryId}/download?${p.toString()}`
}
export function deleteLibraryFile(itemId: string, fileId: string): Promise<void> {
  return absRequest<void>(`/api/items/${itemId}/file/${fileId}`, {
    method: 'DELETE',
  })
}
// Reorder a book's audio files. ABS wants the full ordered list of file inos.
export function reorderItemTracks(
  itemId: string,
  orderedInos: string[]
): Promise<void> {
  return absRequest<void>(`/api/items/${itemId}/tracks`, {
    method: 'PATCH',
    body: JSON.stringify({
      orderedFileData: orderedInos.map((ino) => ({ ino })),
    }),
  })
}
// Write the current metadata (and optionally chapters) back into the audio
// files. ABS runs this as a background task. backup=1 keeps the originals.
export function embedItemMetadata(
  itemId: string,
  opts: { forceEmbedChapters?: boolean; backup?: boolean } = {}
): Promise<void> {
  const p = new URLSearchParams()
  if (opts.forceEmbedChapters) p.set('forceEmbedChapters', '1')
  if (opts.backup) p.set('backup', '1')
  const qs = p.toString()
  return absRequest<void>(
    `/api/tools/item/${itemId}/embed-metadata${qs ? '?' + qs : ''}`,
    { method: 'POST' }
  )
}

export function updateItemMetadata(
  itemId: string,
  metadata: ItemMetadataPatch,
  tags?: string[]
): Promise<void> {
  const body: { metadata: ItemMetadataPatch; tags?: string[] } = { metadata }
  if (tags) body.tags = tags
  return absRequest<void>(`/api/items/${itemId}/media`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

// Write the same media payload across many items at once.
export interface BatchMediaPayload {
  metadata?: ItemMetadataPatch
  tags?: string[]
}

export function batchUpdateItems(
  ids: string[],
  mediaPayload: BatchMediaPayload
): Promise<{ success: boolean; updates: number }> {
  return absRequest<{ success: boolean; updates: number }>(
    '/api/items/batch/update',
    {
      method: 'POST',
      body: JSON.stringify(ids.map((id) => ({ id, mediaPayload }))),
    }
  )
}

export function getPersonalized(libraryId: string): Promise<ABSShelf[]> {
  return absRequest<ABSShelf[]>(`/api/libraries/${libraryId}/personalized`)
}

export function getSeries(
  libraryId: string,
  page = 0,
  limit = 100
): Promise<ABSSeriesResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    sort: 'name',
  })
  return absRequest<ABSSeriesResponse>(
    `/api/libraries/${libraryId}/series?${params.toString()}`
  )
}

// ABS doesn't expose a single-series-by-id endpoint cleanly; filter the list.
// The series list includes each series' books, so this is sufficient for v0.1.
export async function getOneSeries(
  libraryId: string,
  seriesId: string
): Promise<ABSSeries | undefined> {
  const res = await getSeries(libraryId, 0, 1000)
  return res.results.find((s) => s.id === seriesId)
}

export function getLibraries(): Promise<ABSLibrariesResponse> {
  return absRequest<ABSLibrariesResponse>('/api/libraries')
}

export function searchLibrary(
  libraryId: string,
  query: string
): Promise<ABSSearchResponse> {
  return absRequest<ABSSearchResponse>(
    `/api/libraries/${libraryId}/search?q=${encodeURIComponent(query)}`
  )
}

export function getCollections(
  libraryId: string
): Promise<ABSCollectionsResponse> {
  return absRequest<ABSCollectionsResponse>(
    `/api/libraries/${libraryId}/collections`
  )
}

export function getCollection(collectionId: string): Promise<ABSCollection> {
  return absRequest<ABSCollection>(`/api/collections/${collectionId}`)
}

export function deleteCollection(collectionId: string): Promise<void> {
  return absRequest<void>(`/api/collections/${collectionId}`, {
    method: 'DELETE',
  })
}

// Rename / edit a collection. ABS accepts name and/or description.
export function updateCollection(
  collectionId: string,
  patch: { name?: string; description?: string }
): Promise<ABSCollection> {
  return absRequest<ABSCollection>(`/api/collections/${collectionId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// Create a collection. ABS requires at least one book id (validated server-side).
export function createCollection(
  libraryId: string,
  name: string,
  books: string[]
): Promise<ABSCollection> {
  return absRequest<ABSCollection>('/api/collections', {
    method: 'POST',
    body: JSON.stringify({ libraryId, name, books }),
  })
}

// Add a book to a collection. The body field is `id` (the libraryItemId).
export function addBookToCollection(
  collectionId: string,
  libraryItemId: string
): Promise<ABSCollection> {
  return absRequest<ABSCollection>(`/api/collections/${collectionId}/book`, {
    method: 'POST',
    body: JSON.stringify({ id: libraryItemId }),
  })
}

// Add many books to a collection at once. ABS wants { books: [libraryItemId] }.
export function addBooksToCollection(
  collectionId: string,
  libraryItemIds: string[]
): Promise<ABSCollection> {
  return absRequest<ABSCollection>(
    `/api/collections/${collectionId}/batch/add`,
    {
      method: 'POST',
      body: JSON.stringify({ books: libraryItemIds }),
    }
  )
}

export function getPlaylists(libraryId: string): Promise<ABSPlaylistsResponse> {
  return absRequest<ABSPlaylistsResponse>(
    `/api/libraries/${libraryId}/playlists`
  )
}

export function getPlaylist(playlistId: string): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}`)
}

// Rename / edit a playlist. ABS accepts name and/or description.
export function updatePlaylist(
  playlistId: string,
  patch: { name?: string; description?: string }
): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function createPlaylist(
  libraryId: string,
  name: string,
  items: { libraryItemId: string; episodeId?: string }[]
): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>('/api/playlists', {
    method: 'POST',
    body: JSON.stringify({ libraryId, name, items }),
  })
}

// --- Podcast episode download queue (admin) ---
export interface ABSEpisodeDownload {
  id: string
  episodeDisplayTitle: string | null
  podcastTitle: string | null
  libraryItemId: string
  libraryId: string | null
  isFinished: boolean
  failed: boolean
  startedAt: number | null
  createdAt: number | null
  finishedAt: number | null
  publishedAt: number | null
}
export interface ABSEpisodeDownloadQueue {
  currentDownload: ABSEpisodeDownload | null
  queue: ABSEpisodeDownload[]
}
export function getEpisodeDownloadQueue(
  libraryId: string
): Promise<ABSEpisodeDownloadQueue> {
  return absRequest<ABSEpisodeDownloadQueue>(
    `/api/libraries/${libraryId}/episode-downloads`
  )
}
// Clear the queued (not yet started) downloads for one podcast item.
export function clearEpisodeDownloadQueue(podcastItemId: string): Promise<void> {
  return absRequest<void>(`/api/podcasts/${podcastItemId}/clear-queue`)
}

// Add many books to a playlist at once. ABS wants { items: [{ libraryItemId }] }.
export function addBooksToPlaylist(
  playlistId: string,
  libraryItemIds: string[]
): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}/batch/add`, {
    method: 'POST',
    body: JSON.stringify({ items: libraryItemIds.map((libraryItemId) => ({ libraryItemId })) }),
  })
}

// --- Batch item actions (all take { libraryItemIds }) ---
export function batchDeleteItems(libraryItemIds: string[]): Promise<void> {
  return absRequest<void>('/api/items/batch/delete', {
    method: 'POST',
    body: JSON.stringify({ libraryItemIds }),
  })
}
export function batchScanItems(libraryItemIds: string[]): Promise<void> {
  return absRequest<void>('/api/items/batch/scan', {
    method: 'POST',
    body: JSON.stringify({ libraryItemIds }),
  })
}
export function batchQuickMatchItems(
  libraryItemIds: string[],
  options: { provider?: string; overrideDetails?: boolean } = {}
): Promise<void> {
  return absRequest<void>('/api/items/batch/quickmatch', {
    method: 'POST',
    body: JSON.stringify({ libraryItemIds, options }),
  })
}

export function addItemToPlaylist(
  playlistId: string,
  libraryItemId: string,
  episodeId?: string
): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}/item`, {
    method: 'POST',
    body: JSON.stringify(episodeId ? { libraryItemId, episodeId } : { libraryItemId }),
  })
}

export function getAuthors(libraryId: string): Promise<ABSAuthorsResponse> {
  return absRequest<ABSAuthorsResponse>(
    `/api/libraries/${libraryId}/authors`
  )
}

export function getAuthor(authorId: string): Promise<ABSAuthorDetail> {
  return absRequest<ABSAuthorDetail>(`/api/authors/${authorId}?include=items`)
}

export function getNarrators(
  libraryId: string
): Promise<ABSNarratorsResponse> {
  return absRequest<ABSNarratorsResponse>(
    `/api/libraries/${libraryId}/narrators`
  )
}

// --- Podcasts (podcast-type libraries) ---

export function getPodcasts(
  libraryId: string
): Promise<ABSPodcastItemsResponse> {
  return absRequest<ABSPodcastItemsResponse>(
    `/api/libraries/${libraryId}/items?limit=0`
  )
}

export function getPodcast(podcastId: string): Promise<ABSPodcastItem> {
  return absRequest<ABSPodcastItem>(`/api/items/${podcastId}`)
}

export function getRecentEpisodes(
  libraryId: string,
  limit = 50
): Promise<ABSRecentEpisodesResponse> {
  return absRequest<ABSRecentEpisodesResponse>(
    `/api/libraries/${libraryId}/recent-episodes?limit=${limit}`
  )
}

// Search the podcast directory (iTunes). Library-independent.
export interface ABSPodcastSearchResult {
  id: number
  title: string
  artistName: string
  description: string | null
  cover: string | null
  feedUrl: string
  pageUrl: string | null
  trackCount: number
  genres: string[]
  explicit: boolean
}
export function searchPodcastDirectory(
  term: string
): Promise<ABSPodcastSearchResult[]> {
  return absRequest<ABSPodcastSearchResult[]>(
    `/api/search/podcast?term=${encodeURIComponent(term)}`
  )
}

export function getLibraryItems(
  libraryId: string,
  page = 0,
  limit = 50
): Promise<ABSLibraryItemsResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  })
  return absRequest<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?${params.toString()}`
  )
}

// Fetch the entire library in one request (ABS treats limit=0 as "no limit").
// The Library page filters/sorts/derives client-side over the full set.
export function getAllLibraryItems(
  libraryId: string
): Promise<ABSLibraryItemsResponse> {
  return absRequest<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?limit=0`
  )
}
