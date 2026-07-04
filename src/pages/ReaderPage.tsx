import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import ePub, { type Book, type Rendition, type NavItem } from 'epubjs'
import { cfiStorageKey, readerDimOpacity, audioAnchorFraction } from '@hearthshelf/core'
import { getItem, ebookUrl, libraryKeys } from '@/api/libraries'
import { useAuthStore } from '@/store/authStore'
import { usePlayerStore } from '@/store/playerStore'
import { usePlayer } from '@/hooks/usePlayer'
import {
  useReaderPrefs,
  READER_THEMES,
  READER_FONT_STACKS,
  READER_WIDTHS,
  READER_LINE_HEIGHTS,
  type ReaderPrefs,
} from '@/store/readerPrefsStore'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'
import { ReaderSettingsPanel } from '@/components/reader/ReaderSettingsPanel'

interface ReaderPageProps {
  // When set, the reader renders as an inline "read along" panel (e.g. beside
  // the desktop player) instead of the full-screen route: a close (X) button,
  // a "Read along" eyebrow, and no audio-jump chrome. Falls back to the route
  // params + full-screen layout when omitted.
  itemId?: string
  inline?: boolean
  onClose?: () => void
}

export function ReaderPage({ itemId: itemIdProp, inline, onClose }: ReaderPageProps = {}) {
  const params = useParams()
  const itemId = itemIdProp ?? params.itemId
  const navigate = useNavigate()
  const prefs = useReaderPrefs()
  const theme = READER_THEMES[prefs.theme]

  const viewerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [toc, setToc] = useState<NavItem[]>([])
  const [progress, setProgress] = useState(0)
  const [chapterLabel, setChapterLabel] = useState('')
  const [panel, setPanel] = useState<'settings' | 'chapters' | null>(null)

  const { data: detail } = useQuery({
    queryKey: libraryKeys.item(itemId ?? ''),
    queryFn: () => getItem(itemId as string),
    enabled: Boolean(itemId),
    staleTime: 10 * 60 * 1000,
  })
  const title = detail?.media.metadata.title ?? 'Reading'
  const author = detail?.media.metadata.authors?.[0]?.name ?? ''

  // Read-along: when the same title is playing, offer a jump to the audio's
  // rough place. The two are never force-synced.
  const sessionId = usePlayerStore((s) => s.libraryItemId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const audioCurrent = usePlayerStore((s) => s.currentTime)
  const audioDuration = usePlayerStore((s) => s.duration)
  const audioOn = !!itemId && sessionId === itemId
  const { playItem } = usePlayer()
  const hasAudio = (detail?.media.numAudioFiles ?? 0) > 0

  // Move the reading position to roughly where the audio is. epub.js maps a
  // percentage through the page through the book to a CFI; the audio's
  // elapsed fraction is the best cross-medium anchor we have (no per-word sync).
  const jumpToAudioSpot = useCallback(() => {
    const book = bookRef.current
    const rendition = renditionRef.current
    if (!book || !rendition || audioDuration <= 0) return
    const pct = audioAnchorFraction(audioCurrent, audioDuration)
    const cfi = book.locations.cfiFromPercentage(pct)
    if (cfi) void rendition.display(cfi)
  }, [audioCurrent, audioDuration])

  // ---- Build the epub.js book + rendition once we have an item + viewer ----
  useEffect(() => {
    if (!itemId || !viewerRef.current) return
    const viewer = viewerRef.current
    let cancelled = false
    let book: Book | null = null
    let rendition: Rendition | null = null
    setLoading(true)
    setLoadError(false)

    // Fetch the EPUB as binary first. Passing an ArrayBuffer (rather than the
    // authed `?token=` URL) avoids epub.js's URL-extension sniffing and lets the
    // proxy authenticate the request like any other fetch.
    const authToken = useAuthStore.getState().token
    fetch(ebookUrl(itemId, authToken))
      .then((res) => {
        if (!res.ok) throw new Error(`ebook ${res.status}`)
        return res.arrayBuffer()
      })
      .then((buf) => {
        if (cancelled) return
        book = ePub(buf)
        bookRef.current = book
        const flow = prefs.layout === 'paged' ? 'paginated' : 'scrolled'
        rendition = book.renderTo(viewer, {
          width: '100%',
          height: '100%',
          flow,
          spread: 'none',
          allowScriptedContent: false,
        })
        renditionRef.current = rendition

        const savedCfi = localStorage.getItem(cfiStorageKey(itemId)) || undefined
        rendition
          .display(savedCfi)
          .then(() => {
            if (!cancelled) setLoading(false)
          })
          .catch(() => {
            if (!cancelled) {
              setLoadError(true)
              setLoading(false)
            }
          })

        book.ready
          .then(() => book?.locations.generate(1600))
          .then(() => {
            if (cancelled || !book) return
            setToc(book.navigation?.toc ?? [])
          })
          .catch(() => {})

        rendition.on('relocated', onRelocated)
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(true)
          setLoading(false)
        }
      })

    function onRelocated(loc: { start: { cfi: string; href: string } }) {
      if (cancelled || !book || !itemId) return
      localStorage.setItem(cfiStorageKey(itemId), loc.start.cfi)
      const pct = book.locations.percentageFromCfi(loc.start.cfi)
      if (typeof pct === 'number' && !Number.isNaN(pct)) setProgress(pct)
      const item = book.navigation?.get(loc.start.href)
      if (item?.label) setChapterLabel(item.label.trim())
    }

    return () => {
      cancelled = true
      rendition?.destroy()
      book?.destroy()
      bookRef.current = null
      renditionRef.current = null
    }
    // Recreate when the book or the flow-affecting layout changes. Token is
    // read fresh (getState) so auth refreshes don't churn the rendition.
  }, [itemId, prefs.layout])

  // ---- Apply typographic prefs to the rendition without rebuilding it ----
  const applyTheme = useCallback(() => {
    const r = renditionRef.current
    if (!r) return
    const t = READER_THEMES[prefs.theme]
    r.themes.override('color', t.ink)
    r.themes.override('background', t.bg)
    r.themes.fontSize(`${prefs.size}px`)
    r.themes.font(READER_FONT_STACKS[prefs.font])
    r.themes.override('line-height', String(READER_LINE_HEIGHTS[prefs.lh]))
    r.themes.override('text-align', prefs.align)
    r.themes.override('max-width', `${READER_WIDTHS[prefs.width]}px`)
    r.themes.override('margin', '0 auto')
    // Drop-cap on the opening paragraph of each chapter - a quiet print touch.
    // Injected into the rendered EPUB via epub.js's default-theme stylesheet so
    // it lands inside the content iframe (override() can't reach pseudo-elements).
    r.themes.default({
      'p:first-of-type::first-letter': {
        'font-size': '3.1em',
        'line-height': '0.82',
        float: 'left',
        'padding-right': '0.08em',
        'font-weight': '600',
        color: t.ink,
      },
    })
  }, [prefs.theme, prefs.size, prefs.font, prefs.lh, prefs.align, prefs.width])

  useEffect(() => {
    applyTheme()
  }, [applyTheme, loading])

  // ---- Navigation ----
  const next = () => renditionRef.current?.next()
  const prev = () => renditionRef.current?.prev()
  const goHref = (href: string) => {
    setPanel(null)
    renditionRef.current?.display(href)
  }
  const back = () => (inline && onClose ? onClose() : navigate(-1))

  // Keyboard: arrows page, Escape closes panel / exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (panel) setPanel(null)
        else back()
      } else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel])

  const setPref = <K extends keyof ReaderPrefs>(k: K, v: ReaderPrefs[K]) => prefs.set(k, v)

  const isPaged = prefs.layout === 'paged'

  const rootStyle = {
    ['--rd-bg' as string]: theme.bg,
    ['--rd-ink' as string]: theme.ink,
    ['--rd-faint' as string]: theme.faint,
    ['--rd-line' as string]: theme.line,
    ['--rd-fill' as string]: theme.fill,
    ['--rd-surface' as string]: theme.surface,
  }
  const dim = readerDimOpacity(prefs.brightness)

  if (!itemId) return <ErrorState message="No book selected." />

  return (
    <div className={'reader fade-in' + (inline ? ' inline' : '')} style={rootStyle}>
      <div className="reader-top">
        <button
          className="rd-btn rd-icon"
          onClick={back}
          title={inline ? 'Close read-along' : 'Close reader'}
        >
          <Icon name={inline ? 'close' : 'arrow_back'} />
        </button>
        <div className="rt-title">
          <div className="rt-k">
            {inline ? 'Read along' : 'Reading'}
            {author ? ` · ${author}` : ''}
          </div>
          <div className="rt-t">{title}</div>
        </div>
        <div className="rt-spacer" />

        {/* In the inline player panel the player itself owns audio controls,
            so the reader hides its own audio-jump / open-player chrome. */}
        {!inline && audioOn ? (
          <>
            {audioDuration > 0 && (
              <button
                className="rd-btn rd-icon"
                onClick={jumpToAudioSpot}
                title="Jump to where the audio is"
              >
                <Icon name="my_location" />
              </button>
            )}
            <button
              className="rd-btn rd-icon"
              onClick={() => navigate('/player')}
              title={isPlaying ? 'Listening - open the player' : 'Open the player'}
            >
              <Icon name={isPlaying ? 'graphic_eq' : 'headphones'} fill={isPlaying} />
            </button>
          </>
        ) : !inline && hasAudio ? (
          <button
            className="rd-btn rd-icon"
            onClick={() => void playItem(itemId)}
            title="Switch to listening"
          >
            <Icon name="headphones" />
          </button>
        ) : null}

        <button
          className={'rd-btn rd-icon' + (panel === 'chapters' ? ' on' : '')}
          onClick={() => setPanel((p) => (p === 'chapters' ? null : 'chapters'))}
          title="Chapters"
          disabled={toc.length === 0}
        >
          <Icon name="list" />
        </button>
        <button
          className={'rd-btn rd-aa' + (panel === 'settings' ? ' on' : '')}
          onClick={() => setPanel((p) => (p === 'settings' ? null : 'settings'))}
          title="Display settings"
        >
          <b className="rd-aa-l">A</b>
          <b className="rd-aa-s">a</b>
        </button>

        <div className="rd-rail">
          <i style={{ width: Math.round(progress * 100) + '%' }} />
        </div>
      </div>

      {panel === 'settings' && (
        <ReaderSettingsPanel prefs={prefs} setPref={setPref} onClose={() => setPanel(null)} />
      )}
      {panel === 'chapters' && (
        <div className="rd-panel rd-chapters" onClick={(e) => e.stopPropagation()}>
          <div className="rp-sec">Chapters</div>
          <div className="rd-chap-list">
            {toc.map((c) => {
              const current = chapterLabel === c.label.trim()
              return (
                <button
                  key={c.href}
                  className={'rd-chap-item' + (current ? ' on' : '')}
                  onClick={() => goHref(c.href)}
                >
                  <span className="rd-chap-l">{c.label.trim()}</span>
                  {current && audioOn && isPlaying && (
                    <Icon name="graphic_eq" fill className="rd-chap-audio" title="Audio is here" />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="reader-stage" onClick={() => panel && setPanel(null)}>
        {loading && <LoadingSpinner className="reader-loading" label="Opening book..." />}
        {loadError && (
          <div className="reader-loading">
            <ErrorState message="Could not open this ebook." onRetry={() => navigate(0)} />
          </div>
        )}
        <div ref={viewerRef} className="reader-viewer" />
        <div className="reader-dim" style={{ opacity: dim }} />
      </div>

      <div className="rd-pagebar">
        <button className="rd-pg" onClick={prev} title="Previous">
          <Icon name="chevron_left" />
        </button>
        <span className="rd-pgnum">
          {Math.round(progress * 100)}%{chapterLabel ? ` · ${chapterLabel}` : ''}
        </span>
        <button className="rd-pg" onClick={next} title="Next">
          <Icon name="chevron_right" />
        </button>
      </div>

      {!isPaged && <span className="rd-scroll-hint" aria-hidden="true" />}
    </div>
  )
}
