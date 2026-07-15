import { json } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { appLog } from '../lib/appLog.js'

export async function handleLogs(req, res, url, ctx) {
  if (url.pathname !== '/hs/logs') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
  if (req.method !== 'GET') return (json(res, 405, { error: 'method_not_allowed' }), true)
  return (json(res, 200, { logs: appLog.entries() }), true)
}
