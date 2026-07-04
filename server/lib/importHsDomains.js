// HS-domain merge for the import engine (Phase 4). When the source is a
// .hsarchive, its HS half (a .hsbackup zip) carries the source server's own
// HearthShelf tables. This walks the data-domain registry and merges each
// domain's rows into THIS server's db, re-keyed through the userMap and
// itemMap the ABS import already produced. Policy per domain:
//
//   union  - insert rows not already present (finished_books, book_notes, ...)
//   lww    - per-key last-writer-wins (user_settings, listening_queue)
//   skip   - never merged (rate_limits, aggregates, instance singletons)
//   custom - clubs: union by name, then members/books (asks-first handled by the
//            UI; here we union deterministically)
//
// Rows are re-keyed: user_id columns through userMap; itemRefs columns
// (library_item_id) through the source-item -> target-item map; avatar files are
// renamed to the target key. Only a subset of domains carry cross-server-safe
// data; the rest are skipped with a note.

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import { createClient } from '@libsql/client'
import { pathToFileURL } from 'node:url'
import { db, DB_DIR } from '../db.js'
import { DATA_DOMAINS } from './dataDomains.js'

// Domains we actually merge on a cross-server import, and how. Everything else in
// the registry is 'skip' for import (instance config, caches, aggregates, op
// history) - target wins. This list is intentionally conservative: each entry is
// a table we know how to re-key safely.
const MERGE_HANDLERS = {
  'finished-books': mergeFinishedBooks,
  'book-notes': mergeBookNotes,
  clubs: mergeClubs,
}

// Open the source HS db (extracted from the .hsbackup) read-only.
async function openSourceHsDb(hsBackupBuf) {
  const zip = new AdmZip(hsBackupBuf)
  const entry = zip.getEntry('hearthshelf.db')
  if (!entry) throw new Error('The HearthShelf backup has no database.')
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-hsimport-'))
  const dbPath = path.join(tmpDir, 'hearthshelf.db')
  await fs.writeFile(dbPath, entry.getData())
  const client = createClient({ url: pathToFileURL(dbPath).toString() })
  await client.execute('PRAGMA query_only = ON')
  return { client, tmpDir, zip }
}

// Re-key a source user id to this server's target user id, or null if the user
// wasn't imported (their rows are skipped).
function targetUser(userMap, sourceUserId) {
  return userMap.get(String(sourceUserId))?.targetUserId ?? null
}

// Re-map a source library_item_id to the target one via the source-item -> media
// -> target-item chain the ABS import produced.
function targetItem(srcItemMedia, mediaToTargetItem, sourceItemId) {
  const media = srcItemMedia.get(String(sourceItemId))
  return media ? (mediaToTargetItem.get(media) ?? null) : null
}

// --- per-domain handlers ---------------------------------------------------

async function mergeFinishedBooks(src, tgtServerId, ctx) {
  const rows = await src.execute(`SELECT * FROM finished_books`)
  let written = 0
  for (const r of rows.rows) {
    const userId = targetUser(ctx.userMap, r.user_id)
    if (!userId) continue
    // Re-map the item ref if present (a linked ABS item); a null stays null (a
    // standalone Goodreads/Hardcover stub with no live item).
    let libraryItemId = r.library_item_id != null ? String(r.library_item_id) : null
    if (libraryItemId) libraryItemId = targetItem(ctx.srcItemMedia, ctx.mediaToTargetItem, libraryItemId)
    // Preserve the SOURCE row id as the PK. This makes a re-run idempotent even
    // for standalone rows (library_item_id NULL), where SQLite's UNIQUE index
    // treats NULLs as distinct and so wouldn't dedupe on the UNIQUE key alone.
    // Source ids are UUIDs, so a collision with an unrelated local row can't
    // happen; a genuine same-import re-run hits INSERT OR IGNORE on this PK.
    const id = r.id != null ? String(r.id) : crypto.randomUUID()
    const res = await db.execute({
      sql: `INSERT OR IGNORE INTO finished_books
              (id, server_id, user_id, source, library_item_id, title, author, isbn, date_finished, rating, hardcover_book_id, hardcover_synced_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, tgtServerId, userId, String(r.source ?? 'abs'), libraryItemId,
        String(r.title ?? ''), r.author != null ? String(r.author) : null,
        r.isbn != null ? String(r.isbn) : null, r.date_finished != null ? String(r.date_finished) : null,
        r.rating != null ? Number(r.rating) : null,
        r.hardcover_book_id != null ? String(r.hardcover_book_id) : null,
        r.hardcover_synced_at != null ? Number(r.hardcover_synced_at) : null,
        Number(r.created_at) || Date.now(), Number(r.updated_at) || Date.now(),
      ],
    })
    written += Number(res.rowsAffected) || 0
  }
  return written
}

async function mergeBookNotes(src, tgtServerId, ctx) {
  const rows = await src.execute(`SELECT * FROM book_notes`)
  let written = 0
  for (const r of rows.rows) {
    const userId = targetUser(ctx.userMap, r.user_id)
    if (!userId) continue
    const libraryItemId = targetItem(ctx.srcItemMedia, ctx.mediaToTargetItem, r.library_item_id)
    if (!libraryItemId) continue // note references an item that didn't import
    // Preserve the note id so a re-run is idempotent (INSERT OR IGNORE on PK).
    const res = await db.execute({
      sql: `INSERT OR IGNORE INTO book_notes
              (id, server_id, user_id, username, library_item_id, club_id, visibility, parent_id, time_sec, safe, body, created_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        String(r.id), tgtServerId, userId, String(r.username ?? ''), libraryItemId,
        String(r.club_id ?? ''), String(r.visibility ?? 'public'), String(r.parent_id ?? ''),
        r.time_sec != null ? Number(r.time_sec) : null, Number(r.safe) || 0,
        String(r.body ?? ''), Number(r.created_at) || Date.now(), Number(r.deleted) || 0,
      ],
    })
    written += Number(res.rowsAffected) || 0
  }
  return written
}

async function mergeClubs(src, tgtServerId, ctx) {
  // Union clubs by name: if a club with the same name exists, reuse its id;
  // otherwise create it (preserving created_by re-keyed). Then union members and
  // books. Deterministic (the UI's "ask before combining" is a pre-step).
  const existing = await db.execute({ sql: `SELECT id, name FROM clubs WHERE server_id = ?`, args: [tgtServerId] })
  const byName = new Map(existing.rows.map((r) => [String(r.name).toLowerCase(), String(r.id)]))
  const clubIdMap = new Map() // source club id -> target club id
  let written = 0

  const srcClubs = await src.execute(`SELECT * FROM clubs`)
  for (const c of srcClubs.rows) {
    const nameKey = String(c.name ?? '').toLowerCase()
    let targetClubId = byName.get(nameKey)
    if (!targetClubId) {
      const creator = targetUser(ctx.userMap, c.created_by)
      if (!creator) continue // can't create a club whose owner didn't import
      targetClubId = crypto.randomUUID()
      await db.execute({
        sql: `INSERT INTO clubs (id, server_id, name, created_by, is_open, archived, created_at, rec_basis)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [targetClubId, tgtServerId, String(c.name ?? ''), creator, Number(c.is_open) || 1, Number(c.archived) || 0, Number(c.created_at) || Date.now(), String(c.rec_basis ?? 'club-history')],
      })
      byName.set(nameKey, targetClubId)
      written++
    }
    clubIdMap.set(String(c.id), targetClubId)
  }

  // Members.
  const srcMembers = await src.execute(`SELECT * FROM club_members`)
  for (const m of srcMembers.rows) {
    const targetClubId = clubIdMap.get(String(m.club_id))
    const userId = targetUser(ctx.userMap, m.user_id)
    if (!targetClubId || !userId) continue
    await db.execute({
      sql: `INSERT OR IGNORE INTO club_members (server_id, club_id, user_id, username, role, joined_at, last_read_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [tgtServerId, targetClubId, userId, String(m.username ?? ''), String(m.role ?? 'member'), Number(m.joined_at) || Date.now(), Number(m.last_read_at) || 0],
    })
  }

  // Books (re-map the item ref; skip books whose item didn't import).
  const srcBooks = await src.execute(`SELECT * FROM club_books`)
  for (const b of srcBooks.rows) {
    const targetClubId = clubIdMap.get(String(b.club_id))
    const libraryItemId = targetItem(ctx.srcItemMedia, ctx.mediaToTargetItem, b.library_item_id)
    const addedBy = targetUser(ctx.userMap, b.added_by)
    if (!targetClubId || !libraryItemId) continue
    await db.execute({
      sql: `INSERT OR IGNORE INTO club_books (server_id, club_id, library_item_id, title, author, added_by, started_at, finished_at, queued_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [tgtServerId, targetClubId, libraryItemId, String(b.title ?? ''), String(b.author ?? ''), addedBy || '', Number(b.started_at) || 0, b.finished_at != null ? Number(b.finished_at) : null, b.queued_at != null ? Number(b.queued_at) : null],
    })
  }

  return written
}

// --- entry point -----------------------------------------------------------

export async function mergeHsDomains({ hsBackupBuf, userMap, mediaToTargetItem, sourceItems, serverId }) {
  const { client, tmpDir } = await openSourceHsDb(hsBackupBuf)
  const srcItemMedia = new Map(sourceItems.map((i) => [String(i.libraryItemId), i.mediaId]))
  const ctx = { userMap, mediaToTargetItem, srcItemMedia }
  const merged = {}
  try {
    for (const domain of DATA_DOMAINS) {
      const handler = MERGE_HANDLERS[domain.key]
      if (!handler) continue // skip domains we don't cross-server merge
      try {
        merged[domain.key] = await handler(client, serverId, ctx)
      } catch {
        merged[domain.key] = 0
      }
    }
  } finally {
    try {
      client.close?.()
    } catch {
      /* ignore */
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
  return merged
}
