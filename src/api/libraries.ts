import { absRequest } from '@/api/client'
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

export function getPlaylists(libraryId: string): Promise<ABSPlaylistsResponse> {
  return absRequest<ABSPlaylistsResponse>(
    `/api/libraries/${libraryId}/playlists`
  )
}

export function getPlaylist(playlistId: string): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}`)
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
