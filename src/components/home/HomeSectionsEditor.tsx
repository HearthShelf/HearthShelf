/**
 * Home's arrange mode: the home screen with the covers stripped away, leaving
 * just the section headers as draggable rows. Entered from the pencil in the
 * Home header, exited with Done.
 *
 * Arranging IS the home screen - not a separate settings page - so the order you
 * drag is literally the order you're looking at. Each row carries its section's
 * real icon and label, an eye to toggle visibility, and a drag handle. Hidden
 * sections stay in the list (dimmed) rather than moving to a separate bucket, so
 * turning one back on doesn't lose its place.
 *
 * The "More picks for you" row also carries a stepper for how many taste-derived
 * shelves it may spawn (0 turns the block off just like the eye does).
 *
 * The arrangement writes to the settings store on every drop/toggle, so it syncs
 * across devices like every other account setting - including to the mobile app,
 * which reads the same homeSections key. Reset puts the canonical order back.
 */
import type { HomeSectionId, HomeSectionPref } from '@hearthshelf/core'
import {
  DEFAULT_HOME_SECTIONS,
  DEFAULT_REC_SHELF_COUNT,
  MAX_REC_SHELF_COUNT,
} from '@hearthshelf/core'
import { Icon } from '@/components/common/Icon'
import { usePointerReorder } from '@/hooks/usePointerReorder'
import { useSettingsStore } from '@/store/settingsStore'

/** How each section presents itself here: its Home icon + label, and a one-line
 *  reminder of what the band actually shows. */
export const HOME_SECTION_META: Record<
  HomeSectionId,
  { label: string; icon: string; hint: string }
> = {
  dashboard: {
    label: 'Up next & streak',
    icon: 'insights',
    hint: 'Your listening streak and progress',
  },
  'release-countdown': {
    label: 'Coming soon',
    icon: 'schedule',
    hint: 'Countdown for books you follow',
  },
  'book-club': { label: 'Your book clubs', icon: 'groups', hint: 'What your clubs are reading' },
  'continue-listening': {
    label: 'Continue Listening',
    icon: 'play_circle',
    hint: 'Books you have started',
  },
  'continue-series': {
    label: 'Continue Series',
    icon: 'auto_stories',
    hint: 'The next book in series you are reading',
  },
  questgiver: {
    label: 'Picked by QuestGiver',
    icon: 'auto_awesome',
    hint: 'Your latest QuestGiver picks',
  },
  recommended: {
    label: 'Recommended for you',
    icon: 'recommend',
    hint: 'Best matches from your whole library',
  },
  'recommended-picks': {
    label: 'More picks for you',
    icon: 'auto_awesome',
    hint: 'Rows built from your favorite genres, authors and narrators',
  },
  'series-next': {
    label: 'Finish the series',
    icon: 'auto_stories',
    hint: 'Unplayed books in series you have started',
  },
  recent: {
    label: 'Back to your library',
    icon: 'library_books',
    hint: 'Books you own but have not started',
  },
  'recently-added': {
    label: 'Recently Added',
    icon: 'schedule',
    hint: 'The newest books on your server',
  },
}

interface HomeSectionsEditorProps {
  onDone: () => void
}

export function HomeSectionsEditor({ onDone }: HomeSectionsEditorProps) {
  const sections = useSettingsStore((s) => s.homeSections)
  const recCount = useSettingsStore((s) => s.homeRecShelfCount)
  const setSetting = useSettingsStore((s) => s.set)

  const hiddenCount = sections.filter((s) => !s.on).length

  const reorder = (from: number, to: number) => {
    const next = sections.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setSetting('homeSections', next)
  }
  const toggle = (id: HomeSectionId) =>
    setSetting(
      'homeSections',
      sections.map((s) => (s.id === id ? { ...s, on: !s.on } : s)),
    )
  const reset = () => {
    setSetting('homeSections', DEFAULT_HOME_SECTIONS)
    setSetting('homeRecShelfCount', DEFAULT_REC_SHELF_COUNT)
  }

  const { dragIndex, overIndex, getRowProps } = usePointerReorder(sections.length, reorder)

  return (
    <div className="hs-edit">
      <div className="hs-edit-bar">
        <div style={{ flex: 1 }}>
          <div className="hs-edit-t">Arrange your home</div>
          <div className="hs-edit-d">
            {hiddenCount > 0 ? `${hiddenCount} hidden` : 'Drag to reorder, tap the eye to hide'}
          </div>
        </div>
        <button type="button" className="pill" onClick={reset}>
          Reset
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          <Icon name="check" /> Done
        </button>
      </div>

      {sections.map((sec, i) => (
        <SectionRow
          key={sec.id}
          section={sec}
          rowProps={getRowProps(i)}
          dragging={dragIndex === i}
          over={overIndex === i && dragIndex !== i}
          recCount={recCount}
          onToggle={() => toggle(sec.id)}
          onSetCount={(n) => setSetting('homeRecShelfCount', n)}
        />
      ))}
    </div>
  )
}

interface SectionRowProps {
  section: HomeSectionPref
  rowProps: ReturnType<ReturnType<typeof usePointerReorder>['getRowProps']>
  dragging: boolean
  over: boolean
  recCount: number
  onToggle: () => void
  onSetCount: (n: number) => void
}

function SectionRow({
  section,
  rowProps,
  dragging,
  over,
  recCount,
  onToggle,
  onSetCount,
}: SectionRowProps) {
  const meta = HOME_SECTION_META[section.id]
  const { style, ...rest } = rowProps
  // The picks block's count stepper doubles as an off switch, so a 0 count reads
  // as hidden here even though the eye is still on.
  const off = !section.on || (section.id === 'recommended-picks' && recCount === 0)

  return (
    <div
      className={'hs-row' + (dragging ? ' dragging' : '')}
      {...rest}
      style={{
        ...style,
        opacity: dragging ? 0.5 : off ? 0.55 : 1,
        borderTop: over ? '2px solid var(--primary)' : undefined,
      }}
    >
      <div className="hs-row-main">
        <Icon name="drag_indicator" style={{ color: 'var(--text-muted)' }} />
        <Icon name={meta.icon} style={{ color: off ? 'var(--text-faint)' : 'var(--primary)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="hs-row-t">{meta.label}</div>
          <div className="hs-row-d">{meta.hint}</div>
        </div>
        {/* Stop the pointer-down from starting a drag when toggling. */}
        <span onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="hs-eye"
            onClick={onToggle}
            title={section.on ? 'Hide this section' : 'Show this section'}
            aria-pressed={section.on}
          >
            <Icon name={section.on ? 'visibility' : 'visibility_off'} />
          </button>
        </span>
      </div>

      {section.id === 'recommended-picks' && (
        <RecCountStepper
          count={recCount}
          disabled={!section.on}
          onChange={onSetCount}
        />
      )}
    </div>
  )
}

/** Stepper for how many taste-derived rows the picks block may spawn (0-8). */
function RecCountStepper({
  count,
  disabled,
  onChange,
}: {
  count: number
  disabled: boolean
  onChange: (n: number) => void
}) {
  const step = (delta: number) => {
    const next = Math.max(0, Math.min(MAX_REC_SHELF_COUNT, count + delta))
    if (next !== count) onChange(next)
  }
  return (
    <div
      className="hs-stepper"
      style={{ opacity: disabled ? 0.5 : 1 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span style={{ flex: 1 }}>
        {count === 0 ? 'No extra rows' : `Up to ${count} row${count === 1 ? '' : 's'}`}
      </span>
      <button
        type="button"
        className="hs-step"
        onClick={() => step(-1)}
        disabled={disabled || count === 0}
        aria-label="Fewer rows"
      >
        <Icon name="remove" />
      </button>
      <b className="hs-step-n">{count}</b>
      <button
        type="button"
        className="hs-step"
        onClick={() => step(1)}
        disabled={disabled || count === MAX_REC_SHELF_COUNT}
        aria-label="More rows"
      >
        <Icon name="add" />
      </button>
    </div>
  )
}
