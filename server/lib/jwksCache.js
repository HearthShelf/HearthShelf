// Durable, on-disk cache of the control plane's JWKS (grant-verification keys).
//
// WHY THIS EXISTS
//
// hosted.js has always claimed that grant verification "works even when the
// control plane is briefly down or this box is firewalled from it". That was
// only half true: pairing stores the jwks_url STRING, never key material, and
// the only cache was jose's in-memory one inside createRemoteJWKSet. That cache
// dies with the process. So a container restart (image update, host reboot,
// OOM kill) while the control plane was unreachable meant jwtVerify threw, the
// caller swallowed it, and EVERY request in hosted mode answered
// 401 connect_failed - indistinguishable from a forged grant.
//
// This module makes the promise real: key material is persisted to the config
// volume at pairing time and re-read on boot, so verification never needs the
// network on the happy path. The network is used only to pick up key rotation.
//
// STALENESS IS BOUNDED ON PURPOSE
//
// Serving a stale JWKS forever would mean control-plane key REVOCATION could
// never reach this box: if CP_SIGNING_JWK were compromised, an attacker could
// mint valid grants for any user and any box that had been offline since would
// keep honouring them indefinitely. So we bound staleness (MAX_STALE_MS) and
// refuse to verify past that, and we accept a revocation signal that does NOT
// depend on the (possibly compromised) signing key - see revocation.js, which
// rides the server_secret-authed version-report channel.
//
// Availability still wins inside the bound: a box that cannot reach the control
// plane keeps working for MAX_STALE_MS, which is far longer than any realistic
// outage and short enough that a key compromise is remediable.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createLocalJWKSet, createRemoteJWKSet } from 'jose'
import { appLog } from './appLog.js'

const DATA_DIR = process.env.QG_DATA_DIR || '/config'
const CACHE_PATH = path.join(DATA_DIR, 'hosted', 'jwks.json')

/** Refresh in the background once the cache is older than this (24h). */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Hard ceiling on how long we will verify against un-refreshed keys (30d).
 * Past this we fail closed: better to reject grants than to honour keys the
 * control plane may have revoked a month ago.
 */
const MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000

/** Network fetches are time-boxed so a black-holed CP can never hang a request. */
const FETCH_TIMEOUT_MS = 5000

/**
 * Verification outcomes that callers must distinguish. Conflating these is what
 * made the original bug invisible: "we could not check" and "this grant is
 * forged" are very different, and only the former should be retried.
 */
export const JWKS_OK = 'ok'
export const JWKS_UNAVAILABLE = 'unavailable' // no keys at all, ever fetched
export const JWKS_STALE_EXPIRED = 'stale_expired' // had keys, too old to trust

// In-process copy so the steady state touches neither disk nor network.
let mem = null // { keys, fetchedAt, url }
let refreshing = null

function nowMs() {
  return Date.now()
}

async function readDisk() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.keys) || !parsed.keys.length) return null
    if (typeof parsed.fetchedAt !== 'number') return null
    return { keys: parsed.keys, fetchedAt: parsed.fetchedAt, url: parsed.url ?? null }
  } catch {
    // Missing or corrupt cache is a normal cold state, not an error.
    return null
  }
}

async function writeDisk(entry) {
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true })
    // Write-then-rename so a crash mid-write can't leave a truncated cache that
    // would read as "corrupt" and force a network fetch on the next cold boot.
    const tmp = `${CACHE_PATH}.tmp`
    await fs.writeFile(tmp, JSON.stringify(entry), 'utf8')
    await fs.rename(tmp, CACHE_PATH)
  } catch (err) {
    // Non-fatal: we still have the in-memory copy for this process. Log it,
    // because it means the next cold boot loses offline verification.
    appLog.warn('hosted', `could not persist JWKS cache: ${String(err).slice(0, 160)}`)
  }
}

/** Fetch the JWKS document over the network, time-boxed. */
async function fetchRemote(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`jwks fetch ${res.status}`)
  const doc = await res.json()
  if (!doc || !Array.isArray(doc.keys) || !doc.keys.length) throw new Error('jwks empty')
  return doc.keys
}

/**
 * Refresh from the network and persist. Deduped: concurrent callers share one
 * in-flight fetch so a burst of requests can't fan out into N fetches.
 */
async function refresh(url) {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const keys = await fetchRemote(url)
      const entry = { keys, fetchedAt: nowMs(), url }
      mem = entry
      await writeDisk(entry)
      return entry
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/**
 * Seed the cache during pairing, when we know the control plane is reachable
 * (we just talked to it). This is what makes the FIRST cold boot offline-capable
 * - without it, a box paired today and restarted tomorrow with no internet would
 * have nothing on disk to verify against.
 *
 * Best-effort by design: pairing must not fail because the JWKS endpoint
 * hiccuped. A later request will refresh it.
 */
export async function primeJwksCache(url) {
  if (!url) return false
  try {
    await refresh(url)
    appLog.info('hosted', 'pinned control-plane JWKS for offline grant verification')
    return true
  } catch (err) {
    appLog.warn('hosted', `could not pin JWKS at pairing: ${String(err).slice(0, 160)}`)
    return false
  }
}

/** Drop the cache (used by disconnect, alongside clearHostedConfig). */
export async function clearJwksCache() {
  mem = null
  try {
    await fs.rm(CACHE_PATH, { force: true })
  } catch {
    // ignore
  }
}

/**
 * Resolve a key-getter for jwtVerify, preferring cached material over the
 * network. Returns { status, keySet, ageMs }.
 *
 * Resolution order - local first, network only as a last resort or to refresh:
 *   1. in-memory (steady state, zero IO)
 *   2. on-disk    (cold boot; works with no internet - the whole point)
 *   3. network    (never cached before, or cache past MAX_STALE_MS)
 *
 * A cache older than REFRESH_AFTER_MS triggers a BACKGROUND refresh but is still
 * served immediately, so key rotation propagates without ever putting a network
 * round-trip on the request path.
 */
export async function resolveJwks(url) {
  if (!url) return { status: JWKS_UNAVAILABLE, keySet: null, ageMs: null }

  if (!mem || mem.url !== url) {
    const disk = await readDisk()
    // A cache written for a DIFFERENT jwks_url is not ours - re-pairing to
    // another control plane must not silently reuse the old keys.
    if (disk && (!disk.url || disk.url === url)) mem = { ...disk, url }
  }

  if (mem) {
    const ageMs = nowMs() - mem.fetchedAt
    if (ageMs <= MAX_STALE_MS) {
      if (ageMs > REFRESH_AFTER_MS) {
        // Fire-and-forget: a failure here is fine, we're serving cached keys.
        void refresh(url).catch(() => {})
      }
      return { status: JWKS_OK, keySet: createLocalJWKSet({ keys: mem.keys }), ageMs }
    }
    // Past the ceiling. Try once to refresh; only fail closed if that fails too.
    try {
      const fresh = await refresh(url)
      return { status: JWKS_OK, keySet: createLocalJWKSet({ keys: fresh.keys }), ageMs: 0 }
    } catch {
      appLog.warn(
        'hosted',
        `JWKS cache is ${Math.floor(ageMs / 86400000)}d old and cannot be refreshed; refusing grants until the control plane is reachable`,
      )
      return { status: JWKS_STALE_EXPIRED, keySet: null, ageMs }
    }
  }

  // Nothing cached: we have to go to the network. This is the only path that
  // requires internet, and it happens once per box (pairing normally primes it).
  try {
    const fresh = await refresh(url)
    return { status: JWKS_OK, keySet: createLocalJWKSet({ keys: fresh.keys }), ageMs: 0 }
  } catch {
    // Fall back to jose's remote set as a courtesy - it may have its own cached
    // copy in this process even though our persist failed.
    return { status: JWKS_UNAVAILABLE, keySet: createRemoteJWKSet(new URL(url)), ageMs: null }
  }
}

/** Cache state for the admin/diagnostics surface. */
export async function jwksCacheStatus() {
  if (!mem) {
    const disk = await readDisk()
    if (disk) mem = disk
  }
  if (!mem) return { pinned: false }
  const ageMs = nowMs() - mem.fetchedAt
  return {
    pinned: true,
    fetchedAt: mem.fetchedAt,
    ageMs,
    keyCount: mem.keys.length,
    stale: ageMs > REFRESH_AFTER_MS,
    expired: ageMs > MAX_STALE_MS,
    maxStaleMs: MAX_STALE_MS,
  }
}
