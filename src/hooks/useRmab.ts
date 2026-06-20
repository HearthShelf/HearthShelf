import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getRmabConfig,
  requestKeys,
  submitRequest,
  cancelRequest,
  retryRequest,
  fetchEbook,
  watchAuthor,
  unwatchAuthor,
  watchSeries,
  unwatchSeries,
  listWatchedAuthors,
  listWatchedSeries,
  type RmabConfig,
} from '@/api/requests'

// Shared ReadMeABook config query - drives the Requests nav item and route gate.
export function useRmabConfig() {
  return useQuery<RmabConfig>({
    queryKey: requestKeys.config,
    queryFn: getRmabConfig,
    staleTime: 5 * 60 * 1000,
  })
}

// True when the request layer should be shown. Defaults to false until known
// (the feature is opt-in - the admin must connect RMAB), so nothing flickers in.
export function useRmabEnabled(): boolean {
  const { data } = useRmabConfig()
  return data?.configured === true
}

// Invalidate every request list + search lane so a write reflects immediately.
function useInvalidateRequests() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['rmab', 'requests'] })
    void qc.invalidateQueries({ queryKey: ['rmab', 'search'] })
  }
}

// Submit a new audiobook request.
export function useSubmitRequest() {
  const invalidate = useInvalidateRequests()
  return useMutation({
    mutationFn: submitRequest,
    onSuccess: invalidate,
  })
}

// Cancel / retry an existing request.
export function useCancelRequest() {
  const invalidate = useInvalidateRequests()
  return useMutation({ mutationFn: cancelRequest, onSuccess: invalidate })
}

export function useRetryRequest() {
  const invalidate = useInvalidateRequests()
  return useMutation({ mutationFn: retryRequest, onSuccess: invalidate })
}

// Fetch the matching ebook for a completed audiobook request.
export function useFetchEbook() {
  const invalidate = useInvalidateRequests()
  return useMutation({ mutationFn: fetchEbook, onSuccess: invalidate })
}

// Watch lists (auto-request new releases from an author / series).
export function useWatchedAuthors(enabled = true) {
  return useQuery({
    queryKey: requestKeys.watchedAuthors,
    queryFn: listWatchedAuthors,
    enabled,
    staleTime: 5 * 60 * 1000,
  })
}

export function useWatchedSeries(enabled = true) {
  return useQuery({
    queryKey: requestKeys.watchedSeries,
    queryFn: listWatchedSeries,
    enabled,
    staleTime: 5 * 60 * 1000,
  })
}

export function useWatchAuthorMutation() {
  const qc = useQueryClient()
  const invalidate = () => void qc.invalidateQueries({ queryKey: requestKeys.watchedAuthors })
  return {
    add: useMutation({ mutationFn: watchAuthor, onSuccess: invalidate }),
    remove: useMutation({ mutationFn: unwatchAuthor, onSuccess: invalidate }),
  }
}

export function useWatchSeriesMutation() {
  const qc = useQueryClient()
  const invalidate = () => void qc.invalidateQueries({ queryKey: requestKeys.watchedSeries })
  return {
    add: useMutation({ mutationFn: watchSeries, onSuccess: invalidate }),
    remove: useMutation({ mutationFn: unwatchSeries, onSuccess: invalidate }),
  }
}
