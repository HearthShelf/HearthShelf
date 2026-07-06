// Admin client for the scheduled-jobs system (/hs/jobs/*). Same shape as the
// other /hs clients (audible.ts): same-origin fetch with the bearer token. All
// endpoints are admin-only server-side.

import { useAuthStore } from '@/store/authStore'

export interface JobRun {
  id: string
  jobId: string
  trigger: 'schedule' | 'manual'
  status: 'running' | 'ok' | 'error'
  startedAt: number
  finishedAt: number | null
  summary: string | null
  error: string | null
  itemsProcessed: number
  itemsTotal: number
}

export interface JobSummary {
  id: string
  name: string
  description: string
  intervalMs: number
  running: boolean
  lastRun: JobRun | null
}

export interface JobLogLine {
  seq: number
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export const jobKeys = {
  list: ['jobs', 'list'] as const,
  runs: (id: string) => ['jobs', 'runs', id] as const,
  logs: (runId: string) => ['jobs', 'logs', runId] as const,
}

async function hsFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/jobs${path}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`Jobs ${res.status}`)
  return res.json() as Promise<T>
}

export async function getJobs(): Promise<{ jobs: JobSummary[] }> {
  return hsFetch('')
}

export async function runJobNow(id: string): Promise<{ runId: string | null }> {
  return hsFetch(`/${encodeURIComponent(id)}/run`, { method: 'POST' })
}

export async function cancelJob(id: string): Promise<{ runId: string | null }> {
  return hsFetch(`/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

export async function getJobRuns(id: string): Promise<{ runs: JobRun[] }> {
  return hsFetch(`/${encodeURIComponent(id)}/runs`)
}

export async function getRunLogs(runId: string): Promise<{ logs: JobLogLine[] }> {
  return hsFetch(`/runs/${encodeURIComponent(runId)}/logs`)
}
