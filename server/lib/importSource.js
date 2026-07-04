// Import sources for the merge engine (Phase 4). A "source" is another ABS
// install we're importing users + histories FROM. Three kinds, all yielding the
// SAME inventory shape so the engine downstream is source-agnostic:
//
//   - 'backup'  : a bare .audiobookshelf zip -> extract absdatabase.sqlite ->
//                 read it read-only (readImportInventory). Also the HS-half
//                 reader for an archive's clubs/notes/etc.
//   - 'archive' : a .hsarchive -> its ABS half is a backup (above); its HS half
//                 (backup.hsbackup) carries the source's HearthShelf tables.
//   - 'live'    : a running ABS URL + admin token -> admin API. Users come from
//                 GET /api/users (minimal), progress + bookmarks from
//                 GET /api/users/:id per user (getAll omits them). N+1 but needs
//                 only an admin token; backup sources are cheaper.
//
// Inventory shape (matches @hearthshelf/core MatchItem / MatchUser / ProgressRow /
// BookmarkRow families): { serverId, serverName, users, items, progress,
// bookmarks, hsBackupBuf }.

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import { openAbsDbReadonly, readImportInventory } from './absdb.js'

// Extract absdatabase.sqlite from an ABS backup zip buffer to a temp file, read
// the inventory read-only, then clean up. Returns the inventory (no serverId -
// ABS backups don't carry one we can trust; the caller supplies context).
async function readAbsBackupBuffer(absZipBuf) {
  let zip
  try {
    zip = new AdmZip(absZipBuf)
  } catch {
    throw new Error('The AudiobookShelf backup is not a valid archive.')
  }
  const entry = zip.getEntry('absdatabase.sqlite')
  if (!entry) throw new Error('That backup has no absdatabase.sqlite - not an AudiobookShelf backup.')

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-import-'))
  const dbPath = path.join(tmpDir, 'absdatabase.sqlite')
  await fs.writeFile(dbPath, entry.getData())
  let client
  try {
    client = await openAbsDbReadonly(dbPath)
    const inv = await readImportInventory(client)
    return inv
  } finally {
    try {
      client?.close?.()
    } catch {
      /* ignore */
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// Read an import source from an uploaded buffer. Classifies archive vs bare ABS
// backup (same test as restoreOnboarding), pulls the ABS inventory, and for an
// archive also returns the HS-half buffer so the HS-domain merge can read it.
export async function readUploadedSource(buf) {
  let zip
  try {
    zip = new AdmZip(buf)
  } catch {
    throw new Error('That file is not a valid archive.')
  }

  // Archive? (manifest.json with format hsarchive)
  const mfEntry = zip.getEntry('manifest.json')
  let archiveManifest = null
  if (mfEntry) {
    try {
      const parsed = JSON.parse(zip.readAsText(mfEntry))
      if (parsed?.format === 'hsarchive') archiveManifest = parsed
    } catch {
      /* not an archive manifest */
    }
  }

  if (archiveManifest) {
    const absEntry = zip.getEntry('abs/backup.audiobookshelf')
    const hsEntry = zip.getEntry('hs/backup.hsbackup')
    if (!absEntry) {
      throw new Error('This archive has no AudiobookShelf data to import.')
    }
    const inv = await readAbsBackupBuffer(absEntry.getData())
    return {
      kind: 'archive',
      serverId: archiveManifest.source?.serverId ?? null,
      serverName: archiveManifest.source?.serverName ?? null,
      hsBackupBuf: hsEntry ? hsEntry.getData() : null,
      ...inv,
    }
  }

  // Bare ABS backup?
  if (zip.getEntry('absdatabase.sqlite')) {
    const inv = await readAbsBackupBuffer(buf)
    return { kind: 'backup', serverId: null, serverName: null, hsBackupBuf: null, ...inv }
  }

  throw new Error('That file is neither a HearthShelf archive nor an AudiobookShelf backup.')
}

// Read a LIVE ABS source over its admin API. `absUrl` + `adminToken` identify
// the source server. Users from GET /api/users; progress + bookmarks from
// GET /api/users/:id per user (getAll omits them). Items from the library item
// listing. Returns the same inventory shape (no hsBackupBuf - a live source's HS
// data would come from a separate HS export, out of scope for the live path).
export async function readLiveSource(absUrl, adminToken) {
  const base = absUrl.replace(/\/$/, '')
  const auth = { Authorization: `Bearer ${adminToken}` }
  const getJson = async (p) => {
    const res = await fetch(`${base}${p}`, { headers: auth })
    if (!res.ok) throw new Error(`Source server returned ${res.status} for ${p}`)
    return res.json()
  }

  // Users (minimal).
  const usersData = await getJson('/api/users')
  const rawUsers = Array.isArray(usersData?.users) ? usersData.users : []
  const users = rawUsers.map((u) => ({
    id: String(u.id),
    username: u.username != null ? String(u.username) : '',
    email: u.email != null ? String(u.email) : null,
    type: u.type != null ? String(u.type) : 'user',
    isActive: u.isActive == null ? true : Boolean(u.isActive),
  }))

  // Items: enumerate every library's items (minified carries media ids + metadata).
  const librariesData = await getJson('/api/libraries')
  const libraries = Array.isArray(librariesData?.libraries) ? librariesData.libraries : []
  const items = []
  for (const lib of libraries) {
    let page = 0
    // Page through the library items (ABS paginates). minified=1 keeps it light.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await getJson(`/api/libraries/${lib.id}/items?minified=1&limit=500&page=${page}`)
      const results = Array.isArray(data?.results) ? data.results : []
      for (const it of results) {
        const media = it.media ?? {}
        const meta = media.metadata ?? {}
        items.push({
          libraryItemId: String(it.id),
          mediaId: media.id != null ? String(media.id) : '',
          title: String(meta.title ?? it.title ?? ''),
          author: meta.authorName != null ? String(meta.authorName) : (meta.authors?.[0]?.name ?? null),
          asin: meta.asin != null && String(meta.asin) !== '' ? String(meta.asin) : null,
          isbn: meta.isbn != null && String(meta.isbn) !== '' ? String(meta.isbn) : null,
          ino: it.ino != null && String(it.ino) !== '' ? String(it.ino) : null,
          isPodcast: String(it.mediaType) === 'podcast',
        })
      }
      if (results.length < 500) break
      page++
    }
  }

  // Progress + bookmarks: per-user GET (getOne includes mediaProgress + bookmarks).
  const progress = []
  const bookmarks = []
  for (const u of users) {
    let detail
    try {
      detail = await getJson(`/api/users/${u.id}`)
    } catch {
      continue // a user we can't read is skipped, not fatal
    }
    for (const mp of detail.mediaProgress ?? []) {
      progress.push({
        userId: u.id,
        mediaItemId: String(mp.mediaItemId ?? mp.libraryItemId ?? ''),
        mediaItemType: mp.mediaItemType != null ? String(mp.mediaItemType) : 'book',
        isFinished: Boolean(mp.isFinished),
        finishedAt: mp.finishedAt != null ? Number(mp.finishedAt) : null,
        currentTime: Number(mp.currentTime) || 0,
        ebookLocation: mp.ebookLocation ?? null,
        ebookProgress: mp.ebookProgress != null ? Number(mp.ebookProgress) : null,
        hideFromContinueListening: Boolean(mp.hideFromContinueListening),
        lastUpdate: Number(mp.lastUpdate ?? mp.updatedAt) || 0,
      })
    }
    for (const b of detail.bookmarks ?? []) {
      if (!b?.libraryItemId) continue
      bookmarks.push({
        userId: u.id,
        libraryItemId: String(b.libraryItemId),
        time: Number(b.time) || 0,
        title: b.title != null ? String(b.title) : '',
        createdAt: b.createdAt != null ? Number(b.createdAt) : null,
      })
    }
  }

  // The live source's own server id, if it exposes one (best-effort; ABS /status
  // doesn't carry a stable GUID, so this is usually null and matching relies on
  // metadata rather than same-server ids).
  return { kind: 'live', serverId: null, serverName: null, hsBackupBuf: null, users, items, progress, bookmarks }
}

// A stable id for a generated temp file name.
export function tempId() {
  return crypto.randomBytes(6).toString('hex')
}
