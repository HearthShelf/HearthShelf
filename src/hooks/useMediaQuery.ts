import { useSyncExternalStore } from 'react'

// Breakpoints (px). Mobile is phone-sized, tablet sits between, desktop is the
// full sidebar layout. These match the responsive rules in design.css.
export const BP_MOBILE = 700
export const BP_TABLET = 1023

function makeQuery(query: string) {
  const mql = typeof window !== 'undefined' ? window.matchMedia(query) : null
  return {
    subscribe(cb: () => void) {
      mql?.addEventListener('change', cb)
      return () => mql?.removeEventListener('change', cb)
    },
    get() {
      return mql?.matches ?? false
    },
  }
}

// Cache one store per query so every caller of the same query shares a
// subscription (and React's useSyncExternalStore stays referentially stable).
const stores = new Map<string, ReturnType<typeof makeQuery>>()
function storeFor(query: string) {
  let s = stores.get(query)
  if (!s) {
    s = makeQuery(query)
    stores.set(query, s)
  }
  return s
}

export function useMediaQuery(query: string): boolean {
  const store = storeFor(query)
  return useSyncExternalStore(store.subscribe, store.get, () => false)
}

// Phone-sized viewport: drives the bottom nav, forced-compact density, and the
// touch-first book grid.
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${BP_MOBILE}px)`)
}

// Tablet or smaller: the sidebar collapses but the layout is not yet phone-like.
export function useIsTabletDown(): boolean {
  return useMediaQuery(`(max-width: ${BP_TABLET}px)`)
}
