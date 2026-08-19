// Generic per-user notification inbox. Domain routes create typed rows; clients
// consume one stable list/read API rather than every feature inventing a badge.

import crypto from 'node:crypto'
import { db, initDb } from './db.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

function parseData(raw) {
  try {
    const value = JSON.parse(String(raw || '{}'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function mapRow(row) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    entityId: String(row.entity_id ?? ''),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    data: parseData(row.data_json),
    createdAt: Number(row.created_at),
    readAt: row.read_at == null ? null : Number(row.read_at),
    actionStatus: row.action_status == null ? null : String(row.action_status),
  }
}

export async function createNotification(
  serverId,
  userId,
  { kind, entityId = '', title, body = '', data = {} },
) {
  await ensure()
  if (entityId) {
    const existing = await db.execute({
      sql: `SELECT id FROM notifications
            WHERE server_id = ? AND user_id = ? AND kind = ? AND entity_id = ? LIMIT 1`,
      args: [serverId, userId, kind, entityId],
    })
    if (existing.rows[0]?.id) return String(existing.rows[0].id)
  }
  const id = crypto.randomUUID()
  await db.execute({
    sql: `INSERT INTO notifications
            (id, server_id, user_id, kind, entity_id, title, body, data_json, created_at, read_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    args: [id, serverId, userId, kind, entityId, title, body, JSON.stringify(data), Date.now()],
  })
  return id
}

export async function listNotifications(serverId, userId, limit = 50) {
  await ensure()
  const capped = Math.max(1, Math.min(100, Number(limit) || 50))
  const result = await db.execute({
    sql: `SELECT n.*,
                 CASE WHEN n.kind = 'club_invite' THEN ci.status ELSE NULL END AS action_status
            FROM notifications n
            LEFT JOIN club_invites ci
              ON n.kind = 'club_invite' AND ci.server_id = n.server_id AND ci.id = n.entity_id
           WHERE n.server_id = ? AND n.user_id = ?
           ORDER BY n.created_at DESC
           LIMIT ?`,
    args: [serverId, userId, capped],
  })
  return result.rows.map(mapRow)
}

export async function unreadNotificationCount(serverId, userId) {
  await ensure()
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM notifications
          WHERE server_id = ? AND user_id = ? AND read_at IS NULL`,
    args: [serverId, userId],
  })
  return Number(result.rows[0]?.n) || 0
}

export async function markNotificationRead(serverId, userId, id) {
  await ensure()
  const result = await db.execute({
    sql: `UPDATE notifications SET read_at = COALESCE(read_at, ?)
          WHERE server_id = ? AND user_id = ? AND id = ?`,
    args: [Date.now(), serverId, userId, id],
  })
  return (result.rowsAffected ?? 0) > 0
}

export async function markAllNotificationsRead(serverId, userId) {
  await ensure()
  await db.execute({
    sql: `UPDATE notifications SET read_at = COALESCE(read_at, ?)
          WHERE server_id = ? AND user_id = ?`,
    args: [Date.now(), serverId, userId],
  })
}

export async function markEntityNotificationsRead(serverId, userId, kind, entityId) {
  await ensure()
  await db.execute({
    sql: `UPDATE notifications SET read_at = COALESCE(read_at, ?)
          WHERE server_id = ? AND user_id = ? AND kind = ? AND entity_id = ?`,
    args: [Date.now(), serverId, userId, kind, entityId],
  })
}

// Dismiss one row. Scoped to the caller's own server_id + user_id like every
// other mutator here, so an id from another user's inbox simply matches nothing
// and reports not-found rather than deleting across accounts.
export async function deleteNotification(serverId, userId, id) {
  await ensure()
  const result = await db.execute({
    sql: `DELETE FROM notifications WHERE server_id = ? AND user_id = ? AND id = ?`,
    args: [serverId, userId, id],
  })
  return (result.rowsAffected ?? 0) > 0
}

// Clear the caller's whole inbox ("Clear all").
export async function deleteAllNotifications(serverId, userId) {
  await ensure()
  await db.execute({
    sql: `DELETE FROM notifications WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
}

export async function deleteEntityNotifications(serverId, kind, entityId) {
  await ensure()
  await db.execute({
    sql: `DELETE FROM notifications WHERE server_id = ? AND kind = ? AND entity_id = ?`,
    args: [serverId, kind, entityId],
  })
}
