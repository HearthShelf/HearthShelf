import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getMe, meKeys } from '@/api/me'
import { useDuplicatesStore } from '@/store/duplicatesStore'
import { carryOverDuplicates, knownDuplicateGroups } from '@/lib/duplicates'

// When the server has a book listed twice and the signed-in user's place is on
// the copy being hidden, move it to the copy that stays. Runs whenever the
// known duplicates or the user's progress change; the core planner makes it a
// no-op once the keeper is up to date.
export function useDuplicateCarryOver() {
  const qc = useQueryClient()
  const indexByLibrary = useDuplicatesStore((s) => s.indexByLibrary)
  const { data: me } = useQuery({
    queryKey: meKeys.me,
    queryFn: getMe,
    staleTime: 60 * 1000,
  })

  useEffect(() => {
    if (!me) return
    const groups = knownDuplicateGroups()
    if (!groups.length) return
    void carryOverDuplicates(groups, me).then((writes) => {
      if (writes === 0) return
      void qc.invalidateQueries({ queryKey: meKeys.me })
      void qc.invalidateQueries({ queryKey: meKeys.itemsInProgress })
      void qc.invalidateQueries({ queryKey: ['personalized'] })
    })
  }, [me, indexByLibrary, qc])
}
