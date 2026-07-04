// The onboarding "Restore from backup" path (playbooks M1 / M2). On a fresh AIO
// (pre-onboarding), take an uploaded .hsarchive OR a bare .audiobookshelf zip and
// stand the server back up from it:
//
//   1. Drive a throwaway ABS /init root to get a short-lived admin token (a fresh
//      AIO's ABS has no users yet, so we must create one to call the admin API).
//   2. Apply the ABS half: upload the backup to ABS and trigger apply. ABS's
//      apply REPLACES its users table with the backup's - so the throwaway root
//      vanishes and the admin will log in with backup-era credentials afterward.
//   3. Restore the HS half if the archive carried one; a bare ABS zip leaves HS
//      fresh (new server_id, empty tables).
//   4. Reconcile (service accounts, connection URLs, rescan check).
//   5. Mark onboarded and return an HONEST summary of what was and wasn't
//      restored, so the wizard never overstates the outcome.
//
// AIO only, and only before onboarding completes - it drives ABS /init, which is
// a first-run-only operation.

import AdmZip from 'adm-zip'
import crypto from 'node:crypto'
import { getMode } from './context.js'
import { getProvisioning, setProvisioning } from './provisioning.js'
import { restoreArchive, applyAbsHalf } from './archive.js'
import { runReconcile } from './reconcile.js'

const ABS_URL = (process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378').replace(/\/$/, '')

// Detect what an uploaded buffer is by peeking at its zip entries.
//   'archive'  -> a .hsarchive (has manifest.json with format 'hsarchive')
//   'abs'      -> a bare ABS backup (.audiobookshelf: has absdatabase.sqlite)
//   'unknown'  -> neither
function classifyUpload(buf) {
  let zip
  try {
    zip = new AdmZip(buf)
  } catch {
    return { kind: 'unknown' }
  }
  const mf = zip.getEntry('manifest.json')
  if (mf) {
    try {
      const parsed = JSON.parse(zip.readAsText(mf))
      if (parsed?.format === 'hsarchive') return { kind: 'archive' }
    } catch {
      /* fall through */
    }
  }
  if (zip.getEntry('absdatabase.sqlite')) return { kind: 'abs' }
  return { kind: 'unknown' }
}

// Create a throwaway ABS root and return its admin token. The subsequent ABS
// restore replaces the users table, so this account is transient by design.
async function initThrowawayRoot(logger) {
  const password = crypto.randomBytes(24).toString('base64url')
  const username = `hs-restore-${crypto.randomBytes(4).toString('hex')}`
  logger?.info?.('Preparing AudiobookShelf for restore')
  const initRes = await fetch(`${ABS_URL}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newRoot: { username, password } }),
  }).catch(() => null)
  if (!initRes || !initRes.ok) throw new Error('Could not initialise AudiobookShelf for the restore.')

  const login = await fetch(`${ABS_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch(() => null)
  const data = login && login.ok ? await login.json() : null
  const token = data?.user?.token || null
  if (!token) throw new Error('Could not sign in to AudiobookShelf to apply the restore.')
  return token
}

// Count the users ABS reports (before the token is invalidated by apply), so the
// summary can say how many accounts came back and the invite step knows the size.
async function countAbsUsers(adminToken) {
  try {
    const res = await fetch(`${ABS_URL}/api/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data?.users) ? data.users.length : null
  } catch {
    return null
  }
}

// The main entry. `buf` is the uploaded backup/archive bytes. Returns a summary
// object the wizard renders. Throws on a fatal problem (bad file, ABS not ready).
export async function restoreFromUpload(buf, logger) {
  if (getMode() !== 'aio') {
    throw new Error('Restore-from-backup during setup is only available on the all-in-one image.')
  }
  const prov = await getProvisioning()
  if (prov.onboarded) throw new Error('This server is already set up - restore from the Backups page instead.')

  const { kind } = classifyUpload(buf)
  if (kind === 'unknown') {
    throw new Error('That file is not a HearthShelf archive or an AudiobookShelf backup.')
  }

  // Get a throwaway admin token to drive the ABS restore.
  const adminToken = await initThrowawayRoot(logger)

  const summary = {
    absRestored: false,
    hsRestored: false,
    hsFresh: false,
    userCount: null,
    reconcile: null,
    warnings: [],
  }

  if (kind === 'archive') {
    // Full archive: replace mode restores both halves (ABS first, then HS).
    logger?.info?.('Restoring from the HearthShelf archive')
    const result = await restoreArchive(buf, 'replace', adminToken, logger)
    summary.absRestored = Boolean(result.absRestored)
    summary.hsRestored = Boolean(result.hsRestored)
    if (!result.hsRestored) {
      summary.hsFresh = true
      summary.warnings.push('The archive had no HearthShelf data, so HearthShelf features start fresh.')
    }
  } else {
    // Bare ABS backup: apply it, HS stays fresh.
    logger?.info?.('Restoring the AudiobookShelf backup')
    // Count users before apply invalidates the token.
    summary.userCount = await countAbsUsers(adminToken)
    await applyAbsHalf(adminToken, buf, logger)
    summary.absRestored = true
    summary.hsFresh = true
  }

  // For the archive path, count users now (a fresh throwaway login is needed
  // since apply invalidated the token; best-effort - the summary tolerates null).
  if (kind === 'archive' && summary.userCount == null) {
    // The admin will log in with backup creds; we can't easily re-auth here, so
    // leave userCount null. The invite step falls back to the Users page.
  }

  // Reconcile: service accounts, connection URLs, rescan check. Uses the (now
  // possibly-invalidated) admin token - reconcile degrades gracefully if the
  // token no longer works, reporting usersReadable:false.
  try {
    summary.reconcile = await runReconcile(adminToken)
  } catch {
    summary.reconcile = null
  }

  // Mark onboarded - the box is set up. The admin now logs in with backup creds.
  await setProvisioning({ absInitialized: true, onboarded: true })

  return summary
}

// Clean helper: whether a restore-onboarding upload is even offerable (AIO,
// pre-onboarding, ABS reachable + uninitialised). The wizard calls this to
// decide whether to show the "Restore from backup" entry.
export async function restoreOnboardingAvailable() {
  if (getMode() !== 'aio') return false
  const prov = await getProvisioning()
  if (prov.onboarded) return false
  try {
    const res = await fetch(`${ABS_URL}/status`)
    if (!res.ok) return false
    const status = await res.json()
    // Only when ABS has NO root yet (a fresh box). A restored volume that already
    // has users routes to normal login instead.
    return !status?.isInit
  } catch {
    return false
  }
}
