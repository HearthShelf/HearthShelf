import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface QueueEntry {
  libraryItemId: string
  title: string
  author: string
}

// How the up-next queue behaves when a book ends:
//  - off:      stop at the end of each book
//  - manual:   play the next book the user queued by hand
//  - auto:     rebuild up-next from the smart rules (see lib/queueRules)
//  - playlist: follow a chosen ABS playlist in order
export type QueueMode = 'off' | 'manual' | 'auto' | 'playlist'

// Ordered, toggleable rules that drive Auto mode. Order = priority.
export type AutoRuleId = 'finish-series' | 'in-progress' | 'new-in-series'

interface QueueState {
  items: QueueEntry[]
  mode: QueueMode
  // Playlist that Playlist mode follows (ABS playlist id), if any.
  playlistId: string | null
  add: (entry: QueueEntry) => void
  remove: (libraryItemId: string) => void
  reorder: (from: number, to: number) => void
  clear: () => void
  // Replace the whole queue (used when Auto rebuilds it).
  setItems: (items: QueueEntry[]) => void
  // Pop and return the head, or null when empty.
  next: () => QueueEntry | null
  setMode: (mode: QueueMode) => void
  setPlaylistId: (id: string | null) => void
}

// Client-only up-next queue. ABS has no cross-book session queue, so this lives
// in sessionStorage (clears on tab close) per the player spec. Mode/playlistId
// ride along so the player keeps the user's intent for the session; the durable
// default mode lives in settings (queueMode).
export const useQueueStore = create<QueueState>()(
  persist(
    (set, get) => ({
      items: [],
      mode: 'manual',
      playlistId: null,
      add: (entry) =>
        set((s) =>
          s.items.some((i) => i.libraryItemId === entry.libraryItemId)
            ? s
            : { items: [...s.items, entry] }
        ),
      remove: (id) =>
        set((s) => ({
          items: s.items.filter((i) => i.libraryItemId !== id),
        })),
      reorder: (from, to) =>
        set((s) => {
          const next = s.items.slice()
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return { items: next }
        }),
      clear: () => set({ items: [] }),
      setItems: (items) => set({ items }),
      next: () => {
        const [head, ...rest] = get().items
        if (!head) return null
        set({ items: rest })
        return head
      },
      setMode: (mode) => set({ mode }),
      setPlaylistId: (playlistId) => set({ playlistId }),
    }),
    {
      name: 'hearthshelf:queue',
      storage: {
        getItem: (k) => {
          const v = sessionStorage.getItem(k)
          return v ? JSON.parse(v) : null
        },
        setItem: (k, v) => sessionStorage.setItem(k, JSON.stringify(v)),
        removeItem: (k) => sessionStorage.removeItem(k),
      },
    }
  )
)
