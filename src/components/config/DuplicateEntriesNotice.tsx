import { useState } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { getAllLibraryItems, libraryKeys } from '@/api/libraries'
import { getMe, meKeys } from '@/api/me'
import type { ABSLibrary } from '@/api/types'
import { useDuplicatesStore } from '@/store/duplicatesStore'
import { cleanUpDuplicates, type DuplicateCleanupResult } from '@/lib/duplicates'
import { Icon } from '@/components/common/Icon'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'

// "Duplicate entries found" for admins: books the server lists twice for one
// folder. Clean up moves listening places to the copy that stays, then removes
// the extra entries from the server's list. Files are never touched.
export function DuplicateEntriesNotice({ libraries }: { libraries: ABSLibrary[] }) {
  const qc = useQueryClient()
  const { data: me } = useQuery({ queryKey: meKeys.me, queryFn: getMe, staleTime: 60 * 1000 })
  const isAdmin = me?.type === 'admin' || me?.type === 'root'
  const canClean = isAdmin && me?.permissions?.delete === true

  const bookLibraries = libraries.filter((l) => l.mediaType !== 'podcast')
  // Shares the cache with the Library page; loading it records the groups.
  const lists = useQueries({
    queries: bookLibraries.map((l) => ({
      queryKey: libraryKeys.allItems(l.id),
      queryFn: () => getAllLibraryItems(l.id),
      staleTime: 5 * 60 * 1000,
      enabled: isAdmin,
    })),
  })
  const groupsByLibrary = useDuplicatesStore((s) => s.groupsByLibrary)
  const groups = bookLibraries.flatMap((l) => groupsByLibrary[l.id] ?? [])
  const extra = groups.reduce((n, g) => n + g.duplicates.length, 0)

  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DuplicateCleanupResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!isAdmin) return null
  if (!extra && !result) return null

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      // Work from a fresh list, never from what was on screen.
      await Promise.all(lists.map((q) => q.refetch()))
      const fresh = bookLibraries.flatMap(
        (l) => useDuplicatesStore.getState().groupsByLibrary[l.id] ?? [],
      )
      const res = await cleanUpDuplicates(fresh)
      setResult(res)
      await Promise.all([
        ...bookLibraries.map((l) => qc.invalidateQueries({ queryKey: libraryKeys.allItems(l.id) })),
        qc.invalidateQueries({ queryKey: meKeys.me }),
        qc.invalidateQueries({ queryKey: meKeys.itemsInProgress }),
        qc.invalidateQueries({ queryKey: ['personalized'] }),
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clean up did not finish.')
    } finally {
      setBusy(false)
    }
  }

  const titleOf = (id: string) => {
    for (const g of groups) {
      if (g.keeper.id === id || g.duplicates.some((d) => d.id === id)) {
        return g.keeper.media?.metadata?.title ?? 'A book'
      }
    }
    return 'A book'
  }

  return (
    <div className="cfg-card" style={{ marginBottom: 'var(--s4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="content_copy" style={{ color: 'var(--accent)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            {extra
              ? `Duplicate entries found: ${groups.length} ${groups.length === 1 ? 'book is' : 'books are'} listed more than once`
              : 'Duplicate entries cleaned up'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
            Your server added the same folder twice. HearthShelf already shows each book once. Clean
            up moves everyone's place to the copy that stays and removes the extra entries. Your
            files are not touched.
          </div>
        </div>
        {extra > 0 && canClean && (
          <button
            className="btn-sm btn-primary"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            <Icon name={busy ? 'hourglass_empty' : 'auto_fix_high'} />{' '}
            {busy ? 'Cleaning up...' : 'Clean up'}
          </button>
        )}
      </div>

      {extra > 0 && !canClean && (
        <div className="be-warn">
          <Icon name="info" /> Your account is not allowed to delete items, so it can't clean these
          up.
        </div>
      )}

      {extra > 0 && (
        <ul style={{ margin: '10px 0 0 34px', fontSize: 13, color: 'var(--text-muted)' }}>
          {groups.slice(0, 8).map((g) => (
            <li key={g.keeper.id}>
              {g.keeper.media?.metadata?.title ?? 'Untitled'}
              {g.keeper.media?.metadata?.authorName
                ? ` - ${g.keeper.media.metadata.authorName}`
                : ''}
              {g.duplicates.length > 1 ? ` (${g.duplicates.length + 1} entries)` : ''}
            </li>
          ))}
          {groups.length > 8 && <li>and {groups.length - 8} more</li>}
        </ul>
      )}

      {result && (
        <div style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
          {result.removed.length > 0 && (
            <div>
              Removed {result.removed.length} extra{' '}
              {result.removed.length === 1 ? 'entry' : 'entries'}.
            </div>
          )}
          {result.kept.some((k) => k.reason === 'other-listener-progress') && (
            <div className="be-warn">
              <Icon name="info" />
              <span>
                Kept{' '}
                {result.kept
                  .filter((k) => k.reason === 'other-listener-progress')
                  .map((k) => titleOf(k.id))
                  .join(', ')}{' '}
                for now: another listener's place is saved only on the extra entry. It moves over
                the next time they open HearthShelf. Then clean up again.
              </span>
            </div>
          )}
          {result.failed.length > 0 && (
            <div className="be-warn">
              <Icon name="warning" /> {result.failed.length} could not be removed. Try again in a
              moment.
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="be-warn">
          <Icon name="warning" /> {error}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Clean up duplicate entries?"
          message="Each book keeps one entry. Listening places and bookmarks move to the entry that stays first. Only the extra entries are removed from the server's list - your files stay where they are."
          confirmLabel="Clean up"
          onConfirm={() => void run()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
