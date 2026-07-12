// Per-user "not right now" dismissals: series and books the user hid from Auto
// sources (the up-next queue + the Continue-* home shelves). Stored server-side
// so the choice follows them across devices, keyed by (server_id, user_id).
// Reversible - restoring is just deleting the row. Never touches ABS progress.

import { db, initDb } from './db.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

const KINDS = new Set(['series', 'item'])

/** The user's dismissals in the shape @hearthshelf/core expects (Dismissals). */
export async function getDismissals(serverId, userId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT kind, entity_id FROM auto_dismissals WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  const seriesIds = []
  const itemIds = []
  for (const row of r.rows) {
    if (row.kind === 'series') seriesIds.push(row.entity_id)
    else if (row.kind === 'item') itemIds.push(row.entity_id)
  }
  return { seriesIds, itemIds }
}

/** Dismiss (hide) an entity. Idempotent. Returns false if kind is invalid. */
export async function addDismissal(serverId, userId, kind, entityId, now) {
  if (!KINDS.has(kind) || !entityId) return false
  await ensure()
  await db.execute({
    sql: `INSERT INTO auto_dismissals (server_id, user_id, kind, entity_id, dismissed_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (server_id, user_id, kind, entity_id) DO NOTHING`,
    args: [serverId, userId, kind, entityId, now],
  })
  return true
}

/** Restore (un-hide) an entity. Idempotent. Returns false if kind is invalid. */
export async function removeDismissal(serverId, userId, kind, entityId) {
  if (!KINDS.has(kind) || !entityId) return false
  await ensure()
  await db.execute({
    sql: `DELETE FROM auto_dismissals WHERE server_id = ? AND user_id = ? AND kind = ? AND entity_id = ?`,
    args: [serverId, userId, kind, entityId],
  })
  return true
}
