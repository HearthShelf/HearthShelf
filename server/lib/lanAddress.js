// Detect this box's LAN address so the control plane can offer it to clients as
// an additional way to reach us.
//
// WHY: when the server's internet goes down (dead WAN, ISP outage, tunnel down) a
// phone on the same Wi-Fi can still reach it - but only if it knows a local
// address. The public URL resolves to the now-unroutable WAN IP, so packets leave
// via the router and die even though the server is metres away.
//
// This is deliberately BEST-EFFORT and advisory. A wrong answer must be harmless:
// the address is only ever an extra candidate that the client tries briefly, with
// a mandatory cryptographic identity check (serverIdentity.js) before any
// credential is presented. So the failure mode of bad detection is a fast
// timeout, never a security problem.
//
// CONTAINER CAVEAT: in Docker's default bridge network this process sees a
// container-private address (172.17.x.x) that no phone can reach. We cannot
// reliably detect that from inside, so HS_LAN_URL exists as an explicit operator
// override and always wins.
import os from 'node:os'
import { appLog } from './appLog.js'

/**
 * Private / link-local ranges we are willing to advertise. Anything outside these
 * is either public (belongs in public_url, not here) or unusable.
 */
function classifyIpv4(ip) {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null
  const [a, b] = o
  if (a === 10) return 'private' // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return 'private' // 172.16.0.0/12
  if (a === 192 && b === 168) return 'private' // 192.168.0.0/16
  if (a === 169 && b === 254) return 'linklocal' // 169.254.0.0/16 - last resort
  return null
}

/**
 * Docker's default bridge sits in 172.17-172.31. It IS private, but it is
 * container-internal and unreachable from a phone, so advertising it is worse
 * than advertising nothing (it wastes a connect attempt every launch). We rank
 * it last rather than excluding it outright, because on host-network deployments
 * a 172.x address can be the real LAN.
 */
function isLikelyContainerBridge(ip) {
  const o = ip.split('.').map(Number)
  return o[0] === 172 && o[1] >= 17 && o[1] <= 31
}

/**
 * Best guess at the LAN IPv4 other devices on this network can reach us at.
 * Returns null when nothing plausible is found (a cloud VPS, for instance - which
 * correctly has no LAN story at all).
 */
export function detectLanIp() {
  const ifaces = os.networkInterfaces()
  const candidates = []
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue
      if (a.internal) continue // loopback
      const cls = classifyIpv4(a.address)
      if (!cls) continue
      // Rank: real private LAN > container bridge > link-local (self-assigned,
      // which usually means DHCP failed and is rarely useful).
      let rank = 0
      if (cls === 'linklocal') rank = 2
      else if (isLikelyContainerBridge(a.address)) rank = 1
      candidates.push({ ip: a.address, iface: name, rank })
    }
  }
  if (!candidates.length) return null
  candidates.sort((x, y) => x.rank - y.rank)
  return candidates[0].ip
}

/**
 * The LAN URL to report to the control plane, or null if we shouldn't report one.
 *
 * Plain http on purpose: a private IP cannot carry a CA-valid certificate, so
 * https would fail cert validation on every client. The security tradeoff is
 * covered by (a) the mandatory identity handshake before any credential is sent,
 * and (b) the client restricting LAN use to Wi-Fi it has been told about. Callers
 * that care about confidentiality on untrusted Wi-Fi should prefer the public
 * URL, which the client already tries.
 *
 * HS_LAN_URL overrides detection entirely (Docker bridge, multi-homed hosts, an
 * operator who wants a .local name or a non-default port).
 * HS_LAN_DISABLE=1 opts out completely.
 */
export function getLanUrl() {
  if (process.env.HS_LAN_DISABLE === '1') return null

  const override = (process.env.HS_LAN_URL || '').trim()
  if (override) {
    try {
      const u = new URL(override)
      return u.origin
    } catch {
      appLog.warn('hosted', `HS_LAN_URL is not a valid URL, ignoring: ${override.slice(0, 80)}`)
    }
  }

  const ip = detectLanIp()
  if (!ip) return null
  // The port clients reach us on. nginx fronts both ABS and /hs on one port, so
  // this is the same port the public URL uses.
  const port = (process.env.HS_LAN_PORT || process.env.PORT || '80').trim()
  return port === '80' ? `http://${ip}` : `http://${ip}:${port}`
}
