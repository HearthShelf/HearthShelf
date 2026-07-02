import { useQuery } from '@tanstack/react-query'
import { fetchServerRuns } from '@/api/questgiver'

// Item ids from the user's most recent QuestGiver run, best-first. Feeds the
// shared ranking layer (rankDiscoverShelves / discoverHomePreview) so QuestGiver-
// refined picks lead Discover and Home. Empty when the user has never run
// QuestGiver - the deterministic base order stands.
export function useQuestGiverPicks(enabled = true): string[] {
  const { data } = useQuery({
    queryKey: ['questgiver', 'runs'],
    queryFn: fetchServerRuns,
    enabled,
    staleTime: 5 * 60 * 1000,
  })
  const latest = data?.[0]
  if (!latest) return []
  return latest.picks
    .map((p) => p.itemId)
    .filter((id): id is string => Boolean(id))
}
