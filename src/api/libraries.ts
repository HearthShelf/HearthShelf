import { absRequest } from '@/api/client'
import type {
  ABSLibrariesResponse,
  ABSLibraryItemsResponse,
} from '@/api/types'

export const libraryKeys = {
  all: ['libraries'] as const,
  items: (libraryId: string, page: number) =>
    ['library-items', libraryId, page] as const,
}

export function getLibraries(): Promise<ABSLibrariesResponse> {
  return absRequest<ABSLibrariesResponse>('/api/libraries')
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
