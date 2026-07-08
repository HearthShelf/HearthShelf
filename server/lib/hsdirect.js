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

const CP_URL = (
  process.env.HSDIRECT_CP_URL ||
  process.env.HS_CONTROL_PLANE ||
  'https://api.hearthshelf.com'
).replace(/\/$/, '')
// Cert lives on the DATA VOLUME (/config), not an ephemeral container path, so it
// SURVIVES container recreation (image updates). Storing it under /etc/hsdirect
// meant every recreate lost the cert and re-issued from Let's Encrypt - which
// burns LE's 5-duplicate-certs-per-week rate limit (a real 429 we hit). Persisted,
// the cert-reuse guard re-issues only on genuine renewal, never on recreate.
const CERT_DIR = process.env.HSDIRECT_CERT_DIR || '/config/hsdirect/tls'
const STATE_DIR = process.env.HSDIRECT_STATE_DIR || '/config/hsdirect'
const ACME_ENV = process.env.HSDIRECT_ACME_ENV || 'production'
// hs.direct serves HTTPS on the SAME container port as the WebUI (:80), and the
// host maps that to a host port (e.g. Unraid's 9277). The public URL must carry
// that HOST port - which the container only knows if we tell it. HSDIRECT_PUBLIC_PORT
// is the externally-reachable port (default 9277, the AIO WebUI port). The
// reverse-proxy/own-domain user sets PUBLIC_URL instead and this is unused.
const PUBLIC_PORT = Number(process.env.HSDIRECT_PUBLIC_PORT || '9277')
// Renew only when the existing cert has less than this much life left. Let's
// Encrypt certs last 90 days; 30 days of headroom means a paired box renews ~once
// every two months and never re-issues on a plain restart (which would otherwise
// hit LE's duplicate-cert rate limit now that the broker forces issuance).
const RENEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

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
export async function acquireCert({ force = false, reconcilePin = false } = {}) {
  log('acquireCert called', JSON.stringify({ force, reconcilePin, certDir: CERT_DIR }))
  const elig = await hsDirectEligible()
  if (!elig.ok) {
    log('skip:', elig.reason)
    // Note: not_eligible means no usable server_secret, so we can't authenticate
    // a status report. The ABSENCE of any diagnostic row in server_certs is
    // itself the signal that the box stopped at this gate.
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

  // A staging/test cert is untrusted by browsers, so the hosted app can never
  // connect over it. Never reuse one no matter how much life it has left - drop
  // through to a real issuance (the broker is now on a trusted CA). This makes a
  // box that was provisioned against a staging CA self-heal on the next boot or
  // periodic refresh, with no manual cert deletion.
  const certIssuer = await certIssuerString(crtPath).catch(() => '(read failed)')
  const isStaging = await certIsUntrustedStaging(crtPath).catch(() => false)
  log('existing cert issuer:', certIssuer, '| staging?', isStaging)
  // Diagnostic note (issuer + staging-detection result) carried along and attached
  // to whatever the REAL outcome turns out to be below - never reported as its own
  // 'failed' status. Reporting it standalone used to briefly set status='failed' in
  // D1 even when the cert was perfectly valid; if the follow-up 'active' report then
  // dropped (e.g. a transient D1 timeout), that bogus 'failed' was left stranded as
  // the last-known status shown in the admin console.
  const diagNote = `diag: issuer="${certIssuer}" staging=${isStaging} certDir=${CERT_DIR}`
  if (isStaging) {
    log('existing cert is from a staging/test CA (untrusted) - forcing re-issuance')
  }

  // Otherwise skip the network round-trip when we already hold a trusted cert
  // with comfortable life left (e.g. a plain restart). The broker forces a real
  // issuance on every call, so re-issuing on each boot would burn the CA's
  // duplicate-cert rate limit. Only renew within RENEW_WINDOW_MS of expiry (or
  // forced, e.g. at pairing). We still re-render+reload nginx so HTTPS comes up.
  if (!force && !isStaging) {
    const existingNotAfter = await certNotAfterMs(crtPath).catch(() => null)
    if (existingNotAfter && existingNotAfter - Date.now() > RENEW_WINDOW_MS) {
      // Reuse the still-valid wildcard cert (no LE round-trip), but recompute the
      // public URL from the CURRENT public IP - the cert is *.<hash>.<zone>, so a
      // changed residential IP only needs a new dashed-IP label, not a new cert.
      const host = await fs
        .readFile(path.join(STATE_DIR, 'stable_host'), 'utf8')
        .then((s) => s.trim())
        .catch(() => null)
      if (host) {
        const ip = await detectPublicIp()
        const portSuffix = PUBLIC_PORT === 443 ? '' : `:${PUBLIC_PORT}`
        const publicUrl = ip
          ? `https://${ip.replace(/\./g, '-')}.${host}${portSuffix}`
          : `https://${host}${portSuffix}`
        // Re-push to the CP if the IP (hence the address + Clerk redirect_uri pin)
        // changed since last time; then re-render nginx so ABS sees the new host.
        // reconcilePin forces the push even when unchanged (startup self-heal of a
        // stale Clerk pin) - the CP only PATCHes Clerk when the URL actually differs.
        await persistPublicUrl(serverId, serverSecret, publicUrl, { force: reconcilePin })
        log(
          'existing cert valid until',
          new Date(existingNotAfter).toISOString(),
          '- skipping issuance',
        )
        const reloadResult = await reloadNginx()
        const diag = `diag-ok: cert_still_valid reload=${reloadResult} | ${diagNote}`
        await reportStatus(serverId, serverSecret, 'active', diag, existingNotAfter)
        return { ok: true, host, publicUrl, reason: 'cert_still_valid', skipped: true }
      }
      // Cert present but stable_host missing - fall through and re-issue to rebuild it.
    }
  }

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
    'req',
    '-new',
    '-key',
    keyPath,
    '-out',
    csrPath,
    '-subj',
    `/CN=${wildcard}`,
    '-addext',
    `subjectAltName=DNS:${wildcard},DNS:${host}`,
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
      // Log the full broker detail (acme.sh's combined output) - truncating to 200
      // chars hid the real failure line behind the "Copying CSR to:" header.
      warn('broker issue failed', res.status, detail.slice(0, 2000))
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
  // DIAGNOSTIC: confirm what we just wrote to disk (issuer of the NEW cert).
  const newIssuer = await certIssuerString(crtPath).catch(() => '(read failed)')
  log('newly installed cert issuer:', newIssuer)
  const ip = await detectPublicIp()
  // Plex-style: the externally-reachable port lives in the URL (we don't serve on
  // 443). Omit it only when it is 443, so the URL stays clean in that case.
  const portSuffix = PUBLIC_PORT === 443 ? '' : `:${PUBLIC_PORT}`
  const publicUrl = ip
    ? `https://${ip.replace(/\./g, '-')}.${host}${portSuffix}`
    : `https://${host}${portSuffix}`
  await fs.writeFile(path.join(STATE_DIR, 'stable_host'), host)
  await persistPublicUrl(serverId, serverSecret, publicUrl)
  log('cert installed for', wildcard, '->', publicUrl)

  // 5. Reload nginx so it serves the new cert (best-effort).
  const reloadResult = await reloadNginx()
  log('nginx reload result:', reloadResult)

  // 6. Report success (notAfter for the picker's expiry hint).
  const notAfter = await certNotAfterMs(crtPath)
  // DIAGNOSTIC: if nginx did NOT actually reload, the box keeps serving the OLD
  // cert even though issuance succeeded - so record the reload outcome + the new
  // issuer in last_error even on success, so D1 shows whether the new cert is
  // actually being served.
  const diag = `diag-ok: newIssuer="${newIssuer}" reload=${reloadResult}`
  await reportStatus(serverId, serverSecret, 'active', diag, notAfter)

  return { ok: true, host, publicUrl, hash, reloadResult }
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
    } catch {
      /* try next */
    }
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
  } catch {
    /* ignore */
  }
  return null
}

// True when the cert on disk was issued by a CA staging/test environment, which
// no browser trusts. A box that ends up with a staging cert (e.g. issued while
// the broker was pointed at Let's Encrypt staging) would otherwise serve it
// happily for its full ~90-day life, since the renew window only triggers near
// expiry - so the hosted app could never connect. We detect it by the issuer and
// force a fresh, trusted issuance instead. The markers cover Let's Encrypt
// staging ("(STAGING)" / "Fake LE" / "Pebble") and acme.sh's test aliases.
// Raw issuer line for diagnostics (so we can see exactly what's on disk).
async function certIssuerString(crtPath) {
  try {
    const { stdout } = await run('openssl', ['x509', '-issuer', '-noout', '-in', crtPath])
    return stdout.trim()
  } catch (e) {
    return `(no cert: ${e.message})`
  }
}

async function certIsUntrustedStaging(crtPath) {
  try {
    const { stdout } = await run('openssl', ['x509', '-issuer', '-noout', '-in', crtPath])
    const issuer = stdout.toLowerCase()
    return (
      issuer.includes('(staging)') ||
      issuer.includes('staging') ||
      issuer.includes('fake le') ||
      issuer.includes('pebble')
    )
  } catch {
    return false
  }
}

async function reloadNginx() {
  // A bare `nginx -s reload` only re-reads the config files ALREADY on disk. At
  // pairing time those are still the plain-HTTP default.conf (the SSL block isn't
  // rendered until a cert exists), so a plain reload would keep serving HTTP on
  // the WebUI port and every TLS handshake fails (400 -> ERR_SSL_PROTOCOL_ERROR).
  // So we re-run the SAME render step the entrypoint uses - now that the cert +
  // stable_host exist it swaps default.conf -> hsdirect-ssl.conf - THEN reload.
  try {
    await run('/usr/local/bin/render-hsdirect.sh')
  } catch (e) {
    warn('nginx re-render failed (will apply on next restart):', e.message)
    return `render_failed: ${e.message}`
  }
  // Validate BEFORE reloading: a `reload` into a broken config can take nginx
  // down, which would brick LAN access too. `nginx -t` catches it first; if it
  // fails we leave the running config untouched and try again next cycle.
  //
  // stdio must be inherited here, NOT piped (execFile's default): nginx's
  // `error_log /dev/stderr` directive OPENS that path at test/reload time (not
  // just syntax-checks it), and /dev/stderr resolves to fd 2 via
  // /proc/self/fd/2. When Node pipes stderr (the default), fd 2 is a pipe end
  // owned by Node, and re-opening a pipe through its /proc/self/fd path fails
  // with ENXIO ("No such device or address") - so `nginx -t` always failed
  // validation here even on a syntactically-valid config, permanently blocking
  // the reload that swaps in the TLS cert after pairing. Inheriting stdio gives
  // nginx the container's real stderr, matching how the long-running master
  // process (started by the entrypoint, not Node) already works.
  try {
    await run('nginx', ['-t'], { stdio: 'inherit' })
  } catch (e) {
    warn(
      'rendered nginx config failed validation - NOT reloading:',
      (e.stderr || e.message || '').slice(0, 500),
    )
    return `validate_failed: ${(e.stderr || e.message || '').slice(0, 200)}`
  }
  try {
    await run('nginx', ['-s', 'reload'], { stdio: 'inherit' })
    log('nginx re-rendered + reloaded (LAN HTTP + connect HTTPS on the WebUI port)')
    return 'reloaded'
  } catch (e) {
    // Not fatal: the entrypoint re-renders on next start. Log and move on.
    warn('nginx reload failed (will apply on next restart):', e.message)
    return `reload_failed: ${e.message}`
  }
}

/**
 * Persist the computed public_url locally and re-push it to the control plane
 * (server_secret-authed). The CP records the new address and re-PATCHes the Clerk
 * OAuth client's pinned redirect_uri so OIDC sign-in keeps working after a
 * residential IP change. Best-effort: a write always happens; the network push is
 * non-fatal.
 *
 * `force` pushes even when the local URL is unchanged - used on startup to
 * RECONCILE the Clerk pin (e.g. a server paired under older code whose pin is the
 * stale stable host, with an unchanged IP, would otherwise never reconcile). The
 * CP only actually PATCHes Clerk when the redirect_uri differs, so a forced push
 * is cheap and idempotent.
 */
async function persistPublicUrl(serverId, serverSecret, publicUrl, { force = false } = {}) {
  const urlPath = path.join(STATE_DIR, 'public_url')
  let previous = null
  try {
    previous = (await fs.readFile(urlPath, 'utf8')).trim() || null
  } catch {
    /* not written yet */
  }
  await fs.writeFile(urlPath, publicUrl).catch(() => {})
  if (previous === publicUrl && !force) return // unchanged - nothing to re-push
  try {
    await fetch(`${CP_URL}/servers/public-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server_id: serverId,
        server_secret: serverSecret,
        public_url: publicUrl,
      }),
      signal: AbortSignal.timeout(15000),
    })
    log('pushed public_url to control plane:', publicUrl)
  } catch (e) {
    warn('public_url push failed (will retry on next change/renew):', e.message)
  }
}

// Retries on failure (including non-2xx, e.g. a transient D1 timeout on the CP
// side) so a single blip can't strand a stale/wrong status in D1 - this is the
// only thing the admin console reads, so an unreported 'active' would otherwise
// leave whatever status was last recorded (possibly 'failed') showing forever.
async function reportStatus(serverId, serverSecret, status, error, notAfter, attempt = 1) {
  try {
    const res = await fetch(`${CP_URL}/servers/cert-status`, {
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
    if (!res.ok) throw new Error(`cert-status ${res.status}`)
  } catch (e) {
    if (attempt >= 3) {
      warn('cert-status report failed after retries:', e.message)
      return
    }
    await new Promise((r) => setTimeout(r, attempt * 2000))
    await reportStatus(serverId, serverSecret, status, error, notAfter, attempt + 1)
  }
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
  // reconcilePin: re-push public_url even if unchanged, so a stale Clerk
  // redirect_uri pin (e.g. paired under older code) self-heals on boot.
  await acquireCert({ reconcilePin: true }).catch((e) => warn('startup acquire failed:', e.message))

  // Periodically re-run acquireCert so a residential IP change is picked up
  // promptly: the cert-reuse path is cheap (no LE round-trip while the cert is
  // valid) and persistPublicUrl only re-pushes when the address actually changed,
  // which re-PATCHes the Clerk redirect_uri so OIDC sign-in keeps working. Without
  // this the pin would only refresh on restart or renewal (hours-days stale).
  //
  // Cadence is throttled by how much life the cert has left: far from expiry
  // there's no renewal to race, so IP-change detection alone doesn't need the
  // tight 2h loop - a box sitting on a fresh 90-day cert was otherwise checking in
  // every 2h (and writing to D1 every time via reportStatus) for ~60 days
  // straight. Inside the renewal window we go back to the tight interval since
  // that's when a missed IP change or renewal actually matters.
  const activeIntervalMs = Number(
    process.env.HSDIRECT_REFRESH_INTERVAL_MS || String(2 * 60 * 60 * 1000),
  ) // 2h, used once inside the renewal window
  const idleIntervalMs = Number(
    process.env.HSDIRECT_IDLE_REFRESH_INTERVAL_MS || String(24 * 60 * 60 * 1000),
  ) // 24h, used while the cert has comfortable life left

  const crtPath = path.join(CERT_DIR, 'fullchain.pem')
  const nextInterval = async () => {
    const notAfter = await certNotAfterMs(crtPath).catch(() => null)
    return notAfter && notAfter - Date.now() > RENEW_WINDOW_MS ? idleIntervalMs : activeIntervalMs
  }

  const scheduleNext = async () => {
    const delay = await nextInterval()
    const timer = setTimeout(async () => {
      await acquireCert().catch((e) => warn('periodic refresh failed:', e.message))
      scheduleNext()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref() // don't hold the process open
  }
  scheduleNext()
}

/**
 * Current hs.direct state for the onboarding "Verify" step. Reads the persisted
 * state files + cert presence; never throws. status is one of:
 *   'opted_out' | 'not_paired' | 'pending' (paired, cert not installed yet)
 *   | 'active' (cert installed; publicUrl usable).
 */
export async function getHsDirectState() {
  if (hsDirectOptedOut()) return { status: 'opted_out', publicUrl: null, host: null }
  const cfg = await getHostedConfig().catch(() => null)
  if (!cfg?.serverSecret) return { status: 'not_paired', publicUrl: null, host: null }

  let publicUrl = null
  let host = null
  try {
    publicUrl = (await fs.readFile(path.join(STATE_DIR, 'public_url'), 'utf8')).trim() || null
  } catch {
    /* not written yet */
  }
  try {
    host = (await fs.readFile(path.join(STATE_DIR, 'stable_host'), 'utf8')).trim() || null
  } catch {
    /* not written yet */
  }

  let certInstalled = false
  try {
    await fs.access(path.join(CERT_DIR, 'fullchain.pem'))
    certInstalled = true
  } catch {
    /* no cert yet */
  }

  return {
    status: certInstalled && publicUrl ? 'active' : 'pending',
    publicUrl,
    host,
  }
}
