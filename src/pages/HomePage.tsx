import { useState, useMemo, useEffect, Fragment, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  continueSeriesShelf,
  isGeneratedRecShelf,
  GENERAL_REC_SECTIONS,
  type HomeSectionId,
  type DiscoverShelf,
} from '@hearthshelf/core'
import { getPersonalized, getAllLibraryItems, getSeries, libraryKeys } from '@/api/libraries'
import { useDismissalsStore } from '@/store/dismissalsStore'
import { getItemsInProgress, meKeys } from '@/api/me'
import { useAuth } from '@/hooks/useAuth'
import { usePlayer } from '@/hooks/usePlayer'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { usePlayerStore } from '@/store/playerStore'
import { useSettingsStore } from '@/store/settingsStore'
import { useIsMobile } from '@/hooks/useMediaQuery'
import type { ABSLibraryItem, ABSMediaProgress, ABSShelf } from '@/api/types'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { BookTile } from '@/components/library/BookTile'
import { HomeRequestsShelf } from '@/components/requests/HomeRequestsShelf'
import { SeriesCard } from '@/components/library/SeriesCard'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'
import { buildDiscoverShelves, rankDiscoverShelves } from '@/lib/discover'
import { useMonthlyShelf, useDiscoverFeedbackQuery } from '@/hooks/useDiscover'
import { useQuestGiverPicks } from '@/hooks/useQuestGiverPicks'
import { useDiscoverEnabled } from '@/hooks/useQuestGiver'
import { HomeSectionsEditor } from '@/components/home/HomeSectionsEditor'
import { HomeClubShelf } from '@/components/home/HomeClubShelf'
import { ReleaseCountdownBanner } from '@/components/home/ReleaseCountdownBanner'
import { DashboardRow } from '@/components/home/DashboardRow'

const SHELF_ICONS: Record<string, string> = {
  'recently-added': 'schedule',
  'recent-series': 'auto_stories',
  'continue-series': 'auto_stories',
  discover: 'explore',
  'continue-listening': 'play_circle',
}

// Display order is no longer fixed here: the user's homeSections arrangement
// supplies it, so kept ABS shelves are looked up by section rather than ranked.

// ABS personalized shelves we suppress on Home: its recommendation +
// finished-again rows, which the HearthShelf taste engine replaces ("discover"
// also mixes in other users' books). The kept rows - continue-listening,
// continue-series, recently-added - are the user's own progress / library, not
// cross-user recommendations.
const TAINTED_ABS_SHELVES = new Set(['discover', 'listen-again', 'read-again'])

function greetingWord(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

type HeroStyle = 'comfy' | 'compact'

const HERO_KEY = 'hearthshelf:homeHero'

interface HeroProps {
  book: ABSLibraryItem
  progress?: ABSMediaProgress
}

function ResumeHero({ book, progress }: HeroProps) {
  const navigate = useNavigate()
  const { playItem } = usePlayer()
  const { title, authorName, narratorName } = book.media.metadata
  const sessionId = usePlayerStore((s) => s.libraryItemId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const playingThis = sessionId === book.id && isPlaying

  const pct = progress?.progress ?? 0
  const hours = book.media.duration ? Math.round(book.media.duration / 360) / 10 : 0
  const chapters = book.media.numChapters ?? 0
  const open = () => navigate(`/book/${book.id}`)

  return (
    <div data-cv={tintFor(title ?? 'Untitled')} className="hero-resume-card">
      <Cover
        itemId={book.id}
        title={title ?? 'Untitled'}
        author={authorName || undefined}
        fs={20}
        onClick={open}
        style={{
          width: 220,
          height: 220,
          borderRadius: 16,
          boxShadow: 'var(--shadow-lift)',
          cursor: 'pointer',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Jump back in
        </div>
        <h2
          style={{
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: '0 0 8px',
          }}
        >
          {title}
        </h2>
        <div style={{ color: 'var(--text-muted)', fontSize: 14.5, marginBottom: 14 }}>
          {authorName}
          {narratorName && ` · Narrated by ${narratorName}`}
        </div>
        <div
          style={{
            color: 'var(--text-muted)',
            fontSize: 13,
            marginBottom: 18,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {hours > 0 && `${hours}h`}
          {chapters > 0 && ` · ${chapters} chapters`}
          {pct > 0 && ` · ${Math.round(pct * 100)}% complete`}
        </div>
        <div className="prog-line" style={{ maxWidth: 460, marginBottom: 22 }}>
          <i style={{ width: pct * 100 + '%' }} />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-primary" onClick={() => void playItem(book.id)}>
            <Icon name={playingThis ? 'pause' : 'play_arrow'} fill />{' '}
            {pct > 0 ? 'Resume' : 'Start listening'}
          </button>
          <button className="pill" onClick={open}>
            <Icon name="info" /> Details
          </button>
        </div>
      </div>
    </div>
  )
}

function CalmHero({ book, progress }: HeroProps) {
  const navigate = useNavigate()
  const { playItem } = usePlayer()
  const { title } = book.media.metadata
  const sessionId = usePlayerStore((s) => s.libraryItemId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const playingThis = sessionId === book.id && isPlaying
  const pct = progress?.progress ?? 0

  return (
    <div
      className="hero-calm"
      data-cv={tintFor(title ?? 'Untitled')}
      onClick={() => void playItem(book.id)}
    >
      <Cover
        itemId={book.id}
        title={title ?? 'Untitled'}
        fs={6}
        onClick={(e) => {
          e.stopPropagation()
          navigate(`/book/${book.id}`)
        }}
        style={{
          width: 76,
          height: 76,
          borderRadius: 12,
          flex: 'none',
          cursor: 'pointer',
        }}
      />
      <div className="hc-meta">
        <div className="hc-k">Jump back in</div>
        <div className="hc-t">{title}</div>
        <div className="prog-line" style={{ maxWidth: 360 }}>
          <i style={{ width: pct * 100 + '%' }} />
        </div>
      </div>
      <button
        className="hc-play"
        onClick={(e) => {
          e.stopPropagation()
          void playItem(book.id)
        }}
      >
        <Icon name={playingThis ? 'pause' : 'play_arrow'} fill />
      </button>
    </div>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { active, activeId } = useActiveLibrary()
  const unifiedHome = useSettingsStore((s) => s.unifiedHome)
  // The user's arrangement drives which bands render and in what order.
  const homeSections = useSettingsStore((s) => s.homeSections)
  const recShelfCount = useSettingsStore((s) => s.homeRecShelfCount)
  // Arrange mode replaces the shelves with draggable section rows (covers off).
  const [editing, setEditing] = useState(false)
  const isMobile = useIsMobile()
  const [heroStyle, setHeroStyle] = useState<HeroStyle>(
    () => (localStorage.getItem(HERO_KEY) as HeroStyle) || 'comfy',
  )
  const chooseHero = (h: HeroStyle) => {
    setHeroStyle(h)
    localStorage.setItem(HERO_KEY, h)
  }
  // Mobile is always compact - the Comfy hero and the toggle are desktop-only.
  const compact = isMobile || heroStyle === 'compact'

  const { data: progress } = useQuery({
    queryKey: meKeys.itemsInProgress,
    queryFn: getItemsInProgress,
    staleTime: 30 * 1000,
  })

  const {
    data: shelves,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: libraryKeys.personalized(activeId ?? ''),
    queryFn: () => getPersonalized(activeId as string),
    enabled: activeId !== null,
    staleTime: 2 * 60 * 1000,
  })

  const progressById = useMediaProgress()

  // Dismissals hide series/books from the Continue-* shelves (and the queue).
  const hydrateDismissals = useDismissalsStore((s) => s.hydrate)
  const dismissedSeries = useDismissalsStore((s) => s.seriesIds)
  const dismissedItems = useDismissalsStore((s) => s.itemIds)
  useEffect(() => {
    void hydrateDismissals()
  }, [hydrateDismissals])
  const dismissedSeriesSet = useMemo(() => new Set(dismissedSeries), [dismissedSeries])
  const dismissedItemSet = useMemo(() => new Set(dismissedItems), [dismissedItems])

  // Continue-Series is built from @hearthshelf/core (real series ids per tile,
  // which the "Hide this series" action needs), off the /series endpoint - not
  // ABS's own continue-series row (whose minified items carry only a name).
  const { data: seriesData } = useQuery({
    queryKey: ['home-series', activeId ?? ''],
    queryFn: () => getSeries(activeId as string, 0, 1000),
    enabled: activeId !== null,
    staleTime: 2 * 60 * 1000,
  })
  const continueSeries = useMemo(() => {
    const all = seriesData?.results ?? []
    if (!all.length) return []
    return continueSeriesShelf(all, progressById, {
      seriesIds: dismissedSeries,
      itemIds: dismissedItems,
    })
  }, [seriesData, progressById, dismissedSeries, dismissedItems])

  const inProgress = progress?.libraryItems ?? []
  const hero = inProgress[0]
  const heroProgress = hero ? progressById.get(hero.id) : undefined
  const heroPct = heroProgress?.progress ?? 0

  // HearthShelf's own taste engine feeds Home's recommendation bands - our
  // recommendations, not ABS's cross-library "discover" feed (which surfaces
  // other household members' books).
  const discoverEnabled = useDiscoverEnabled()
  const { data: libraryData } = useQuery({
    queryKey: libraryKeys.allItems(activeId ?? ''),
    queryFn: () => getAllLibraryItems(activeId as string),
    enabled: activeId !== null && discoverEnabled,
    staleTime: 5 * 60 * 1000,
  })
  const libItems = useMemo(() => libraryData?.results ?? [], [libraryData])
  const libById = useMemo(() => new Map(libItems.map((it) => [it.id, it])), [libItems])
  const hasLib = libItems.length > 0
  const questGiverPicks = useQuestGiverPicks(discoverEnabled && hasLib)
  const { data: feedback } = useDiscoverFeedbackQuery(discoverEnabled && hasLib)
  const { data: monthly } = useMonthlyShelf(libItems, progressById, discoverEnabled && hasLib)

  // Taste-engine rows keyed by the Home section they belong to, so the
  // arrangement walk can render a whole section's shelves at its chosen spot.
  // Fixed-id shelves ('recommended', 'series-next', 'recent', 'questgiver') each
  // get their own arrangeable section; the taste-derived rows (genre / author /
  // narrator / cold) share the 'recommended-picks' block and are capped by
  // homeRecShelfCount, so the listener decides how much of Home the engine fills.
  const recBySection = useMemo(() => {
    const map = new Map<HomeSectionId, DiscoverShelf[]>()
    if (!discoverEnabled || !hasLib) return map
    const { shelves } = buildDiscoverShelves(libItems, progressById)
    const ranked = rankDiscoverShelves(shelves, libById, {
      questGiverPicks,
      feedback: feedback ?? {},
    })
    let generated = 0
    for (const s of ranked) {
      if (isGeneratedRecShelf(s.id)) {
        if (generated >= recShelfCount) continue
        generated++
      }
      const section = (GENERAL_REC_SECTIONS[s.id] ?? 'recommended-picks') as HomeSectionId
      const arr = map.get(section)
      if (arr) arr.push(s)
      else map.set(section, [s])
    }
    return map
  }, [
    discoverEnabled,
    hasLib,
    libItems,
    progressById,
    libById,
    questGiverPicks,
    feedback,
    recShelfCount,
  ])

  // The monthly AI shelf resolved to owned items, not-interested filtered out.
  const aiPreview = useMemo(() => {
    if (!discoverEnabled || !monthly || monthly.engine === 'none') return null
    const fb = feedback ?? {}
    const items = monthly.picks
      .map((p) => libById.get(p.id))
      .filter((it): it is ABSLibraryItem => Boolean(it) && fb[it!.id]?.vote !== 'not_interested')
      .slice(0, 12)
    if (items.length === 0) return null
    return { intro: monthly.intro?.trim() || 'Your shelf this month', items }
  }, [discoverEnabled, monthly, libById, feedback])

  // ABS shelves we keep, indexed by the Home section id they render as. Order
  // comes from the arrangement now, not a fixed rank - so this is a lookup, not
  // a sorted list. Dropped: ABS's recommendation rows (our taste engine replaces
  // them) and ABS's own continue-series (we build our own, with real series ids).
  type KeptShelf = Extract<ABSShelf, { type: 'book' | 'series' }>
  const absBySection = new Map<HomeSectionId, KeptShelf[]>()
  for (const sh of shelves ?? []) {
    if (sh.type !== 'book' && sh.type !== 'series') continue
    if (TAINTED_ABS_SHELVES.has(sh.id) || sh.id === 'continue-series') continue
    if (sh.entities.length === 0) continue
    // continue-listening has its own section; every other kept ABS row
    // (recently-added, recent-series) travels with the Recently Added band.
    const section: HomeSectionId =
      sh.id === 'continue-listening' ? 'continue-listening' : 'recently-added'
    const arr = absBySection.get(section)
    if (arr) arr.push(sh)
    else absBySection.set(section, [sh])
  }

  const hasAnyContent =
    absBySection.size > 0 ||
    inProgress.length > 0 ||
    continueSeries.length > 0 ||
    recBySection.size > 0 ||
    Boolean(aiPreview)
  const allSectionsHidden = hasAnyContent && homeSections.every((s) => !s.on)

  // A plain taste-engine tile, shared by every recommendation band.
  const renderTile = (item: ABSLibraryItem) => {
    const p = progressById.get(item.id)
    return (
      <BookTile
        key={item.id}
        item={item}
        progress={p?.progress ?? 0}
        finished={p?.isFinished}
        fs={compact ? 12 : 15}
        compact={compact}
      />
    )
  }

  return (
    <div className={'page fade-in' + (compact ? ' home-compact' : '')}>
      <div className="home-head-row">
        <div>
          <div className="eyebrow">HearthShelf</div>
          <h1 className="title-xl">
            {greetingWord()}, {user?.username}
          </h1>
          {hero ? (
            <p className="page-sub">
              You're {Math.round(heroPct * 100)}% through{' '}
              <b style={{ color: 'var(--text)' }}>{hero.media.metadata.title}</b> ·{' '}
              {inProgress.length} {inProgress.length === 1 ? 'book' : 'books'} on the go
              {unifiedHome ? (
                <>
                  {' '}
                  <Icon name="hub" /> across all libraries
                </>
              ) : (
                active && ` in ${active.name}`
              )}
            </p>
          ) : (
            <p className="page-sub">Nothing in progress yet</p>
          )}
        </div>
        {!isMobile && !editing && (
          <div className="hero-switch">
            <button
              className="pill"
              onClick={() => setEditing(true)}
              title="Arrange the sections on your home screen"
            >
              <Icon name="edit" /> Arrange
            </button>
            <div className="seg">
              <button
                className={heroStyle === 'comfy' ? 'on' : ''}
                onClick={() => chooseHero('comfy')}
              >
                Comfy
              </button>
              <button
                className={heroStyle === 'compact' ? 'on' : ''}
                onClick={() => chooseHero('compact')}
              >
                Compact
              </button>
            </div>
          </div>
        )}
      </div>

      {hero && !compact && <ResumeHero book={hero} progress={heroProgress} />}
      {hero && compact && <CalmHero book={hero} progress={heroProgress} />}

      <HomeRequestsShelf />

      {isLoading && <LoadingSpinner className="py-12" label="Loading shelves..." />}
      {isError && <ErrorState message="Could not load your shelves." onRetry={refetch} />}

      {editing ? (
        <HomeSectionsEditor onDone={() => setEditing(false)} />
      ) : allSectionsHidden ? (
        // The user hid every band. Say so plainly, with a way straight back to
        // arrange mode, so a bare Home reads as a choice and not a failure.
        <div className="empty-state">
          <Icon name="visibility_off" />
          <h3>Every section is hidden</h3>
          <p>Your home screen is empty because all of its sections are turned off.</p>
          <button className="btn btn-primary" onClick={() => setEditing(true)}>
            <Icon name="edit" /> Arrange your home
          </button>
        </div>
      ) : (
        // Render the bands in the order the user arranged, skipping hidden ones.
        homeSections.map((sec) => {
          if (!sec.on) return null
          switch (sec.id) {
            case 'dashboard':
              return <DashboardRow key={sec.id} />

            case 'release-countdown':
              return <ReleaseCountdownBanner key={sec.id} />

            case 'book-club':
              return <HomeClubShelf key={sec.id} />

            // The monthly AI shelf rides with the QuestGiver band - both are the
            // "picked for you by name" flavour of recommendation.
            case 'questgiver':
              return (
                <Fragment key={sec.id}>
                  {aiPreview && (
                    <ShelfSection icon="auto_awesome" title={aiPreview.intro}>
                      {aiPreview.items.map(renderTile)}
                    </ShelfSection>
                  )}
                  {(recBySection.get('questgiver') ?? []).map((shelf) => (
                    <ShelfSection
                      key={shelf.id}
                      icon={shelf.icon}
                      title={shelf.label}
                      onMore={() => navigate('/discover')}
                    >
                      {shelf.items.map(renderTile)}
                    </ShelfSection>
                  ))}
                </Fragment>
              )

            case 'continue-series':
              // Built from core, so each tile carries a real series id - which
              // the "Hide this series" action needs.
              if (continueSeries.length === 0) return null
              return (
                <ShelfSection
                  key={sec.id}
                  icon={SHELF_ICONS['continue-series'] ?? 'auto_stories'}
                  title="Continue Series"
                >
                  {continueSeries.map(({ series, nextBook }) => {
                    const p = progressById.get(nextBook.id)
                    return (
                      <BookTile
                        key={nextBook.id}
                        item={nextBook}
                        progress={p?.progress ?? 0}
                        finished={p?.isFinished}
                        fs={compact ? 12 : 15}
                        compact={compact}
                        source="series"
                        seriesId={series.id}
                        seriesName={series.name}
                      />
                    )
                  })}
                </ShelfSection>
              )

            case 'continue-listening':
            case 'recently-added':
              return (
                <Fragment key={sec.id}>
                  {(absBySection.get(sec.id) ?? []).map((sh) => {
                    const isContinueListening = sh.id === 'continue-listening'
                    if (sh.type === 'series') {
                      return (
                        <div className="section" key={sh.id}>
                          <SectionHead
                            icon={SHELF_ICONS[sh.id] ?? 'library_books'}
                            title={sh.label}
                          />
                          <div className="series-grid">
                            {sh.entities
                              .filter((s) => !dismissedSeriesSet.has(s.id))
                              .map((s) => (
                                <SeriesCard key={s.id} series={s} />
                              ))}
                          </div>
                        </div>
                      )
                    }
                    return (
                      <ShelfSection
                        key={sh.id}
                        icon={SHELF_ICONS[sh.id] ?? 'library_books'}
                        title={sh.label}
                      >
                        {sh.entities
                          // Hide books the user dismissed from Continue-Listening.
                          .filter(
                            (item) => !(isContinueListening && dismissedItemSet.has(item.id)),
                          )
                          .map((item) => {
                            const p = progressById.get(item.id)
                            return (
                              <BookTile
                                key={item.id}
                                item={item}
                                progress={p?.progress ?? 0}
                                finished={p?.isFinished}
                                fs={compact ? 12 : 15}
                                compact={compact}
                                source={isContinueListening ? 'listening' : 'browse'}
                              />
                            )
                          })}
                      </ShelfSection>
                    )
                  })}
                </Fragment>
              )

            // Every remaining section is a taste-engine band: one shelf for the
            // fixed-id ones, and the whole capped set for 'recommended-picks'.
            default:
              return (
                <Fragment key={sec.id}>
                  {(recBySection.get(sec.id) ?? []).map((shelf) => (
                    <ShelfSection
                      key={shelf.id}
                      icon={shelf.icon}
                      title={shelf.label}
                      onMore={() => navigate('/discover')}
                    >
                      {shelf.items.map(renderTile)}
                    </ShelfSection>
                  ))}
                </Fragment>
              )
          }
        })
      )}
    </div>
  )
}

// A titled row of book tiles - the shape every Home band shares.
function ShelfSection({
  icon,
  title,
  onMore,
  children,
}: {
  icon?: string
  title: string
  onMore?: () => void
  children: ReactNode
}) {
  return (
    <div className="section">
      <SectionHead icon={icon} title={title} onMore={onMore} />
      <div className="shelf-row">{children}</div>
    </div>
  )
}
