// Admin integrations config route. Mounted at /hs/integrations/config.
// Reads/writes the editable connection settings for the external services
// HearthShelf talks to (ReadMeABook, Audplexus) plus the Audible catalog region.
// Admin-only; secrets stay server-side (publicIntegrations never returns them).

import { json, readBody } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { publicIntegrations, setIntegrations } from '../integrations.js'
import { resetRmabSession } from '../rmab.js'
import { appLog } from '../lib/appLog.js'

export async function handleIntegrations(req, res, url, ctx) {
  const p = url.pathname
  if (p !== '/hs/integrations/config') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)

  if (req.method === 'GET') return (json(res, 200, await publicIntegrations()), true)

  if (req.method === 'PUT') {
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    await setIntegrations(body ?? {})
    // The cached RMAB JWT was minted for the old url/token; drop it so the next
    // request re-authenticates against whatever was just saved.
    resetRmabSession()
    const next = await publicIntegrations()
    appLog.info(
      'integrations',
      `ReadMeABook configuration saved (configured=${next.rmabConfigured}, url=${next.rmabUrl || 'unset'})`,
    )
    return (json(res, 200, next), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
