import { Icon } from '@/components/common/Icon'

interface WatchToggleProps {
  on: boolean
  busy?: boolean
  onToggle: () => void
}

// Watch an author or series so ReadMeABook auto-requests new releases.
export function WatchToggle({ on, busy, onToggle }: WatchToggleProps) {
  return (
    <button
      className={'watch-toggle' + (on ? ' on' : '')}
      onClick={onToggle}
      disabled={busy}
      title="We'll request new releases automatically"
    >
      <Icon name={on ? 'notifications_active' : 'notification_add'} fill={on} />{' '}
      {on ? 'Watching' : 'Watch'}
    </button>
  )
}
