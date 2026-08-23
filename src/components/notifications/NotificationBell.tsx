import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { respondToClubInvite } from '@/api/clubs'
import {
  deleteAllNotifications,
  deleteNotification,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type HSNotification,
} from '@/api/notifications'
import { findOwnedItemByAsin } from '@/api/libraries'
import { setRating, ratingKeys, skipRatingPrompt } from '@/api/ratings'
import { Icon } from '@/components/common/Icon'
import { RatingPromptActions } from '@/components/notifications/RatingPromptActions'
import { RATING_NOTIFICATION_KIND } from '@hearthshelf/core'
import { useSettingsStore } from '@/store/settingsStore'

const QUERY_KEY = ['notifications'] as const

/** How long the "Rated 4 stars" confirmation stays before the row clears. Long
 *  enough to read, short enough that it never feels stuck. */
const RATING_DISMISS_MS = 900

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
  const dismiss = useMutation({ mutationFn: deleteNotification, onSuccess: refresh })
  const notifyPrefs = useSettingsStore((state) => state.notifyPrefs)
  const setSetting = useSettingsStore((state) => state.set)
  const clearAll = useMutation({ mutationFn: deleteAllNotifications, onSuccess: refresh })

  // Save a rating from the tray, then clear the row: the question has been
  // answered, so leaving it behind would just be one more thing to dismiss. The
  // component shows a brief "Rated 4 stars" first, which is what makes the row
  // disappearing read as saved rather than lost.
  const rateFromTray = async (notification: HSNotification, value: number): Promise<boolean> => {
    const itemKey = stringData(notification, 'itemKey') || notification.entityId
    if (!itemKey) return false
    try {
      await setRating(itemKey, value)
    } catch {
      // setRating throws rather than swallowing, precisely so the row can stay
      // put instead of claiming a score the server never stored.
      return false
    }
    await qc.invalidateQueries({ queryKey: ratingKeys.map })
    setTimeout(() => dismiss.mutate(notification.id), RATING_DISMISS_MS)
    return true
  }

  // "Don't ask again": silence the whole category, then clear this row. Writes
  // the same notifyPrefs key the Settings notification toggles write, so the two
  // agree and the choice syncs across devices.
  const stopAskingForRatings = (notification: HSNotification) => {
    setSetting('notifyPrefs', {
      ...notifyPrefs,
      types: { ...notifyPrefs.types, rating: { ...notifyPrefs.types.rating, enabled: false } },
    })
    dismiss.mutate(notification.id)
  }

  const openNotification = (notification: HSNotification) => {
    if (!notification.readAt)
      void markNotificationRead(notification.id)
        .then(refresh)
        .catch(() => {})
    const asin = stringData(notification, 'asin')
    if (notification.kind === 'release' && asin) {
      setOpen(false)
      // The 'available' signal means the book has LANDED in the library, so it
      // opens the owned book; the still-upcoming signals open the upcoming
      // page. Falls back to upcoming when the owned copy can't be resolved.
      if (stringData(notification, 'signal') === 'available') {
        void findOwnedItemByAsin(asin).then((itemId) =>
          navigate(
            itemId
              ? `/item/${encodeURIComponent(itemId)}`
              : `/upcoming/${encodeURIComponent(asin)}`,
          ),
        )
        return
      }
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
            {unread > 0 ? (
              <button type="button" disabled={markAll.isPending} onClick={() => markAll.mutate()}>
                Mark all read
              </button>
            ) : notifications.length > 0 ? (
              <button type="button" disabled={clearAll.isPending} onClick={() => clearAll.mutate()}>
                Clear all
              </button>
            ) : null}
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
                // A rating prompt is answered in place, so clicking the row must
                // not navigate away mid-answer - it only marks the row read.
                const isRating = notification.kind === RATING_NOTIFICATION_KIND
                return (
                  <article
                    key={notification.id}
                    className={'notification-row' + (!notification.readAt ? ' unread' : '')}
                    onClick={() => {
                      if (isRating) {
                        if (!notification.readAt) {
                          void markNotificationRead(notification.id)
                            .then(refresh)
                            .catch(() => {})
                        }
                        return
                      }
                      openNotification(notification)
                    }}
                  >
                    <span className="notification-kind">
                      <Icon
                        name={
                          isRating
                            ? 'star'
                            : notification.kind === 'club_invite'
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
                      {isRating ? (
                        <RatingPromptActions
                          bookTitle={stringData(notification, 'title') || 'this book'}
                          onRate={(value) => rateFromTray(notification, value)}
                          onSkip={() => {
                            // Record the skip BEFORE clearing the row: the row is
                            // what the prompt job dedupes against, so dismissing
                            // alone would let the next hourly pass re-ask.
                            const itemKey =
                              stringData(notification, 'itemKey') || notification.entityId
                            if (itemKey) void skipRatingPrompt(itemKey)
                            dismiss.mutate(notification.id)
                          }}
                          onStopAsking={() => stopAskingForRatings(notification)}
                        />
                      ) : pending ? (
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
                    <button
                      type="button"
                      className="ab-ico notification-dismiss"
                      title="Dismiss"
                      aria-label={`Dismiss ${notification.title}`}
                      disabled={dismiss.isPending}
                      onClick={(event) => {
                        event.stopPropagation()
                        dismiss.mutate(notification.id)
                      }}
                    >
                      <Icon name="close" />
                    </button>
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
