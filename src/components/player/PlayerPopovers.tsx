import { type SleepCtl } from '@/hooks/useSleepTimer'
import { formatTimestamp } from '@/lib/format'
import { Icon } from '@/components/common/Icon'

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const SLEEP_PRESETS = [5, 15, 30, 45, 60, 90]

// "30s", "1m 30s" - compact label for the sleep-timer rewind amount.
function fmtRewind(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

// Playback-speed popover: live value, slider (0.5x-3x), and preset chips.
// Shared by the full player and the persistent play bar.
export function SpeedPopover({
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

// Sleep-timer popover: duration / chapter / clock stop modes plus the stop
// sequence (rewind, fade, chime). All logic lives in useSleepTimer (ctl).
export function SleepPopover({
  ctl,
  onClose,
}: {
  ctl: SleepCtl
  onClose: () => void
}) {
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

      <div className="pop-row">
        <div className="pr-t">
          Rewind when it stops
          <div className="pr-d">
            {ctl.rewindSec > 0
              ? `Backs up ${fmtRewind(ctl.rewindSec)} so you pick up with context`
              : 'Resumes exactly where it stopped'}
          </div>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
            color: ctl.rewindSec > 0 ? 'var(--text)' : 'var(--text-muted)',
            minWidth: 44,
            textAlign: 'right',
          }}
        >
          {ctl.rewindSec > 0 ? fmtRewind(ctl.rewindSec) : 'Off'}
        </span>
      </div>
      <div className="pop-row" style={{ marginTop: 6 }}>
        <input
          type="range"
          min={0}
          max={ctl.maxRewind}
          step={5}
          value={Math.min(ctl.rewindSec, ctl.maxRewind)}
          onChange={(e) => ctl.setRewindSec(Number(e.target.value))}
          style={{ flex: 1, accentColor: 'var(--accent)' }}
          aria-label="Rewind amount"
        />
      </div>
      {ctl.rewindSec > 0 && (
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
