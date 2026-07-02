import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getAllLibraryItems, libraryKeys } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { useQuestGiverEnabled } from '@/hooks/useQuestGiver'
import {
  useMonthlyShelf,
  useDiscoverFeedbackQuery,
  useSetDiscoverFeedback,
  usePopular,
} from '@/hooks/useDiscover'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { SectionHead } from '@/components/common/SectionHead'
import { BookTile } from '@/components/library/BookTile'
import { QuestGiverEntry } from '@/components/questgiver/QuestGiverEntry'
import { DiscoverAiTile } from '@/components/discover/DiscoverAiTile'
import { DiscoverSearch } from '@/components/discover/DiscoverSearch'
import { buildDiscoverShelves, rankDiscoverShelves } from '@/lib/discover'
import { useQuestGiverPicks } from '@/hooks/useQuestGiverPicks'

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
  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items])
  const ownedKeys = useMemo(
    () =>
      new Set(
        items.map((it) => {
          const m = it.media.metadata
          return ((m.title ?? '') + '|' + (m.authorName ?? '')).toLowerCase()
        }),
      ),
    [items],
  )
  const { shelves: baseShelves, profile } = useMemo(
    () => buildDiscoverShelves(items, progressById),
    [items, progressById],
  )

  const hasItems = items.length > 0
  const { data: monthly } = useMonthlyShelf(items, progressById, hasItems)
  const { data: feedback } = useDiscoverFeedbackQuery(hasItems)
  const { data: popular } = usePopular(hasItems)
  const questGiverPicks = useQuestGiverPicks(hasItems)
  const setFeedback = useSetDiscoverFeedback()

  const fbMap = useMemo(() => feedback ?? {}, [feedback])

  // Apply the shared ranking layer: QuestGiver picks lead, liked/rated items float
  // up, disliked/not-interested items drop out - same order Home previews.
  const shelves = useMemo(
    () => rankDiscoverShelves(baseShelves, byId, { questGiverPicks, feedback: fbMap }),
    [baseShelves, byId, questGiverPicks, fbMap],
  )

  // AI-shelf picks resolved to owned items, with not_interested hidden.
  const aiPicks = useMemo(() => {
    if (!monthly || monthly.engine === 'none') return []
    return monthly.picks
      .map((p) => ({ item: byId.get(p.id), reason: p.reason }))
      .filter((x) => x.item && fbMap[x.item.id]?.vote !== 'not_interested') as {
      item: NonNullable<ReturnType<typeof byId.get>>
      reason: string
    }[]
  }, [monthly, byId, fbMap])

  // Popular-on-this-server resolved to owned, unstarted-or-any items.
  const popularItems = useMemo(() => {
    if (!popular?.length) return []
    return popular
      .map((p) => byId.get(p.itemId))
      .filter((it): it is NonNullable<typeof it> => Boolean(it))
      .slice(0, 18)
  }, [popular, byId])

  if (isLoading) return <LoadingSpinner />

  const onVote = (itemKey: string, vote: 'like' | 'dislike' | 'not_interested' | null) =>
    setFeedback.mutate({ itemKey, vote })
  const onRate = (itemKey: string, rating: number | null) => setFeedback.mutate({ itemKey, rating })
  const onNotInterested = (itemKey: string) =>
    setFeedback.mutate({ itemKey, vote: 'not_interested' })

  return (
    <div className="page fade-in discover-page">
      <div className="page-head">
        <div className="eyebrow">HearthShelf</div>
        <h1 className="title-xl">Discover</h1>
        <p className="page-sub">
          Search Audible for any title, or scroll for picks tuned to your listening.
        </p>
      </div>

      <DiscoverSearch ownedKeys={ownedKeys} />

      {qgEnabled && <QuestGiverEntry totalFinished={profile.totalFin} />}

      {!hasItems ? (
        <div className="empty-state">
          <Icon name="explore" />
          <h3>Nothing to discover yet</h3>
          <p>Add books to your library and they'll start showing up here.</p>
        </div>
      ) : (
        <>
          {aiPicks.length > 0 && (
            <div className="section">
              <SectionHead
                icon="auto_awesome"
                title={monthly?.intro?.trim() ? monthly.intro : 'Your shelf this month'}
              />
              <div className="disc-ai-row">
                {aiPicks.map(({ item, reason }) => {
                  const p = progressById.get(item.id)
                  return (
                    <DiscoverAiTile
                      key={item.id}
                      item={item}
                      reason={reason}
                      progress={p?.progress ?? 0}
                      finished={p?.isFinished}
                      feedback={fbMap[item.id]}
                      onVote={onVote}
                      onRate={onRate}
                      onNotInterested={onNotInterested}
                    />
                  )
                })}
              </div>
            </div>
          )}

          {shelves.map((shelf) => (
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
          ))}

          {popularItems.length > 0 && (
            <div className="section">
              <SectionHead icon="trending_up" title="Popular on your server" />
              <div className="shelf-row">
                {popularItems.map((item) => {
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
          )}
        </>
      )}
    </div>
  )
}
