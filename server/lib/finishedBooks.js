// Unified "finished books" store. See db.js's finished_books/hardcover_accounts
// comments for the shape and why a row can be a stub (no library_item_id).
//
// Three things feed this table, never overwriting each other in place:
//   - 'abs'       rows come from ABS's own mediaProgress.isFinished (syncAbsFinished)
//   - 'goodreads' rows come from a reviewed CSV import (upsertGoodreadsRows)
//   - 'hardcover' rows would come from a future pull-sync (not built yet)
// The UNIQUE(server_id, user_id, source, library_item_id, title) constraint
// means re-running an import or a reconcile updates the existing row for that
// source instead of duplicating it; it does NOT merge across sources, so the
// same book finished via ABS and also present in a Goodreads import shows as
// two rows. That's intentional for v1 - collapsing sources is a UI concern,
// not a storage one.

import crypto from 'node:crypto'
import { db, initDb } from '../db.js'

function rowToFinishedBook(r) {
  return {
    id: String(r.id),
    source: String(r.source),
    libraryItemId: r.library_item_id ? String(r.library_item_id) : null,
    title: String(r.title),
    author: r.author ? String(r.author) : null,
    isbn: r.isbn ? String(r.isbn) : null,
    dateFinished: r.date_finished ? String(r.date_finished) : null,
    rating: r.rating == null ? null : Number(r.rating),
    hardcoverBookId: r.hardcover_book_id ? String(r.hardcover_book_id) : null,
    hardcoverSyncedAt: r.hardcover_synced_at == null ? null : Number(r.hardcover_synced_at),
    absSyncedAt: r.abs_synced_at == null ? null : Number(r.abs_synced_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export async function listFinishedBooks(serverId, userId) {
  await initDb()
  const r = await db.execute({
    sql: `SELECT * FROM finished_books WHERE server_id = ? AND user_id = ? ORDER BY date_finished DESC, updated_at DESC`,
    args: [serverId, userId],
  })
  return r.rows.map(rowToFinishedBook)
}

// Upsert one row keyed on (server_id, user_id, source, library_item_id, title).
// library_item_id is normalized to '' for the UNIQUE key (SQLite treats NULL
// as distinct in every row, which would defeat the constraint for stubs).
async function upsertRow(serverId, userId, source, row) {
  const now = Date.now()
  const libraryItemId = row.libraryItemId || null
  const keyLibraryItemId = libraryItemId ?? ''
  const existing = await db.execute({
    sql: `SELECT id, library_item_id, date_finished FROM finished_books
          WHERE server_id = ? AND user_id = ? AND source = ?
            AND COALESCE(library_item_id, '') = ? AND title = ?`,
    args: [serverId, userId, source, keyLibraryItemId, row.title],
  })
  if (existing.rows[0]?.id) {
    // If the match or the finish date changed, the ABS backfill is stale - clear
    // abs_synced_at so the row is re-written to ABS with the corrected data.
    const prevItem = existing.rows[0].library_item_id ? String(existing.rows[0].library_item_id) : null
    const prevDate = existing.rows[0].date_finished ? String(existing.rows[0].date_finished) : null
    const resyncNeeded = prevItem !== libraryItemId || prevDate !== (row.dateFinished || null)
    await db.execute({
      sql: `UPDATE finished_books SET
              library_item_id = ?, author = ?, isbn = ?, date_finished = ?, rating = ?, updated_at = ?${
                resyncNeeded ? ', abs_synced_at = NULL' : ''
              }
            WHERE id = ?`,
      args: [
        libraryItemId,
        row.author || null,
        row.isbn || null,
        row.dateFinished || null,
        row.rating ?? null,
        now,
        existing.rows[0].id,
      ],
    })
    return { id: String(existing.rows[0].id), inserted: false }
  }
  const id = crypto.randomUUID()
  await db.execute({
    sql: `INSERT INTO finished_books
            (id, server_id, user_id, source, library_item_id, title, author, isbn, date_finished, rating, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      serverId,
      userId,
      source,
      libraryItemId,
      row.title,
      row.author || null,
      row.isbn || null,
      row.dateFinished || null,
      row.rating ?? null,
      now,
      now,
    ],
  })
  return { id, inserted: true }
}

// Commit reviewed Goodreads rows. Each row is already resolved by the client
// (definite libraryItemId or null for a stub) - this never re-runs matching.
export async function upsertGoodreadsRows(serverId, userId, rows) {
  await initDb()
  let inserted = 0
  let updated = 0
  for (const row of rows) {
    if (!row?.title) continue
    const result = await upsertRow(serverId, userId, 'goodreads', row)
    if (result.inserted) inserted++
    else updated++
  }
  return { inserted, updated }
}

// Reconcile ABS's own finished status into the store. `mediaProgress` is the
// array from /api/me (entries with isFinished true), paired with minimal item
// metadata (title/author) the caller already has from the library listing.
export async function syncAbsFinished(serverId, userId, finishedItems) {
  await initDb()
  let inserted = 0
  for (const item of finishedItems) {
    if (!item?.libraryItemId || !item?.title) continue
    const result = await upsertRow(serverId, userId, 'abs', {
      libraryItemId: item.libraryItemId,
      title: item.title,
      author: item.author || null,
      isbn: item.isbn || null,
      dateFinished: item.dateFinished || null,
      rating: null,
    })
    if (result.inserted) inserted++
  }
  return { inserted }
}

export async function getHardcoverAccount(serverId, userId) {
  await initDb()
  const r = await db.execute({
    sql: `SELECT username, last_sync_at, last_sync_status, last_sync_error FROM hardcover_accounts
          WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  const row = r.rows[0]
  return {
    connected: Boolean(row),
    username: row?.username ? String(row.username) : null,
    lastSyncAt: row?.last_sync_at == null ? null : Number(row.last_sync_at),
    lastSyncStatus: row?.last_sync_status ? String(row.last_sync_status) : null,
    lastSyncError: row?.last_sync_error ? String(row.last_sync_error) : null,
  }
}

// Internal: the raw token for the sync engine. Never exposed to a route's
// JSON response.
export async function getHardcoverToken(serverId, userId) {
  await initDb()
  const r = await db.execute({
    sql: `SELECT token FROM hardcover_accounts WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  return r.rows[0]?.token ? String(r.rows[0].token) : null
}

export async function setHardcoverToken(serverId, userId, token, username) {
  await initDb()
  const now = Date.now()
  await db.execute({
    sql: `INSERT INTO hardcover_accounts (server_id, user_id, token, username, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (server_id, user_id) DO UPDATE SET
            token = excluded.token, username = excluded.username, updated_at = excluded.updated_at`,
    args: [serverId, userId, token, username || null, now],
  })
}

export async function clearHardcoverAccount(serverId, userId) {
  await initDb()
  await db.execute({
    sql: `DELETE FROM hardcover_accounts WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
}

export async function setHardcoverSyncResult(serverId, userId, status, error) {
  await initDb()
  await db.execute({
    sql: `UPDATE hardcover_accounts SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?
          WHERE server_id = ? AND user_id = ?`,
    args: [Date.now(), status, error || null, serverId, userId],
  })
}

// Rows still needing a push to Hardcover for this user.
export async function getUnsyncedFinishedBooks(serverId, userId) {
  await initDb()
  const r = await db.execute({
    sql: `SELECT * FROM finished_books WHERE server_id = ? AND user_id = ? AND hardcover_synced_at IS NULL`,
    args: [serverId, userId],
  })
  return r.rows.map(rowToFinishedBook)
}

export async function markHardcoverSynced(id, hardcoverBookId) {
  await initDb()
  await db.execute({
    sql: `UPDATE finished_books SET hardcover_book_id = ?, hardcover_synced_at = ?, updated_at = ? WHERE id = ?`,
    args: [hardcoverBookId, Date.now(), Date.now(), id],
  })
}

// Rows whose finish has not yet been written back into ABS's mediaProgress.
// Two callers want different subsets:
//   matchedOnly=true  -> only rows already linked to a library item (the
//                        import path writes these as the caller, no re-match)
//   matchedOnly=false -> also stub rows (no library_item_id) for the promotion
//                        job to re-match against a now-larger library
export async function getUnsyncedAbsFinishedBooks(serverId, userId, matchedOnly = false) {
  await initDb()
  const r = await db.execute({
    sql: `SELECT * FROM finished_books
          WHERE server_id = ? AND user_id = ? AND abs_synced_at IS NULL
            AND date_finished IS NOT NULL${matchedOnly ? ' AND library_item_id IS NOT NULL' : ''}`,
    args: [serverId, userId],
  })
  return r.rows.map(rowToFinishedBook)
}

export async function markAbsSynced(id) {
  await initDb()
  await db.execute({
    sql: `UPDATE finished_books SET abs_synced_at = ?, updated_at = ? WHERE id = ?`,
    args: [Date.now(), Date.now(), id],
  })
}

// Distinct (server_id, user_id) pairs that have at least one finished_books row
// still needing an ABS backfill (a dated stub to re-match, or a matched row whose
// finish hasn't reached ABS yet). Drives the promotion job's per-user loop.
export async function getUsersWithPendingAbsBackfill() {
  await initDb()
  const r = await db.execute(
    `SELECT DISTINCT server_id, user_id FROM finished_books
     WHERE abs_synced_at IS NULL AND date_finished IS NOT NULL`,
  )
  return r.rows.map((row) => ({ serverId: String(row.server_id), userId: String(row.user_id) }))
}

// The promotion job resolves a stub against the library: attach a library_item_id
// and clear any stale ABS sync stamp. Keeps the row's identity (id/title/date).
export async function attachLibraryItem(id, libraryItemId) {
  await initDb()
  await db.execute({
    sql: `UPDATE finished_books SET library_item_id = ?, abs_synced_at = NULL, updated_at = ? WHERE id = ?`,
    args: [libraryItemId, Date.now(), id],
  })
}
