// Shared composer affordances for the note surfaces (book-detail NotesSection,
// player NotesPop, club composer). Two author-set controls per docs/social.md:
//
//   - Visibility: a 2-way Public / Personal segmented toggle for GENERAL
//     (non-club) top-level notes. Personal = only-you. Club notes don't offer it
//     (visibility is implicit). Defaults to the noteDefaultVisibility device
//     setting; the caller writes that setting back on each post.
//   - Safe: a spoiler-free opt-in, next to Submit on every TOP-LEVEL composer
//     (general and club), default off, labelled to make the consequence explicit.
//     Never offered on the reply composer.
//
// Both render nothing extra structurally so they slot into the existing
// .note-composer / .club-composer flex column.

import type { HSNote, NoteVisibility } from '@hearthshelf/core'
import { Icon } from '@/components/common/Icon'

// Small status chips shown in a received note's meta row. A personal note (your
// own - the server never sends anyone else's) gets an "Only you" chip; a safe
// note gets a "Safe" chip so readers know it was shown early on purpose.
export function NoteChips({ note }: { note: HSNote }) {
  const personal = note.visibility === 'personal'
  const safe = note.safe
  if (!personal && !safe) return null
  return (
    <>
      {personal && (
        <span className="chip note-chip note-chip-personal">
          <Icon name="lock" /> Only you
        </span>
      )}
      {safe && (
        <span className="chip note-chip note-chip-safe">
          <Icon name="verified" /> Safe
        </span>
      )}
    </>
  )
}

// Public / Personal segmented control for a general note composer. Only two of
// the three NoteVisibility values apply here (a club note is implicit 'club').
export function VisibilityToggle({
  value,
  onChange,
  disabled,
}: {
  value: NoteVisibility
  onChange: (v: 'public' | 'personal') => void
  disabled?: boolean
}) {
  return (
    <div className="note-vis" role="group" aria-label="Who can see this note">
      <div className="seg note-vis-seg">
        <button
          type="button"
          className={value !== 'personal' ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange('public')}
        >
          <Icon name="public" style={{ fontSize: 15, verticalAlign: '-2px' }} /> Public
        </button>
        <button
          type="button"
          className={value === 'personal' ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange('personal')}
        >
          <Icon name="lock" style={{ fontSize: 15, verticalAlign: '-2px' }} /> Only me
        </button>
      </div>
      <span className="note-vis-hint">
        {value === 'personal' ? 'Only you can see this note.' : 'Everyone on the server can see this.'}
      </span>
    </div>
  )
}

// Spoiler-free checkbox for a top-level composer. Off means the note is gated by
// playback position for others; on means it shows to everyone right away.
export function SafeToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={'note-safe' + (checked ? ' on' : '')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <Icon name={checked ? 'verified' : 'shield'} style={{ fontSize: 16 }} />
      <span>Safe - show to everyone now (no spoilers)</span>
    </label>
  )
}
