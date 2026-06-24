// The HearthShelf datastore. libSQL (embedded SQLite) replaces the old
// discover.json file. One file holds everything the backend keeps: QuestGiver
// feedback / history / monthly-shelf cache, popular signals, durable rate-limit
// counts, the editable AI config, and per-user app settings.
//
// libSQL is the same engine Turso runs, embedded against a local file. To point
// at a remote Turso primary later, set HS_DB_URL (libsql://...) + HS_DB_TOKEN;
// otherwise it falls back to a local file under QG_DATA_DIR. No code changes.
//
// Env: HS_DB_URL, HS_DB_TOKEN (optional remote); QG_DATA_DIR (default /app/data).

import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'

const DIR = process.env.QG_DATA_DIR || '/app/data'
const FILE = path.join(DIR, 'hearthshelf.db')

// Remote (Turso) when HS_DB_URL is set, else an embedded local file.
const url = process.env.HS_DB_URL || pathToFileURL(FILE).toString()
const authToken = process.env.HS_DB_TOKEN || undefined

export const db = createClient({ url, authToken })

// WAL lets readers and the single writer run concurrently without blocking -
// the right mode for a small multi-user box. No-op / harmless on remote libSQL.
async function applyPragmas() {
  if (process.env.HS_DB_URL) return // remote primary manages its own settings
  try {
    await db.execute('PRAGMA journal_mode = WAL')
    await db.execute('PRAGMA busy_timeout = 5000')
    await db.execute('PRAGMA foreign_keys = ON')
  } catch {
    // Pragmas are best-effort; the DB still works without them.
  }
}

// Idempotent schema. Runs on every boot; CREATE ... IF NOT EXISTS is a no-op
// once the tables exist, so this doubles as the migration entry point.
//
// Every per-user table keys on (server_id, user_id): an ABS user id is only
// unique within one ABS server, so the server_id (this HearthShelf instance's
// identity, see getServerId) namespaces data. Self-hosted has one server_id;
// the future hosted model fronts many. server_id defaults to LOCAL_SERVER for
// rows migrated from the pre-server_id schema.
const LOCAL_SERVER = 'local'

const SCHEMA = [
  // This instance's identity. One row; server_id is a self-generated UUID that
  // survives ABS URL changes (we don't derive it from ABS, which exposes no
  // stable GUID). Seeded by getServerId() on first boot.
  `CREATE TABLE IF NOT EXISTS server_identity (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     server_id  TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS qg_feedback (
     server_id TEXT NOT NULL DEFAULT 'local',
     user_id   TEXT NOT NULL,
     item_key  TEXT NOT NULL,
     vote      TEXT,
     rating    INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (server_id, user_id, item_key)
   )`,
  `CREATE TABLE IF NOT EXISTS qg_monthly (
     server_id  TEXT NOT NULL DEFAULT 'local',
     user_id    TEXT NOT NULL,
     month      TEXT NOT NULL,
     engine     TEXT,
     intro      TEXT,
     picks_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (server_id, user_id, month)
   )`,
  // Popular signals are per-server (one server's library/community), so they
  // key on (server_id, date).
  `CREATE TABLE IF NOT EXISTS popular_signals (
     server_id  TEXT NOT NULL DEFAULT 'local',
     date       TEXT NOT NULL,
     items_json TEXT NOT NULL,
     PRIMARY KEY (server_id, date)
   )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     server_id  TEXT NOT NULL DEFAULT 'local',
     user_id    TEXT NOT NULL,
     period_key TEXT NOT NULL,
     count      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (server_id, user_id, period_key)
   )`,
  // AI config is a single instance-wide row (the admin's provider/key), not
  // per-user, so it stays single-row.
  `CREATE TABLE IF NOT EXISTS ai_config (
     id        INTEGER PRIMARY KEY CHECK (id = 1),
     provider  TEXT,
     model     TEXT,
     api_key   TEXT,
     base_url  TEXT,
     ai_limit  TEXT,
     enabled   INTEGER NOT NULL DEFAULT 1,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS qg_runs (
     id          TEXT PRIMARY KEY,
     server_id   TEXT NOT NULL DEFAULT 'local',
     user_id     TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     summary     TEXT,
     result_json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_qg_runs_user
     ON qg_runs (server_id, user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS app_settings (
     server_id    TEXT NOT NULL DEFAULT 'local',
     user_id      TEXT NOT NULL,
     values_json  TEXT NOT NULL,
     updated_at   INTEGER NOT NULL,
     PRIMARY KEY (server_id, user_id)
   )`,
  // Hosted-mode config: a single row holding how this instance trusts the
  // control plane (app.hearthshelf.com) and acts on ABS for federated users.
  // Only present/used when HS_MODE=hosted. Written by the pairing flow.
  `CREATE TABLE IF NOT EXISTS hosted_config (
     id              INTEGER PRIMARY KEY CHECK (id = 1),
     issuer          TEXT,        -- control-plane issuer (JWT iss to require)
     jwks_url        TEXT,        -- where to fetch the control plane's pubkeys
     server_secret   TEXT,        -- this server's secret for the control plane
     abs_admin_token TEXT,        -- ABS admin token used to mint per-user keys
     updated_at      INTEGER NOT NULL
   )`,
  // Per-user ABS API key cache (hosted mode). After verifying a control-plane
  // grant, HS resolves the ABS user by verified email and mints a per-user ABS
  // API key once, caching it here so later requests skip the round-trip. Keyed
  // by the control-plane subject (Clerk user id) plus this server_id.
  `CREATE TABLE IF NOT EXISTS hosted_user_keys (
     server_id   TEXT NOT NULL,
     cp_subject  TEXT NOT NULL,   -- Clerk user id (grant sub)
     email       TEXT NOT NULL,   -- verified email the key was minted for
     abs_user_id TEXT NOT NULL,
     abs_api_key TEXT NOT NULL,
     role        TEXT,
     synced_username TEXT,        -- last Clerk username pushed to ABS (sync guard)
     created_at  INTEGER NOT NULL,
     PRIMARY KEY (server_id, cp_subject)
   )`,
  // First-boot provisioning state (all-in-one image only). One row records that
  // the bundled ABS has been initialised (root user created, default library
  // made) so the routine runs exactly once, and stashes the minted admin token
  // the auto-provision + onboarding flow reuse. Empty/absent on slim images.
  `CREATE TABLE IF NOT EXISTS provisioning (
     id              INTEGER PRIMARY KEY CHECK (id = 1),
     abs_initialized INTEGER NOT NULL DEFAULT 0,
     abs_admin_token TEXT,        -- admin token minted at provision time
     root_username   TEXT,
     root_password   TEXT,        -- generated root password, revealed once in setup
     onboarded       INTEGER NOT NULL DEFAULT 0,  -- user finished the wizard
     updated_at      INTEGER NOT NULL
   )`,
]

// Bring a pre-server_id database up to the keyed schema. Adds the server_id
// column to any table created before this migration; the CREATE statements
// above only apply to fresh databases, so existing installs need the ALTER.
// Each ALTER is best-effort: "duplicate column" means it already ran.
const MIGRATIONS = [
  `ALTER TABLE qg_feedback     ADD COLUMN server_id TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE qg_monthly      ADD COLUMN server_id TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE popular_signals ADD COLUMN server_id TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE rate_limits     ADD COLUMN server_id TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE qg_runs         ADD COLUMN server_id TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE app_settings    ADD COLUMN server_id TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE hosted_user_keys ADD COLUMN synced_username TEXT`,
]

let ready = null

// Initialise the database exactly once. Callers await this before first use;
// index.js awaits it on boot so a query never races schema creation.
export function initDb() {
  if (!ready) {
    ready = (async () => {
      await applyPragmas()
      for (const stmt of SCHEMA) await db.execute(stmt)
      for (const stmt of MIGRATIONS) {
        try {
          await db.execute(stmt)
        } catch {
          // Column already exists (migration already ran) - ignore.
        }
      }
    })()
  }
  return ready
}

// This instance's stable server_id. Generated once (UUIDv4) and persisted, so
// it survives restarts and ABS URL changes. ABS exposes no reusable server
// GUID, so we own this identifier.
let serverIdReady = null
export function getServerId() {
  if (!serverIdReady) {
    serverIdReady = (async () => {
      await initDb()
      const r = await db.execute('SELECT server_id FROM server_identity WHERE id = 1')
      if (r.rows[0]?.server_id) return String(r.rows[0].server_id)
      const id = crypto.randomUUID()
      await db.execute({
        sql: `INSERT INTO server_identity (id, server_id, created_at) VALUES (1, ?, ?)`,
        args: [id, Date.now()],
      })
      return id
    })()
  }
  return serverIdReady
}

export const DB_FILE = FILE
export const DB_DIR = DIR
export { LOCAL_SERVER }
