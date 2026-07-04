// Per-user data export (Phase 5). A user downloads everything HearthShelf holds
// that's theirs and has no ABS equivalent - reading history (incl. Goodreads/
// Hardcover imports), notes, settings, queue, Discover feedback - as a plain
// JSON file, with finished books also as CSV. This is the secret-free, no-admin
// trust surface (contrast the admin server backup, which carries secrets). See
// docs/data-lifecycle/merge-engine.md (M5) + data-inventory.md.
//
// Driven by the data-domain registry: it walks every domain with
// `userExport: true`, reads that user's rows, and strips any `secretColumns`.
// Adding an exportable feature = flipping userExport on its domain; this code
// picks it up with no change.

import { db, getServerId } from '../db.js'
import { DATA_DOMAINS } from './dataDomains.js'
import { HS_VERSION } from './hsVersion.js'

// Read one user's rows from a table, filtered by (server_id, user_id), with the
// domain's secret columns removed. Returns [] on any failure (a missing table
// contributes nothing rather than failing the whole export).
async function readUserTable(table, serverId, userId, secretCols) {
  try {
    const r = await db.execute({
      sql: `SELECT * FROM ${table} WHERE server_id = ? AND user_id = ?`,
      args: [serverId, userId],
    })
    const secret = new Set(secretCols ?? [])
    return r.rows.map((row) => {
      const out = {}
      for (const [k, v] of Object.entries(row)) {
        if (secret.has(k)) continue
        out[k] = v
      }
      return out
    })
  } catch {
    return []
  }
}

// Build the full export object for a user. `username` is snapshotted into the
// manifest for a human-readable file. Returns { manifest, domains } where
// domains is { <domainKey>: { <table>: rows[] } }.
export async function buildUserExport(userId, username) {
  const serverId = await getServerId()
  const domains = {}
  let totalRows = 0

  for (const domain of DATA_DOMAINS) {
    if (!domain.userExport) continue
    const tables = {}
    for (const table of domain.tables) {
      const rows = await readUserTable(table, serverId, userId, domain.secretColumns?.[table])
      if (rows.length) {
        tables[table] = rows
        totalRows += rows.length
      }
    }
    if (Object.keys(tables).length) domains[domain.key] = tables
  }

  const manifest = {
    format: 'hearthshelf-user-export',
    formatVersion: 1,
    exportedAt: Date.now(),
    hsVersion: HS_VERSION,
    serverId,
    user: { id: userId, username: username || null },
    totalRows,
    note: 'Your HearthShelf data. Your library, listening progress, and account live in AudiobookShelf - this is only the HearthShelf-specific data (reading history, notes, settings). No passwords or secrets are included.',
  }

  return { manifest, domains }
}

// A CSV of the user's finished books (the piece people most want portable). One
// row per finished book; header first. Values are quoted + escaped. Empty (just
// the header) when they've finished nothing.
export function finishedBooksCsv(exportObj) {
  const rows = exportObj.domains['finished-books']?.finished_books ?? []
  const cols = ['title', 'author', 'isbn', 'source', 'date_finished', 'rating']
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [cols.join(',')]
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','))
  return lines.join('\n')
}
