import { Icon } from '@/components/common/Icon'

const TITLES: Record<string, { title: string; note: string }> = {
  integrations: {
    title: 'Integrations',
    note: 'External link providers and acquisition integrations live here.',
  },
  logs: {
    title: 'Logs',
    note: 'Server log streaming is not exposed by this AudiobookShelf version.',
  },
  notifications: {
    title: 'Notifications',
    note: 'Notification rules configuration is coming in a later pass.',
  },
  email: {
    title: 'Email',
    note: 'SMTP / email settings configuration is coming in a later pass.',
  },
  meta: {
    title: 'Metadata Utils',
    note: 'Genre and tag management tools are coming in a later pass.',
  },
  rss: {
    title: 'RSS Feeds',
    note: 'RSS feed management is coming in a later pass.',
  },
  auth: {
    title: 'Authentication',
    note: 'Auth / OIDC provider configuration is coming in a later pass.',
  },
  serverstats: {
    title: 'Server Stats',
    note: 'Server-wide aggregate stats need cross-user aggregation, coming later.',
  },
  libstats: {
    title: 'Library Stats',
    note: 'Library aggregate stats are coming in a later pass.',
  },
  mystats: {
    title: 'Your Stats',
    note: 'Your personal stats live on the main Stats page.',
  },
}

export function ConfigStub({ section }: { section: string }) {
  const info = TITLES[section] ?? {
    title: 'Coming soon',
    note: 'This admin section is still being built.',
  }
  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">{info.title}</h1>
      </div>
      <div className="empty-state">
        <Icon name="construction" />
        <h3>Not available yet</h3>
        <p>{info.note}</p>
      </div>
    </>
  )
}
