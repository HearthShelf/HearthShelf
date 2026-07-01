// Per-user settings sync. Mounted at /hs/settings. Settings follow a user across
// devices, keyed by (server_id, user_id). Per-key rows with per-key
// last-writer-wins (see server/settings.js); the catalog
// (lib/settingsCatalog.js) validates every write.
//
// GET  /hs/settings?deviceId=<id>
//   -> { account: { <key>: { value, updatedAt } },
//        device:  { <key>: { value, updatedAt } },   // only for this deviceId
//        connection: { absUrl, label, connected } | null }   // never the key
//
// PUT  /hs/settings
//   { deviceId, changes: [ { scope, key, value, updatedAt } ] }
//   -> { applied: [key...], rejected: [{key,value,updatedAt}], invalid: [{key,value,reason}] }

import { json, readBody } from '../lib/http.js'
import { getSettings, applyChanges } from '../settings.js'
import { getConnection } from '../connections.js'

export async function handleSettings(req, res, url, ctx) {
  if (url.pathname !== '/hs/settings') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  if (req.method === 'GET') {
    const deviceId = url.searchParams.get('deviceId') || ''
    const [{ account, device }, connRow] = await Promise.all([getSettings(ctx.serverId, ctx.userId, deviceId), getConnection(ctx.serverId, ctx.userId)])
    const connection = connRow ? { absUrl: connRow.absUrl, label: connRow.label, connected: connRow.connected } : null
    return (json(res, 200, { account, device, connection }), true)
  }

  if (req.method === 'PUT') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const changes = body?.changes
    if (!Array.isArray(changes)) {
      return (json(res, 400, { error: 'invalid_changes' }), true)
    }
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : ''
    const result = await applyChanges(ctx.serverId, ctx.userId, deviceId, changes)
    return (json(res, 200, result), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
