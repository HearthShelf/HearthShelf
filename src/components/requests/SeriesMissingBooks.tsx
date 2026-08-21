import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Icon } from '@/components/common/Icon'
import { RequestTile, type CatalogResult } from '@/components/requests/RequestTile'
import { RequestConfirmModal } from '@/components/requests/RequestConfirmModal'
import { WatchSeriesButton } from '@/components/requests/WatchButton'
import { fetchAudibleSeries, audibleKeys } from '@/api/audible'
import { useRmabEnabled } from '@/hooks/useRmab'
import { useDismissalsStore } from '@/store/dismissalsStore'
import { useFollowLookup, useFollow, useUnfollow } from '@/hooks/useSubscriptions'
import {
  missingSeriesBooks,
  isUpcoming,
  countdownLabel,
  releaseMs,
  type OwnedSeriesBook,
  type HSAudibleSeriesBook,
} from '@hearthshelf/core'

// Format a release date for a row subtitle, e.g. "Aug 19, 2026".
function releaseDateLabel(book: HSAudibleSeriesBook): string | null {
  const ms = releaseMs(book)
  if (ms === null) return null
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// One unowned roster book, as an inline series-list row. An UNRELEASED book
// can't be obtained by anyone yet, so it never offers Request/Buy - it shows
// when it lands and offers to notify you instead. A released one keeps the
// existing request/buy behaviour.
function MissingRow({
  book,
  num,
  now,
  canRequest,
  onRequest,
}: {
  book: HSAudibleSeriesBook
  num: number
  now: number
  canRequest: boolean
  onRequest: (b: CatalogResult) => void
}) {
  const upcoming = book.upcoming ?? isUpcoming(book, now)
  const dismiss = useDismissalsStore((st) => st.dismiss)
  const { bookSub } = useFollowLookup()
  const follow = useFollow()
  const unfollow = useUnfollow()
  const sub = bookSub(book.asin)
  const following = Boolean(sub)
  const busy = follow.isPending || unfollow.isPending

  const toggleFollow = () => {
    if (busy) return
    if (sub) {
      unfollow.mutate(sub.id)
      return
    }
    follow.mutate({
      kind: 'book',
      asin: book.asin,
      seriesAsin: book.seriesAsin,
      title: book.title,
      author: book.author,
      seriesTitle: book.series,
      sequence: book.sequence,
      coverArtUrl: book.coverArtUrl,
      narrator: book.narrator,
      durationMinutes: book.durationMinutes,
      releaseDate: book.releaseDate,
      publicationDatetime: book.publicationDatetime,
    })
  }

  const countdown = upcoming ? countdownLabel(book, now) : null
  const dateLabel = upcoming ? releaseDateLabel(book) : null
  const subtitle = [book.author, book.narrator].filter(Boolean).join(' · ')

  return (
    <div
      className={`sl-row sl-row-missing${upcoming ? ' sl-row-upcoming' : ''}`}
      onClick={() => (upcoming ? toggleFollow() : onRequest(book))}
    >
      <div className="sl-num">{num}</div>
      {book.coverArtUrl ? (
        <img className="sl-cover" src={book.coverArtUrl} alt="" />
      ) : (
        <div className="sl-cover" style={{ background: 'var(--c-highest)' }} />
      )}
      <div className="sl-meta">
        <div className="sl-title">{book.title}</div>
        <div className="sl-sub">{subtitle}</div>
        {upcoming && dateLabel && (
          <div className="sl-release">
            <Icon name="event_upcoming" />
            Coming {dateLabel}
            {countdown ? ` · ${countdown}` : ''}
          </div>
        )}
      </div>
      {/* "Never coming" escape hatch: Audible lists ebook-only side stories and
          print editions as series books, and they'd otherwise count against the
          series forever. */}
      <button
        className="sl-ignore-btn"
        title="Ignore this book - it won't count toward the series"
        onClick={(e) => {
          e.stopPropagation()
          if (book.asin) void dismiss('roster', book.asin, book.title).catch(() => {})
        }}
      >
        <Icon name="visibility_off" />
      </button>
      {upcoming ? (
        <span
          className={`sl-missing-tag sl-follow-tag${following ? ' on' : ''}`}
          aria-disabled={busy}
        >
          <Icon name={following ? 'notifications_active' : 'notifications'} fill={following} />
          {following ? 'Following' : 'Notify me'}
        </span>
      ) : (
        <span className="sl-missing-tag">
          <Icon name={canRequest ? 'bolt' : 'shopping_cart'} fill={canRequest} />
          {canRequest ? 'Request' : 'Not in library'}
        </span>
      )}
    </div>
  )
}

interface SeriesMissingBooksProps {
  // ABS's series id - what identifies the series when resolving its Audible
  // roster (two distinct series can share a name).
  seriesId: string
  seriesName: string
  // Owned books (title + this-series sequence) to match against the Audible
  // roster - see missingSeriesBooks for how the match is made.
  ownedBooks: OwnedSeriesBook[]
  // When true, render the missing entries as inline list rows (sl-row-missing)
  // meant to sit at the end of a series-list, instead of a separate section.
  inline?: boolean
  // Starting sequence number for inline rows (continues the owned-book numbering).
  startSeq?: number
}

// Audible entries in this series that aren't in the library. Each is requestable
// when RMAB is connected, and always buyable on Audible. Resolves the series ASIN
// via the backend (ABS exposes none); renders nothing if no series match.
// Inline mode folds the missing rows into the series list (DS sl-row-missing);
// the default renders the standalone "Complete the series" section.
export function SeriesMissingBooks({
  seriesId,
  seriesName,
  ownedBooks,
  inline,
  startSeq = 0,
}: SeriesMissingBooksProps) {
  const canRequest = useRmabEnabled()
  const ignoredAsins = useDismissalsStore((st) => st.rosterAsins)
  const [confirm, setConfirm] = useState<CatalogResult | null>(null)

  const { data } = useQuery({
    queryKey: audibleKeys.series(seriesId, seriesName),
    queryFn: () => fetchAudibleSeries(seriesId, seriesName),
    enabled: seriesName.length >= 2,
    staleTime: 30 * 60 * 1000,
    retry: false,
  })

  if (!data?.seriesAsin) return null

  const missing = missingSeriesBooks(data.books, ownedBooks, ignoredAsins, seriesName)
  if (missing.length === 0) return null

  if (inline) {
    // One `now` for the whole render so every row's countdown agrees.
    const now = Date.now()
    return (
      <>
        {missing.map((b, i) => (
          <MissingRow
            key={b.asin}
            book={b}
            num={startSeq + i + 1}
            now={now}
            canRequest={canRequest}
            onRequest={setConfirm}
          />
        ))}
        {confirm && (
          <RequestConfirmModal
            book={confirm}
            canRequest={canRequest}
            intro
            onClose={() => setConfirm(null)}
          />
        )}
      </>
    )
  }

  return (
    <div className="section">
      <div className="rmab-lane-head">
        <Icon name="travel_explore" />
        <h2>Complete the series</h2>
        <WatchSeriesButton asin={data.seriesAsin} title={data.seriesTitle ?? seriesName} />
      </div>
      <p className="rmab-lane-sub">
        {missing.length} {missing.length === 1 ? 'entry' : 'entries'} not in your library.
      </p>
      <div className="req-grid">
        {missing.map((b) => (
          <RequestTile key={b.asin} result={b} canRequest={canRequest} onRequest={setConfirm} />
        ))}
      </div>
      {confirm && <RequestConfirmModal book={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
