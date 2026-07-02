import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { useAuthStore } from '@/store/authStore'
import { useSettingsStore } from '@/store/settingsStore'
import { getClubs, getClub } from '@/api/clubs'
import { detectNotePops } from '@hearthshelf/core'
import type { HSNote, HSNoteStub } from '@hearthshelf/core'
import { Avatar } from '@/components/common/Avatar'
import { Icon } from '@/components/common/Icon'

const SEEN_CAP = 500
const SEEN_PREFIX = 'hearthshelf:notePops:'

// Device-local pop dedupe: seen stub ids per club, capped, in localStorage.
function loadSeen(clubId: string): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_PREFIX + clubId)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function saveSeen(clubId: string, ids: string[]) {
  try {
    // Keep the most recent SEEN_CAP ids (ids are appended in crossing order).
    const capped = ids.slice(-SEEN_CAP)
    localStorage.setItem(SEEN_PREFIX + clubId, JSON.stringify(capped))
  } catch {
    // Storage full / disabled - re-pop after clear is accepted (v1).
  }
}

interface PopToast {
  clubId: string
  note?: HSNote
  passedCount?: number
}

// Watches the playing book's club stubs and pops a toast when playback crosses
// one, deep-linking into the club panel. Mounted once in AppShell beside
// useSettingsSync/useQueueSync. It subscribes to the player store coarsely (a
// transient subscription that reads position without re-rendering on every
// tick), so it never forces per-frame renders. Only the currently playing
// book's active club is watched; the notePops setting silences it.
export function NotePopWatcher() {
  const token = useAuthStore((s) => s.token)
  const requestClub = usePlayerStore((s) => s.requestClub)
  const [toast, setToast] = useState<PopToast | null>(null)

  // The active club (mine, whose current book is the playing item) + its stubs.
  const clubRef = useRef<string | null>(null)
  const stubsRef = useRef<HSNoteStub[]>([])
  const seenRef = useRef<Set<string>>(new Set())
  const seenOrderRef = useRef<string[]>([])
  const lastPosRef = useRef(0)

  // Resolve which club (if any) governs the currently playing book, and load its
  // locked stubs. Re-runs whenever the playing item changes.
  const playingItemId = usePlayerStore((s) => s.libraryItemId)
  useEffect(() => {
    let cancelled = false
    clubRef.current = null
    stubsRef.current = []
    if (!token || !playingItemId) return
    void (async () => {
      const clubs = await getClubs(playingItemId)
      if (cancelled || !clubs.enabled) return
      const active = clubs.mine.find((c) => c.currentBook?.libraryItemId === playingItemId)
      if (!active) return
      clubRef.current = active.id
      seenRef.current = loadSeen(active.id)
      seenOrderRef.current = [...seenRef.current]
      const detail = await getClub({ clubId: active.id, position: usePlayerStore.getState().currentTime })
      if (cancelled) return
      stubsRef.current = detail.notes.locked
    })()
    return () => {
      cancelled = true
    }
  }, [token, playingItemId])

  // Refresh stubs on the club poll cadence (30s) so newly added ahead-notes get
  // ticks/pops without reopening the book.
  useEffect(() => {
    if (!token) return
    const id = window.setInterval(() => {
      const clubId = clubRef.current
      if (!clubId) return
      void getClub({ clubId, position: usePlayerStore.getState().currentTime }).then((d) => {
        if (clubRef.current === clubId) stubsRef.current = d.notes.locked
      })
    }, 30 * 1000)
    return () => window.clearInterval(id)
  }, [token])

  // Coarse position subscription: fires on every setCurrentTime, but only does
  // work (and never sets React state on the hot path unless a crossing occurs).
  useEffect(() => {
    lastPosRef.current = usePlayerStore.getState().currentTime
    const unsub = usePlayerStore.subscribe((state) => {
      const clubId = clubRef.current
      if (!clubId) {
        lastPosRef.current = state.currentTime
        return
      }
      // Respect the notePops device setting (read fresh - it's not on this hook's
      // dependency list).
      if (!useSettingsStore.getState().notePops) {
        lastPosRef.current = state.currentTime
        return
      }
      const prev = lastPosRef.current
      const next = state.currentTime
      if (next === prev) return
      const { pops, seeked } = detectNotePops(prev, next, stubsRef.current, seenRef.current)
      lastPosRef.current = next
      if (pops.length === 0) return

      // Mark all crossed stubs seen (dedupe), persist capped.
      for (const p of pops) {
        if (!seenRef.current.has(p.id)) {
          seenRef.current.add(p.id)
          seenOrderRef.current.push(p.id)
        }
      }
      saveSeen(clubId, seenOrderRef.current)

      if (seeked) {
        // A scrub crossed several at once - one summary toast, no flood.
        setToast({ clubId, passedCount: pops.length })
        return
      }
      // A single natural crossing: fetch the now-unlocked note and toast it.
      void getClub({ clubId, position: next }).then((detail) => {
        const note = detail.notes.notes.find((n) => pops.some((p) => p.id === n.id))
        setToast({ clubId, note, passedCount: note ? undefined : pops.length })
      })
    })
    return () => unsub()
  }, [])

  // Auto-dismiss.
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 6000)
    return () => window.clearTimeout(id)
  }, [toast])

  if (!toast) return null

  const openClub = () => {
    requestClub(toast.clubId)
    setToast(null)
  }

  return (
    <button className="note-pop-toast" onClick={openClub}>
      {toast.note ? (
        <>
          <Avatar userId={toast.note.userId} name={toast.note.username} size={30} />
          <div className="npt-body">
            <div className="npt-author">{toast.note.username} left a note</div>
            <div className="npt-text">{toast.note.body}</div>
          </div>
        </>
      ) : (
        <>
          <span className="npt-ico">
            <Icon name="forum" fill />
          </span>
          <div className="npt-body">
            <div className="npt-author">
              Passed {toast.passedCount} {toast.passedCount === 1 ? 'note' : 'notes'}
            </div>
            <div className="npt-text">Tap to open the club chat</div>
          </div>
        </>
      )}
      <Icon name="chevron_right" className="npt-go" />
    </button>
  )
}
