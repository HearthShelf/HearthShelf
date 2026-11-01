import { useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { EMPTY_OWNED_INDEX, ownedIndexFromLibraryItems } from '@hearthshelf/core'
import { getAllLibraryItems, libraryKeys, searchLibrary } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { BookTile } from '@/components/library/BookTile'
import { ExternalSearchLane } from '@/components/requests/ExternalSearchLane'
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

  // The whole library, for the ownership check below. Shares react-query's cache
  // with Discover and the QuestGiver assessment, so it is usually already warm.
  const { data: allItems } = useQuery({
    queryKey: libraryKeys.allItems(activeId ?? ''),
    queryFn: () => getAllLibraryItems(activeId as string),
    enabled: activeId !== null && q.length >= 2,
  })

  const books = data?.book ?? []
  const series = data?.series ?? []
  const authors = data?.authors ?? []
  const narrators = data?.narrators ?? []
  const hasResults =
    books.length > 0 || series.length > 0 || authors.length > 0 || narrators.length > 0

  // Ownership for the requestable lane is decided against the WHOLE library, not
  // against this query's hits. ABS's search is a substring match while Audible's
  // absorbs typos, so a misspelled query found nothing here and the right book
  // there - leaving the owned set empty and offering a Request for a book already
  // on the shelf. See core's lib/ownedMatch.ts.
  const ownedIndex = useMemo(
    () => (allItems ? ownedIndexFromLibraryItems(allItems.results) : EMPTY_OWNED_INDEX),
    [allItems],
  )

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">Search results</div>
        <h1 className="title-xl">{q ? `"${q}"` : 'Search'}</h1>
      </div>

      {q.length < 2 && <p className="page-sub">Type at least two characters to search.</p>}

      {isLoading && <LoadingSpinner className="py-12" label="Searching..." />}
      {isError && <ErrorState message="Search failed." onRetry={refetch} />}

      {data && !hasResults && (
        <div className="sg-empty">
          <Icon name="search_off" />
          <p>No results for "{q}"</p>
        </div>
      )}

      {books.length > 0 && (
        <div className="search-group">
          <SectionHead icon="auto_stories" title={`In your library · ${books.length}`} />
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
          <SectionHead icon="format_list_numbered" title={`Series · ${series.length}`} />
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
                    {s.books.length > 4 && <div className="stack-more">+{s.books.length - 4}</div>}
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

      {q.length >= 2 && <ExternalSearchLane query={q} ownedIndex={ownedIndex} />}
    </div>
  )
}
