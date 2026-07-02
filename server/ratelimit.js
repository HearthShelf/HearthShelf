// Per-user rate limiting for QuestGiver. The limit string ("off" | "N/day" |
// "N/week" | "N/month") comes from the editable AI config (see providers.js).
// Counts are persisted in the rate_limits table so a restart no longer wipes a
// user's usage mid-period.

import { db, initDb } from './db.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

export function parseLimit(raw) {
  const v = (raw || 'off').trim().toLowerCase()
  if (v === 'off' || v === '') return null
  const m = v.match(/^(\d+)\s*\/\s*(hour|day|week|month)$/)
  if (!m) return null
  return { max: Number(m[1]), period: m[2] }
}

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${week}`
}

function periodKey(period, now = new Date()) {
  if (period === 'hour') return now.toISOString().slice(0, 13) // YYYY-MM-DDTHH
  if (period === 'day') return now.toISOString().slice(0, 10)
  if (period === 'week') return isoWeek(now)
  return now.toISOString().slice(0, 7) // month: YYYY-MM
}

async function readCount(serverId, userId, key) {
  await ensure()
  const r = await db.execute({
    sql: `SELECT count FROM rate_limits WHERE server_id = ? AND user_id = ? AND period_key = ?`,
    args: [serverId, userId, key],
  })
  return r.rows[0] ? Number(r.rows[0].count) : 0
}

// The period_key stored per feature. `scope` namespaces one feature's counts
// from another's so two features that share a period (e.g. both '/day') don't
// share a bucket. QuestGiver passes no scope (legacy key shape preserved); notes
// and clubs pass 'notes' / 'clubs'.
function bucketKey(userId, period, scope) {
  const base = `${userId}:${periodKey(period)}`
  return scope ? `${scope}:${base}` : base
}

// Returns { allowed, limit, remaining, period } for a user WITHOUT consuming.
export async function check(serverId, userId, limitStr, scope = '') {
  const limit = parseLimit(limitStr)
  if (!limit) return { allowed: true, limit: null, remaining: null, period: null }
  const key = bucketKey(userId, limit.period, scope)
  const used = await readCount(serverId, userId, key)
  return {
    allowed: used < limit.max,
    limit: limit.max,
    remaining: Math.max(0, limit.max - used),
    period: limit.period,
  }
}

// Consume one unit for a user; returns the post-consume state. The UPSERT is a
// single atomic statement so concurrent requests can't lose a count.
export async function consume(serverId, userId, limitStr, scope = '') {
  const limit = parseLimit(limitStr)
  if (!limit) return { allowed: true, limit: null, remaining: null, period: null }
  const key = bucketKey(userId, limit.period, scope)
  await ensure()
  await db.execute({
    sql: `INSERT INTO rate_limits (server_id, user_id, period_key, count) VALUES (?, ?, ?, 1)
          ON CONFLICT (server_id, user_id, period_key) DO UPDATE SET count = count + 1`,
    args: [serverId, userId, key],
  })
  const used = await readCount(serverId, userId, key)
  return {
    allowed: used <= limit.max,
    limit: limit.max,
    remaining: Math.max(0, limit.max - used),
    period: limit.period,
  }
}
