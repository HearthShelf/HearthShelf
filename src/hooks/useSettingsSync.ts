import { useEffect, useRef } from 'react'
import { useSettingsStore, settingsValues } from '@/store/settingsStore'
import { useAuthStore } from '@/store/authStore'
import { getServerSettings, putServerSettings } from '@/api/settings'

const PUSH_DEBOUNCE_MS = 1200

// Keeps the local settings store in sync with the server copy, so a user's
// preferences follow them across devices. localStorage stays the instant cache
// (the store renders from it immediately); this hook reconciles with the DB:
//   - on login, pull the server values and apply them (server is the truth)
//   - on any later local change, debounce-push the full snapshot back
//
// Mounted once in AppShell. If the backend is unreachable the app keeps working
// purely from localStorage - sync is best-effort.
export function useSettingsSync() {
  const token = useAuthStore((s) => s.token)
  const applyServer = useSettingsStore((s) => s.applyServer)

  // True while we're applying server values, so the change-subscription doesn't
  // immediately echo them back as a push.
  const hydrating = useRef(false)
  // Set once the initial pull completes; we don't push before then (avoids
  // clobbering the server with defaults during the first paint).
  const hydrated = useRef(false)
  const timer = useRef<number | null>(null)

  // Pull on login (or token change).
  useEffect(() => {
    if (!token) {
      hydrated.current = false
      return
    }
    let cancelled = false
    hydrated.current = false
    getServerSettings()
      .then((res) => {
        if (cancelled) return
        if (res.values && typeof res.values === 'object') {
          hydrating.current = true
          applyServer(res.values)
          hydrating.current = false
        }
      })
      .catch(() => {
        // Backend offline - keep the localStorage values as-is.
      })
      .finally(() => {
        if (!cancelled) hydrated.current = true
      })
    return () => {
      cancelled = true
    }
  }, [token, applyServer])

  // Push local changes back (debounced) once hydrated.
  useEffect(() => {
    if (!token) return
    const unsub = useSettingsStore.subscribe((state) => {
      if (!hydrated.current || hydrating.current) return
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        putServerSettings(
          settingsValues(state) as unknown as Record<string, unknown>
        ).catch(() => {
          // Best-effort; localStorage already holds the change.
        })
      }, PUSH_DEBOUNCE_MS)
    })
    return () => {
      unsub()
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [token])
}
