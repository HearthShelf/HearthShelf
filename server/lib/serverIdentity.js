// This server's own cryptographic identity, used to prove "you really are
// talking to the box you think you are" BEFORE a client hands over a credential.
//
// THE PROBLEM THIS SOLVES
//
// A control-plane grant is a bearer token. It carries the user's verified email,
// Clerk subject, username, and role, and any HearthShelf server that receives it
// can exchange it for a long-lived per-user ABS API key. The client therefore
// must never present a grant to an origin it has not authenticated.
//
// Over the public internet that authentication comes free from TLS: the origin is
// a CA-valid HTTPS name the control plane vouched for. On a LAN it does NOT.
// A LAN address is a private IP (or .local name) with no usable CA cert, learned
// from a registry that can go stale the moment DHCP reassigns a lease. Any device
// on the network can answer on that IP and port. Without an identity check, the
// phone's LAN-first connect would hand a live grant to whatever picked up - and
// that listener could replay it against the real server and walk away with
// permanent access to the user's library.
//
// Note the asymmetry that makes this necessary: the `aud` check inside
// verifyGrant protects the SERVER from a grant minted for someone else. It does
// nothing to protect the CLIENT, because a malicious server simply doesn't run
// that code. Protection has to be on the client side, and it needs something the
// impostor cannot produce.
//
// THE MECHANISM
//
// At pairing the box generates an Ed25519 keypair and registers the PUBLIC half
// with the control plane. A client fetches that public key over TLS from the
// control plane (trusted channel), then challenges the candidate origin:
//
//   client -> server:  POST /hs/hosted/identity { nonce }
//   server -> client:  { server_id, signature = Sign(priv, nonce||server_id) }
//
// The client verifies the signature against the CP-supplied public key. Only the
// real box holds the private key, so an impostor cannot answer - and the client
// walks away WITHOUT ever having sent a grant.
//
// The nonce is client-chosen and single-use, so a passive observer on the LAN
// cannot replay a previously captured response. The server_id is inside the
// signed payload so a signature captured from server A cannot be replayed as
// proof of server B.
import crypto from 'node:crypto'
import { db, initDb, getServerId } from '../db.js'
import { appLog } from './appLog.js'

let ready = null
function ensure() {
  if (!ready) ready = initDb()
  return ready
}

/**
 * Load (or lazily create) this server's identity keypair.
 *
 * Generated once and persisted. The public half is what the control plane
 * publishes to clients; the private half never leaves this box.
 */
export async function getIdentityKeys() {
  await ensure()
  let r
  try {
    r = await db.execute(
      'SELECT identity_private_key, identity_public_key FROM server_identity WHERE id = 1',
    )
  } catch {
    // Migration hasn't landed yet on this box.
    return null
  }
  const row = r.rows[0]
  if (row?.identity_private_key && row?.identity_public_key) {
    return {
      privateKey: String(row.identity_private_key),
      publicKey: String(row.identity_public_key),
    }
  }

  // First use: generate and persist.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  try {
    await db.execute({
      sql: `UPDATE server_identity SET identity_private_key = ?, identity_public_key = ? WHERE id = 1`,
      args: [priv, pub],
    })
  } catch (err) {
    appLog.warn('hosted', `could not persist server identity key: ${String(err).slice(0, 160)}`)
    return null
  }
  appLog.info('hosted', 'generated this server\'s identity keypair for origin verification')
  return { privateKey: priv, publicKey: pub }
}

/** The public key to register with the control plane (base64 SPKI DER). */
export async function getIdentityPublicKey() {
  const keys = await getIdentityKeys()
  return keys?.publicKey ?? null
}

/**
 * Sign a client-supplied challenge, proving possession of the private key.
 *
 * The signed payload binds the nonce to THIS server's id, so a response captured
 * from one box is not reusable as proof for another. Returns null if we have no
 * key (pre-migration box) - callers must treat that as "cannot prove identity",
 * never as success.
 */
export async function signIdentityChallenge(nonce) {
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 512) return null
  const keys = await getIdentityKeys()
  if (!keys) return null
  const serverId = await getServerId()

  const payload = Buffer.from(`hs-identity:v1:${serverId}:${nonce}`, 'utf8')
  const key = crypto.createPrivateKey({
    key: Buffer.from(keys.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const sig = crypto.sign(null, payload, key) // null alg = Ed25519's own
  return { serverId, signature: sig.toString('base64') }
}

/**
 * Verify a challenge response. Not used by the server itself (the client does the
 * verifying) - exported so the same canonical payload construction is available
 * to tests and to any server-to-server checking we add later. Keeping one
 * implementation of the payload format prevents client and server drifting.
 */
export function verifyIdentityChallenge(publicKeyB64, serverId, nonce, signatureB64) {
  try {
    const payload = Buffer.from(`hs-identity:v1:${serverId}:${nonce}`, 'utf8')
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    return crypto.verify(null, payload, key, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}
