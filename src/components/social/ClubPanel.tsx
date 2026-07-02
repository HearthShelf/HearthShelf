import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getClub, clubsKeys, markClubRead } from '@/api/clubs'
import { postNote } from '@/api/notes'
import type { ABSChapter } from '@/api/types'
import type { HSClubBook, HSClubMember } from '@hearthshelf/core'
import { sortMembersByProgress } from '@hearthshelf/core'
import { formatTimestamp } from '@/lib/format'
import { Avatar } from '@/components/common/Avatar'
import { Icon } from '@/components/common/Icon'
import { buildThreads, noteTimeLabel } from '@/components/social/noteLabels'

// A single member's progress rail in the race: chapter tick marks, a filled bar
// to their position, an avatar dot, a finished flag, and a listening-now pulse.
function MemberRail({
  member,
  duration,
  chapters,
}: {
  member: HSClubMember
  duration: number
  chapters: ABSChapter[]
}) {
  const dur = member.duration ?? duration
  const frac =
    member.isFinished === true
      ? 1
      : member.currentTime != null && dur > 0
        ? Math.min(1, member.currentTime / dur)
        : 0
  const known = member.currentTime != null || member.isFinished === true
  return (
    <div className="club-rail-row">
      <div className="club-rail-name">
        <Avatar userId={member.userId} name={member.username} size={22} />
        <span className="crn-text">{member.username}</span>
        {member.role === 'owner' && <Icon name="star" fill className="crn-owner" />}
        {member.listeningNow && (
          <Icon name="graphic_eq" fill className="crn-live" title="Listening recently" />
        )}
      </div>
      <div className="club-rail-track">
        {dur > 0 &&
          chapters.map((c) => (
            <i
              key={c.id}
              className="crt-tick"
              style={{ left: `${Math.min(100, (c.start / dur) * 100)}%` }}
            />
          ))}
        <i className="crt-fill" style={{ width: `${frac * 100}%` }} />
        {known && (
          <span
            className={'crt-dot' + (member.isFinished ? ' done' : '')}
            style={{ left: `${frac * 100}%` }}
            title={
              member.isFinished
                ? 'Finished'
                : member.currentTime != null
                  ? formatTimestamp(member.currentTime)
                  : ''
            }
          />
        )}
      </div>
      <span className="club-rail-pct">
        {member.isFinished ? (
          <Icon name="check_circle" fill style={{ fontSize: 15, color: '#a7c896' }} />
        ) : known ? (
          `${Math.round(frac * 100)}%`
        ) : (
          '—'
        )}
      </span>
    </div>
  )
}

// The player's book-club panel. Shows the club's book history (a selector for
// the current + past books), the per-book chat thread with a composer (stamps
// the current playback position when the playing item IS the viewed book), and
// the member progress race for the viewed book. Bumps the per-club read cursor
// when the chat is scrolled to the bottom. Polls every 15s while mounted.
export function ClubPanel({
  clubId,
  playingItemId,
  playingPosition,
  playingChapters,
  onClose,
  onSeek,
  scrollToNoteId,
}: {
  clubId: string
  // The item currently loaded in the player (may differ from the viewed book).
  playingItemId: string | null
  playingPosition: number
  playingChapters: ABSChapter[]
  onClose: () => void
  onSeek: (sec: number) => void
  scrollToNoteId?: string | null
}) {
  const qc = useQueryClient()
  const [viewBookId, setViewBookId] = useState<string>('')
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Position for the spoiler gate. When the selected book is the one playing (or
  // no book is explicitly selected, so the default resolves to the current book
  // the player is on), send the live position; a past book we aren't playing
  // sends 0 and relies on the finished-bypass. The server clamps to the caller's
  // own progress when it can, so an over-optimistic position can't leak.
  const gatePosition =
    playingItemId && (viewBookId === '' || viewBookId === playingItemId) ? playingPosition : 0

  const { data } = useQuery({
    queryKey: clubsKeys.detail(clubId, viewBookId),
    queryFn: () => getClub({ clubId, bookId: viewBookId || undefined, position: gatePosition }),
    enabled: Boolean(clubId),
    staleTime: 10 * 1000,
    refetchInterval: 15 * 1000,
  })

  const club = data?.club
  const books = data?.books ?? []
  const current = books.find((b) => b.finishedAt == null) ?? null
  // The book actually shown (server resolves the default when we send none).
  const shownBookId =
    viewBookId ||
    current?.libraryItemId ||
    books[books.length - 1]?.libraryItemId ||
    ''
  const shownBook: HSClubBook | null =
    books.find((b) => b.libraryItemId === shownBookId) ?? current
  const isViewingCurrent = Boolean(current) && shownBookId === current?.libraryItemId
  // Composer stamps a position only when the player is on the viewed book.
  const canStamp = Boolean(playingItemId && playingItemId === shownBookId)

  const notes = useMemo(() => data?.notes.notes ?? [], [data?.notes.notes])
  const hiddenAhead = data?.notes.hiddenAhead ?? 0
  const threads = useMemo(() => buildThreads(notes), [notes])

  const members = useMemo(
    () => sortMembersByProgress(data?.members ?? []),
    [data?.members],
  )
  const shownDuration =
    members.find((m) => m.duration != null)?.duration ?? 0

  const invalidate = () => qc.invalidateQueries({ queryKey: clubsKeys.detail(clubId, viewBookId) })

  const post = useMutation({
    mutationFn: (vars: { body: string; parentId?: string }) =>
      postNote({
        libraryItemId: shownBookId,
        clubId,
        parentId: vars.parentId,
        timeSec: canStamp ? playingPosition : null,
        body: vars.body,
      }),
    onSuccess: () => {
      setDraft('')
      invalidate()
    },
  })

  // Bump the read cursor to the newest unlocked note when the chat is open (the
  // server applies max(), so this is safe to fire on each new-message batch).
  const markRead = useMutation({
    mutationFn: (lastReadAt: number) => markClubRead(clubId, lastReadAt),
    onSuccess: () => qc.invalidateQueries({ queryKey: clubsKeys.detail(clubId, viewBookId) }),
  })

  const newestAt = notes.reduce((mx, n) => (n.createdAt > mx ? n.createdAt : mx), 0)
  const cursorRef = useRef(0)
  useEffect(() => {
    // When the panel shows the newest note (list is short or scrolled to bottom),
    // advance the cursor. Keep it simple: mark read whenever a newer note than
    // our last-sent cursor appears while the panel is mounted.
    if (newestAt > cursorRef.current) {
      cursorRef.current = newestAt
      markRead.mutate(newestAt)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestAt])

  // Scroll to the requested note (from a pop deep-link) once notes land.
  useEffect(() => {
    if (!scrollToNoteId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(`[data-note-id="${scrollToNoteId}"]`)
    if (el) el.scrollIntoView({ block: 'center' })
  }, [scrollToNoteId, notes])

  if (data && !data.enabled) {
    return (
      <div className="pp-inner">
        <div className="pp-head">
          <Icon name="groups" />
          <div className="pp-htext">
            <div className="pp-title">Book club</div>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="pop-empty" style={{ padding: 32 }}>
          This club isn't available.
        </div>
      </div>
    )
  }

  const bubble = (
    note: (typeof notes)[number],
    reply?: boolean,
    onReply?: () => void,
  ) => {
    const stamp = noteTimeLabel(note.timeSec, playingChapters)
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
                style={{ cursor: note.timeSec != null && canStamp ? 'pointer' : 'default' }}
                onClick={() => note.timeSec != null && canStamp && onSeek(note.timeSec)}
              >
                <Icon name="schedule" style={{ fontSize: 12, verticalAlign: '-2px' }} /> {stamp}
              </span>
            )}
          </div>
          <div className="note-text">{note.body}</div>
          {onReply && (
            <div className="note-actions">
              <button className="note-act" onClick={onReply}>
                <Icon name="reply" style={{ fontSize: 14 }} /> Reply
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="pp-inner">
      <div className="pp-head">
        <Icon name="groups" />
        <div className="pp-htext">
          <div className="pp-title">{club?.name ?? 'Book club'}</div>
          <div className="pp-sub">
            {club ? `${club.memberCount} ${club.memberCount === 1 ? 'member' : 'members'}` : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      {/* Book history selector */}
      {books.length > 1 && (
        <div className="club-book-select">
          <select
            className="fld"
            value={shownBookId}
            onChange={(e) => setViewBookId(e.target.value)}
          >
            {books
              .slice()
              .reverse()
              .map((b) => (
                <option key={b.libraryItemId} value={b.libraryItemId}>
                  {b.finishedAt == null ? 'Now reading' : 'Past'} · {b.title || 'Untitled'}
                </option>
              ))}
          </select>
        </div>
      )}

      {/* Progress race */}
      {members.length > 0 && (
        <div className="club-race">
          <div className="club-race-head">
            <Icon name="trending_up" style={{ fontSize: 15 }} />{' '}
            {isViewingCurrent ? 'Where everyone is' : 'How it ended'}
          </div>
          {members.map((m) => (
            <MemberRail
              key={m.userId}
              member={m}
              duration={shownDuration}
              chapters={canStamp ? playingChapters : []}
            />
          ))}
        </div>
      )}

      {/* Chat */}
      <div className="pp-scroll club-chat" ref={scrollRef}>
        {threads.length === 0 ? (
          <div className="pop-empty" style={{ padding: '24px 0' }}>
            No messages yet. Say something about {shownBook?.title || 'this book'}.
          </div>
        ) : (
          threads.map((t) => (
            <div key={t.note.id} className="note-thread">
              {bubble(t.note, false, () => setReplyTo(replyTo === t.note.id ? null : t.note.id))}
              {t.replies.map((r) => bubble(r, true))}
              {replyTo === t.note.id && (
                <div className="note-reply" style={{ marginTop: 4 }}>
                  <ReplyComposer
                    disabled={post.isPending}
                    onCancel={() => setReplyTo(null)}
                    onSend={(body) => post.mutate({ body, parentId: t.note.id })}
                    author={t.note.username}
                  />
                </div>
              )}
            </div>
          ))
        )}
        {hiddenAhead > 0 && (
          <div className="note-hidden-ahead" style={{ marginTop: 10 }}>
            <Icon name="lock" style={{ fontSize: 14, verticalAlign: '-2px' }} /> {hiddenAhead}{' '}
            {hiddenAhead === 1 ? 'message is' : 'messages are'} ahead of you.
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="club-composer">
        <input
          className="fld"
          placeholder={
            canStamp ? `Message at ${formatTimestamp(playingPosition)}…` : 'Message the club…'
          }
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim() && !post.isPending) {
              post.mutate({ body: draft.trim() })
            }
          }}
        />
        <button
          className="btn-sm btn-green"
          disabled={!draft.trim() || post.isPending}
          onClick={() => post.mutate({ body: draft.trim() })}
        >
          <Icon name="send" />
        </button>
      </div>
    </div>
  )
}

function ReplyComposer({
  author,
  disabled,
  onSend,
  onCancel,
}: {
  author: string
  disabled: boolean
  onSend: (body: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  return (
    <div className="club-composer" style={{ padding: 0 }}>
      <input
        className="fld"
        placeholder={`Reply to ${author}…`}
        value={text}
        maxLength={2000}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim() && !disabled) onSend(text.trim())
          if (e.key === 'Escape') onCancel()
        }}
      />
      <button
        className="btn-sm btn-green"
        disabled={!text.trim() || disabled}
        onClick={() => onSend(text.trim())}
      >
        <Icon name="send" />
      </button>
    </div>
  )
}
