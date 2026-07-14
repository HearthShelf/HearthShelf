// The queue-recompute job: nightly, rebuild every Auto-mode user's up-next list
// so new library releases (a new book in a started series) show up in the queue
// without the user doing anything. Recompute is otherwise trigger-based (client
// play-cooldown, settings/manual/dismissal edits) - this is the backstop that
// catches changes no client action would.
//
// Like abs-finish-backfill, a background job has no user token, so it mints a
// short-lived per-user ABS key from the stored admin token. That token only
// exists on the all-in-one image; on slim images the job cleanly skips.
//
// It passes NO currentItemId to resolveQueue, so each user's rebuild seeds
// 'finish-series' from the stored current_item_id the client last stamped on
// play - a barely-played book still continues its series at 3am.

import { getProvisioning } from '../lib/provisioning.js'
import { getUsersWithQueue } from '../queue.js'
import { getUserSetting } from '../settings.js'
import { resolveQueue } from '../lib/computeQueue.js'

const ABS_URL = (process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378').replace(/\/$/, '')

// Mint a self-scoped ABS key for one user (admin-token privilege). Mirrors
// absFinishBackfill.mintUserKey - kept local so the two paths stay independent.
async function mintUserKey(adminToken, absUserId) {
  const res = await fetch(`${ABS_URL}/api/api-keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `hs-queue:${absUserId}`, userId: absUserId, isActive: true }),
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

export async function runQueueRecompute(logger, signal) {
  const { adminToken } = await getProvisioning()
  if (!adminToken) {
    logger.warn('No stored ABS admin token (slim image) - cannot mint user keys. Skipping.')
    return 'Skipped: no admin token to recompute queues'
  }

  const users = await getUsersWithQueue()
  logger.info(`${users.length} user(s) with a stored queue`)
  logger.progress(0, users.length)

  let rebuilt = 0 // users actually in Auto mode whose queue was recomputed
  let i = 0
  for (const { serverId, userId } of users) {
    if (signal?.aborted) {
      logger.warn(`Cancelled after ${i} of ${users.length} users`)
      return `Cancelled after ${i} of ${users.length} users (${rebuilt} queues rebuilt)`
    }
    i++

    // Cheap pre-filter: only Auto users have anything to recompute. resolveQueue
    // would no-op the rest anyway, but skipping avoids minting a key for them.
    const mode = (await getUserSetting(serverId, userId, 'queueMode')) ?? 'off'
    if (mode !== 'auto') {
      logger.progress(i, users.length)
      continue
    }

    const minted = await mintUserKey(adminToken, userId)
    if (!minted) {
      logger.warn(`Could not mint a key for user ${userId} - skipping`)
      logger.progress(i, users.length)
      continue
    }
    try {
      // No currentItemId: use the stored stamp so a barely-played book keeps
      // continuing its series even with no client present.
      await resolveQueue({ serverId, userId, absUrl: ABS_URL, absToken: minted.key })
      rebuilt++
    } catch (err) {
      logger.warn(`User ${userId}: ${String(err?.message ?? err)}`)
    } finally {
      await deleteApiKey(adminToken, minted.keyId)
    }
    logger.progress(i, users.length)
  }

  return `Recomputed ${rebuilt} Auto queue(s) across ${users.length} user(s) with a stored queue`
}
