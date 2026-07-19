import { useState, useEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useSettingsStore,
  ACCENT_PRESETS,
  type SettingsState,
  type AutoRulePref,
} from '@/store/settingsStore'
import type { AutoRuleId } from '@/store/queueStore'
import { useQueueStore } from '@/store/queueStore'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getPlaylists, libraryKeys } from '@/api/libraries'
import { getMe, changePassword, meKeys } from '@/api/me'
import { getCommunityConfig, socialKeys } from '@/api/social'
import {
  getHardcoverAccount,
  connectHardcover,
  disconnectHardcover,
  triggerHardcoverSync,
  finishedBooksKeys,
} from '@/api/finishedBooks'
import { useRmabConfig } from '@/hooks/useRmab'
import { useToast } from '@/hooks/useToast'
import { exportMyDataJson, exportMyFinishedBooksCsv } from '@/api/export'
import { fmtSessDate } from '@/lib/format'
import {
  useReaderPrefs,
  READER_SIZE_MIN,
  READER_SIZE_MAX,
  type ReaderPrefs,
} from '@/store/readerPrefsStore'
import { Icon } from '@/components/common/Icon'
import { ManualQueueEditor } from '@/components/player/ManualQueueEditor'
import { useDismissalsStore } from '@/store/dismissalsStore'
import { AvatarUpload } from '@/components/common/AvatarUpload'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { CoverStyleDemo } from '@/components/common/CoverStyleDemo'

type SettingsSection =
  'account' | 'appearance' | 'playback' | 'sleep' | 'reading' | 'library' | 'connections'

const SETTINGS_NAV: { label: string; items: [SettingsSection, string, string][] }[] = [
  {
    label: 'You',
    items: [
      ['account', 'person', 'Account'],
      ['appearance', 'palette', 'Appearance'],
    ],
  },
  {
    label: 'Listening',
    items: [
      ['playback', 'speed', 'Playback'],
      ['sleep', 'bedtime', 'Sleep timer'],
    ],
  },
  {
    label: 'Reading',
    items: [['reading', 'menu_book', 'Reader']],
  },
  {
    label: 'Library',
    items: [
      ['library', 'groups', 'Home & community'],
      ['connections', 'hub', 'Connections'],
    ],
  },
]

// Picks which playlist Playlist-mode follows. Stored in the queue store
// (session-scoped) since it drives playback, not a synced preference.
function PlaylistPicker() {
  const { activeId } = useActiveLibrary()
  const playlistId = useQueueStore((s) => s.playlistId)
  const setPlaylistId = useQueueStore((s) => s.setPlaylistId)
  const { data } = useQuery({
    queryKey: libraryKeys.playlists(activeId ?? ''),
    queryFn: () => getPlaylists(activeId as string),
    enabled: !!activeId,
    staleTime: 2 * 60 * 1000,
  })
  const playlists = data?.results ?? []

  if (playlists.length === 0) {
    return <span className="badge-pill">No playlists yet</span>
  }
  return (
    <select
      className="fld"
      style={{ maxWidth: 240 }}
      value={playlistId ?? ''}
      onChange={(e) => setPlaylistId(e.target.value || null)}
    >
      <option value="">Choose a playlist…</option>
      {playlists.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  )
}

// Human labels for the Auto-queue rules.
const RULE_LABELS: Record<AutoRuleId, { title: string; desc: string }> = {
  'finish-series': {
    title: 'Finish current series',
    desc: 'Queue the next book in the series you are listening to.',
  },
  'in-progress': {
    title: 'Anything in progress',
    desc: 'Queue other books you have started but not finished.',
  },
  'new-in-series': {
    title: 'New book in a started series',
    desc: 'Queue the next book from each series you have begun but not finished.',
  },
  'new-in-series-all': {
    title: 'Include every book in the series',
    desc: 'Instead of just the next one, queue all the books left in each series you started.',
  },
  'book-club': {
    title: 'Book club picks',
    desc: 'Queue what your book clubs are reading, current book first.',
  },
  manual: {
    title: 'Books you queued by hand',
    desc: 'Queue the books you added yourself. Drag to set where they land.',
  },
}

// Drag-to-reorder list of the Auto rules, each with an on/off toggle. The list
// order is the rule priority. Reuses the queue-panel drag pattern.
function RuleList({
  rules,
  onChange,
}: {
  rules: AutoRulePref[]
  onChange: (rules: AutoRulePref[]) => void
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  const move = (from: number, to: number) => {
    const next = rules.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }
  const toggle = (i: number) =>
    onChange(rules.map((r, idx) => (idx === i ? { ...r, on: !r.on } : r)))

  return (
    <div className="rule-list">
      {rules.map((r, i) => {
        const meta = RULE_LABELS[r.id]
        // new-in-series-all is a sub-modifier of new-in-series: indent it and
        // dim/disable it while the parent is off (it does nothing on its own).
        const isSub = r.id === 'new-in-series-all'
        const parentOff = isSub && !rules.find((x) => x.id === 'new-in-series')?.on
        return (
          <div
            className={'rule-row' + (dragIdx === i ? ' dragging' : '') + (isSub ? ' rule-sub' : '')}
            key={r.id}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIdx !== null && dragIdx !== i) move(dragIdx, i)
              setDragIdx(null)
            }}
            onDragEnd={() => setDragIdx(null)}
            style={parentOff ? { opacity: 0.45 } : undefined}
          >
            <span className="rule-handle" title="Drag to reorder">
              <Icon name="drag_indicator" />
            </span>
            <span className="rule-pri">{i + 1}</span>
            <div className="rule-meta">
              <div className="rule-t">{meta.title}</div>
              <div className="rule-d">{meta.desc}</div>
            </div>
            <Toggle on={r.on} onClick={() => !parentOff && toggle(i)} />
          </div>
        )
      })}
    </div>
  )
}

// The user's "not right now" dismissals, each with a Restore button. Restoring
// brings a series/book back to the Auto queue + Continue-* shelves.
function HiddenFromShelves() {
  const seriesIds = useDismissalsStore((s) => s.seriesIds)
  const itemIds = useDismissalsStore((s) => s.itemIds)
  const labels = useDismissalsStore((s) => s.labels)
  const hydrate = useDismissalsStore((s) => s.hydrate)
  const restore = useDismissalsStore((s) => s.restore)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const rows: { kind: 'series' | 'item'; id: string }[] = [
    ...seriesIds.map((id) => ({ kind: 'series' as const, id })),
    ...itemIds.map((id) => ({ kind: 'item' as const, id })),
  ]
  if (rows.length === 0) return null

  return (
    <div className="set-row set-row-stack">
      <div className="sr-meta">
        <div className="sr-t">Hidden from shelves</div>
        <div className="sr-d">
          Series and books you hid from your Auto queue and Continue shelves. Restore to bring them
          back.
        </div>
      </div>
      <div className="rule-list">
        {rows.map((r) => (
          <div className="rule-row" key={`${r.kind}:${r.id}`} style={{ cursor: 'default' }}>
            <Icon name={r.kind === 'series' ? 'collections_bookmark' : 'menu_book'} />
            <div className="rule-meta" style={{ flex: 1 }}>
              <div className="rule-t">
                {labels[r.id] ?? (r.kind === 'series' ? 'Hidden series' : 'Hidden book')}
              </div>
            </div>
            <button className="btn-ghost" onClick={() => void restore(r.kind, r.id)}>
              Restore
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

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
        <button key={o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  )
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div className={'toggle' + (on ? ' on' : '')} role="switch" aria-checked={on} onClick={onClick}>
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
          <button key={p} className={value === p ? 'on' : ''} onClick={() => onChange(p)}>
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
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
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
  title: ReactNode
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

  // Toast for page-level actions (e.g. the data-export buttons).
  const { toast: pageToast, show } = useToast()

  const [section, setSection] = useState<SettingsSection>('account')

  // The server's default sharing setting, so the leaderboard toggle can show the
  // inherited state when the user hasn't chosen for themselves (shareReadBooks
  // is null until they do).
  const { data: community } = useQuery({
    queryKey: socialKeys.communityConfig,
    queryFn: getCommunityConfig,
    staleTime: 5 * 60 * 1000,
  })
  const defaultShare = community?.defaultShare ?? true
  const defaultShareListening = community?.defaultShareListening ?? false
  // Effective state shown on each toggle: explicit choice if made, else default.
  const sharesEffective = s.shareReadBooks ?? defaultShare
  const listeningEffective = s.shareCurrentlyListening ?? defaultShareListening

  return (
    <div className="page fade-in settings-shell">
      {pageToast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {pageToast}
        </div>
      )}
      <div className="page-head">
        <div className="eyebrow">Make it yours</div>
        <h1 className="title-xl">Settings</h1>
      </div>

      <div className="settings-layout">
        <nav className="config-nav">
          {SETTINGS_NAV.map((group) => (
            <div key={group.label}>
              <div className="cn-label">{group.label}</div>
              {group.items.map(([id, icon, label]) => (
                <button
                  key={id}
                  className={'cn-item' + (section === id ? ' on' : '')}
                  onClick={() => setSection(id)}
                >
                  <Icon name={icon} fill={section === id} />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="config-body">
          {section === 'account' && <AccountSettings />}
          {section === 'reading' && <ReadingSettings />}
          {section === 'connections' && <ConnectionsSettings />}

          {/* Appearance */}
          {section === 'appearance' && (
            <>
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
                  title="Accent colour"
                  desc="The colour for buttons, progress, and active controls."
                  control={
                    <div className="swatch-row">
                      {ACCENT_PRESETS.map((p) => (
                        <div
                          key={p.name}
                          title={p.name}
                          className={'swatch' + (s.accentHex === p.hex ? ' on' : '')}
                          style={{ background: p.hex }}
                          onClick={() => {
                            put('accentMode', 'manual')
                            put('accentHex', p.hex)
                          }}
                        />
                      ))}
                    </div>
                  }
                />
                <SetRow
                  title="Cover-glow intensity"
                  desc="How strongly the now-playing cover blooms behind the page."
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
                  title={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      Cover style
                      <span className="cs-info">
                        <Icon name="info" />
                        <span className="cs-pop">
                          <CoverStyleDemo />
                        </span>
                      </span>
                    </span>
                  }
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
                  title="Hearth background on player"
                  desc="Show the cozy hearth scene behind the full-screen player while something is playing."
                  control={
                    <Toggle
                      on={s.hearthBgPlayer}
                      onClick={() => put('hearthBgPlayer', !s.hearthBgPlayer)}
                    />
                  }
                />
                <SetRow
                  title="Use shared settings"
                  desc="Keep this device's settings in step with your other devices. Turn off to keep this device's look and feel on its own."
                  control={
                    <Toggle
                      on={s.useSharedSettings}
                      onClick={() => put('useSharedSettings', !s.useSharedSettings)}
                    />
                  }
                />
              </div>
            </>
          )}

          {/* Playback (+ Queue) */}
          {section === 'playback' && (
            <>
              <div className="set-group">
                <SetRow
                  title="Default speed"
                  desc="The rate a fresh book starts at."
                  control={
                    <NumPick
                      value={s.defaultSpeed}
                      onChange={(v) => put('defaultSpeed', v)}
                      presets={[0.75, 1, 1.25, 1.5, 2]}
                      min={0.5}
                      max={3.5}
                      unit="x"
                    />
                  }
                />{' '}
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
                      onChange={(v) => {
                        put('skipForwardCustom', v)
                        put('skipForward', v)
                      }}
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
                      onChange={(v) => {
                        put('skipBackCustom', v)
                        put('skipBack', v)
                      }}
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
                <SetRow
                  title="Count end credits as done"
                  desc="If the last chapter is this short, reaching it finishes the book. Stops end credits and outros from leaving a book stuck at 100%. Set 0 to turn off."
                  control={
                    <NumPick
                      value={s.creditsChapterMaxSec}
                      onChange={(v) => put('creditsChapterMaxSec', v)}
                      presets={[30, 60, 120]}
                      min={0}
                      max={600}
                    />
                  }
                />
                <SetRow
                  title="Finish grace"
                  desc="Stopping this close to the end of the last real chapter still counts as finishing the book."
                  control={
                    <NumPick
                      value={s.chapterEndGraceSec}
                      onChange={(v) => put('chapterEndGraceSec', v)}
                      presets={[5, 15, 30]}
                      min={0}
                      max={300}
                    />
                  }
                />
                <SetRow
                  title="Finished at percent"
                  desc="Backup rule for books with no chapter list: mark them done past this much. The chapter rules above are more accurate, so this stays off unless you set it."
                  control={
                    <NumPick
                      value={s.finishedPercent}
                      onChange={(v) => put('finishedPercent', v)}
                      presets={[0, 90, 95]}
                      min={0}
                      max={100}
                      unit="%"
                    />
                  }
                />
                <SetRow
                  title="Hide player bar"
                  desc="Turn off the docked bar that shows what's playing. Open the full player from the nav or a book's Play button."
                  control={
                    <Toggle
                      on={s.hideMiniPlayer}
                      onClick={() => put('hideMiniPlayer', !s.hideMiniPlayer)}
                    />
                  }
                />
              </div>

              {/* Queue */}
              <div className="nav-label" style={{ padding: '16px 4px 10px' }}>
                Queue
              </div>
              <div className="set-group">
                <SetRow
                  title="When a book ends"
                  desc="Off stops; Manual plays your queue; Auto builds an up-next from the rules below; Playlist follows a chosen playlist."
                  control={
                    <Seg
                      value={s.queueMode}
                      onChange={(v) => put('queueMode', v)}
                      options={[
                        { v: 'off', l: 'Off' },
                        { v: 'manual', l: 'Manual' },
                        { v: 'auto', l: 'Auto' },
                        { v: 'playlist', l: 'Playlist' },
                      ]}
                    />
                  }
                />
                <div
                  className="set-row set-row-stack"
                  style={
                    s.queueMode !== 'auto' ? { opacity: 0.45, pointerEvents: 'none' } : undefined
                  }
                >
                  <div className="sr-meta">
                    <div className="sr-t">Auto rules</div>
                    <div className="sr-d">
                      Drag to set priority. The queue fills from the top rule down.
                    </div>
                  </div>
                  <RuleList rules={s.queueAutoRules} onChange={(r) => put('queueAutoRules', r)} />
                </div>
                {(s.queueMode === 'manual' || s.queueMode === 'auto') && (
                  <div className="set-row set-row-stack">
                    <div className="sr-meta">
                      <div className="sr-t">
                        {s.queueMode === 'auto' ? 'Your queue' : 'Manual queue'}
                      </div>
                      <div className="sr-d">
                        {s.queueMode === 'auto'
                          ? 'Auto picks are shown grayed out. Drag or remove the books you queued by hand below.'
                          : 'Drag to set the order, or remove a book.'}
                      </div>
                    </div>
                    <ManualQueueEditor mode={s.queueMode} />
                  </div>
                )}
                {s.queueMode === 'playlist' && (
                  <SetRow
                    title="Playlist to follow"
                    desc="Playlist mode plays through this playlist in order."
                    control={<PlaylistPicker />}
                  />
                )}
                <HiddenFromShelves />
              </div>
            </>
          )}

          {/* Library: Home & community */}
          {section === 'library' && (
            <>
              <div className="set-group">
                <SetRow
                  title="Library layout"
                  desc="Let the grid fill the full width, or keep it boxed."
                  control={
                    <Toggle on={s.libraryFill} onClick={() => put('libraryFill', !s.libraryFill)} />
                  }
                />
                <SetRow
                  title="Unified home"
                  desc="Pull in-progress titles onto Home from every library at once."
                  control={
                    <Toggle on={s.unifiedHome} onClick={() => put('unifiedHome', !s.unifiedHome)} />
                  }
                />
                <SetRow
                  title="Search outside your library"
                  desc="Also find audiobooks you don't own yet. Search shows them in a 'Not in your library' section so you can request them."
                  control={
                    <Toggle
                      on={s.searchExternalSources}
                      onClick={() => put('searchExternalSources', !s.searchExternalSources)}
                    />
                  }
                />
                <SetRow
                  title="Goodreads link on book pages"
                  desc="Show a Goodreads search link on each book's detail page."
                  control={
                    <Toggle
                      on={s.externalLinkGoodreads}
                      onClick={() => put('externalLinkGoodreads', !s.externalLinkGoodreads)}
                    />
                  }
                />
                <SetRow
                  title="Audible link on book pages"
                  desc="Show an Audible search link on each book's detail page."
                  control={
                    <Toggle
                      on={s.externalLinkAudible}
                      onClick={() => put('externalLinkAudible', !s.externalLinkAudible)}
                    />
                  }
                />
                <SetRow
                  title="Hardcover link on book pages"
                  desc="Show a Hardcover search link on each book's detail page."
                  control={
                    <Toggle
                      on={s.externalLinkHardcover}
                      onClick={() => put('externalLinkHardcover', !s.externalLinkHardcover)}
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
                  desc={
                    s.shareReadBooks === null
                      ? `Appear on the server leaderboard with your name and finished count. Following the server default (currently ${defaultShare ? 'shared' : 'hidden'}) until you choose.`
                      : 'Appear on the server leaderboard with your name and finished count. Turn this off to stay hidden from other listeners.'
                  }
                  control={
                    <Toggle
                      on={sharesEffective}
                      onClick={() => put('shareReadBooks', !sharesEffective)}
                    />
                  }
                />
                <SetRow
                  title="Show when I'm listening"
                  desc={
                    s.shareCurrentlyListening === null
                      ? `Let other listeners see you as recently listening on a book you're playing. Following the server default (currently ${defaultShareListening ? 'shown' : 'hidden'}) until you choose.`
                      : "Let other listeners see you as recently listening on a book you're playing. Turn this off to keep what you're listening to private."
                  }
                  control={
                    <Toggle
                      on={listeningEffective}
                      onClick={() => put('shareCurrentlyListening', !listeningEffective)}
                    />
                  }
                />
                <SetRow
                  title="Book club note pops"
                  desc="Get a little pop when your listening crosses a club note, so you can read and reply. Turn off to silence pops on this device without leaving any club."
                  control={<Toggle on={s.notePops} onClick={() => put('notePops', !s.notePops)} />}
                />
                <SetRow
                  title="Download my data"
                  desc="Get a copy of your HearthShelf data - reading history, notes, settings, and Discover feedback. No passwords or secrets. Your library and progress live in AudiobookShelf and aren't included."
                  control={
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn-sm btn-ghost"
                        onClick={() =>
                          void exportMyDataJson().catch(() => show('Could not export your data'))
                        }
                      >
                        JSON
                      </button>
                      <button
                        className="btn-sm btn-ghost"
                        onClick={() =>
                          void exportMyFinishedBooksCsv().catch(() =>
                            show('Could not export your books'),
                          )
                        }
                      >
                        Books (CSV)
                      </button>
                    </div>
                  }
                />
              </div>
            </>
          )}

          {/* Sleep timer */}
          {section === 'sleep' && (
            <>
              <div className="set-group">
                <SetRow
                  title="Fade volume out"
                  desc="Ease the volume down as the timer runs out, instead of cutting off."
                  control={
                    <Toggle on={s.sleepFade} onClick={() => put('sleepFade', !s.sleepFade)} />
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
                  desc="When the timer stops, jump back this far so you can pick up with context. Set to Off to resume exactly where it stopped."
                  control={
                    <div className="range-row">
                      <input
                        type="range"
                        min={0}
                        max={300}
                        step={5}
                        value={s.sleepRewindSec}
                        onChange={(e) => put('sleepRewindSec', Number(e.target.value))}
                      />
                      <span className="badge-pill">
                        {s.sleepRewindSec === 0
                          ? 'Off'
                          : s.sleepRewindSec < 60
                            ? `${s.sleepRewindSec}s`
                            : `${Math.floor(s.sleepRewindSec / 60)}m${
                                s.sleepRewindSec % 60 ? ` ${s.sleepRewindSec % 60}s` : ''
                              }`}
                      </span>
                    </div>
                  }
                />
                <SetRow
                  title="Auto sleep timer"
                  desc="Start a timer on its own when you press play during quiet hours."
                  control={
                    <Toggle on={s.autoSleep} onClick={() => put('autoSleep', !s.autoSleep)} />
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Account section (folded in from the old /account page) ---
function AccountSettings() {
  const { data: me } = useQuery({
    queryKey: meKeys.me,
    queryFn: getMe,
    staleTime: 60 * 1000,
  })

  const useGravatar = useSettingsStore((s) => s.useGravatar)
  const setSetting = useSettingsStore((s) => s.set)
  // null = never chose, so the default (ON) applies; only an explicit false is off.
  const gravatarOn = useGravatar !== false

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async () => {
    setMsg(null)
    if (next !== confirm) {
      setMsg({ ok: false, text: 'New passwords do not match.' })
      return
    }
    if (!next) {
      setMsg({ ok: false, text: 'Enter a new password.' })
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      setMsg({ ok: true, text: 'Password updated.' })
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch {
      setMsg({
        ok: false,
        text: 'Could not update password. Check your current password.',
      })
    } finally {
      setBusy(false)
    }
  }

  if (!me) return <LoadingSpinner className="py-12" label="Loading account..." />

  const perms = Object.entries(me.permissions ?? {}).filter(([, v]) => v)
  const sso = me.hasOpenIDLink

  return (
    <>
      <div className="cfg-card" style={{ marginBottom: 'var(--s4)' }}>
        <div className="cfg-line">
          <Icon name="account_circle" style={{ color: 'var(--text-muted)' }} />
          <div className="cl-meta">
            <div className="cl-t">Profile photo</div>
          </div>
          <AvatarUpload key={`grav-${gravatarOn}`} userId={me.id} name={me.username} size={72} />
        </div>
        <div className="cfg-line">
          <Icon name="public" style={{ color: 'var(--text-muted)' }} />
          <div className="cl-meta">
            <div className="cl-t">Use my Gravatar</div>
            <div className="cl-d">
              When you haven't uploaded a photo, show your Gravatar (from your email) instead of
              initials.
            </div>
          </div>
          <Toggle on={gravatarOn} onClick={() => setSetting('useGravatar', !gravatarOn)} />
        </div>
      </div>

      <div className="cfg-card">
        {(
          [
            ['person', 'Username', me.username],
            ['badge', 'Account type', me.type],
            ['calendar_today', 'Member since', fmtSessDate(me.createdAt).day],
          ] as [string, string, string][]
        ).map(([icon, label, value]) => (
          <div className="cfg-line" key={label}>
            <Icon name={icon} style={{ color: 'var(--text-muted)' }} />
            <div className="cl-meta">
              <div className="cl-t">{label}</div>
            </div>
            <span style={{ color: 'var(--text-muted)' }}>{value}</span>
          </div>
        ))}
        <div className="cfg-line">
          <Icon name="email" style={{ color: 'var(--text-muted)' }} />
          <div className="cl-meta">
            <div className="cl-t">Email</div>
          </div>
          <span style={{ color: 'var(--text-muted)' }}>
            {me.email ?? 'Not set'}
            {sso && (
              <Icon name="lock" style={{ fontSize: 15, marginLeft: 6, verticalAlign: '-2px' }} />
            )}
          </span>
        </div>
      </div>

      {sso && (
        <div className="sso-warn" style={{ marginTop: 'var(--s4)' }}>
          <Icon name="info" />
          <span>
            Your email and sign-in are managed by your <b>OpenID Connect provider</b>. Changes made
            here can be overwritten the next time you sign in. Update them with your identity
            provider.
          </span>
        </div>
      )}

      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <Icon name="lock" />
        <h2>{sso ? 'Fallback password' : 'Change password'}</h2>
      </div>
      {sso && (
        <p className="page-sub" style={{ marginTop: -6, marginBottom: 12 }}>
          You sign in with OpenID. Set a password here only if you also want to sign in directly.
        </p>
      )}
      <div className="cfg-card">
        {!sso && (
          <div className="field full">
            <label>Current password</label>
            <input
              className="fld"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
        )}
        <div className="field full">
          <label>New password</label>
          <input
            className="fld"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <div className="field full">
          <label>Confirm new password</label>
          <input
            className="fld"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <button className="btn-sm btn-green" disabled={busy} onClick={() => void submit()}>
            <Icon name="save" /> {sso ? 'Set password' : 'Update password'}
          </button>
          {msg && (
            <span style={{ fontSize: 13, color: msg.ok ? '#a7c896' : 'var(--primary)' }}>
              {msg.text}
            </span>
          )}
        </div>
      </div>

      {perms.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
            <Icon name="verified_user" />
            <h2>Permissions</h2>
          </div>
          <div className="meta-chips">
            {perms.map(([k]) => (
              <span className="chip" key={k}>
                <Icon name="check" /> {k.replace(/^can/, '')}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  )
}

// --- Reading section: in-browser reader display preferences ---
const READER_THEME_OPTS: { v: ReaderPrefs['theme']; l: string }[] = [
  { v: 'dark', l: 'Dark' },
  { v: 'sepia', l: 'Sepia' },
  { v: 'light', l: 'Light' },
]
const READER_FONT_OPTS: { v: ReaderPrefs['font']; l: string }[] = [
  { v: 'serif', l: 'Serif' },
  { v: 'sans', l: 'Sans' },
  { v: 'dyslexic', l: 'Dyslexic' },
]
const READER_WIDTH_OPTS: { v: ReaderPrefs['width']; l: string }[] = [
  { v: 'narrow', l: 'Narrow' },
  { v: 'medium', l: 'Medium' },
  { v: 'wide', l: 'Wide' },
]
const READER_LH_OPTS: { v: ReaderPrefs['lh']; l: string }[] = [
  { v: 'compact', l: 'Compact' },
  { v: 'normal', l: 'Normal' },
  { v: 'relaxed', l: 'Relaxed' },
]

function ReadingSettings() {
  const rp = useReaderPrefs()
  return (
    <div className="set-group">
      <SetRow
        title="Reader theme"
        desc="Page colours for the in-browser ebook reader."
        control={
          <Seg value={rp.theme} onChange={(v) => rp.set('theme', v)} options={READER_THEME_OPTS} />
        }
      />
      <SetRow
        title="Typeface"
        desc="Serif reads like print; Dyslexic aids some readers."
        control={
          <Seg value={rp.font} onChange={(v) => rp.set('font', v)} options={READER_FONT_OPTS} />
        }
      />
      <SetRow
        title="Text size"
        desc="How large the body text is set."
        control={
          <div className="range-row">
            <input
              type="range"
              min={READER_SIZE_MIN}
              max={READER_SIZE_MAX}
              value={rp.size}
              onChange={(e) => rp.set('size', Number(e.target.value))}
            />
            <span className="badge-pill">{rp.size}px</span>
          </div>
        }
      />
      <SetRow
        title="Line spacing"
        desc="Breathing room between lines."
        control={<Seg value={rp.lh} onChange={(v) => rp.set('lh', v)} options={READER_LH_OPTS} />}
      />
      <SetRow
        title="Page width"
        desc="How wide the column of text runs."
        control={
          <Seg value={rp.width} onChange={(v) => rp.set('width', v)} options={READER_WIDTH_OPTS} />
        }
      />
      <SetRow
        title="Justify text"
        desc="Align both edges of the paragraph, like a printed book."
        control={
          <Toggle
            on={rp.align === 'justify'}
            onClick={() => rp.set('align', rp.align === 'justify' ? 'left' : 'justify')}
          />
        }
      />
    </div>
  )
}

// --- Connections section: external account links ---
// ReadMeABook and outbound book-search links stay admin-managed server-side
// (Server > Integrations). Hardcover sync is per-user reading-tracker data,
// so it gets a real connect form here instead of pointing at the admin page.
function ConnectionsSettings() {
  const { data: rmab, isLoading } = useRmabConfig()
  const connected = rmab?.configured === true
  return (
    <>
      <HardcoverSettings />

      <div className="cfg-card" style={{ marginTop: 'var(--s4)' }}>
        <div className="cfg-line">
          <Icon
            name={connected ? 'check_circle' : 'bolt'}
            fill={connected}
            style={{ color: connected ? '#5a9c52' : 'var(--text-muted)' }}
          />
          <div className="cl-meta" style={{ flex: 1 }}>
            <div className="cl-t">ReadMeABook</div>
            <div className="cl-d">
              {isLoading
                ? 'Checking…'
                : connected
                  ? 'Connected. You can request titles you don’t own yet from Requests and QuestGiver.'
                  : 'Not connected. Your server admin sets this up under Server → Integrations.'}
            </div>
          </div>
          <span
            className="badge-pill"
            style={{
              background: connected
                ? 'color-mix(in oklab, #5a9c52 20%, transparent)'
                : 'var(--fill)',
              color: connected ? '#7fbd6f' : 'var(--text-muted)',
            }}
          >
            {connected ? 'Active' : 'Off'}
          </span>
        </div>
      </div>

      <div className="cfg-card" style={{ marginTop: 'var(--s4)' }}>
        <div className="cfg-line">
          <Icon name="hub" style={{ color: 'var(--text-muted)' }} />
          <div className="cl-meta" style={{ flex: 1 }}>
            <div className="cl-t">External book links</div>
            <div className="cl-d">
              Goodreads, Audible, Hardcover and other search links are managed by your server admin
              under Server &rarr; Integrations.
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// Hardcover: per-user reading-tracker sync. The token is a personal access
// token from the user's own Hardcover account, so it's entered here (not the
// admin Integrations page) and stored against this ABS user only.
function HardcoverSettings() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { toast, show } = useToast()
  const { data, isLoading } = useQuery({
    queryKey: finishedBooksKeys.hardcover,
    queryFn: getHardcoverAccount,
    staleTime: 30 * 1000,
  })
  const [token, setToken] = useState('')

  const connect = useMutation({
    mutationFn: () => connectHardcover(token.trim()),
    onSuccess: (account) => {
      qc.setQueryData(finishedBooksKeys.hardcover, account)
      setToken('')
      show('Hardcover connected')
    },
    onError: (err) =>
      show(
        err instanceof Error && err.message === 'invalid_token'
          ? 'That token didn’t work'
          : 'Could not connect',
      ),
  })

  const disconnect = useMutation({
    mutationFn: disconnectHardcover,
    onSuccess: () => {
      qc.setQueryData(finishedBooksKeys.hardcover, {
        connected: false,
        username: null,
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
      })
      show('Hardcover disconnected')
    },
  })

  const sync = useMutation({
    mutationFn: triggerHardcoverSync,
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: finishedBooksKeys.hardcover })
      qc.invalidateQueries({ queryKey: finishedBooksKeys.list })
      show(`Synced ${result.synced} book${result.synced === 1 ? '' : 's'}`)
    },
    onError: () => show('Sync failed'),
  })

  const connected = data?.connected === true

  return (
    <div className="cfg-card">
      <div className="cfg-line">
        <Icon
          name={connected ? 'check_circle' : 'auto_stories'}
          fill={connected}
          style={{ color: connected ? '#5a9c52' : 'var(--text-muted)' }}
        />
        <div className="cl-meta" style={{ flex: 1 }}>
          <div className="cl-t">Hardcover</div>
          <div className="cl-d">
            {isLoading
              ? 'Checking…'
              : connected
                ? `Connected as ${data?.username ?? 'your Hardcover account'}.`
                : 'Sync the books you finish here to your Hardcover reading history.'}
            {connected && data?.lastSyncAt && (
              <>
                {' '}
                Last synced {new Date(data.lastSyncAt).toLocaleString()}
                {data.lastSyncStatus === 'error' && data.lastSyncError
                  ? ` (last attempt had errors: ${data.lastSyncError})`
                  : ''}
              </>
            )}
          </div>
        </div>
        <span
          className="badge-pill"
          style={{
            background: connected ? 'color-mix(in oklab, #5a9c52 20%, transparent)' : 'var(--fill)',
            color: connected ? '#7fbd6f' : 'var(--text-muted)',
          }}
        >
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {!connected && (
        <div className="field full" style={{ marginTop: 'var(--s3)' }}>
          <label>Personal access token</label>
          <input
            className="fld"
            type="password"
            autoComplete="off"
            placeholder="Paste your Hardcover API token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <div className="cl-d" style={{ marginTop: 4 }}>
            Find this at{' '}
            <a href="https://hardcover.app/account/api" target="_blank" rel="noreferrer">
              hardcover.app/account/api
            </a>
            .
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
        {!connected ? (
          <button
            className="btn-sm btn-green"
            disabled={!token.trim() || connect.isPending}
            onClick={() => connect.mutate()}
          >
            <Icon name="save" /> Connect
          </button>
        ) : (
          <>
            <button
              className="btn-sm btn-green"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
            >
              <Icon name="sync" /> Sync now
            </button>
            <button
              className="btn-sm"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </button>
          </>
        )}
        <button className="btn-sm" onClick={() => navigate('/settings/import/goodreads')}>
          <Icon name="upload_file" /> Import from Goodreads
        </button>
      </div>

      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </div>
  )
}
