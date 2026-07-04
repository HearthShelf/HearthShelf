// Admin client for HearthShelf's own backups + the .hsarchive format
// (/hs/backups/*, /hs/archive/*). Same-origin fetch with the bearer token, like
// the other /hs clients (jobs.ts). All endpoints are admin-only server-side.

import { useAuthStore } from '@/store/authStore'
import type {
  HsBackupsResponse,
  HsBackupConfig,
  HsArchiveEstimate,
  ArchiveRestoreMode,
} from '@hearthshelf/core'

export const backupKeys = {
  list: ['hs', 'backups'] as const,
  archiveEstimate: ['hs', 'archive', 'estimate'] as const,
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
  if (!res.ok) throw new Error(`Backups ${res.status}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

// --- HS backups ---

export function getHsBackups(): Promise<HsBackupsResponse> {
  return hsJson('/hs/backups')
}

export function runHsBackup(): Promise<{ runId: string | null }> {
  return hsJson('/hs/backups', { method: 'POST' })
}

export function setHsBackupConfig(
  patch: Partial<Pick<HsBackupConfig, 'schedule' | 'keep' | 'offBoxPath'>>,
): Promise<{ config: HsBackupConfig }> {
  return hsJson('/hs/backups/config', { method: 'PUT', body: JSON.stringify(patch) })
}

export function deleteHsBackup(id: string): Promise<{ ok: boolean }> {
  return hsJson(`/hs/backups/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function downloadHsBackup(id: string): Promise<Blob> {
  const res = await fetch(`/hs/backups/${encodeURIComponent(id)}/download`, {
    headers: authHeader(),
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  return res.blob()
}

// The .hsbackup is uploaded as the raw request body (the backend reads bytes,
// not multipart - keeps it dependency-free, matches the avatar upload).
export async function uploadHsBackup(file: File): Promise<void> {
  const res = await fetch('/hs/backups/upload', {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/zip' },
    body: file,
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.detail ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Upload failed (${res.status})`)
  }
}

export interface HsRestoreResult {
  ok: boolean
  crossServer?: boolean
  backupServerId?: string
  escapeDir?: string
}

export function restoreHsBackup(id: string): Promise<HsRestoreResult> {
  return hsJson(`/hs/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' })
}

// --- .hsarchive ---

export function getArchiveEstimate(): Promise<HsArchiveEstimate> {
  return hsJson('/hs/archive/estimate')
}

// Build + download the full-server archive. Returns the blob + suggested name.
export async function downloadArchive(): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch('/hs/archive', { method: 'POST', headers: authHeader() })
  if (!res.ok) throw new Error(`Archive failed (${res.status})`)
  const disp = res.headers.get('Content-Disposition') || ''
  const match = disp.match(/filename="([^"]+)"/)
  const filename = match ? match[1] : 'hearthshelf.hsarchive'
  return { blob: await res.blob(), filename }
}

export async function restoreArchive(file: File, mode: ArchiveRestoreMode): Promise<HsRestoreResult> {
  const res = await fetch(`/hs/archive/restore?mode=${encodeURIComponent(mode)}`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/zip' },
    body: file,
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.detail ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Restore failed (${res.status})`)
  }
  return res.json()
}

// A helper the UI uses to save a blob to the user's disk.
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
