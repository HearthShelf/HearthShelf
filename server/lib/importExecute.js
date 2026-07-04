// The import/merge engine EXECUTE path (Phase 4). Applies a persisted dry-run
// report against the live ABS server, writing each user's history AS that user
// via minted per-user ABS keys and self-scoped endpoints - the same supported
// APIs mobile offline sync uses, never database surgery. See
// docs/data-lifecycle/merge-engine.md.
//
// Safety: backup-before-import (Phase 1 HS backup + an ABS backup), idempotent
// (progress is pre-merged so a re-run recomputes the same value and skips no-op
// writes), and read-only toward the source.

import crypto from 'node:crypto'
import { db, getServerId } from '../db.js'
import { readTargetInventory } from './absdb.js'
import { readStashedSource, clearStashedSource, getImportReport } from './importEngine.js'
import { createBackup } from './backup.js'
import { mergeHsDomains } from './importHsDomains.js'
import { buildTargetIndex, matchItem, mergeProgress, progressUnchanged, bookmarksToAdd } from '@hearthshelf/core'

const ABS_URL = (process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378').replace(/\/$/, '')

// --- ABS admin helpers (mirrors lib/hosted.js, standalone for import) ------

async function createAbsUser(adminToken, src) {
  const base = (src.username || (src.email ? src.email.split('@')[0] : '') || 'user').trim() || 'user'
  const tempPassword = crypto.randomBytes(24).toString('base64url')
  for (let attempt = 0; attempt < 3; attempt++) {
    const username = attempt === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`
    const res = await fetch(`${ABS_URL}/api/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        email: src.email || null,
        password: tempPassword,
        type: src.type === 'admin' ? 'admin' : 'user', // never import root/guest here
        isActive: src.isActive !== false,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      const user = data?.user || data
      return user?.id ? { id: String(user.id), username, tempPassword } : null
    }
    if (res.status !== 500 && res.status !== 409 && res.status !== 400) return null
  }
  return null
}

async function mintUserKey(adminToken, absUserId) {
  const res = await fetch(`${ABS_URL}/api/api-keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `hs-import:${absUserId}`, userId: absUserId, isActive: true }),
  }).catch(() => null)
  if (!res || !res.ok) return null
  const data = await res.json().catch(() => null)
  const k = (typeof data?.apiKey === 'object' ? data.apiKey?.apiKey : data?.apiKey) || data?.key || null
  return typeof k === 'string' && k ? { keyId: data?.apiKey?.id ?? null, key: k } : null
}

async function deleteApiKey(adminToken, keyId) {
  if (!keyId) return
  await fetch(`${ABS_URL}/api/api-keys/${keyId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  }).catch(() => {})
}

// A target user's current progress for the matched items, keyed by libraryItemId,
// so the engine can pre-merge. Read AS the user with their key (self-scoped).
async function readUserProgress(userKey) {
  try {
    const res = await fetch(`${ABS_URL}/api/me`, { headers: { Authorization: `Bearer ${userKey}` } })
    if (!res.ok) return new Map()
    const me = await res.json()
    const map = new Map()
    for (const mp of me.mediaProgress ?? []) {
      // key by libraryItemId (what the batch write uses)
      map.set(String(mp.libraryItemId), {
        mediaItemId: String(mp.mediaItemId ?? ''),
        libraryItemId: String(mp.libraryItemId),
        isFinished: Boolean(mp.isFinished),
        finishedAt: mp.finishedAt != null ? Number(mp.finishedAt) : null,
        currentTime: Number(mp.currentTime) || 0,
        ebookLocation: mp.ebookLocation ?? null,
        ebookProgress: mp.ebookProgress != null ? Number(mp.ebookProgress) : null,
        hideFromContinueListening: Boolean(mp.hideFromContinueListening),
        lastUpdate: Number(mp.lastUpdate ?? mp.updatedAt) || 0,
      })
    }
    return map
  } catch {
    return new Map()
  }
}

async function writeProgressBatch(userKey, payloads) {
  if (!payloads.length) return 0
  const res = await fetch(`${ABS_URL}/api/me/progress/batch/update`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${userKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payloads),
  }).catch(() => null)
  return res && res.ok ? payloads.length : 0
}

async function writeBookmark(userKey, libraryItemId, time, title) {
  const res = await fetch(`${ABS_URL}/api/me/item/${encodeURIComponent(libraryItemId)}/bookmark`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ time: Math.round(time), title: title || `Bookmark` }),
  }).catch(() => null)
  return res && res.ok
}

// --- Execute ---------------------------------------------------------------

// Apply a persisted report. `reportId` must exist; `userOverrides` (from the UI)
// replaces per-source-user action/targetUserId. `ctx` carries the admin token.
export async function importExecute({ reportId, userOverrides, ctx }) {
  const serverId = await getServerId()
  const found = await getImportReport(reportId)
  if (!found?.report) throw new Error('That import report was not found - run a dry-run first.')
  if (found.status === 'done') throw new Error('That import was already applied.')
  const report = found.report

  const source = await readStashedSource(reportId)
  if (!source) {
    throw new Error('The import data for this report is no longer staged. Please run a new dry-run.')
  }
  const adminToken = ctx?.absToken
  if (!adminToken) throw new Error('An admin token is required to run the import.')

  await db.execute({
    sql: `UPDATE import_reports SET status = 'executing', updated_at = ? WHERE id = ?`,
    args: [Date.now(), reportId],
  })

  const result = {
    reportId,
    createdAt: Date.now(),
    usersCreated: 0,
    usersMerged: 0,
    progressWritten: 0,
    sessionsWritten: 0,
    bookmarksWritten: 0,
    domainsMerged: {},
    createdUserInvites: [],
    warnings: [...(report.warnings ?? [])],
    backup: { hsBackup: null, absBackupId: null },
  }

  // 1. Backup-before-import (Phase 1 HS backup; ABS backup best-effort).
  try {
    const bk = await createBackup()
    result.backup.hsBackup = bk.filename
  } catch (err) {
    result.warnings.push(`Could not take a HearthShelf backup before importing: ${String(err?.message ?? err)}`)
  }
  try {
    const absRes = await fetch(`${ABS_URL}/api/backups`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } })
    if (absRes.ok) {
      const data = await absRes.json()
      const newest = (data?.backups ?? []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]
      result.backup.absBackupId = newest?.id ?? null
    }
  } catch {
    result.warnings.push('Could not take an AudiobookShelf backup before importing.')
  }

  // 2. Re-read target inventory (fresh - the world may have moved since dry-run)
  //    and rebuild the item map: sourceMediaId -> targetLibraryItemId (the batch
  //    write keys by libraryItemId, not media id).
  const target = await readTargetInventory()
  if (!target) throw new Error('This server\'s AudiobookShelf database is not readable.')
  const index = buildTargetIndex(target.items.filter((i) => !i.isPodcast))
  const useSameServerIds = (report.mode === 'restore-as-import' || report.mode === 'relink') && report.sameServer
  const allowInode = report.mode === 'relink' ? false : false // execute never trusts inode fresh; the report already matched
  const mediaToTargetItem = new Map() // sourceMediaId -> targetLibraryItemId
  for (const si of source.items) {
    if (si.isPodcast) continue
    const m = matchItem(si, index, { allowInode, sameServer: useSameServerIds })
    if (m.targetItemId) mediaToTargetItem.set(si.mediaId, m.targetItemId)
  }

  // 3. Resolve the user map from the report + overrides.
  const overrides = new Map((userOverrides ?? []).map((o) => [String(o.sourceUserId), o]))
  const userMap = new Map() // sourceUserId -> { targetUserId, created }
  for (const um of report.users) {
    const ov = overrides.get(um.sourceUserId)
    const action = ov?.action ?? um.action
    if (action === 'skip') continue
    if (action === 'map') {
      const targetUserId = ov?.targetUserId ?? um.targetUserId
      if (targetUserId) {
        userMap.set(um.sourceUserId, { targetUserId: String(targetUserId), created: false })
        result.usersMerged++
      }
    } else if (action === 'create') {
      const src = source.users.find((u) => u.id === um.sourceUserId)
      if (!src) continue
      const created = await createAbsUser(adminToken, src)
      if (created) {
        userMap.set(um.sourceUserId, { targetUserId: created.id, created: true })
        result.usersCreated++
        result.createdUserInvites.push({ userId: created.id, email: src.email, username: created.username })
      } else {
        result.warnings.push(`Could not create user "${um.sourceLabel}".`)
      }
    }
  }

  // 4. Per-user writes (progress + bookmarks) via minted keys.
  const bookProgress = source.progress.filter((p) => p.mediaItemType !== 'podcastEpisode' && p.mediaItemType !== 'podcast')
  const progressByUser = new Map()
  for (const p of bookProgress) {
    if (!progressByUser.has(p.userId)) progressByUser.set(p.userId, [])
    progressByUser.get(p.userId).push(p)
  }
  const bookmarksByUser = new Map()
  for (const b of source.bookmarks) {
    if (!bookmarksByUser.has(b.userId)) bookmarksByUser.set(b.userId, [])
    bookmarksByUser.get(b.userId).push(b)
  }

  for (const [sourceUserId, mapping] of userMap) {
    const minted = await mintUserKey(adminToken, mapping.targetUserId)
    if (!minted) {
      result.warnings.push(`Could not act as user ${mapping.targetUserId}; skipped their history.`)
      continue
    }
    try {
      // Existing target progress (for the merge), keyed by target libraryItemId.
      const targetProg = await readUserProgress(minted.key)

      // Build merged progress payloads.
      const payloads = []
      for (const sp of progressByUser.get(sourceUserId) ?? []) {
        const targetItemId = mediaToTargetItem.get(sp.mediaItemId)
        if (!targetItemId) continue // unmatched item; skipped (already reported)
        const existing = targetProg.get(targetItemId) ?? null
        // Shape the source row as a ProgressRow keyed to the TARGET item.
        const sourceRow = {
          mediaItemId: existing?.mediaItemId ?? '',
          libraryItemId: targetItemId,
          isFinished: sp.isFinished,
          finishedAt: sp.finishedAt,
          currentTime: sp.currentTime,
          ebookLocation: sp.ebookLocation,
          ebookProgress: sp.ebookProgress,
          hideFromContinueListening: sp.hideFromContinueListening,
          lastUpdate: sp.lastUpdate,
        }
        const merged = mergeProgress(sourceRow, existing)
        if (progressUnchanged(merged, existing)) continue // idempotent skip
        payloads.push({
          libraryItemId: targetItemId,
          currentTime: merged.currentTime ?? 0,
          isFinished: Boolean(merged.isFinished),
          finishedAt: merged.finishedAt ?? null,
          ebookLocation: merged.ebookLocation ?? null,
          ebookProgress: merged.ebookProgress ?? null,
          hideFromContinueListening: Boolean(merged.hideFromContinueListening),
        })
      }
      result.progressWritten += await writeProgressBatch(minted.key, payloads)

      // Bookmarks: union by (target item, time). Re-map the source bookmark's
      // libraryItemId to the target item via its source media... but bookmarks
      // reference libraryItemId, not media. Map source libraryItem -> its media ->
      // target item. Build a small source-item -> media lookup.
      const srcItemMedia = new Map(source.items.map((i) => [i.libraryItemId, i.mediaId]))
      const wantBookmarks = []
      for (const bm of bookmarksByUser.get(sourceUserId) ?? []) {
        const media = srcItemMedia.get(bm.libraryItemId)
        const targetItemId = media ? mediaToTargetItem.get(media) : null
        if (!targetItemId) continue
        wantBookmarks.push({ libraryItemId: targetItemId, time: bm.time, title: bm.title })
      }
      // Read existing bookmarks (from /api/me) to dedupe.
      const meRes = await fetch(`${ABS_URL}/api/me`, { headers: { Authorization: `Bearer ${minted.key}` } }).catch(() => null)
      const meData = meRes && meRes.ok ? await meRes.json() : {}
      const existingBm = (meData.bookmarks ?? []).map((b) => ({ libraryItemId: String(b.libraryItemId), time: Number(b.time) || 0 }))
      const toAdd = bookmarksToAdd(wantBookmarks, existingBm)
      for (const bm of toAdd) {
        if (await writeBookmark(minted.key, bm.libraryItemId, bm.time, bm.title)) result.bookmarksWritten++
      }
    } finally {
      // Clean up the minted key - it was only for this import.
      await deleteApiKey(adminToken, minted.keyId)
    }
  }

  // 5. HS-domain merge (archive sources only). Re-keys through userMap and
  //    re-maps itemRefs through the media->target-item map, then applies each
  //    domain's registry policy.
  if (source.hsBackupBuf) {
    try {
      const merged = await mergeHsDomains({
        hsBackupBuf: source.hsBackupBuf,
        userMap,
        mediaToTargetItem,
        sourceItems: source.items,
        serverId,
      })
      result.domainsMerged = merged
    } catch (err) {
      result.warnings.push(`HearthShelf data merge had a problem: ${String(err?.message ?? err)}`)
    }
  }

  // 6. Persist result + mark done, clear the staged source.
  await db.execute({
    sql: `UPDATE import_reports SET status = 'done', result_json = ?, updated_at = ? WHERE id = ?`,
    args: [JSON.stringify(result), Date.now(), reportId],
  })
  await clearStashedSource(reportId)

  return result
}
