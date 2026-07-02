// HearthShelf backend - the app's own server beyond static nginx. Holds the AI
// provider key and the RMAB session server-side, identifies the caller via their
// ABS token, enforces per-user rate limits, and serves HearthShelf-specific
// features (QuestGiver, Discover, settings sync, RMAB requests, Audible search).
//
// This file is a thin dispatcher: it resolves the request context once, then
// offers the request to each feature route module in turn. Feature logic lives
// in server/routes/*; shared helpers in server/lib/*.
//
// Routes (nginx proxies /hs/* here):
//   /hs/questgiver/*  -> config, admin AI config, recommend, runs, health
//   /hs/discover/*    -> monthly AI shelf, feedback, popular signals
//   /hs/settings      -> per-user app settings sync
//   /hs/queue         -> per-user listening queue sync
//   /hs/social/*      -> cross-user leaderboard + finished counts + listening-now
//   /hs/notes         -> public + club notes (spoiler-gated)
//   /hs/clubs/*       -> book clubs (multi-book groups, per-book chat)
//   /hs/stats         -> the caller's computed listening stats (streak, week, ...)
//   /hs/narrators/*   -> narrator photos (HearthShelf-native; ABS has none)
//   /hs/rmab/*        -> ReadMeABook acquisition proxy
//   /hs/audible/*     -> HearthShelf's own Audible catalog search
//   /hs/audplexus/*   -> Audplexus library-sync diagnostics (admin)
//   /hs/integrations/config -> admin: edit RMAB/Audplexus/Audible connection
//
// Integration connection settings (RMAB, Audplexus, Audible region) live in the
// integrations_config DB table, editable from Config > Integrations. Setting the
// matching env var (RMAB_URL / RMAB_LOGIN_TOKEN / AUDPLEXUS_URL / AUDPLEXUS_KEY /
// AUDIBLE_REGION) OVERRIDES the DB for that field and locks it in the UI. Same
// model for the QG_* / DISCOVER_ENABLED AI config. See server/integrations.js
// and server/config.js.
//
// Env: QG_PROVIDER, QG_MODEL, QG_API_KEY, QG_BASE_URL, QG_LIMIT, QG_ENABLED,
//      DISCOVER_ENABLED, QG_DATA_DIR, ABS_SERVER_URL (to validate the caller's
//      token), HS_MODE.

import http from 'node:http'
import { json } from './lib/http.js'
import { resolveContext } from './lib/context.js'
import { initDb, getServerId } from './db.js'
import { isProviderConfigured } from './providers.js'
import { handleQuestGiver } from './routes/questgiver.js'
import { handleDiscover } from './routes/discover.js'
import { handleSettings } from './routes/settings.js'
import { handleQueue } from './routes/queue.js'
import { handleSocial } from './routes/social.js'
import { handleNotes } from './routes/notes.js'
import { handleRmab } from './routes/rmab.js'
import { handleAudible } from './routes/audible.js'
import { handleAudplexus } from './routes/audplexus.js'
import { handleIntegrations } from './routes/integrations.js'
import { handleHosted } from './routes/hosted.js'
import { handleRuntime } from './routes/runtime.js'
import { handleServiceAccounts } from './routes/serviceAccounts.js'
import { handleAvatars } from './routes/avatars.js'
import { handleNarrators } from './routes/narrators.js'
import { handleFinishedBooks } from './routes/finished-books.js'
import { handleStats } from './routes/stats.js'
import { provisionAio } from './lib/provision-aio.js'
import { hsDirectOnStartup } from './lib/hsdirect.js'
import { emailRelayOnStartup } from './lib/emailRelay.js'

const PORT = process.env.QG_PORT || 8080

// In hosted mode the SPA at app.hearthshelf.com calls this server cross-origin
// (it holds an ABS/grant bearer, not a cookie), so /hs/* must allow that one
// origin. Scoped to the configured origin, never '*', and credentials stay off
// since we use bearer tokens. Self-hosted (same-origin) mode sets nothing.
const APP_ORIGIN = (process.env.HS_APP_ORIGIN || 'https://app.hearthshelf.com').replace(/\/$/, '')

function applyCors(req, res) {
  // NOT gated on HS_MODE: a paired AIO/slim box (mode 'aio'/'slim', not 'hosted')
  // still serves cross-origin connect/grant calls from app.hearthshelf.com, so we
  // must answer the CORS preflight + set headers whenever the request comes from
  // the allowed app origin. Only that one origin is ever allowed (never '*').
  const origin = req.headers['origin']
  const allowed = origin && origin.replace(/\/$/, '') === APP_ORIGIN
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '86400')
  }
  // Short-circuit the preflight for an allowed origin, regardless of route/mode.
  if (allowed && req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return true
  }
  return false
}

// Feature route modules, tried in order. Each returns true once it has handled
// (and responded to) the request, false to let the next module try.
const ROUTES = [
  handleRuntime,
  handleServiceAccounts,
  handleAvatars,
  handleNarrators,
  handleHosted,
  handleQuestGiver,
  handleDiscover,
  handleSettings,
  handleQueue,
  handleSocial,
  handleNotes,
  handleFinishedBooks,
  handleStats,
  handleRmab,
  handleAudible,
  handleAudplexus,
  handleIntegrations,
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  // CORS for the hosted SPA (and OPTIONS preflight short-circuit).
  if (applyCors(req, res)) return

  // Resolve the caller's context once. Handlers that require auth check for a
  // null ctx themselves (some routes, like /hs/questgiver/config, work
  // unauthenticated and just return less data).
  let ctx = null
  try {
    ctx = await resolveContext(req)
  } catch (err) {
    return json(res, 500, { error: 'context_error', detail: String(err).slice(0, 120) })
  }

  try {
    for (const route of ROUTES) {
      if (await route(req, res, url, ctx)) return
    }
  } catch (err) {
    if (!res.headersSent)
      json(res, 500, { error: 'server_error', detail: String(err).slice(0, 160) })
    return
  }

  json(res, 404, { error: 'not_found' })
})

// Initialise the database (schema + migrations + legacy JSON import) and our
// server identity before accepting traffic, so the first request never races
// table creation.
initDb()
  .then(async () => {
    const serverId = await getServerId()
    const configured = await isProviderConfigured()
    // All-in-one image: detect the bundled ABS's setup state on boot (is it
    // initialised yet?). Runs in the background so it never delays serving - the
    // SPA polls /hs/runtime and shows onboarding once ABS is ready. The admin
    // creates the root user from the wizard, not here. No-op on slim/hosted.
    void provisionAio()
    // If this AIO box was already paired with app.hearthshelf.com, refresh its
    // hs.direct certificate on boot so :443 keeps serving a valid cert (the IP
    // may have changed while it was down). No-op when not paired, opted out, or
    // not the AIO image. Background; never delays serving.
    void hsDirectOnStartup()
    // If paired, start the loopback SMTP relay so ABS can send e-reader books +
    // test mail through HearthShelf's shared Resend without its own SMTP. No-op
    // when unpaired or opted out. Background; never delays serving.
    void emailRelayOnStartup()
    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(
        `[hearthshelf] listening on :${PORT} (server ${serverId}, provider configured: ${configured})`,
      )
    })
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[hearthshelf] failed to initialise:', err)
    process.exit(1)
  })
