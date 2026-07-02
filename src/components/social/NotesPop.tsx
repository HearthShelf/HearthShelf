import { useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { getNotes, postNote, deleteNote, notesKeys } from '@/api/notes'
import type { HSNote } from '@hearthshelf/core'
import type { ABSChapter } from '@/api/types'
import { formatTimestamp } from '@/lib/format'
import { Avatar } from '@/components/common/Avatar'
import { Icon } from '@/components/common/Icon'
import { buildThreads, noteTimeLabel } from '@/components/social/noteLabels'
import { VisibilityToggle, SafeToggle, NoteChips } from '@/components/social/NoteComposerControls'
import { useSettingsStore } from '@/store/settingsStore'

// The player's notes pop (styled like the bookmark pop): a composer that stamps
// the note at the current playback position, and the list of unlocked notes for
// the playing book. Mirrors the pop-head / pop-scroll shell of the other player
// pops. Notes ahead of the reader stay server-gated, so this list only holds
// what the reader has unlocked. scrollToNoteId scrolls to a note (from a marker
// click). onSeek jumps playback to a note's timestamp.
export function NotesPop({
  libraryItemId,
  chapters,
  meId,
  position,
  finished,
  scrollToNoteId,
  onClose,
  onSeek,
}: {
  libraryItemId: string
  chapters: ABSChapter[]
  meId: string
  position: number
  finished: boolean
  scrollToNoteId?: string | null
  onClose: () => void
  onSeek: (sec: number) => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const noteDefaultVisibility = useSettingsStore((s) => s.noteDefaultVisibility)
  const setSetting = useSettingsStore((s) => s.set)
  const [visibility, setVisibility] = useState<'public' | 'personal'>(
    noteDefaultVisibility === 'personal' ? 'personal' : 'public',
  )
  const [safe, setSafe] = useState(false)

  const { data } = useQuery({
    queryKey: notesKeys.forItem(libraryItemId),
    queryFn: () => getNotes({ libraryItemId, position, finished }),
    enabled: Boolean(libraryItemId),
    staleTime: 30 * 1000,
  })

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: notesKeys.forItem(libraryItemId) })

  // Post stamped at the current position (a timestamped note, gated for others
  // unless marked safe). Carries the composer's visibility + safe choice.
  const post = useMutation({
    mutationFn: () =>
      postNote({ libraryItemId, timeSec: position, body: draft.trim(), visibility, safe }),
    onSuccess: () => {
      setDraft('')
      setSafe(false)
      invalidate()
    },
  })

  const submit = () => {
    if (noteDefaultVisibility !== visibility) setSetting('noteDefaultVisibility', visibility)
    post.mutate()
  }

  const del = useMutation({
    mutationFn: (id: string) => deleteNote(id),
    onSuccess: invalidate,
  })

  // Scroll a requested note into view when the pop opens from a marker click.
  useEffect(() => {
    if (!scrollToNoteId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(`[data-note-id="${scrollToNoteId}"]`)
    if (el) el.scrollIntoView({ block: 'center' })
  }, [scrollToNoteId, data])

  const threads = data ? buildThreads(data.notes) : []
  const hiddenAhead = data?.hiddenAhead ?? 0

  const bubble = (note: HSNote, reply?: boolean) => {
    const stamp = noteTimeLabel(note.timeSec, chapters)
    return (
      <div
        className={'note-row' + (reply ? ' pop-note-reply' : '')}
        key={note.id}
        data-note-id={note.id}
      >
        <Avatar userId={note.userId} name={note.username} size={30} className="note-avatar" />
        <div className="note-body">
          <div className="note-meta">
            <span className="note-author">{note.username}</span>
            {stamp && (
              <span
                className="note-stamp"
                style={{ cursor: note.timeSec != null ? 'pointer' : 'default' }}
                onClick={() => note.timeSec != null && onSeek(note.timeSec)}
              >
                <Icon name="schedule" style={{ fontSize: 12, verticalAlign: '-2px' }} /> {stamp}
              </span>
            )}
            <NoteChips note={note} />
          </div>
          <div className="note-text">{note.body}</div>
          {note.userId === meId && (
            <div className="note-actions">
              <button className="note-act" onClick={() => del.mutate(note.id)}>
                <Icon name="delete" style={{ fontSize: 14 }} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="pop-head">
        <Icon name="forum" /> Notes
        <span className="pop-x" onClick={onClose}>
          <Icon name="close" style={{ fontSize: 18 }} />
        </span>
      </div>
      <div className="note-composer" style={{ marginBottom: 12 }}>
        <textarea
          className="fld note-input"
          placeholder={`Leave a note at ${formatTimestamp(position)}…`}
          value={draft}
          maxLength={2000}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
        />
        <VisibilityToggle value={visibility} onChange={setVisibility} disabled={post.isPending} />
        <div className="note-composer-foot">
          <SafeToggle checked={safe} onChange={setSafe} disabled={post.isPending} />
          <button
            className="btn-sm btn-green"
            disabled={!draft.trim() || post.isPending}
            onClick={submit}
          >
            <Icon name="add_comment" /> Note at {formatTimestamp(position)}
          </button>
        </div>
      </div>
      {threads.length === 0 ? (
        <div className="pop-empty">No notes here yet</div>
      ) : (
        <div className="pop-scroll" ref={scrollRef}>
          {threads.map((t) => (
            <div key={t.note.id}>
              {bubble(t.note)}
              {t.replies.map((r) => bubble(r, true))}
            </div>
          ))}
        </div>
      )}
      {hiddenAhead > 0 && (
        <div className="note-hidden-ahead" style={{ marginTop: 10 }}>
          <Icon name="lock" style={{ fontSize: 14, verticalAlign: '-2px' }} /> {hiddenAhead} ahead
        </div>
      )}
    </>
  )
}
