// hs.direct cert acquisition (backend-driven).
//
// hs.direct gives a self-hosted server a free, valid HTTPS hostname automatically
// so app.hearthshelf.com can reach it - the consolidated, monitored connection
// point that is a core reason HearthShelf exists. See
// HearthShelf-WebApp/docs/hs-direct-implementation.md.
//
// Why this lives in the backend (not the entrypoint): the control-plane
// credentials (server_id + server_secret) only exist AFTER the admin pairs with
// app.hearthshelf.com at runtime - they're stored in our SQLite hosted_config,
// not env vars. So we acquire the cert at the pairing moment, right after the
// secret is persisted, and again on boot if a paired box restarts.
//
// Activation rule: hs.direct runs when the box is PAIRED (a server_secret exists)
// and the admin hasn't explicitly opted out (HSDIRECT_DISABLED=true or the WebUI
// toggle). A user's own PUBLIC_URL does NOT disable it - hs.direct stays as the
// always-valid fallback the control plane can monitor.
//
// Key custody: the private key is generated HERE and never leaves the box. We
// send only a CSR to the VPS broker, which returns the signed wildcard chain.

import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getServerId } from '../db.js'
import { getHostedConfig } from './hosted.js'
import { getMode } from './context.js'

const execFileP = promisify(execFile)

const CP_URL = (process.env.HSDIRECT_CP_URL || process.env.HS_CONTROL_PLANE || 'https://api.hearthshelf.com').replace(/\/$/, '')
const CERT_DIR = process.env.HSDIRECT_CERT_DIR || '/etc/hsdirect/tls'
const STATE_DIR = process.env.HSDIRECT_STATE_DIR || '/config/hsdirect'
const ACME_ENV = process.env.HSDIRECT_ACME_ENV || 'production'

const log = (...a) => console.log('[hsdirect]', ...a)
const warn = (...a) => console.warn('[hsdirect]', ...a)

/**
 * Is hs.direct allowed to run? On by default once paired; off only when the admin
 * explicitly opts out. Setting your own PUBLIC_URL does NOT count as opting out -
 * hs.direct remains the monitored fallback connection.
 */
export function hsDirectOptedOut() {
  const v = (process.env.HSDIRECT_DISABLED || '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/** Whether we should attempt hs.direct right now (paired + opted-in). */
export async function hsDirectEligible() {
  if (hsDirectOptedOut()) return { ok: false, reason: 'opted_out' }
  const cfg = await getHostedConfig()
  if (!cfg?.serverSecret) return { ok: false, reason: 'not_paired' }
  return { ok: true, serverSecret: cfg.serverSecret }
}

async function run(cmd, args, opts = {}) {
  return execFileP(cmd, args, { maxBuffer: 4 * 1024 * 1024, ...opts })
}

/**
 * Acquire (or refresh) the hs.direct wildcard cert and install it for nginx.
 * Idempotent and non-fatal: any failure is logged and returns {ok:false}; it
 * never throws into the pairing flow. Returns the hs.direct host + public URL on
 * success so the caller can report it / use it as the pairing public_url.
 */
export async function acquireCert({ force = false } = {}) {
  const elig = await hsDirectEligible()
  if (!elig.ok) {
    log('skip:', elig.reason)
    return { ok: false, reason: elig.reason }
  }
  const serverId = await getServerId()
  const serverSecret = elig.serverSecret

  try {
    await fs.mkdir(CERT_DIR, { recursive: true })
    await fs.mkdir(STATE_DIR, { recursive: true })
  } catch (e) {
    warn('mkdir failed:', e.message)
    return { ok: false, reason: 'fs_error' }
  }

  const keyPath = path.join(CERT_DIR, 'server.key')
  const csrPath = path.join(CERT_DIR, 'server.csr')
  const crtPath = path.join(CERT_DIR, 'fullchain.pem')

  // 1. Ask the control plane to authorize issuance. Returns the broker URL, the
  //    stable <hash> + host, and a short-lived grant the broker verifies.
  let grant
  try {
    const res = await fetch(`${CP_URL}/servers/cert-grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: serverId, server_secret: serverSecret }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      warn('cert-grant failed', res.status, detail.slice(0, 200))
      return { ok: false, reason: 'cert_grant_failed', status: res.status }
    }
    grant = await res.json()
  } catch (e) {
    warn('cert-grant unreachable:', e.message)
    return { ok: false, reason: 'cp_unreachable' }
  }

  const { cert_grant: token, broker_url: brokerUrl, hash, host } = grant
  if (!token || !brokerUrl || !hash || !host) {
    warn('cert-grant response missing fields')
    return { ok: false, reason: 'bad_grant_response' }
  }
  const wildcard = `*.${host}`

  // 2. Generate our own EC keypair (once; reuse on renewal) and a CSR. The key
  //    never leaves this box.
  try {
    await fs.access(keyPath)
  } catch {
    await run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath])
    await fs.chmod(keyPath, 0o600)
  }
  await run('openssl', [
    'req', '-new', '-key', keyPath, '-out', csrPath,
    '-subj', `/CN=${wildcard}`,
    '-addext', `subjectAltName=DNS:${wildcard},DNS:${host}`,
  ])
  const csrPem = await fs.readFile(csrPath, 'utf8')

  // 3. Send the CSR + grant to the VPS broker. It runs ACME DNS-01 and returns
  //    the signed chain. Broker TLS is verified normally - the broker should
  //    serve a real cert for its own hostname (it self-issues one via acme.sh).
  //    The broker serves a real Let's Encrypt cert for its own hostname
  //    (ns1.d.hearthshelf.com), so TLS is verified normally. The grant is the
  //    authorization that lets only a paired server obtain a cert.
  let certPem
  try {
    const res = await fetch(`${brokerUrl.replace(/\/$/, '')}/issue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csr: csrPem, server_id: serverId, hash }),
      signal: AbortSignal.timeout(240000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      warn('broker issue failed', res.status, detail.slice(0, 200))
      await reportStatus(serverId, serverSecret, 'failed', `broker ${res.status}`)
      return { ok: false, reason: 'broker_failed', status: res.status }
    }
    const body = await res.json()
    certPem = body.cert
  } catch (e) {
    warn('broker unreachable:', e.message)
    await reportStatus(serverId, serverSecret, 'failed', `broker unreachable`)
    return { ok: false, reason: 'broker_unreachable' }
  }

  if (!certPem || !certPem.includes('BEGIN CERTIFICATE')) {
    warn('broker returned no certificate')
    await reportStatus(serverId, serverSecret, 'failed', 'no certificate')
    return { ok: false, reason: 'no_cert' }
  }

  // 4. Install the chain + compute the public URL from our current public IP.
  await fs.writeFile(crtPath, certPem, { mode: 0o644 })
  const ip = await detectPublicIp()
  const publicUrl = ip ? `https://${ip.replace(/\./g, '-')}.${host}` : `https://${host}`
  await fs.writeFile(path.join(STATE_DIR, 'stable_host'), host)
  await fs.writeFile(path.join(STATE_DIR, 'public_url'), publicUrl)
  log('cert installed for', wildcard, '->', publicUrl)

  // 5. Reload nginx so it serves the new cert on :443 (best-effort).
  await reloadNginx()

  // 6. Report success (notAfter for the picker's expiry hint).
  const notAfter = await certNotAfterMs(crtPath)
  await reportStatus(serverId, serverSecret, 'active', null, notAfter)

  return { ok: true, host, publicUrl, hash }
}

// Best-effort public IP lookup via several echo services. Returns the IPv4
// string or null. Exported so the onboarding wizard can show the admin their
// real public address (not the LAN one) before connecting.
export async function detectPublicIp() {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (r.ok) {
        const ip = (await r.text()).trim()
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
      }
    } catch { /* try next */ }
  }
  return null
}

async function certNotAfterMs(crtPath) {
  try {
    const { stdout } = await run('openssl', ['x509', '-enddate', '-noout', '-in', crtPath])
    const m = stdout.match(/notAfter=(.+)/)
    if (m) {
      const t = Date.parse(m[1])
      return Number.isFinite(t) ? t : null
    }
  } catch { /* ignore */ }
  return null
}

async function reloadNginx() {
  // In the AIO container nginx runs as a sibling process; signal it to reload.
  try {
    await run('nginx', ['-s', 'reload'])
    log('nginx reloaded')
  } catch (e) {
    // Not fatal: on first pairing nginx may not yet have the :443 block; the
    // entrypoint re-templates on next start. Log and move on.
    warn('nginx reload failed (will apply on next restart):', e.message)
  }
}

async function reportStatus(serverId, serverSecret, status, error, notAfter) {
  try {
    await fetch(`${CP_URL}/servers/cert-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server_id: serverId,
        server_secret: serverSecret,
        status,
        acme_env: ACME_ENV,
        ...(notAfter ? { not_after: notAfter } : {}),
        ...(error ? { error } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    })
  } catch { /* best-effort */ }
}

/**
 * Backend startup hook: if this box is already paired (restart after a prior
 * pairing) and not opted out, refresh the cert so :443 keeps working. Non-fatal.
 * Only meaningful on the AIO image, where nginx + the box are co-located.
 */
export async function hsDirectOnStartup() {
  if (getMode() !== 'aio') return
  const elig = await hsDirectEligible()
  if (!elig.ok) return
  log('paired box starting - refreshing hs.direct cert')
  await acquireCert().catch((e) => warn('startup acquire failed:', e.message))
}
