import {
  ABS_ENDPOINTS,
  planDuplicateCarryOver,
  planDuplicateCleanup,
  resolveKeeperId,
  type DuplicateCleanupPlan,
  type ListenerProgress,
  type ABSBookmark,
  type ABSMediaProgress,
  type DuplicateCandidate,
  type DuplicateGroup,
  type DuplicateIndex,
  type ProgressCarryPatch,
} from '@hearthshelf/core'
import { absRequest } from '@/api/client'
import { getMe } from '@/api/me'
import { getUsers } from '@/api/admin'
import { getDuplicateIndex, useDuplicatesStore } from '@/store/duplicatesStore'

// App side of duplicate library items (one folder ABS recorded twice). The
// decisions are @hearthshelf/core lib/duplicates.ts; this file only does the
// requests.

/** The item to open/play instead of `itemId` (itself unless it is a duplicate). */
export function resolveItemId(itemId: string): string {
  return resolveKeeperId(getDuplicateIndex(), itemId)
}

/**
 * Groups for carry-over. Prefers the full groups the library list found; falls
 * back to the persisted index (ids only - enough for carry-over, which only
 * compares ids) so a cold start can still move a place before the list loads.
 */
export function knownDuplicateGroups(): DuplicateGroup<DuplicateCandidate>[] {
  const { groupsByLibrary, indexByLibrary } = useDuplicatesStore.getState()
  const groups: DuplicateGroup<DuplicateCandidate>[] = []
  const covered = new Set<string>()
  for (const list of Object.values(groupsByLibrary)) {
    for (const group of list) {
      groups.push(group)
      for (const dup of group.duplicates) covered.add(dup.id)
    }
  }
  for (const [libraryId, index] of Object.entries(indexByLibrary)) {
    for (const group of groupsFromIndex(libraryId, index)) {
      const missing = group.duplicates.filter((d) => !covered.has(d.id))
      if (missing.length) groups.push({ ...group, duplicates: missing })
    }
  }
  return groups
}

function groupsFromIndex(
  libraryId: string,
  index: DuplicateIndex,
): DuplicateGroup<DuplicateCandidate>[] {
  const byKeeper = new Map<string, DuplicateCandidate[]>()
  for (const dupId of Object.keys(index)) {
    const keeperId = resolveKeeperId(index, dupId)
    if (keeperId === dupId) continue
    const list = byKeeper.get(keeperId) ?? []
    list.push({ id: dupId, libraryId })
    byKeeper.set(keeperId, list)
  }
  return [...byKeeper.entries()].map(([keeperId, duplicates]) => ({
    keeper: { id: keeperId, libraryId },
    duplicates,
    match: 'path' as const,
  }))
}

function writeProgress(keeperId: string, patch: ProgressCarryPatch): Promise<void> {
  return absRequest<void>(ABS_ENDPOINTS.meProgressUpdate(keeperId), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

function writeBookmark(keeperId: string, time: number, title: string): Promise<void> {
  return absRequest<void>(ABS_ENDPOINTS.meItemBookmark(keeperId), {
    method: 'POST',
    body: JSON.stringify({ time, title }),
  })
}

// Plans already sent this page load, so a stale /api/me between the write and
// its refetch cannot send the same copy twice. Keyed by what was copied, so a
// newer place on the duplicate (an old tab still playing it) is copied again.
const sent = new Set<string>()

/**
 * Move the signed-in user's place and bookmarks from duplicates onto their
 * keepers. Never overwrites newer progress on the keeper (core
 * planProgressCarryOver). Returns how many writes were made.
 */
export async function carryOverDuplicates(
  groups: readonly DuplicateGroup<DuplicateCandidate>[],
  me: { mediaProgress: readonly ABSMediaProgress[]; bookmarks?: readonly ABSBookmark[] },
): Promise<number> {
  let writes = 0
  for (const group of groups) {
    const plan = planDuplicateCarryOver(group, me.mediaProgress, me.bookmarks ?? [])
    if (plan.progress) {
      const key = `p:${plan.keeperId}:${plan.progress.fromItemId}:${plan.progress.patch.lastUpdate ?? ''}:${plan.progress.patch.currentTime}`
      if (!sent.has(key)) {
        sent.add(key)
        try {
          await writeProgress(plan.keeperId, plan.progress.patch)
          writes++
        } catch {
          sent.delete(key)
        }
      }
    }
    for (const bookmark of plan.bookmarks) {
      const key = `b:${plan.keeperId}:${Math.round(bookmark.time)}`
      if (sent.has(key)) continue
      sent.add(key)
      try {
        await writeBookmark(plan.keeperId, bookmark.time, bookmark.title)
        writes++
      } catch {
        sent.delete(key)
      }
    }
  }
  return writes
}

// --- Admin cleanup ---------------------------------------------------------

/**
 * Remove ONE duplicate entry's database record. The files stay on disk.
 *
 * NEVER add ?hard=1 here (and never route this through removeLibraryItem's
 * deleteFiles): a duplicate points at the very same folder as the copy being
 * kept, so a hard delete would erase the real book's files.
 */
function removeDuplicateEntry(itemId: string): Promise<void> {
  return absRequest<void>(ABS_ENDPOINTS.itemDelete(itemId), { method: 'DELETE' })
}

function getListenerProgress(userId: string): Promise<ListenerProgress> {
  return absRequest<{ id: string; mediaProgress?: ABSMediaProgress[] }>(
    ABS_ENDPOINTS.user(userId),
  ).then((user) => ({ userId: user.id ?? userId, progress: user.mediaProgress ?? [] }))
}

export interface DuplicateCleanupResult {
  removed: string[]
  failed: string[]
  kept: DuplicateCleanupPlan['keep']
}

/**
 * Admin "Clean up": move the admin's own place first, then read every
 * listener's progress, and remove only the copies nobody would lose a place
 * on (core planDuplicateCleanup). Copies holding someone else's newer place are
 * kept; that listener's own HearthShelf moves it the next time they open it.
 */
export async function cleanUpDuplicates(
  groups: readonly DuplicateGroup<DuplicateCandidate>[],
): Promise<DuplicateCleanupResult> {
  await carryOverDuplicates(groups, await getMe())
  const { users } = await getUsers()
  // Sequential on purpose: households are small and this keeps ABS unhurried.
  const listeners: ListenerProgress[] = []
  for (const user of users) listeners.push(await getListenerProgress(user.id))
  const plan = planDuplicateCleanup(groups, listeners)
  const removed: string[] = []
  const failed: string[] = []
  for (const id of plan.remove) {
    try {
      await removeDuplicateEntry(id)
      removed.push(id)
    } catch {
      failed.push(id)
    }
  }
  return { removed, failed, kept: plan.keep }
}
