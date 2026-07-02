import { useEffect, useRef } from 'react'
import { validateSetting } from '@hearthshelf/core'
import { useSettingsStore, SYNCED_KEYS, scopeOf } from '@/store/settingsStore'
import { useAuthStore } from '@/store/authStore'
import { getServerSettings, putServerSettings, type SettingChange } from '@/api/settings'

const PUSH_DEBOUNCE_MS = 1200

// Keeps the local settings store in sync with the server copy per-key, so a
// user's settings follow them across devices without one device clobbering
// another's unrelated change. localStorage stays the instant cache; this hook
// reconciles with the DB:
//   - on login, pull the server values and merge them per-key (LWW)
//   - on any later local change, debounce-push only the keys that changed
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
  // Snapshot of per-key meta at last push, to diff what changed.
  const lastMeta = useRef<Record<string, number>>({})
  const timer = useRef<number | null>(null)

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
        lastMeta.current = { ...useSettingsStore.getState().meta }
        hydrated.current = true
      })
    return () => {
      cancelled = true
    }
  }, [token])

  // Push changed keys back (debounced) once hydrated.
  useEffect(() => {
    if (!token) return
    const unsub = useSettingsStore.subscribe(() => {
      if (!hydrated.current || hydrating.current) return
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        const s = useSettingsStore.getState()
        const changes: SettingChange[] = []
        for (const key of SYNCED_KEYS) {
          const k = key as string
          const at = s.meta[k]
          if (at == null) continue // never set locally - leave as default
          if (lastMeta.current[k] === at) continue // unchanged since last push
          const scope = scopeOf(k)
          if (!scope) continue
          const value = (s as unknown as Record<string, unknown>)[k]
          // Validate client-side so we never push a value the server would reject.
          const v = validateSetting(k, value as never)
          if (!v.ok) continue
          changes.push({ scope, key: k, value: v.value, updatedAt: at })
        }
        if (!changes.length) return
        const deviceId = s.deviceId
        putServerSettings(deviceId, changes)
          .then((res) => {
            // Adopt any value the server rejected as stale (another device newer).
            if (res.rejected?.length) {
              const rows: Record<string, { value: unknown; updatedAt: number }> = {}
              for (const r of res.rejected) rows[r.key] = { value: r.value, updatedAt: r.updatedAt }
              hydrating.current = true
              useSettingsStore.getState().applyServerKeys(rows as never)
              hydrating.current = false
            }
            lastMeta.current = { ...useSettingsStore.getState().meta }
          })
          .catch(() => {
            // Best-effort; localStorage already holds the change, retried next change.
          })
      }, PUSH_DEBOUNCE_MS)
    })
    return () => {
      unsub()
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [token])
}
