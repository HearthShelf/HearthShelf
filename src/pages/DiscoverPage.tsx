import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getAllLibraryItems, libraryKeys } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { useQuestGiverEnabled } from '@/hooks/useQuestGiver'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { SectionHead } from '@/components/common/SectionHead'
import { BookTile } from '@/components/library/BookTile'
import { QuestGiverEntry } from '@/components/questgiver/QuestGiverEntry'
import { buildDiscoverShelves } from '@/lib/discover'

export function DiscoverPage() {
  const { activeId } = useActiveLibrary()
  const progressById = useMediaProgress()
  const qgEnabled = useQuestGiverEnabled()

  const { data, isLoading } = useQuery({
    queryKey: libraryKeys.allItems(activeId ?? ''),
    queryFn: () => getAllLibraryItems(activeId as string),
    enabled: activeId !== null,
  })

  const items = useMemo(() => data?.results ?? [], [data])
  const { shelves, profile } = useMemo(
    () => buildDiscoverShelves(items, progressById),
    [items, progressById]
  )

  if (isLoading) return <LoadingSpinner />

  return (
    <div className="page fade-in discover-page">
      <div className="page-head">
        <div className="eyebrow">HearthShelf</div>
        <h1 className="title-xl">Discover</h1>
        <p className="page-sub">More from your shelf, picked from what you actually listen to.</p>
      </div>

      {qgEnabled && <QuestGiverEntry totalFinished={profile.totalFin} />}

      {items.length === 0 ? (
        <div className="empty-state">
          <Icon name="explore" />
          <h3>Nothing to discover yet</h3>
          <p>Add books to your library and they'll start showing up here.</p>
        </div>
      ) : (
        shelves.map((shelf) => (
          <div className="section" key={shelf.id}>
            <SectionHead icon={shelf.icon} title={shelf.label} />
            <div className="shelf-row">
              {shelf.items.map((item) => {
                const p = progressById.get(item.id)
                return (
                  <BookTile
                    key={item.id}
                    item={item}
                    progress={p?.progress ?? 0}
                    finished={p?.isFinished}
                  />
                )
              })}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
