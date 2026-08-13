import { useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ABSLibraryItem, ABSMediaProgress } from '@/api/types'
import {
  getMonthlyShelf,
  getDiscoverFeedback,
  setDiscoverFeedback,
  getPopular,
  discoverKeys,
  type DiscoverFeedbackMap,
  type DiscoverVote,
  type MonthlyShelf,
  type PopularItem,
} from '@/api/discover'
import { buildDiscoverSummary, discoverCandidates } from '@/lib/discover'
import { useIgnoredItemIds } from '@/hooks/useIgnoredItemIds'

// The month's AI-curated shelf. Long staleTime - it only changes once a month, so
// there's no value refetching within a session.
export function useMonthlyShelf(
  items: ABSLibraryItem[],
  progressById: Map<string, ABSMediaProgress>,
  enabled: boolean,
) {
  const summary = useMemo(() => buildDiscoverSummary(items, progressById), [items, progressById])
  // Books in ignored series never reach the prompt, so the month's shelf cannot
  // come back recommending a series the listener has no interest in.
  const ignoredIds = useIgnoredItemIds(enabled)
  const candidates = useMemo(
    () => discoverCandidates(items, progressById, ignoredIds),
    [items, progressById, ignoredIds],
  )
  return useQuery<MonthlyShelf>({
    queryKey: [...discoverKeys.monthly, summary, candidates.length],
    queryFn: () => getMonthlyShelf(summary, candidates),
    enabled: enabled && candidates.length > 0,
    staleTime: 60 * 60 * 1000, // 1h; the server caps it to one generation/month
  })
}

export function useDiscoverFeedbackQuery(enabled: boolean) {
  return useQuery<DiscoverFeedbackMap>({
    queryKey: discoverKeys.feedback,
    queryFn: getDiscoverFeedback,
    enabled,
    staleTime: 5 * 60 * 1000,
  })
}

// Mutation that upserts feedback and optimistically updates the cached map so the
// UI (e.g. hiding a not_interested tile) reacts immediately, before the round-trip.
export function useSetDiscoverFeedback() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ itemKey, vote }: { itemKey: string; vote?: DiscoverVote | null }) =>
      setDiscoverFeedback(itemKey, { vote }),
    onMutate: async ({ itemKey, vote }) => {
      await qc.cancelQueries({ queryKey: discoverKeys.feedback })
      const prev = qc.getQueryData<DiscoverFeedbackMap>(discoverKeys.feedback) ?? {}
      const next: DiscoverFeedbackMap = { ...prev }
      const entry = { ...(next[itemKey] ?? {}) }
      if (vote !== undefined) {
        if (vote === null) delete entry.vote
        else entry.vote = vote
      }
      if (Object.keys(entry).length === 0) delete next[itemKey]
      else next[itemKey] = entry
      qc.setQueryData(discoverKeys.feedback, next)
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(discoverKeys.feedback, ctx.prev)
    },
    onSuccess: (map) => qc.setQueryData(discoverKeys.feedback, map),
  })
}

export function usePopular(enabled: boolean) {
  return useQuery<PopularItem[]>({
    queryKey: discoverKeys.popular,
    queryFn: getPopular,
    enabled,
    staleTime: 60 * 60 * 1000,
  })
}
