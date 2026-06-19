import { type ReactNode } from 'react'
import {
  useSettingsStore,
  ACCENT_PRESETS,
  type SettingsState,
} from '@/store/settingsStore'

// --- Local controls (ported from the design reference Settings component) ---

interface SegOption<T extends string> {
  v: T
  l: string
}
function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: SegOption<T>[]
  onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.v}
          className={value === o.v ? 'on' : ''}
          onClick={() => onChange(o.v)}
        >
          {o.l}
        </button>
      ))}
    </div>
  )
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div
      className={'toggle' + (on ? ' on' : '')}
      role="switch"
      aria-checked={on}
      onClick={onClick}
    >
      <i />
    </div>
  )
}

// Quick-pick preset chips + a freeform numeric field sharing one value.
function NumPick({
  value,
  onChange,
  presets,
  min = 1,
  max = 600,
  unit = 's',
}: {
  value: number
  onChange: (v: number) => void
  presets: number[]
  min?: number
  max?: number
  unit?: string
}) {
  return (
    <div className="num-pick">
      <div className="seg">
        {presets.map((p) => (
          <button
            key={p}
            className={value === p ? 'on' : ''}
            onClick={() => onChange(p)}
          >
            {p}
            {unit}
          </button>
        ))}
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) =>
          onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))
        }
        className="num-field"
      />
      <span className="num-unit">{unit === 's' ? 'sec' : unit}</span>
    </div>
  )
}

function SetRow({
  title,
  desc,
  control,
  disabled,
}: {
  title: string
  desc?: string
  control: ReactNode
  disabled?: boolean
}) {
  return (
    <div
      className="set-row"
      style={disabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}
    >
      <div className="sr-meta">
        <div className="sr-t">{title}</div>
        {desc && <div className="sr-d">{desc}</div>}
      </div>
      {control}
    </div>
  )
}

// Stretch features that depend on data ABS may not expose yet.
function ComingSoon() {
  return <span className="badge-pill abridged">Coming soon</span>
}

export function SettingsPage() {
  const s = useSettingsStore()
  const set = s.set
  // Typed setter shorthand.
  const put = <K extends keyof SettingsState>(k: K, v: SettingsState[K]) =>
    set(k as never, v as never)

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div className="eyebrow">Make it yours</div>
        <h1 className="title-xl">Settings</h1>
      </div>

      {/* Appearance */}
      <div className="nav-label" style={{ padding: '0 4px 10px' }}>
        Appearance
      </div>
      <div className="set-group">
        <SetRow
          title="Theme"
          desc="Dark is home; light for daytime reading."
          control={
            <Seg
              value={s.theme}
              onChange={(v) => put('theme', v)}
              options={[
                { v: 'dark', l: 'Dark' },
                { v: 'light', l: 'Light' },
                { v: 'flat', l: 'OLED' },
              ]}
            />
          }
        />
        <SetRow
          title="Accent from cover"
          desc="Let the artwork colour the controls and glow."
          control={
            <Toggle
              on={s.accentMode === 'dynamic'}
              onClick={() =>
                put('accentMode', s.accentMode === 'dynamic' ? 'manual' : 'dynamic')
              }
            />
          }
        />
        <SetRow
          title="Manual accent"
          desc="Pick a fixed colour for chrome."
          disabled={s.accentMode === 'dynamic'}
          control={
            <div className="swatch-row">
              {ACCENT_PRESETS.map((p) => (
                <div
                  key={p.name}
                  title={p.name}
                  className={'swatch' + (s.accentHex === p.hex ? ' on' : '')}
                  style={{ background: p.hex }}
                  onClick={() => put('accentHex', p.hex)}
                />
              ))}
            </div>
          }
        />
        <SetRow
          title="Cover-glow intensity"
          desc="How strongly the cover blooms behind the page."
          control={
            <div className="range-row">
              <input
                type="range"
                min={0}
                max={60}
                value={s.glow}
                onChange={(e) => put('glow', Number(e.target.value))}
              />
              <span className="badge-pill">{s.glow}</span>
            </div>
          }
        />
        <SetRow
          title="Cover style"
          desc="Float artwork on the page, or sit it on cards."
          control={
            <Seg
              value={s.coverStyle}
              onChange={(v) => put('coverStyle', v)}
              options={[
                { v: 'floating', l: 'Floating' },
                { v: 'cards', l: 'Cards' },
              ]}
            />
          }
        />
        <SetRow
          title="Colour everywhere"
          desc="Tint the whole app, not just the player."
          control={
            <Toggle
              on={s.colorEverywhere}
              onClick={() => put('colorEverywhere', !s.colorEverywhere)}
            />
          }
        />
      </div>

      {/* Playback */}
      <div className="nav-label" style={{ padding: '16px 4px 10px' }}>
        Playback
      </div>
      <div className="set-group">
        <SetRow
          title="Scrubber"
          desc="Drag through the current chapter, or scrub the whole book on one bar."
          control={
            <Seg
              value={s.scrubber}
              onChange={(v) => put('scrubber', v)}
              options={[
                { v: 'chapter', l: 'Chapter' },
                { v: 'book', l: 'Full book' },
              ]}
            />
          }
        />
        <SetRow
          title="Fast-forward"
          desc="How far the forward button jumps."
          control={
            <NumPick
              value={s.skipForward}
              onChange={(v) => put('skipForward', v)}
              presets={[15, 30, 60]}
            />
          }
        />
        <SetRow
          title="Rewind"
          desc="How far the back button jumps - shorter to nudge, longer to recap."
          control={
            <NumPick
              value={s.skipBack}
              onChange={(v) => put('skipBack', v)}
              presets={[10, 15, 30]}
            />
          }
        />
        <SetRow
          title="Chapter barrier"
          desc="Stop playback at the end of each chapter instead of rolling on."
          control={
            <Toggle
              on={s.chapterBarrier}
              onClick={() => put('chapterBarrier', !s.chapterBarrier)}
            />
          }
        />
      </div>

      {/* Library */}
      <div className="nav-label" style={{ padding: '16px 4px 10px' }}>
        Library
      </div>
      <div className="set-group">
        <SetRow
          title="Library layout"
          desc="Let the grid fill the full width, or keep it boxed."
          control={
            <Toggle
              on={s.libraryFill}
              onClick={() => put('libraryFill', !s.libraryFill)}
            />
          }
        />
        <SetRow
          title="Unified home"
          desc="Pull in-progress titles onto Home from every library at once."
          control={
            <Toggle
              on={s.unifiedHome}
              onClick={() => put('unifiedHome', !s.unifiedHome)}
            />
          }
        />
        <SetRow
          title="Show what others have read"
          desc="See community comparisons and what other listeners are reading."
          disabled
          control={<ComingSoon />}
        />
        <SetRow
          title="Share my reading list"
          desc="Let other listeners see your name and finished titles."
          disabled
          control={<ComingSoon />}
        />
      </div>

      {/* Sleep timer */}
      <div className="nav-label" style={{ padding: '16px 4px 10px' }}>
        Sleep timer
      </div>
      <div className="set-group">
        <SetRow
          title="Fade volume out"
          desc="Ease the volume down as the timer runs out, instead of cutting off."
          control={
            <Toggle
              on={s.sleepFade}
              onClick={() => put('sleepFade', !s.sleepFade)}
            />
          }
        />
        <SetRow
          title="Fade length"
          desc="How long the fade takes before it stops."
          disabled={!s.sleepFade}
          control={
            <div className="range-row">
              <input
                type="range"
                min={3}
                max={60}
                value={s.sleepFadeLen}
                onChange={(e) => put('sleepFadeLen', Number(e.target.value))}
              />
              <span className="badge-pill">{s.sleepFadeLen}s</span>
            </div>
          }
        />
        <SetRow
          title="Rewind on wake"
          desc="When the timer stops, jump back a little so you can pick up with context."
          control={
            <Toggle
              on={s.sleepRewind}
              onClick={() => put('sleepRewind', !s.sleepRewind)}
            />
          }
        />
        <SetRow
          title="Warning chime"
          desc="A soft chime a minute before sleep, so you can tap to keep listening."
          control={
            <Toggle
              on={s.sleepChime}
              onClick={() => put('sleepChime', !s.sleepChime)}
            />
          }
        />
        <SetRow
          title="Auto sleep timer"
          desc="Start a timer on its own when you press play during quiet hours."
          control={
            <Toggle
              on={s.autoSleep}
              onClick={() => put('autoSleep', !s.autoSleep)}
            />
          }
        />
        {s.autoSleep && (
          <>
            <SetRow
              title="Quiet hours"
              desc="When auto sleep should kick in."
              control={
                <div className="time-row">
                  <input
                    type="time"
                    value={s.autoSleepStart}
                    onChange={(e) => put('autoSleepStart', e.target.value)}
                    className="fld"
                  />
                  <span style={{ color: 'var(--text-muted)' }}>to</span>
                  <input
                    type="time"
                    value={s.autoSleepEnd}
                    onChange={(e) => put('autoSleepEnd', e.target.value)}
                    className="fld"
                  />
                </div>
              }
            />
            <SetRow
              title="Auto duration"
              desc="Timer length auto sleep starts with."
              control={
                <NumPick
                  value={s.autoSleepDur}
                  onChange={(v) => put('autoSleepDur', v)}
                  presets={[20, 30, 45]}
                  min={5}
                  max={180}
                  unit="m"
                />
              }
            />
          </>
        )}
      </div>

      <p
        className="page-sub"
        style={{ margin: '12px 4px 8px', fontSize: 12.5 }}
      >
        External book links (Goodreads, Audible, Hardcover...) are managed by your
        server admin under Server &rarr; Integrations.
      </p>
    </div>
  )
}
