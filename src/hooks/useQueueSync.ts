import { useEffect, useRef } from 'react'
import { useQueueStore } from '@/store/queueStore'
import { usePlayerStore } from '@/store/playerStore'
import { useAuthStore } from '@/store/authStore'
import { getServerQueue, putServerQueue } from '@/api/queue'

const PUSH_DEBOUNCE_MS = 400

// Keeps the local queue store in sync with the server copy, so the up-next
// list follows a user across devices. Mirrors useSettingsSync's pull/push
// shape, but tuned for a queue: shorter debounce (it's interactive, not a
// once-in-a-while preference edit), and pulls happen on focus too, not just
// login - a queue built on another device should show up without a reload.
//
// Conflict rule: while THIS device has an active playback session, it is the
// authority - it doesn't adopt a remote queue mid-session (that would yank
// the list out from under whoever is actively listening here). An idle
// device always adopts the latest queue on its next pull.
//
// Mounted once in AppShell, alongside useSettingsSync.
export function useQueueSync() {
  const token = useAuthStore((s) => s.token)
  const hydrating = useRef(false)
  const hydrated = useRef(false)
  const timer = useRef<number | null>(null)

  const pull = useRef(async () => {
    if (!token) return
    try {
      const server = await getServerQueue()
      const hasActiveSession = !!usePlayerStore.getState().sessionId
      if (hasActiveSession) return
      hydrating.current = true
      useQueueStore.setState({
        items: server.items,
        playlistId: server.playlistId,
        updatedAt: server.updatedAt,
      })
      hydrating.current = false
    } catch {
      // Backend unreachable - keep the local queue as-is.
    } finally {
      hydrated.current = true
    }
  })

  // Pull on login/token change.
  useEffect(() => {
    if (!token) {
      hydrated.current = false
      return
    }
    hydrated.current = false
    void pull.current()
  }, [token])

  // Pull again whenever the tab/app regains focus, so a queue built on
  // another device shows up without a reload.
  useEffect(() => {
    if (!token) return
    const onFocus = () => void pull.current()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [token])

  // Push local changes back (debounced) once hydrated.
  useEffect(() => {
    if (!token) return
    const unsub = useQueueStore.subscribe(() => {
      if (!hydrated.current || hydrating.current) return
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        const { items, playlistId, updatedAt } = useQueueStore.getState()
        putServerQueue(items, playlistId, updatedAt)
          .then((res) => {
            // Our write was stale (another device moved faster) - adopt the
            // server's state unless we've since started playing here.
            if (res.applied === false && !usePlayerStore.getState().sessionId) {
              useQueueStore.setState({
                items: res.items,
                playlistId: res.playlistId,
                updatedAt: res.updatedAt,
              })
            }
          })
          .catch(() => {
            // Best-effort; the local store already holds the change.
          })
      }, PUSH_DEBOUNCE_MS)
    })
    return () => {
      unsub()
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [token])
}
