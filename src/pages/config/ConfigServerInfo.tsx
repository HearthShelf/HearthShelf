import { useQuery } from '@tanstack/react-query'
import { absRequest } from '@/api/client'
import type { ABSStatusResponse } from '@/api/types'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'

export function ConfigServerInfo() {
  const { data } = useQuery({
    queryKey: ['server-status'],
    queryFn: () => absRequest<ABSStatusResponse>('/status'),
    staleTime: 5 * 60 * 1000,
  })

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Settings</h1>
      </div>

      {!data ? (
        <LoadingSpinner className="py-12" label="Loading server info..." />
      ) : (
        <div className="cfg-card">
          {(
            [
              ['dns', 'Server', data.app ?? 'audiobookshelf', false],
              ['info', 'Version', data.serverVersion ?? '—', true],
              ['language', 'Language', data.language ?? '—', false],
              [
                'lock',
                'Auth methods',
                (data.authMethods ?? []).join(', ') || '—',
                false,
              ],
            ] as [string, string, string, boolean][]
          ).map(([icon, label, value, mono]) => (
            <div className="cfg-line" key={label}>
              <Icon name={icon} style={{ color: 'var(--text-muted)' }} />
              <div className="cl-meta">
                <div className="cl-t">{label}</div>
              </div>
              <span
                style={{
                  color: 'var(--text-muted)',
                  fontFamily: mono ? 'var(--font-mono)' : undefined,
                }}
              >
                {value}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
