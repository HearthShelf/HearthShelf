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
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS qg_feedback (
     user_id   TEXT NOT NULL,
     item_key  TEXT NOT NULL,
     vote      TEXT,
     rating    INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, item_key)
   )`,
  `CREATE TABLE IF NOT EXISTS qg_monthly (
     user_id    TEXT NOT NULL,
     month      TEXT NOT NULL,
     engine     TEXT,
     intro      TEXT,
     picks_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, month)
   )`,
  `CREATE TABLE IF NOT EXISTS popular_signals (
     date       TEXT PRIMARY KEY,
     items_json TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     user_id    TEXT NOT NULL,
     period_key TEXT NOT NULL,
     count      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, period_key)
   )`,
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
     user_id     TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     summary     TEXT,
     result_json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_qg_runs_user
     ON qg_runs (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS app_settings (
     user_id      TEXT PRIMARY KEY,
     values_json  TEXT NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
]

let ready = null

// Initialise the database exactly once. Callers await this before first use;
// index.js awaits it on boot so a query never races schema creation.
export function initDb() {
  if (!ready) {
    ready = (async () => {
      await applyPragmas()
      for (const stmt of SCHEMA) await db.execute(stmt)
    })()
  }
  return ready
}

export const DB_FILE = FILE
export const DB_DIR = DIR
