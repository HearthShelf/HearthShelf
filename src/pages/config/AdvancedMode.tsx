import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Icon } from '@/components/common/Icon'

// A single "Advanced Options" flag shared across every config page. Pages opt in
// by reading useAdvancedMode() and revealing their advanced controls (extra
// server details, destructive actions like killing a running job) only when it's
// on. The <AdvancedToggle /> sits in the top-right of a page header and flips it.
// The choice is sticky per browser so it survives navigation and reloads.

const STORAGE_KEY = 'hs.advancedMode'

interface AdvancedModeValue {
  advanced: boolean
  setAdvanced: (v: boolean) => void
}

const AdvancedModeContext = createContext<AdvancedModeValue | null>(null)

export function AdvancedModeProvider({ children }: { children: ReactNode }) {
  const [advanced, setAdvanced] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, advanced ? '1' : '0')
    } catch {
      // ignore storage failures (private mode etc.)
    }
  }, [advanced])

  return (
    <AdvancedModeContext.Provider value={{ advanced, setAdvanced }}>
      {children}
    </AdvancedModeContext.Provider>
  )
}

export function useAdvancedMode(): AdvancedModeValue {
  const ctx = useContext(AdvancedModeContext)
  if (!ctx) return { advanced: false, setAdvanced: () => {} }
  return ctx
}

// Small labeled switch for the top-right of a page header. Render it inside a
// page whose header is position: relative (the config body is), and it pins
// itself to the top-right corner.
export function AdvancedToggle() {
  const { advanced, setAdvanced } = useAdvancedMode()
  return (
    <button
      type="button"
      className="adv-toggle"
      aria-pressed={advanced}
      onClick={() => setAdvanced(!advanced)}
      title="Show advanced options on this page"
    >
      <Icon name="tune" />
      <span>Advanced Options</span>
      <span className={advanced ? 'toggle on' : 'toggle'} aria-hidden="true">
        <i />
      </span>
    </button>
  )
}
