import { useNavigate } from 'react-router-dom'
import type { ABSSeries } from '@/api/types'
import type { SeriesGapSummary } from '@/api/audible'
import { Cover, tintFor } from '@/components/common/Cover'
import { useMediaProgress } from '@/hooks/useMediaProgress'

interface SeriesCardProps {
  series: ABSSeries
  selectionActive?: boolean
  /** Gap counts from the swept roster. Undefined when the sweep hasn't reached
   *  this series - the card then reads exactly as it did before, with no badge:
   *  "unknown" must not render as "complete". */
  gap?: SeriesGapSummary
}

export function SeriesCard({ series, selectionActive = false, gap }: SeriesCardProps) {
  const navigate = useNavigate()
  const progressById = useMediaProgress()
  const books = series.books ?? []
  const shown = books.slice(0, 4)
  const extra = books.length - shown.length
  const author = books[0]?.media.metadata.authorName || ''
  const cv = tintFor(books[0]?.media.metadata.title ?? series.name)

  // Series overall progress = average of per-book fractions; finished count is
  // the number of books marked finished.
  let done = 0
  let sum = 0
  for (const b of books) {
    const p = progressById.get(b.id)
    if (p?.isFinished) done++
    sum += p?.progress ?? 0
  }
  const pct = books.length ? sum / books.length : 0

  return (
    <div
      className="series-card"
      data-cv={cv}
      onClick={() => !selectionActive && navigate(`/series/${series.id}`, { state: { series } })}
    >
      <div className="series-stack">
        {shown.map((b) => (
          <Cover key={b.id} itemId={b.id} title={b.media.metadata.title ?? 'Untitled'} fs={7} />
        ))}
        {extra > 0 && <div className="stack-more sm">+{extra}</div>}
      </div>
      <div className="series-meta">
        <h3>{series.name}</h3>
        <p>
          {author && `${author} · `}
          {books.length} {books.length === 1 ? 'book' : 'books'} · {done} finished
        </p>
        {gap && (gap.missing > 0 || gap.upcoming > 0) && (
          <p className="sc-gap">
            {gap.missing > 0 && (
              <span className="sc-gap-missing">{gap.missing} not in library</span>
            )}
            {gap.upcoming > 0 && <span className="sc-gap-soon">{gap.upcoming} coming soon</span>}
          </p>
        )}
        <div className="sc-prog">
          <div className="prog-line" style={{ flex: 1 }}>
            <i style={{ width: pct * 100 + '%' }} />
          </div>
          <span>{Math.round(pct * 100)}%</span>
        </div>
      </div>
    </div>
  )
}
