// Admin API for the scheduled-jobs system (Sonarr/Radarr-style). All endpoints
// are admin-only. Mounted under /hs/jobs/*.
//
//   GET  /hs/jobs                     -> list jobs + their latest run
//   POST /hs/jobs/:id/run             -> trigger a run now (202, returns runId)
//   GET  /hs/jobs/:id/runs            -> recent runs for a job
//   GET  /hs/jobs/runs/:runId/logs    -> the log lines for a run

import { json } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { db, getServerId } from '../db.js'
import { JOBS } from '../jobs/registry.js'
import { runJob, isJobRunning } from '../jobs/runner.js'

// The latest run row for each job id, as a map { jobId: run }.
async function latestRuns(serverId) {
  try {
    const res = await db.execute({
      sql: `
        SELECT r.* FROM job_runs r
        JOIN (
          SELECT job_id, MAX(started_at) AS mx
          FROM job_runs WHERE server_id = ? GROUP BY job_id
        ) m ON m.job_id = r.job_id AND m.mx = r.started_at
        WHERE r.server_id = ?
      `,
      args: [serverId, serverId],
    })
    const out = {}
    for (const row of res.rows) out[String(row.job_id)] = shapeRun(row)
    return out
  } catch {
    return {}
  }
}

function shapeRun(row) {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    trigger: String(row.trigger),
    status: String(row.status),
    startedAt: Number(row.started_at) || 0,
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    summary: row.summary == null ? null : String(row.summary),
    error: row.error == null ? null : String(row.error),
    itemsProcessed: Number(row.items_processed) || 0,
    itemsTotal: Number(row.items_total) || 0,
  }
}

export async function handleJobs(req, res, url, ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/jobs')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)

  const serverId = getServerId()

  // GET /hs/jobs - list jobs with their latest run + running state.
  if (p === '/hs/jobs' && req.method === 'GET') {
    const runs = await latestRuns(serverId)
    const jobs = JOBS.map((j) => ({
      id: j.id,
      name: j.name,
      description: j.description,
      intervalMs: j.defaultIntervalMs,
      running: isJobRunning(j.id),
      lastRun: runs[j.id] ?? null,
    }))
    return (json(res, 200, { jobs }), true)
  }

  // POST /hs/jobs/:id/run - trigger now.
  const runMatch = p.match(/^\/hs\/jobs\/([^/]+)\/run$/)
  if (runMatch && req.method === 'POST') {
    const jobId = decodeURIComponent(runMatch[1])
    if (!JOBS.some((j) => j.id === jobId)) return (json(res, 404, { error: 'unknown_job' }), true)
    if (isJobRunning(jobId)) return (json(res, 409, { error: 'already_running' }), true)
    const runId = await runJob(jobId, { trigger: 'manual' })
    return (json(res, 202, { runId }), true)
  }

  // GET /hs/jobs/:id/runs - recent runs for a job.
  const runsMatch = p.match(/^\/hs\/jobs\/([^/]+)\/runs$/)
  if (runsMatch && req.method === 'GET') {
    const jobId = decodeURIComponent(runsMatch[1])
    try {
      const r = await db.execute({
        sql: `
          SELECT * FROM job_runs
          WHERE server_id = ? AND job_id = ?
          ORDER BY started_at DESC LIMIT 20
        `,
        args: [serverId, jobId],
      })
      return (json(res, 200, { runs: r.rows.map(shapeRun) }), true)
    } catch {
      return (json(res, 200, { runs: [] }), true)
    }
  }

  // GET /hs/jobs/runs/:runId/logs - the log stream for one run.
  const logsMatch = p.match(/^\/hs\/jobs\/runs\/([^/]+)\/logs$/)
  if (logsMatch && req.method === 'GET') {
    const runId = decodeURIComponent(logsMatch[1])
    try {
      const r = await db.execute({
        sql: `SELECT seq, at, level, message FROM job_run_logs WHERE run_id = ? ORDER BY seq ASC LIMIT 1000`,
        args: [runId],
      })
      const logs = r.rows.map((row) => ({
        seq: Number(row.seq) || 0,
        at: Number(row.at) || 0,
        level: String(row.level),
        message: String(row.message),
      }))
      return (json(res, 200, { logs }), true)
    } catch {
      return (json(res, 200, { logs: [] }), true)
    }
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
