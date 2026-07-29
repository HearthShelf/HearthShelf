// Control-plane signing-key revocation, delivered OUT OF BAND of the signing key.
//
// WHY A SEPARATE CHANNEL
//
// Grant verification trusts the CP's Ed25519 signing key, fetched as a JWKS and
// (see jwksCache.js) pinned to disk so it survives an offline cold boot. That
// pinning creates a problem: if the CP's signing key is ever compromised, an
// attacker can mint valid grants for any user, and a box holding a pinned copy
// of that key would keep honouring them.
//
// We cannot deliver "key X is revoked" as something SIGNED BY key X - a thief
// holding the key could forge the revocation's absence, or simply serve an old
// JWKS. So revocation rides a channel authenticated by a DIFFERENT credential:
// this server's own server_secret, which the control plane stores hashed and
// which the attacker does not obtain by stealing the signing key.
//
// The version-report call (POST /servers/version, already periodic and already
// server_secret-authed) carries the signal. The CP answers with:
//
//   revoked_kids:  [kid, ...]   keys never to honour again
//   min_key_gen:   integer      reject any key below this generation
//
// Both are persisted locally, so a box that learns of a revocation and THEN goes
// offline stays protected. This is deliberately fail-safe in the other
// direction too: never receiving the signal leaves the previous (more
// restrictive or equal) state in place - we never widen trust on silence.
import fs from 'node:fs/promises'
import path from 'node:path'
import { appLog } from './appLog.js'

const DATA_DIR = process.env.QG_DATA_DIR || '/config'
const STATE_PATH = path.join(DATA_DIR, 'hosted', 'key-revocation.json')

// { revokedKids: string[], minKeyGen: number, updatedAt: number }
let mem = null

async function load() {
  if (mem) return mem
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8')
    const p = JSON.parse(raw)
    mem = {
      revokedKids: Array.isArray(p.revokedKids) ? p.revokedKids.filter((k) => typeof k === 'string') : [],
      minKeyGen: Number.isFinite(p.minKeyGen) ? p.minKeyGen : 0,
      updatedAt: Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
    }
  } catch {
    mem = { revokedKids: [], minKeyGen: 0, updatedAt: 0 }
  }
  return mem
}

async function persist(state) {
  try {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true })
    const tmp = `${STATE_PATH}.tmp`
    await fs.writeFile(tmp, JSON.stringify(state), 'utf8')
    await fs.rename(tmp, STATE_PATH)
  } catch (err) {
    appLog.warn('hosted', `could not persist key revocation state: ${String(err).slice(0, 160)}`)
  }
}

/**
 * Record a revocation signal received over the server_secret-authed channel.
 *
 * MONOTONIC BY DESIGN: revoked kids only ever accumulate, and minKeyGen only
 * ever increases. A downgrade would be the exact move an attacker who gained
 * write access to the channel would attempt, and there is no legitimate reason
 * for the control plane to un-revoke a key - rotating forward is free.
 */
export async function recordRevocationSignal(signal) {
  if (!signal || typeof signal !== 'object') return
  const cur = await load()
  const incomingKids = Array.isArray(signal.revoked_kids)
    ? signal.revoked_kids.filter((k) => typeof k === 'string' && k)
    : []
  const incomingGen = Number.isFinite(Number(signal.min_key_gen)) ? Number(signal.min_key_gen) : 0

  const merged = new Set(cur.revokedKids)
  let added = 0
  for (const kid of incomingKids) {
    if (!merged.has(kid)) {
      merged.add(kid)
      added++
    }
  }
  const nextGen = Math.max(cur.minKeyGen, incomingGen)

  if (!added && nextGen === cur.minKeyGen) return // nothing new

  mem = { revokedKids: [...merged], minKeyGen: nextGen, updatedAt: Date.now() }
  await persist(mem)
  appLog.warn(
    'hosted',
    `control-plane key revocation updated: ${added} newly revoked key(s), min generation ${nextGen}`,
  )
}

/**
 * Is this grant's signing key still trusted? Called after signature
 * verification, with the `kid` from the verified JWT header.
 *
 * Checked AFTER verification on purpose: an unverified header is attacker-
 * controlled, so acting on it earlier would let anyone name any kid. Once the
 * signature is proven, the kid is authentic and safe to judge.
 */
export async function isKeyRevoked(kid, keyGen) {
  const st = await load()
  if (kid && st.revokedKids.includes(kid)) return true
  if (Number.isFinite(keyGen) && keyGen < st.minKeyGen) return true
  return false
}

export async function revocationStatus() {
  const st = await load()
  return { revokedKidCount: st.revokedKids.length, minKeyGen: st.minKeyGen, updatedAt: st.updatedAt }
}

/** Reset on disconnect - a box that unpaired has no CP trust state to keep. */
export async function clearRevocationState() {
  mem = null
  try {
    await fs.rm(STATE_PATH, { force: true })
  } catch {
    // ignore
  }
}
