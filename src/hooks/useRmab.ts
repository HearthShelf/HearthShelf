import { useQuery } from '@tanstack/react-query'
import { getRmabConfig, requestKeys, type RmabConfig } from '@/api/requests'

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
