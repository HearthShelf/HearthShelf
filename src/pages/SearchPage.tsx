import { useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { searchLibrary } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { BookTile } from '@/components/library/BookTile'
import { RmabSearchLane } from '@/components/requests/RmabSearchLane'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (
      (parts[0].match(/[A-Za-z]/)?.[0] ?? '') +
      (parts[parts.length - 1].match(/[A-Za-z]/)?.[0] ?? '')
    ).toUpperCase()
  }
  return (name.match(/[A-Za-z]/g) ?? []).slice(0, 2).join('').toUpperCase()
}

export function SearchPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const q = (params.get('q') ?? '').trim()
  const { activeId } = useActiveLibrary()
  const progressById = useMediaProgress()

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['search', activeId, q],
    queryFn: () => searchLibrary(activeId as string, q),
    enabled: activeId !== null && q.length >= 2,
    staleTime: 60 * 1000,
  })

  const books = data?.book ?? []
  const series = data?.series ?? []
  const authors = data?.authors ?? []
  const narrators = data?.narrators ?? []
  const hasResults =
    books.length > 0 ||
    series.length > 0 ||
    authors.length > 0 ||
    narrators.length > 0

  // Owned-title keys so the requestable lane never lists books we already have.
  const ownedKeys = new Set(
    books.map(({ libraryItem }) => {
      const m = libraryItem.media.metadata
      return ((m.title ?? '') + '|' + (m.authorName ?? '')).toLowerCase()
    })
  )

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">Search results</div>
        <h1 className="title-xl">{q ? `"${q}"` : 'Search'}</h1>
      </div>

      {q.length < 2 && (
        <p className="page-sub">Type at least two characters to search.</p>
      )}

      {isLoading && <LoadingSpinner className="py-12" label="Searching..." />}
      {isError && (
        <ErrorState message="Search failed." onRetry={refetch} />
      )}

      {data && !hasResults && (
        <div className="sg-empty">
          <Icon name="search_off" />
          <p>No results in your library for "{q}"</p>
        </div>
      )}

      {books.length > 0 && (
        <div className="search-group">
          <SectionHead icon="auto_stories" title={`Books · ${books.length}`} />
          <div className="lib-grid">
            {books.map(({ libraryItem }) => {
              const p = progressById.get(libraryItem.id)
              return (
                <BookTile
                  key={libraryItem.id}
                  item={libraryItem}
                  progress={p?.progress ?? 0}
                  finished={p?.isFinished}
                />
              )
            })}
          </div>
        </div>
      )}

      {series.length > 0 && (
        <div className="search-group">
          <SectionHead
            icon="format_list_numbered"
            title={`Series · ${series.length}`}
          />
          <div className="coll-grid">
            {series.map((s) => {
              const author = s.books[0]?.media.metadata.authorName ?? ''
              const cv = tintFor(s.books[0]?.media.metadata.title ?? s.series.name)
              return (
                <div
                  key={s.series.id}
                  className="coll-card"
                  data-cv={cv}
                  onClick={() => navigate(`/series/${s.series.id}`)}
                >
                  <div className="coll-stack">
                    {s.books.slice(0, 4).map((b) => (
                      <Cover
                        key={b.id}
                        itemId={b.id}
                        title={b.media.metadata.title ?? 'Untitled'}
                        fs={7}
                      />
                    ))}
                    {s.books.length > 4 && (
                      <div className="stack-more">+{s.books.length - 4}</div>
                    )}
                  </div>
                  <div className="coll-meta">
                    <h3>{s.series.name}</h3>
                    <p>
                      {author && `${author} · `}
                      {s.books.length} {s.books.length === 1 ? 'book' : 'books'}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {authors.length > 0 && (
        <div className="search-group">
          <SectionHead icon="person" title={`Authors · ${authors.length}`} />
          <div className="author-grid">
            {authors.map((a) => {
              const cv = tintFor(a.name)
              return (
                <div className="author-card" key={a.id} data-cv={cv}>
                  <div
                    className="author-av"
                    style={{
                      background: `linear-gradient(150deg, ${cv}, color-mix(in oklab, ${cv} 45%, #000))`,
                    }}
                  >
                    {initialsOf(a.name)}
                  </div>
                  <div className="author-name">{a.name}</div>
                  <div className="author-books">
                    {a.numBooks} {a.numBooks === 1 ? 'book' : 'books'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {narrators.length > 0 && (
        <div className="search-group">
          <SectionHead icon="mic" title={`Narrators · ${narrators.length}`} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s3)' }}>
            {narrators.map((n) => (
              <div className="chip" key={n.name}>
                <Icon name="mic" fill style={{ fontSize: 14 }} /> {n.name}
                <span style={{ color: 'var(--text-faint)', marginLeft: 4 }}>
                  {n.numBooks} {n.numBooks === 1 ? 'book' : 'books'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {q.length >= 2 && <RmabSearchLane query={q} ownedKeys={ownedKeys} />}
    </div>
  )
}
