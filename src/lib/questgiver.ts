// QuestGiver recommendation engine. Builds a per-genre profile from the user's
// real library + listening progress, then scores candidates. The AI path runs
// server-side (see server/); this module owns the profile, the candidate pool,
// the deterministic heuristic fallback, and the prompt builder.
//
// Ported from the design prototype (formerly "bookdate") to TypeScript against
// real ABS data, using QuestGiver naming throughout.

import type { ABSLibraryItem, ABSMediaProgress } from '@/api/types'

export interface QgBook {
  id: string
  title: string
  author: string
  genre: string // primary bucket (first token)
  genres: string[] // all genre tokens this book belongs to
  hours: number
  rating: number
  finished: boolean
  progress: number
  owned: boolean
}

export interface QgGenreStat {
  genre: string
  finished: number
  started: number
  owned: number
  hours: number
  score: number
  weight: number
}

export interface QgProfile {
  stat: Record<string, QgGenreStat>
  listened: QgGenreStat[]
  dominant: string | null
  cold: QgGenreStat | null
  totalFin: number
}

export interface QgCandidate {
  id: string
  title: string
  author: string
  genre: string // primary bucket
  genres: string[] // all tokens (for weight matching)
  hours: number
  rating: number
  source: 'library' | 'request'
}

export interface QgAnswers {
  direction: 'more' | 'switch' | 'new'
  mood?: string
  length?: 'any' | 'short' | 'standard' | 'epic'
  familiarity?: number
  narratorAffinity?: boolean
  includeRequest?: boolean
  weights: Record<string, number>
  count?: number
}

export interface QgPick {
  id: string
  reason: string
}
export interface QgNewPick {
  title: string
  author: string
  genre: string
  hours: number
  reason: string
}
export interface QgResult {
  intro: string
  picks: QgPick[]
  newPicks: QgNewPick[]
  engine: 'ai' | 'heuristic'
}

// A pick resolved against the real library, ready to render. `kind` is always
// 'library' today; 'request'/'new' light up with the ReadMeABook backend.
export interface QgRenderedPick {
  key: string // title|author lowercase - feedback + repeat detection
  kind: 'library' | 'request' | 'new'
  itemId?: string
  title: string
  author: string
  genre: string
  hours: number
  reason: string
  priorCount: number
}

// Genres surfaced as "explore" sliders when RMAB request is enabled - things the
// listener may not own yet.
export const QG_EXPLORE_GENRES = [
  'LitRPG',
  'Thriller',
  'Mystery',
  'Romance',
  'Horror',
  'History',
]

// ABS often stores genres as comma-joined multi-genre strings
// ("Mystery, Thriller & Suspense, Science Fiction & Fantasy"). Split into clean
// tokens so weighting works on real buckets, not dozens of near-duplicate combos.
function genresOf(item: ABSLibraryItem): string[] {
  const raw = item.media.metadata.genres ?? []
  const tokens = raw
    .flatMap((g) => g.split(','))
    .map((g) => g.trim())
    .filter(Boolean)
  return tokens.length ? [...new Set(tokens)] : ['Unsorted']
}

// The primary genre bucket for a book (first token).
function genreOf(item: ABSLibraryItem): string {
  return genresOf(item)[0]
}

function hoursOf(item: ABSLibraryItem): number {
  const dur = item.media.duration ?? 0
  return dur ? Math.round((dur / 3600) * 10) / 10 : 0
}

// Build the QgBook view of the library, merging in progress.
export function qgBooks(
  items: ABSLibraryItem[],
  progressById: Map<string, ABSMediaProgress>
): QgBook[] {
  return items.map((it) => {
    const p = progressById.get(it.id)
    return {
      id: it.id,
      title: it.media.metadata.title ?? 'Untitled',
      author: it.media.metadata.authorName ?? '',
      genre: genreOf(it),
      genres: genresOf(it),
      hours: hoursOf(it),
      rating: 4, // ABS does not expose a numeric per-item rating; neutral default
      finished: p?.isFinished ?? false,
      progress: p?.progress ?? 0,
      owned: true,
    }
  })
}

// Per-genre listening profile. "listened" = finished or in-progress; finished
// weighted heavier. Weights normalize to 0-10.
export function qgBuildProfile(books: QgBook[]): QgProfile {
  const stat: Record<string, QgGenreStat> = {}
  const bump = (g: string, k: 'finished' | 'started' | 'owned', h = 0) => {
    stat[g] = stat[g] || {
      genre: g,
      finished: 0,
      started: 0,
      owned: 0,
      hours: 0,
      score: 0,
      weight: 0,
    }
    stat[g][k]++
    if (h) stat[g].hours += h
  }
  // Count a book toward every genre token it carries, so multi-genre titles
  // strengthen each real bucket (hours split evenly to avoid double-counting).
  for (const b of books) {
    const gs = b.genres.length ? b.genres : [b.genre]
    const share = b.hours / gs.length
    for (const g of gs) {
      bump(g, 'owned')
      if (b.finished) bump(g, 'finished', share)
      else if (b.progress > 0) bump(g, 'started', share * b.progress)
    }
  }
  const listened = Object.values(stat)
  listened.forEach((x) => {
    x.score = x.finished * 2 + x.started
  })
  const maxScore = Math.max(1, ...listened.map((x) => x.score))
  listened.forEach((x) => {
    x.weight =
      x.score > 0
        ? Math.max(2, Math.round((x.score / maxScore) * 10))
        : x.owned > 0
          ? 1
          : 0
  })
  listened.sort((a, b) => b.score - a.score)
  const played = listened.filter((x) => x.score > 0)
  const dominant = played[0]?.genre ?? null
  const cold =
    listened
      .filter((x) => x.genre !== dominant && x.owned >= 2 && x.score <= 1)
      .sort((a, b) => b.owned - a.owned)[0] ?? null
  const totalFin = listened.reduce((n, x) => n + x.finished, 0)
  return { stat, listened, dominant, cold, totalFin }
}

// Library candidate pool: owned books not finished and not in progress.
export function qgLibraryCandidates(books: QgBook[]): QgCandidate[] {
  return books
    .filter((b) => !b.finished && !(b.progress > 0))
    .map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      genre: b.genre,
      genres: b.genres,
      hours: b.hours,
      rating: b.rating,
      source: 'library' as const,
    }))
}

// Deterministic heuristic recommender. Always available, no backend, no RMAB.
export function qgHeuristic(
  profile: QgProfile,
  answers: QgAnswers,
  candidates: QgCandidate[],
  rand: () => number = Math.random
): Omit<QgResult, 'engine'> {
  const w = answers.weights || {}
  // A candidate's weight is the best weight across all its genre tokens.
  const weightOf = (c: QgCandidate): number =>
    Math.max(0, ...c.genres.map((g) => w[g] || 0))
  const dirBoost = (c: QgCandidate): number => {
    if (answers.direction === 'more' && profile.dominant && c.genres.includes(profile.dominant))
      return 4
    if (answers.direction === 'switch' && profile.cold && c.genres.includes(profile.cold.genre))
      return 5
    return 0
  }
  const lenOk = (c: QgCandidate): boolean => {
    if (!answers.length || answers.length === 'any') return true
    if (answers.length === 'short') return c.hours > 0 && c.hours < 8
    if (answers.length === 'standard') return c.hours >= 8 && c.hours <= 15
    return c.hours > 15
  }
  const scored = candidates
    .filter(lenOk)
    .map((c) => ({
      c,
      s: weightOf(c) + (c.rating - 4) * 2 + dirBoost(c) + rand() * 0.5,
    }))
    .filter((x) => weightOf(x.c) > 0 || x.s > 2)
    .sort((a, b) => b.s - a.s)

  const reasons = {
    more: (g: string) =>
      `Right in your ${g} wheelhouse - exactly the lane you've been listening in.`,
    switch: (g: string) =>
      `A strong ${g} pick to pull you back into a genre you've let go cold.`,
    new: (g: string) =>
      `A well-reviewed ${g} listen to stretch your shelf in a new direction.`,
  }
  const count = answers.count ?? (answers.includeRequest ? 5 : 4)
  const picks: QgPick[] = scored.slice(0, count).map((x) => ({
    id: x.c.id,
    reason: (reasons[answers.direction] ?? reasons.more)(x.c.genre),
  }))

  const intro = profile.dominant
    ? `Based on ${profile.totalFin} finished ${profile.totalFin === 1 ? 'book' : 'books'} - mostly ${profile.dominant} - here's where I'd point you next.`
    : "Here's where I'd point you next."
  return { intro, picks, newPicks: [] }
}

// Build the AI prompt. The server attaches no extra context, so this is the
// full instruction. Candidates are listed as "id | title — author | genre | Xh".
export function qgCraftPrompt(
  profile: QgProfile,
  answers: QgAnswers,
  candidates: QgCandidate[]
): string {
  const w = answers.weights || {}
  const weightLines = Object.entries(w)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([g, v]) => `  ${g}: ${v}/10`)
    .join('\n')
  const pool = candidates
    .map((c) => `${c.id} | ${c.title} — ${c.author} | ${c.genre} | ${c.hours}h`)
    .join('\n')
  return [
    'You are QuestGiver, an audiobook matchmaker inside HearthShelf. Recommend the listener\'s next books.',
    '',
    'LISTENER PROFILE:',
    `- Finished ${profile.totalFin} books; dominant genre lately: ${profile.dominant || 'varied'}.`,
    profile.cold
      ? `- Owns ${profile.cold.owned} ${profile.cold.genre} titles but rarely plays them (gone cold).`
      : '',
    `- Direction they chose: ${answers.direction} (more=stay in lane, switch=revive a cold genre, new=explore).`,
    answers.mood ? `- In the mood for: ${answers.mood}` : '',
    answers.length && answers.length !== 'any'
      ? `- Length preference: ${answers.length}`
      : '',
    answers.familiarity != null
      ? `- New-voice appetite (0 known authors .. 10 all new): ${answers.familiarity}/10`
      : '',
    answers.narratorAffinity ? '- Favors their trusted narrators.' : '',
    '',
    'GENRE WEIGHTS (higher = wants more):',
    weightLines || '  (none set)',
    '',
    'CANDIDATES (id | title — author | genre | length):',
    pool,
    '',
    `Pick ${answers.count ?? 5} from the candidate ids, ordered best-first, honoring the weights and direction.`,
    'Each reason is ONE warm, specific sentence in a calm librarian voice.',
    'Return ONLY JSON, no prose: {"intro":"one sentence","picks":[{"id":"...","reason":"..."}],"newPicks":[]}',
  ]
    .filter(Boolean)
    .join('\n')
}
