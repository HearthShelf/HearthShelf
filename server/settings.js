// Per-user app settings (theme, accent, cover size, sleep prefs, etc.), stored
// server-side so they follow a user across devices. The whole settings object
// is kept as one JSON blob keyed by ABS user id - the backend treats it as
// opaque; the frontend owns the shape.

import { db, initDb } from './db.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

export async function getSettings(userId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT values_json, updated_at FROM app_settings WHERE user_id = ?`,
    args: [userId],
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

export async function setSettings(userId, values) {
  await ensure()
  const now = Date.now()
  await db.execute({
    sql: `INSERT INTO app_settings (user_id, values_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET values_json = excluded.values_json, updated_at = excluded.updated_at`,
    args: [userId, JSON.stringify(values ?? {}), now],
  })
  return { values, updatedAt: now }
}
