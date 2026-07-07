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
    sql: `SELECT items_json, manual_json, playlist_id, updated_at FROM listening_queue WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  const row = r.rows[0]
  if (!row) return { items: [], manual: [], playlistId: null, updatedAt: 0 }
  return {
    items: parseList(row.items_json),
    manual: parseList(row.manual_json),
    playlistId: row.playlist_id ?? null,
    updatedAt: Number(row.updated_at),
  }
}

// Upsert the queue, but only when the caller's updatedAt is at least as new
// as what's stored - guards against a stale device clobbering a queue another
// device already advanced. Returns the row that ends up stored (the caller's
// write on success, the current row on rejection) plus whether it applied.
//
// `manual` is the durable hand-queued list. Omit it (undefined) to preserve
// whatever is stored - the Auto rebuild (resolveQueue) does this so recomputing
// `items` never wipes the user's manual list. Pass an array to replace it (a
// client editing the manual queue).
export async function setQueue(serverId, userId, { items, manual, playlistId, updatedAt }) {
  await ensure()
  const current = await getQueue(serverId, userId)
  if (updatedAt < current.updatedAt) {
    return {
      applied: false,
      items: current.items,
      manual: current.manual,
      playlistId: current.playlistId,
      updatedAt: current.updatedAt,
    }
  }
  const nextManual = manual === undefined ? current.manual : (manual ?? [])
  await db.execute({
    sql: `INSERT INTO listening_queue (server_id, user_id, items_json, manual_json, playlist_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (server_id, user_id) DO UPDATE SET items_json = excluded.items_json, manual_json = excluded.manual_json, playlist_id = excluded.playlist_id, updated_at = excluded.updated_at`,
    args: [
      serverId,
      userId,
      JSON.stringify(items ?? []),
      JSON.stringify(nextManual),
      playlistId ?? null,
      updatedAt,
    ],
  })
  return {
    applied: true,
    items: items ?? [],
    manual: nextManual,
    playlistId: playlistId ?? null,
    updatedAt,
  }
}
