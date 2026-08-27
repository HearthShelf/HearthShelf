// Durable store for the precomputed Audible series roster (the series-roster
// job's output). GLOBAL per HearthShelf instance - "owned" is a library-wide
// fact, not per-user - so rows key on (server_id, series_id).
//
// Keyed by ABS's series id, NOT the name: two distinct series can share a name
// (Karevik's "Accidental Champion" vs Herzman's), and a name key made one
// overwrite the other. The roster books carry an `owned` flag the clients read
// directly. See jobs/seriesRoster.js for the producer and routes/audible.js for
// the consumer.

import { db, getServerId } from '../db.js'
import { realRosterBooks } from '@hearthshelf/core/lib/series'
import { isUpcoming } from '@hearthshelf/core/lib/notifications'

function parseBooks(raw) {
  try {
    const books = JSON.parse(String(raw))
    return Array.isArray(books) ? books : []
  } catch {
    return []
  }
}

function rowToRoster(row) {
  return {
    seriesId: String(row.series_id),
    name: String(row.name),
    seriesAsin: row.series_asin == null ? null : String(row.series_asin),
    seriesTitle: row.series_title == null ? undefined : String(row.series_title),
    books: parseBooks(row.books_json),
    resolvedAt: Number(row.resolved_at) || 0,
  }
}

// Persist one series' enriched roster. `books` is the array already stamped with
// owned flags. Upsert so a re-run refreshes in place.
export async function saveSeriesRoster({ seriesId, name, seriesAsin, seriesTitle, books }) {
  if (!seriesId) return
  const serverId = await getServerId()
  await db.execute({
    sql: `
      INSERT INTO series_roster
        (server_id, series_id, name, series_asin, series_title, books_json, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (server_id, series_id) DO UPDATE SET
        name         = excluded.name,
        series_asin  = excluded.series_asin,
        series_title = excluded.series_title,
        books_json   = excluded.books_json,
        resolved_at  = excluded.resolved_at
    `,
    args: [
      serverId,
      String(seriesId),
      name,
      seriesAsin ?? null,
      seriesTitle ?? null,
      JSON.stringify(books ?? []),
      Date.now(),
    ],
  })
}

// Read a precomputed roster by ABS series id - the precise lookup. Returns
// null when this series hasn't been swept yet.
export async function getSeriesRosterById(seriesId) {
  const id = String(seriesId ?? '').trim()
  if (!id) return null
  const serverId = await getServerId()
  try {
    const res = await db.execute({
      sql: `
        SELECT series_id, name, series_asin, series_title, books_json, resolved_at
        FROM series_roster
        WHERE server_id = ? AND series_id = ?
        LIMIT 1
      `,
      args: [serverId, id],
    })
    const row = res.rows[0]
    return row ? rowToRoster(row) : null
  } catch {
    return null
  }
}

// Read a precomputed roster by its resolved Audible series ASIN. Precise (the
// ASIN identifies the Audible series), used by the release-notify job, whose
// stored subscriptions carry the ASIN rather than an ABS series id.
export async function getSeriesRosterByAsin(seriesAsin) {
  const asin = String(seriesAsin ?? '').trim()
  if (!asin) return null
  const serverId = await getServerId()
  try {
    const res = await db.execute({
      sql: `
        SELECT series_id, name, series_asin, series_title, books_json, resolved_at
        FROM series_roster
        WHERE server_id = ? AND lower(series_asin) = ?
        LIMIT 1
      `,
      args: [serverId, asin.toLowerCase()],
    })
    const row = res.rows[0]
    return row ? rowToRoster(row) : null
  } catch {
    return null
  }
}

// Read a precomputed roster by series NAME. Ambiguous by nature - two series can
// share a name - so this returns null when the name matches more than one row
// rather than guessing wrong. Callers that know the ABS series id should use
// getSeriesRosterById; this exists for callers that only have a name (the
// release-notify job's stored subscriptions, and older clients that send only
// ?q=<name>).
export async function getSeriesRoster(name) {
  const nameKey = String(name ?? '')
    .trim()
    .toLowerCase()
  if (!nameKey) return null
  const serverId = await getServerId()
  try {
    const res = await db.execute({
      sql: `
        SELECT series_id, name, series_asin, series_title, books_json, resolved_at
        FROM series_roster
        WHERE server_id = ? AND lower(trim(name)) = ?
        LIMIT 2
      `,
      args: [serverId, nameKey],
    })
    // More than one series carries this name: no way to pick correctly from a
    // name alone, and guessing is exactly the bug this re-key removed.
    if (res.rows.length !== 1) return null
    return rowToRoster(res.rows[0])
  } catch {
    return null
  }
}

// Every stored roster reduced to counts, for the library's series grid.
//
// The grid needs one fact per series - "you own 9 of 15, and 1 more is coming" -
// for potentially hundreds of series at once. Reading the full rosters to do
// that would ship megabytes of book JSON to render a badge, so the reduction
// happens here and only the counts travel.
//
// STORED ROWS ONLY. A series the nightly sweep hasn't reached is simply absent
// from the result, and the grid then shows it exactly as it does today (owned
// count, no badge). That is the deliberate trade: a page of the library must
// never trigger hundreds of live Audible resolves.
//
// Counting goes through Core's realRosterBooks so the grid agrees with the
// series detail page - it drops phantom placeholders, unsequenced stubs and
// duplicate editions. Counting raw books_json would re-inflate every series with
// exactly the junk that filtering exists to remove.
export async function getSeriesRosterSummaries() {
  const serverId = await getServerId()
  let rows
  try {
    const res = await db.execute({
      sql: `
        SELECT series_id, name, series_asin, series_title, books_json, resolved_at
        FROM series_roster
        WHERE server_id = ?
      `,
      args: [serverId],
    })
    rows = res.rows
  } catch {
    return []
  }

  const now = Date.now()
  const out = []
  for (const row of rows) {
    const roster = rowToRoster(row)
    if (!roster.seriesAsin) continue // unresolved: nothing to say about gaps
    const books = realRosterBooks(roster.books, [], roster.name)
    let missing = 0
    let upcoming = 0
    for (const book of books) {
      // An unreleased book is not a gap in the library - nobody could own it.
      // Counting it as missing would leave a caught-up series permanently
      // incomplete, so it is reported on its own axis instead.
      if (book.upcoming ?? isUpcoming(book, now)) {
        upcoming++
        continue
      }
      if (book.owned === false) missing++
    }
    out.push({
      seriesId: roster.seriesId,
      total: books.length,
      missing,
      upcoming,
      resolvedAt: roster.resolvedAt,
    })
  }
  return out
}
