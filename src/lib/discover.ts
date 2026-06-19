// Discover shelf generators. Builds ambient "more from your shelf" rows entirely
// from the user's own library + listening history - no backend, no AI, no RMAB.
// Reuses the taste profile from questgiver.ts so Discover and QuestGiver agree on
// what the listener actually likes.

import type { ABSLibraryItem, ABSMediaProgress } from '@/api/types'
import { qgBooks, qgBuildProfile, type QgProfile } from '@/lib/questgiver'

export interface DiscoverShelf {
  id: string
  label: string
  icon: string
  items: ABSLibraryItem[]
}

const MIN_SHELF = 3 // drop a row with fewer than this many books
const MAX_SHELVES = 6
const ROW_CAP = 18 // books per row

// Genre tokens for an item (mirrors questgiver's split of comma-joined strings).
function genresOf(item: ABSLibraryItem): string[] {
  const raw = item.media.metadata.genres ?? []
  const tokens = raw
    .flatMap((g) => g.split(','))
    .map((g) => g.trim())
    .filter(Boolean)
  return tokens.length ? [...new Set(tokens)] : []
}

interface ItemState {
  item: ABSLibraryItem
  finished: boolean
  started: boolean
  unstarted: boolean
}

function statesOf(
  items: ABSLibraryItem[],
  progressById: Map<string, ABSMediaProgress>
): ItemState[] {
  return items.map((item) => {
    const p = progressById.get(item.id)
    const finished = p?.isFinished ?? false
    const started = !finished && (p?.progress ?? 0) > 0
    return { item, finished, started, unstarted: !finished && !started }
  })
}

// Authors/narrators the listener finishes most (>= 2 finished).
function topBy(
  states: ItemState[],
  key: (i: ABSLibraryItem) => string
): string[] {
  const counts = new Map<string, number>()
  for (const s of states) {
    if (!s.finished) continue
    const k = key(s.item).trim()
    if (!k) continue
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
}

// Build all Discover shelves in priority order, de-duping books across rows.
export function buildDiscoverShelves(
  items: ABSLibraryItem[],
  progressById: Map<string, ABSMediaProgress>
): { shelves: DiscoverShelf[]; profile: QgProfile } {
  const profile = qgBuildProfile(qgBooks(items, progressById))
  const states = statesOf(items, progressById)
  const unstarted = states.filter((s) => s.unstarted).map((s) => s.item)

  const used = new Set<string>()
  const shelves: DiscoverShelf[] = []
  const take = (pool: ABSLibraryItem[]): ABSLibraryItem[] => {
    const out: ABSLibraryItem[] = []
    for (const it of pool) {
      if (used.has(it.id)) continue
      out.push(it)
      if (out.length >= ROW_CAP) break
    }
    return out
  }
  const push = (shelf: Omit<DiscoverShelf, 'items'>, pool: ABSLibraryItem[]) => {
    if (shelves.length >= MAX_SHELVES) return
    const picked = take(pool)
    if (picked.length < MIN_SHELF) return
    picked.forEach((it) => used.add(it.id))
    shelves.push({ ...shelf, items: picked })
  }

  // 1. Top genre(s) - unstarted books in the listener's strongest buckets.
  const topGenres = profile.listened
    .filter((g) => g.score > 0)
    .slice(0, 2)
    .map((g) => g.genre)
  for (const g of topGenres) {
    push(
      { id: 'genre-' + g, label: `Because you love ${g}`, icon: 'local_fire_department' },
      unstarted.filter((it) => genresOf(it).includes(g))
    )
  }

  // 2. More from authors the listener finishes.
  for (const author of topBy(states, (i) => i.media.metadata.authorName).slice(0, 2)) {
    push(
      { id: 'author-' + author, label: `More from ${author}`, icon: 'person' },
      unstarted.filter((it) => it.media.metadata.authorName.trim() === author)
    )
  }

  // 3. Narrators the listener returns to.
  const topNarrator = topBy(states, (i) => i.media.metadata.narratorName)[0]
  if (topNarrator) {
    push(
      { id: 'narrator-' + topNarrator, label: `Narrated by ${topNarrator}`, icon: 'record_voice_over' },
      unstarted.filter((it) => it.media.metadata.narratorName.trim() === topNarrator)
    )
  }

  // 4. Finish the series - unstarted owned entries in a series the listener has
  //    finished or started at least one book of.
  const touchedSeries = new Set<string>()
  for (const s of states) {
    const name = s.item.media.metadata.seriesName.trim()
    if (name && (s.finished || s.started)) touchedSeries.add(name)
  }
  const seriesGaps = unstarted.filter((it) => {
    const name = it.media.metadata.seriesName.trim()
    return name && touchedSeries.has(name)
  })
  push({ id: 'series-next', label: 'Finish the series', icon: 'auto_stories' }, seriesGaps)

  // 5. Revisit a cold genre - owned a lot, barely played.
  if (profile.cold) {
    push(
      { id: 'cold-' + profile.cold.genre, label: `Revisit ${profile.cold.genre}`, icon: 'swap_horiz' },
      unstarted.filter((it) => genresOf(it).includes(profile.cold!.genre))
    )
  }

  // 6. Fallback - unstarted owned books, most recently added first. Always present
  //    so a non-empty library never shows an empty Discover.
  push(
    { id: 'recent', label: 'Back to your library', icon: 'library_books' },
    [...unstarted].sort((a, b) => b.addedAt - a.addedAt)
  )

  return { shelves, profile }
}
