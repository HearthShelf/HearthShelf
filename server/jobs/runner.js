// Scheduled-job runner. A tiny Sonarr/Radarr-style task system: each registered
// job runs on an interval (default nightly) and can also be triggered manually
// ("Run now" from the admin Jobs panel). Every run - scheduled or manual - is
// recorded in job_runs with a streamed log in job_run_logs, so the admin can see
// status + logs. Built on the same setInterval+unref pattern as the telemetry /
// version-report background tasks (see lib/telemetry.js).

import crypto from 'node:crypto'
import { db, getServerId } from '../db.js'
import { JOBS } from './registry.js'

// Per-job mutex: a scheduled tick and a manual "run now" (or two clicks) must
// never overlap. Value is the in-flight run id.
const running = new Map() // jobId -> runId

export function isJobRunning(jobId) {
  return running.has(jobId)
}

// A logger handed to each job's run(). Buffers lines and flushes them to
// job_run_logs; also lets the job report progress counts onto the run row.
function makeLogger(runId) {
  let seq = 0
  let processed = 0
  let total = 0
  const write = (level, message) => {
    const n = seq++
    // Fire-and-forget: a logging failure must never sink the job.
    void db
      .execute({
        sql: `INSERT INTO job_run_logs (run_id, seq, at, level, message) VALUES (?, ?, ?, ?, ?)`,
        args: [runId, n, Date.now(), level, String(message).slice(0, 2000)],
      })
      .catch(() => {})
  }
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    // Update progress counters (best-effort) so the panel can show N/total.
    progress: (p, t) => {
      if (typeof p === 'number') processed = p
      if (typeof t === 'number') total = t
      void db
        .execute({
          sql: `UPDATE job_runs SET items_processed = ?, items_total = ? WHERE id = ?`,
          args: [processed, total, runId],
        })
        .catch(() => {})
    },
  }
}

// Execute a job by id. `trigger` is 'schedule' or 'manual'. Returns the run id,
// or null when the job is unknown or already running. The actual work runs in the
// background; callers (the scheduler tick, the run-now route) don't await it.
export async function runJob(jobId, { trigger = 'manual' } = {}) {
  const job = JOBS.find((j) => j.id === jobId)
  if (!job) return null
  if (running.has(jobId)) return null

  const runId = crypto.randomUUID()
  running.set(jobId, runId)
  const serverId = getServerId()
  const startedAt = Date.now()

  await db
    .execute({
      sql: `
        INSERT INTO job_runs
          (id, server_id, job_id, trigger, status, started_at, items_processed, items_total)
        VALUES (?, ?, ?, ?, 'running', ?, 0, 0)
      `,
      args: [runId, serverId, jobId, trigger, startedAt],
    })
    .catch(() => {})

  const logger = makeLogger(runId)

  // Background execution - never block the caller (scheduler tick / HTTP route).
  void (async () => {
    try {
      logger.info(`Starting ${job.name} (${trigger})`)
      const summary = await job.run(logger)
      await db
        .execute({
          sql: `UPDATE job_runs SET status = 'ok', finished_at = ?, summary = ? WHERE id = ?`,
          args: [Date.now(), String(summary ?? 'Done').slice(0, 500), runId],
        })
        .catch(() => {})
      logger.info(`Finished: ${summary ?? 'Done'}`)
    } catch (err) {
      const msg = String(err?.message ?? err).slice(0, 500)
      await db
        .execute({
          sql: `UPDATE job_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?`,
          args: [Date.now(), msg, runId],
        })
        .catch(() => {})
      logger.error(`Failed: ${msg}`)
    } finally {
      running.delete(jobId)
    }
  })()

  return runId
}

// Minimal 5-field cron matcher (minute hour day-of-month month day-of-week).
// Supports '*', comma lists, ranges 'a-b', and steps '*/n' / 'a-b/n'. Enough for
// the schedule presets the Backups UI offers (daily/weekly at a time). Returns
// false on any unparseable field so a bad cron never fires wildly.
function cronFieldMatches(field, value) {
  if (field === '*') return true
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? parseInt(stepPart, 10) : 1
    if (!Number.isFinite(step) || step <= 0) return false
    let lo
    let hi
    if (rangePart === '*') {
      lo = -Infinity
      hi = Infinity
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((n) => parseInt(n, 10))
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      lo = a
      hi = b
    } else {
      const n = parseInt(rangePart, 10)
      if (!Number.isFinite(n)) return false
      lo = n
      hi = n
    }
    if (value < lo || value > hi) continue
    const base = rangePart === '*' ? 0 : lo
    if ((value - base) % step === 0) return true
  }
  return false
}

// True if `cron` (5-field) matches the given Date (local time, minute-granular).
export function cronMatches(cron, date) {
  if (!cron || typeof cron !== 'string') return false
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hour, dom, mon, dow] = fields
  const dowVal = date.getDay() // 0-6, Sun=0 (cron 0 or 7 = Sun)
  return (
    cronFieldMatches(min, date.getMinutes()) &&
    cronFieldMatches(hour, date.getHours()) &&
    cronFieldMatches(dom, date.getDate()) &&
    cronFieldMatches(mon, date.getMonth() + 1) &&
    (cronFieldMatches(dow, dowVal) || (dowVal === 0 && cronFieldMatches(dow, 7)))
  )
}

// Start the scheduler. Two kinds of job:
//   - interval jobs (defaultIntervalMs): a setInterval, overridable via
//     HS_JOB_<ID>_INTERVAL_MS. Kept for series-roster.
//   - cron jobs (job.cronSchedule()): a single per-minute tick evaluates each
//     one's current cron (read live from config, so a schedule change in the UI
//     takes effect without a restart) and runs it when the minute matches.
// Timers are unref()'d so they never keep the process alive. Jobs do NOT run
// immediately on boot; the first run is on schedule or a manual click.
export function startJobs() {
  const cronJobs = JOBS.filter((j) => typeof j.cronSchedule === 'function')

  for (const job of JOBS) {
    if (typeof job.cronSchedule === 'function') continue // handled by the cron tick
    const envKey = `HS_JOB_${job.id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_INTERVAL_MS`
    const everyMs = Number(process.env[envKey] || String(job.defaultIntervalMs))
    if (!Number.isFinite(everyMs) || everyMs <= 0) continue
    const timer = setInterval(() => {
      void runJob(job.id, { trigger: 'schedule' })
    }, everyMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  if (cronJobs.length) {
    // Track the last minute we fired each cron job so a slightly-jittery tick
    // can't double-fire within the same minute.
    const lastFiredMinute = new Map()
    const tick = async () => {
      const now = new Date()
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
      for (const job of cronJobs) {
        try {
          const cron = await job.cronSchedule()
          if (!cron) continue // '' / off = no schedule
          if (!cronMatches(cron, now)) continue
          if (lastFiredMinute.get(job.id) === minuteKey) continue
          lastFiredMinute.set(job.id, minuteKey)
          void runJob(job.id, { trigger: 'schedule' })
        } catch {
          // a config read failure just skips this job this minute
        }
      }
    }
    const timer = setInterval(() => void tick(), 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
  }
}
