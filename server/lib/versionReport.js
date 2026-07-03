// Version reporting: a paired box tells the control plane which HearthShelf (and
// ABS) version it is running, on startup and weekly. This is what lets the hosted
// app know a box is behind and prompt its admin to update.
//
// Runs for EVERY paired box (any mode), unlike hsDirectOnStartup which is AIO-only
// - so it lives as its own startup hook in index.js rather than piggybacking on
// hs.direct. Best-effort throughout: a failed report never affects serving, and an
// unpaired box simply does nothing.
//
// Authenticates the same way every other server-to-server call does: server_id +
// server_secret, posted to the control plane at cfg.issuer (recorded at pairing).

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getHostedConfig } from './hosted.js'
import { getServerId } from '../db.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''

// This backend's version, read once from server/package.json (same idiom as
// routes/runtime.js). null if unreadable.
const HS_VERSION = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null
  } catch {
    return null
  }
})()

const log = (...a) => console.log('[version]', ...a)

// Best-effort ABS version from its public /status. Never throws; returns null.
async function detectAbsVersion() {
  if (!ABS_URL) return null
  try {
    const r = await fetch(`${ABS_URL.replace(/\/$/, '')}/status`)
    if (!r.ok) return null
    const data = await r.json()
    return typeof data?.serverVersion === 'string' ? data.serverVersion : null
  } catch {
    return null
  }
}

// Post one report. Returns the control plane's reply (which carries the latest
// release) or null. Silent on any failure - an unpaired box or an unreachable CP
// must never disturb the process.
async function reportVersion() {
  const cfg = await getHostedConfig().catch(() => null)
  if (!cfg?.serverSecret || !cfg?.issuer) return null // not paired

  const serverId = await getServerId()
  const absVersion = await detectAbsVersion()
  try {
    const res = await fetch(`${cfg.issuer.replace(/\/$/, '')}/servers/version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server_id: serverId,
        server_secret: cfg.serverSecret,
        hs_version: HS_VERSION,
        abs_version: absVersion,
      }),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    // Log a one-line nudge to the box's own console if it's behind. The admin's
    // real prompt is the banner in the hosted app; this is just operator-friendly.
    const latest = data?.latest?.version
    if (latest && HS_VERSION && latest !== HS_VERSION) {
      log(`update available: running v${HS_VERSION}, latest is v${latest} (${data.latest.severity})`)
    }
    return data
  } catch {
    return null
  }
}

// Report on startup, then weekly. The interval is unref'd so it never holds the
// process open. No-op (silently) until the box is paired.
export async function startVersionReporting() {
  await reportVersion()
  const everyMs = Number(process.env.HS_VERSION_REPORT_INTERVAL_MS || String(7 * 24 * 60 * 60 * 1000)) // 7d
  const timer = setInterval(() => {
    reportVersion().catch(() => {})
  }, everyMs)
  if (typeof timer.unref === 'function') timer.unref()
}
