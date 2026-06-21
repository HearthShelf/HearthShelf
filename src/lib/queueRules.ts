import type { ABSLibraryItem, ABSMediaProgress, ABSSeries } from '@/api/types'
import type { QueueEntry, AutoRuleId } from '@/store/queueStore'
import type { AutoRulePref } from '@/store/settingsStore'

interface BuildArgs {
  // All books in the active library (minified list shape).
  items: ABSLibraryItem[]
  // The library's series, books ordered by sequence (ABS series response order).
  series: ABSSeries[]
  // Per-item listening progress, keyed by libraryItemId.
  progressById: Map<string, ABSMediaProgress>
  // The book currently playing (excluded from the queue).
  currentItemId: string | null
  // Ordered, enabled rules (array order = priority).
  rules: AutoRulePref[]
}

function entryOf(item: ABSLibraryItem): QueueEntry {
  const m = item.media.metadata
  return {
    libraryItemId: item.id,
    title: m.title ?? 'Untitled',
    author: m.authorName ?? '',
  }
}

function isFinished(
  id: string,
  progressById: Map<string, ABSMediaProgress>
): boolean {
  return !!progressById.get(id)?.isFinished
}

function isStarted(
  id: string,
  progressById: Map<string, ABSMediaProgress>
): boolean {
  const p = progressById.get(id)
  return !!p && !p.isFinished && p.progress > 0
}

// Build the Auto-mode up-next list. Pure: same inputs -> same output. Rules run
// in priority order; each appends its books, then we de-dupe (first rule wins),
// drop the current book and anything finished.
export function buildAutoQueue({
  items,
  series,
  progressById,
  currentItemId,
  rules,
}: BuildArgs): QueueEntry[] {
  const itemById = new Map(items.map((i) => [i.id, i]))
  // Series that contain the current book (for "finish current series").
  const seriesOf = (id: string) =>
    series.filter((s) => s.books.some((b) => b.id === id))

  const collected: string[] = []
  const push = (id: string) => {
    if (id === currentItemId) return
    if (!itemById.has(id)) return
    if (isFinished(id, progressById)) return
    if (!collected.includes(id)) collected.push(id)
  }

  for (const rule of rules) {
    if (!rule.on) continue
    applyRule(rule.id)
  }

  function applyRule(id: AutoRuleId) {
    if (id === 'finish-series') {
      if (!currentItemId) return
      for (const s of seriesOf(currentItemId)) {
        const idx = s.books.findIndex((b) => b.id === currentItemId)
        // Books after the current one, in sequence order.
        for (const b of s.books.slice(idx + 1)) push(b.id)
      }
    } else if (id === 'in-progress') {
      // Other books the user has started but not finished.
      for (const it of items) {
        if (isStarted(it.id, progressById)) push(it.id)
      }
    } else if (id === 'new-in-series') {
      // Series the user has started (any book finished or in progress) but not
      // completed: queue the remaining unfinished books in sequence.
      for (const s of series) {
        const touched = s.books.some(
          (b) => isFinished(b.id, progressById) || isStarted(b.id, progressById)
        )
        const complete = s.books.every((b) => isFinished(b.id, progressById))
        if (!touched || complete) continue
        for (const b of s.books) {
          if (!isFinished(b.id, progressById)) push(b.id)
        }
      }
    }
  }

  return collected.map((id) => entryOf(itemById.get(id) as ABSLibraryItem))
}
