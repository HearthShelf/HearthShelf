import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { usePlayerStore } from '@/store/playerStore'
import { useSettingsStore } from '@/store/settingsStore'
import { usePlayer } from '@/hooks/usePlayer'
import { useSleepTimer } from '@/hooks/useSleepTimer'
import { Icon } from '@/components/common/Icon'
import { Cover } from '@/components/common/Cover'
import { SpeedPopover, SleepPopover } from '@/components/player/PlayerPopovers'
import { formatTimestamp } from '@/lib/format'

type Pop = 'speed' | 'sleep' | 'volume' | null

// Persistent across route changes - rendered once by AppShell, never unmounted
// on navigation. Hidden (per the design) until a playback session exists.
export function PlayerBar() {
  const libraryItemId = usePlayerStore((s) => s.libraryItemId)
  const title = usePlayerStore((s) => s.title)
  const author = usePlayerStore((s) => s.author)
  const duration = usePlayerStore((s) => s.duration)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const chapters = usePlayerStore((s) => s.chapters)
  const speed = usePlayerStore((s) => s.playbackSpeed)
  const volume = usePlayerStore((s) => s.volume)
  const setSpeed = usePlayerStore((s) => s.setSpeed)
  const setVolume = usePlayerStore((s) => s.setVolume)
  const requestPanel = usePlayerStore((s) => s.requestPanel)

  const scrubber = useSettingsStore((s) => s.scrubber)
  const { togglePlaying, seek, skip, chapterStep } = usePlayer()
  const sleepCtl = useSleepTimer()
  const navigate = useNavigate()
  const onPlayerRoute = useLocation().pathname === '/player'

  const [pop, setPop] = useState<Pop>(null)
  const togglePop = (k: Pop) => setPop((c) => (c === k ? null : k))

  if (!libraryItemId || !title) return null

  // The scrubber tracks either the whole book or the current chapter, per the
  // Settings "scrubber" preference - matching the full player.
  let cur = { start: 0, end: duration }
  if (chapters.length > 0) {
    let idx = chapters.findIndex((c) => currentTime < c.end)
    if (idx === -1) idx = chapters.length - 1
    cur = chapters[idx]
  }
  const useChapter = scrubber === 'chapter' && chapters.length > 0
  const span = useChapter ? cur.end - cur.start : duration
  const offset = useChapter ? cur.start : 0
  const localPos = Math.max(0, currentTime - offset)
  const pct = span > 0 ? Math.min(100, (localPos / span) * 100) : 0

  const onScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (span <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    seek(offset + ratio * span)
  }

  // Chapters/Bookmarks/Queue live in the full player; the mini bar opens it
  // with the requested panel pre-selected.
  const openPanel = (panel: 'chapters' | 'bookmarks' | 'queue') => {
    setPop(null)
    requestPanel(panel)
    navigate('/player')
  }

  return (
    <div className={'playbar' + (onPlayerRoute ? ' hidden' : '')}>
      <div
        className="pb-now"
        onClick={() => navigate('/player')}
        style={{ cursor: 'pointer' }}
      >
        <Cover itemId={libraryItemId} title={title} author={author ?? undefined} fs={5} />
        <div className="pb-meta">
          <div className="pb-title">{title}</div>
          <div className="pb-sub">{author}</div>
        </div>
      </div>

      <div className="pb-center">
        <div className="pb-controls">
          <button className="pb-skip" onClick={() => chapterStep(-1)} aria-label="Previous chapter">
            <Icon name="skip_previous" fill />
          </button>
          <button className="pb-skip" onClick={() => skip(-30)} aria-label="Back 30 seconds">
            <Icon name="replay_30" />
            <small>30</small>
          </button>
          <button
            className="pb-play"
            onClick={togglePlaying}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            <Icon name={isPlaying ? 'pause' : 'play_arrow'} fill />
          </button>
          <button className="pb-skip" onClick={() => skip(30)} aria-label="Forward 30 seconds">
            <Icon name="forward_30" />
            <small>30</small>
          </button>
          <button className="pb-skip" onClick={() => chapterStep(1)} aria-label="Next chapter">
            <Icon name="skip_next" fill />
          </button>
        </div>
        <div className="pb-time">
          <span>{formatTimestamp(localPos)}</span>
          <div className="scrub" onClick={onScrub}>
            <i style={{ width: pct + '%' }} />
            <b style={{ left: pct + '%' }} />
          </div>
          <span>-{formatTimestamp(Math.max(0, span - localPos))}</span>
        </div>
      </div>

      <div className="pb-right">
        <div className="pb-pop-wrap">
          {pop === 'speed' && (
            <div className="p-pop pb-pop">
              <SpeedPopover speed={speed} setSpeed={setSpeed} onClose={() => setPop(null)} />
            </div>
          )}
          <button
            className={'pill' + (pop === 'speed' ? ' on' : '')}
            onClick={() => togglePop('speed')}
          >
            {speed}×
          </button>
        </div>
        <button className="icon-btn" title="Chapters" onClick={() => openPanel('chapters')}>
          <Icon name="list" />
        </button>
        <button className="icon-btn" title="Bookmarks" onClick={() => openPanel('bookmarks')}>
          <Icon name="bookmark_border" />
        </button>
        <div className="pb-pop-wrap">
          {pop === 'sleep' && (
            <div
              className="p-pop pb-pop"
              style={{ maxHeight: '70vh', overflowY: 'auto' }}
            >
              <SleepPopover ctl={sleepCtl} onClose={() => setPop(null)} />
            </div>
          )}
          <button
            className={'icon-btn' + (pop === 'sleep' || sleepCtl.active ? ' on' : '')}
            title="Sleep timer"
            onClick={() => togglePop('sleep')}
          >
            <Icon name="bedtime" />
          </button>
        </div>
        <button className="icon-btn" title="Queue" onClick={() => openPanel('queue')}>
          <Icon name="queue_music" />
        </button>
        <div className="pb-pop-wrap">
          {pop === 'volume' && (
            <div className="p-pop pb-pop pb-pop-volume">
              <div className="pop-head">
                <Icon name="volume_up" /> Volume
                <span className="pop-x" onClick={() => setPop(null)}>
                  <Icon name="close" style={{ fontSize: 18 }} />
                </span>
              </div>
              <div className="pop-row" style={{ marginTop: 4 }}>
                <button
                  className="icon-btn"
                  title={volume === 0 ? 'Unmute' : 'Mute'}
                  onClick={() => setVolume(volume === 0 ? 1 : 0)}
                >
                  <Icon name={volume === 0 ? 'volume_off' : 'volume_up'} />
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                />
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12.5,
                    color: 'var(--text-muted)',
                    width: 34,
                    textAlign: 'right',
                  }}
                >
                  {Math.round(volume * 100)}%
                </span>
              </div>
            </div>
          )}
          <button
            className={'icon-btn' + (pop === 'volume' ? ' on' : '')}
            title="Volume"
            onClick={() => togglePop('volume')}
          >
            <Icon name={volume === 0 ? 'volume_off' : 'volume_up'} />
          </button>
        </div>
      </div>
    </div>
  )
}
