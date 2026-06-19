import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getAllLibraryItems, getSeries, libraryKeys } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { usePlayer } from '@/hooks/usePlayer'
import { useSettingsStore } from '@/store/settingsStore'
import type { ABSLibraryItem, ABSSeries } from '@/api/types'
import { BookTile } from '@/components/library/BookTile'
import { SeriesCard } from '@/components/library/SeriesCard'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { Dropdown, MItem } from '@/components/common/Dropdown'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

type Tab = 'books' | 'series' | 'authors' | 'narrators'
type View = 'grid' | 'compact' | 'list'
type ProgFilter = 'all' | 'in-progress' | 'finished' | 'not-started'

const SORTS = ['Title', 'Author', 'Published Year', 'Date Added', 'Duration'] as const
type Sort = (typeof SORTS)[number]

const VIEW_KEY = 'hearthshelf:libraryView'

const PROG_CHIPS: [ProgFilter, string, string][] = [
  ['in-progress', 'play_circle', 'In progress'],
  ['finished', 'task_alt', 'Finished'],
  ['not-started', 'circle', 'Not started'],
]

interface DerivedPerson {
  name: string
  count: number
  cv: string
  initials: string
}

function initialsOf(name: string): string {
  // First letters of the first and last meaningful name parts (handles dotted
  // initials like "J.N. Chaney" -> "JC").
  const letters = name.match(/[A-Za-z]/g) ?? []
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const first = parts[0].match(/[A-Za-z]/)?.[0] ?? ''
    const last = parts[parts.length - 1].match(/[A-Za-z]/)?.[0] ?? ''
    return (first + last).toUpperCase()
  }
  return letters.slice(0, 2).join('').toUpperCase()
}

export function LibraryPage() {
  const { libraryId } = useParams()
  const navigate = useNavigate()
  const { active, activeId } = useActiveLibrary(libraryId)
  const progressById = useMediaProgress()
  const { playItem } = usePlayer()
  const fill = useSettingsStore((s) => s.libraryFill)
  const setFill = (v: boolean) => useSettingsStore.getState().set('libraryFill', v)

  const [tab, setTab] = useState<Tab>('books')
  const [prog, setProg] = useState<ProgFilter>('all')
  const [genre, setGenre] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('Title')
  const [desc, setDesc] = useState(false)
  const [view, setView] = useState<View>(
    () => (localStorage.getItem(VIEW_KEY) as View) || 'grid'
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [sSort, setSSort] = useState<'Name' | 'Books'>('Name')
  const [pSort, setPSort] = useState<'Name' | 'Books'>('Books')

  const setViewPersist = (v: View) => {
    setView(v)
    localStorage.setItem(VIEW_KEY, v)
  }

  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: libraryKeys.allItems(activeId ?? ''),
    queryFn: () => getAllLibraryItems(activeId as string),
    enabled: activeId !== null,
    staleTime: 2 * 60 * 1000,
  })

  const { data: seriesData } = useQuery({
    queryKey: libraryKeys.series(activeId ?? ''),
    queryFn: () => getSeries(activeId as string, 0, 1000),
    enabled: activeId !== null && tab === 'series',
    staleTime: 2 * 60 * 1000,
  })

  const allItems = useMemo(() => data?.results ?? [], [data])

  // Available genres for the filter menu.
  const genres = useMemo(() => {
    const set = new Set<string>()
    for (const it of allItems) for (const g of it.media.metadata.genres) set.add(g)
    return [...set].sort()
  }, [allItems])

  // Filter + sort the books client-side.
  const books = useMemo(() => {
    let list = allItems
    if (prog !== 'all') {
      list = list.filter((it) => {
        const p = progressById.get(it.id)
        if (prog === 'finished') return p?.isFinished
        if (prog === 'in-progress')
          return p && !p.isFinished && p.progress > 0
        if (prog === 'not-started') return !p || p.progress === 0
        return true
      })
    }
    if (genre) list = list.filter((it) => it.media.metadata.genres.includes(genre))

    const cmp: Record<Sort, (a: ABSLibraryItem, b: ABSLibraryItem) => number> = {
      Title: (a, b) =>
        (a.media.metadata.titleIgnorePrefix || a.media.metadata.title || '').localeCompare(
          b.media.metadata.titleIgnorePrefix || b.media.metadata.title || ''
        ),
      Author: (a, b) =>
        a.media.metadata.authorName.localeCompare(b.media.metadata.authorName),
      'Published Year': (a, b) =>
        Number(a.media.metadata.publishedYear ?? 0) -
        Number(b.media.metadata.publishedYear ?? 0),
      'Date Added': (a, b) => a.addedAt - b.addedAt,
      Duration: (a, b) => (a.media.duration ?? 0) - (b.media.duration ?? 0),
    }
    const sorted = [...list].sort(cmp[sort])
    if (desc) sorted.reverse()
    return sorted
  }, [allItems, prog, genre, sort, desc, progressById])

  // Derive authors / narrators from the full item set.
  const derivePeople = (field: 'authorName' | 'narratorName'): DerivedPerson[] => {
    const map = new Map<string, { count: number; cv: string }>()
    for (const it of allItems) {
      const raw = it.media.metadata[field]
      if (!raw) continue
      for (const name of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
        const cur = map.get(name)
        if (cur) cur.count++
        else map.set(name, { count: 1, cv: tintFor(it.media.metadata.title ?? name) })
      }
    }
    return [...map.entries()].map(([name, v]) => ({
      name,
      count: v.count,
      cv: v.cv,
      initials: initialsOf(name),
    }))
  }
  const authors = useMemo(() => derivePeople('authorName'), [allItems])
  const narrators = useMemo(() => derivePeople('narratorName'), [allItems])

  const sortedAuthors = useMemo(() => {
    const a = [...authors]
    a.sort(pSort === 'Name' ? (x, y) => x.name.localeCompare(y.name) : (x, y) => y.count - x.count)
    return a
  }, [authors, pSort])
  const sortedNarrators = useMemo(() => {
    const a = [...narrators]
    a.sort(pSort === 'Name' ? (x, y) => x.name.localeCompare(y.name) : (x, y) => y.count - x.count)
    return a
  }, [narrators, pSort])

  const seriesList = useMemo(() => {
    const list: ABSSeries[] = [...(seriesData?.results ?? [])]
    list.sort(
      sSort === 'Name'
        ? (a, b) => a.name.localeCompare(b.name)
        : (a, b) => (b.books?.length ?? 0) - (a.books?.length ?? 0)
    )
    return list
  }, [seriesData, sSort])

  // Multi-select
  const anySelected = selected.size > 0
  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const clearSel = () => setSelected(new Set())
  const selectAll = () => setSelected(new Set(books.map((b) => b.id)))
  const switchTab = (id: Tab) => {
    clearSel()
    setTab(id)
  }

  // Narrator/author detail pages are Phase 2; for now a card click just lands
  // the user in the Books grid with filters cleared.
  const goBooks = () => {
    setGenre(null)
    setProg('all')
    setSort('Title')
    setDesc(false)
    setTab('books')
  }

  const TABS: { id: Tab; icon: string; label: string; n: number }[] = [
    { id: 'books', icon: 'grid_view', label: 'Books', n: data?.total ?? allItems.length },
    { id: 'series', icon: 'auto_stories', label: 'Series', n: seriesData?.total ?? 0 },
    { id: 'authors', icon: 'person', label: 'Authors', n: authors.length },
    { id: 'narrators', icon: 'mic', label: 'Narrators', n: narrators.length },
  ]

  return (
    <div
      className="page fade-in"
      style={
        fill
          ? {
              paddingTop: 24,
              maxWidth: 'none',
              paddingLeft: 'var(--s6)',
              paddingRight: 'var(--s6)',
            }
          : { paddingTop: 24 }
      }
    >
      <div className="page-head">
        <div className="eyebrow">Your collection</div>
        <h1 className="title-xl">{active?.name ?? 'Library'}</h1>
      </div>

      <div className="qv-tabs">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            className={'qv-tab' + (tab === tb.id ? ' on' : '')}
            onClick={() => switchTab(tb.id)}
          >
            <Icon name={tb.icon} fill={tab === tb.id} />
            <span>{tb.label}</span>
            <span className="qv-count">{tb.n}</span>
          </button>
        ))}
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading library..." />}
      {isError && (
        <ErrorState message="Could not load this library." onRetry={refetch} />
      )}

      {/* ---- Books ---- */}
      {tab === 'books' && data && (
        <>
          {anySelected ? (
            <div className="toolbar2 sel-bar">
              <button className="pill" onClick={clearSel} title="Clear selection">
                <Icon name="close" />
              </button>
              <span
                className="count-badge"
                style={{ color: 'var(--accent)', fontWeight: 600 }}
              >
                {selected.size} selected
              </span>
              {selected.size < books.length && (
                <button className="pill" onClick={selectAll}>
                  Select all {books.length}
                </button>
              )}
              <div className="tb-spacer" />
              <Dropdown icon="playlist_add" label="Add to…">
                <div className="mp-label">Add selection to</div>
                <MItem icon="folder_special" label="Collection…" onClick={clearSel} />
                <MItem icon="queue_music" label="Playlist…" onClick={clearSel} />
              </Dropdown>
              <Dropdown icon="more_horiz" label="More">
                <MItem icon="download" label="Download" onClick={clearSel} />
                <MItem icon="sync" label="Re-scan" onClick={clearSel} />
                <div className="mp-sep" />
                <MItem
                  icon="delete"
                  label={`Delete ${selected.size} item${selected.size === 1 ? '' : 's'}…`}
                  danger
                  onClick={clearSel}
                />
              </Dropdown>
            </div>
          ) : (
            <div className="toolbar2">
              <span className="count-badge">
                {books.length} of {data.total} books
              </span>
              <div className="seg">
                {PROG_CHIPS.map(([id, ic, label]) => (
                  <button
                    key={id}
                    className={prog === id ? 'on' : ''}
                    onClick={() => setProg(prog === id ? 'all' : id)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <Icon name={ic} fill={prog === id} style={{ fontSize: 17 }} />{' '}
                    {label}
                  </button>
                ))}
              </div>
              <Dropdown
                icon="filter_list"
                label={genre ?? 'Genre'}
                align="left"
              >
                <div className="mp-label">Filter by genre</div>
                <MItem label="All genres" on={!genre} onClick={() => setGenre(null)} />
                {genres.map((g) => (
                  <MItem
                    key={g}
                    label={g}
                    on={genre === g}
                    onClick={() => setGenre(g)}
                  />
                ))}
              </Dropdown>
              <Dropdown icon="swap_vert" label={sort} align="left">
                <div className="mp-label">Sort by</div>
                {SORTS.map((s) => (
                  <MItem
                    key={s}
                    label={s}
                    on={s === sort}
                    tail={
                      s === sort ? (
                        <Icon
                          name={desc ? 'expand_more' : 'expand_less'}
                          style={{ color: 'var(--accent)' }}
                        />
                      ) : undefined
                    }
                    onClick={() => (s === sort ? setDesc((d) => !d) : setSort(s))}
                  />
                ))}
              </Dropdown>
              <div className="tb-spacer" />
              <button
                className={'pill' + (fill ? ' on' : '')}
                onClick={() => setFill(!fill)}
                title={fill ? 'Full width' : 'Boxed'}
              >
                <Icon name={fill ? 'width_full' : 'width_normal'} />{' '}
                {fill ? 'Full width' : 'Boxed'}
              </button>
              <div className="seg-view">
                {(
                  [
                    ['grid', 'grid_view'],
                    ['compact', 'apps'],
                    ['list', 'view_list'],
                  ] as [View, string][]
                ).map(([v, ic]) => (
                  <button
                    key={v}
                    className={view === v ? 'on' : ''}
                    onClick={() => setViewPersist(v)}
                    title={v}
                  >
                    <Icon name={ic} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {books.length === 0 && (
            <div className="empty-state">
              <Icon name="filter_alt_off" />
              <h3>No results for filter</h3>
              <p>Nothing in this library matches the active filter.</p>
              <button
                className="btn-sm btn-ghost"
                style={{ margin: '0 auto' }}
                onClick={() => {
                  setProg('all')
                  setGenre(null)
                }}
              >
                Clear filter
              </button>
            </div>
          )}

          {books.length > 0 &&
            (view === 'list' ? (
              <div className={'lib-list' + (anySelected ? ' selecting' : '')}>
                {books.map((b) => {
                  const p = progressById.get(b.id)
                  const m = b.media.metadata
                  const hours = b.media.duration
                    ? Math.round(b.media.duration / 360) / 10
                    : 0
                  return (
                    <div
                      className={'ll-row' + (selected.has(b.id) ? ' sel' : '')}
                      key={b.id}
                      data-cv={tintFor(m.title ?? 'Untitled')}
                      onClick={() =>
                        anySelected ? toggleSel(b.id) : navigate(`/book/${b.id}`)
                      }
                    >
                      <Cover
                        itemId={b.id}
                        title={m.title ?? 'Untitled'}
                        fs={5}
                        overlay={
                          <button
                            className={'b-check' + (selected.has(b.id) ? ' on' : '')}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleSel(b.id)
                            }}
                          >
                            <Icon
                              name="check"
                              fill
                              style={{ opacity: selected.has(b.id) ? 1 : 0 }}
                            />
                          </button>
                        }
                      />
                      <div style={{ minWidth: 0 }}>
                        <div className="ll-title">{m.title}</div>
                        <div className="ll-sub">
                          {m.authorName}
                          {m.narratorName && ` · ${m.narratorName}`}
                        </div>
                      </div>
                      <span className="ll-col">
                        {m.genres[0] ?? ''} {m.publishedYear ? `· ${m.publishedYear}` : ''}
                      </span>
                      {p && p.progress > 0 && !p.isFinished ? (
                        <div className="ll-prog">
                          <div className="prog-line">
                            <i style={{ width: p.progress * 100 + '%' }} />
                          </div>
                          <span>{Math.round(p.progress * 100)}%</span>
                        </div>
                      ) : (
                        <span
                          className="ll-col mono"
                          style={{ fontFamily: 'var(--font-mono)' }}
                        >
                          {p?.isFinished ? 'Finished' : `${hours}h`}
                        </span>
                      )}
                      <button
                        className="ll-play"
                        onClick={(e) => {
                          e.stopPropagation()
                          void playItem(b.id)
                        }}
                      >
                        <Icon name="play_arrow" fill />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div
                className={
                  'lib-grid' +
                  (view === 'compact' ? ' compact' : '') +
                  (anySelected ? ' selecting' : '')
                }
              >
                {books.map((b) => {
                  const p = progressById.get(b.id)
                  return (
                    <BookTile
                      key={b.id}
                      item={b}
                      fs={view === 'compact' ? 12 : 15}
                      progress={p?.progress ?? 0}
                      finished={p?.isFinished}
                      compact={view === 'compact'}
                      selected={selected.has(b.id)}
                      anySelected={anySelected}
                      onToggleSelect={() => toggleSel(b.id)}
                    />
                  )
                })}
              </div>
            ))}
        </>
      )}

      {/* ---- Series ---- */}
      {tab === 'series' && (
        <>
          <div className="toolbar2">
            <span className="count-badge">{seriesList.length} series</span>
            <div className="tb-spacer" />
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Sort</span>
            <div className="seg">
              {(['Name', 'Books'] as const).map((o) => (
                <button
                  key={o}
                  className={sSort === o ? 'on' : ''}
                  onClick={() => setSSort(o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
          <div className="series-grid">
            {seriesList.map((s) => (
              <SeriesCard key={s.id} series={s} />
            ))}
          </div>
        </>
      )}

      {/* ---- Authors / Narrators ---- */}
      {(tab === 'authors' || tab === 'narrators') && (
        <>
          <div className="toolbar2">
            <span className="count-badge">
              {(tab === 'authors' ? authors : narrators).length}{' '}
              {tab === 'authors' ? 'authors' : 'narrators'}
            </span>
            <div className="tb-spacer" />
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Sort</span>
            <div className="seg">
              {(['Name', 'Books'] as const).map((o) => (
                <button
                  key={o}
                  className={pSort === o ? 'on' : ''}
                  onClick={() => setPSort(o)}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
          <div className="author-grid">
            {(tab === 'authors' ? sortedAuthors : sortedNarrators).map((p) => (
              <div
                className="author-card"
                key={p.name}
                data-cv={p.cv}
                onClick={() => tab === 'narrators' && goBooks()}
              >
                <div
                  className={'author-av' + (tab === 'narrators' ? ' nar-av-lg' : '')}
                  style={{
                    background: `linear-gradient(150deg, ${p.cv}, color-mix(in oklab, ${p.cv} 45%, #000))`,
                  }}
                >
                  {p.initials}
                  {tab === 'narrators' && (
                    <span className="nar-mic">
                      <Icon name="mic" fill />
                    </span>
                  )}
                </div>
                <div className="author-name">{p.name}</div>
                <div className="author-books">
                  {p.count} {p.count === 1 ? 'book' : 'books'}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
