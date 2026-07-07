import { create } from 'zustand'
import type { QueueEntry, QueueMode } from '@hearthshelf/core'

export type { QueueEntry, QueueMode, AutoRuleId, AutoRulePref } from '@hearthshelf/core'

interface QueueState {
  // The ACTIVE up-next list the player pops from. In Auto/Playlist mode it's
  // rebuilt from rules/playlist (ephemeral); in Manual mode it mirrors `manual`.
  items: QueueEntry[]
  // The DURABLE hand-queued list. add/remove/reorder edit this; it drives
  // Manual mode and, in Auto mode, feeds the 'manual' rule so a hand-picked
  // queue survives every Auto rebuild. Synced via /hs/queue alongside items.
  manual: QueueEntry[]
  mode: QueueMode
  // Playlist that Playlist mode follows (ABS playlist id), if any.
  playlistId: string | null
  // Bumped on every items/manual/playlistId mutation; the conflict key
  // /hs/queue uses to decide whether a write is newer. See useQueueSync.
  updatedAt: number
  // Add/remove/reorder the DURABLE manual list. In Manual mode the active
  // `items` list mirrors it so the up-next panel updates live.
  add: (entry: QueueEntry) => void
  remove: (libraryItemId: string) => void
  reorder: (from: number, to: number) => void
  clear: () => void
  // Replace the whole manual list (drag-reorder of the whole set, bulk set).
  setManual: (manual: QueueEntry[]) => void
  // Replace the active up-next list (used when Auto/Playlist rebuild it, or a
  // server sync pull adopts a remote queue). bump=false skips the updatedAt
  // stamp, for pulls that shouldn't be echoed straight back as a write.
  setItems: (items: QueueEntry[], bump?: boolean) => void
  // Pop and return the head of the active list, or null when empty.
  next: () => QueueEntry | null
  setMode: (mode: QueueMode) => void
  setPlaylistId: (id: string | null) => void
}

// Client-side up-next queue. `items`/`manual`/`playlistId` persist server-side
// (see useQueueSync, /hs/queue) so they follow the user across devices; `mode`
// is session-local UI state mirrored from the synced settings default
// (settings.queueMode) by AudioEngine, not persisted here directly.
export const useQueueStore = create<QueueState>()((set, get) => ({
  items: [],
  manual: [],
  mode: 'manual',
  playlistId: null,
  updatedAt: 0,
  add: (entry) =>
    set((s) => {
      if (s.manual.some((i) => i.libraryItemId === entry.libraryItemId)) return s
      const manual = [...s.manual, entry]
      // In Manual mode the active list is the manual list - mirror the add so
      // the up-next panel and the player see it immediately.
      const items = s.mode === 'manual' ? manual : s.items
      return { manual, items, updatedAt: Date.now() }
    }),
  remove: (id) =>
    set((s) => {
      const manual = s.manual.filter((i) => i.libraryItemId !== id)
      const items =
        s.mode === 'manual' ? manual : s.items.filter((i) => i.libraryItemId !== id)
      return { manual, items, updatedAt: Date.now() }
    }),
  reorder: (from, to) =>
    set((s) => {
      const manual = s.manual.slice()
      const [moved] = manual.splice(from, 1)
      manual.splice(to, 0, moved)
      const items = s.mode === 'manual' ? manual : s.items
      return { manual, items, updatedAt: Date.now() }
    }),
  clear: () =>
    set((s) => ({ manual: [], items: s.mode === 'manual' ? [] : s.items, updatedAt: Date.now() })),
  setManual: (manual) =>
    set((s) => ({ manual, items: s.mode === 'manual' ? manual : s.items, updatedAt: Date.now() })),
  setItems: (items, bump = true) =>
    set((s) => ({ items, updatedAt: bump ? Date.now() : s.updatedAt })),
  next: () => {
    const [head, ...rest] = get().items
    if (!head) return null
    set((s) => ({
      items: rest,
      // Keep the manual list in step when it's the active list, so a popped
      // book doesn't reappear from the durable copy on the next sync.
      manual: s.mode === 'manual' ? rest : s.manual,
      updatedAt: Date.now(),
    }))
    return head
  },
  setMode: (mode) =>
    set((s) => ({
      mode,
      // Entering Manual mode, the active list becomes the durable manual list.
      items: mode === 'manual' ? s.manual : s.items,
    })),
  setPlaylistId: (playlistId) => set({ playlistId, updatedAt: Date.now() }),
}))
