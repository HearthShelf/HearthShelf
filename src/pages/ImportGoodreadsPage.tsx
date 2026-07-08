import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useToast } from '@/hooks/useToast'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { parseGoodreadsCsv, isReadRow, type GoodreadsRow } from '@/lib/goodreadsCsv'
import {
  matchRows,
  importRows,
  finishedBooksKeys,
  type MatchRow,
  type ImportRow,
} from '@/api/finishedBooks'

// One reviewed row: the parsed CSV data plus the user's resolved match
// decision (a chosen libraryItemId, or null to save as a stub).
interface ReviewRow extends GoodreadsRow {
  status: 'auto' | 'ambiguous' | 'none'
  candidates: MatchRow['candidates']
  resolvedLibraryItemId: string | null
  resolved: boolean
}

export function ImportGoodreadsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { toast, show } = useToast()
  const { libraries, activeId, select } = useActiveLibrary()

  const [skippedCount, setSkippedCount] = useState<number | null>(null)
  const [rows, setRows] = useState<ReviewRow[] | null>(null)
  const [matching, setMatching] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [backfillAbs, setBackfillAbs] = useState(true)

  const handleFile = async (file: File) => {
    setParseError(null)
    setRows(null)
    let parsed: GoodreadsRow[]
    try {
      parsed = await parseGoodreadsCsv(file)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Could not read that file')
      return
    }
    const readRows = parsed.filter(isReadRow)
    setSkippedCount(parsed.length - readRows.length)
    if (!activeId) {
      setParseError('No library selected')
      return
    }
    setMatching(true)
    try {
      const { matches } = await matchRows(
        activeId,
        readRows.map((r) => ({ title: r.title, author: r.author, isbn: r.isbn ?? r.isbn13 })),
      )
      setRows(
        readRows.map((r, i) => {
          const m = matches[i]
          const auto = m.status === 'auto' ? (m.candidates[0]?.libraryItemId ?? null) : null
          return {
            ...r,
            status: m.status,
            candidates: m.candidates,
            resolvedLibraryItemId: auto,
            resolved: m.status !== 'ambiguous',
          }
        }),
      )
    } catch {
      setParseError('Could not match against your library. Try again.')
    } finally {
      setMatching(false)
    }
  }

  const unresolvedCount = useMemo(() => rows?.filter((r) => !r.resolved).length ?? 0, [rows])
  const matchedCount = useMemo(
    () => rows?.filter((r) => r.resolved && r.resolvedLibraryItemId).length ?? 0,
    [rows],
  )

  const resolveRow = (index: number, libraryItemId: string | null) => {
    setRows((cur) =>
      cur
        ? cur.map((r, i) =>
            i === index ? { ...r, resolvedLibraryItemId: libraryItemId, resolved: true } : r,
          )
        : cur,
    )
  }

  const acceptAllAutoMatches = () => {
    setRows((cur) =>
      cur
        ? cur.map((r) =>
            r.status === 'ambiguous' && r.candidates[0]
              ? { ...r, resolvedLibraryItemId: r.candidates[0].libraryItemId, resolved: true }
              : r,
          )
        : cur,
    )
  }

  const stubAllUnresolved = () => {
    setRows((cur) =>
      cur
        ? cur.map((r) => (!r.resolved ? { ...r, resolvedLibraryItemId: null, resolved: true } : r))
        : cur,
    )
  }

  const commit = useMutation({
    mutationFn: () => {
      const reviewed: ImportRow[] = (rows ?? []).map((r) => ({
        title: r.title,
        author: r.author || null,
        isbn: r.isbn ?? r.isbn13,
        dateFinished: r.dateFinished,
        rating: r.rating,
        libraryItemId: r.resolvedLibraryItemId,
      }))
      return importRows(reviewed, backfillAbs)
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: finishedBooksKeys.list })
      const backfilled = result.absBackfilled ?? 0
      show(
        `Imported ${result.inserted + result.updated} books` +
          (backfilled ? ` · ${backfilled} marked finished in your library` : ''),
      )
      setRows(null)
    },
    onError: () => show('Import failed - try again'),
  })

  return (
    <div className="page fade-in">
      <div className="page-head">
        <button className="btn-sm" onClick={() => navigate('/settings')}>
          <Icon name="arrow_back" /> Settings
        </button>
        <div className="eyebrow">Reading history</div>
        <h1 className="title-xl">Import from Goodreads</h1>
        <p className="page-sub">
          Export your library from Goodreads (Account Settings &rarr; Export Library), then upload
          the CSV here. Only books marked "read" are imported. Books still in your library get
          linked to their cover and details; everything else is kept as a reading-history record on
          its own.
        </p>
      </div>

      {!rows && (
        <div className="cfg-card">
          {libraries.length > 1 && (
            <div className="field full">
              <label>Library to match against</label>
              <select
                className="fld"
                value={activeId ?? ''}
                onChange={(e) => select(e.target.value)}
              >
                {libraries.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field full">
            <label>Goodreads export CSV</label>
            <input
              className="fld"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
          </div>
          {matching && <LoadingSpinner className="py-8" label="Matching against your library..." />}
          {parseError && (
            <div className="p-toast" style={{ color: '#e0716c' }}>
              {parseError}
            </div>
          )}
        </div>
      )}

      {rows && (
        <>
          <div className="cfg-card" style={{ marginBottom: 'var(--s4)' }}>
            <div className="cl-d">
              {rows.length} read book{rows.length === 1 ? '' : 's'} found
              {skippedCount ? ` (${skippedCount} to-read/currently-reading rows skipped)` : ''}.
              {unresolvedCount > 0
                ? ` ${unresolvedCount} need a decision before you can import.`
                : ' Ready to import.'}
            </div>
            <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
              <button className="btn-sm" onClick={acceptAllAutoMatches}>
                Accept all suggested matches
              </button>
              <button className="btn-sm" onClick={stubAllUnresolved}>
                Save rest as history only
              </button>
            </div>
          </div>

          <div className="cfg-card">
            {rows.map((r, i) => (
              <div
                className="cfg-line"
                key={`${r.title}-${i}`}
                style={{
                  gap: 12,
                  borderTop: i ? '1px solid var(--border)' : undefined,
                  paddingTop: i ? 'var(--s3)' : undefined,
                  marginTop: i ? 'var(--s3)' : undefined,
                }}
              >
                <Icon
                  name={
                    r.status === 'auto' ? 'check_circle' : r.status === 'none' ? 'help' : 'help'
                  }
                  fill={r.status === 'auto'}
                  style={{ color: r.status === 'auto' ? '#5a9c52' : 'var(--text-muted)' }}
                />
                <div className="cl-meta" style={{ flex: 1 }}>
                  <div className="cl-t">{r.title}</div>
                  <div className="cl-d">
                    {r.author} {r.dateFinished ? `· read ${r.dateFinished}` : ''}
                  </div>
                </div>
                {r.status === 'auto' && (
                  <span className="badge-pill" style={{ color: '#7fbd6f' }}>
                    Matched: {r.candidates[0]?.title}
                  </span>
                )}
                {r.status === 'none' && (
                  <span className="badge-pill" style={{ color: 'var(--text-muted)' }}>
                    History only
                  </span>
                )}
                {r.status === 'ambiguous' && (
                  <select
                    className="fld"
                    style={{ maxWidth: 280 }}
                    value={r.resolved ? (r.resolvedLibraryItemId ?? '') : ''}
                    onChange={(e) => resolveRow(i, e.target.value || null)}
                  >
                    <option value="" disabled={r.resolved}>
                      Pick a match...
                    </option>
                    {r.candidates.map((c) => (
                      <option key={c.libraryItemId} value={c.libraryItemId}>
                        {c.title} — {c.author}
                      </option>
                    ))}
                    <option value="">None of these (history only)</option>
                  </select>
                )}
              </div>
            ))}
          </div>

          <label
            className="cfg-line"
            style={{ gap: 10, marginTop: 'var(--s4)', cursor: 'pointer', alignItems: 'flex-start' }}
          >
            <input
              type="checkbox"
              checked={backfillAbs}
              onChange={(e) => setBackfillAbs(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <div className="cl-meta">
              <div className="cl-t">Mark matched books finished in my library</div>
              <div className="cl-d">
                Sets each matched book&rsquo;s finished date to when you read it, so your reading
                totals and this-year count fill in on your Stats page.
                {matchedCount ? ` ${matchedCount} book${matchedCount === 1 ? '' : 's'} will update.` : ''}{' '}
                Listening time, streaks, and the heatmap can&rsquo;t be filled in&mdash;Goodreads
                doesn&rsquo;t record how long you listened.
              </div>
            </div>
          </label>

          <button
            className="btn-sm btn-green"
            style={{ marginTop: 'var(--s3)' }}
            disabled={unresolvedCount > 0 || commit.isPending}
            onClick={() => commit.mutate()}
          >
            <Icon name="save" /> Confirm &amp; import
          </button>
        </>
      )}

      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </div>
  )
}
