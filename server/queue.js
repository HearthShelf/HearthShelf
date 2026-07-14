// The user's up-next listening queue, stored server-side so it follows them
// across devices. One row per (server_id, user_id); the backend treats
// items_json as opaque (an ordered QueueEntry[] - see @hearthshelf/core
// QueueState). Queue MODE and auto-rules are preferences and live in
// app_settings instead (server/settings.js).

import { db, initDb } from './db.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

function parseList(json) {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export async function getQueue(serverId, userId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT items_json, manual_json, playlist_id, current_item_id, updated_at FROM listening_queue WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  const row = r.rows[0]
  if (!row) return { items: [], manual: [], playlistId: null, currentItemId: null, updatedAt: 0 }
  return {
    items: parseList(row.items_json),
    manual: parseList(row.manual_json),
    playlistId: row.playlist_id ?? null,
    currentItemId: row.current_item_id ?? null,
    updatedAt: Number(row.updated_at),
  }
}

// Distinct (server_id, user_id) pairs that have a stored queue row. The nightly
// recompute job iterates these; resolveQueue itself no-ops users not in Auto
// mode, so we don't need to join app_settings here.
export async function getUsersWithQueue() {
  await ensure()
  const r = await db.execute(`SELECT DISTINCT server_id, user_id FROM listening_queue`)
  return r.rows.map((row) => ({ serverId: String(row.server_id), userId: String(row.user_id) }))
}

// Upsert the queue, but only when the caller's updatedAt is at least as new
// as what's stored - guards against a stale device clobbering a queue another
// device already advanced. Returns the row that ends up stored (the caller's
// write on success, the current row on rejection) plus whether it applied.
//
// `items` and `manual` are each independently optional. Omit either (undefined)
// to preserve whatever is stored:
//   - The Auto rebuild (resolveQueue) omits `manual` so recomputing `items`
//     never wipes the user's hand-queued list.
//   - The queue route omits `items` in non-Manual modes so a client can never
//     overwrite the server-computed active list (only Manual is client-authored).
// Pass an array for either to replace it.
export async function setQueue(serverId, userId, { items, manual, playlistId, currentItemId, updatedAt }) {
  await ensure()
  const current = await getQueue(serverId, userId)
  if (updatedAt < current.updatedAt) {
    return {
      applied: false,
      items: current.items,
      manual: current.manual,
      playlistId: current.playlistId,
      currentItemId: current.currentItemId,
      updatedAt: current.updatedAt,
    }
  }
  const nextItems = items === undefined ? current.items : (items ?? [])
  const nextManual = manual === undefined ? current.manual : (manual ?? [])
  // Like items/manual, currentItemId is independently optional: undefined =
  // preserve the stored value (so an Auto rebuild that doesn't know the current
  // book, e.g. the nightly job, keeps the last client-stamped one). Pass a
  // string to set it, or null to clear it.
  const nextCurrentItemId = currentItemId === undefined ? current.currentItemId : (currentItemId ?? null)
  await db.execute({
    sql: `INSERT INTO listening_queue (server_id, user_id, items_json, manual_json, playlist_id, current_item_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (server_id, user_id) DO UPDATE SET items_json = excluded.items_json, manual_json = excluded.manual_json, playlist_id = excluded.playlist_id, current_item_id = excluded.current_item_id, updated_at = excluded.updated_at`,
    args: [
      serverId,
      userId,
      JSON.stringify(nextItems),
      JSON.stringify(nextManual),
      playlistId ?? null,
      nextCurrentItemId,
      updatedAt,
    ],
  })
  return {
    applied: true,
    items: nextItems,
    manual: nextManual,
    playlistId: playlistId ?? null,
    currentItemId: nextCurrentItemId,
    updatedAt,
  }
}
