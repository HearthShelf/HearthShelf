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
//   /hs/social/*      -> cross-user leaderboard + per-book finished counts
//   /hs/rmab/*        -> ReadMeABook acquisition proxy
//   /hs/audible/*     -> HearthShelf's own Audible catalog search
//   /hs/audplexus/*   -> Audplexus library-sync diagnostics (admin)
//
// Env: QG_PROVIDER, QG_MODEL, QG_API_KEY, QG_BASE_URL, QG_LIMIT, QG_ENABLED,
//      DISCOVER_ENABLED, QG_DATA_DIR, RMAB_URL, RMAB_LOGIN_TOKEN, AUDIBLE_REGION,
//      AUDPLEXUS_URL, AUDPLEXUS_KEY, ABS_SERVER_URL (to validate the caller's
//      token), HS_MODE.

import http from 'node:http'
import { json } from './lib/http.js'
import { resolveContext } from './lib/context.js'
import { initDb, getServerId } from './db.js'
import { isProviderConfigured } from './providers.js'
import { handleQuestGiver } from './routes/questgiver.js'
import { handleDiscover } from './routes/discover.js'
import { handleSettings } from './routes/settings.js'
import { handleSocial } from './routes/social.js'
import { handleRmab } from './routes/rmab.js'
import { handleAudible } from './routes/audible.js'
import { handleAudplexus } from './routes/audplexus.js'
import { handleHosted } from './routes/hosted.js'
import { handleRuntime } from './routes/runtime.js'
import { provisionAio } from './lib/provision-aio.js'

const PORT = process.env.QG_PORT || 8080

// Feature route modules, tried in order. Each returns true once it has handled
// (and responded to) the request, false to let the next module try.
const ROUTES = [
  handleRuntime,
  handleHosted,
  handleQuestGiver,
  handleDiscover,
  handleSettings,
  handleSocial,
  handleRmab,
  handleAudible,
  handleAudplexus,
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

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
    if (!res.headersSent) json(res, 500, { error: 'server_error', detail: String(err).slice(0, 160) })
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
    // All-in-one image: set up the bundled ABS on first boot (root user, admin
    // token, default library). Runs in the background so it never delays serving
    // - the SPA polls /hs/runtime and shows onboarding once ABS is ready. A
    // no-op on slim/hosted and on every boot after the first.
    void provisionAio()
    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(
        `[hearthshelf] listening on :${PORT} (server ${serverId}, provider configured: ${configured})`
      )
    })
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[hearthshelf] failed to initialise:', err)
    process.exit(1)
  })
