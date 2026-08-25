// Admin-only, read-only Auto Queue debugger.

import { json } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { debugUserQueue } from '../lib/queueDebug.js'

export async function handleQueueDebug(req, res, url, ctx) {
  if (url.pathname !== '/hs/admin/queue-debug') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
  if (req.method !== 'GET') return (json(res, 405, { error: 'method_not_allowed' }), true)

  const userId = url.searchParams.get('userId')?.trim() ?? ''
  const itemId = url.searchParams.get('itemId')?.trim() || null
  if (!userId) return (json(res, 400, { error: 'user_id_required' }), true)

  try {
    const report = await debugUserQueue(ctx, userId, itemId)
    return (json(res, 200, report), true)
  } catch (error) {
    const detail = String(error?.message ?? error).slice(0, 240)
    console.warn(`[queue-debug] user ${userId}: ${detail}`)
    return (json(res, 502, { error: 'queue_debug_failed', detail }), true)
  }
}
