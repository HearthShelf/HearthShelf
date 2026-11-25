import {
  ABS_ENDPOINTS,
  normalizeSeriesPatch,
  normalizeAuthorsPatch,
  findDuplicateItems,
  hideDuplicateItems,
  type ABSItemMetadataPatch,
  type ABSItemSeriesPatch,
  type ABSItemAuthorPatch,
} from '@hearthshelf/core'
import { absRequest } from '@/api/client'
import { useAuthStore } from '@/store/authStore'
import { getDuplicateIndex, useDuplicatesStore } from '@/store/duplicatesStore'
import type {
  ABSLibrariesResponse,
  ABSLibraryItemsResponse,
  ABSLibraryItem,
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
  items: (libraryId: string, page: number) => ['library-items', libraryId, page] as const,
  allItems: (libraryId: string) => ['library-all-items', libraryId] as const,
  item: (itemId: string) => ['library-item', itemId] as const,
  personalized: (libraryId: string) => ['personalized', libraryId] as const,
  series: (libraryId: string) => ['series', libraryId] as const,
  collections: (libraryId: string) => ['collections', libraryId] as const,
  collection: (collectionId: string) => ['collection', collectionId] as const,
  playlists: (libraryId: string) => ['playlists', libraryId] as const,
  authors: (libraryId: string) => ['authors', libraryId] as const,
  filterData: (libraryId: string) => ['library-filterdata', libraryId] as const,
}

// The library's existing values for each metadata field, used to suggest
// autocompletions in the edit forms so a user picks the established spelling
// rather than creating a near-duplicate author/series/genre. ABS caches this
// server-side for 30 minutes.
export interface ABSLibraryFilterData {
  authors: { id: string; name: string }[]
  series: { id: string; name: string }[]
  genres: string[]
  tags: string[]
  narrators: string[]
  languages: string[]
  publishers: string[]
}

export function getLibraryFilterData(libraryId: string): Promise<ABSLibraryFilterData> {
  return absRequest<ABSLibraryFilterData>(ABS_ENDPOINTS.libraryFilterData(libraryId))
}

export function getItem(itemId: string): Promise<ABSLibraryItemDetail> {
  return absRequest<ABSLibraryItemDetail>(`/api/items/${itemId}`)
}

// Direct URL to an item's primary ebook file (epub/pdf). epub.js fetches this
// itself, so auth rides as a query token (matching the cover URL pattern) - the
// proxied ABS endpoint accepts ?token= for file serving.
export function ebookUrl(itemId: string, token: string | null): string {
  const params = token ? `?token=${encodeURIComponent(token)}` : ''
  return `/abs-api${ABS_ENDPOINTS.itemEbook(itemId)}${params}`
}

// The editable-metadata payload and its guards live in @hearthshelf/core so
// every surface sends ABS the same well-formed body. See core's
// lib/itemMetadata.ts for why the normalizers exist (ABS fails silently).
export type ItemSeriesPatch = ABSItemSeriesPatch
export type ItemAuthorPatch = ABSItemAuthorPatch
export type ItemMetadataPatch = ABSItemMetadataPatch

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
  author = '',
): Promise<ABSMatchResult[]> {
  const p = new URLSearchParams({ provider, title, author })
  return absRequest<ABSMatchResult[]>(`/api/search/books?${p.toString()}`)
}

export function searchCovers(
  provider: string,
  title: string,
  author = '',
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
  },
): Promise<void> {
  return absRequest<void>(`/api/items/${itemId}/match`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// Set the item cover from an external image URL. POST (upload) is the route that
// downloads a url; PATCH only accepts a file path already in the book's folder
// and answers 400 "no cover path" for a url.
export function updateItemCover(itemId: string, url: string): Promise<void> {
  return absRequest<void>(`/api/items/${itemId}/cover`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

// Replace the item's chapter list. Each chapter needs title/start/end (seconds).
export function updateItemChapters(
  itemId: string,
  chapters: { title: string; start: number; end: number }[],
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
// Remove a book from the library. ABS keeps the files on disk unless hard is set
// (DELETE /api/items/:id?hard=1). Needs the ABS "can delete" permission.
export function removeLibraryItem(itemId: string, deleteFiles: boolean): Promise<void> {
  return absRequest<void>(`/api/items/${itemId}${deleteFiles ? '?hard=1' : ''}`, {
    method: 'DELETE',
  })
}
// Reorder a book's audio files. ABS wants the full ordered list of file inos.
export function reorderItemTracks(itemId: string, orderedInos: string[]): Promise<void> {
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
  opts: { forceEmbedChapters?: boolean; backup?: boolean } = {},
): Promise<void> {
  const p = new URLSearchParams()
  if (opts.forceEmbedChapters) p.set('forceEmbedChapters', '1')
  if (opts.backup) p.set('backup', '1')
  const qs = p.toString()
  return absRequest<void>(`/api/tools/item/${itemId}/embed-metadata${qs ? '?' + qs : ''}`, {
    method: 'POST',
  })
}

export function updateItemMetadata(
  itemId: string,
  metadata: ItemMetadataPatch,
  tags?: string[],
): Promise<void> {
  const clean: ItemMetadataPatch = { ...metadata }
  if (clean.series) clean.series = normalizeSeriesPatch(clean.series)
  if (clean.authors) clean.authors = normalizeAuthorsPatch(clean.authors)
  const body: { metadata: ItemMetadataPatch; tags?: string[] } = { metadata: clean }
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
  mediaPayload: BatchMediaPayload,
): Promise<{ success: boolean; updates: number }> {
  return absRequest<{ success: boolean; updates: number }>('/api/items/batch/update', {
    method: 'POST',
    body: JSON.stringify(ids.map((id) => ({ id, mediaPayload }))),
  })
}

// A book ABS recorded twice for one folder shows as one tile everywhere: every
// list below drops a duplicate whose keeper is in the same list (core
// hideDuplicateItems, using the index the full library list builds plus the
// list's own paths). Opening a duplicate resolves to its keeper separately.
export function dedupeItems<T extends { id: string }>(items: T[]): T[] {
  return hideDuplicateItems(items, getDuplicateIndex())
}

function dedupeSeries(series: ABSSeries): ABSSeries {
  return { ...series, books: dedupeItems(series.books ?? []) }
}

export async function getPersonalized(libraryId: string): Promise<ABSShelf[]> {
  const shelves = await absRequest<ABSShelf[]>(`/api/libraries/${libraryId}/personalized`)
  return shelves.map((shelf) => {
    if (shelf.type === 'book') return { ...shelf, entities: dedupeItems(shelf.entities) }
    if (shelf.type === 'series') return { ...shelf, entities: shelf.entities.map(dedupeSeries) }
    return shelf
  })
}

export async function getSeries(
  libraryId: string,
  page = 0,
  limit = 100,
): Promise<ABSSeriesResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    sort: 'name',
  })
  const res = await absRequest<ABSSeriesResponse>(
    `/api/libraries/${libraryId}/series?${params.toString()}`,
  )
  return { ...res, results: res.results.map(dedupeSeries) }
}

// ABS doesn't expose a single-series-by-id endpoint cleanly; filter the list.
// The series list includes each series' books, so this is sufficient for v0.1.
export async function getOneSeries(
  libraryId: string,
  seriesId: string,
): Promise<ABSSeries | undefined> {
  const res = await getSeries(libraryId, 0, 1000)
  return res.results.find((s) => s.id === seriesId)
}

export function getLibraries(): Promise<ABSLibrariesResponse> {
  return absRequest<ABSLibrariesResponse>('/api/libraries')
}

export async function searchLibrary(libraryId: string, query: string): Promise<ABSSearchResponse> {
  const res = await absRequest<ABSSearchResponse>(
    `/api/libraries/${libraryId}/search?q=${encodeURIComponent(query)}`,
  )
  const keep = new Set(dedupeItems((res.book ?? []).map((b) => b.libraryItem)).map((i) => i.id))
  return { ...res, book: (res.book ?? []).filter((b) => keep.has(b.libraryItem.id)) }
}

/**
 * Find the owned library item for an Audible ASIN, or null when it isn't in the
 * library. ABS has no by-ASIN endpoint and the minified list metadata omits
 * `asin`, so this searches (ABS does index the ASIN) and then CONFIRMS against
 * the item detail - a bare ASIN can substring-match a description, and opening
 * the wrong book is worse than not resolving one. Best-effort: every failure
 * returns null so callers can fall back.
 */
export async function findOwnedItemByAsin(asin: string): Promise<string | null> {
  const wanted = asin.trim().toLowerCase()
  if (!wanted) return null
  try {
    const { libraries } = await getLibraries()
    for (const library of libraries) {
      const hits = await searchLibrary(library.id, asin)
      for (const hit of (hits.book ?? []).slice(0, 5)) {
        try {
          const detail = await getItem(hit.libraryItem.id)
          if ((detail.media?.metadata?.asin ?? '').trim().toLowerCase() === wanted) {
            return hit.libraryItem.id
          }
        } catch {
          // Unreadable item - try the next hit.
        }
      }
    }
  } catch {
    // Offline or refused - caller falls back to the upcoming page.
  }
  return null
}

export function getCollections(libraryId: string): Promise<ABSCollectionsResponse> {
  return absRequest<ABSCollectionsResponse>(`/api/libraries/${libraryId}/collections`)
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
  patch: { name?: string; description?: string },
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
  books: string[],
): Promise<ABSCollection> {
  return absRequest<ABSCollection>('/api/collections', {
    method: 'POST',
    body: JSON.stringify({ libraryId, name, books }),
  })
}

// Add a book to a collection. The body field is `id` (the libraryItemId).
export function addBookToCollection(
  collectionId: string,
  libraryItemId: string,
): Promise<ABSCollection> {
  return absRequest<ABSCollection>(`/api/collections/${collectionId}/book`, {
    method: 'POST',
    body: JSON.stringify({ id: libraryItemId }),
  })
}

// Add many books to a collection at once. ABS wants { books: [libraryItemId] }.
export function addBooksToCollection(
  collectionId: string,
  libraryItemIds: string[],
): Promise<ABSCollection> {
  return absRequest<ABSCollection>(`/api/collections/${collectionId}/batch/add`, {
    method: 'POST',
    body: JSON.stringify({ books: libraryItemIds }),
  })
}

export function getPlaylists(libraryId: string): Promise<ABSPlaylistsResponse> {
  return absRequest<ABSPlaylistsResponse>(`/api/libraries/${libraryId}/playlists`)
}

export function getPlaylist(playlistId: string): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}`)
}

// Rename / edit a playlist. ABS accepts name and/or description.
export function updatePlaylist(
  playlistId: string,
  patch: { name?: string; description?: string },
): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function createPlaylist(
  libraryId: string,
  name: string,
  items: { libraryItemId: string; episodeId?: string }[],
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
export function getEpisodeDownloadQueue(libraryId: string): Promise<ABSEpisodeDownloadQueue> {
  return absRequest<ABSEpisodeDownloadQueue>(`/api/libraries/${libraryId}/episode-downloads`)
}
// Clear the queued (not yet started) downloads for one podcast item.
export function clearEpisodeDownloadQueue(podcastItemId: string): Promise<void> {
  return absRequest<void>(`/api/podcasts/${podcastItemId}/clear-queue`)
}

// Add many books to a playlist at once. ABS wants { items: [{ libraryItemId }] }.
export function addBooksToPlaylist(
  playlistId: string,
  libraryItemIds: string[],
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
  options: { provider?: string; overrideDetails?: boolean } = {},
): Promise<void> {
  return absRequest<void>('/api/items/batch/quickmatch', {
    method: 'POST',
    body: JSON.stringify({ libraryItemIds, options }),
  })
}

export function addItemToPlaylist(
  playlistId: string,
  libraryItemId: string,
  episodeId?: string,
): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}/item`, {
    method: 'POST',
    body: JSON.stringify(episodeId ? { libraryItemId, episodeId } : { libraryItemId }),
  })
}

export function getAuthors(libraryId: string): Promise<ABSAuthorsResponse> {
  return absRequest<ABSAuthorsResponse>(`/api/libraries/${libraryId}/authors`)
}

export async function getAuthor(authorId: string): Promise<ABSAuthorDetail> {
  const author = await absRequest<ABSAuthorDetail>(`/api/authors/${authorId}?include=items`)
  return { ...author, libraryItems: dedupeItems(author.libraryItems ?? []) }
}

export function getNarrators(libraryId: string): Promise<ABSNarratorsResponse> {
  return absRequest<ABSNarratorsResponse>(`/api/libraries/${libraryId}/narrators`)
}

// --- Podcasts (podcast-type libraries) ---

export function getPodcasts(libraryId: string): Promise<ABSPodcastItemsResponse> {
  return absRequest<ABSPodcastItemsResponse>(`/api/libraries/${libraryId}/items?limit=0`)
}

export function getPodcast(podcastId: string): Promise<ABSPodcastItem> {
  return absRequest<ABSPodcastItem>(`/api/items/${podcastId}`)
}

export function getRecentEpisodes(
  libraryId: string,
  limit = 50,
): Promise<ABSRecentEpisodesResponse> {
  return absRequest<ABSRecentEpisodesResponse>(
    `/api/libraries/${libraryId}/recent-episodes?limit=${limit}`,
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
export function searchPodcastDirectory(term: string): Promise<ABSPodcastSearchResult[]> {
  return absRequest<ABSPodcastSearchResult[]>(
    `/api/search/podcast?term=${encodeURIComponent(term)}`,
  )
}

export function getLibraryItems(
  libraryId: string,
  page = 0,
  limit = 50,
): Promise<ABSLibraryItemsResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  })
  return absRequest<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?${params.toString()}`,
  )
}

// Fetch the entire library in one request (ABS treats limit=0 as "no limit").
// The Library page filters/sorts/derives client-side over the full set.
//
// The full list includes missing/invalid items, so it is where duplicate
// entries (one folder ABS recorded twice) are found: the groups go to the
// duplicates store (admin cleanup, keeper resolution, progress carry-over) and
// the list comes back with each book once.
export async function getAllLibraryItems(libraryId: string): Promise<ABSLibraryItemsResponse> {
  const res = await getRawLibraryItems(libraryId)
  const results = dedupeItems(res.results)
  return { ...res, results, total: Math.max(0, res.total - (res.results.length - results.length)) }
}

// The full list as ABS returns it, duplicates included. Records this library's
// duplicate groups as a side effect.
export async function getRawLibraryItems(libraryId: string): Promise<ABSLibraryItemsResponse> {
  const res = await absRequest<ABSLibraryItemsResponse>(`/api/libraries/${libraryId}/items?limit=0`)
  recordDuplicates(libraryId, res.results)
  return res
}

function recordDuplicates(libraryId: string, items: ABSLibraryItem[]): void {
  const groups = findDuplicateItems(items.filter((item) => item.libraryId === libraryId))
  useDuplicatesStore.getState().setLibraryGroups(libraryId, groups)
}
