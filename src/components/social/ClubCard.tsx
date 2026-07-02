import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getClubs, joinClub, clubsKeys } from '@/api/clubs'
import type { HSClub } from '@hearthshelf/core'
import { usePlayer } from '@/hooks/usePlayer'
import { usePlayerStore } from '@/store/playerStore'
import { Icon } from '@/components/common/Icon'
import { CreateClubModal } from '@/components/social/CreateClubModal'

// The book-club card on the detail page. Shows the caller's clubs whose CURRENT
// book is this item (open the room), open clubs reading this book they can join,
// and a "Start a club" action. Degrades to nothing when clubs are disabled
// (older server / admin kill-switch).
export function ClubCard({
  libraryItemId,
  bookTitle,
  onToast,
}: {
  libraryItemId: string
  bookTitle: string
  onToast: (msg: string) => void
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { playItem } = usePlayer()
  const sessionItemId = usePlayerStore((s) => s.libraryItemId)
  const requestClub = usePlayerStore((s) => s.requestClub)
  const [creating, setCreating] = useState(false)

  const { data } = useQuery({
    queryKey: clubsKeys.forItem(libraryItemId),
    queryFn: () => getClubs(libraryItemId),
    enabled: Boolean(libraryItemId),
    staleTime: 60 * 1000,
  })

  const join = useMutation({
    mutationFn: (clubId: string) => joinClub(clubId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: clubsKeys.forItem(libraryItemId) })
      onToast('Joined the club')
    },
    onError: () => onToast('Could not join the club'),
  })

  if (data && !data.enabled) return null

  // Open a club's room: bring the book to the player (if not already playing),
  // then ask the player to open this club's panel.
  const openRoom = async (clubId: string) => {
    if (sessionItemId !== libraryItemId) {
      await playItem(libraryItemId)
    }
    requestClub(clubId)
    navigate('/player')
  }

  // My clubs whose CURRENT book is this item (so "open room" lands on this book).
  const mineHere = (data?.mine ?? []).filter(
    (c) => c.currentBook?.libraryItemId === libraryItemId,
  )
  const joinable = data?.joinable ?? []
  const hasAny = mineHere.length > 0 || joinable.length > 0

  const clubLine = (club: HSClub, action: React.ReactNode) => (
    <div className="club-row" key={club.id}>
      <span className="club-ico">
        <Icon name="groups" />
      </span>
      <div className="club-meta">
        <div className="club-name">{club.name}</div>
        <div className="club-sub">
          {club.memberCount} {club.memberCount === 1 ? 'member' : 'members'}
        </div>
      </div>
      {action}
    </div>
  )

  return (
    <div className="detail-section club-card">
      <div className="section-head">
        <Icon name="groups" />
        <h2>Book club</h2>
      </div>

      {hasAny ? (
        <div className="club-list">
          {mineHere.map((c) =>
            clubLine(
              c,
              <button className="btn-sm btn-green" onClick={() => void openRoom(c.id)}>
                <Icon name="forum" /> Open room
              </button>,
            ),
          )}
          {joinable.map((c) =>
            clubLine(
              c,
              <button
                className="btn-sm"
                disabled={join.isPending}
                onClick={() => join.mutate(c.id)}
              >
                <Icon name="group_add" /> Join
              </button>,
            ),
          )}
        </div>
      ) : (
        <div className="pop-empty" style={{ padding: '16px 0' }}>
          No clubs are reading this book yet.
        </div>
      )}

      <button className="btn-sm btn-ghost" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
        <Icon name="group_add" /> Start a club with this book
      </button>

      {creating && (
        <CreateClubModal
          libraryItemId={libraryItemId}
          bookTitle={bookTitle}
          onClose={() => setCreating(false)}
          onCreated={(club) => onToast(`Created "${club.name}"`)}
        />
      )}
    </div>
  )
}
