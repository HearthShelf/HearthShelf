import { useState, useRef, useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayer } from '@/hooks/usePlayer'
import { useSettingsStore } from '@/store/settingsStore'
import { useQueueStore, type QueueMode, type AutoRuleId } from '@/store/queueStore'
import { useBookmarks } from '@/hooks/useBookmarks'
import { useSleepTimer } from '@/hooks/useSleepTimer'
import { SpeedPopover, SleepPopover } from '@/components/player/PlayerPopovers'
import { RecentListens } from '@/components/player/RecentListens'
import { Cover } from '@/components/common/Cover'
import { Icon } from '@/components/common/Icon'
import { formatTimestamp } from '@/lib/format'
import type { ABSChapter, ABSLibraryItemDetail } from '@/api/types'

// The merged Shelf-Queue mobile now-playing screen: a full-screen takeover
// rendered by PlayerPage on mobile. Desktop keeps the two-pane player.
// Auto-advance is owned by useQueueAdvance (wired into AudioEngine); this screen
// only reflects queue state - it never advances playback itself.

type ActionKey = 'chapters' | 'speed' | 'sleep' | 'readalong' | 'recent' | 'details' | 'addlist'
const MP_ACTIONS: ActionKey[] = [
  'chapters',
  'speed',
  'sleep',
  'readalong',
  'recent',
  'details',
  'addlist',
]

type SheetKind =
  'queue' | 'more' | 'chapters' | 'recent' | 'list' | 'rules' | 'speed' | 'sleep' | null

const MODES: { v: QueueMode; l: string }[] = [
  { v: 'off', l: 'Off' },
  { v: 'manual', l: 'Manual' },
  { v: 'auto', l: 'Auto' },
  { v: 'playlist', l: 'Playlist' },
]
const MODE_SUB: Record<QueueMode, string> = {
  off: 'Playback stops when this book ends.',
  manual: 'Your hand-picked order - drag to arrange.',
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
    desc: "Pull in other titles you've already started but set down.",
  },
  'new-in-series': {
    label: 'New books in series you started',
    desc: 'Queue the next book from each series you have going.',
  },
  'new-in-series-all': {
    label: 'Include every book in the series',
    desc: 'Instead of just the next one, queue all the books left in each series you started.',
  },
  'book-club': {
    label: 'Book club picks',
    desc: 'Add what your book clubs are reading, current book first.',
  },
  manual: {
    label: 'Books you queued by hand',
    desc: 'Play the books you added to your queue, after your Auto picks.',
  },
}

const LISTS = [
  { name: 'Want to listen', icon: 'bookmark_add' },
  { name: 'Favorites', icon: 'favorite' },
  { name: 'For the road', icon: 'directions_car' },
  { name: 'Cozy nights', icon: 'local_fire_department' },
  { name: 'Re-listen', icon: 'replay' },
]

function eyebrow(txt: string) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '0.3em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
      }}
    >
      {txt}
    </div>
  )
}

// Bottom sheet shell. Module-level so it keeps its own state across the parent's
// re-renders (a sheet declared inline would remount on every tick).
function Sheet({
  title,
  kicker,
  right,
  children,
  maxH = '82%',
  onClose,
}: {
  title: string
  kicker: string
  right?: ReactNode
  children: ReactNode
  maxH?: string
  onClose: () => void
}) {
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.5)' }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 31,
          maxHeight: maxH,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--sheet)',
          borderRadius: 'var(--r-sheet) var(--r-sheet) 0 0',
          borderTop: '1px solid var(--hairline)',
          boxShadow: '0 -20px 50px -20px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10 }}>
          <div style={{ width: 38, height: 4, borderRadius: 99, background: 'var(--hairline)' }} />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            padding: '10px 14px 12px 20px',
          }}
        >
          <div>
            {eyebrow(kicker)}
            <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', marginTop: 3 }}>
              {title}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {right}
            <button className="mp-ib" style={{ width: 40, height: 40 }} onClick={onClose}>
              <Icon name="close" style={{ fontSize: 22 }} />
            </button>
          </div>
        </div>
        {children}
      </div>
    </>
  )
}

function PopSheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.5)' }}
      />
      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 'calc(16px + env(safe-area-inset-bottom))',
          zIndex: 31,
        }}
      >
        {children}
      </div>
    </>
  )
}

interface MobilePlayerProps {
  libraryItemId: string
  title: string
  author: string
  duration: number
  pos: number
  isPlaying: boolean
  chapters: ABSChapter[]
  speed: number
  setSpeed: (s: number) => void
  genre: string
  detail: ABSLibraryItemDetail | undefined
  toggle: () => void
  seek: (sec: number) => void
  minimize: () => void
  onToast: (msg: string) => void
}

export function MobilePlayer({
  libraryItemId,
  title,
  author,
  duration,
  pos,
  isPlaying,
  chapters,
  speed,
  setSpeed,
  genre,
  detail,
  toggle,
  seek,
  minimize,
  onToast,
}: MobilePlayerProps) {
  const navigate = useNavigate()
  const { playItem } = usePlayer()
  const skipFwd = useSettingsStore((s) => s.skipForward)
  const skipBack = useSettingsStore((s) => s.skipBack)
  const queueMode = useSettingsStore((s) => s.queueMode)
  const autoRules = useSettingsStore((s) => s.queueAutoRules)
  const setSetting = useSettingsStore((s) => s.set)

  const queueItems = useQueueStore((s) => s.items)
  const manualItems = useQueueStore((s) => s.manual)
  const reorder = useQueueStore((s) => s.reorder)
  const setManual = useQueueStore((s) => s.setManual)
  const removeFromQueue = useQueueStore((s) => s.remove)
  const setQueueStoreMode = useQueueStore((s) => s.setMode)

  // Which merged-list rows are hand-added (inline drag + X in Auto mode); the
  // rest are rule-generated (bolt marker, read-only).
  const manualIds = new Set(manualItems.map((m) => m.libraryItemId))

  const sleep = useSleepTimer()
  const { bookmarks, addBookmark: addBookmarkApi } = useBookmarks(libraryItemId)

  const [sheet, setSheet] = useState<SheetKind>(null)
  const [car, setCar] = useState(false)
  const [order, setOrder] = useState<ActionKey[]>(MP_ACTIONS)
  const [edit, setEdit] = useState(false)
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [aDrag, setADrag] = useState<number | null>(null)
  const [aOver, setAOver] = useState<number | null>(null)
  const [lists, setLists] = useState<Record<string, boolean>>({})
  const py = useRef<number | null>(null)
  const cy = useRef<number | null>(null)

  // Close transient UI when the book changes. React's "adjust state during
  // render" idiom: track the last id in state so a new book closes any open
  // sheet / car-mode without an effect (and without a flash of the old sheet).
  const [lastId, setLastId] = useState(libraryItemId)
  if (lastId !== libraryItemId) {
    setLastId(libraryItemId)
    if (sheet !== null) setSheet(null)
    if (car) setCar(false)
  }

  // Chapter / position
  const { ci, cur } = useMemo(() => {
    if (chapters.length === 0)
      return { ci: 0, cur: { id: 0, start: 0, end: duration, title: 'Full book' } as ABSChapter }
    let idx = chapters.findIndex((b) => pos < b.end)
    if (idx === -1) idx = chapters.length - 1
    return { ci: idx, cur: chapters[idx] }
  }, [chapters, pos, duration])
  const chPos = Math.max(0, pos - cur.start)
  const bookRatio = duration ? pos / duration : 0
  const seekClamp = (s: number) => seek(Math.max(0, Math.min(duration, Math.round(s))))
  const clickRatio = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }
  const prevCh = () =>
    seekClamp(chPos > 4 ? cur.start : (chapters[Math.max(0, ci - 1)]?.start ?? 0))
  const nextCh = () =>
    seekClamp(chapters[Math.min(chapters.length - 1, ci + 1)]?.start ?? cur.start)
  const rewind = () => seekClamp(pos - skipBack)
  const forward = () => seekClamp(pos + skipFwd)

  // Queue + end-of-book handoff visual
  const hasNext = queueMode !== 'off' && queueItems.length > 0
  const next = queueItems[0]
  const WINDOW = 20 * 60
  const remaining = duration - pos
  let h = 0
  if (hasNext && remaining < WINDOW) h = Math.max(0, Math.min(1, (WINDOW - remaining) / WINDOW))
  const lean = h * 14
  const fall = h > 0.8 ? ((h - 0.8) / 0.2) * 62 : 0
  const curT =
    'translate(' +
    (-(h * 18)).toFixed(1) +
    '%, ' +
    (h > 0.8 ? ((h - 0.8) / 0.2) * 46 : 0).toFixed(1) +
    'px) rotate(' +
    (-(lean + fall)).toFixed(1) +
    'deg)'
  const curOp = h > 0.9 ? Math.max(0, 1 - (h - 0.9) / 0.1) : 1
  const nextT = 'translateX(' + ((1 - h) * 112).toFixed(1) + '%)'
  const nextOp = h > 0.01 ? 1 : 0

  const jumpTo = (id: string) => {
    setSheet(null)
    void playItem(id)
  }
  const addBookmark = () => {
    const lbl = formatTimestamp(pos)
    if (bookmarks.some((b) => Math.abs(b.time - pos) < 2)) {
      onToast('Already bookmarked here')
      return
    }
    addBookmarkApi(pos, cur.title)
    onToast('Bookmark saved at ' + lbl)
  }
  const speedLabel = speed.toFixed(2).replace(/\.?0+$/, '') + '×'

  const setMode = (v: QueueMode) => {
    setSetting('queueMode', v)
    setQueueStoreMode(v)
  }
  const toggleRule = (id: AutoRuleId) =>
    setSetting(
      'queueAutoRules',
      autoRules.map((r) => (r.id === id ? { ...r, on: !r.on } : r)),
    )

  const hasEbook = !!detail?.media.ebookFile
  const ACT: Record<ActionKey, { icon: string; label: string; on: () => void }> = {
    chapters: { icon: 'list', label: 'Chapters', on: () => setSheet('chapters') },
    speed: { icon: 'speed', label: speedLabel, on: () => setSheet('speed') },
    sleep: {
      icon: 'bedtime',
      label: sleep.active ? 'Sleep on' : 'Sleep',
      on: () => setSheet('sleep'),
    },
    readalong: {
      icon: 'menu_book',
      label: 'Read along',
      on: () => navigate(`/reader/${libraryItemId}`),
    },
    recent: { icon: 'history', label: 'Recent', on: () => setSheet('recent') },
    details: { icon: 'info', label: 'Details', on: () => navigate(`/book/${libraryItemId}`) },
    addlist: { icon: 'playlist_add', label: 'Add to list', on: () => setSheet('list') },
  }
  const okA = (k: ActionKey) => k !== 'readalong' || hasEbook
  const vis = order.filter(okA)
  const toolbar = vis.slice(0, 4).map((k) => ({ key: k, ...ACT[k] }))

  const commitQ = () => {
    if (drag != null && over != null && drag !== over) {
      if (queueMode === 'auto') {
        // Merged Auto list: reorder only the hand-added rows among themselves.
        // Apply the move to the merged order, then persist the manual subsequence.
        const merged = queueItems.slice()
        const [moved] = merged.splice(drag, 1)
        merged.splice(over, 0, moved)
        setManual(merged.filter((e) => manualIds.has(e.libraryItemId)))
      } else {
        reorder(drag, over)
      }
    }
    setDrag(null)
    setOver(null)
  }
  const commitA = () => {
    if (aDrag == null || aOver == null || aDrag === aOver) {
      setADrag(null)
      setAOver(null)
      return
    }
    const v = vis.slice()
    const [m] = v.splice(aDrag, 1)
    v.splice(aOver, 0, m)
    const hidden = order.filter((k) => !okA(k))
    setOrder([...v, ...hidden])
    setADrag(null)
    setAOver(null)
  }

  const closeSheet = () => setSheet(null)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'var(--scaffold)',
        color: 'var(--text)',
        fontFamily: 'var(--font)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 430,
          zIndex: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(125% 70% at 50% -10%, color-mix(in oklab, var(--glow-accent, var(--accent)) calc(var(--glow-strength, 60) * 1%), transparent) 0%, transparent 60%)',
        }}
      />

      {/* header */}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'calc(10px + env(safe-area-inset-top)) 12px 6px',
        }}
      >
        <button
          className="mp-ib"
          style={{ width: 40, height: 40 }}
          onClick={minimize}
          title="Minimize"
        >
          <Icon name="expand_more" style={{ fontSize: 26 }} />
        </button>
        <div style={{ textAlign: 'center', lineHeight: 1.25 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 300,
              letterSpacing: '0.32em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
            }}
          >
            Now playing
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'color-mix(in oklab, var(--text) 80%, transparent)',
              marginTop: 2,
            }}
          >
            HearthShelf{genre ? ' · ' + genre : ''}
          </div>
        </div>
        <button
          className="mp-ib"
          style={{ width: 40, height: 40 }}
          onClick={() => setSheet('queue')}
          title="Queue"
        >
          <Icon name="queue_music" style={{ fontSize: 23 }} />
        </button>
      </div>

      {/* body */}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 24px',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: 'min(216px, 60vw)',
            aspectRatio: '1 / 1',
            flex: 'none',
          }}
        >
          {next && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: 18,
                overflow: 'hidden',
                zIndex: 1,
                transform: nextT,
                opacity: nextOp,
                transition: 'transform .35s ease, opacity .35s ease',
                boxShadow: '0 26px 60px -20px rgba(0,0,0,0.6)',
              }}
            >
              <Cover
                itemId={next.libraryItemId}
                title={next.title}
                fs={13}
                style={{ width: '100%', height: '100%', borderRadius: 0 }}
              />
            </div>
          )}
          <div
            onPointerDown={(e) => {
              py.current = e.clientY
            }}
            onPointerUp={(e) => {
              if (py.current != null && e.clientY - py.current < -40) setCar(true)
              py.current = null
            }}
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 18,
              overflow: 'hidden',
              zIndex: 2,
              transformOrigin: 'bottom left',
              transform: curT,
              opacity: curOp,
              transition: 'transform .35s ease, opacity .35s ease',
              touchAction: 'none',
              boxShadow:
                '0 26px 60px -20px color-mix(in oklab, var(--glow-accent, var(--accent)) 72%, #000)',
            }}
          >
            <Cover
              itemId={libraryItemId}
              title={title}
              fs={13}
              style={{ width: '100%', height: '100%', borderRadius: 0 }}
            />
            <div
              style={{
                position: 'absolute',
                left: 9,
                bottom: 9,
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '5px 10px 5px 8px',
                borderRadius: 999,
                background: 'rgba(12,10,8,0.6)',
                backdropFilter: 'blur(6px)',
                color: '#fff',
              }}
            >
              <span className={'mp-eq' + (isPlaying ? ' on' : '')}>
                <i />
                <i />
                <i />
              </span>
              <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.02em' }}>
                {isPlaying ? 'Playing' : 'Paused'}
              </span>
            </div>
            <button
              title="Bookmark this moment"
              onClick={addBookmark}
              style={{
                position: 'absolute',
                top: 9,
                right: 9,
                width: 36,
                height: 36,
                borderRadius: 999,
                border: 'none',
                cursor: 'pointer',
                background: 'rgba(12,10,8,0.5)',
                backdropFilter: 'blur(6px)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="bookmark_add" style={{ fontSize: 19 }} />
            </button>
          </div>
        </div>

        <button
          onClick={() => setCar(true)}
          style={{
            marginTop: 10,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          <Icon name="keyboard_arrow_up" style={{ fontSize: 16 }} /> Car mode
        </button>

        <div style={{ textAlign: 'center', marginTop: 8, maxWidth: 300 }}>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              lineHeight: 1.12,
              margin: '6px 0 0',
              textWrap: 'balance',
            }}
          >
            {title}
          </h1>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 5 }}>{author}</div>
        </div>

        <div style={{ width: '100%', marginTop: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              color: 'var(--text-muted)',
              marginBottom: 7,
            }}
          >
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>
              {Math.round(bookRatio * 100)}%
            </span>
            <span>
              Ch {ci + 1} / {chapters.length || 1}
            </span>
          </div>
          <div className="scrub seekable" onClick={(e) => seekClamp(clickRatio(e) * duration)}>
            <i style={{ width: bookRatio * 100 + '%' }} />
            <b style={{ left: bookRatio * 100 + '%' }} />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-muted)',
              marginTop: 8,
            }}
          >
            <span>{formatTimestamp(pos)}</span>
            <span>-{formatTimestamp(duration - pos)}</span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            marginTop: 14,
          }}
        >
          <button
            className="mp-ib"
            style={{ width: 44, height: 44 }}
            onClick={prevCh}
            title="Previous chapter"
          >
            <Icon name="skip_previous" fill style={{ fontSize: 27 }} />
          </button>
          <button
            className="mp-ib"
            style={{ width: 48, height: 48 }}
            onClick={rewind}
            title={'Back ' + skipBack + 's'}
          >
            <Icon name="replay" style={{ fontSize: 28 }} />
          </button>
          <button
            onClick={toggle}
            style={{
              width: 70,
              height: 70,
              borderRadius: 999,
              border: 'none',
              cursor: 'pointer',
              background: 'var(--text)',
              color: 'var(--scaffold)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 14px 30px -10px rgba(0,0,0,0.6)',
            }}
          >
            <Icon
              name={isPlaying ? 'pause' : 'play_arrow'}
              fill
              style={{ fontSize: 36, marginLeft: isPlaying ? 0 : 3 }}
            />
          </button>
          <button
            className="mp-ib"
            style={{ width: 48, height: 48 }}
            onClick={forward}
            title={'Forward ' + skipFwd + 's'}
          >
            <Icon name="replay" style={{ fontSize: 28, transform: 'scaleX(-1)' }} />
          </button>
          <button
            className="mp-ib"
            style={{ width: 44, height: 44 }}
            onClick={nextCh}
            title="Next chapter"
          >
            <Icon name="skip_next" fill style={{ fontSize: 27 }} />
          </button>
        </div>

        <div
          style={{ display: 'flex', alignItems: 'stretch', gap: 5, width: '100%', marginTop: 14 }}
        >
          {toolbar.map((a) => (
            <button key={a.key} className="mp-tool" onClick={a.on}>
              <Icon name={a.icon} />
              <span>{a.label}</span>
            </button>
          ))}
          <button className="mp-tool" onClick={() => setSheet('more')}>
            <Icon name="more_horiz" />
            <span>More</span>
          </button>
        </div>
      </div>

      {/* up-next peek */}
      <button
        onClick={() => setSheet('queue')}
        style={{
          position: 'relative',
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          boxSizing: 'border-box',
          padding: '11px 18px calc(14px + env(safe-area-inset-bottom))',
          border: 'none',
          borderTop: '1px solid var(--hairline)',
          background: 'color-mix(in oklab, var(--c-high) 72%, transparent)',
          backdropFilter: 'blur(8px)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 9,
            overflow: 'hidden',
            flex: 'none',
            boxShadow: '0 6px 10px -5px rgba(0,0,0,0.5)',
          }}
        >
          {next ? (
            <Cover
              itemId={next.libraryItemId}
              title={next.title}
              fs={3.4}
              style={{ width: '100%', height: '100%', borderRadius: 0 }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', background: 'var(--fill)' }} />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 9.5,
              fontWeight: 300,
              letterSpacing: '0.26em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
            }}
          >
            {hasNext ? 'Up next' : 'Queue off'}
          </div>
          <div
            className="mp-clamp1"
            style={{ fontSize: 13.5, fontWeight: 600, marginTop: 2, color: 'var(--text)' }}
          >
            {hasNext ? next.title : 'Stops after this book'}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: 'var(--text-muted)',
            flex: 'none',
          }}
        >
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {hasNext ? queueItems.length + ' queued' : 'Off'}
          </span>
          <Icon name="expand_less" style={{ fontSize: 20 }} />
        </div>
      </button>

      {/* QUEUE SHEET */}
      {sheet === 'queue' && (
        <Sheet kicker="Up next" title="On the hearth" onClose={closeSheet}>
          <div
            style={{
              margin: '0 20px 8px',
              display: 'flex',
              gap: 4,
              background: 'var(--fill)',
              border: '1px solid var(--hairline)',
              borderRadius: 999,
              padding: 4,
            }}
          >
            {MODES.map((m) => (
              <button
                key={m.v}
                className={'mp-seg' + (queueMode === m.v ? ' on' : '')}
                onClick={() => setMode(m.v)}
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
              padding: '0 20px 14px',
            }}
          >
            <span style={{ fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-muted)' }}>
              {MODE_SUB[queueMode]}
            </span>
            {queueMode === 'auto' && (
              <button
                className="mp-pill"
                style={{ flex: 'none' }}
                onClick={() => setSheet('rules')}
              >
                <Icon name="tune" style={{ fontSize: 15 }} /> Auto rules
              </button>
            )}
          </div>
          <div
            style={{
              overflowY: 'auto',
              padding: '2px 14px calc(22px + env(safe-area-inset-bottom))',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div className="mp-row" style={{ background: 'var(--row-now, var(--fill))' }}>
              <Icon
                name="graphic_eq"
                fill
                style={{ width: 22, textAlign: 'center', color: 'var(--accent)', fontSize: 18 }}
              />
              <div
                style={{ width: 46, height: 46, borderRadius: 9, overflow: 'hidden', flex: 'none' }}
              >
                <Cover
                  itemId={libraryItemId}
                  title={title}
                  fs={4}
                  style={{ width: '100%', height: '100%', borderRadius: 0 }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mp-clamp1" style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {title}
                </div>
                <div
                  className="mp-clamp1"
                  style={{ fontSize: 11.5, color: 'var(--accent)', fontWeight: 600, marginTop: 1 }}
                >
                  Now playing
                </div>
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
                  padding: '34px 20px 30px',
                  color: 'var(--text-muted)',
                }}
              >
                <Icon name="do_not_disturb_on" style={{ fontSize: 40, opacity: 0.5 }} />
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                  Nothing queued
                </div>
                <div style={{ fontSize: 12, maxWidth: 240, lineHeight: 1.45 }}>
                  Playback stops when this book ends. Switch to Manual or Auto to keep going.
                </div>
              </div>
            ) : queueItems.length === 0 ? (
              <div
                style={{
                  padding: '30px 20px',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: 13,
                }}
              >
                {queueMode === 'auto'
                  ? 'Nothing queued yet. Books you add by hand show up here too.'
                  : 'Nothing queued yet.'}
              </div>
            ) : (
              // ONE merged list. In Auto mode only hand-added rows are
              // draggable/removable; rule-generated rows show a bolt and are
              // read-only. In Manual mode every row is the editable hand list.
              queueItems.map((b, i) => {
                const isManual = manualIds.has(b.libraryItemId)
                const editable = queueMode === 'manual' || (queueMode === 'auto' && isManual)
                const showBolt = queueMode === 'auto' && !isManual
                return (
                  <div
                    key={b.libraryItemId}
                    className={
                      'mp-row' +
                      (editable && drag === i ? ' drag' : '') +
                      (editable && over === i && drag !== null && drag !== i ? ' over' : '')
                    }
                    draggable={editable}
                    onDragStart={editable ? () => setDrag(i) : undefined}
                    onDragOver={
                      editable
                        ? (e) => {
                            e.preventDefault()
                            if (over !== i) setOver(i)
                          }
                        : undefined
                    }
                    onDrop={editable ? commitQ : undefined}
                    onDragEnd={editable ? commitQ : undefined}
                  >
                    {editable ? (
                      <Icon
                        name="drag_indicator"
                        style={{
                          width: 22,
                          textAlign: 'center',
                          color: 'var(--text-muted)',
                          fontSize: 20,
                          cursor: 'grab',
                        }}
                      />
                    ) : (
                      <span style={{ width: 22, flex: 'none' }} />
                    )}
                    <div
                      style={{
                        width: 46,
                        height: 46,
                        borderRadius: 9,
                        overflow: 'hidden',
                        flex: 'none',
                        cursor: 'pointer',
                      }}
                      onClick={() => jumpTo(b.libraryItemId)}
                    >
                      <Cover
                        itemId={b.libraryItemId}
                        title={b.title}
                        fs={4}
                        style={{ width: '100%', height: '100%', borderRadius: 0 }}
                      />
                    </div>
                    <div
                      style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                      onClick={() => jumpTo(b.libraryItemId)}
                    >
                      <div className="mp-clamp1" style={{ fontSize: 13.5, fontWeight: 600 }}>
                        {b.title}
                      </div>
                      <div
                        className="mp-clamp1"
                        style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1 }}
                      >
                        {b.author}
                      </div>
                    </div>
                    {editable && queueMode !== 'manual' ? (
                      <button
                        className="mp-ib"
                        style={{ width: 40, height: 40 }}
                        onClick={() => removeFromQueue(b.libraryItemId)}
                        title="Remove"
                      >
                        <Icon name="close" style={{ fontSize: 20 }} />
                      </button>
                    ) : showBolt ? (
                      <span
                        style={{
                          width: 40,
                          height: 40,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flex: 'none',
                        }}
                        title="Added automatically by your Auto rules"
                      >
                        <Icon name="bolt" style={{ fontSize: 18, color: 'var(--accent)' }} />
                      </span>
                    ) : (
                      <button
                        className="mp-ib"
                        style={{ width: 40, height: 40 }}
                        onClick={() => jumpTo(b.libraryItemId)}
                        title="Play now"
                      >
                        <Icon name="play_arrow" style={{ fontSize: 22 }} />
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </Sheet>
      )}

      {/* AUTO RULES */}
      {sheet === 'rules' && (
        <Sheet kicker="Auto-queue" title="What gets added" onClose={closeSheet}>
          <div
            style={{
              overflowY: 'auto',
              padding: '2px 18px calc(18px + env(safe-area-inset-bottom))',
            }}
          >
            {autoRules.map((r) => {
              const copy = RULE_COPY[r.id]
              // new-in-series-all is a sub-modifier of new-in-series: indent it
              // and dim/disable it while the parent is off (does nothing alone).
              const isSub = r.id === 'new-in-series-all'
              const parentOff = isSub && !autoRules.find((x) => x.id === 'new-in-series')?.on
              return (
                <div
                  key={r.id}
                  onClick={() => {
                    if (!parentOff) toggleRule(r.id)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '14px 4px',
                    paddingLeft: isSub ? 22 : 4,
                    borderBottom: '1px solid var(--hairline)',
                    cursor: parentOff ? 'default' : 'pointer',
                    opacity: parentOff ? 0.45 : 1,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>{copy.label}</div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-muted)',
                        marginTop: 3,
                        lineHeight: 1.4,
                      }}
                    >
                      {copy.desc}
                    </div>
                  </div>
                  <div className={'mp-sw' + (r.on ? ' on' : '')}>
                    <i />
                  </div>
                </div>
              )
            })}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '14px 4px 6px',
                color: 'var(--text-muted)',
                fontSize: 11.5,
                lineHeight: 1.5,
              }}
            >
              <Icon name="settings" style={{ fontSize: 16, marginTop: 1 }} />
              <span>These live in Settings › Playback › Auto-queue. Changes apply everywhere.</span>
            </div>
          </div>
        </Sheet>
      )}

      {/* MORE SHEET */}
      {sheet === 'more' && (
        <Sheet
          kicker="Player"
          title="All actions"
          onClose={closeSheet}
          right={
            <button
              onClick={() => setEdit((v) => !v)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: '1px solid var(--hairline)',
                background: 'var(--fill)',
                color: 'var(--text)',
                borderRadius: 999,
                padding: '7px 14px',
                fontFamily: 'var(--font)',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Icon name={edit ? 'check' : 'tune'} style={{ fontSize: 16 }} />
              {edit ? 'Done' : 'Edit'}
            </button>
          }
        >
          {edit && (
            <div
              style={{
                padding: '0 20px 8px',
                fontSize: 11.5,
                lineHeight: 1.4,
                color: 'var(--text-muted)',
              }}
            >
              Drag to reorder - the first four appear under the player.
            </div>
          )}
          <div
            style={{
              overflowY: 'auto',
              padding: '2px 14px calc(22px + env(safe-area-inset-bottom))',
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
            }}
          >
            {vis.map((k, i) => (
              <div
                key={k}
                className={
                  'mp-row' +
                  (aDrag === i ? ' drag' : '') +
                  (aOver === i && aDrag !== null && aDrag !== i ? ' over' : '')
                }
                draggable={edit}
                onDragStart={() => setADrag(i)}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (aOver !== i) setAOver(i)
                }}
                onDrop={commitA}
                onDragEnd={commitA}
                onClick={() => {
                  if (!edit) {
                    setSheet(null)
                    ACT[k].on()
                  }
                }}
                style={{ cursor: 'pointer', padding: '11px 8px' }}
              >
                <Icon
                  name={edit ? 'drag_indicator' : ACT[k].icon}
                  style={{
                    width: 24,
                    textAlign: 'center',
                    fontSize: edit ? 20 : 21,
                    color: edit ? 'var(--text-muted)' : 'var(--text)',
                  }}
                />
                <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{ACT[k].label}</div>
                {i < 4 && (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--hairline)',
                      borderRadius: 999,
                      padding: '3px 8px',
                    }}
                  >
                    On player
                  </span>
                )}
              </div>
            ))}
          </div>
        </Sheet>
      )}

      {/* CHAPTERS */}
      {sheet === 'chapters' && (
        <Sheet kicker="This book" title="Chapters" onClose={closeSheet}>
          <div
            style={{
              overflowY: 'auto',
              padding: '2px 14px calc(22px + env(safe-area-inset-bottom))',
            }}
          >
            {chapters.map((c, i) => (
              <div
                key={c.id}
                className="mp-row"
                onClick={() => {
                  seekClamp(c.start)
                  setSheet(null)
                }}
                style={{ cursor: 'pointer', padding: '10px 10px' }}
              >
                <span
                  style={{
                    width: 26,
                    textAlign: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: i === ci ? 'var(--accent)' : 'var(--text-faint)',
                  }}
                >
                  {i === ci ? (
                    <Icon name="graphic_eq" fill style={{ fontSize: 16 }} />
                  ) : i < ci ? (
                    <Icon name="check" style={{ fontSize: 15 }} />
                  ) : (
                    i + 1
                  )}
                </span>
                <div
                  style={{
                    flex: 1,
                    fontSize: 13.5,
                    fontWeight: i === ci ? 600 : 500,
                    color: i === ci ? 'var(--text)' : 'var(--text-muted)',
                  }}
                  className="mp-clamp1"
                >
                  {c.title}
                </div>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--text-faint)',
                  }}
                >
                  {formatTimestamp(c.end - c.start)}
                </span>
              </div>
            ))}
          </div>
        </Sheet>
      )}

      {sheet === 'recent' && (
        <Sheet kicker="This book" title="Recent listens" onClose={closeSheet}>
          <div
            style={{
              overflowY: 'auto',
              padding: '2px 14px calc(22px + env(safe-area-inset-bottom))',
            }}
          >
            <RecentListens
              libraryItemId={libraryItemId}
              onSeek={(sec) => {
                seekClamp(sec)
                setSheet(null)
              }}
            />
          </div>
        </Sheet>
      )}

      {/* ADD TO LIST */}
      {sheet === 'list' && (
        <Sheet kicker="Save" title="Add to list" onClose={closeSheet}>
          <div
            style={{
              overflowY: 'auto',
              padding: '2px 14px calc(22px + env(safe-area-inset-bottom))',
            }}
          >
            {LISTS.map((l) => {
              const on = !!lists[l.name]
              return (
                <div
                  key={l.name}
                  className="mp-row"
                  onClick={() => {
                    setLists((m) => ({ ...m, [l.name]: !m[l.name] }))
                    onToast(on ? 'Removed from ' + l.name : 'Added to ' + l.name)
                  }}
                  style={{ cursor: 'pointer', padding: '12px 10px' }}
                >
                  <Icon
                    name={l.icon}
                    style={{
                      width: 24,
                      textAlign: 'center',
                      color: on ? 'var(--accent)' : 'var(--text-muted)',
                      fontSize: 20,
                    }}
                  />
                  <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{l.name}</div>
                  {on && <Icon name="check" style={{ color: 'var(--accent)', fontSize: 20 }} />}
                </div>
              )
            })}
          </div>
        </Sheet>
      )}

      {/* SPEED / SLEEP - reuse the desktop popovers in a bottom sheet */}
      {sheet === 'speed' && (
        <PopSheet onClose={closeSheet}>
          <div className="p-pop" style={{ width: 'auto' }}>
            <SpeedPopover speed={speed} setSpeed={setSpeed} onClose={() => setSheet(null)} />
          </div>
        </PopSheet>
      )}
      {sheet === 'sleep' && (
        <PopSheet onClose={closeSheet}>
          <div className="p-pop" style={{ width: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
            <SleepPopover ctl={sleep} onClose={() => setSheet(null)} />
          </div>
        </PopSheet>
      )}

      {/* CAR MODE */}
      {car && (
        <div
          onPointerDown={(e) => {
            cy.current = e.clientY
          }}
          onPointerUp={(e) => {
            if (cy.current != null && e.clientY - cy.current > 40) setCar(false)
            cy.current = null
          }}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            background: 'var(--scaffold)',
            display: 'flex',
            flexDirection: 'column',
            padding:
              'calc(14px + env(safe-area-inset-top)) 22px calc(20px + env(safe-area-inset-bottom))',
            boxSizing: 'border-box',
            touchAction: 'none',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: '62%',
              zIndex: 0,
              pointerEvents: 'none',
              background:
                'radial-gradient(120% 60% at 50% -6%, color-mix(in oklab, var(--glow-accent, var(--accent)) calc((var(--glow-strength, 60) + 22) * 1%), transparent) 0%, transparent 62%)',
            }}
          />
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 300,
                letterSpacing: '0.28em',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
              }}
            >
              Car mode
            </div>
            <button
              className="mp-ib"
              style={{ width: 40, height: 40 }}
              onClick={() => setCar(false)}
              title="Exit car mode"
            >
              <Icon name="expand_more" style={{ fontSize: 26 }} />
            </button>
          </div>
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              onClick={toggle}
              style={{
                width: 'min(264px, 72vw)',
                aspectRatio: '1 / 1',
                borderRadius: 22,
                overflow: 'hidden',
                position: 'relative',
                cursor: 'pointer',
                boxShadow:
                  '0 30px 70px -20px color-mix(in oklab, var(--glow-accent, var(--accent)) 75%, #000)',
              }}
            >
              <Cover
                itemId={libraryItemId}
                title={title}
                fs={17}
                style={{ width: '100%', height: '100%', borderRadius: 0 }}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: isPlaying ? 'transparent' : 'rgba(0,0,0,0.34)',
                  transition: 'background .2s',
                }}
              >
                <Icon
                  name={isPlaying ? 'pause' : 'play_arrow'}
                  fill
                  style={{
                    fontSize: 84,
                    color: '#fff',
                    opacity: isPlaying ? 0.16 : 0.82,
                    transition: 'opacity .2s',
                  }}
                />
              </div>
            </div>
            <div style={{ textAlign: 'center', marginTop: 22 }}>
              <div
                className="mp-clamp1"
                style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', maxWidth: 330 }}
              >
                {title}
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 5 }}>
                {cur.title}
              </div>
            </div>
            <div style={{ width: '100%', maxWidth: 360, marginTop: 18 }}>
              <div className="scrub seekable" onClick={(e) => seekClamp(clickRatio(e) * duration)}>
                <i style={{ width: bookRatio * 100 + '%' }} />
                <b style={{ left: bookRatio * 100 + '%' }} />
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  color: 'var(--text-muted)',
                  marginTop: 9,
                }}
              >
                <span>{formatTimestamp(pos)}</span>
                <span>-{formatTimestamp(duration - pos)}</span>
              </div>
            </div>
          </div>
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              maxWidth: 380,
              width: '100%',
              margin: '0 auto',
            }}
          >
            <button className="mp-carbtn" onClick={prevCh} title="Previous chapter">
              <Icon name="skip_previous" fill style={{ fontSize: 40 }} />
            </button>
            <button className="mp-carbtn" onClick={rewind} title={'Back ' + skipBack + 's'}>
              <Icon name="replay" style={{ fontSize: 44 }} />
            </button>
            <button className="mp-carbtn" onClick={forward} title={'Forward ' + skipFwd + 's'}>
              <Icon name="replay" style={{ fontSize: 44, transform: 'scaleX(-1)' }} />
            </button>
            <button className="mp-carbtn" onClick={nextCh} title="Next chapter">
              <Icon name="skip_next" fill style={{ fontSize: 40 }} />
            </button>
          </div>
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 56,
              marginTop: 14,
            }}
          >
            <button
              className="mp-carbtn"
              onClick={() => setSheet('speed')}
              style={{ flexDirection: 'column', gap: 3, color: 'var(--text-muted)' }}
            >
              <Icon name="speed" style={{ fontSize: 30 }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{speedLabel}</span>
            </button>
            <button
              className="mp-carbtn"
              onClick={addBookmark}
              style={{ flexDirection: 'column', gap: 3, color: 'var(--text-muted)' }}
            >
              <Icon name="bookmark_add" style={{ fontSize: 30 }} />
              <span style={{ fontSize: 11, fontWeight: 600 }}>Bookmark</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
