// Admin client for the import/merge engine (/hs/import/*). Same-origin fetch
// with the bearer token, like the other /hs clients. Admin-only server-side.

import { useAuthStore } from '@/store/authStore'
import type { ImportReport, ImportResult, ImportMode, UserMatch } from '@hearthshelf/core'

export const importKeys = {
  runs: ['hs', 'import', 'runs'] as const,
  run: (id: string) => ['hs', 'import', 'run', id] as const,
}

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function hsJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...authHeader(),
      ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { detail?: string })?.detail ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Import ${res.status}`)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export interface ImportRunSummary {
  id: string
  mode: ImportMode
  sourceKind: 'live' | 'archive' | 'backup'
  status: 'dry-run' | 'executing' | 'done' | 'error'
  createdAt: number
  updatedAt: number
}

export function listImportRuns(): Promise<{ runs: ImportRunSummary[] }> {
  return hsJson('/hs/import/runs')
}

export function getImportRun(
  id: string,
): Promise<{ report: ImportReport | null; status: string; result: ImportResult | null }> {
  return hsJson(`/hs/import/runs/${encodeURIComponent(id)}`)
}

// Dry-run from an uploaded file (.hsarchive / .audiobookshelf). Options ride in
// the query string; the raw file is the body.
export async function inspectUpload(
  file: File,
  opts: { mode: ImportMode; allowInode?: boolean; userSubset?: string[] },
): Promise<ImportReport> {
  const params = new URLSearchParams({ mode: opts.mode })
  if (opts.allowInode) params.set('allowInode', '1')
  if (opts.userSubset?.length) params.set('userSubset', opts.userSubset.join(','))
  return hsJson(`/hs/import/inspect?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  })
}

// Dry-run from a live source (ABS URL + admin token).
export function inspectLive(opts: {
  mode: ImportMode
  absUrl: string
  adminToken: string
  allowInode?: boolean
}): Promise<ImportReport> {
  return hsJson('/hs/import/inspect', {
    method: 'POST',
    body: JSON.stringify({
      mode: opts.mode,
      allowInode: opts.allowInode,
      source: { absUrl: opts.absUrl, adminToken: opts.adminToken },
    }),
  })
}

// Execute a report, optionally overriding the proposed user mappings.
export function executeImport(
  reportId: string,
  userOverrides?: Pick<UserMatch, 'sourceUserId' | 'action' | 'targetUserId'>[],
): Promise<ImportResult> {
  return hsJson('/hs/import/execute', {
    method: 'POST',
    body: JSON.stringify({ reportId, users: userOverrides ?? [] }),
  })
}
