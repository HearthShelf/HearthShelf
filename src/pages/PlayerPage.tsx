import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '@/store/playerStore'
import { usePlayer } from '@/hooks/usePlayer'
import { useSettingsStore } from '@/store/settingsStore'
import { useSleepTimer, type SleepCtl } from '@/hooks/useSleepTimer'
import { formatTimestamp } from '@/lib/format'
import { Cover } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import type { ABSChapter } from '@/api/types'

type Panel = 'chapters' | 'details' | 'queue' | null
type Pop = 'speed' | 'sleep' | 'bookmark' | 'list' | null

interface Bookmark {
  sec: number
  label: string
  note: string
}

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const SLEEP_PRESETS = [5, 15, 30, 45, 60, 90]
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

function SpeedPopover({
  speed,
  setSpeed,
  onClose,
}: {
  speed: number
  setSpeed: (s: number) => void
  onClose: () => void
}) {
  return (
    <>
      <div className="pop-head">
        <Icon name="speed" /> Playback speed
        <span className="pop-x" onClick={onClose}>
          <Icon name="close" style={{ fontSize: 18 }} />
        </span>
      </div>
      <div className="speed-val">
        {speed.toFixed(2).replace(/\.?0+$/, '')}
        <small>×</small>
      </div>
      <input
        className="speed-slider"
        type="range"
        min={0.5}
        max={3}
        step={0.05}
        value={speed}
        onChange={(e) => setSpeed(Number(Number(e.target.value).toFixed(2)))}
      />
      <div className="speed-ticks">
        <span>0.5×</span>
        <span>1×</span>
        <span>2×</span>
        <span>3×</span>
      </div>
      <div className="sleep-grid">
        {SPEED_PRESETS.map((s) => (
          <button
            key={s}
            className={Math.abs(s - speed) < 0.001 ? 'on' : ''}
            onClick={() => setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </>
  )
}

function SleepPopover({ ctl, onClose }: { ctl: SleepCtl; onClose: () => void }) {
  const { curIdx, bounds } = ctl
  return (
    <>
      <div className="pop-head">
        <Icon name="bedtime" /> Sleep timer
        <span className="pop-x" onClick={onClose}>
          <Icon name="close" style={{ fontSize: 18 }} />
        </span>
      </div>

      <div className="seg seg-full" style={{ marginBottom: 14 }}>
        <button
          className={ctl.tab === 'duration' ? 'on' : ''}
          onClick={() => ctl.setTab('duration')}
        >
          Duration
        </button>
        <button
          className={ctl.tab === 'chapter' ? 'on' : ''}
          onClick={() => ctl.setTab('chapter')}
        >
          Chapter
        </button>
        <button
          className={ctl.tab === 'time' ? 'on' : ''}
          onClick={() => ctl.setTab('time')}
        >
          Time
        </button>
      </div>

      <div className="sleep-tab-body">
        {ctl.tab === 'duration' && (
          <div className="sleep-grid">
            {SLEEP_PRESETS.map((m) => (
              <button
                key={m}
                className={
                  ctl.sleeping && Math.abs(ctl.left - m * 60) < 30 ? 'on' : ''
                }
                onClick={() => ctl.setDuration(m)}
              >
                {m}m
              </button>
            ))}
          </div>
        )}
        {ctl.tab === 'chapter' && (
          <>
            <select
              className="fld"
              style={{ marginBottom: 10 }}
              value={ctl.eoc ? ctl.eoc.idx : curIdx}
              onChange={(e) =>
                ctl.setChapter(Number(e.target.value), ctl.eoc ? ctl.eoc.at : 'end')
              }
            >
              {bounds.map((c, i) =>
                i >= curIdx ? (
                  <option key={c.id} value={i}>
                    {c.title}
                  </option>
                ) : null
              )}
            </select>
            <div className="seg seg-full">
              <button
                className={ctl.eoc && ctl.eoc.at === 'start' ? 'on' : ''}
                onClick={() =>
                  ctl.setChapter(ctl.eoc ? ctl.eoc.idx : curIdx, 'start')
                }
              >
                Chapter start
              </button>
              <button
                className={ctl.eoc && ctl.eoc.at === 'end' ? 'on' : ''}
                onClick={() =>
                  ctl.setChapter(ctl.eoc ? ctl.eoc.idx : curIdx, 'end')
                }
              >
                Chapter end
              </button>
            </div>
          </>
        )}
        {ctl.tab === 'time' && (
          <>
            <input
              type="time"
              className="fld"
              onChange={(e) => ctl.setClock(e.target.value)}
            />
            <div className="pr-d" style={{ marginTop: 8 }}>
              Playback stops at the clock time you pick.
            </div>
          </>
        )}
      </div>

      <div className="pop-divider" />
      <div className="pop-label">When it stops</div>

      <div
        className="pop-row"
        onClick={() => ctl.setRewind(!ctl.rewind)}
        style={{ cursor: 'pointer' }}
      >
        <div className="pr-t">
          Rewind 30s when it stops
          <div className="pr-d">Pick up with a little context</div>
        </div>
        <div className={'toggle' + (ctl.rewind ? ' on' : '')}>
          <i />
        </div>
      </div>
      {ctl.rewind && (
        <div
          className="pop-row"
          onClick={() => ctl.setBarrier(!ctl.chapterBarrier)}
          style={{ cursor: 'pointer', marginTop: 8, paddingLeft: 14 }}
        >
          <div className="pr-t">
            Keep within chapter
            <div className="pr-d">Don't rewind past the chapter start</div>
          </div>
          <div className={'toggle' + (ctl.chapterBarrier ? ' on' : '')}>
            <i />
          </div>
        </div>
      )}

      <div
        className="pop-row"
        onClick={() => ctl.setFade(!ctl.fade)}
        style={{ cursor: 'pointer', marginTop: 12 }}
      >
        <div className="pr-t">
          Fade volume out
          <div className="pr-d">
            {ctl.fade ? `Eases down over ${ctl.fadeLen}s` : 'Stops abruptly'}
          </div>
        </div>
        <div className={'toggle' + (ctl.fade ? ' on' : '')}>
          <i />
        </div>
      </div>
      {ctl.fade && (
        <div className="pop-row" style={{ marginTop: 8 }}>
          <Icon
            name="volume_down"
            style={{ fontSize: 18, color: 'var(--text-muted)' }}
          />
          <input
            type="range"
            min={3}
            max={60}
            value={ctl.fadeLen}
            onChange={(e) => ctl.setFadeLen(Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--accent)' }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              color: 'var(--text-muted)',
              width: 30,
              textAlign: 'right',
            }}
          >
            {ctl.fadeLen}s
          </span>
        </div>
      )}

      <div
        className="pop-row"
        onClick={() => ctl.setChime(!ctl.chime)}
        style={{ cursor: 'pointer', marginTop: 12 }}
      >
        <div className="pr-t">
          Warning chime
          <div className="pr-d">A soft chime a minute before sleep</div>
        </div>
        <div className={'toggle' + (ctl.chime ? ' on' : '')}>
          <i />
        </div>
      </div>

      {ctl.active && (
        <>
          <div className="sleep-ends">
            <Icon
              name="schedule"
              style={{ fontSize: 17, color: 'var(--text-muted)' }}
            />{' '}
            Stops at <b>{ctl.endsAt}</b>
            {ctl.sleeping && (
              <span style={{ color: 'var(--text-muted)' }}>
                {' '}
                · in {formatTimestamp(ctl.left)}
              </span>
            )}
          </div>
          <div className="add-cancel">
            {ctl.sleeping && (
              <button className="btn-sm btn-ghost" onClick={() => ctl.addTime(5)}>
                <Icon name="add" /> 5 min
              </button>
            )}
            <button className="btn-sm btn-ghost" onClick={ctl.cancel}>
              <Icon name="close" /> Cancel
            </button>
          </div>
        </>
      )}
    </>
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
  const { togglePlaying, seek } = usePlayer()
  const setSpeed = usePlayerStore((s) => s.setSpeed)

  const skipFwd = useSettingsStore((s) => s.skipForward)
  const skipBack = useSettingsStore((s) => s.skipBack)
  const scrubber = useSettingsStore((s) => s.scrubber)

  // Full sleep-timer controller (three modes + stop behaviours from Settings).
  const sleepCtl = useSleepTimer()

  const [panel, setPanel] = useState<Panel>(null)
  const [pop, setPop] = useState<Pop>(null)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [lists, setLists] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<string | null>(null)

  // Reset player-only UI when the book changes (not the sleep timer).
  useEffect(() => {
    setBookmarks([])
    setLists({})
    setPanel(null)
    setPop(null)
  }, [sessionId])

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
    if (bookmarks.some((b) => Math.abs(b.sec - pos) < 2)) {
      setToast('Already bookmarked here')
      return
    }
    setBookmarks((b) => [{ sec: pos, label, note: cur.title }, ...b])
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
                  {bookmarks.map((b) => (
                    <div className="bm-row" key={b.sec}>
                      <span
                        className="bm-t"
                        onClick={() => {
                          seek(b.sec)
                          setToast(`Jumped to ${b.label}`)
                        }}
                      >
                        {b.label}
                      </span>
                      <span
                        className="bm-n"
                        onClick={() => {
                          seek(b.sec)
                          setToast(`Jumped to ${b.label}`)
                        }}
                      >
                        {b.note}
                      </span>
                      <span
                        className="bm-x"
                        onClick={() =>
                          setBookmarks((bm) => bm.filter((x) => x.sec !== b.sec))
                        }
                      >
                        <Icon name="delete" style={{ fontSize: 17 }} />
                      </span>
                    </div>
                  ))}
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
          <div className="pp-inner">
            <PanelHead
              icon="reorder"
              title="Up next"
              sub="1 in queue"
              onClose={() => setPanel(null)}
            />
            <div className="pp-scroll">
              <div className="queue-row now">
                <span
                  className="q-handle"
                  style={{ opacity: 0.35, cursor: 'default' }}
                >
                  <Icon name="graphic_eq" fill />
                </span>
                <Cover itemId={libraryItemId} title={title} fs={3} />
                <div className="q-meta">
                  <div className="q-t">{title}</div>
                  <div className="q-s">Now playing · {author}</div>
                </div>
              </div>
              <div className="pop-empty" style={{ marginTop: 12 }}>
                Up-next queue is coming soon.
              </div>
            </div>
          </div>
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
