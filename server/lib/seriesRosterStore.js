// Durable store for the precomputed Audible series roster (the series-roster
// job's output). GLOBAL per HearthShelf instance - "owned" is a library-wide
// fact, not per-user - so rows key on (server_id, lowercased name). The roster
// books carry an `owned` flag the clients read directly. See jobs/seriesRoster.js
// for the producer and routes/audible.js for the consumer.

import { db, getServerId } from '../db.js'

// Persist one series' enriched roster. `books` is the array already stamped with
// owned flags. Upsert so a re-run refreshes in place.
export async function saveSeriesRoster({ name, seriesAsin, seriesTitle, books }) {
  const serverId = await getServerId()
  const nameKey = name.trim().toLowerCase()
  await db.execute({
    sql: `
      INSERT INTO series_roster
        (server_id, name_key, name, series_asin, series_title, books_json, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (server_id, name_key) DO UPDATE SET
        name         = excluded.name,
        series_asin  = excluded.series_asin,
        series_title = excluded.series_title,
        books_json   = excluded.books_json,
        resolved_at  = excluded.resolved_at
    `,
    args: [
      serverId,
      nameKey,
      name,
      seriesAsin ?? null,
      seriesTitle ?? null,
      JSON.stringify(books ?? []),
      Date.now(),
    ],
  })
}

// Read a precomputed roster by series name. Returns the same shape the audible
// route returns ({ name, seriesAsin, seriesTitle, books, resolvedAt }) or null
// when this series hasn't been swept yet.
export async function getSeriesRoster(name) {
  const serverId = await getServerId()
  const nameKey = String(name ?? '')
    .trim()
    .toLowerCase()
  if (!nameKey) return null
  try {
    const res = await db.execute({
      sql: `
        SELECT name, series_asin, series_title, books_json, resolved_at
        FROM series_roster
        WHERE server_id = ? AND name_key = ?
        LIMIT 1
      `,
      args: [serverId, nameKey],
    })
    const row = res.rows[0]
    if (!row) return null
    let books = []
    try {
      books = JSON.parse(String(row.books_json))
    } catch {
      books = []
    }
    return {
      name: String(row.name),
      seriesAsin: row.series_asin == null ? null : String(row.series_asin),
      seriesTitle: row.series_title == null ? undefined : String(row.series_title),
      books: Array.isArray(books) ? books : [],
      resolvedAt: Number(row.resolved_at) || 0,
    }
  } catch {
    return null
  }
}
