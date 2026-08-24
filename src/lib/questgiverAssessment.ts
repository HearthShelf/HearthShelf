import { qgBooks, qgBuildProfile, type QgBook, type QgProfile } from '@/lib/questgiver'
import type { ABSLibraryItem, ABSLibraryItemDetail, ABSMediaProgress } from '@/api/types'

export type QgAssessmentVerdict = 'strong' | 'good' | 'mixed' | 'unlikely' | 'unknown'
export type QgAssessmentConfidence = 'high' | 'medium' | 'low'

export interface QgAssessmentTarget {
  kind: 'book' | 'series'
  title: string
  author: string
  genres: string[]
  hours: number
  itemIds: string[]
}

export interface QgAssessment {
  verdict: QgAssessmentVerdict
  confidence: QgAssessmentConfidence
  summary: string
  reasons: string[]
  caution: string | null
  engine: 'ai' | 'heuristic'
}

export interface QgAssessmentContext {
  target: QgAssessmentTarget
  profile: QgProfile
  finishedBooks: number
  startedBooks: number
  sameAuthorFinished: number
  averageListenedHours: number
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function qgBookTarget(item: ABSLibraryItem | ABSLibraryItemDetail): QgAssessmentTarget {
  const metadata = item.media.metadata
  const duration =
    'audioFiles' in item.media
      ? item.media.audioFiles.reduce((sum, file) => sum + (file.duration ?? 0), 0)
      : item.media.duration
  return {
    kind: 'book',
    title: metadata.title ?? 'Untitled',
    author:
      ('authors' in metadata ? metadata.authors[0]?.name : undefined) || metadata.authorName || '',
    genres: unique((metadata.genres ?? []).flatMap((genre) => genre.split(','))),
    hours: duration ? Math.round((duration / 3600) * 10) / 10 : 0,
    itemIds: [item.id],
  }
}

export function qgSeriesTarget(title: string, books: ABSLibraryItem[]): QgAssessmentTarget {
  const targets = books.map(qgBookTarget)
  const hours = targets.filter((target) => target.hours > 0)
  return {
    kind: 'series',
    title,
    author: targets.find((target) => target.author)?.author ?? '',
    genres: unique(targets.flatMap((target) => target.genres)),
    hours: hours.length
      ? Math.round((hours.reduce((sum, target) => sum + target.hours, 0) / hours.length) * 10) / 10
      : 0,
    itemIds: books.map((book) => book.id),
  }
}

export function qgAssessmentContext(
  target: QgAssessmentTarget,
  items: ABSLibraryItem[],
  progressById: Map<string, ABSMediaProgress>,
): QgAssessmentContext {
  const excluded = new Set(target.itemIds)
  const history = qgBooks(
    items.filter((item) => !excluded.has(item.id)),
    progressById,
  )
  const listened = history.filter((book) => book.finished || book.progress > 0)
  const finished = listened.filter((book) => book.finished)
  const started = listened.filter((book) => !book.finished)
  const sameAuthorFinished = target.author
    ? finished.filter((book) => book.author.toLowerCase() === target.author.toLowerCase()).length
    : 0
  const hours = listened
    .map((book) => (book.finished ? book.hours : book.hours * book.progress))
    .filter((value) => value > 0)

  return {
    target,
    profile: qgBuildProfile(history),
    finishedBooks: finished.length,
    startedBooks: started.length,
    sameAuthorFinished,
    averageListenedHours: hours.length
      ? Math.round((hours.reduce((sum, value) => sum + value, 0) / hours.length) * 10) / 10
      : 0,
  }
}

function bestGenre(context: QgAssessmentContext): { genre: string; weight: number } | null {
  return (
    context.target.genres
      .map((genre) => ({ genre, weight: context.profile.stat[genre]?.weight ?? 0 }))
      .sort((a, b) => b.weight - a.weight)[0] ?? null
  )
}

export function qgAssessHeuristic(context: QgAssessmentContext): QgAssessment {
  const historyCount = context.finishedBooks + context.startedBooks
  if (historyCount < 2) {
    return {
      verdict: 'unknown',
      confidence: 'low',
      summary: `I need a little more listening history before I can judge ${context.target.title} fairly.`,
      reasons: [
        historyCount === 0
          ? 'No other finished or in-progress books are available to compare yet.'
          : 'One listening signal is not enough to establish a reliable pattern.',
      ],
      caution: 'Finish or make progress on a few books, then ask again.',
      engine: 'heuristic',
    }
  }

  const genre = bestGenre(context)
  const genreScore = genre?.weight ?? 0
  const lengthDifference =
    context.target.hours > 0 && context.averageListenedHours > 0
      ? Math.abs(context.target.hours - context.averageListenedHours) / context.averageListenedHours
      : null
  const lengthScore = lengthDifference == null ? 4 : Math.max(0, 10 - lengthDifference * 8)
  const score = Math.min(
    100,
    Math.round(20 + genreScore * 5.5 + Math.min(2, context.sameAuthorFinished) * 10 + lengthScore),
  )
  const verdict: QgAssessmentVerdict =
    score >= 78 ? 'strong' : score >= 62 ? 'good' : score >= 43 ? 'mixed' : 'unlikely'
  const confidence: QgAssessmentConfidence =
    historyCount >= 8 ? 'high' : historyCount >= 4 ? 'medium' : 'low'

  const reasons: string[] = []
  if (genre && genre.weight > 0) {
    reasons.push(
      `${genre.genre} is a ${genre.weight >= 7 ? 'strong' : 'developing'} match for your listening history (${genre.weight}/10).`,
    )
  } else if (context.target.genres.length) {
    reasons.push(
      `You have little listening history in ${context.target.genres.slice(0, 2).join(' or ')}.`,
    )
  }
  if (context.sameAuthorFinished > 0) {
    reasons.push(
      `You finished ${context.sameAuthorFinished} other ${context.sameAuthorFinished === 1 ? 'book' : 'books'} by ${context.target.author}.`,
    )
  }
  if (lengthDifference != null) {
    reasons.push(
      lengthDifference <= 0.35
        ? `Its ${context.target.hours}h length is close to your usual listening range.`
        : `Its ${context.target.hours}h length is ${context.target.hours > context.averageListenedHours ? 'longer' : 'shorter'} than your ${context.averageListenedHours}h recent average.`,
    )
  }

  const subject = context.target.kind === 'series' ? 'This series' : 'This book'
  const summary =
    verdict === 'strong'
      ? `${subject} looks like a very strong fit for you.`
      : verdict === 'good'
        ? `${subject} is likely to fit your tastes.`
        : verdict === 'mixed'
          ? `${subject} could work, but the match is not clear-cut.`
          : `${subject} sits outside the patterns in your listening history.`

  return {
    verdict,
    confidence,
    summary,
    reasons: reasons.slice(0, 3),
    caution: confidence === 'low' ? 'This is an early read based on limited history.' : null,
    engine: 'heuristic',
  }
}

export function qgCraftAssessmentPrompt(context: QgAssessmentContext): string {
  const genreEvidence = context.target.genres
    .map((genre) => {
      const stat = context.profile.stat[genre]
      return `${genre}: ${stat?.weight ?? 0}/10 preference, ${stat?.finished ?? 0} finished, ${stat?.started ?? 0} started`
    })
    .join('; ')
  return [
    'You are QuestGiver, a calm audiobook librarian inside HearthShelf.',
    `Judge whether the listener is likely to enjoy this ${context.target.kind}. Use ONLY the evidence below. Do not invent plot, quality, or content details.`,
    '',
    `TARGET: ${context.target.title}${context.target.author ? ` by ${context.target.author}` : ''}`,
    `TARGET GENRES: ${context.target.genres.join(', ') || 'unknown'}`,
    `TYPICAL LENGTH: ${context.target.hours || 'unknown'} hours`,
    '',
    'LEAKAGE-FREE LISTENING HISTORY (the target and its series books are excluded):',
    `- ${context.finishedBooks} finished books and ${context.startedBooks} other started books`,
    `- Dominant genre: ${context.profile.dominant ?? 'not established'}`,
    `- Target-genre evidence: ${genreEvidence || 'none'}`,
    `- Other finished books by this author: ${context.sameAuthorFinished}`,
    `- Average listened length: ${context.averageListenedHours || 'unknown'} hours`,
    '',
    'Choose verdict strong, good, mixed, unlikely, or unknown. Confidence must be high, medium, or low.',
    'Use unknown when the history is too thin. Give 1-3 short evidence-based reasons and an optional caution.',
    'Return ONLY JSON: {"verdict":"good","confidence":"medium","summary":"one sentence","reasons":["..."],"caution":null}',
  ].join('\n')
}

// Kept here for focused tests and future clients that already have QgBook data.
export function qgListenedBooks(books: QgBook[]): QgBook[] {
  return books.filter((book) => book.finished || book.progress > 0)
}
