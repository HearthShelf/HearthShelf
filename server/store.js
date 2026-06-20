// QuestGiver/Discover persistence, backed by the libSQL datastore (see db.js).
// Replaces the old discover.json file. Same function names as before, now async
// because they hit SQLite.
//
// On first boot we import a legacy discover.json (if present) into the DB, then
// rename it to discover.json.migrated so the import runs once and nothing is
// lost for existing deployments.

import fs from 'node:fs'
import path from 'node:path'
import { db, initDb, DB_DIR } from './db.js'

// --- One-time migration from the legacy JSON file ---

async function migrateLegacyJson() {
  const legacy = path.join(DB_DIR, 'discover.json')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'))
  } catch {
    return // no legacy file (or unreadable) - nothing to import
  }
  const now = Date.now()
  try {
    for (const [userId, items] of Object.entries(parsed.feedback ?? {})) {
      for (const [itemKey, fb] of Object.entries(items ?? {})) {
        await db.execute({
          sql: `INSERT OR REPLACE INTO qg_feedback (user_id, item_key, vote, rating, updated_at)
                VALUES (?, ?, ?, ?, ?)`,
          args: [userId, itemKey, fb.vote ?? null, fb.rating ?? null, now],
        })
      }
    }
    for (const [userId, shelf] of Object.entries(parsed.monthly ?? {})) {
      if (!shelf?.month) continue
      await db.execute({
        sql: `INSERT OR REPLACE INTO qg_monthly (user_id, month, engine, intro, picks_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [userId, shelf.month, shelf.engine ?? null, shelf.intro ?? '', JSON.stringify(shelf.picks ?? []), now],
      })
    }
    if (parsed.popular?.date) {
      await db.execute({
        sql: `INSERT OR REPLACE INTO popular_signals (date, items_json) VALUES (?, ?)`,
        args: [parsed.popular.date, JSON.stringify(parsed.popular.items ?? [])],
      })
    }
    fs.renameSync(legacy, legacy + '.migrated')
    // eslint-disable-next-line no-console
    console.log('[store] migrated discover.json into the database')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[store] legacy migration failed:', String(err).slice(0, 160))
  }
}

let ready = null
export function ensureStore() {
  if (!ready) ready = initDb().then(migrateLegacyJson)
  return ready
}

// --- Feedback ---

export async function getFeedback(userId) {
  await ensureStore()
  const r = await db.execute({
    sql: `SELECT item_key, vote, rating FROM qg_feedback WHERE user_id = ?`,
    args: [userId],
  })
  const out = {}
  for (const row of r.rows) {
    const fb = {}
    if (row.vote != null) fb.vote = row.vote
    if (row.rating != null) fb.rating = Number(row.rating)
    out[row.item_key] = fb
  }
  return out
}

export async function setFeedback(userId, itemKey, fb) {
  await ensureStore()
  // Merge with any existing row so a vote-only update keeps the rating.
  const existing = await db.execute({
    sql: `SELECT vote, rating FROM qg_feedback WHERE user_id = ? AND item_key = ?`,
    args: [userId, itemKey],
  })
  const cur = existing.rows[0] ?? {}
  let vote = cur.vote ?? null
  let rating = cur.rating ?? null
  if ('vote' in fb) vote = fb.vote ?? null
  if ('rating' in fb) rating = fb.rating ?? null

  if (vote == null && rating == null) {
    await db.execute({
      sql: `DELETE FROM qg_feedback WHERE user_id = ? AND item_key = ?`,
      args: [userId, itemKey],
    })
  } else {
    await db.execute({
      sql: `INSERT OR REPLACE INTO qg_feedback (user_id, item_key, vote, rating, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [userId, itemKey, vote, rating, Date.now()],
    })
  }
  return getFeedback(userId)
}

// --- Monthly AI shelf cache ---

export async function getMonthly(userId, month) {
  await ensureStore()
  const r = await db.execute({
    sql: `SELECT engine, intro, picks_json FROM qg_monthly WHERE user_id = ? AND month = ?`,
    args: [userId, month],
  })
  const row = r.rows[0]
  if (!row) return null
  return {
    month,
    engine: row.engine ?? 'none',
    intro: row.intro ?? '',
    picks: JSON.parse(row.picks_json ?? '[]'),
  }
}

export async function setMonthly(userId, shelf) {
  await ensureStore()
  await db.execute({
    sql: `INSERT OR REPLACE INTO qg_monthly (user_id, month, engine, intro, picks_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [userId, shelf.month, shelf.engine ?? null, shelf.intro ?? '', JSON.stringify(shelf.picks ?? []), Date.now()],
  })
  return shelf
}

// --- Popular signals (global, dated) ---

export async function getPopular(date) {
  await ensureStore()
  const r = await db.execute({
    sql: `SELECT items_json FROM popular_signals WHERE date = ?`,
    args: [date],
  })
  const row = r.rows[0]
  return row ? { date, items: JSON.parse(row.items_json ?? '[]') } : null
}

export async function setPopular(payload) {
  await ensureStore()
  await db.execute({
    sql: `INSERT OR REPLACE INTO popular_signals (date, items_json) VALUES (?, ?)`,
    args: [payload.date, JSON.stringify(payload.items ?? [])],
  })
  return payload
}
