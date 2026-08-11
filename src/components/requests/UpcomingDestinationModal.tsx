import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Modal } from '@/components/common/Modal'
import { Icon } from '@/components/common/Icon'
import { useSettingsStore } from '@/store/settingsStore'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { getSeries } from '@/api/libraries'

export interface UpcomingTarget {
  title: string
  author?: string
  cover?: string
  asin?: string
  /** The series this belongs to, when known - used to offer the local series page. */
  seriesTitle?: string
}

/** Deep links to external book sites. Mirrors the set BookDetailPage offers,
 *  built from the ASIN when we have one and a title+author search otherwise.
 *  Which providers appear is the per-user choice from Settings -> Library. */
function externalLinks(
  item: UpcomingTarget,
  enabled: { goodreads: boolean; audible: boolean; hardcover: boolean },
) {
  const q = encodeURIComponent(`${item.title ?? ''} ${item.author ?? ''}`.trim())
  const links: { key: string; icon: string; label: string; href: string }[] = []
  if (enabled.goodreads) {
    links.push({
      key: 'goodreads',
      icon: 'menu_book',
      label: 'Goodreads',
      href: `https://www.goodreads.com/search?q=${q}`,
    })
  }
  if (enabled.audible) {
    links.push({
      key: 'audible',
      icon: 'headphones',
      label: 'Audible',
      href: item.asin
        ? `https://www.audible.com/pd/${item.asin}`
        : `https://www.audible.com/search?keywords=${q}`,
    })
  }
  if (enabled.hardcover) {
    links.push({
      key: 'hardcover',
      icon: 'auto_stories',
      label: 'Hardcover',
      href: `https://hardcover.app/search?q=${q}`,
    })
  }
  return links
}

/** Find the ABS series whose name matches, so we can link to the local series
 *  page. Null when the library has no such series (a series you follow but own
 *  nothing from), in which case that row is simply not offered. */
function useLocalSeriesId(seriesTitle: string | undefined) {
  const { activeId } = useActiveLibrary()
  return useQuery({
    queryKey: ['series-lookup', activeId, seriesTitle],
    queryFn: async () => {
      // NOT limit=0: ABS treats that as "return nothing" for this endpoint (it
      // still reports the true `total`), which silently found no match and hid
      // the series row entirely. Ask for a page big enough to cover a library.
      const res = await getSeries(activeId as string, 0, 1000)
      const want = (seriesTitle ?? '').trim().toLowerCase()
      return res.results.find((s) => s.name.trim().toLowerCase() === want)?.id ?? null
    },
    enabled: Boolean(activeId) && Boolean(seriesTitle),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

// Where do you want to go? A book that isn't in the library has no page of its
// own here, so rather than guessing (and dead-ending on a route that doesn't
// exist) this asks: the series page you own, or one of the external sites
// you've enabled in Settings.
export function UpcomingDestinationModal({
  item,
  onClose,
}: {
  item: UpcomingTarget
  onClose: () => void
}) {
  const navigate = useNavigate()
  const goodreads = useSettingsStore((s) => s.externalLinkGoodreads)
  const audible = useSettingsStore((s) => s.externalLinkAudible)
  const hardcover = useSettingsStore((s) => s.externalLinkHardcover)
  const { data: seriesId } = useLocalSeriesId(item.seriesTitle)

  const links = externalLinks(item, { goodreads, audible, hardcover })

  return (
    <Modal title="Open in" onClose={onClose}>
      <div className="ud-head">
        {item.cover ? (
          <img className="ud-cover" src={item.cover} alt="" />
        ) : (
          <div className="ud-cover up-cover-ph" />
        )}
        <div className="ud-meta">
          <div className="ud-title">{item.title}</div>
          {item.author && <div className="ud-sub">{item.author}</div>}
          {item.seriesTitle && <div className="ud-series">{item.seriesTitle}</div>}
        </div>
      </div>

      <div className="ud-list">
        {item.asin && (
          <button
            className="ud-row"
            onClick={() => {
              onClose()
              navigate(`/upcoming/${encodeURIComponent(item.asin!)}`)
            }}
          >
            <Icon name="menu_book" />
            <div className="ud-row-meta">
              <b>Book details</b>
              <span>Release date, description, and narrator</span>
            </div>
            <Icon name="chevron_right" />
          </button>
        )}

        {seriesId && (
          <button
            className="ud-row"
            onClick={() => {
              onClose()
              navigate(`/series/${seriesId}`)
            }}
          >
            <Icon name="auto_awesome_motion" />
            <div className="ud-row-meta">
              <b>Series page</b>
              <span>See every book in {item.seriesTitle}</span>
            </div>
            <Icon name="chevron_right" />
          </button>
        )}

        {links.map((l) => (
          <a
            key={l.key}
            className="ud-row"
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
          >
            <Icon name={l.icon} />
            <div className="ud-row-meta">
              <b>{l.label}</b>
              <span>Open in a new tab</span>
            </div>
            <Icon name="open_in_new" />
          </a>
        ))}

        {!item.asin && !seriesId && links.length === 0 && (
          <p className="ud-none">
            No destinations are enabled. Turn on book links in Settings → Library.
          </p>
        )}
      </div>
    </Modal>
  )
}
