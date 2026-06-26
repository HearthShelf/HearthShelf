// Service-account tracking. Mounted at /hs/service-accounts (admin-only).
//
// HearthShelf frames a subset of ABS admin/root users as "service accounts" in
// its Config UI. The accounts and their API keys live entirely in ABS - the SPA
// does that CRUD directly through /abs-api/*. This route only persists which ABS
// user ids HearthShelf has tagged as service accounts (the ones an admin created
// from the Service Accounts page), so the framing survives restarts and follows
// the instance. The auto-created service root is identified separately by the
// runtime config (serviceUsername) and never needs a row here.

import { json, readBody } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import {
  getServiceAccountIds,
  addServiceAccountId,
  removeServiceAccountId,
} from '../lib/serviceAccounts.js'

export async function handleServiceAccounts(req, res, url, ctx) {
  if (!url.pathname.startsWith('/hs/service-accounts')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)

  // GET /hs/service-accounts -> { ids: string[] }
  if (url.pathname === '/hs/service-accounts' && req.method === 'GET') {
    const ids = await getServiceAccountIds()
    return (json(res, 200, { ids }), true)
  }

  // POST /hs/service-accounts { userId } -> { ids } (tag an existing ABS user)
  if (url.pathname === '/hs/service-accounts' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const userId = String(body?.userId || '').trim()
    if (!userId) return (json(res, 400, { error: 'missing_user_id' }), true)
    const ids = await addServiceAccountId(userId)
    return (json(res, 200, { ids }), true)
  }

  // DELETE /hs/service-accounts/:id -> { ids } (untag; the ABS user is untouched)
  const m = url.pathname.match(/^\/hs\/service-accounts\/([^/]+)$/)
  if (m && req.method === 'DELETE') {
    const ids = await removeServiceAccountId(decodeURIComponent(m[1]))
    return (json(res, 200, { ids }), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
