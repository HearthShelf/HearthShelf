// Generic notification inbox.
//   GET  /hs/notifications                 -> list + unread count
//   PUT  /hs/notifications/read-all        -> mark every row read
//   PUT  /hs/notifications/:id/read        -> mark one row read

import { json } from '../lib/http.js'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
} from '../notifications.js'

export async function handleNotifications(req, res, url, ctx) {
  const p = url.pathname
  if (p !== '/hs/notifications' && !p.startsWith('/hs/notifications/')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  if (p === '/hs/notifications' && req.method === 'GET') {
    const [notifications, unreadCount] = await Promise.all([
      listNotifications(ctx.serverId, ctx.userId),
      unreadNotificationCount(ctx.serverId, ctx.userId),
    ])
    return (json(res, 200, { notifications, unreadCount }), true)
  }

  if (p === '/hs/notifications/read-all' && req.method === 'PUT') {
    await markAllNotificationsRead(ctx.serverId, ctx.userId)
    return (json(res, 200, { ok: true }), true)
  }

  const match = p.match(/^\/hs\/notifications\/([^/]+)\/read$/)
  if (match && req.method === 'PUT') {
    const found = await markNotificationRead(ctx.serverId, ctx.userId, decodeURIComponent(match[1]))
    return (json(res, found ? 200 : 404, found ? { ok: true } : { error: 'not_found' }), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
