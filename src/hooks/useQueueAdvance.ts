import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { usePlayerStore } from '@/store/playerStore'
import { useQueueStore } from '@/store/queueStore'
import { useSettingsStore } from '@/store/settingsStore'
import { usePlayer } from '@/hooks/usePlayer'
import { useMarkFinished } from '@/hooks/useMarkFinished'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { getAllLibraryItems, getSeries, getPlaylists, libraryKeys } from '@/api/libraries'
import { getMe, meKeys } from '@/api/me'
import { buildAutoQueue } from '@hearthshelf/core'
import type {
  ABSLibraryItemsResponse,
  ABSSeriesResponse,
  ABSMediaProgress,
  ABSPlaylistsResponse,
  QueueEntry,
} from '@/api/types'

// Set true for the one book-change that a book-end auto-advance causes, so the
// AudioEngine's play-cooldown does NOT rebuild the queue for it (only explicit
// plays should). Read-and-cleared by the cooldown when the new book loads.
let advancedByEnd = false
export function markAdvancedByEnd(): void {
  advancedByEnd = true
}
export function consumeAdvancedByEnd(): boolean {
  const v = advancedByEnd
  advancedByEnd = false
  return v
}

// Encapsulates "what plays next when a book ends", honoring the queue mode.
// Returns a single advance() the AudioEngine calls from onEnded.
export function useQueueAdvance() {
  const qc = useQueryClient()
  const { playItem } = usePlayer()
  const { markFinished } = useMarkFinished()
  const { activeId } = useActiveLibrary()
  const queueRules = useSettingsStore((s) => s.queueAutoRules)

  // Pull a query's data from cache, fetching (and caching) on a miss.
  const ensure = useCallback(
    <T>(key: readonly unknown[], fn: () => Promise<T>) =>
      qc.ensureQueryData({
        queryKey: key as unknown[],
        queryFn: fn,
        staleTime: 60 * 1000,
      }) as Promise<T>,
    [qc],
  )

  const buildAuto = useCallback(async (): Promise<QueueEntry[]> => {
    if (!activeId) return []
    const [itemsRes, seriesRes, me] = await Promise.all([
      ensure<ABSLibraryItemsResponse>(libraryKeys.allItems(activeId), () =>
        getAllLibraryItems(activeId),
      ),
      ensure<ABSSeriesResponse>(libraryKeys.series(activeId), () => getSeries(activeId, 0, 1000)),
      ensure<{ mediaProgress: ABSMediaProgress[] }>(meKeys.me, getMe),
    ])
    const progressById = new Map<string, ABSMediaProgress>()
    for (const p of me.mediaProgress ?? []) progressById.set(p.libraryItemId, p)
    return buildAutoQueue({
      items: itemsRes.results,
      series: seriesRes.results,
      progressById,
      currentItemId: usePlayerStore.getState().libraryItemId,
      rules: queueRules,
      // Feed the durable hand-queued list into the 'manual' rule so a
      // hand-picked queue survives the Auto rebuild.
      manualBooks: useQueueStore.getState().manual,
    })
  }, [activeId, ensure, queueRules])

  // Rebuild the up-next list from a chosen ABS playlist (Playlist mode).
  const buildPlaylist = useCallback(async (): Promise<QueueEntry[]> => {
    if (!activeId) return []
    const { playlistId } = useQueueStore.getState()
    if (!playlistId) return []
    const res = await ensure<ABSPlaylistsResponse>(libraryKeys.playlists(activeId), () =>
      getPlaylists(activeId),
    )
    const pl = res.results.find((p) => p.id === playlistId)
    if (!pl) return []
    const cur = usePlayerStore.getState().libraryItemId
    return pl.items
      .map((it) => it.libraryItem)
      .filter((li) => li && li.id !== cur)
      .map((li) => ({
        libraryItemId: li.id,
        title: li.media.metadata.title ?? 'Untitled',
        author: li.media.metadata.authorName ?? '',
      }))
  }, [activeId, ensure])

  // Populate the queue for Auto/Playlist modes without advancing (app load).
  const refresh = useCallback(async () => {
    const { mode, setItems } = useQueueStore.getState()
    if (mode === 'auto') setItems(await buildAuto())
    else if (mode === 'playlist') setItems(await buildPlaylist())
  }, [buildAuto, buildPlaylist])

  const advance = useCallback(async () => {
    const cur = usePlayerStore.getState().libraryItemId
    const { mode } = useQueueStore.getState()
    if (cur) await markFinished([cur], true).catch(() => {})

    if (mode === 'off') {
      usePlayerStore.getState().setPlaying(false)
      return
    }

    // Play the head of the queue we ALREADY hold - no rebuild here. Rebuilding
    // right after marking the book finished would re-seed 'finish-series' from
    // the just-ended book (now finished) and, with progress mid-invalidation,
    // jump past the next book in the series - the "book ended and it jumped
    // away" bug. The next book's play triggers a rebuild once it's playing.
    // Playlist mode only needs a build if the queue is empty (nothing to pop).
    if (mode === 'playlist' && useQueueStore.getState().items.length === 0) {
      useQueueStore.getState().setItems(await buildPlaylist())
    }

    const head = useQueueStore.getState().next()
    if (head) {
      // This play is a book-end advance: suppress the cooldown's rebuild for it.
      markAdvancedByEnd()
      void playItem(head.libraryItemId)
    } else usePlayerStore.getState().setPlaying(false)
  }, [markFinished, buildPlaylist, playItem])

  return { advance, refresh }
}
