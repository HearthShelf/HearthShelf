// Email relay shim (SMTP -> control-plane HTTP).
//
// Self-hosters otherwise have to stand up their own SMTP just so ABS can deliver
// e-reader books and test mail. This runs a tiny SMTP server on localhost that
// ABS talks to as if it were a normal mail server; we parse each message and
// forward it to the control plane (POST /email/send), which sends it through
// HearthShelf's shared Resend instance. The box never holds a Resend credential
// - it authenticates with the server_secret it already got at pairing time.
//
// Why this lives in the backend (not a separate sidecar): the control-plane
// credentials (server_id + server_secret) only exist AFTER pairing and are kept
// in our SQLite hosted_config, not env vars. The backend already owns that DB
// and is a long-running process, so the listener rides along with it - same
// reasoning as hsdirect.js.
//
// Activation rule (mirrors hs.direct): runs when the box is PAIRED and the admin
// hasn't opted out (HS_EMAIL_RELAY_DISABLED=true). Listens on loopback only.

import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { getServerId } from '../db.js'
import { getHostedConfig } from './hosted.js'

// Loopback host + a default port ABS points its SMTP host/port at. Both are
// overridable so the aio image (HS + ABS in one container) and the slim image
// (separate containers sharing the internal network) can differ if needed.
const HOST = process.env.HS_EMAIL_RELAY_HOST || '127.0.0.1'
const PORT = Number(process.env.HS_EMAIL_RELAY_PORT || '12525')

const log = (...a) => console.log('[email-relay]', ...a)
const warn = (...a) => console.warn('[email-relay]', ...a)

// Reject the SMTP transaction with a specific reply code. smtp-server reads
// `responseCode` off the error; without it ABS sees a generic 450 and our real
// code gets buried in the message text. 4xx = transient (ABS may retry), 5xx =
// permanent.
function smtpError(code, message) {
  const err = new Error(message)
  err.responseCode = code
  return err
}

/** On by default once paired; off only when the admin explicitly opts out. */
export function emailRelayOptedOut() {
  const v = (process.env.HS_EMAIL_RELAY_DISABLED || '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/** The loopback address ABS should be pointed at, for the auto-config UI. */
export function emailRelayEndpoint() {
  return { host: HOST, port: PORT }
}

// Forward one parsed message to the control plane. Returns the CP response so
// the SMTP callback can surface a clean accept/reject to ABS.
async function forward({
  issuer,
  serverId,
  serverSecret,
  to,
  subject,
  html,
  text,
  replyTo,
  attachments = [],
}) {
  const cpBase = issuer.replace(/\/$/, '')
  const res = await fetch(`${cpBase}/email/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server_id: serverId,
      server_secret: serverSecret,
      to,
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(attachments.length ? { attachments } : {}),
    }),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

/** Send one HearthShelf-owned transactional message through the same paired
 * control-plane relay used by ABS SMTP. Best-effort and safe for feature routes:
 * invitation state is committed even when email delivery is unavailable. */
export async function sendTransactionalEmail({
  to,
  subject,
  html,
  text,
  replyTo = '',
  attachments = [],
}) {
  if (!to || !to.includes('@')) return { sent: false, reason: 'no_email' }
  if (emailRelayOptedOut()) return { sent: false, reason: 'relay_disabled' }
  const cfg = await getHostedConfig().catch(() => null)
  if (!cfg?.serverSecret || !cfg?.issuer) return { sent: false, reason: 'not_paired' }
  try {
    const serverId = await getServerId()
    const result = await forward({
      issuer: cfg.issuer,
      serverId,
      serverSecret: cfg.serverSecret,
      to,
      subject,
      html,
      text,
      replyTo,
      attachments,
    })
    if (result.status >= 200 && result.status < 300) return { sent: true }
    return {
      sent: false,
      reason: result.status === 429 ? 'allowance_reached' : 'relay_rejected',
    }
  } catch {
    return { sent: false, reason: 'relay_unreachable' }
  }
}

// Pull the single recipient ABS addressed (ereader sends + test mail are 1:1).
// If a message ever carries multiple recipients we take the first; the relay is
// for ABS's transactional mail, not bulk.
function firstRecipient(parsed, envelopeRcpt) {
  const fromHeader = parsed?.to?.value?.[0]?.address
  if (fromHeader) return fromHeader
  return envelopeRcpt?.[0]?.address || ''
}

function buildServer() {
  return new SMTPServer({
    // ABS connects over plain SMTP on loopback; no TLS/upgrade needed inside the
    // box, and we never accept connections off-host.
    secure: false,
    disabledCommands: ['STARTTLS'],
    // ABS authenticates (nodemailer always sends AUTH when a user is set). We
    // don't validate - reaching loopback is the trust boundary - but we must
    // accept AUTH or ABS refuses to send.
    authOptional: true,
    onAuth(_auth, _session, cb) {
      cb(null, { user: 'hearthshelf' })
    },
    async onData(stream, session, cb) {
      let cfg
      try {
        cfg = await getHostedConfig()
      } catch (err) {
        return cb(smtpError(451, `relay config unavailable: ${String(err).slice(0, 80)}`))
      }
      if (!cfg?.serverSecret || !cfg?.issuer) {
        return cb(
          smtpError(451, 'box not paired with HearthShelf; configure your own SMTP instead'),
        )
      }

      let parsed
      try {
        parsed = await simpleParser(stream)
      } catch (err) {
        return cb(smtpError(451, `could not parse message: ${String(err).slice(0, 80)}`))
      }

      const to = firstRecipient(parsed, session.envelope?.rcptTo)
      if (!to || !to.includes('@')) return cb(smtpError(550, 'no usable recipient'))
      const subject = parsed.subject || '(no subject)'
      const html = parsed.html || ''
      const text = parsed.text || ''
      const replyTo = parsed.replyTo?.value?.[0]?.address || ''

      let result
      try {
        const serverId = await getServerId()
        result = await forward({
          issuer: cfg.issuer,
          serverId,
          serverSecret: cfg.serverSecret,
          to,
          subject,
          html,
          text,
          replyTo,
        })
      } catch (err) {
        return cb(smtpError(451, `control plane unreachable: ${String(err).slice(0, 80)}`))
      }

      if (result.status === 429) {
        return cb(smtpError(452, 'monthly email allowance reached for this server'))
      }
      if (result.status < 200 || result.status >= 300) {
        const detail = result.data?.detail || result.data?.error || `status ${result.status}`
        return cb(smtpError(451, `relay rejected: ${String(detail).slice(0, 100)}`))
      }
      log(`relayed to ${to} (subject: ${subject.slice(0, 40)})`)
      cb()
    },
  })
}

let started = false

// Start the loopback SMTP listener if the box is paired and opted in. Idempotent
// and best-effort: a bind failure logs and returns rather than killing the
// backend - email relay is optional, the core app must still serve.
export async function emailRelayOnStartup() {
  if (started) return
  if (emailRelayOptedOut()) {
    log('disabled (HS_EMAIL_RELAY_DISABLED)')
    return
  }
  const cfg = await getHostedConfig().catch(() => null)
  if (!cfg?.serverSecret || !cfg?.issuer) {
    log('not paired yet; relay idle (ABS keeps its own SMTP until you pair)')
    return
  }

  const server = buildServer()
  server.on('error', (err) => warn('smtp server error:', String(err).slice(0, 160)))
  await new Promise((resolve) => {
    server.listen(PORT, HOST, () => {
      started = true
      log(`listening on ${HOST}:${PORT} -> ${cfg.issuer.replace(/\/$/, '')}/email/send`)
      resolve()
    })
  })
}
