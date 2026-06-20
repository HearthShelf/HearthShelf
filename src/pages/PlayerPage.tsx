import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '@/store/playerStore'
import { usePlayer } from '@/hooks/usePlayer'
import { useSettingsStore } from '@/store/settingsStore'
import { useSleepTimer } from '@/hooks/useSleepTimer'
import { SpeedPopover, SleepPopover } from '@/components/player/PlayerPopovers'
import { useBookmarks } from '@/hooks/useBookmarks'
import { useQueueStore } from '@/store/queueStore'
import { formatTimestamp } from '@/lib/format'
import { Cover } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import type { ABSChapter } from '@/api/types'

type Panel = 'chapters' | 'details' | 'queue' | null
type Pop = 'speed' | 'sleep' | 'bookmark' | 'list' | null

const LISTS = [
  { name: 'Bedtime', icon: 'bedtime' },
  { name: 'Long drives', icon: 'directions_car' },
  { name: 'Favourites', icon: 'favorite' },
  { name: 'Re-listen', icon: 'replay' },
]

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
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  return (
    <div className="pp-inner">
      <PanelHead
        icon="reorder"
        title="Up next"
        sub={`${items.length + 1} in queue · drag to reorder`}
        onClose={onClose}
      />
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
        {items.length === 0 ? (
          <div className="pop-empty" style={{ marginTop: 12 }}>
            Nothing queued. Add books with "Add to queue".
          </div>
        ) : (
          items.map((q, i) => (
            <div
              className={'queue-row' + (dragIdx === i ? ' dragging' : '')}
              key={q.libraryItemId}
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIdx !== null && dragIdx !== i) reorder(dragIdx, i)
                setDragIdx(null)
              }}
              onDragEnd={() => setDragIdx(null)}
            >
              <span className="q-handle" title="Drag to reorder">
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
              <span
                className="bm-x"
                title="Remove"
                onClick={() => remove(q.libraryItemId)}
              >
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
  const { togglePlaying, seek, playItem } = usePlayer()
  const setSpeed = usePlayerStore((s) => s.setSpeed)

  const skipFwd = useSettingsStore((s) => s.skipForward)
  const skipBack = useSettingsStore((s) => s.skipBack)
  const scrubber = useSettingsStore((s) => s.scrubber)

  // Full sleep-timer controller (three modes + stop behaviours from Settings).
  const sleepCtl = useSleepTimer()

  const [panel, setPanel] = useState<Panel>(null)
  const [pop, setPop] = useState<Pop>(null)
  const [lists, setLists] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<string | null>(null)

  const { bookmarks, addBookmark: addBookmarkApi, removeBookmark } =
    useBookmarks(libraryItemId)

  // Reset player-only UI when the book CHANGES (not on first mount, so a panel
  // requested by the mini play bar survives navigation to this page).
  const firstSession = useRef(true)
  useEffect(() => {
    if (firstSession.current) {
      firstSession.current = false
      return
    }
    setLists({})
    setPanel(null)
    setPop(null)
  }, [sessionId])

  // The mini play bar can ask us to open a panel on arrival.
  const requestedPanel = usePlayerStore((s) => s.requestedPanel)
  const clearRequestedPanel = usePlayerStore((s) => s.clearRequestedPanel)
  useEffect(() => {
    if (!requestedPanel) return
    if (requestedPanel === 'bookmarks') setPop('bookmark')
    else if (requestedPanel === 'chapters') setPanel('chapters')
    else if (requestedPanel === 'queue') setPanel('queue')
    clearRequestedPanel()
  }, [requestedPanel, clearRequestedPanel])

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
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement
      )
        return
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
      <div className="page">
        <p className="page-sub">Nothing playing.</p>
        <button className="btn btn-primary" onClick={() => navigate('/')}>
          <Icon name="library_books" /> Browse library
        </button>
      </div>
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
  const prevCh = () =>
    seekClamp(chPos > 4 ? cur.start : chapters[Math.max(0, ci - 1)]?.start ?? 0)
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
  const toggleList = (name: string) => {
    setLists((m) => {
      const next = { ...m, [name]: !m[name] }
      setToast(next[name] ? `Added to ${name}` : `Removed from ${name}`)
      return next
    })
  }
  const listCount = Object.values(lists).filter(Boolean).length

  return (
    <div className={'player' + (open ? ' with-panel' : '')}>
      <div className="player-col">
        <div className="p-head">
          <div>
            <div className="eyebrow">HearthShelf</div>
            <h1
              style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}
            >
              Listening
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="pill">
              <Icon name="cloud_done" /> Synced
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
              className="prog-line seekable"
              onClick={(e) => seekClamp(clickRatio(e) * duration)}
            >
              <i style={{ width: bookRatio * 100 + '%' }} />
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
              className="scrub seekable"
              onClick={(e) => seekClamp(clickRatio(e) * duration)}
            >
              <i style={{ width: bookRatio * 100 + '%' }} />
              <b style={{ left: bookRatio * 100 + '%' }} />
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
          {pop === 'list' && (
            <div className="p-pop">
              <div className="pop-head">
                <Icon name="playlist_add" /> Add to list
                <span className="pop-x" onClick={() => setPop(null)}>
                  <Icon name="close" style={{ fontSize: 18 }} />
                </span>
              </div>
              <div className="pop-scroll">
                {LISTS.map((l) => (
                  <div
                    className={'list-row' + (lists[l.name] ? ' on' : '')}
                    key={l.name}
                    onClick={() => toggleList(l.name)}
                  >
                    <span className="lr-ico">
                      <Icon name={l.icon} />
                    </span>
                    <span className="lr-t">{l.name}</span>
                    <span className="lr-check">
                      <Icon name="check" />
                    </span>
                  </div>
                ))}
              </div>
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
                        <span
                          className="bm-x"
                          onClick={() => removeBookmark(b.time)}
                        >
                          <Icon name="delete" style={{ fontSize: 17 }} />
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
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
              {bookmarks.length > 0 && (
                <span className="badge-dot">{bookmarks.length}</span>
              )}
            </button>
            <button
              className={'pill' + (pop === 'list' || listCount ? ' on' : '')}
              onClick={() => togglePop('list')}
            >
              <Icon name="playlist_add" /> Add to list
              {listCount > 0 && <span className="badge-dot">{listCount}</span>}
            </button>
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
                </div>
              </div>
              <div className="meta-chips" style={{ margin: '0 0 18px' }}>
                <span className="chip">
                  <Icon name="schedule" /> {formatTimestamp(duration)}
                </span>
                <span className="chip">
                  <Icon name="list" /> {chapters.length} chapters
                </span>
              </div>
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
      </div>

      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </div>
  )
}
