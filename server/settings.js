// Per-user app settings, stored server-side so they follow a user across
// devices. Backed by the per-key user_settings table (replaced the old
// app_settings JSON blob): one row per (server_id, user_id, scope, device_id,
// key), each with its own updated_at, so sync merges at the setting level
// (per-key last-writer-wins). The catalog (lib/settingsCatalog.js, which re-uses
// @hearthshelf/core's catalog directly) defines each key's scope + validation;
// unset keys fall back to the catalog default on the client (sparse storage - the
// DB holds only what the user changed).

import { db, initDb } from './db.js'
import { settingScope, validateSetting } from './lib/settingsCatalog.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

// All of a user's settings, split by scope. Account rows always apply; device
// rows are returned only for the given deviceId (or none when deviceId is
// falsy). Each value is { value, updatedAt }.
export async function getSettings(serverId, userId, deviceId = '') {
  await ensure()
  const r = await db.execute({
    sql: `SELECT scope, device_id, key, value_json, updated_at
          FROM user_settings
          WHERE server_id = ? AND user_id = ? AND (scope = 'account' OR (scope = 'device' AND device_id = ?))`,
    args: [serverId, userId, deviceId || ''],
  })
  const account = {}
  const device = {}
  for (const row of r.rows) {
    let value = null
    try {
      value = JSON.parse(row.value_json)
    } catch {
      continue
    }
    const bucket = row.scope === 'device' ? device : account
    bucket[String(row.key)] = { value, updatedAt: Number(row.updated_at) }
  }
  return { account, device }
}

// Read one key out of a user's settings, or null when unset. Account scope only
// (the callers - e.g. the avatar route's Gravatar opt-out - want the account
// value). One indexed query, no blob scan.
export async function getUserSetting(serverId, userId, key) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT value_json FROM user_settings
          WHERE server_id = ? AND user_id = ? AND scope = 'account' AND device_id = '' AND key = ?`,
    args: [serverId, userId, key],
  })
  const row = r.rows[0]
  if (!row) return null
  try {
    return JSON.parse(row.value_json)
  } catch {
    return null
  }
}

// Map of user id -> their EXPLICIT sharing choice (true/false) for one triBool
// privacy key, for the users within a server who actually set one. These keys
// are tri-state: a row with a boolean value means they chose; no row means they
// never chose, so the admin default applies (see server/community.js). One
// indexed WHERE key = query instead of parsing every user's blob.
//
// `key` defaults to 'shareReadBooks' (leaderboard + finished-by); pass
// 'shareCurrentlyListening' for listening-now presence - same one-query pattern.
export async function getExplicitSharePrefs(serverId, key = 'shareReadBooks') {
  await ensure()
  const r = await db.execute({
    sql: `SELECT user_id, value_json FROM user_settings
          WHERE server_id = ? AND scope = 'account' AND device_id = '' AND key = ?`,
    args: [serverId, key],
  })
  const out = new Map()
  for (const row of r.rows) {
    try {
      const v = JSON.parse(row.value_json)
      if (typeof v === 'boolean') out.set(String(row.user_id), v)
    } catch {
      // Unparseable - treat as no explicit choice.
    }
  }
  return out
}

// Apply a batch of per-key changes. Each change is { scope, key, value,
// updatedAt }. A change is validated against the catalog and only written when
// its updatedAt is at least as new as the stored row (per-key LWW). Returns
// { applied, rejected, invalid } buckets so the caller can report per-key
// results. deviceId scopes any device-scope writes (required for them).
export async function applyChanges(serverId, userId, deviceId, changes) {
  await ensure()
  const applied = []
  const rejected = []
  const invalid = []

  for (const change of changes) {
    const key = String(change?.key ?? '')
    const scope = settingScope(key)
    if (!scope) {
      invalid.push({ key, value: change?.value ?? null, reason: 'unknown_key' })
      continue
    }
    // The catalog owns each key's scope; ignore a mislabeled scope from the client.
    const devId = scope === 'device' ? deviceId || '' : ''
    if (scope === 'device' && !devId) {
      invalid.push({ key, value: change?.value ?? null, reason: 'device_id_required' })
      continue
    }

    const result = validateSetting(key, change?.value)
    if (!result.ok) {
      invalid.push({ key, value: change?.value ?? null, reason: result.reason })
      continue
    }

    const updatedAt = Number(change?.updatedAt)
    if (!Number.isFinite(updatedAt)) {
      invalid.push({ key, value: result.value, reason: 'bad_timestamp' })
      continue
    }

    // Per-key LWW: skip if a newer value is already stored (ties overwrite).
    const cur = await db.execute({
      sql: `SELECT value_json, updated_at FROM user_settings
            WHERE server_id = ? AND user_id = ? AND scope = ? AND device_id = ? AND key = ?`,
      args: [serverId, userId, scope, devId, key],
    })
    const curRow = cur.rows[0]
    const curUpdated = curRow ? Number(curRow.updated_at) : -1
    if (updatedAt < curUpdated) {
      let curValue = null
      try {
        curValue = JSON.parse(curRow.value_json)
      } catch {
        curValue = null
      }
      // The stored value wins; report it so the stale client adopts it.
      rejected.push({ key, value: curValue, updatedAt: curUpdated })
      continue
    }

    await db.execute({
      sql: `INSERT INTO user_settings (server_id, user_id, scope, device_id, key, value_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (server_id, user_id, scope, device_id, key)
            DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      args: [serverId, userId, scope, devId, key, JSON.stringify(result.value), updatedAt],
    })
    applied.push(key)
  }

  return { applied, rejected, invalid }
}
