import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { respondToClubInvite } from '@/api/clubs'
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type HSNotification,
} from '@/api/notifications'
import { Icon } from '@/components/common/Icon'

const QUERY_KEY = ['notifications'] as const

function stringData(notification: HSNotification, key: string): string {
  const value = notification.data[key]
  return typeof value === 'string' ? value : ''
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function NotificationBell() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getNotifications,
    staleTime: 15_000,
    refetchInterval: 30_000,
  })

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const refresh = () => qc.invalidateQueries({ queryKey: QUERY_KEY })
  const respond = useMutation({
    mutationFn: ({ notification, accept }: { notification: HSNotification; accept: boolean }) =>
      respondToClubInvite(
        stringData(notification, 'clubId'),
        stringData(notification, 'inviteId') || notification.entityId,
        accept,
      ),
    onSuccess: refresh,
  })
  const markAll = useMutation({ mutationFn: markAllNotificationsRead, onSuccess: refresh })

  const openNotification = (notification: HSNotification) => {
    if (!notification.readAt)
      void markNotificationRead(notification.id)
        .then(refresh)
        .catch(() => {})
    const asin = stringData(notification, 'asin')
    if (notification.kind === 'release' && asin) {
      setOpen(false)
      navigate(`/upcoming/${encodeURIComponent(asin)}`)
    }
  }

  const notifications = data?.notifications ?? []
  const unread = data?.unreadCount ?? 0
  return (
    <div className="notification-bell" ref={rootRef}>
      <button
        type="button"
        className={'ab-ico notification-bell-button' + (open ? ' on' : '')}
        title="Notifications"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={unread ? 'notifications_active' : 'notifications'} fill={unread > 0} />
        {unread > 0 && <span>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notification-tray" role="dialog" aria-label="Notifications">
          <div className="notification-tray-head">
            <div>
              <span className="eyebrow">Inbox</span>
              <strong>Notifications</strong>
            </div>
            {unread > 0 && (
              <button type="button" disabled={markAll.isPending} onClick={() => markAll.mutate()}>
                Mark all read
              </button>
            )}
          </div>
          <div className="notification-tray-list">
            {notifications.length === 0 ? (
              <div className="notification-empty">
                <Icon name="notifications_none" />
                <strong>Nothing new</strong>
                <span>Invitations, club updates, and release alerts will appear here.</span>
              </div>
            ) : (
              notifications.map((notification) => {
                const pending =
                  notification.kind === 'club_invite' && notification.actionStatus === 'pending'
                return (
                  <article
                    key={notification.id}
                    className={'notification-row' + (!notification.readAt ? ' unread' : '')}
                    onClick={() => openNotification(notification)}
                  >
                    <span className="notification-kind">
                      <Icon
                        name={
                          notification.kind === 'club_invite'
                            ? 'group_add'
                            : notification.kind === 'release'
                              ? 'new_releases'
                              : 'notifications'
                        }
                      />
                    </span>
                    <div>
                      <div className="notification-row-title">
                        <strong>{notification.title}</strong>
                        <time>{relativeTime(notification.createdAt)}</time>
                      </div>
                      {notification.body && <p>{notification.body}</p>}
                      {pending ? (
                        <div className="notification-actions">
                          <button
                            type="button"
                            className="pill on"
                            disabled={respond.isPending}
                            onClick={(event) => {
                              event.stopPropagation()
                              respond.mutate({ notification, accept: true })
                            }}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            className="pill"
                            disabled={respond.isPending}
                            onClick={(event) => {
                              event.stopPropagation()
                              respond.mutate({ notification, accept: false })
                            }}
                          >
                            Decline
                          </button>
                        </div>
                      ) : notification.kind === 'club_invite' ? (
                        <span className="notification-status">
                          {notification.actionStatus === 'accepted'
                            ? 'Joined'
                            : notification.actionStatus === 'declined'
                              ? 'Declined'
                              : 'No longer available'}
                        </span>
                      ) : null}
                    </div>
                  </article>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
