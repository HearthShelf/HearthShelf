import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface QueueEntry {
  libraryItemId: string
  title: string
  author: string
}

interface QueueState {
  items: QueueEntry[]
  add: (entry: QueueEntry) => void
  remove: (libraryItemId: string) => void
  reorder: (from: number, to: number) => void
  clear: () => void
}

// Client-only up-next queue. ABS has no cross-book session queue, so this lives
// in sessionStorage (clears on tab close) per the player spec.
export const useQueueStore = create<QueueState>()(
  persist(
    (set) => ({
      items: [],
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
