// HS backup schedule + retention config. A single instance-wide row, admin-owned.
//
// Precedence: ENV OVERRIDES DB, per field (same model as integrations.js /
// config.js). If HS_BACKUP_SCHEDULE / HS_BACKUPS_TO_KEEP / HS_BACKUP_PATH is set,
// that value is used and the field is locked (read-only in the UI); otherwise the
// editable DB value applies. This lets a deployment pin the schedule or an off-box
// path via env while leaving the rest configurable.
//
// Defaults (fresh box, opt-out): nightly 01:00, keep 7. See
// docs/data-lifecycle/backups.md.

import { db, initDb } from './db.js'

export const DEFAULT_SCHEDULE = '0 1 * * *'
export const DEFAULT_KEEP = 7

function envVal(name) {
  const v = process.env[name]
  return v != null && v !== '' ? v : null
}

// Which fields the environment pins, and to what. Presence of a key = env-locked.
function envOverrides() {
  const out = {}
  const schedule = envVal('HS_BACKUP_SCHEDULE')
  if (schedule != null) out.schedule = schedule
  const keepRaw = envVal('HS_BACKUPS_TO_KEEP')
  if (keepRaw != null) {
    const n = parseInt(keepRaw, 10)
    if (Number.isFinite(n) && n > 0) out.keep = n
  }
  const offBox = envVal('HS_BACKUP_PATH')
  if (offBox != null) out.offBoxPath = offBox
  return out
}

let ready = null
async function ensureRow() {
  if (ready) return ready
  ready = (async () => {
    await initDb()
    const r = await db.execute('SELECT id FROM backup_config WHERE id = 1')
    if (r.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO backup_config (id, schedule, keep, off_box_path, updated_at)
              VALUES (1, ?, ?, NULL, ?)`,
        args: [DEFAULT_SCHEDULE, DEFAULT_KEEP, Date.now()],
      })
    }
  })()
  return ready
}

// The stored (DB-only) values, no env overlay.
async function getStored() {
  await ensureRow()
  const r = await db.execute('SELECT * FROM backup_config WHERE id = 1')
  const row = r.rows[0] ?? {}
  return {
    schedule: row.schedule != null ? String(row.schedule) : DEFAULT_SCHEDULE,
    keep: Number(row.keep) || DEFAULT_KEEP,
    offBoxPath: row.off_box_path != null ? String(row.off_box_path) : null,
  }
}

// The effective config the backup job runs on: env layered on top of stored.
export async function getBackupConfig() {
  const stored = await getStored()
  return { ...stored, ...envOverrides() }
}

// Apply a partial admin update to the DB layer. Fields pinned by env are ignored
// (they can't be edited from the UI). Returns the public view.
export async function setBackupConfig(patch) {
  await ensureRow()
  const env = envOverrides()
  const next = await getStored()
  const editable = (field) => field in patch && !(field in env)

  if (editable('schedule')) {
    // '' / 'off' both mean "no schedule"; store as '' so the job skips it.
    const s = String(patch.schedule ?? '').trim()
    next.schedule = s.toLowerCase() === 'off' ? '' : s
  }
  if (editable('keep')) {
    const n = parseInt(patch.keep, 10)
    if (Number.isFinite(n) && n > 0) next.keep = n
  }
  if (editable('offBoxPath')) {
    const p = String(patch.offBoxPath ?? '').trim()
    next.offBoxPath = p || null
  }
  await db.execute({
    sql: `UPDATE backup_config SET schedule = ?, keep = ?, off_box_path = ?, updated_at = ? WHERE id = 1`,
    args: [next.schedule, next.keep, next.offBoxPath, Date.now()],
  })
  return publicBackupConfig()
}

// Public view for the admin UI. Reports the effective values + which fields env
// pins (so the UI locks them). Matches HsBackupConfig in @hearthshelf/core.
export async function publicBackupConfig() {
  const env = envOverrides()
  const c = await getBackupConfig()
  return {
    schedule: c.schedule,
    keep: c.keep,
    offBoxPath: c.offBoxPath,
    env: {
      schedule: 'schedule' in env,
      keep: 'keep' in env,
      offBoxPath: 'offBoxPath' in env,
    },
  }
}
