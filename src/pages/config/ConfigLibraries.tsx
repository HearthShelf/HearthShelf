import { useQuery } from '@tanstack/react-query'
import { getLibraries, libraryKeys } from '@/api/libraries'
import { libraryIcon } from '@/hooks/useActiveLibrary'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'

export function ConfigLibraries() {
  const { data, isLoading } = useQuery({
    queryKey: libraryKeys.all,
    queryFn: getLibraries,
    staleTime: 5 * 60 * 1000,
  })

  const libraries = data?.libraries ?? []

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Libraries</h1>
      </div>

      {isLoading ? (
        <LoadingSpinner className="py-12" label="Loading libraries..." />
      ) : (
        <div className="cfg-card">
          {libraries.map((l) => (
            <div className="cfg-line" key={l.id}>
              <span
                className="lib-ico"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  display: 'grid',
                  placeItems: 'center',
                  background: 'color-mix(in oklab, var(--accent) 16%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <Icon name={libraryIcon(l)} fill />
              </span>
              <div className="cl-meta">
                <div className="cl-t">{l.name}</div>
                <div className="cl-d">
                  {l.mediaType === 'podcast' ? 'Podcasts' : 'Audiobooks'}
                </div>
              </div>
              <span style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
                {l.mediaType}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
