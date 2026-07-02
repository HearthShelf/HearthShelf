import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { usePlayerStore } from '@/store/playerStore'
import { usePlayer } from '@/hooks/usePlayer'
import { useSettingsStore } from '@/store/settingsStore'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useSleepTimer } from '@/hooks/useSleepTimer'
import { SpeedPopover, SleepPopover } from '@/components/player/PlayerPopovers'
import { RecentListens } from '@/components/player/RecentListens'
import { ReaderPage } from '@/pages/ReaderPage'
import { MobilePlayer } from '@/components/player/MobilePlayer'
import { useBookmarks } from '@/hooks/useBookmarks'
import { AddToListMenu } from '@/components/library/AddToListMenu'
import { useQueueStore, type QueueMode, type AutoRuleId } from '@/store/queueStore'
import { getItem, libraryKeys } from '@/api/libraries'
import { getMe, meKeys } from '@/api/me'
import { getNotes, notesKeys } from '@/api/notes'
import { syncSession } from '@/api/playback'
import { formatTimestamp, stripHtml } from '@/lib/format'
import { Cover } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { Stars } from '@/components/common/Stars'
import { NotesPop } from '@/components/social/NotesPop'
import { ClubPanel } from '@/components/social/ClubPanel'
import { TimelineMarkers } from '@/components/social/TimelineMarkers'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import type { ABSChapter } from '@/api/types'
import cozyHearth from '@/assets/img/SittingInTheHearth.webp'

type Panel = 'chapters' | 'details' | 'queue' | 'reader' | 'club' | null
type Pop = 'speed' | 'sleep' | 'bookmark' | 'recent' | 'notes' | null

function PanelHead({
  icon,
  title,
  sub,
  onClose,
}: {
  icon: string
  title: string
  sub?: string
  onClose: () => void
}) {
  return (
    <div className="pp-head">
      <Icon name={icon} />
      <div className="pp-htext">
        <div className="pp-title">{title}</div>
        {sub && <div className="pp-sub">{sub}</div>}
      </div>
      <button className="icon-btn" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  )
}

function ChaptersPanel({
  chapters,
  curIdx,
  onSeek,
  onClose,
}: {
  chapters: ABSChapter[]
  curIdx: number
  onSeek: (start: number) => void
  onClose: () => void
}) {
  const left = chapters.length - curIdx
  return (
    <div className="pp-inner">
      <PanelHead
        icon="list"
        title="Chapters"
        sub={`${chapters.length} chapters · ${left} left`}
        onClose={onClose}
      />
      <div className="chap-list pp-scroll">
        {chapters.map((c, i) => {
          const isNow = i === curIdx
          const done = i < curIdx
          return (
            <div
              className={'chap' + (isNow ? ' now' : '') + (done ? ' done' : '')}
              key={c.id}
              style={{ cursor: 'pointer' }}
              onClick={() => onSeek(c.start)}
            >
              <span className="n">
                {isNow ? (
                  <Icon name="graphic_eq" fill style={{ fontSize: 16 }} />
                ) : done ? (
                  <Icon name="check" style={{ fontSize: 15 }} />
                ) : (
                  i + 1
                )}
              </span>
              <span className="ct">{c.title}</span>
              <span className="cd">{formatTimestamp(c.end - c.start)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const QUEUE_MODES: { v: QueueMode; l: string }[] = [
  { v: 'off', l: 'Off' },
  { v: 'manual', l: 'Manual' },
  { v: 'auto', l: 'Auto' },
  { v: 'playlist', l: 'Playlist' },
]
const QUEUE_MODE_SUB: Record<QueueMode, string> = {
  off: 'Playback stops when this book ends.',
  manual: 'Your hand-picked order — drag to arrange.',
  auto: "Filled automatically from what you're listening to.",
  playlist: 'Playing in order from a saved list.',
}
const RULE_COPY: Record<AutoRuleId, { label: string; desc: string }> = {
  'finish-series': {
    label: 'Finish the current series',
    desc: "Queue the next book whenever you're part-way through a series.",
  },
  'in-progress': {
    label: 'Anything in progress',
    desc: 'Keep going with books you already started.',
  },
  'new-in-series': {
    label: 'New books in a series',
    desc: "Suggest the first unread book in any series you've started.",
  },
}

function QueuePanel({
  nowId,
  nowTitle,
  nowAuthor,
  onClose,
  onPlay,
}: {
  nowId: string
  nowTitle: string
  nowAuthor: string
  onClose: () => void
  onPlay: (id: string) => void
}) {
  const items = useQueueStore((s) => s.items)
  const remove = useQueueStore((s) => s.remove)
  const reorder = useQueueStore((s) => s.reorder)
  const setQueueMode = useQueueStore((s) => s.setMode)
  const queueMode = useSettingsStore((s) => s.queueMode)
  const setSetting = useSettingsStore((s) => s.set)
  const autoRules = useSettingsStore((s) => s.queueAutoRules)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [showRules, setShowRules] = useState(false)

  const setMode = (v: QueueMode) => {
    setSetting('queueMode', v)
    setQueueMode(v)
  }
  const toggleRule = (id: AutoRuleId) =>
    setSetting(
      'queueAutoRules',
      autoRules.map((r) => (r.id === id ? { ...r, on: !r.on } : r)),
    )

  const panelSub =
    queueMode === 'manual'
      ? `${items.length + 1} in queue · drag to reorder`
      : `${items.length + 1} in queue`

  return (
    <div className="pp-inner">
      <PanelHead icon="reorder" title="Up next" sub={panelSub} onClose={onClose} />

      {/* Mode selector */}
      <div style={{ padding: '8px 20px 0' }}>
        <div
          style={{
            display: 'flex',
            gap: 4,
            background: 'var(--fill)',
            border: '1px solid var(--hairline)',
            borderRadius: 999,
            padding: 4,
          }}
        >
          {QUEUE_MODES.map((m) => (
            <button
              key={m.v}
              className={'mp-seg' + (queueMode === m.v ? ' on' : '')}
              onClick={() => setMode(m.v)}
              style={{ flex: 1 }}
            >
              {m.l}
            </button>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '8px 4px 12px',
          }}
        >
          <span style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-muted)' }}>
            {QUEUE_MODE_SUB[queueMode]}
          </span>
          {queueMode === 'auto' && (
            <button
              className={'pill' + (showRules ? ' on' : '')}
              style={{ flex: 'none', fontSize: 12 }}
              onClick={() => setShowRules((s) => !s)}
            >
              <Icon name="tune" style={{ fontSize: 15 }} /> Auto rules
            </button>
          )}
        </div>
        {queueMode === 'auto' && showRules && (
          <div style={{ marginBottom: 12 }}>
            {autoRules.map((r) => {
              const copy = RULE_COPY[r.id]
              return (
                <div
                  key={r.id}
                  className="pop-row"
                  onClick={() => toggleRule(r.id)}
                  style={{ cursor: 'pointer', padding: '8px 4px', gap: 12 }}
                >
                  <div className="pr-t" style={{ flex: 1 }}>
                    {copy.label}
                    <div className="pr-d">{copy.desc}</div>
                  </div>
                  <div className={'toggle' + (r.on ? ' on' : '')}>
                    <i />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="pp-scroll">
        <div className="queue-row now">
          <span className="q-handle" style={{ opacity: 0.35, cursor: 'default' }}>
            <Icon name="graphic_eq" fill />
          </span>
          <Cover itemId={nowId} title={nowTitle} fs={3} />
          <div className="q-meta">
            <div className="q-t">{nowTitle}</div>
            <div className="q-s">Now playing · {nowAuthor}</div>
          </div>
        </div>
        {queueMode === 'off' ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: 8,
              padding: '32px 20px',
              color: 'var(--text-muted)',
            }}
          >
            <Icon name="do_not_disturb_on" style={{ fontSize: 36, opacity: 0.5 }} />
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              Nothing queued
            </div>
            <div style={{ fontSize: 12, maxWidth: 240, lineHeight: 1.45 }}>
              Playback stops when this book ends. Switch to Manual or Auto to keep going.
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="pop-empty" style={{ marginTop: 12 }}>
            Nothing queued. Add books with "Add to list".
          </div>
        ) : (
          items.map((q, i) => (
            <div
              className={'queue-row' + (dragIdx === i ? ' dragging' : '')}
              key={q.libraryItemId}
              draggable={queueMode === 'manual'}
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIdx !== null && dragIdx !== i) reorder(dragIdx, i)
                setDragIdx(null)
              }}
              onDragEnd={() => setDragIdx(null)}
            >
              <span
                className="q-handle"
                title={queueMode === 'manual' ? 'Drag to reorder' : undefined}
                style={queueMode !== 'manual' ? { opacity: 0.3, cursor: 'default' } : undefined}
              >
                <Icon name="drag_indicator" />
              </span>
              <Cover itemId={q.libraryItemId} title={q.title} fs={3} />
              <div
                className="q-meta"
                style={{ cursor: 'pointer' }}
                onClick={() => onPlay(q.libraryItemId)}
              >
                <div className="q-t">{q.title}</div>
                <div className="q-s">{q.author}</div>
              </div>
              <span className="bm-x" title="Remove" onClick={() => remove(q.libraryItemId)}>
                <Icon name="close" />
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function PlayerPage() {
  const navigate = useNavigate()
  const libraryItemId = usePlayerStore((s) => s.libraryItemId)
  const title = usePlayerStore((s) => s.title)
  const author = usePlayerStore((s) => s.author)
  const duration = usePlayerStore((s) => s.duration)
  const pos = usePlayerStore((s) => s.currentTime)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const chapters = usePlayerStore((s) => s.chapters)
  const speed = usePlayerStore((s) => s.playbackSpeed)
  const sessionId = usePlayerStore((s) => s.sessionId)
  const syncError = usePlayerStore((s) => s.syncError)
  const { togglePlaying, seek, playItem } = usePlayer()
  const setSpeed = usePlayerStore((s) => s.setSpeed)

  const skipFwd = useSettingsStore((s) => s.skipForward)
  const skipBack = useSettingsStore((s) => s.skipBack)
  const scrubber = useSettingsStore((s) => s.scrubber)
  const hearthBgPlayer = useSettingsStore((s) => s.hearthBgPlayer)
  const isMobile = useIsMobile()

  // Full sleep-timer controller (three modes + stop behaviours from Settings).
  const sleepCtl = useSleepTimer()

  const [panel, setPanel] = useState<Panel>(null)
  const [pop, setPop] = useState<Pop>(null)
  const [toast, setToast] = useState<string | null>(null)
  // The club whose panel is open, and a note to scroll to when a pop/marker
  // deep-links into the notes pop or club panel.
  const [openClubId, setOpenClubId] = useState<string | null>(null)
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null)

  const { bookmarks, addBookmark: addBookmarkApi, removeBookmark } = useBookmarks(libraryItemId)

  // The caller's id (for delete-own on notes) and their finished/position state
  // in this book (drives the notes spoiler gate + marker overlay).
  const { data: me } = useQuery({
    queryKey: meKeys.me,
    queryFn: getMe,
    staleTime: 5 * 60 * 1000,
  })
  const progressById = useMediaProgress()
  const myProgress = libraryItemId ? progressById.get(libraryItemId) : undefined
  const finishedHere = myProgress?.isFinished ?? false

  // Public notes for the playing book, for the seek-bar markers. Shares the
  // NotesSection/NotesPop query key so they invalidate together; the 30s
  // staleTime keeps it off the per-tick path. Degrades to nothing.
  const { data: notesData } = useQuery({
    queryKey: notesKeys.forItem(libraryItemId ?? ''),
    queryFn: () =>
      getNotes({ libraryItemId: libraryItemId as string, position: pos, finished: finishedHere }),
    enabled: !!libraryItemId,
    staleTime: 30 * 1000,
  })

  // Full metadata for the details panel (narrator, year, genre, series,
  // description, rating) - the player store only carries title/author/duration.
  const { data: detail } = useQuery({
    queryKey: libraryKeys.item(libraryItemId ?? ''),
    queryFn: () => getItem(libraryItemId as string),
    enabled: !!libraryItemId,
    staleTime: 5 * 60 * 1000,
  })
  const dm = detail?.media.metadata
  const hasEbook = !!detail?.media.ebookFile || !!detail?.media.ebookFormat

  // Reset player-only UI when the book CHANGES (not on first mount, so a panel
  // requested by the mini play bar survives navigation to this page).
  const firstSession = useRef(true)
  useEffect(() => {
    if (firstSession.current) {
      firstSession.current = false
      return
    }
    setPanel(null)
    setPop(null)
  }, [sessionId])

  // The mini play bar / a note pop can ask us to open a panel on arrival.
  const requestedPanel = usePlayerStore((s) => s.requestedPanel)
  const requestedClubId = usePlayerStore((s) => s.requestedClubId)
  const requestedNoteId = usePlayerStore((s) => s.requestedNoteId)
  const clearRequestedPanel = usePlayerStore((s) => s.clearRequestedPanel)
  useEffect(() => {
    if (!requestedPanel) return
    if (requestedPanel === 'bookmarks') setPop('bookmark')
    else if (requestedPanel === 'chapters') setPanel('chapters')
    else if (requestedPanel === 'queue') setPanel('queue')
    else if (requestedPanel === 'notes') {
      setFocusNoteId(requestedNoteId)
      setPanel(null)
      setPop('notes')
    } else if (requestedPanel === 'club') {
      setFocusNoteId(requestedNoteId)
      if (requestedClubId) setOpenClubId(requestedClubId)
      setPop(null)
      setPanel('club')
    }
    clearRequestedPanel()
  }, [requestedPanel, requestedClubId, requestedNoteId, clearRequestedPanel])

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 2200)
    return () => window.clearTimeout(id)
  }, [toast])

  // Derived chapter position
  const { ci, cur } = useMemo(() => {
    if (chapters.length === 0)
      return { ci: 0, cur: { id: 0, start: 0, end: duration, title: 'Full book' } as ABSChapter }
    let idx = chapters.findIndex((b) => pos < b.end)
    if (idx === -1) idx = chapters.length - 1
    return { ci: idx, cur: chapters[idx] }
  }, [chapters, pos, duration])

  // Keyboard shortcuts (player route only)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === ' ') {
        e.preventDefault()
        togglePlaying()
      } else if (e.key === 'ArrowLeft') {
        seek(Math.max(0, pos - skipBack))
      } else if (e.key === 'ArrowRight') {
        seek(Math.min(duration, pos + skipFwd))
      } else if (e.key === 'Escape') {
        setPanel(null)
        setPop(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [togglePlaying, seek, pos, duration, skipBack, skipFwd])

  if (!sessionId || !libraryItemId || !title) {
    return (
      <div className="page fade-in cozy-page">
        <div
          className="cozy-bg"
          aria-hidden="true"
          style={{ backgroundImage: `url("${cozyHearth}")` }}
        />
        <div className="cozy-veil" aria-hidden="true" />
        <div className="cozy-empty">
          <div className="eyebrow">By the hearth</div>
          <h1 className="cozy-h">Nothing playing</h1>
          <p className="cozy-sub">
            The fire's lit and the chair's yours. Pull something off the shelf and settle in.
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/library')}>
            <Icon name="auto_stories" fill /> Browse the library
          </button>
        </div>
      </div>
    )
  }

  // Mobile gets the dedicated full-screen Shelf-Queue player; desktop keeps the
  // two-pane immersive layout below.
  if (isMobile) {
    return (
      <>
        <MobilePlayer
          libraryItemId={libraryItemId}
          title={title}
          author={author ?? ''}
          duration={duration}
          pos={pos}
          isPlaying={isPlaying}
          chapters={chapters}
          speed={speed}
          setSpeed={setSpeed}
          genre={dm?.genres[0] ?? ''}
          detail={detail}
          toggle={togglePlaying}
          seek={seek}
          minimize={() => navigate(-1)}
          onToast={setToast}
        />
        {toast && (
          <div className="p-toast">
            <Icon name="check_circle" fill /> {toast}
          </div>
        )}
      </>
    )
  }

  const chSpan = cur.end - cur.start
  const chPos = Math.max(0, pos - cur.start)
  const chRatio = chSpan > 0 ? Math.min(1, chPos / chSpan) : 0
  const bookRatio = duration > 0 ? pos / duration : 0

  const clickRatio = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }
  const seekClamp = (sec: number) => seek(Math.max(0, Math.min(duration, sec)))

  // Seek-bar note markers: unlocked public notes (avatar dots) and any locked
  // club stubs (anonymous ticks) for the playing book. Clicking a passed marker
  // opens the notes pop scrolled to it; an ahead tick shows a teaser toast.
  const openNoteFromMarker = (noteId: string) => {
    setFocusNoteId(noteId)
    setPanel(null)
    setPop('notes')
  }
  const teaseAhead = (timeSec: number) =>
    setToast(`A note awaits at ${formatTimestamp(timeSec)}`)
  const markersEl =
    notesData && notesData.enabled ? (
      <TimelineMarkers
        notes={notesData.notes}
        stubs={notesData.locked}
        duration={duration}
        onOpenNote={openNoteFromMarker}
        onTease={teaseAhead}
      />
    ) : null
  const prevCh = () =>
    seekClamp(chPos > 4 ? cur.start : (chapters[Math.max(0, ci - 1)]?.start ?? 0))
  const nextCh = () =>
    seekClamp(chapters[Math.min(chapters.length - 1, ci + 1)]?.start ?? cur.start)

  const togglePanel = (p: Exclude<Panel, null>) => {
    setPop(null)
    setPanel((c) => (c === p ? null : p))
  }
  const togglePop = (p: Exclude<Pop, null>) => {
    setPanel(null)
    setPop((c) => (c === p ? null : p))
  }
  const open = panel !== null

  const addBookmark = () => {
    const label = formatTimestamp(pos)
    if (bookmarks.some((b) => Math.abs(b.time - pos) < 2)) {
      setToast('Already bookmarked here')
      return
    }
    addBookmarkApi(pos, cur.title)
    setToast(`Bookmark saved at ${label}`)
  }
  const retrySync = () => {
    const { sessionId: sid, currentTime, duration: dur } = usePlayerStore.getState()
    if (!sid) return
    setToast('Retrying sync…')
    syncSession(sid, { currentTime, timeListened: 0, duration: dur })
      .then(() => {
        usePlayerStore.getState().setSyncError(false)
        setToast('Synced')
      })
      .catch(() => setToast('Still offline — your position is saved locally'))
  }

  return (
    <div className={'player' + (open ? ' with-panel' : '') + (hearthBgPlayer ? ' hearth-bg' : '')}>
      {hearthBgPlayer && (
        <>
          <div
            className="player-hearth-bg"
            aria-hidden="true"
            style={{ backgroundImage: `url("${cozyHearth}")` }}
          />
          <div className="player-hearth-veil" aria-hidden="true" />
        </>
      )}
      <div className="player-col">
        <div className="p-head">
          <button
            className="p-minimize"
            onClick={() => navigate(-1)}
            aria-label="Minimize player"
            title="Minimize"
          >
            <Icon name="keyboard_arrow_down" />
          </button>
          <div className="p-head-title">
            <div className="eyebrow">HearthShelf</div>
            <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>
              Listening
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={'pill sync-pill ' + (syncError ? 'bad' : 'ok')}
              onClick={syncError ? retrySync : undefined}
              title={
                syncError
                  ? 'Sync issue - your latest position may not be saved. Tap to retry.'
                  : 'Your progress is synced across devices'
              }
            >
              <Icon name={syncError ? 'cloud_off' : 'cloud_done'} />{' '}
              {syncError ? 'Sync issue' : 'Synced'}
            </button>
            <button
              className={'pill' + (panel === 'queue' ? ' on' : '')}
              onClick={() => togglePanel('queue')}
            >
              <Icon name="reorder" /> Queue
            </button>
          </div>
        </div>

        <div className="p-cover-wrap">
          <Cover
            itemId={libraryItemId}
            title={title}
            author={author ?? undefined}
            fs={26}
            onClick={() => navigate(`/book/${libraryItemId}`)}
          />
          <div className="p-cover-prog">
            <i style={{ width: bookRatio * 100 + '%' }} />
          </div>
        </div>

        <div className="p-prog-row">
          <div className="p-pct">
            {Math.round(bookRatio * 100)}
            <small>%</small>
          </div>
          <div className="p-ch">
            Ch {ci + 1} / {chapters.length || 1}
          </div>
        </div>

        {/* secondary context line - the metric the main scrubber is NOT showing */}
        {scrubber === 'book' ? (
          <>
            <div
              className="prog-line seekable"
              onClick={(e) => seekClamp(cur.start + clickRatio(e) * chSpan)}
            >
              <i style={{ width: chRatio * 100 + '%' }} />
            </div>
            <div className="p-times">
              <span>{cur.title}</span>
              <span>-{formatTimestamp(chSpan - chPos)} in ch</span>
            </div>
          </>
        ) : (
          <>
            <div
              className="prog-line seekable has-markers"
              onClick={(e) => seekClamp(clickRatio(e) * duration)}
            >
              <i style={{ width: bookRatio * 100 + '%' }} />
              {markersEl}
            </div>
            <div className="p-times">
              <span>{formatTimestamp(pos)} elapsed</span>
              <span>{formatTimestamp(duration - pos)} left</span>
            </div>
          </>
        )}

        {/* primary scrubber */}
        <div style={{ width: '100%', marginTop: 28, textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            {scrubber === 'book' ? 'Full book' : cur.title}
          </div>
          {scrubber === 'book' ? (
            <div
              className="scrub seekable has-markers"
              onClick={(e) => seekClamp(clickRatio(e) * duration)}
            >
              <i style={{ width: bookRatio * 100 + '%' }} />
              <b style={{ left: bookRatio * 100 + '%' }} />
              {markersEl}
            </div>
          ) : (
            <div
              className="scrub seekable"
              onClick={(e) => seekClamp(cur.start + clickRatio(e) * chSpan)}
            >
              <i style={{ width: chRatio * 100 + '%' }} />
              <b style={{ left: chRatio * 100 + '%' }} />
            </div>
          )}
          <div className="p-times">
            {scrubber === 'book' ? (
              <>
                <span>{formatTimestamp(pos)} elapsed</span>
                <span>{formatTimestamp(duration - pos)} left</span>
              </>
            ) : (
              <>
                <span>{formatTimestamp(chPos)}</span>
                <span>-{formatTimestamp(chSpan - chPos)}</span>
              </>
            )}
          </div>
        </div>

        <div className="p-transport">
          <button className="p-skip lite" title="Previous chapter" onClick={prevCh}>
            <Icon name="skip_previous" fill />
          </button>
          <button
            className="p-skip"
            title={`Back ${skipBack} seconds`}
            onClick={() => seekClamp(pos - skipBack)}
          >
            <Icon name="replay" />
            <small>{skipBack}</small>
          </button>
          <button className="p-play" onClick={togglePlaying}>
            <Icon name={isPlaying ? 'pause' : 'play_arrow'} fill />
          </button>
          <button
            className="p-skip"
            title={`Forward ${skipFwd} seconds`}
            onClick={() => seekClamp(pos + skipFwd)}
          >
            <Icon name="replay" style={{ transform: 'scaleX(-1)' }} />
            <small>{skipFwd}</small>
          </button>
          <button className="p-skip lite" title="Next chapter" onClick={nextCh}>
            <Icon name="skip_next" fill />
          </button>
        </div>

        <div className="p-actions">
          {pop === 'speed' && (
            <div className="p-pop">
              <SpeedPopover speed={speed} setSpeed={setSpeed} onClose={() => setPop(null)} />
            </div>
          )}
          {pop === 'sleep' && (
            <div className="p-pop">
              <SleepPopover ctl={sleepCtl} onClose={() => setPop(null)} />
            </div>
          )}
          {pop === 'bookmark' && (
            <div className="p-pop">
              <div className="pop-head">
                <Icon name="bookmark" /> Bookmarks
                <span className="pop-x" onClick={() => setPop(null)}>
                  <Icon name="close" style={{ fontSize: 18 }} />
                </span>
              </div>
              <button
                className="btn-sm btn-green"
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  marginBottom: bookmarks.length ? 12 : 0,
                }}
                onClick={addBookmark}
              >
                <Icon name="bookmark_add" /> Bookmark {formatTimestamp(pos)}
              </button>
              {bookmarks.length === 0 ? (
                <div className="pop-empty">No bookmarks yet</div>
              ) : (
                <div className="pop-scroll">
                  {bookmarks.map((b) => {
                    const label = formatTimestamp(b.time)
                    const jump = () => {
                      seek(b.time)
                      setToast(`Jumped to ${label}`)
                    }
                    return (
                      <div className="bm-row" key={b.time}>
                        <span className="bm-t" onClick={jump}>
                          {label}
                        </span>
                        <span className="bm-n" onClick={jump}>
                          {b.title}
                        </span>
                        <span className="bm-x" onClick={() => removeBookmark(b.time)}>
                          <Icon name="delete" style={{ fontSize: 17 }} />
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {pop === 'recent' && (
            <div className="p-pop">
              <div className="pop-head">
                <Icon name="history" /> Recent listens
                <span className="pop-x" onClick={() => setPop(null)}>
                  <Icon name="close" style={{ fontSize: 18 }} />
                </span>
              </div>
              <div className="pop-scroll">
                <RecentListens
                  libraryItemId={libraryItemId}
                  onSeek={(sec) => {
                    seekClamp(sec)
                    setToast(`Jumped to ${formatTimestamp(sec)}`)
                    setPop(null)
                  }}
                />
              </div>
            </div>
          )}
          {pop === 'notes' && me && (
            <div className="p-pop">
              <NotesPop
                libraryItemId={libraryItemId}
                chapters={chapters}
                meId={me.id}
                position={pos}
                finished={finishedHere}
                scrollToNoteId={focusNoteId}
                onClose={() => {
                  setPop(null)
                  setFocusNoteId(null)
                }}
                onSeek={(sec) => seekClamp(sec)}
              />
            </div>
          )}

          <div className="action-grid">
            <button
              className={'pill' + (panel === 'chapters' ? ' on' : '')}
              onClick={() => togglePanel('chapters')}
            >
              <Icon name="list" /> Chapters
            </button>
            <button
              className={'pill' + (panel === 'details' ? ' on' : '')}
              onClick={() => togglePanel('details')}
            >
              <Icon name="info" /> Book details
            </button>
            {hasEbook && (
              <button
                className={'pill' + (panel === 'reader' ? ' on' : '')}
                onClick={() => togglePanel('reader')}
              >
                <Icon name="menu_book" /> Read along
              </button>
            )}
            <button
              className={'pill' + (pop === 'speed' ? ' on' : '')}
              onClick={() => togglePop('speed')}
            >
              <Icon name="speed" /> {speed}×
            </button>
            <button
              className={'pill' + (pop === 'sleep' || sleepCtl.active ? ' on' : '')}
              onClick={() => togglePop('sleep')}
            >
              <Icon name="bedtime" />{' '}
              {sleepCtl.sleeping
                ? `Sleep · ${formatTimestamp(sleepCtl.left)}`
                : sleepCtl.active
                  ? `Sleep · ${sleepCtl.endsAt}`
                  : 'Sleep timer'}
            </button>
            <button
              className={'pill' + (pop === 'bookmark' ? ' on' : '')}
              onClick={() => togglePop('bookmark')}
            >
              <Icon name="bookmark_add" /> Bookmark
              {bookmarks.length > 0 && <span className="badge-dot">{bookmarks.length}</span>}
            </button>
            <button
              className={'pill' + (pop === 'recent' ? ' on' : '')}
              onClick={() => togglePop('recent')}
            >
              <Icon name="history" /> Recent listens
            </button>
            <button
              className={'pill' + (pop === 'notes' ? ' on' : '')}
              onClick={() => {
                setFocusNoteId(null)
                togglePop('notes')
              }}
            >
              <Icon name="forum" /> Notes
              {notesData?.enabled && notesData.notes.length > 0 && (
                <span className="badge-dot">{notesData.notes.length}</span>
              )}
            </button>
            <AddToListMenu
              libraryItemId={libraryItemId}
              libraryId={detail?.libraryId ?? null}
              title={title}
              author={author ?? ''}
              onToast={setToast}
              trigger={(toggle, isOpen) => (
                <button
                  className={'pill' + (isOpen ? ' on' : '')}
                  onClick={() => {
                    setPanel(null)
                    setPop(null)
                    toggle()
                  }}
                >
                  <Icon name="playlist_add" /> Add to list
                </button>
              )}
            />
          </div>
        </div>
      </div>

      <div className={'p-panel' + (open ? ' open' : '')} aria-hidden={!open}>
        {panel === 'chapters' && (
          <ChaptersPanel
            chapters={chapters}
            curIdx={ci}
            onSeek={(start) => seek(start)}
            onClose={() => setPanel(null)}
          />
        )}
        {panel === 'reader' && (
          <div className="pp-inner pp-reader">
            <ReaderPage itemId={libraryItemId} inline onClose={() => setPanel(null)} />
          </div>
        )}
        {panel === 'details' && (
          <div className="pp-inner">
            <PanelHead icon="info" title="Book details" onClose={() => setPanel(null)} />
            <div className="pp-scroll" style={{ padding: '0 4px' }}>
              <div style={{ display: 'flex', gap: 18, marginBottom: 18 }}>
                <Cover
                  itemId={libraryItemId}
                  title={title}
                  fs={9}
                  style={{ width: 116, height: 116, borderRadius: 12, flex: 'none' }}
                />
                <div style={{ minWidth: 0 }}>
                  <h2
                    style={{
                      fontSize: 19,
                      fontWeight: 700,
                      margin: '0 0 6px',
                      lineHeight: 1.15,
                    }}
                  >
                    {title}
                  </h2>
                  <div className="by">
                    by <b>{author}</b>
                  </div>
                  {dm?.narrators[0] && (
                    <div className="by" style={{ marginTop: 2 }}>
                      Read by <b>{dm.narrators.join(', ')}</b>
                    </div>
                  )}
                  {dm?.rating != null && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginTop: 10,
                      }}
                    >
                      <Stars rating={dm.rating} />
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                        {dm.rating.toFixed(1)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="meta-chips" style={{ margin: '0 0 18px' }}>
                <span className="chip">
                  <Icon name="schedule" /> {formatTimestamp(duration)}
                </span>
                <span className="chip">
                  <Icon name="list" /> {chapters.length} chapters
                </span>
                {dm?.publishedYear && (
                  <span className="chip">
                    <Icon name="calendar_today" /> {dm.publishedYear}
                  </span>
                )}
                {dm?.genres[0] && (
                  <span className="chip">
                    <Icon name="category" /> {dm.genres[0]}
                  </span>
                )}
              </div>
              {dm?.series[0] && (
                <div
                  className="pp-series-row"
                  onClick={() => navigate(`/series/${dm.series[0].id}`)}
                >
                  <Icon name="auto_stories" />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="pp-series-name">{dm.series[0].name}</div>
                    {dm.series[0].sequence && (
                      <div className="pp-series-seq">Book {dm.series[0].sequence}</div>
                    )}
                  </div>
                  <Icon name="chevron_right" />
                </div>
              )}
              {dm?.description && (
                <p className="desc" style={{ margin: '0 0 18px', whiteSpace: 'pre-line' }}>
                  {stripHtml(dm.description)}
                </p>
              )}
              <button
                className="btn-sm btn-ghost"
                onClick={() => navigate(`/book/${libraryItemId}`)}
              >
                <Icon name="open_in_new" /> Open full details
              </button>
            </div>
          </div>
        )}
        {panel === 'queue' && (
          <QueuePanel
            nowId={libraryItemId}
            nowTitle={title}
            nowAuthor={author ?? ''}
            onClose={() => setPanel(null)}
            onPlay={(id) => void playItem(id)}
          />
        )}
        {panel === 'club' && openClubId && (
          <ClubPanel
            clubId={openClubId}
            playingItemId={libraryItemId}
            playingPosition={pos}
            playingChapters={chapters}
            scrollToNoteId={focusNoteId}
            onClose={() => {
              setPanel(null)
              setFocusNoteId(null)
            }}
            onSeek={(sec) => seekClamp(sec)}
          />
        )}
      </div>

      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </div>
  )
}
