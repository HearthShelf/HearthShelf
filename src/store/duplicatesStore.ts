import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  buildDuplicateIndex,
  mergeDuplicateIndexes,
  type ABSLibraryItem,
  type DuplicateGroup,
  type DuplicateIndex,
} from '@hearthshelf/core'

// Library items AudiobookShelf recorded twice for one folder (see
// @hearthshelf/core lib/duplicates.ts for how that happens). Filled every time
// the full library list loads (getAllLibraryItems). The duplicate -> keeper
// index is persisted so a cold deep link or an old continue-listening entry to
// a duplicate id still resolves before the library list has loaded; the groups
// (full item objects) stay in memory for the admin cleanup.

interface DuplicatesState {
  /** Per library: duplicate id -> keeper id. Persisted. */
  indexByLibrary: Record<string, DuplicateIndex>
  /** Per library: the groups from the last full list. In memory only. */
  groupsByLibrary: Record<string, DuplicateGroup<ABSLibraryItem>[]>
  setLibraryGroups: (libraryId: string, groups: DuplicateGroup<ABSLibraryItem>[]) => void
  reset: () => void
}

export const useDuplicatesStore = create<DuplicatesState>()(
  persist(
    (set) => ({
      indexByLibrary: {},
      groupsByLibrary: {},
      setLibraryGroups: (libraryId, groups) =>
        set((s) => ({
          indexByLibrary: { ...s.indexByLibrary, [libraryId]: buildDuplicateIndex(groups) },
          groupsByLibrary: { ...s.groupsByLibrary, [libraryId]: groups },
        })),
      reset: () => set({ indexByLibrary: {}, groupsByLibrary: {} }),
    }),
    {
      name: 'hearthshelf:duplicates',
      partialize: (s) => ({ indexByLibrary: s.indexByLibrary }),
    },
  ),
)

/** Every known duplicate -> keeper, across libraries. */
export function getDuplicateIndex(): DuplicateIndex {
  return mergeDuplicateIndexes(...Object.values(useDuplicatesStore.getState().indexByLibrary))
}

export function useDuplicateIndex(): DuplicateIndex {
  const byLibrary = useDuplicatesStore((s) => s.indexByLibrary)
  // Cheap: one entry per duplicate, and there are only ever a handful.
  return mergeDuplicateIndexes(...Object.values(byLibrary))
}
