// Anonymous telemetry opt-in. Mounted at /hs/telemetry.
//
//   GET /hs/telemetry          -> { enabled, canEdit, payloadPreview }
//   PUT /hs/telemetry { enabled } (admin only) -> { enabled, canEdit }
//
// Admin-owned, instance-wide. GET returns a preview of EXACTLY what a report
// would send so the Config UI can show the user before they opt in. The box only
// phones home when enabled (see lib/telemetry.js reportTelemetry).

import { json, readBody } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import {
  getTelemetryConfig,
  setTelemetryEnabled,
  previewPayload,
  reportTelemetry,
} from '../lib/telemetry.js'

export async function handleTelemetry(req, res, url, ctx) {
  const p = url.pathname
  if (p !== '/hs/telemetry') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  if (req.method === 'GET') {
    const cfg = await getTelemetryConfig()
    const payloadPreview = await previewPayload()
    return (json(res, 200, { enabled: cfg.enabled, canEdit: isAdmin(ctx), payloadPreview }), true)
  }

  if (req.method === 'PUT') {
    if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    const enabled = Boolean(body?.enabled)
    const next = await setTelemetryEnabled(enabled)
    // Send an immediate report when just enabled, so stats reflect the opt-in
    // without waiting for the weekly tick. Best-effort; never blocks the response.
    if (next.enabled) void reportTelemetry()
    return (json(res, 200, { enabled: next.enabled, canEdit: true }), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
