import { useAuthStore } from '@/store/authStore'
import type { AutoRulePref, QueueEntry } from '@hearthshelf/core'

export interface QueueDebugSource {
  ruleId: string
  ruleLabel: string
  result: 'included' | 'excluded' | 'matched' | 'not_candidate' | 'modifier'
  reason: string
  seriesId?: string
  seriesName?: string
  sourceIndex?: number
  clubs?: { id: string; name: string }[]
}

export interface QueueDebugRule {
  id: string
  label: string
  priority: number
  enabled: boolean
  added: number
  attempts: Array<{
    result: string
    reason: string
    seriesId?: string
    seriesName?: string
    sourceIndex?: number
    clubs?: { id: string; name: string }[]
  }>
}

export interface QueueDebugTarget {
  libraryItemId: string
  title: string | null
  author: string | null
  inVisibleLibrary: boolean
  existsOnServer?: boolean
  hiddenByPermissions?: boolean
  isCurrentItem: boolean
  isFinished: boolean
  dismissedItem: boolean
  included: boolean
  position: number | null
  winningRule: string | null
  progress: {
    progress: number
    currentTime: number
    duration: number
    isFinished: boolean
    lastUpdate: number
  } | null
  series: { id: string; name: string; dismissed: boolean; sequence: string | null }[]
  sources: QueueDebugSource[]
  rules: QueueDebugRule[]
  notes: string[]
}

export interface QueueDebugReport {
  generatedAt: number
  user: { id: string; username: string; type: string }
  mode: string
  rules: AutoRulePref[]
  current: { id: string | null; source: string }
  stored: {
    items: QueueEntry[]
    manual: QueueEntry[]
    currentItemId: string | null
    updatedAt: number
  }
  inputs: {
    libraries: { id: string; name: string }[]
    libraryItems: number
    series: number
    progressRows: number
    clubs: Array<{
      id: string
      name: string
      books: Array<QueueEntry & { slot: string; sourceIndex: number }>
    }>
    clubBooks: number
    manualBooks: number
    dismissals: {
      items: { id: string; title: string | null }[]
      series: { id: string; title: string | null }[]
    }
    hiddenByPermissions: number
  }
  result: {
    parity: boolean
    sameOrder: boolean
    queue: Array<
      QueueEntry & {
        position: number
        winningRule: string | null
        sources: QueueDebugSource[]
        storedPosition: number
      }
    >
    storedOnly: QueueEntry[]
    computedOnly: QueueEntry[]
  }
  target: QueueDebugTarget | null
  warnings: string[]
}

export async function getQueueDebugReport(
  userId: string,
  itemId?: string,
): Promise<QueueDebugReport> {
  const token = useAuthStore.getState().token
  const query = new URLSearchParams({ userId })
  if (itemId?.trim()) query.set('itemId', itemId.trim())
  const response = await fetch(`/hs/admin/queue-debug?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(body?.detail ?? `Queue debugger failed (${response.status})`)
  }
  return response.json() as Promise<QueueDebugReport>
}
