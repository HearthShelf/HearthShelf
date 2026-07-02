import { useMemo } from 'react'
import { clusterTimelineMarkers } from '@hearthshelf/core'
import type { HSNote, HSNoteStub, TimelineMarker } from '@hearthshelf/core'
import { Avatar } from '@/components/common/Avatar'

// Overlay of note markers on the player seek bar. Unlocked notes (passed)
// render as small avatar dots at timeSec/duration; locked stubs (ahead) render
// as thin anonymous ticks - no avatar, since author identity ahead of you is
// withheld. Clicking a passed marker opens the notes pop scrolled to it;
// clicking an ahead tick shows a teaser toast. The overlay is absolutely
// positioned across the rail with pointer-events:none, so only the marker
// elements are clickable and the seek bar underneath keeps working.
export function TimelineMarkers({
  notes,
  stubs,
  duration,
  onOpenNote,
  onTease,
}: {
  notes: HSNote[]
  stubs: HSNoteStub[]
  duration: number
  // Open the notes pop scrolled to a note (a passed marker click).
  onOpenNote: (noteId: string) => void
  // Show a teaser for an ahead note at a timestamp (a locked tick click).
  onTease: (timeSec: number) => void
}) {
  const markers = useMemo<TimelineMarker[]>(() => {
    if (duration <= 0) return []
    const items = [
      ...notes
        .filter((n) => n.timeSec != null)
        .map((n) => ({
          id: n.id,
          timeSec: n.timeSec as number,
          kind: 'note' as const,
          userId: n.userId,
          username: n.username,
        })),
      ...stubs.map((s) => ({ id: s.id, timeSec: s.timeSec, kind: 'stub' as const })),
    ]
    return clusterTimelineMarkers(items, duration)
  }, [notes, stubs, duration])

  if (markers.length === 0) return null

  return (
    <div className="tl-markers" aria-hidden="false">
      {markers.map((m, i) => {
        const left = `${m.fraction * 100}%`
        // A cluster with any unlocked note is clickable-to-open; a pure stub
        // cluster only teases.
        const firstNote = m.items.find((it) => it.kind === 'note')
        const firstTs = m.items[0]?.timeSec ?? 0
        if (firstNote) {
          return (
            <button
              key={`${firstNote.id}-${i}`}
              className={'tl-marker tl-note' + (m.kind === 'mixed' ? ' tl-mixed' : '')}
              style={{ left }}
              title="Open note"
              onClick={() => onOpenNote(firstNote.id)}
            >
              <Avatar
                userId={firstNote.userId ?? ''}
                name={firstNote.username ?? '?'}
                size={16}
              />
              {m.count > 1 && <span className="tl-count">{m.count}</span>}
            </button>
          )
        }
        return (
          <button
            key={`stub-${i}`}
            className="tl-marker tl-stub"
            style={{ left }}
            title="A note awaits here"
            onClick={() => onTease(firstTs)}
          >
            {m.count > 1 && <span className="tl-count">{m.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
