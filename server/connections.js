// The user's syncable bookshelf (ABS) connection, stored server-side so it can
// follow them to a new platform. One row per (server_id, user_id). abs_url +
// label are non-secret and surface to the client; abs_user_key is the minted
// per-user ABS key and is a SECRET - written here, never returned to the browser
// (only a `connected` flag is), the same handling as hardcover_accounts.token.

import { db, initDb } from './db.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

// The user's connection as safe-to-send fields, or null if none. The ABS key is
// never included - only whether one is stored.
export async function getConnection(serverId, userId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT abs_url, label, abs_user_key, updated_at FROM connections WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  const row = r.rows[0]
  if (!row) return null
  return {
    absUrl: String(row.abs_url),
    label: row.label != null ? String(row.label) : null,
    connected: !!row.abs_user_key,
    updatedAt: Number(row.updated_at),
  }
}

// Upsert the connection's non-secret fields (URL + label). The ABS key is set
// separately via setConnectionKey so a settings write can never overwrite it.
export async function setConnection(serverId, userId, { absUrl, label }) {
  await ensure()
  const now = Date.now()
  await db.execute({
    sql: `INSERT INTO connections (server_id, user_id, abs_url, label, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (server_id, user_id) DO UPDATE SET abs_url = excluded.abs_url, label = excluded.label, updated_at = excluded.updated_at`,
    args: [serverId, userId, String(absUrl), label != null ? String(label) : null, now],
  })
  return getConnection(serverId, userId)
}

// Store the minted per-user ABS key (the secret). Kept out of setConnection and
// never returned by any read, so the key is written by the auth/pairing path
// only and never round-trips through settings sync.
export async function setConnectionKey(serverId, userId, absUserKey) {
  await ensure()
  const now = Date.now()
  await db.execute({
    sql: `INSERT INTO connections (server_id, user_id, abs_url, abs_user_key, updated_at) VALUES (?, ?, '', ?, ?)
          ON CONFLICT (server_id, user_id) DO UPDATE SET abs_user_key = excluded.abs_user_key, updated_at = excluded.updated_at`,
    args: [serverId, userId, String(absUserKey), now],
  })
}

// The stored ABS key for server-side use (reaching ABS on the user's behalf).
// Never send this to a client.
export async function getConnectionKey(serverId, userId) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT abs_user_key FROM connections WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  const row = r.rows[0]
  return row?.abs_user_key ? String(row.abs_user_key) : null
}
