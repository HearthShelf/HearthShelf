import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { resolveKeeperId } from '@hearthshelf/core'
import { useDuplicateIndex } from '@/store/duplicatesStore'

// A link to a duplicate entry (a book ABS recorded twice) - an old bookmark,
// a shared link, a continue-listening tile - opens the copy that stays.
// Returns true while a redirect is pending so the page can skip its fetch.
export function useKeeperRedirect(itemId: string | undefined, pathFor: (id: string) => string) {
  const navigate = useNavigate()
  const index = useDuplicateIndex()
  const keeperId = itemId ? resolveKeeperId(index, itemId) : undefined
  const redirecting = Boolean(itemId && keeperId && keeperId !== itemId)
  useEffect(() => {
    if (redirecting && keeperId) navigate(pathFor(keeperId), { replace: true })
  }, [redirecting, keeperId, navigate, pathFor])
  return redirecting
}
