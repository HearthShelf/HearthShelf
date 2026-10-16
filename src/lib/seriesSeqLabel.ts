import type { ABSLibraryItem } from '@/api/types'

/**
 * The book's own series number as written, for the reading-order column:
 * "Foundation #2.5" -> "2.5", an omnibus "Series #1-3.5" -> "1-3.5". A row's
 * position in the list is not its number - an omnibus or a half-step novella
 * shifts every row after it. '' when the book has no sequence.
 */
export function seriesSeqLabel(item: ABSLibraryItem): string {
  return seqLabel(item.media.metadata.seriesName?.match(/#\s*([\d.]+(?:\s*-\s*[\d.]+)?)\s*$/)?.[1])
}

export function seqLabel(sequence: string | null | undefined): string {
  return (sequence ?? '').replace(/\s+/g, '')
}

export type SeriesListRow<M> =
  { kind: 'owned'; book: ABSLibraryItem } | { kind: 'missing'; book: M }

/**
 * Fold the books the library doesn't have into the owned reading order, each at
 * its own place in the series, so a novella like #10.5 sits between 10 and 11
 * rather than after the last owned book. `owned` arrives in reading order.
 * An owned book wins a tie; a missing book with no sequence goes last.
 */
export function interleaveMissing<M extends { sequence?: string | null }>(
  owned: ABSLibraryItem[],
  missing: M[],
): SeriesListRow<M>[] {
  const ownedKey = (b: ABSLibraryItem) =>
    Number(b.media.metadata.seriesName?.match(/#?([\d.]+)\s*$/)?.[1] ?? 0)
  const missingKey = (m: M) => {
    const n = Number(m.sequence?.match(/([\d.]+)\s*$/)?.[1])
    return Number.isFinite(n) ? n : Infinity
  }
  const queue = [...missing].sort((a, b) => {
    const x = missingKey(a)
    const y = missingKey(b)
    return x === y ? 0 : x < y ? -1 : 1
  })
  const rows: SeriesListRow<M>[] = []
  let j = 0
  for (const book of owned) {
    while (j < queue.length && missingKey(queue[j]) < ownedKey(book)) {
      rows.push({ kind: 'missing', book: queue[j++] })
    }
    rows.push({ kind: 'owned', book })
  }
  while (j < queue.length) rows.push({ kind: 'missing', book: queue[j++] })
  return rows
}
