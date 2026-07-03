// QuestGiver client API: talks to the in-container backend at /hs/questgiver/*,
// with a deterministic heuristic fallback so the flow never dead-ends when the
// AI provider is unconfigured or unreachable.

import { useAuthStore } from '@/store/authStore'
import {
  qgHeuristic,
  qgCraftPrompt,
  type QgProfile,
  type QgAnswers,
  type QgCandidate,
  type QgResult,
  type QgRenderedPick,
} from '@/lib/questgiver'
import type {
  HSQuestGiverConfig,
  HSQuestGiverConfigEnvLocks,
  HSQuestGiverAdminConfig,
  HSQuestGiverAdminConfigUpdate,
} from '@hearthshelf/core'

export type QgConfig = HSQuestGiverConfig

async function qgFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token
  const res = await fetch(`/hs/questgiver${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`QG ${res.status}`)
  return res.json() as Promise<T>
}

export async function getQgConfig(): Promise<QgConfig> {
  try {
    return await qgFetch<QgConfig>('/config')
  } catch {
    // Backend unreachable (e.g. local dev without the node service running).
    // Keep the feature on so the heuristic flow still works; AI is just off.
    return {
      featureEnabled: true,
      discoverEnabled: true,
      enabled: false,
      provider: null,
      model: null,
      limit: null,
      remaining: null,
      period: null,
    }
  }
}

// --- Admin: editable AI config (provider/model/key/limit/enabled) ---

// Per-field env locks: true = the value is pinned by an environment variable, so
// it overrides the database and is read-only in the UI.
export type QgEnvLocks = HSQuestGiverConfigEnvLocks
export type QgAdminConfig = HSQuestGiverAdminConfig
export type QgAdminConfigPatch = HSQuestGiverAdminConfigUpdate

export function getQgAdminConfig(): Promise<QgAdminConfig> {
  return qgFetch<QgAdminConfig>('/admin/config')
}

export function saveQgAdminConfig(patch: QgAdminConfigPatch): Promise<QgAdminConfig> {
  return qgFetch<QgAdminConfig>('/admin/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

// Get a recommendation. Tries the AI backend; on any failure (unconfigured,
// rate-limited, provider error, network) falls back to the local heuristic.
export async function qgRecommend(
  profile: QgProfile,
  answers: QgAnswers,
  candidates: QgCandidate[],
): Promise<QgResult & { remaining?: number | null }> {
  try {
    const prompt = qgCraftPrompt(profile, answers, candidates)
    const data = await qgFetch<{
      intro: string
      picks: { id: string; reason: string }[]
      newPicks: { title: string; author: string; genre: string; hours: number; reason: string }[]
      remaining?: number | null
    }>('/recommend', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    })
    return {
      intro: data.intro,
      picks: data.picks,
      newPicks: data.newPicks ?? [],
      engine: 'ai',
      remaining: data.remaining ?? null,
    }
  } catch {
    // Heuristic fallback - deterministic, no backend needed.
    return { ...qgHeuristic(profile, answers, candidates), engine: 'heuristic' }
  }
}

// --- Client-only persistence (run history, feedback, usage display) ---

export interface QgRun {
  id: string
  label: string
  when: string // human-readable timestamp, stamped at save time
  engine: 'ai' | 'heuristic'
  intro: string
  picks: QgRenderedPick[]
}
export interface QgFeedback {
  vote?: 1 | -1
  note?: string
}

const RUNS_KEY = 'hs_qg_runs'
const FEEDBACK_KEY = 'hs_qg_feedback'

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full / disabled - non-fatal */
  }
}

export function getRuns(): QgRun[] {
  return read<QgRun[]>(RUNS_KEY, [])
}
export function saveRun(run: QgRun): QgRun[] {
  const runs = [run, ...getRuns()].slice(0, 30) // cap at 30
  write(RUNS_KEY, runs)
  // Mirror to the server so history follows the user across devices. Best
  // effort - localStorage already holds it if the backend is unreachable.
  qgFetch('/runs', { method: 'POST', body: JSON.stringify({ run }) }).catch(() => {})
  return runs
}

// Pull the server-side run history (cross-device). Falls back to the local
// cache when the backend is unreachable.
export async function fetchServerRuns(): Promise<QgRun[]> {
  try {
    const data = await qgFetch<{ runs: QgRun[] }>('/runs')
    if (Array.isArray(data.runs)) {
      write(RUNS_KEY, data.runs.slice(0, 30))
      return data.runs
    }
  } catch {
    /* offline - keep the local cache */
  }
  return getRuns()
}

export function getFeedback(): Record<string, QgFeedback> {
  return read<Record<string, QgFeedback>>(FEEDBACK_KEY, {})
}
export function setFeedback(key: string, fb: QgFeedback): Record<string, QgFeedback> {
  const all = getFeedback()
  all[key.toLowerCase()] = { ...all[key.toLowerCase()], ...fb }
  write(FEEDBACK_KEY, all)
  return all
}
