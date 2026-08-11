import { create } from 'zustand'
import * as api from '@/api/dismissals'

// Per-user "not right now" dismissals of series/books from Auto sources (the
// queue + the Continue-* home shelves). Synced from /hs/dismissals; every shelf
// filters against this. Writes are optimistic with rollback. A `labels` cache
// (best-effort, not synced) lets the Settings restore list show real names.
//
// The 'roster' kind is different in kind, not just degree: its entity is an
// AUDIBLE ASIN, not an ABS id, because it marks a series book the user never
// expects to own (an ebook-only side story, a print edition) which has no ABS
// item. Ignoring one drops it from the missing list, the series completion
// denominator, Upcoming, and the Home countdown.

type DismissKind = 'series' | 'item' | 'roster'

const BUCKET = {
  series: 'seriesIds',
  item: 'itemIds',
  roster: 'rosterAsins',
} as const

interface DismissalsState {
  seriesIds: string[]
  itemIds: string[]
  rosterAsins: string[]
  labels: Record<string, string>
  hydrate: () => Promise<void>
  reset: () => void
  isSeriesDismissed: (id: string) => boolean
  isItemDismissed: (id: string) => boolean
  isRosterIgnored: (asin: string) => boolean
  dismiss: (kind: DismissKind, entityId: string, label?: string) => Promise<void>
  restore: (kind: DismissKind, entityId: string) => Promise<void>
}

export const useDismissalsStore = create<DismissalsState>((set, get) => ({
  seriesIds: [],
  itemIds: [],
  rosterAsins: [],
  labels: {},

  hydrate: async () => {
    try {
      const d = await api.getDismissals()
      set({
        seriesIds: d.seriesIds,
        itemIds: d.itemIds,
        rosterAsins: d.rosterAsins ?? [],
      })
    } catch {
      // Backend unreachable - keep the current cache.
    }
  },

  reset: () => set({ seriesIds: [], itemIds: [], rosterAsins: [], labels: {} }),

  isSeriesDismissed: (id) => get().seriesIds.includes(id),
  isItemDismissed: (id) => get().itemIds.includes(id),
  // ASIN casing varies across Audible responses, so compare case-insensitively.
  isRosterIgnored: (asin) => {
    const want = asin.toLowerCase()
    return get().rosterAsins.some((a) => a.toLowerCase() === want)
  },

  dismiss: async (kind, entityId, label) => {
    const key = BUCKET[kind]
    const prev = {
      seriesIds: get().seriesIds,
      itemIds: get().itemIds,
      rosterAsins: get().rosterAsins,
    }
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
      set({ seriesIds: d.seriesIds, itemIds: d.itemIds, rosterAsins: d.rosterAsins ?? [] })
    } catch {
      set(prev) // roll back
      throw new Error('dismiss_failed')
    }
  },

  restore: async (kind, entityId) => {
    const key = BUCKET[kind]
    const prev = {
      seriesIds: get().seriesIds,
      itemIds: get().itemIds,
      rosterAsins: get().rosterAsins,
    }
    if (!get()[key].includes(entityId)) return
    set((s) => ({ [key]: s[key].filter((id) => id !== entityId) }))
    try {
      const d = await api.removeDismissal(kind, entityId)
      set({ seriesIds: d.seriesIds, itemIds: d.itemIds, rosterAsins: d.rosterAsins ?? [] })
    } catch {
      set(prev)
      throw new Error('restore_failed')
    }
  },
}))
