import { create } from 'zustand'
import type { QueueEntry, QueueMode } from '@hearthshelf/core'

export type { QueueEntry, QueueMode, AutoRuleId, AutoRulePref } from '@hearthshelf/core'

interface QueueState {
  items: QueueEntry[]
  mode: QueueMode
  // Playlist that Playlist mode follows (ABS playlist id), if any.
  playlistId: string | null
  // Bumped on every items/playlistId mutation; the conflict key /hs/queue uses
  // to decide whether a write is newer than what's stored. See useQueueSync.
  updatedAt: number
  add: (entry: QueueEntry) => void
  remove: (libraryItemId: string) => void
  reorder: (from: number, to: number) => void
  clear: () => void
  // Replace the whole queue (used when Auto rebuilds it, or a server sync
  // pull adopts a remote queue). bump=false skips the updatedAt stamp, for
  // pulls that shouldn't be echoed straight back to the server as a write.
  setItems: (items: QueueEntry[], bump?: boolean) => void
  // Pop and return the head, or null when empty.
  next: () => QueueEntry | null
  setMode: (mode: QueueMode) => void
  setPlaylistId: (id: string | null) => void
}

// Client-side up-next queue. `items`/`playlistId` persist server-side (see
// useQueueSync, /hs/queue) so they follow the user across devices; `mode` is
// session-local UI state mirrored from the synced settings default
// (settings.queueMode) by AudioEngine, not persisted here directly.
export const useQueueStore = create<QueueState>()((set, get) => ({
  items: [],
  mode: 'manual',
  playlistId: null,
  updatedAt: 0,
  add: (entry) =>
    set((s) =>
      s.items.some((i) => i.libraryItemId === entry.libraryItemId)
        ? s
        : { items: [...s.items, entry], updatedAt: Date.now() }
    ),
  remove: (id) =>
    set((s) => ({
      items: s.items.filter((i) => i.libraryItemId !== id),
      updatedAt: Date.now(),
    })),
  reorder: (from, to) =>
    set((s) => {
      const next = s.items.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { items: next, updatedAt: Date.now() }
    }),
  clear: () => set({ items: [], updatedAt: Date.now() }),
  setItems: (items, bump = true) =>
    set((s) => ({ items, updatedAt: bump ? Date.now() : s.updatedAt })),
  next: () => {
    const [head, ...rest] = get().items
    if (!head) return null
    set({ items: rest, updatedAt: Date.now() })
    return head
  },
  setMode: (mode) => set({ mode }),
  setPlaylistId: (playlistId) => set({ playlistId, updatedAt: Date.now() }),
}))
