// Per-user app settings (theme, accent, cover size, sleep prefs, etc.), stored
// server-side so they follow a user across devices. The whole settings object
// is kept as one JSON blob keyed by (server_id, ABS user id) - the backend
// treats it as opaque; the frontend owns the shape.

import { db, initDb } from './db.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

export async function getSettings(serverId, userId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT values_json, updated_at FROM app_settings WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  const row = r.rows[0]
  if (!row) return { values: null, updatedAt: 0 }
  let values = null
  try {
    values = JSON.parse(row.values_json)
  } catch {
    values = null
  }
  return { values, updatedAt: Number(row.updated_at) }
}

// Map of user id -> their EXPLICIT leaderboard-sharing choice, for the users
// (within a server) who have actually set one. shareReadBooks is tri-state:
// present in a user's settings means they chose (true = share, false = hide);
// absent from this map means they never chose, so the admin's default applies
// (see server/community.js). The social leaderboard merges this with the default
// to decide who appears - flipping the default is retroactive for absent users
// but never overrides an explicit choice here.
export async function getExplicitSharePrefs(serverId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT user_id, values_json FROM app_settings WHERE server_id = ?`,
    args: [serverId],
  })
  const out = new Map()
  for (const row of r.rows) {
    try {
      const values = JSON.parse(row.values_json)
      if (values && typeof values.shareReadBooks === 'boolean') {
        out.set(String(row.user_id), values.shareReadBooks)
      }
    } catch {
      // Unparseable settings blob - treat as "no explicit choice".
    }
  }
  return out
}

export async function setSettings(serverId, userId, values) {
  await ensure()
  const now = Date.now()
  await db.execute({
    sql: `INSERT INTO app_settings (server_id, user_id, values_json, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (server_id, user_id) DO UPDATE SET values_json = excluded.values_json, updated_at = excluded.updated_at`,
    args: [serverId, userId, JSON.stringify(values ?? {}), now],
  })
  return { values, updatedAt: now }
}
