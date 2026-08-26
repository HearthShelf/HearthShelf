import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  getDebuggableSeries,
  getSeriesDebugReport,
  resweepSeries,
  type SeriesDebugMatch,
  type SeriesDebugReport,
  type SeriesDebugRosterBook,
} from '@/api/seriesDebug'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { RawJson } from '@/components/config/RawJson'

// Why a series shows the books it shows.
//
// The pipeline behind "you're missing book 10" has four stages, and the UI only
// ever shows the verdict. This page shows each stage's reasoning, so a wrong
// answer can be READ rather than guessed at:
//
//   1. Resolution - which Audible series this name bound to, and what else ran
//   2. Roster     - the raw children, and what filtering dropped (and why)
//   3. Matching   - per book, which signal claimed it, or why each was refused
//   4. Stored     - the precomputed roster vs a fresh live resolve
//
// The single highest-value column is "normalized title": the string the matcher
// actually compares. When it reads as the series name plus a number instead of
// the book's own name, the series-prefix strip missed - the failure that hid
// whole series behind "titles contradict" refusals.

function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : 'never'
}

function Pill({ tone, children }: { tone: 'good' | 'warn' | 'bad'; children: React.ReactNode }) {
  const colors = {
    good: { color: '#83c77a', borderColor: 'rgba(131,199,122,.35)' },
    warn: { color: '#e0a25b', borderColor: 'rgba(224,162,91,.35)' },
    bad: { color: '#e8897f', borderColor: 'rgba(232,137,127,.35)' },
  }[tone]
  return (
    <span className="pill" style={colors}>
      {children}
    </span>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ minWidth: 150 }}>
      <div style={{ color: 'var(--text-faint)', fontSize: 11, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ marginTop: 3, overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  )
}

// A normalized title that still carries the series name plus a number is the
// signature of a failed prefix strip. Flagging it inline is the whole reason
// this column is here.
function suspectNormalization(book: { title: string; normalizedTitle: string }, series: string) {
  const norm = book.normalizedTitle.trim()
  if (!norm) return false
  const seriesNorm = series
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!seriesNorm) return false
  // "federation marine 2" - the series name plus a bare number, with the book's
  // own name gone. The un-numbered exact match is legitimate (a title that IS
  // just the series name), so only the numbered form is suspect.
  return new RegExp(`^${seriesNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d`).test(norm)
}

function ResolutionCard({ report }: { report: SeriesDebugReport }) {
  const res = report.resolution
  if (!res) return null
  return (
    <section className="cfg-card" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: '0 0 10px' }}>1 · Series resolution</h3>
      {res.matched ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
          <Fact label="Searched for" value={<code>{res.query}</code>} />
          <Fact label="Matched series" value={res.matched.title} />
          <Fact label="Series ASIN" value={<code>{res.matched.asin}</code>} />
          <Fact label="Votes" value={res.votes} />
          <Fact
            label="Author hits"
            value={
              res.authorHits > 0 ? (
                <Pill tone="good">{res.authorHits} agree</Pill>
              ) : (
                <Pill tone="warn">none — popularity only</Pill>
              )
            }
          />
          <Fact
            label="Library authors"
            value={res.ownedAuthors.length ? res.ownedAuthors.join(', ') : '—'}
          />
        </div>
      ) : (
        <div className="rr-err">
          <Icon name="error" fill /> No Audible series matched “{res.query}”. Nothing downstream can
          run, so this series shows owned books only.
        </div>
      )}
    </section>
  )
}

function RosterCard({ report }: { report: SeriesDebugReport }) {
  const [showDropped, setShowDropped] = useState(true)
  const books = report.roster.books
  const shown = showDropped ? books : books.filter((b) => b.kept)
  const ordered = useMemo(
    () =>
      [...shown].sort((a, b) => (parseFloat(a.sequence) || 999) - (parseFloat(b.sequence) || 999)),
    [shown],
  )
  if (!report.roster.seriesAsin) return null

  const droppedCount = books.filter((b) => !b.kept).length
  return (
    <section className="cfg-card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0, flex: 1 }}>2 · Audible roster</h3>
        <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
          {report.roster.rawCount} children → {report.roster.keptCount} real books
          {droppedCount ? ` · ${droppedCount} dropped` : ''}
        </span>
        {droppedCount > 0 && (
          <button className="btn-sm btn-ghost" onClick={() => setShowDropped((v) => !v)}>
            {showDropped ? 'Hide dropped' : 'Show dropped'}
          </button>
        )}
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 52 }}>Seq</th>
              <th>Audible title</th>
              <th>Normalized</th>
              <th>Released</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((b) => (
              <RosterRow key={b.asin ?? b.title} book={b} series={report.name} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function RosterRow({ book, series }: { book: SeriesDebugRosterBook; series: string }) {
  const suspect = suspectNormalization(book, series)
  return (
    <tr style={{ opacity: book.kept ? 1 : 0.5 }}>
      <td style={{ color: 'var(--text-muted)' }}>{book.sequence || '—'}</td>
      <td>
        <div style={{ fontWeight: 600 }}>{book.title}</div>
        <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>{book.asin ?? 'no ASIN'}</code>
      </td>
      <td>
        <code style={{ fontSize: 12 }}>{book.normalizedTitle || '—'}</code>
        {suspect && (
          <div style={{ marginTop: 4 }}>
            <Pill tone="bad">series name kept, book name lost</Pill>
          </div>
        )}
      </td>
      <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {book.releaseDate?.slice(0, 10) ?? '—'}
        {book.isPlaceholder && (
          <div>
            <Pill tone="warn">placeholder</Pill>
          </div>
        )}
      </td>
      <td>
        {book.kept ? (
          <Pill tone="good">kept</Pill>
        ) : (
          <>
            <Pill tone="warn">
              {book.droppedBy === 'phantom-placeholder' ? 'phantom' : 'duplicate edition'}
            </Pill>
            {book.droppedFor && (
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>
                superseded by <code>{book.droppedFor}</code>
              </div>
            )}
          </>
        )}
      </td>
    </tr>
  )
}

function MatchRow({ match, series }: { match: SeriesDebugMatch; series: string }) {
  const [open, setOpen] = useState(false)
  const suspect = suspectNormalization(match, series)
  const refused = match.attempts.some((a) => a.outcome === 'refused')
  return (
    <>
      <tr
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: 'pointer' }}
        title="Show every signal that was tried"
      >
        <td style={{ color: 'var(--text-muted)' }}>{match.sequence || '—'}</td>
        <td>
          <div style={{ fontWeight: 600 }}>{match.title}</div>
          <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {match.normalizedTitle || '—'}
          </code>
          {suspect && (
            <div style={{ marginTop: 4 }}>
              <Pill tone="bad">series name kept, book name lost</Pill>
            </div>
          )}
        </td>
        <td>
          {match.owned ? (
            <Pill tone="good">owned · {match.matchedBy}</Pill>
          ) : refused ? (
            <Pill tone="bad">missing · refused</Pill>
          ) : (
            <Pill tone="warn">missing</Pill>
          )}
        </td>
        <td style={{ color: 'var(--text-muted)' }}>{match.matchedOwned ?? '—'}</td>
        <td style={{ textAlign: 'right' }}>
          <Icon name={open ? 'expand_less' : 'expand_more'} />
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--bg-sunken, rgba(0,0,0,.14))' }}>
            {match.attempts.map((a, i) => (
              <div
                key={i}
                style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 2px' }}
              >
                <code style={{ width: 74, flex: 'none', fontSize: 11.5 }}>{a.signal}</code>
                <span style={{ width: 84, flex: 'none' }}>
                  {a.outcome === 'matched' ? (
                    <Pill tone="good">matched</Pill>
                  ) : a.outcome === 'refused' ? (
                    <Pill tone="bad">refused</Pill>
                  ) : (
                    <Pill tone="warn">{a.outcome}</Pill>
                  )}
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{a.detail}</span>
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  )
}

function MatchingCard({ report }: { report: SeriesDebugReport }) {
  const results = report.matching.results
  if (!results.length) return null
  const owned = results.filter((r) => r.owned).length
  const ordered = useMemo(
    () =>
      [...results].sort(
        (a, b) => (parseFloat(a.sequence) || 999) - (parseFloat(b.sequence) || 999),
      ),
    [results],
  )
  return (
    <section className="cfg-card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0, flex: 1 }}>3 · Ownership matching</h3>
        <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
          {owned} owned · {results.length - owned} missing · library holds {report.ownedCount}
        </span>
      </div>
      {owned !== report.ownedCount && (
        <div className="rr-err" style={{ marginBottom: 10 }}>
          <Icon name="warning" fill /> The library holds {report.ownedCount} books in this series
          but only {owned} matched. The unmatched ones are being shown to users as “not in library”.
        </div>
      )}
      <p className="hint" style={{ margin: '0 0 8px 2px', fontSize: 12 }}>
        Click a row to see every signal that was tried, in priority order.
      </p>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 52 }}>Seq</th>
              <th>Roster book / normalized</th>
              <th>Verdict</th>
              <th>Matched owned copy</th>
              <th style={{ width: 34 }} />
            </tr>
          </thead>
          <tbody>
            {ordered.map((m) => (
              <MatchRow key={m.asin ?? m.title} match={m} series={report.name} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function OwnedCard({ report }: { report: SeriesDebugReport }) {
  const owned = report.matching.owned
  if (!owned.length) return null
  return (
    <section className="cfg-card" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: '0 0 10px' }}>3b · What the library holds</h3>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 52 }}>Seq</th>
              <th>ABS title / normalized</th>
              <th>ASIN</th>
              <th>Eligible signals</th>
              <th>Claimed</th>
            </tr>
          </thead>
          <tbody>
            {owned.map((o, i) => (
              <tr key={`${o.asin}-${o.title}-${i}`}>
                <td style={{ color: 'var(--text-muted)' }}>{o.sequence || '—'}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{o.title || '—'}</div>
                  <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                    {o.normalizedTitle || '—'}
                  </code>
                </td>
                <td>
                  {o.asin ? (
                    <>
                      <code style={{ fontSize: 11 }}>{o.asin}</code>
                      <div style={{ marginTop: 3 }}>
                        {o.asinIsLive ? (
                          <Pill tone="good">live</Pill>
                        ) : (
                          <Pill tone="warn">delisted</Pill>
                        )}
                      </div>
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-faint)' }}>none</span>
                  )}
                </td>
                <td style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                  {o.eligibleFor.join(', ')}
                </td>
                <td>
                  {o.claimedBy ? (
                    <code style={{ fontSize: 11 }}>{o.claimedBy}</code>
                  ) : (
                    <Pill tone="warn">unclaimed</Pill>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function StoredCard({
  report,
  onResweep,
  resweeping,
}: {
  report: SeriesDebugReport
  onResweep: () => void
  resweeping: boolean
}) {
  const stored = report.stored
  if (!stored) return null
  return (
    <section className="cfg-card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0, flex: 1 }}>4 · Stored roster vs live</h3>
        <button className="btn-sm btn-primary" disabled={resweeping} onClick={onResweep}>
          <Icon name="sync" /> {resweeping ? 'Re-sweeping…' : 'Re-sweep this series'}
        </button>
      </div>
      {!stored.present ? (
        <p style={{ color: 'var(--text-muted)', margin: 0 }}>
          No stored roster yet — the nightly sweep hasn’t reached this series. Reads fall back to a
          live resolve, so the page still works; re-sweep to store it now.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 10 }}>
            <Fact label="Stored at" value={fmtDate(stored.resolvedAt)} />
            <Fact label="Stored books" value={stored.bookCount} />
            <Fact
              label="Drift"
              value={
                stored.drift.length ? (
                  <Pill tone="warn">{stored.drift.length} differ</Pill>
                ) : (
                  <Pill tone="good">in sync</Pill>
                )
              }
            />
          </div>
          {stored.drift.length > 0 && (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Book</th>
                    <th>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {stored.drift.map((d) => (
                    <tr key={`${d.kind}-${d.asin}`}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{d.title || '—'}</div>
                        <code style={{ fontSize: 11, color: 'var(--text-faint)' }}>{d.asin}</code>
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                        {d.kind === 'only-live' && 'In the live roster but not stored (new book)'}
                        {d.kind === 'only-stored' &&
                          'Stored but gone from the live roster (delisted)'}
                        {d.kind === 'owned-differs' &&
                          `Owned flag is stale: stored ${String(d.stored)}, live ${String(d.live)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export function ConfigSeriesDebugger() {
  const [seriesId, setSeriesId] = useState('')
  const [filter, setFilter] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['series-debug', 'list'],
    queryFn: getDebuggableSeries,
    staleTime: 5 * 60 * 1000,
  })

  const debug = useMutation({ mutationFn: (id: string) => getSeriesDebugReport(id) })
  const resweep = useMutation({
    mutationFn: (id: string) => resweepSeries(id),
    onSuccess: (result) => {
      setToast(
        result.resolved
          ? `Stored ${result.books} books. Reloading the report…`
          : 'Could not resolve this series against Audible.',
      )
      window.setTimeout(() => setToast(null), 4000)
      if (result.resolved && seriesId) debug.mutate(seriesId)
    },
  })

  const matches = useMemo(() => {
    const all = list.data ?? []
    const q = filter.trim().toLowerCase()
    const filtered = q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all
    return filtered.slice(0, 300)
  }, [list.data, filter])

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Advanced · read only</div>
        <h1 className="title-xl">Series Debugger</h1>
        <p className="page-sub">
          Why a series shows the books it shows: which Audible series it resolved to, what roster
          filtering dropped, and which signal decided every owned/missing verdict.
        </p>
      </div>

      {toast && (
        <div
          className="cfg-card"
          style={{ marginBottom: 'var(--s4)', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <Icon name="info" style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 13.5 }}>{toast}</span>
        </div>
      )}

      <div className="cfg-card">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <label>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--text-muted)',
                marginBottom: 5,
              }}
            >
              Find a series
            </span>
            <input
              className="input"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Type to filter…"
              style={{ width: '100%' }}
            />
          </label>
          <label>
            <span
              style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--text-muted)',
                marginBottom: 5,
              }}
            >
              Series{' '}
              {list.data && <span style={{ color: 'var(--text-faint)' }}>({matches.length})</span>}
            </span>
            <select
              className="input"
              value={seriesId}
              onChange={(e) => setSeriesId(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">Choose a series</option>
              {matches.map((s) => (
                <option key={s.seriesId} value={s.seriesId}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-primary"
            disabled={!seriesId || debug.isPending}
            onClick={() => seriesId && debug.mutate(seriesId)}
          >
            <Icon name="troubleshoot" fill /> {debug.isPending ? 'Inspecting…' : 'Load diagnostics'}
          </button>
        </div>
        {list.isLoading && (
          <p className="hint" style={{ margin: '10px 2px 0', fontSize: 12 }}>
            Loading the series list…
          </p>
        )}
        {list.error && (
          <p className="hint" style={{ margin: '10px 2px 0', fontSize: 12 }}>
            Could not load the series list. This needs AudiobookShelf’s database mounted.
          </p>
        )}
      </div>

      {debug.isPending && (
        <LoadingSpinner className="py-12" label="Replaying the match pipeline…" />
      )}
      {debug.error && (
        <div className="rr-err" style={{ marginTop: 14 }}>
          <Icon name="error" fill /> {debug.error.message}
        </div>
      )}

      {debug.data && !debug.isPending && (
        <div style={{ marginTop: 14 }}>
          <ResolutionCard report={debug.data} />
          <RosterCard report={debug.data} />
          <MatchingCard report={debug.data} />
          <OwnedCard report={debug.data} />
          <StoredCard
            report={debug.data}
            resweeping={resweep.isPending}
            onResweep={() => seriesId && resweep.mutate(seriesId)}
          />
          <RawJson label="Raw report JSON" value={debug.data} />
        </div>
      )}
    </>
  )
}
