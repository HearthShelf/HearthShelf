// Post-restore / post-migration reconciliation. After an ABS restore (or an
// archive replace), the ABS users table has been swapped for the backup's, and
// HS rows are keyed to those user ids. Most things line up by construction (see
// data-inventory.md), but three things can be stale and need fixing or flagging:
//
//   1. Service accounts - the AIO's service root (provisioning.root_username)
//      and any tracked service_accounts ids may no longer exist in ABS (the
//      restore replaced the users table with the backup's). The backend uses the
//      service root's token for admin ops (federation, minting keys), so if it's
//      gone those paths break silently. We DETECT this and let the admin
//      re-provision + re-mint (they're now logged in with backup-era creds).
//   2. connections.abs_url - per-user rows point at the OLD origin after a
//      Thin->AIO move. We rewrite them to this box's ABS origin.
//   3. Zero-match rescan - if HS holds item references but NONE of them resolve
//      in ABS anymore, the library was re-scanned onto new inodes (new item
//      ids); history dangles. We can't fix that here (it's an M4/M8 import), but
//      we surface it so the admin isn't left guessing.
//
// This module only READS ABS (via a caller-supplied admin token) and WRITES our
// own DB. It never writes ABS's database - that stays ABS's job.

import { db, getServerId } from '../db.js'
import { getProvisioning, setProvisioning } from './provisioning.js'
import { getServiceAccountIds } from './serviceAccounts.js'
import { getMode } from './context.js'

const ABS_URL = (process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378').replace(/\/$/, '')
const SERVICE_USERNAME = process.env.AIO_SERVICE_USERNAME || 'hearthshelf-service'

// Fetch the full ABS user list with an admin token. Returns [] on any failure
// (the caller treats an unreadable list as "can't verify" rather than "empty").
async function fetchAbsUsers(adminToken) {
  if (!adminToken) return null
  try {
    const res = await fetch(`${ABS_URL}/api/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data?.users) ? data.users : []
  } catch {
    return null
  }
}

// Every distinct ABS library_item_id HearthShelf references across its domains.
// Used for the zero-match rescan check.
async function referencedItemIds(serverId) {
  const ids = new Set()
  const queries = [
    `SELECT DISTINCT library_item_id AS id FROM finished_books WHERE server_id = ? AND library_item_id IS NOT NULL AND library_item_id != ''`,
    `SELECT DISTINCT library_item_id AS id FROM book_notes WHERE server_id = ? AND library_item_id != ''`,
    `SELECT DISTINCT library_item_id AS id FROM club_books WHERE server_id = ?`,
  ]
  for (const sql of queries) {
    try {
      const r = await db.execute({ sql, args: [serverId] })
      for (const row of r.rows) if (row.id) ids.add(String(row.id))
    } catch {
      // a missing table just contributes no ids
    }
  }
  return [...ids]
}

// Does an ABS library item exist? ABS returns 404 for a missing/unscanned id.
async function absItemExists(adminToken, itemId) {
  try {
    const res = await fetch(`${ABS_URL}/api/items/${encodeURIComponent(itemId)}?minified=1`, {
      headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
    })
    return res.ok
  } catch {
    return false
  }
}

// Sample up to `limit` referenced item ids and report how many still resolve in
// ABS. A zero-match (references exist, none resolve) means an inode-mismatch
// rescan minted new ids; the history dangles and needs an import/re-link (M8).
async function checkItemMatches(adminToken, serverId, limit = 25) {
  const ids = await referencedItemIds(serverId)
  if (ids.length === 0) return { referenced: 0, sampled: 0, matched: 0, zeroMatch: false }
  const sample = ids.slice(0, limit)
  let matched = 0
  for (const id of sample) {
    if (await absItemExists(adminToken, id)) matched++
  }
  return {
    referenced: ids.length,
    sampled: sample.length,
    matched,
    // Only a confident zero-match (we sampled several, none matched) trips the
    // warning - a single unmatched id could just be a since-deleted book.
    zeroMatch: sample.length >= 3 && matched === 0,
  }
}

// Rewrite every connections.abs_url to this box's ABS origin (they may point at
// the pre-migration origin). Slim keeps the admin's configured ABS_SERVER_URL;
// AIO uses the in-container URL. Returns the number of rows updated.
async function rewriteConnectionUrls(serverId) {
  try {
    const r = await db.execute({
      sql: `UPDATE connections SET abs_url = ?, updated_at = ?
              WHERE server_id = ? AND abs_url != '' AND abs_url != ?`,
      args: [ABS_URL, Date.now(), serverId, ABS_URL],
    })
    return Number(r.rowsAffected) || 0
  } catch {
    return 0
  }
}

// Run the full reconcile and return a structured report. `adminToken` is an ABS
// admin bearer (the caller has one: the just-restored admin, or the service
// token). Nothing here throws - each check degrades to "unknown" so a partial
// failure still yields an actionable report.
export async function runReconcile(adminToken) {
  const serverId = await getServerId()
  const mode = getMode()
  const prov = await getProvisioning()

  const users = await fetchAbsUsers(adminToken)
  const usersReadable = Array.isArray(users)
  const usernames = usersReadable ? new Set(users.map((u) => u?.username)) : null
  const userIds = usersReadable ? new Set(users.map((u) => String(u?.id))) : null

  // Service root (AIO): does the recorded service username still exist?
  const serviceUsername = prov.rootUsername || (mode === 'aio' ? SERVICE_USERNAME : null)
  const serviceRootMissing =
    mode === 'aio' && !!serviceUsername && usernames != null && !usernames.has(serviceUsername)

  // Tracked service-account ids that no longer resolve.
  const trackedIds = await getServiceAccountIds()
  const missingServiceIds =
    userIds != null ? trackedIds.filter((id) => !userIds.has(String(id))) : []

  // Connection URLs -> this box's origin.
  const connectionsRewritten = await rewriteConnectionUrls(serverId)

  // Zero-match rescan detection.
  const items = await checkItemMatches(adminToken, serverId)

  return {
    mode,
    usersReadable,
    userCount: usersReadable ? users.length : null,
    serviceRootMissing,
    serviceUsername,
    missingServiceIds,
    connectionsRewritten,
    items,
    // A single "needs the admin's attention" flag the UI can gate on.
    needsAttention: serviceRootMissing || missingServiceIds.length > 0 || items.zeroMatch,
  }
}

// Re-provision the AIO service root after a restore replaced it. The admin is
// logged in with backup-era credentials and passes their own admin token; we
// create a fresh service root (new generated password), record it, and return
// its token so the backend's admin path (hosted_config.absAdminToken) can be
// refreshed by the caller. AIO only.
export async function reprovisionServiceRoot(adminToken) {
  if (getMode() !== 'aio') throw new Error('Service accounts are only used on the all-in-one image.')
  if (!adminToken) throw new Error('An admin token is required to re-provision.')

  const crypto = await import('node:crypto')
  const password = crypto.randomBytes(24).toString('base64url')

  // Create the service root as a normal admin user (root already exists post
  // restore - the backup's root - so we make a dedicated service admin instead).
  const res = await fetch(`${ABS_URL}/api/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: SERVICE_USERNAME,
      password,
      type: 'admin',
      isActive: true,
    }),
  }).catch(() => null)

  // A 200 means created; a 500/409 for "username taken" means it already exists
  // (the backup carried it) - in that case we can't know its password, so we
  // report that the admin must reset it manually.
  if (!res || !res.ok) {
    throw new Error(
      'Could not create a fresh service account. The backup may already contain one - reset its password from the Users page.',
    )
  }

  // Log in as the new service root to get its token.
  const login = await fetch(`${ABS_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: SERVICE_USERNAME, password }),
  }).catch(() => null)
  const data = login && login.ok ? await login.json() : null
  const token = data?.user?.token || null
  if (!token) throw new Error('Created the service account but could not sign in as it.')

  await setProvisioning({ rootUsername: SERVICE_USERNAME, servicePassword: password })
  return { token, username: SERVICE_USERNAME }
}
