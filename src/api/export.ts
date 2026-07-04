// Client for the per-user data export (/hs/export/*). Downloads the caller's own
// HearthShelf data (reading history, notes, settings, queue, Discover) as JSON,
// or their finished books as CSV. Self-scoped server-side - no admin needed.

import { useAuthStore } from '@/store/authStore'

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// Fetch a path with the bearer and trigger a browser download of the response,
// using the server's Content-Disposition filename when present.
async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(path, { headers: authHeader() })
  if (!res.ok) throw new Error(`Export failed (${res.status})`)
  const disp = res.headers.get('Content-Disposition') || ''
  const match = disp.match(/filename="([^"]+)"/)
  const filename = match ? match[1] : fallbackName
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportMyDataJson(): Promise<void> {
  return download('/hs/export/me', 'hearthshelf-export.json')
}

export function exportMyFinishedBooksCsv(): Promise<void> {
  return download('/hs/export/me.csv', 'hearthshelf-finished-books.csv')
}
