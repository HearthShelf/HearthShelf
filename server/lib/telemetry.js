// Anonymous, opt-in usage telemetry (Home Assistant style).
//
// OFF by default: nothing is sent until an admin turns it on in Config. When on,
// the box sends COARSE, non-identifying counts - bucketed user/library sizes plus
// lifetime activity totals (quests given/accepted, books finished, club books
// finished) - keyed by a RANDOM per-install telemetry_id that is deliberately NOT
// the server_id. The control plane aggregates these into the public
// hearthshelf.com/stats page and can never tie a report back to a paired server.
//
// What is NEVER sent: usernames, emails, book/library titles, IP addresses, the
// server name, or the server_id. See buildPayload for the exact shape - the
// Config UI shows the same preview so the opt-in is honest.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { db, initDb, getServerId } from '../db.js'
import { getMode } from './context.js'
import { getHostedConfig } from './hosted.js'

const ABS_URL = process.env.ABS_SERVER_URL || ''

const HS_VERSION = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null
  } catch {
    return null
  }
})()

const log = (...a) => console.log('[telemetry]', ...a)

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

// --- config (opt-in state + the anonymous handle) --------------------------

// Read the telemetry config, creating the row (disabled, no handle) on first
// access. The handle is only minted when the admin opts in, so a box that never
// opts in never even generates one.
export async function getTelemetryConfig() {
  await ensure()
  const r = await db.execute('SELECT enabled, telemetry_id FROM telemetry_config WHERE id = 1')
  const row = r.rows[0]
  if (!row) {
    await db.execute({
      sql: `INSERT INTO telemetry_config (id, enabled, telemetry_id, updated_at) VALUES (1, 0, NULL, ?)`,
      args: [Date.now()],
    })
    return { enabled: false, telemetryId: null }
  }
  return { enabled: Boolean(row.enabled), telemetryId: row.telemetry_id ?? null }
}

// Turn telemetry on or off. Enabling mints a fresh random telemetry_id if none
// exists yet. Disabling keeps the handle row but stops reporting (so re-enabling
// later reuses the same anonymous id rather than looking like a new install).
export async function setTelemetryEnabled(enabled) {
  await ensure()
  const cur = await getTelemetryConfig()
  let id = cur.telemetryId
  if (enabled && !id) id = crypto.randomUUID().replace(/-/g, '')
  await db.execute({
    sql: `UPDATE telemetry_config SET enabled = ?, telemetry_id = ?, updated_at = ? WHERE id = 1`,
    args: [enabled ? 1 : 0, id, Date.now()],
  })
  return { enabled: Boolean(enabled), telemetryId: id }
}

// --- payload ---------------------------------------------------------------

function userBucket(n) {
  if (n <= 1) return '1'
  if (n <= 5) return '2-5'
  if (n <= 20) return '6-20'
  return '21+'
}
function bookBucket(n) {
  if (n <= 0) return '0'
  if (n < 100) return '1-99'
  if (n < 1000) return '100-999'
  return '1000+'
}

async function scalar(sql) {
  try {
    const r = await db.execute(sql)
    const row = r.rows[0]
    const v = row ? Object.values(row)[0] : 0
    return Number(v) || 0
  } catch {
    return 0
  }
}

// Best-effort ABS library size (total items) + version from its public endpoints.
// Never throws; returns { books: 0, absVersion: null } on any failure.
async function absSnapshot() {
  const out = { books: 0, absVersion: null }
  if (!ABS_URL) return out
  const base = ABS_URL.replace(/\/$/, '')
  try {
    const s = await fetch(`${base}/status`)
    if (s.ok) {
      const d = await s.json()
      if (typeof d?.serverVersion === 'string') out.absVersion = d.serverVersion
    }
  } catch {
    /* ignore */
  }
  return out
}

// Build the anonymous report. Distinct-user count is the union of user_ids that
// have any HS-tracked activity (quests, finished books, or a saved queue) - a
// stand-in for "active users" that needs no ABS admin token. All counts are
// coarse (buckets) or lifetime totals; nothing identifies a person or a title.
export async function buildPayload(telemetryId) {
  const [questsGiven, questsAccepted, booksFinished, clubBooksFinished, clubsActive, userCount] =
    await Promise.all([
      scalar(`SELECT COUNT(*) FROM qg_runs`),
      // A quest is "accepted" when the user thumbs it up in feedback.
      scalar(`SELECT COUNT(*) FROM qg_feedback WHERE vote = 'up'`),
      scalar(`SELECT COUNT(*) FROM finished_books`),
      scalar(`SELECT COUNT(*) FROM club_books WHERE finished_at IS NOT NULL`),
      scalar(`SELECT COUNT(*) FROM clubs WHERE archived = 0`),
      scalar(
        `SELECT COUNT(*) FROM (
           SELECT user_id FROM qg_runs
           UNION SELECT user_id FROM finished_books
           UNION SELECT user_id FROM listening_queue
         )`,
      ),
    ])

  const abs = await absSnapshot()

  return {
    telemetry_id: telemetryId,
    hs_version: HS_VERSION,
    abs_version: abs.absVersion,
    mode: getMode(),
    user_bucket: userBucket(userCount),
    book_bucket: bookBucket(abs.books),
    quests_given: questsGiven,
    quests_accepted: questsAccepted,
    books_finished: booksFinished,
    club_books_finished: clubBooksFinished,
    clubs_active: clubsActive,
  }
}

// A caller-facing preview of exactly what a report would contain right now, for
// the Config disclosure. Uses a redacted handle so the UI never displays the real
// anonymous id (which the user shouldn't need to see or share).
export async function previewPayload() {
  const payload = await buildPayload('preview')
  return { ...payload, telemetry_id: '(anonymous install id)' }
}

// --- reporting -------------------------------------------------------------

// The control plane base. A paired box has it recorded as the hosted issuer; an
// unpaired box (self-hosted, never connected) falls back to the public API host
// so opt-in telemetry still works without pairing.
async function controlPlaneBase() {
  const cfg = await getHostedConfig().catch(() => null)
  const base =
    cfg?.issuer ||
    process.env.HS_CONTROL_PLANE ||
    process.env.HSDIRECT_CP_URL ||
    'https://api.hearthshelf.com'
  return base.replace(/\/$/, '')
}

// Send one report if opted in. Silent no-op when disabled; best-effort on the
// network. Not authenticated - the payload is anonymous by design and the control
// plane validates its shape.
export async function reportTelemetry() {
  const cfg = await getTelemetryConfig()
  if (!cfg.enabled || !cfg.telemetryId) return
  try {
    const payload = await buildPayload(cfg.telemetryId)
    const base = await controlPlaneBase()
    await fetch(`${base}/telemetry/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    /* best-effort */
  }
}

// Report on startup (if opted in), then weekly. Interval unref'd so it never
// holds the process open.
export async function startTelemetryReporting() {
  await getServerId() // ensure the identity/db is initialised
  const cfg = await getTelemetryConfig()
  if (cfg.enabled) log('anonymous telemetry is on; reporting weekly')
  await reportTelemetry()
  const everyMs = Number(
    process.env.HS_TELEMETRY_INTERVAL_MS || String(7 * 24 * 60 * 60 * 1000),
  ) // 7d
  const timer = setInterval(() => {
    reportTelemetry().catch(() => {})
  }, everyMs)
  if (typeof timer.unref === 'function') timer.unref()
}
