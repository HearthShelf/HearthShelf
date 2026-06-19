import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { getPersonalized, libraryKeys } from '@/api/libraries'
import { getItemsInProgress, meKeys } from '@/api/me'
import { useAuth } from '@/hooks/useAuth'
import { usePlayer } from '@/hooks/usePlayer'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { usePlayerStore } from '@/store/playerStore'
import type { ABSLibraryItem, ABSMediaProgress } from '@/api/types'
import { Cover, tintFor } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { SectionHead } from '@/components/common/SectionHead'
import { BookTile } from '@/components/library/BookTile'
import { SeriesCard } from '@/components/library/SeriesCard'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

const SHELF_ICONS: Record<string, string> = {
  'recently-added': 'schedule',
  'recent-series': 'auto_stories',
  'continue-series': 'auto_stories',
  discover: 'explore',
  'continue-listening': 'play_circle',
}

function greetingWord(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

type HeroStyle = 'resume' | 'calm'

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
    <div
      data-cv={tintFor(title ?? 'Untitled')}
      className="hero-resume-card"
    >
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
        <div
          style={{ color: 'var(--text-muted)', fontSize: 14.5, marginBottom: 14 }}
        >
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
        <div
          className="prog-line"
          style={{ maxWidth: 460, marginBottom: 22 }}
        >
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
        style={{ width: 76, height: 76, borderRadius: 12, flex: 'none' }}
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
  const { user } = useAuth()
  const { active, activeId } = useActiveLibrary()
  const [heroStyle, setHeroStyle] = useState<HeroStyle>('resume')

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

  return (
    <div className="page fade-in">
      <div className="home-head-row">
        <div>
          <div className="eyebrow">HearthShelf</div>
          <h1 className="title-xl">
            {greetingWord()}, {user?.username}
          </h1>
          {hero ? (
            <p className="page-sub">
              You're {Math.round(heroPct * 100)}% through{' '}
              <b style={{ color: 'var(--text)' }}>
                {hero.media.metadata.title}
              </b>{' '}
              · {inProgress.length}{' '}
              {inProgress.length === 1 ? 'book' : 'books'} on the go
              {active && ` in ${active.name}`}
            </p>
          ) : (
            <p className="page-sub">Nothing in progress yet</p>
          )}
        </div>
        <div className="hero-switch">
          <div className="seg">
            <button
              className={heroStyle === 'resume' ? 'on' : ''}
              onClick={() => setHeroStyle('resume')}
            >
              Resume
            </button>
            <button
              className={heroStyle === 'calm' ? 'on' : ''}
              onClick={() => setHeroStyle('calm')}
            >
              Calm
            </button>
          </div>
        </div>
      </div>

      {hero && heroStyle === 'resume' && (
        <ResumeHero book={hero} progress={heroProgress} />
      )}
      {hero && heroStyle === 'calm' && (
        <CalmHero book={hero} progress={heroProgress} />
      )}

      {isLoading && <LoadingSpinner className="py-12" label="Loading shelves..." />}
      {isError && (
        <ErrorState message="Could not load your shelves." onRetry={refetch} />
      )}

      {shelves
        ?.filter((sh) => sh.type === 'book' || sh.type === 'series')
        .map((sh) => (
          <div className="section" key={sh.id}>
            <SectionHead
              icon={SHELF_ICONS[sh.id] ?? 'library_books'}
              title={sh.label}
            />
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
