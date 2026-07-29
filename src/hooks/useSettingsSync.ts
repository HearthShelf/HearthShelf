import { useCallback, useEffect, useRef } from 'react'
import { useSettingsStore, pendingSettingChanges } from '@/store/settingsStore'
import { useAuthStore } from '@/store/authStore'
import { getServerSettings, putServerSettings } from '@/api/settings'

const PUSH_DEBOUNCE_MS = 1200

// Keeps the local settings store in sync with the server copy per-key, so a
// user's settings follow them across devices without one device clobbering
// another's unrelated change. localStorage stays the instant cache; this hook
// reconciles with the DB:
//   - on login, pull the server values and merge them per-key (LWW)
//   - on any later local change, debounce-push only the keys that changed
//   - after a pull, flush anything the server still doesn't have
//
// What counts as "changed" comes from the store's own pending set (`meta` vs
// `pushed`), not from a snapshot taken here. The snapshot used to be re-based
// after every pull, so an edit still inside the debounce - or one whose push had
// failed while the backend was down - was diffed away and never sent. A key is
// now retired only when the server confirms it, and `pushed` is persisted, so an
// offline edit still pushes after a reload.
//
// Account-scoped settings only apply on a device where useSharedSettings is on;
// device-scoped settings always round-trip (they're a per-device backup).
// Mounted once in AppShell. Best-effort: offline, the app runs from localStorage.
export function useSettingsSync() {
  const token = useAuthStore((s) => s.token)

  // True while applying server values, so the change-subscription doesn't echo
  // them straight back as a push.
  const hydrating = useRef(false)
  // Set once the initial pull completes; we don't push before then.
  const hydrated = useRef(false)
  // A push is in flight; its response decides what's still pending.
  const pushing = useRef(false)
  const timer = useRef<number | null>(null)

  const schedulePush = useCallback(() => {
    if (!hydrated.current || hydrating.current) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      // Wait for the in-flight request rather than sending an overlapping batch.
      if (pushing.current) {
        schedulePush()
        return
      }
      const changes = pendingSettingChanges()
      if (!changes.length) return
      pushing.current = true
      putServerSettings(useSettingsStore.getState().deviceId, changes)
        .then((res) => {
          // Retire exactly what the server took. Anything unacknowledged stays
          // pending and rides along on the next push.
          const done: Record<string, number> = {}
          for (const c of changes) {
            if (res.applied?.includes(c.key)) done[c.key] = c.updatedAt
          }
          // Invalid values can never be accepted; retire them rather than
          // re-sending them on every future push.
          for (const bad of res.invalid ?? []) {
            const sent = changes.find((c) => c.key === bad.key)
            if (sent) done[bad.key] = sent.updatedAt
          }
          if (Object.keys(done).length) useSettingsStore.getState().markPushed(done)
          // Adopt any value the server rejected as stale (another device newer);
          // applyServerKeys records its updatedAt, which retires the key.
          if (res.rejected?.length) {
            const rows: Record<string, { value: unknown; updatedAt: number }> = {}
            for (const r of res.rejected) rows[r.key] = { value: r.value, updatedAt: r.updatedAt }
            hydrating.current = true
            useSettingsStore.getState().applyServerKeys(rows as never)
            hydrating.current = false
          }
        })
        .catch(() => {
          // Best-effort; the change stays pending (and persisted), so the next
          // change or the next login pull retries it.
        })
        .finally(() => {
          pushing.current = false
        })
    }, PUSH_DEBOUNCE_MS)
  }, [])

  // Pull on login (or token change).
  useEffect(() => {
    if (!token) {
      hydrated.current = false
      return
    }
    let cancelled = false
    hydrated.current = false
    const { deviceId } = useSettingsStore.getState()
    getServerSettings(deviceId)
      .then((res) => {
        if (cancelled) return
        const useShared = useSettingsStore.getState().useSharedSettings
        hydrating.current = true
        // Device settings always apply; account settings only when this device
        // opts into shared settings.
        if (useShared && res.account) useSettingsStore.getState().applyServerKeys(res.account)
        if (res.device) useSettingsStore.getState().applyServerKeys(res.device)
        hydrating.current = false
      })
      .catch(() => {
        // Backend offline - keep the localStorage values as-is.
      })
      .finally(() => {
        if (cancelled) return
        hydrated.current = true
        // applyServerKeys has retired every key the server acknowledged, so this
        // sends exactly the local edits that never landed.
        schedulePush()
      })
    return () => {
      cancelled = true
    }
  }, [token, schedulePush])

  // Push changed keys back (debounced) once hydrated.
  useEffect(() => {
    if (!token) return
    const unsub = useSettingsStore.subscribe(schedulePush)
    return () => {
      unsub()
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [token, schedulePush])
}
