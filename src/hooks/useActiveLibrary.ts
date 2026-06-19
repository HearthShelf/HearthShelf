import { create } from 'zustand'
import { useQuery } from '@tanstack/react-query'
import { getLibraries, getLibraryItems, libraryKeys } from '@/api/libraries'
import { useAuthStore } from '@/store/authStore'
import type { ABSLibrary } from '@/api/types'

// User-selected library override (set by the AppBar LibrarySwitcher). Null until
// the user explicitly switches; resolution falls back to the route param, then
// the account default, then the first library.
interface ActiveLibraryStore {
  selectedId: string | null
  select: (id: string) => void
}
const useActiveLibraryStore = create<ActiveLibraryStore>((set) => ({
  selectedId: null,
  select: (id) => set({ selectedId: id }),
}))

// ABS library mediaType -> a Material Symbol. ABS ships its own icon names
// (e.g. "audiobookshelf") that aren't Material Symbols, so map by mediaType.
export function libraryIcon(library: Pick<ABSLibrary, 'mediaType'>): string {
  return library.mediaType === 'podcast' ? 'podcasts' : 'menu_book'
}

export interface ActiveLibrary {
  libraries: ABSLibrary[]
  active: ABSLibrary | null
  activeId: string | null
  itemCount: number | null
  select: (id: string) => void
}

// Single source of truth for the active library across the shell. `routeId` is
// the optional :libraryId route param, which wins for deep-links; otherwise the
// switcher selection, then the account default, then the first library.
export function useActiveLibrary(routeId?: string): ActiveLibrary {
  const defaultLibraryId = useAuthStore((s) => s.defaultLibraryId)
  const selectedId = useActiveLibraryStore((s) => s.selectedId)
  const select = useActiveLibraryStore((s) => s.select)

  const { data } = useQuery({
    queryKey: libraryKeys.all,
    queryFn: getLibraries,
    staleTime: 5 * 60 * 1000,
  })
  const libraries = data?.libraries ?? []

  const activeId =
    routeId ??
    selectedId ??
    defaultLibraryId ??
    libraries[0]?.id ??
    null
  const active = libraries.find((l) => l.id === activeId) ?? null

  // Item count for the active library drives the sidebar badge. ABS treats
  // limit=0 as "no limit" (returns every item), so fetch a single item just to
  // read `total` off the response.
  const { data: countData } = useQuery({
    queryKey: [...libraryKeys.all, 'count', activeId],
    queryFn: () => getLibraryItems(activeId as string, 0, 1),
    enabled: !!activeId,
    staleTime: 5 * 60 * 1000,
  })

  return {
    libraries,
    active,
    activeId,
    itemCount: countData?.total ?? null,
    select,
  }
}
