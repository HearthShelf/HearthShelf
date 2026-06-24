// All-in-one first-boot provisioning. On the bundled image HearthShelf owns the
// ABS server in the same container, so it sets ABS up itself instead of asking
// the admin to do ABS's own first-run dance. After this runs once, the admin
// only ever sees HearthShelf's onboarding wizard.
//
// Sequence (idempotent, runs once - guarded by the provisioning table):
//   1. Wait for the bundled ABS to answer /status.
//   2. If ABS has no root user, POST /init to create one (generated password).
//   3. Log in as root to obtain its token, which doubles as the admin token the
//      backend reuses (QuestGiver hosted pairing, library calls).
//   4. Create a default "Audiobooks" library pointed at the mounted folder.
//   5. Record everything in the provisioning table so step 1-4 never repeat.
//
// The generated root credentials are stored so the onboarding wizard can reveal
// them to the admin once (with a prompt to change the password). This is the
// same trust boundary as the admin token we already persist.
//
// No-op unless HS_MODE=aio. Slim points at the admin's own ABS; hosted is
// fronted by the control plane.

import crypto from 'node:crypto'
import { db } from '../db.js'
import { getMode } from './context.js'
import { getProvisioning, setProvisioning } from './provisioning.js'

const ABS_URL = process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378'
// Where the bundled ABS is told to look for audiobooks. The AIO compose/run
// mounts the user's library here; ABS scans it on first boot.
const DEFAULT_LIBRARY_PATH = process.env.AIO_LIBRARY_PATH || '/audiobooks'
const ROOT_USERNAME = process.env.AIO_ROOT_USERNAME || 'root'

const log = (...a) => console.log('[aio-provision]', ...a)
const warn = (...a) => console.warn('[aio-provision]', ...a)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Poll ABS /status until it answers (it boots in parallel with us). Returns the
// parsed status, or null if it never came up within the budget.
async function waitForAbs({ tries = 60, intervalMs = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${ABS_URL}/status`)
      if (res.ok) return await res.json()
    } catch {
      // ABS not listening yet - keep waiting.
    }
    await sleep(intervalMs)
  }
  return null
}

async function initRootUser(password) {
  const res = await fetch(`${ABS_URL}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newRoot: { username: ROOT_USERNAME, password } }),
  })
  return res.ok
}

// Log in as root and return its bearer token. ABS returns the auth envelope
// (user.token) from /login, the same shape the SPA consumes.
async function loginRoot(password) {
  const res = await fetch(`${ABS_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ROOT_USERNAME, password }),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data?.user?.token || null
}

// Create a default book library pointed at the mounted folder. Best-effort: a
// missing folder or duplicate name must not block provisioning - the admin can
// fix libraries in the UI afterward.
async function createDefaultLibrary(adminToken) {
  try {
    const res = await fetch(`${ABS_URL}/api/libraries`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Audiobooks',
        mediaType: 'book',
        icon: 'audiobookshelf',
        folders: [{ fullPath: DEFAULT_LIBRARY_PATH }],
      }),
    })
    if (!res.ok) {
      warn(`default library not created: ABS ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    warn(`default library error: ${String(err).slice(0, 120)}`)
    return false
  }
}

// Run the full first-boot provision. Returns silently on any path that isn't a
// fresh AIO box; throws nothing (errors are logged, retried next boot).
export async function provisionAio() {
  if (getMode() !== 'aio') return

  try {
    const prov = await getProvisioning()
    if (prov.absInitialized) {
      log('already provisioned, skipping')
      return
    }

    const status = await waitForAbs()
    if (!status) {
      warn('bundled ABS never came up; will retry next boot')
      return
    }

    // ABS may already be initialised (e.g. a volume restored from a prior run)
    // but our provisioning row is empty. If so, we can't recover the root
    // password; record that ABS is up and let the admin sign in normally.
    if (status.isInit) {
      log('ABS already initialised; marking provisioned without new credentials')
      await setProvisioning({ absInitialized: true, rootUsername: ROOT_USERNAME })
      return
    }

    const password = crypto.randomBytes(15).toString('base64url')
    if (!(await initRootUser(password))) {
      warn('ABS /init failed; will retry next boot')
      return
    }
    log('root user created')

    const adminToken = await loginRoot(password)
    if (!adminToken) {
      warn('root login failed after init; will retry next boot')
      return
    }

    await createDefaultLibrary(adminToken)

    await setProvisioning({
      absInitialized: true,
      adminToken,
      rootUsername: ROOT_USERNAME,
      onboarded: false,
    })
    // The generated root password is sensitive and needed only once - the wizard
    // reveals it, then nudges a change. Stored alongside provisioning state, the
    // same volume as the admin token already is.
    await db.execute({
      sql: `UPDATE provisioning SET root_password = ? WHERE id = 1`,
      args: [password],
    })
    log('provisioning complete')
  } catch (err) {
    warn(`unexpected error: ${String(err).slice(0, 160)}`)
  }
}
