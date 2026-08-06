/**
 * Active book clubs on Home. Shows the clubs the reader is in as a compact row.
 * Renders nothing when the reader has no clubs or the server has clubs turned
 * off - so it's safe to always mount.
 *
 * A club room lives in the player's club panel (it needs playing position +
 * chapters for note timestamps), so a tile requests the club through the player
 * store and then navigates there, the same handoff the notes pop uses.
 */
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { getClubs, clubsKeys } from '@/api/clubs'
import { usePlayerStore } from '@/store/playerStore'
import { Cover } from '@/components/common/Cover'
import { SectionHead } from '@/components/common/SectionHead'

export function HomeClubShelf() {
  const navigate = useNavigate()
  const requestClub = usePlayerStore((s) => s.requestClub)

  const { data } = useQuery({
    // Item '' = my clubs only.
    queryKey: clubsKeys.forItem(''),
    queryFn: () => getClubs(),
    staleTime: 5 * 60 * 1000,
  })

  const clubs = data?.enabled ? data.mine : []
  if (clubs.length === 0) return null

  const open = (clubId: string) => {
    requestClub(clubId)
    navigate('/player')
  }

  return (
    <div className="section">
      <SectionHead icon="groups" title="Your book clubs" />
      <div className="shelf-row">
        {clubs.map((c) => (
          <button key={c.id} type="button" className="club-tile" onClick={() => open(c.id)}>
            <Cover
              itemId={c.currentBook?.libraryItemId ?? ''}
              title={c.currentBook?.title ?? c.name}
              fs={11}
              style={{ width: '100%', aspectRatio: '1', borderRadius: 12 }}
            />
            <div className="club-tile-n">{c.name}</div>
            <div className="club-tile-b">{c.currentBook?.title || 'No current book'}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
