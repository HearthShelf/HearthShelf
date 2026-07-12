import { create } from 'zustand'
import * as api from '@/api/dismissals'

// Per-user "not right now" dismissals of series/books from Auto sources (the
// queue + the Continue-* home shelves). Synced from /hs/dismissals; every shelf
// filters against this. Writes are optimistic with rollback. A `labels` cache
// (best-effort, not synced) lets the Settings restore list show real names.

interface DismissalsState {
  seriesIds: string[]
  itemIds: string[]
  labels: Record<string, string>
  hydrate: () => Promise<void>
  reset: () => void
  isSeriesDismissed: (id: string) => boolean
  isItemDismissed: (id: string) => boolean
  dismiss: (kind: 'series' | 'item', entityId: string, label?: string) => Promise<void>
  restore: (kind: 'series' | 'item', entityId: string) => Promise<void>
}

export const useDismissalsStore = create<DismissalsState>((set, get) => ({
  seriesIds: [],
  itemIds: [],
  labels: {},

  hydrate: async () => {
    try {
      const d = await api.getDismissals()
      set({ seriesIds: d.seriesIds, itemIds: d.itemIds })
    } catch {
      // Backend unreachable - keep the current cache.
    }
  },

  reset: () => set({ seriesIds: [], itemIds: [], labels: {} }),

  isSeriesDismissed: (id) => get().seriesIds.includes(id),
  isItemDismissed: (id) => get().itemIds.includes(id),

  dismiss: async (kind, entityId, label) => {
    const key = kind === 'series' ? 'seriesIds' : 'itemIds'
    const prev = { seriesIds: get().seriesIds, itemIds: get().itemIds }
    if (get()[key].includes(entityId)) {
      if (label) set((s) => ({ labels: { ...s.labels, [entityId]: label } }))
      return
    }
    set((s) => ({
      [key]: [...s[key], entityId],
      labels: label ? { ...s.labels, [entityId]: label } : s.labels,
    }))
    try {
      const d = await api.addDismissal(kind, entityId)
      set({ seriesIds: d.seriesIds, itemIds: d.itemIds })
    } catch {
      set(prev) // roll back
      throw new Error('dismiss_failed')
    }
  },

  restore: async (kind, entityId) => {
    const key = kind === 'series' ? 'seriesIds' : 'itemIds'
    const prev = { seriesIds: get().seriesIds, itemIds: get().itemIds }
    if (!get()[key].includes(entityId)) return
    set((s) => ({ [key]: s[key].filter((id) => id !== entityId) }))
    try {
      const d = await api.removeDismissal(kind, entityId)
      set({ seriesIds: d.seriesIds, itemIds: d.itemIds })
    } catch {
      set(prev)
      throw new Error('restore_failed')
    }
  },
}))
