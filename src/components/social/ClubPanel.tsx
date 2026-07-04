import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getClub,
  clubsKeys,
  markClubRead,
  recommendClubBook,
  setClubRecBasis,
  addClubQueue,
} from '@/api/clubs'
import { postNote } from '@/api/notes'
import { getAllLibraryItems, libraryKeys } from '@/api/libraries'
import { useAuthStore } from '@/store/authStore'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import type { ABSChapter } from '@/api/types'
import type {
  HSClubBook,
  HSClubMember,
  ClubRecBasis,
  ClubRecCandidate,
  ClubRecPick,
} from '@hearthshelf/core'
import { sortMembersByProgress, qgBooks, qgLibraryCandidates } from '@hearthshelf/core'
import { formatTimestamp } from '@/lib/format'
import { Avatar } from '@/components/common/Avatar'
import { Icon } from '@/components/common/Icon'
import { buildThreads, noteTimeLabel } from '@/components/social/noteLabels'
import { SafeToggle, NoteChips } from '@/components/social/NoteComposerControls'

// A member is "almost done" once they're at least 90% through the current book.
// When the whole club has nothing queued next, that's the cue to recommend one.
const ALMOST_DONE = 0.9
function memberFraction(m: HSClubMember): number {
  if (m.isFinished === true) return 1
  if (m.currentTime != null && m.duration != null && m.duration > 0) {
    return Math.min(1, m.currentTime / m.duration)
  }
  return 0
}

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
  const [safe, setSafe] = useState(false)
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

  // Recommendation surface: owner-only, and only when the club allows it (basis
  // isn't 'off'). The auto-banner nudges when the club is wrapping up its book -
  // a member is near the end AND nothing is queued next.
  const me = useAuthStore((s) => s.user)
  const isOwner = Boolean(me && club && me.id === club.createdBy)
  const recBasis = club?.recBasis ?? 'club-history'
  const queue = data?.queue ?? []
  const someoneAlmostDone = members.some((m) => memberFraction(m) >= ALMOST_DONE)
  const wrappingUp = isViewingCurrent && queue.length === 0 && someoneAlmostDone

  const invalidate = () => qc.invalidateQueries({ queryKey: clubsKeys.detail(clubId, viewBookId) })

  const post = useMutation({
    mutationFn: (vars: { body: string; parentId?: string; safe?: boolean }) =>
      postNote({
        libraryItemId: shownBookId,
        clubId,
        parentId: vars.parentId,
        timeSec: canStamp ? playingPosition : null,
        // Safe is top-level only; the server also drops it on replies. Visibility
        // is implicit 'club' here, so the composer never offers Public/Personal.
        safe: vars.parentId ? undefined : vars.safe,
        body: vars.body,
      }),
    onSuccess: () => {
      setDraft('')
      setSafe(false)
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
            <NoteChips note={note} />
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

      {/* Next-book recommendation (owner only) */}
      {isOwner && recBasis !== 'off' && (
        <ClubRecommend
          clubId={clubId}
          clubName={club?.name ?? 'this club'}
          basis={recBasis}
          books={books}
          wrappingUp={wrappingUp}
          onQueued={invalidate}
          onBasisChanged={invalidate}
        />
      )}
      {isOwner && recBasis === 'off' && (
        <ClubRecBasisOff clubId={clubId} onBasisChanged={invalidate} />
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
      <div className="club-composer club-composer-safe">
        <div className="club-composer-row">
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
                post.mutate({ body: draft.trim(), safe })
              }
            }}
          />
          <button
            className="btn-sm btn-green"
            disabled={!draft.trim() || post.isPending}
            onClick={() => post.mutate({ body: draft.trim(), safe })}
          >
            <Icon name="send" />
          </button>
        </div>
        <SafeToggle checked={safe} onChange={setSafe} disabled={post.isPending} />
      </div>
    </div>
  )
}

// The basis choices the owner can pick, with short plain-language labels.
const BASIS_OPTIONS: { value: ClubRecBasis; label: string }[] = [
  { value: 'club-history', label: "Books your club has read" },
  { value: 'all-members-finished', label: "Everything members have finished" },
  { value: 'off', label: 'Turn recommendations off' },
]

// Owner-only next-book recommendation section. Builds the candidate pool from
// the owner's own unstarted library books (the same shape QuestGiver uses) and
// the genre lists of the club's already-read books, posts them, and shows the
// picks with a one-click "Add to up next". When the club is wrapping up its
// current book (a member near the end, nothing queued), it self-surfaces a nudge.
function ClubRecommend({
  clubId,
  clubName,
  basis,
  books,
  wrappingUp,
  onQueued,
  onBasisChanged,
}: {
  clubId: string
  clubName: string
  basis: ClubRecBasis
  books: HSClubBook[]
  wrappingUp: boolean
  onQueued: () => void
  onBasisChanged: () => void
}) {
  const qc = useQueryClient()
  const { activeId } = useActiveLibrary()
  const progressById = useMediaProgress()
  const [picks, setPicks] = useState<ClubRecPick[] | null>(null)
  const [intro, setIntro] = useState('')
  const [engine, setEngine] = useState<'ai' | 'heuristic' | null>(null)
  const [expanded, setExpanded] = useState(false)

  // The owner's whole library, only fetched once they engage (expand or the
  // wrapping-up nudge shows) - it's the candidate source and the genre lookup.
  const shouldLoad = expanded || wrappingUp
  const { data: itemsData } = useQuery({
    queryKey: libraryKeys.allItems(activeId ?? ''),
    queryFn: () => getAllLibraryItems(activeId as string),
    enabled: shouldLoad && activeId !== null,
    staleTime: 60 * 1000,
  })

  const qBooks = useMemo(
    () => qgBooks(itemsData?.results ?? [], progressById),
    [itemsData, progressById],
  )
  // libraryItemId -> its genres, to resolve the club's read books to genre lists.
  const genresById = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const b of qBooks) m.set(b.id, b.genres)
    return m
  }, [qBooks])

  const rec = useMutation({
    mutationFn: () => {
      const candidates: ClubRecCandidate[] = qgLibraryCandidates(qBooks).map((c) => ({
        libraryItemId: c.id,
        title: c.title,
        author: c.author,
        genre: c.genre,
        genres: c.genres,
        hours: c.hours,
      }))
      const historyGenres = books.map((b) => genresById.get(b.libraryItemId) ?? [])
      return recommendClubBook(clubId, candidates, historyGenres)
    },
    onSuccess: (r) => {
      setPicks(r.picks)
      setIntro(r.unavailable ? '' : r.intro)
      setEngine(r.engine)
      setExpanded(true)
    },
  })

  const queueOne = useMutation({
    mutationFn: (libraryItemId: string) => addClubQueue(clubId, libraryItemId),
    onSuccess: (_added, libraryItemId) => {
      // Drop the queued pick from the list so the owner sees what's left.
      setPicks((prev) => prev?.filter((p) => p.libraryItemId !== libraryItemId) ?? null)
      onQueued()
    },
  })

  const setBasis = useMutation({
    mutationFn: (next: ClubRecBasis) => setClubRecBasis(clubId, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: clubsKeys.detail(clubId, '') })
      onBasisChanged()
    },
  })

  return (
    <div className="club-recommend">
      <div className="club-race-head" style={{ cursor: 'pointer' }} onClick={() => setExpanded((v) => !v)}>
        <Icon name="auto_awesome" style={{ fontSize: 15 }} /> Next book
        <Icon
          name={expanded ? 'expand_less' : 'expand_more'}
          style={{ fontSize: 16, marginLeft: 'auto' }}
        />
      </div>

      {wrappingUp && !picks && (
        <div className="banner info" style={{ margin: '6px 0' }}>
          <Icon name="lightbulb" />
          Your club is wrapping up {clubName === 'this club' ? 'this book' : clubName} and has nothing
          queued next. Want a recommendation?
        </div>
      )}

      {(expanded || wrappingUp) && (
        <>
          <div className="club-rec-controls">
            <select
              className="fld"
              value={basis}
              onChange={(e) => setBasis.mutate(e.target.value as ClubRecBasis)}
              disabled={setBasis.isPending}
            >
              {BASIS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              className="btn-sm btn-green"
              disabled={rec.isPending || activeId === null}
              onClick={() => rec.mutate()}
            >
              {rec.isPending ? 'Thinking…' : 'Recommend next book'}
            </button>
          </div>

          {rec.isError && (
            <div className="banner error" style={{ marginTop: 6 }}>
              <Icon name="error" /> Couldn't get a recommendation. Try again.
            </div>
          )}

          {picks && picks.length === 0 && !rec.isPending && (
            <div className="pop-empty" style={{ padding: '12px 0' }}>
              No fitting book left in your library to suggest.
            </div>
          )}

          {intro && <div className="club-rec-intro">{intro}</div>}

          {picks?.map((p) => (
            <div key={p.libraryItemId} className="club-rec-pick">
              <div className="crp-body">
                <div className="crp-title">{p.title || 'Untitled'}</div>
                <div className="crp-author">{p.author}</div>
                {p.reason && <div className="crp-reason">{p.reason}</div>}
              </div>
              <button
                className="btn-sm"
                disabled={queueOne.isPending}
                onClick={() => queueOne.mutate(p.libraryItemId)}
                title="Add to the club's up-next queue"
              >
                <Icon name="playlist_add" /> Queue
              </button>
            </div>
          ))}

          {engine === 'heuristic' && picks && picks.length > 0 && (
            <div className="club-rec-note">Simple genre match (AI is off).</div>
          )}
        </>
      )}
    </div>
  )
}

// Shown when the owner has turned recommendations off: a one-line way back on.
function ClubRecBasisOff({ clubId, onBasisChanged }: { clubId: string; onBasisChanged: () => void }) {
  const setBasis = useMutation({
    mutationFn: () => setClubRecBasis(clubId, 'club-history'),
    onSuccess: onBasisChanged,
  })
  return (
    <div className="club-rec-note" style={{ padding: '4px 12px' }}>
      Next-book recommendations are off.{' '}
      <button className="link-btn" onClick={() => setBasis.mutate()} disabled={setBasis.isPending}>
        Turn on
      </button>
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
