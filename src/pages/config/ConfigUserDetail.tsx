import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getUsers, adminKeys } from '@/api/admin'
import { fmtSessDate } from '@/lib/format'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'

export function ConfigUserDetail({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: adminKeys.users,
    queryFn: getUsers,
    staleTime: 60 * 1000,
  })

  const user = data?.users.find((u) => u.id === userId)

  if (isLoading) {
    return <LoadingSpinner className="py-12" label="Loading user..." />
  }
  if (!user) {
    return (
      <div className="empty-state">
        <Icon name="person_off" />
        <h3>User not found</h3>
      </div>
    )
  }

  const perms = Object.entries(user.permissions ?? {}).filter(([, v]) => v)
  const seen = user.lastSeen ? fmtSessDate(user.lastSeen) : null

  return (
    <>
      <div className="crumb">
        <Link className="lnk" to="/config/users">
          Users
        </Link>
        <Icon name="chevron_right" />
        {user.username}
      </div>

      <div className="page-head">
        <div className="eyebrow">Admin · User</div>
        <h1 className="title-xl">{user.username}</h1>
      </div>

      <div className="cfg-card">
        {(
          [
            ['badge', 'Type', user.type],
            ['email', 'Email', user.email ?? '—'],
            ['toggle_on', 'Status', user.isActive ? 'Active' : 'Disabled'],
            ['lock', 'Locked', user.isLocked ? 'Yes' : 'No'],
            [
              'schedule',
              'Last seen',
              seen ? `${seen.day} · ${seen.time}` : 'never',
            ],
            ['calendar_today', 'Created', fmtSessDate(user.createdAt).day],
          ] as [string, string, string][]
        ).map(([icon, label, value]) => (
          <div className="cfg-line" key={label}>
            <Icon name={icon} style={{ color: 'var(--text-muted)' }} />
            <div className="cl-meta">
              <div className="cl-t">{label}</div>
            </div>
            <span style={{ color: 'var(--text-muted)' }}>{value}</span>
          </div>
        ))}
      </div>

      {perms.length > 0 && (
        <>
          <div className="section-head">
            <Icon name="key" />
            <h2>Permissions</h2>
          </div>
          <div className="meta-chips">
            {perms.map(([k]) => (
              <span className="chip" key={k}>
                <Icon name="check" /> {k.replace(/^can/, '')}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  )
}
