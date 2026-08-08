import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getRatings, setRating, ratingKeys, type RatingMap } from '@/api/ratings'

// One shared query key across every surface, so rating a book on the series page
// updates the book page, the finished-books page, and Discover with no refetch.
export function useRatings(enabled = true) {
  return useQuery<RatingMap>({
    queryKey: ratingKeys.map,
    queryFn: getRatings,
    enabled,
    staleTime: 5 * 60 * 1000,
  })
}

// Optimistic: the stars fill on click and roll back if the write fails.
export function useSetRating() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ itemKey, rating }: { itemKey: string; rating: number | null }) =>
      setRating(itemKey, rating),
    onMutate: async ({ itemKey, rating }) => {
      await qc.cancelQueries({ queryKey: ratingKeys.map })
      const prev = qc.getQueryData<RatingMap>(ratingKeys.map) ?? {}
      const next: RatingMap = { ...prev }
      if (rating === null) delete next[itemKey]
      else next[itemKey] = rating
      qc.setQueryData(ratingKeys.map, next)
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ratingKeys.map, ctx.prev)
    },
    onSuccess: (map) => qc.setQueryData(ratingKeys.map, map),
  })
}
