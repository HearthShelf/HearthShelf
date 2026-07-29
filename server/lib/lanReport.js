// Report this box's LAN address (and identity public key) to the control plane,
// so a phone on the same Wi-Fi can reach us when our internet is down.
//
// The control plane never fetches this address - it stores it and forwards it to
// authenticated clients, which reach it on their own network. The identity key
// travels with it because a LAN address is useless without a way to authenticate
// it: a private IP is spoofable by any device on the network, and clients must
// never hand a control-plane grant to an unauthenticated origin.
//
// Best-effort throughout. A box with no LAN (cloud VPS), a detection miss, or an
// unreachable control plane must never affect request serving - the LAN path is
// an optimisation, and every failure just means clients use the public URL.
import { getServerId } from '../db.js'
import { getHostedConfig } from './hosted.js'
import { getIdentityPublicKey } from './serverIdentity.js'
import { getLanUrl } from './lanAddress.js'
import { appLog } from './appLog.js'

const CP_URL = (process.env.HS_CP_API || 'https://api.hearthshelf.com').replace(/\/$/, '')

// Remember what we last successfully reported so a periodic re-check is a no-op
// when nothing moved. The control plane rate-limits these writes, so re-posting
// an unchanged value would burn that budget for no reason.
let lastReported = null

/**
 * Push the current LAN address to the control plane.
 *
 * @param force when true, report even if the value looks unchanged (used after
 *   pairing, where the control plane has no prior value at all).
 */
export async function reportLanAddress({ force = false } = {}) {
  const cfg = await getHostedConfig()
  // Only paired boxes have a server_secret to authenticate with.
  if (!cfg?.serverSecret) return { ok: false, reason: 'not_paired' }

  const serverId = await getServerId()
  const localUrl = getLanUrl()

  // No detectable LAN address. If we previously reported one, withdraw it -
  // leaving a stale private IP on file means clients keep dialling an address
  // that is now someone else's device.
  if (!localUrl) {
    if (!lastReported && !force) return { ok: false, reason: 'no_lan_address' }
    const withdrawn = await post({ server_id: serverId, server_secret: cfg.serverSecret, local_url: '' })
    if (withdrawn) lastReported = null
    return { ok: withdrawn, reason: 'withdrawn' }
  }

  const identityKey = await getIdentityPublicKey()
  if (!identityKey) {
    // Without an identity key the control plane will (correctly) refuse the
    // address, so don't bother asking.
    return { ok: false, reason: 'no_identity_key' }
  }

  if (!force && lastReported === localUrl) return { ok: true, reason: 'unchanged' }

  const ok = await post({
    server_id: serverId,
    server_secret: cfg.serverSecret,
    local_url: localUrl,
    identity_key: identityKey,
  })
  if (ok) {
    lastReported = localUrl
    appLog.info('hosted', `reported LAN address ${localUrl} for offline-capable local access`)
  }
  return { ok, localUrl }
}

async function post(body) {
  try {
    const res = await fetch(`${CP_URL}/servers/local-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      appLog.warn(
        'hosted',
        `LAN address report rejected (${res.status}): ${detail.slice(0, 160)}`,
      )
      return false
    }
    return true
  } catch (err) {
    // Our internet may simply be down - which is precisely the scenario the LAN
    // address exists for. Nothing to do but try again later.
    appLog.warn('hosted', `LAN address report failed: ${String(err).slice(0, 120)}`)
    return false
  }
}

/**
 * Startup + periodic reporting. The address can change without any restart (DHCP
 * lease change, interface flap), and a stale entry is actively harmful, so we
 * re-check on an interval rather than only at boot.
 *
 * Fired with `void` from index.js like the other startup tasks - it must never
 * delay serving.
 */
export function startLanReporting() {
  const RECHECK_MS = 6 * 60 * 60 * 1000 // 6h
  void reportLanAddress({ force: true }).catch(() => {})
  const t = setInterval(() => {
    void reportLanAddress().catch(() => {})
  }, RECHECK_MS)
  // Don't hold the event loop open on shutdown.
  if (typeof t.unref === 'function') t.unref()
}
