import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { getPersonalized, getAllLibraryItems, libraryKeys } from '@/api/libraries'
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
import { buildDiscoverShelves, discoverHomePreview } from '@/lib/discover'
import { useMonthlyShelf, useDiscoverFeedbackQuery } from '@/hooks/useDiscover'
import { useQuestGiverPicks } from '@/hooks/useQuestGiverPicks'
import { useDiscoverEnabled } from '@/hooks/useQuestGiver'

const SHELF_ICONS: Record<string, string> = {
  'recently-added': 'schedule',
  'recent-series': 'auto_stories',
  'continue-series': 'auto_stories',
  discover: 'explore',
  'continue-listening': 'play_circle',
}

// Display order for the ABS shelves we keep on Home (progress + library rows).
// Recommendation shelves are dropped (TAINTED_ABS_SHELVES) and replaced by the
// taste engine. Any kept shelf id not listed falls to the end in original order.
const SHELF_ORDER = ['continue-listening', 'continue-series', 'recently-added', 'recent-series']

function shelfRank(id: string): number {
  const i = SHELF_ORDER.indexOf(id)
  return i === -1 ? SHELF_ORDER.length : i
}

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
  const inProgress = progress?.libraryItems ?? []
  const hero = inProgress[0]
  const heroProgress = hero ? progressById.get(hero.id) : undefined
  const heroPct = heroProgress?.progress ?? 0

  // HearthShelf's own taste engine feeds the Home discovery preview - our
  // recommendations, not ABS's cross-library "discover" feed (which surfaces
  // other household members' books). Home shows a single lead shelf; the full
  // set lives on the Discover page.
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

  const previewShelf = useMemo(() => {
    if (!discoverEnabled || !hasLib) return null
    const { shelves } = buildDiscoverShelves(libItems, progressById)
    return discoverHomePreview(shelves, libById, {
      questGiverPicks,
      feedback: feedback ?? {},
    })
  }, [discoverEnabled, hasLib, libItems, progressById, libById, questGiverPicks, feedback])

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
        {!isMobile && (
          <div className="hero-switch">
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

      {aiPreview && (
        <div className="section">
          <SectionHead icon="auto_awesome" title={aiPreview.intro} />
          <div className="shelf-row">
            {aiPreview.items.map((item) => {
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
            })}
          </div>
        </div>
      )}

      {previewShelf && (
        <div className="section">
          <SectionHead
            icon={previewShelf.icon}
            title={previewShelf.label}
            onMore={() => navigate('/discover')}
          />
          <div className="shelf-row">
            {previewShelf.items.map((item) => {
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
            })}
          </div>
        </div>
      )}

      {isLoading && <LoadingSpinner className="py-12" label="Loading shelves..." />}
      {isError && <ErrorState message="Could not load your shelves." onRetry={refetch} />}

      {shelves
        ?.filter(
          (sh) =>
            (sh.type === 'book' || sh.type === 'series') &&
            // Drop ABS's own recommendation + finished-again rows: our taste
            // engine handles recommendations (above), and "discover" mixes in
            // other users' books. "continue-series" is folded into the hero flow.
            !TAINTED_ABS_SHELVES.has(sh.id),
        )
        .sort((a: ABSShelf, b: ABSShelf) => shelfRank(a.id) - shelfRank(b.id))
        .map((sh) => (
          <div className="section" key={sh.id}>
            <SectionHead icon={SHELF_ICONS[sh.id] ?? 'library_books'} title={sh.label} />
            {sh.type === 'book' && (
              <div className="shelf-row">
                {sh.entities.map((item) => {
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
                })}
              </div>
            )}
            {sh.type === 'series' && (
              <div className="series-grid">
                {sh.entities.map((s) => (
                  <SeriesCard key={s.id} series={s} />
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  )
}
