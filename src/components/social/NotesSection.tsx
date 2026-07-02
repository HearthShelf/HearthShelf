import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getNotes, postNote, deleteNote, notesKeys } from '@/api/notes'
import type { HSNote } from '@hearthshelf/core'
import type { ABSChapter } from '@/api/types'
import { Avatar } from '@/components/common/Avatar'
import { Icon } from '@/components/common/Icon'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { buildThreads, noteTimeLabel } from '@/components/social/noteLabels'

// A relative "2h ago" / date label for a note's created_at.
function agoLabel(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

function NoteBubble({
  note,
  chapters,
  meId,
  onReply,
  onDelete,
}: {
  note: HSNote
  chapters: ABSChapter[]
  meId: string
  onReply?: () => void
  onDelete: (id: string) => void
}) {
  const stamp = noteTimeLabel(note.timeSec, chapters)
  const mine = note.userId === meId
  return (
    <div className="note-row">
      <Avatar userId={note.userId} name={note.username} size={34} className="note-avatar" />
      <div className="note-body">
        <div className="note-meta">
          <span className="note-author">{note.username}</span>
          {stamp && (
            <span className="note-stamp">
              <Icon name="schedule" style={{ fontSize: 13, verticalAlign: '-2px' }} /> {stamp}
            </span>
          )}
          <span className="note-ago">{agoLabel(note.createdAt)}</span>
        </div>
        <div className="note-text">{note.body}</div>
        <div className="note-actions">
          {onReply && (
            <button className="note-act" onClick={onReply}>
              <Icon name="reply" style={{ fontSize: 15 }} /> Reply
            </button>
          )}
          {mine && (
            <button className="note-act" onClick={() => onDelete(note.id)}>
              <Icon name="delete" style={{ fontSize: 15 }} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Public-notes section for the book detail page. Lists unlocked notes as threads
// (author avatar + name + optional chapter/timestamp label), one level of
// replies, a composer for a general (ungated) note, delete-own with a confirm,
// and a teaser line for notes hidden ahead of the reader's position. Degrades:
// when the server returns enabled:false (older server / admin kill-switch) the
// whole section renders nothing.
export function NotesSection({
  libraryItemId,
  chapters,
  meId,
  position,
  finished,
}: {
  libraryItemId: string
  chapters: ABSChapter[]
  meId: string
  // The reader's current position in seconds (from their progress), for the
  // server-side spoiler gate.
  position: number
  finished: boolean
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<HSNote | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: notesKeys.forItem(libraryItemId),
    queryFn: () => getNotes({ libraryItemId, position, finished }),
    enabled: Boolean(libraryItemId),
    staleTime: 30 * 1000,
  })

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: notesKeys.forItem(libraryItemId) })

  const post = useMutation({
    mutationFn: (vars: { body: string; parentId?: string }) =>
      postNote({ libraryItemId, body: vars.body, parentId: vars.parentId }),
    onSuccess: () => {
      setDraft('')
      setReplyDraft('')
      setReplyTo(null)
      invalidate()
    },
  })

  const del = useMutation({
    mutationFn: (id: string) => deleteNote(id),
    onSuccess: invalidate,
  })

  // enabled:false (older server / kill-switch) hides the section entirely.
  if (data && !data.enabled) return null

  const threads = data ? buildThreads(data.notes) : []
  const hiddenAhead = data?.hiddenAhead ?? 0

  return (
    <div className="detail-section notes-section">
      <div className="section-head">
        <Icon name="forum" />
        <h2>Notes</h2>
        {threads.length > 0 && <span className="sec-count">{data?.notes.length}</span>}
      </div>

      {/* Composer for a general (whole-book) note. */}
      <div className="note-composer">
        <textarea
          className="fld note-input"
          placeholder="Leave a note about this book (no timestamp)…"
          value={draft}
          maxLength={2000}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="btn-sm btn-green"
          disabled={!draft.trim() || post.isPending}
          onClick={() => post.mutate({ body: draft.trim() })}
        >
          <Icon name="send" /> Post
        </button>
      </div>

      {isLoading ? (
        <LoadingSpinner className="py-8" label="Loading notes..." />
      ) : threads.length === 0 ? (
        <div className="pop-empty" style={{ padding: '20px 0' }}>
          No notes yet. Be the first to leave one.
        </div>
      ) : (
        <div className="note-list">
          {threads.map((t) => (
            <div className="note-thread" key={t.note.id}>
              <NoteBubble
                note={t.note}
                chapters={chapters}
                meId={meId}
                onReply={() => {
                  setReplyTo(t.note)
                  setReplyDraft('')
                }}
                onDelete={setConfirmDel}
              />
              {t.replies.map((r) => (
                <div className="note-reply" key={r.id}>
                  <NoteBubble
                    note={r}
                    chapters={chapters}
                    meId={meId}
                    onDelete={setConfirmDel}
                  />
                </div>
              ))}
              {replyTo?.id === t.note.id && (
                <div className="note-reply note-composer" style={{ marginTop: 6 }}>
                  <textarea
                    className="fld note-input"
                    placeholder={`Reply to ${t.note.username}…`}
                    value={replyDraft}
                    maxLength={2000}
                    rows={2}
                    autoFocus
                    onChange={(e) => setReplyDraft(e.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn-sm btn-green"
                      disabled={!replyDraft.trim() || post.isPending}
                      onClick={() =>
                        post.mutate({ body: replyDraft.trim(), parentId: t.note.id })
                      }
                    >
                      <Icon name="send" /> Reply
                    </button>
                    <button className="btn-sm btn-ghost" onClick={() => setReplyTo(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {hiddenAhead > 0 && (
        <div className="note-hidden-ahead">
          <Icon name="lock" style={{ fontSize: 15, verticalAlign: '-2px' }} />{' '}
          {hiddenAhead} {hiddenAhead === 1 ? 'note is' : 'notes are'} ahead of you. Keep
          listening to unlock them.
        </div>
      )}

      {confirmDel && (
        <ConfirmDialog
          title="Delete note?"
          message="This removes your note for everyone. This can't be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => del.mutate(confirmDel)}
          onClose={() => setConfirmDel(null)}
        />
      )}
    </div>
  )
}
