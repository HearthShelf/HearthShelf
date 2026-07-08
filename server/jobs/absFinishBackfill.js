// The abs-finish-backfill job: the "add it later" half of the Goodreads-import
// stats backfill. A Goodreads import saves finished_books rows for books the user
// doesn't own yet as stubs (no library_item_id); once such a book IS added to the
// library, this job re-matches the stub, writes the backdated finish into ABS's
// mediaProgress (so it counts toward the stats page), and stamps abs_synced_at.
// It also flushes any matched-but-unsynced rows an on-import backfill failed on.
//
// Unlike the on-import path (which writes as the calling user), a background job
// has no user token, so it mints a short-lived per-user ABS key from the stored
// admin token - the same supported pattern importExecute.js uses. That token only
// exists on the all-in-one image; on slim images the job cleanly skips.

import { matchAgainstLibrary } from '../lib/bookMatch.js'
import { writeFinishesAsUser } from '../lib/absProgress.js'
import { getProvisioning } from '../lib/provisioning.js'
import {
  getUsersWithPendingAbsBackfill,
  getUnsyncedAbsFinishedBooks,
  attachLibraryItem,
  markAbsSynced,
} from '../lib/finishedBooks.js'

const ABS_URL = (process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378').replace(/\/$/, '')

// Mint a self-scoped ABS key for one user (admin-token privilege). Mirrors
// importExecute.mintUserKey - kept local so the two paths stay independent.
async function mintUserKey(adminToken, absUserId) {
  const res = await fetch(`${ABS_URL}/api/api-keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `hs-backfill:${absUserId}`, userId: absUserId, isActive: true }),
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

// All library items visible to this user, in ABS's minified match shape, across
// every library they can see. Fetched as the user (their minted key) so the
// re-match only ever links books they actually own.
async function fetchUserLibraryItems(userKey) {
  const libRes = await fetch(`${ABS_URL}/api/libraries`, {
    headers: { Authorization: `Bearer ${userKey}` },
  }).catch(() => null)
  if (!libRes || !libRes.ok) return []
  const libData = await libRes.json().catch(() => null)
  const libraries = libData?.libraries ?? []
  const items = []
  for (const lib of libraries) {
    const res = await fetch(
      `${ABS_URL}/api/libraries/${encodeURIComponent(lib.id)}/items?minified=1&limit=0`,
      { headers: { Authorization: `Bearer ${userKey}` } },
    ).catch(() => null)
    if (!res || !res.ok) continue
    const data = await res.json().catch(() => null)
    for (const it of data?.results ?? []) items.push(it)
  }
  return items
}

export async function runAbsFinishBackfill(logger, signal) {
  const { adminToken } = await getProvisioning()
  if (!adminToken) {
    logger.warn('No stored ABS admin token (slim image) - cannot mint user keys. Skipping.')
    return 'Skipped: no admin token to write ABS progress'
  }

  const users = await getUsersWithPendingAbsBackfill()
  logger.info(`${users.length} user(s) with finishes pending ABS backfill`)
  logger.progress(0, users.length)

  let promoted = 0 // stubs newly matched to a library item
  let written = 0 // finishes written into ABS
  let i = 0
  for (const { serverId, userId } of users) {
    if (signal?.aborted) {
      logger.warn(`Cancelled after ${i} of ${users.length} users`)
      return `Cancelled after ${i} of ${users.length} users (${written} finishes written)`
    }
    i++

    const minted = await mintUserKey(adminToken, userId)
    if (!minted) {
      logger.warn(`Could not mint a key for user ${userId} - skipping`)
      logger.progress(i, users.length)
      continue
    }
    try {
      const pending = await getUnsyncedAbsFinishedBooks(serverId, userId, false)
      if (!pending.length) continue

      // Re-match the stubs (rows with no library_item_id) against the user's
      // current library; matched rows are already linked and just need writing.
      const stubs = pending.filter((r) => !r.libraryItemId)
      let items = null
      if (stubs.length) items = await fetchUserLibraryItems(minted.key)

      const toWrite = []
      for (const row of pending) {
        if (row.libraryItemId) {
          toWrite.push(row)
          continue
        }
        if (!items) continue
        const m = matchAgainstLibrary(
          { title: row.title, author: row.author, isbn: row.isbn },
          items,
        )
        // Only auto-promote a confident single match; ambiguous stubs wait for a
        // human decision (a re-import), never guessing which edition finished.
        if (m.status === 'auto' && m.candidates[0]?.libraryItemId) {
          const libraryItemId = m.candidates[0].libraryItemId
          await attachLibraryItem(row.id, libraryItemId)
          promoted++
          toWrite.push({ ...row, libraryItemId })
        }
      }

      if (toWrite.length) {
        const n = await writeFinishesAsUser(minted.key, toWrite, ABS_URL)
        if (n) {
          for (const row of toWrite) await markAbsSynced(row.id)
          written += n
        }
      }
    } catch (err) {
      logger.warn(`User ${userId}: ${String(err?.message ?? err)}`)
    } finally {
      await deleteApiKey(adminToken, minted.keyId)
    }
    logger.progress(i, users.length)
  }

  return `Backfilled ${written} finish(es) into ABS across ${users.length} user(s); ${promoted} stub(s) newly matched`
}
