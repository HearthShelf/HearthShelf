import { useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getLibraries, getOneSeries, libraryKeys } from '@/api/libraries'
import { fetchAudibleSeries, audibleKeys } from '@/api/audible'
import { missingSeriesBooks, ownedKeyOf, seriesCompletion } from '@hearthshelf/core'
import { useAuth } from '@/hooks/useAuth'
import { usePlayer } from '@/hooks/usePlayer'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { useMarkFinished } from '@/hooks/useMarkFinished'
import { useIsMobile } from '@/hooks/useMediaQuery'
import type { ABSLibraryItem, ABSSeries } from '@/api/types'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { BookContextMenu } from '@/components/library/BookContextMenu'
import { SeriesMissingBooks } from '@/components/requests/SeriesMissingBooks'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

// Books ordered by their series sequence number when present.
function orderBooks(books: ABSLibraryItem[]): ABSLibraryItem[] {
  return [...books].sort((a, b) => {
    const sa = Number(a.media.metadata.seriesName?.match(/#?([\d.]+)\s*$/)?.[1] ?? 0)
    const sb = Number(b.media.metadata.seriesName?.match(/#?([\d.]+)\s*$/)?.[1] ?? 0)
    return sa - sb
  })
}

// Count-aware cover cluster: 1 solo, 2 stacked, 3 two+one, 4+ a 2x2 square
// with an optional centered 5th carrying a "+N" overflow chip.
function HeroCovers({ books }: { books: ABSLibraryItem[] }) {
  const n = books.length
  const layout = n >= 4 ? 'square' : n === 3 ? 'tri' : n === 2 ? 'duo' : 'solo'
  const cover = (b: ABSLibraryItem, fs: number) => (
    <Cover key={b.id} itemId={b.id} title={b.media.metadata.title ?? 'Untitled'} fs={fs} />
  )

  return (
    <div className={'hero-covers ' + layout}>
      {layout === 'solo' && cover(books[0], 13)}
      {layout === 'duo' && books.slice(0, 2).map((b) => cover(b, 11))}
      {layout === 'tri' && (
        <>
          <div className="hc-row">{books.slice(0, 2).map((b) => cover(b, 10))}</div>
          <div className="hc-btm">{cover(books[2], 10)}</div>
        </>
      )}
      {layout === 'square' && (
        <>
          <div className="hc-grid">{books.slice(0, 4).map((b) => cover(b, 8))}</div>
          {n >= 5 && (
            <div className="hc-center">
              <div className="hc-fifth">
                {cover(books[4], 8)}
                {n > 5 && <span className="hc-more">+{n - 5}</span>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SeriesDetail({ series }: { series: ABSSeries }) {
  const navigate = useNavigate()
  const { playItem } = usePlayer()
  const progressById = useMediaProgress()
  const { markFinished, isPending: marking } = useMarkFinished()
  const isMobile = useIsMobile()
  const books = orderBooks(series.books ?? [])
  const author = books[0]?.media.metadata.authorName || ''
  const cv = tintFor(books[0]?.media.metadata.title ?? series.name)
  const ownedKeys = new Set(
    books.map((b) => ownedKeyOf(b.media.metadata.title, b.media.metadata.authorName)),
  )

  // The full Audible roster for this series (cached; SeriesMissingBooks reuses the
  // same query). The unowned gap enlarges the completion denominator so the % and
  // the segment track reflect the whole series, not just what's owned.
  const { data: audible } = useQuery({
    queryKey: audibleKeys.series(series.name),
    queryFn: () => fetchAudibleSeries(series.name),
    enabled: series.name.length >= 2,
    staleTime: 30 * 60 * 1000,
    retry: false,
  })
  const missing = audible?.seriesAsin ? missingSeriesBooks(audible.books, ownedKeys) : []

  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const clearSel = () => {
    setSelected(new Set())
    setSelectMode(false)
  }
  const selectAll = () => setSelected(new Set(books.map((b) => b.id)))

  const allSeriesFinished =
    books.length > 0 && books.every((b) => progressById.get(b.id)?.isFinished)
  // Quick-mark the whole series: finish all, or unfinish if already all done.
  const markSeries = () => {
    if (!books.length) return
    void markFinished(
      books.map((b) => b.id),
      !allSeriesFinished,
    )
  }
  // Mark the current selection, toggling off if every selected book is finished.
  const markSelection = () => {
    const ids = [...selected]
    if (!ids.length) return
    const allFinished = ids.every((id) => progressById.get(id)?.isFinished)
    void markFinished(ids, !allFinished).then(clearSel)
  }

  // Per-book progress, finished count, totals.
  let done = 0
  let sum = 0
  let totalHours = 0
  for (const b of books) {
    const p = progressById.get(b.id)
    if (p?.isFinished) done++
    sum += p?.isFinished ? 1 : (p?.progress ?? 0)
    totalHours += (b.media.duration ?? 0) / 3600
  }
  const completion = seriesCompletion({
    ownedProgressSum: sum,
    ownedCount: books.length,
    missingCount: missing.length,
  })
  const pct = completion.pct
  // Listened hours are an owned-books figure (we have no runtime for unowned
  // books), so scale by owned progress, not the full-series percentage.
  const listenedHours = books.length ? totalHours * (sum / books.length) : 0

  // Next up = first unfinished in reading order, else the first book.
  const nextUpIdx = books.findIndex((b) => !progressById.get(b.id)?.isFinished)
  const nextUp = nextUpIdx === -1 ? books[0] : books[nextUpIdx]
  const nextUpNum = (nextUpIdx === -1 ? 0 : nextUpIdx) + 1

  // Shared progress widgets (segment track + bottom hours bar).
  const progEl = (
    <div className="series-prog">
      <div className="sp-top">
        <span className="sp-pct">{Math.round(pct * 100)}%</span>
        <span className="sp-cap">
          {done} of {completion.totalCount} finished · {listenedHours.toFixed(0)}h of{' '}
          {totalHours.toFixed(0)}h
          {completion.missingCount > 0 && ` · ${completion.missingCount} not in library`}
        </span>
      </div>
      <div className="sp-track">
        {books.map((b, i) => {
          const p = progressById.get(b.id)
          const fin = p?.isFinished
          const part = !fin && (p?.progress ?? 0) > 0
          const status = fin
            ? 'finished'
            : part
              ? `${Math.round((p?.progress ?? 0) * 100)}%`
              : 'not started'
          return (
            <div
              key={b.id}
              className={'sp-seg' + (fin ? ' done' : '') + (part ? ' part' : '')}
              title={`Book ${i + 1} · ${status}`}
            >
              {part && <i style={{ width: (p?.progress ?? 0) * 100 + '%' }} />}
            </div>
          )
        })}
        {missing.map((b, i) => (
          <div
            key={b.asin}
            className="sp-seg missing"
            title={`Book ${books.length + i + 1} · not in library`}
          />
        ))}
      </div>
    </div>
  )
  const heroProg = (
    <div className="hero-prog">
      <div className="hp-fill" style={{ width: pct * 100 + '%' }}>
        <span className="hp-head" />
      </div>
    </div>
  )

  const hero = isMobile ? (
    <div className="series-hero mob">
      <div className="eyebrow">Series</div>
      <h1 className="series-mtitle">{series.name}</h1>
      {author && <div className="series-msub">{author}</div>}
      <div className="series-mstats">
        <span>
          <b>{books.length}</b>books
        </span>
        <span>
          <b>{totalHours.toFixed(0)}h</b>total
        </span>
        <span>
          <b>
            {done}/{completion.totalCount}
          </b>
          finished
        </span>
      </div>
      {progEl}
      {nextUp && (
        <button className="btn btn-primary mob-cta" onClick={() => void playItem(nextUp.id)}>
          <Icon name="play_arrow" fill /> Continue · Book {nextUpNum}
        </button>
      )}
      <div className="mob-actions">
        <button className="pill" disabled={marking} onClick={markSeries}>
          <Icon name={allSeriesFinished ? 'remove_done' : 'done_all'} />{' '}
          {allSeriesFinished ? 'Not finished' : 'Mark finished'}
        </button>
      </div>
      {heroProg}
    </div>
  ) : (
    <div className="series-hero">
      <HeroCovers books={books} />
      <div className="series-hero-meta">
        <div className="eyebrow">Series</div>
        <h1 className="title-xl">{series.name}</h1>
        <div style={{ color: 'var(--text-muted)', fontSize: 14.5, margin: '8px 0 18px' }}>
          {author && `${author} · `}
          {books.length} {books.length === 1 ? 'book' : 'books'} · {totalHours.toFixed(0)}h total
          {completion.missingCount > 0 && ` · ${completion.missingCount} not in library`}
        </div>

        {progEl}

        <div style={{ display: 'flex', gap: 12, marginTop: 22, flexWrap: 'wrap' }}>
          {nextUp && (
            <button className="btn btn-primary" onClick={() => void playItem(nextUp.id)}>
              <Icon name="play_arrow" fill /> Continue · Book {nextUpNum}
            </button>
          )}
          <button className="pill" disabled={marking} onClick={markSeries}>
            <Icon name={allSeriesFinished ? 'remove_done' : 'done_all'} />{' '}
            {allSeriesFinished ? 'Mark series unfinished' : 'Mark series finished'}
          </button>
        </div>
      </div>

      {heroProg}
    </div>
  )

  return (
    <div className="page fade-in" style={{ ['--glow-accent' as string]: cv }}>
      <button
        className="pill"
        style={{ marginBottom: isMobile ? 16 : 24 }}
        onClick={() => navigate('/library?tab=series')}
      >
        <Icon name="arrow_back" /> Library
      </button>

      {hero}

      <div className="section">
        {selected.size > 0 ? (
          <div className="toolbar2 sel-bar">
            <button className="pill" onClick={clearSel} title="Clear selection">
              <Icon name="close" />
            </button>
            <span className="count-badge" style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {selected.size} selected
            </span>
            {selected.size < books.length && (
              <button className="pill" onClick={selectAll}>
                Select all {books.length}
              </button>
            )}
            <div className="tb-spacer" />
            <button className="pill" disabled={marking} onClick={markSelection}>
              <Icon name="task_alt" />{' '}
              {[...selected].every((id) => progressById.get(id)?.isFinished)
                ? 'Mark not finished'
                : 'Mark finished'}
            </button>
          </div>
        ) : (
          <div className="series-list-head">
            <SectionHead icon="format_list_numbered" title="In reading order" />
            <button
              className={'pill' + (selectMode ? ' on' : '')}
              onClick={() => setSelectMode((v) => !v)}
            >
              <Icon name="checklist" /> {selectMode ? 'Done' : 'Select'}
            </button>
          </div>
        )}
        <div className="series-list">
          {books.map((b, i) => {
            const m = b.media.metadata
            const p = progressById.get(b.id)
            const fin = p?.isFinished
            const part = !fin && (p?.progress ?? 0) > 0
            const hours = b.media.duration ? Math.round(b.media.duration / 360) / 10 : 0
            const isSel = selected.has(b.id)
            const active = selectMode || selected.size > 0
            return (
              <BookContextMenu
                key={b.id}
                item={b}
                progress={p?.progress}
                finished={fin}
                seriesId={series.id}
                seriesName={series.name}
              >
                <div
                  className={'sl-row' + (isSel ? ' sel' : '')}
                  data-cv={tintFor(m.title ?? 'Untitled')}
                  onClick={() => (active ? toggleSel(b.id) : navigate(`/book/${b.id}`))}
                >
                  {active ? (
                    <button
                      className={'b-check sl-check' + (isSel ? ' on' : '')}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleSel(b.id)
                      }}
                      aria-label={isSel ? 'Deselect' : 'Select'}
                    >
                      <Icon name="check" fill style={{ opacity: isSel ? 1 : 0 }} />
                    </button>
                  ) : (
                    <div className="sl-num">{i + 1}</div>
                  )}
                  <Cover itemId={b.id} title={m.title ?? 'Untitled'} fs={6} className="sl-cover" />
                  <div className="sl-meta">
                    <div className="sl-title">
                      {m.title}
                      {fin && (
                        <Icon
                          name="check_circle"
                          fill
                          style={{
                            fontSize: 16,
                            color: 'var(--text-muted)',
                            marginLeft: 8,
                            verticalAlign: '-3px',
                          }}
                        />
                      )}
                    </div>
                    <div className="sl-sub">
                      {[m.narratorName, hours > 0 && `${hours}h`].filter(Boolean).join(' · ')}
                    </div>
                    {part && (
                      <div className="prog-line" style={{ marginTop: 8, maxWidth: 280 }}>
                        <i style={{ width: (p?.progress ?? 0) * 100 + '%' }} />
                      </div>
                    )}
                  </div>
                  <div className="sl-rating" />
                  <button
                    className="icon-btn sl-play"
                    onClick={(e) => {
                      e.stopPropagation()
                      void playItem(b.id)
                    }}
                    aria-label="Play"
                  >
                    <Icon name="play_arrow" fill />
                  </button>
                </div>
              </BookContextMenu>
            )
          })}
          {selected.size === 0 && (
            <SeriesMissingBooks
              seriesName={series.name}
              ownedKeys={ownedKeys}
              inline
              startSeq={books.length}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export function SeriesDetailPage() {
  const { seriesId } = useParams()
  const location = useLocation()
  const passed = (location.state as { series?: ABSSeries } | null)?.series
  const { defaultLibraryId } = useAuth()
  const { data: librariesData } = useQuery({
    queryKey: libraryKeys.all,
    queryFn: getLibraries,
    staleTime: 5 * 60 * 1000,
  })
  const libraryId = defaultLibraryId ?? librariesData?.libraries[0]?.id ?? null

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['series-detail', libraryId, seriesId],
    queryFn: () => getOneSeries(libraryId!, seriesId!),
    enabled: libraryId !== null && Boolean(seriesId) && !passed,
    staleTime: 2 * 60 * 1000,
  })

  // Deep-linked from the index: render immediately from router state.
  if (passed) return <SeriesDetail series={passed} />

  if (isLoading) {
    return (
      <div className="page">
        <LoadingSpinner className="py-12" label="Loading series..." />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="page">
        <ErrorState message="Could not load this series." onRetry={refetch} />
      </div>
    )
  }
  return <SeriesDetail series={data} />
}
