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
import { assertDomainsCoverSchema } from './lib/dataDomains.js'

const DIR = process.env.QG_DATA_DIR || '/app/data'
const FILE = path.join(DIR, 'hearthshelf.db')

// Remote (Turso) when HS_DB_URL is set, else an embedded local file.
const url = process.env.HS_DB_URL || pathToFileURL(FILE).toString()
const authToken = process.env.HS_DB_TOKEN || undefined

// The live libSQL client. Held behind a stable proxy (`db`) so a restore can
// swap the underlying connection out from under every importer (they all import
// the same `db` binding) after replacing the database file. reopenDb() rebuilds
// this and re-runs pragmas + migrations. On the remote (Turso) path there is no
// local file to swap, so reopen is a no-op there.
let client = createClient({ url, authToken })

// A proxy that always forwards to the current `client`. Route modules do
// `import { db }` once; swapping `client` here transparently reconnects them.
export const db = new Proxy(
  {},
  {
    get(_target, prop) {
      const value = client[prop]
      return typeof value === 'function' ? value.bind(client) : value
    },
  },
)

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
     id           INTEGER PRIMARY KEY CHECK (id = 1),
     server_id    TEXT NOT NULL,
     server_name  TEXT,            -- admin-chosen display name (Plex-style); how
                                   -- the server is referred to + sent at pairing
     created_at   INTEGER NOT NULL
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
  // Community config is a single instance-wide row (admin-owned), seeded from
  // the COMMUNITY_DEFAULT_SHARE env on first boot. Holds the default for whether
  // a user shares their reading on the leaderboard - applied to users who never
  // set their own preference (see server/community.js).
  `CREATE TABLE IF NOT EXISTS community_config (
     id                  INTEGER PRIMARY KEY CHECK (id = 1),
     default_share       INTEGER NOT NULL DEFAULT 1,
     updated_at          INTEGER NOT NULL
   )`,
  // Integrations config is a single instance-wide row (admin-owned): the
  // external services HearthShelf can talk to (ReadMeABook, Audplexus) plus the
  // Audible catalog region. Editable from Config > Integrations, but any matching
  // env var (RMAB_*, AUDPLEXUS_*, AUDIBLE_REGION) overrides its field and locks
  // it in the UI. Secrets (rmab_login_token, audplexus_key) are held server-side,
  // never sent to the browser. See server/integrations.js.
  `CREATE TABLE IF NOT EXISTS integrations_config (
     id                INTEGER PRIMARY KEY CHECK (id = 1),
     rmab_url          TEXT,
     rmab_login_token  TEXT,
     audplexus_url     TEXT,
     audplexus_key     TEXT,
     audible_region    TEXT,
     updated_at        INTEGER NOT NULL
   )`,
  // HS backup schedule + retention (see docs/data-lifecycle/backups.md). A single
  // instance-wide row, admin-owned. env overrides DB per field (HS_BACKUP_SCHEDULE,
  // HS_BACKUPS_TO_KEEP, HS_BACKUP_PATH) like ai_config / integrations_config.
  // Defaults: nightly 01:00, keep 7 - backups ship ON (opt-out) so a fresh box
  // protects itself. off_box_path mirrors each backup to a host mount when set.
  `CREATE TABLE IF NOT EXISTS backup_config (
     id           INTEGER PRIMARY KEY CHECK (id = 1),
     schedule     TEXT NOT NULL DEFAULT '0 1 * * *',
     keep         INTEGER NOT NULL DEFAULT 7,
     off_box_path TEXT,
     updated_at   INTEGER NOT NULL
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
     discover_enabled INTEGER NOT NULL DEFAULT 1,  -- ambient Discover history shelves
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
  // Legacy per-user settings blob. Superseded by user_settings (per-key rows);
  // kept in place so the one-time fan-out (see migrateSettingsToRows) can read it
  // and so a rollback is possible. No longer written after the migration runs.
  `CREATE TABLE IF NOT EXISTS app_settings (
     server_id    TEXT NOT NULL DEFAULT 'local',
     user_id      TEXT NOT NULL,
     values_json  TEXT NOT NULL,
     updated_at   INTEGER NOT NULL,
     PRIMARY KEY (server_id, user_id)
   )`,
  // Centralized per-key user settings (replaces the app_settings blob). One row
  // per (server_id, user_id, scope, device_id, key), each with its own
  // updated_at so sync merges at the setting level (per-key last-writer-wins) -
  // a change on one device never clobbers an unrelated change on another. The
  // catalog in @hearthshelf/core defines every key's scope + default; absence of
  // a row means "use the default" (sparse storage). scope='account' has
  // device_id='' and syncs to every device; scope='device' rows carry a stable
  // per-install device_id and only round-trip for that device. Reading one key
  // server-side (e.g. shareReadBooks) is now one indexed query, not a blob scan.
  `CREATE TABLE IF NOT EXISTS user_settings (
     server_id   TEXT NOT NULL DEFAULT 'local',
     user_id     TEXT NOT NULL,
     scope       TEXT NOT NULL DEFAULT 'account',
     device_id   TEXT NOT NULL DEFAULT '',
     key         TEXT NOT NULL,
     value_json  TEXT NOT NULL,
     updated_at  INTEGER NOT NULL,
     PRIMARY KEY (server_id, user_id, scope, device_id, key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_settings_lookup
     ON user_settings (server_id, user_id, scope, device_id)`,
  // The user's syncable bookshelf (ABS) connection, so it can follow them to a
  // new platform. abs_url + label are non-secret and may surface to the client;
  // abs_user_key is the minted per-user ABS key and is a SECRET - written
  // server-side, never returned to the browser (only a connected flag is), the
  // same handling as hardcover_accounts.token. One row per user for now; add a
  // conn_id to the key if multi-bookshelf-per-user is ever needed.
  `CREATE TABLE IF NOT EXISTS connections (
     server_id     TEXT NOT NULL DEFAULT 'local',
     user_id       TEXT NOT NULL,
     abs_url       TEXT NOT NULL,
     abs_user_key  TEXT,
     label         TEXT,
     last_used_at  INTEGER,
     updated_at    INTEGER NOT NULL,
     PRIMARY KEY (server_id, user_id)
   )`,
  // The user's up-next listening queue, so it follows them across devices.
  // One row per user; items_json is the ordered QueueEntry[] (see
  // @hearthshelf/core QueueState). Queue MODE and auto-rules are preferences
  // and live in app_settings instead - only the item list churns often enough
  // (every auto-advance rebuild) to warrant its own table.
  // items_json is the ACTIVE up-next list (rebuilt in Auto/Playlist, mirrors
  // the manual list in Manual mode). manual_json is the DURABLE hand-queued
  // list: it drives Manual mode and, in Auto mode, feeds the 'manual' rule so a
  // hand-picked queue survives every Auto rebuild. Auto never overwrites it.
  `CREATE TABLE IF NOT EXISTS listening_queue (
     server_id    TEXT NOT NULL DEFAULT 'local',
     user_id      TEXT NOT NULL,
     items_json   TEXT NOT NULL DEFAULT '[]',
     manual_json  TEXT NOT NULL DEFAULT '[]',
     playlist_id  TEXT,
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
  // Profile photos (a HearthShelf "US thing" - ABS has no avatar concept). The
  // image bytes live as files under QG_DATA_DIR/avatars/<server_id>_<user_id>.<ext>;
  // this table only tracks the content type, extension, and version so the GET
  // route can find the file and the client can cache-bust on change. Keyed by
  // (server_id, user_id) like every per-user table.
  `CREATE TABLE IF NOT EXISTS avatars (
     server_id    TEXT NOT NULL DEFAULT 'local',
     user_id      TEXT NOT NULL,
     content_type TEXT NOT NULL,
     ext          TEXT NOT NULL,
     version      INTEGER NOT NULL DEFAULT 1,
     updated_at   INTEGER NOT NULL,
     -- 'upload' (the user deliberately picked this photo) or 'clerk' (copied from
     -- their SSO photo by the hosted WebApp). Ranking uses this: a manual upload
     -- outranks a synced Clerk photo, and a Clerk sync never overwrites an upload.
     source       TEXT NOT NULL DEFAULT 'upload',
     PRIMARY KEY (server_id, user_id)
   )`,
  // Narrator photos - a HearthShelf-native feature (ABS has no narrator record).
  // One image per narrator NAME, server-wide. Bytes live as files under
  // QG_DATA_DIR/narrators/<server_id>_<name_key>.<ext>; this row tracks the
  // type/ext/version (cache-bust) + the original-cased name. name_key is a hash
  // of the trimmed+lowercased name (see lib/narratorImages.js).
  `CREATE TABLE IF NOT EXISTS narrator_images (
     server_id    TEXT NOT NULL DEFAULT 'local',
     name_key     TEXT NOT NULL,
     name         TEXT NOT NULL,
     content_type TEXT NOT NULL,
     ext          TEXT NOT NULL,
     version      INTEGER NOT NULL DEFAULT 1,
     updated_at   INTEGER NOT NULL,
     PRIMARY KEY (server_id, name_key)
   )`,
  // HearthShelf-tracked service accounts (instance-wide, single row). A "service
  // account" is just an ABS admin/root user; ABS has no native concept of one, so
  // HearthShelf remembers which accounts it minted as machine accounts here. The
  // auto-created service root (provisioning.root_username) is always treated as one
  // without needing a row. ids_json is a JSON array of ABS user ids.
  `CREATE TABLE IF NOT EXISTS service_accounts (
     id          INTEGER PRIMARY KEY CHECK (id = 1),
     ids_json    TEXT NOT NULL DEFAULT '[]',
     updated_at  INTEGER NOT NULL
   )`,
  // First-boot setup state (all-in-one image only). One row tracks whether the
  // bundled ABS has a root user yet (abs_initialized) and whether the admin has
  // finished HearthShelf's onboarding wizard (onboarded). On AIO the wizard
  // creates a service root account (root_username) with a generated password
  // (root_password, kept so an interrupted onboarding can recover and re-login as
  // the service account). abs_admin_token is unused legacy (the live admin token
  // lives in hosted_config). Empty/absent on slim images.
  `CREATE TABLE IF NOT EXISTS provisioning (
     id              INTEGER PRIMARY KEY CHECK (id = 1),
     abs_initialized INTEGER NOT NULL DEFAULT 0,  -- does the bundled ABS have a root user?
     abs_admin_token TEXT,        -- unused legacy column
     root_username   TEXT,        -- the HearthShelf service account username
     root_password   TEXT,        -- generated service-account password (recovery)
     onboarded       INTEGER NOT NULL DEFAULT 0,  -- user finished the wizard
     updated_at      INTEGER NOT NULL
   )`,
  // Per-user reading history, unified across sources. ABS only tracks
  // mediaProgress.isFinished for items currently in the library; this table is
  // the durable record of "I finished this book," whether or not ABS still
  // has (or ever had) a matching library item. library_item_id is set when a
  // row is linked to a real ABS item; null means it's a standalone stub (e.g.
  // imported from Goodreads for a book not owned). The same logical book can
  // appear once per source (abs/goodreads/hardcover) so re-running an import
  // or an ABS reconcile updates in place instead of duplicating.
  `CREATE TABLE IF NOT EXISTS finished_books (
     id                  TEXT PRIMARY KEY,
     server_id           TEXT NOT NULL DEFAULT 'local',
     user_id             TEXT NOT NULL,
     source              TEXT NOT NULL,  -- 'abs' | 'goodreads' | 'hardcover'
     library_item_id     TEXT,
     title               TEXT NOT NULL,
     author              TEXT,
     isbn                TEXT,
     date_finished       TEXT,           -- ISO date (YYYY-MM-DD), nullable
     rating              INTEGER,        -- 1-5, nullable
     hardcover_book_id   TEXT,
     hardcover_synced_at INTEGER,
     created_at          INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL,
     UNIQUE (server_id, user_id, source, library_item_id, title)
   )`,
  // Public + club notes on books (see docs/social.md). One row per note or
  // reply. club_id '' = a public note (house sentinel, like user_settings
  // device_id); parent_id '' = top-level (a reply gates at its PARENT's
  // time_sec). time_sec NULL = a general, ungated note. username is snapshotted
  // at write time so names render without an absdb mount. Soft delete (deleted=1)
  // keeps reply threads intact. The server route is the authoritative spoiler
  // gate (a WHERE + body-strip), never a mirror of core's client-side gateNotes.
  `CREATE TABLE IF NOT EXISTS book_notes (
     id              TEXT PRIMARY KEY,
     server_id       TEXT NOT NULL DEFAULT 'local',
     user_id         TEXT NOT NULL,
     username        TEXT NOT NULL DEFAULT '',
     library_item_id TEXT NOT NULL,
     club_id         TEXT NOT NULL DEFAULT '',
     visibility      TEXT NOT NULL DEFAULT 'public',
     parent_id       TEXT NOT NULL DEFAULT '',
     time_sec        REAL,
     safe            INTEGER NOT NULL DEFAULT 0,
     body            TEXT NOT NULL,
     created_at      INTEGER NOT NULL,
     deleted         INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_book_notes_item
     ON book_notes (server_id, library_item_id, club_id, created_at)`,
  // Book clubs (see docs/social.md). A club is a persistent group; the book is
  // an attribute of its timeline (club_books), not of the club. is_open is 1 for
  // open-join v1 (the column is shaped for invite-only later); archived hides a
  // finished club while keeping its chat readable.
  `CREATE TABLE IF NOT EXISTS clubs (
     id              TEXT PRIMARY KEY,
     server_id       TEXT NOT NULL DEFAULT 'local',
     name            TEXT NOT NULL,
     created_by      TEXT NOT NULL,
     is_open         INTEGER NOT NULL DEFAULT 1,
     archived        INTEGER NOT NULL DEFAULT 0,
     created_at      INTEGER NOT NULL
   )`,
  // A club's reading timeline. Each book is in exactly one state:
  //   queued   : queued_at set, finished_at NULL (up-next, not started)
  //   current  : queued_at NULL, finished_at NULL (exactly one per club)
  //   finished : finished_at stamped
  // title/author are snapshotted at add time so the timeline renders even if the
  // item later leaves ABS. started_at is 0 while a book is queued, set when the
  // owner promotes it to current.
  `CREATE TABLE IF NOT EXISTS club_books (
     server_id       TEXT NOT NULL DEFAULT 'local',
     club_id         TEXT NOT NULL,
     library_item_id TEXT NOT NULL,
     title           TEXT NOT NULL DEFAULT '',
     author          TEXT NOT NULL DEFAULT '',
     added_by        TEXT NOT NULL,
     started_at      INTEGER NOT NULL,
     finished_at     INTEGER,
     queued_at       INTEGER,
     PRIMARY KEY (server_id, club_id, library_item_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_club_books_item
     ON club_books (server_id, library_item_id, finished_at)`,
  // Club membership. role is 'owner' | 'member'; the owner cannot leave (they
  // archive instead). last_read_at is the per-club unread cursor (unread =
  // unlocked notes newer than it); the PUT bumps it max(stored, incoming).
  `CREATE TABLE IF NOT EXISTS club_members (
     server_id    TEXT NOT NULL DEFAULT 'local',
     club_id      TEXT NOT NULL,
     user_id      TEXT NOT NULL,
     username     TEXT NOT NULL DEFAULT '',
     role         TEXT NOT NULL DEFAULT 'member',
     joined_at    INTEGER NOT NULL,
     last_read_at INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (server_id, club_id, user_id)
   )`,
  // One Hardcover Personal Access Token per ABS user (not server-wide - a
  // Hardcover account belongs to a person, not a household's HearthShelf box).
  // The token is never returned to the client once saved; only connection
  // status and the last sync result are.
  `CREATE TABLE IF NOT EXISTS hardcover_accounts (
     server_id        TEXT NOT NULL DEFAULT 'local',
     user_id          TEXT NOT NULL,
     token            TEXT NOT NULL,
     username         TEXT,
     last_sync_at     INTEGER,
     last_sync_status TEXT,   -- 'ok' | 'error'
     last_sync_error  TEXT,
     updated_at       INTEGER NOT NULL,
     PRIMARY KEY (server_id, user_id)
   )`,
  // Anonymous usage telemetry opt-in (Home Assistant style). One instance-wide
  // row, admin-owned. enabled ships OFF by default - the box phones nothing home
  // until an admin turns it on. telemetry_id is a random per-install handle sent
  // WITH the counts and deliberately NOT the server_id, so the reports the
  // control plane aggregates can't be tied back to this paired server's identity.
  `CREATE TABLE IF NOT EXISTS telemetry_config (
     id           INTEGER PRIMARY KEY CHECK (id = 1),
     enabled      INTEGER NOT NULL DEFAULT 0,
     telemetry_id TEXT,
     updated_at   INTEGER NOT NULL
   )`,
  // Import/merge engine reports (see docs/data-lifecycle/merge-engine.md). A
  // dry-run produces a report row; execute requires a report id produced against
  // the current target state. status: 'dry-run' | 'executing' | 'done' | 'error'.
  // report_json holds the full ImportReport; result_json the ImportResult once
  // executed. Kept for audit + resumability; never merged into another server.
  `CREATE TABLE IF NOT EXISTS import_reports (
     id           TEXT PRIMARY KEY,
     server_id    TEXT NOT NULL DEFAULT 'local',
     mode         TEXT NOT NULL,
     source_kind  TEXT NOT NULL,
     status       TEXT NOT NULL,
     report_json  TEXT NOT NULL,
     result_json  TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  // --- Scheduled jobs (Sonarr/Radarr-style) --------------------------------
  // One row per job execution (scheduled tick or manual "run now"). The runner
  // writes 'running' on start and flips to 'ok'/'error' on finish. summary is a
  // short human line; items_processed/items_total drive a progress readout.
  `CREATE TABLE IF NOT EXISTS job_runs (
     id              TEXT PRIMARY KEY,
     server_id       TEXT NOT NULL DEFAULT 'local',
     job_id          TEXT NOT NULL,
     trigger         TEXT NOT NULL,           -- 'schedule' | 'manual'
     status          TEXT NOT NULL,           -- 'running' | 'ok' | 'error'
     started_at      INTEGER NOT NULL,
     finished_at     INTEGER,
     summary         TEXT,
     error           TEXT,
     items_processed INTEGER NOT NULL DEFAULT 0,
     items_total     INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_job
     ON job_runs (server_id, job_id, started_at)`,
  // The log stream for a run, one row per line, ordered by seq.
  `CREATE TABLE IF NOT EXISTS job_run_logs (
     run_id  TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     at      INTEGER NOT NULL,
     level   TEXT NOT NULL,                   -- 'info' | 'warn' | 'error'
     message TEXT NOT NULL,
     PRIMARY KEY (run_id, seq)
   )`,
  // Precomputed Audible series roster, GLOBAL (no user_id - "owned" is a
  // library-wide fact). Keyed by lowercased series name (how the client asks).
  // books_json is the enriched roster: each Audible book + sequence + owned flag.
  `CREATE TABLE IF NOT EXISTS series_roster (
     server_id     TEXT NOT NULL DEFAULT 'local',
     name_key      TEXT NOT NULL,             -- lowercased series name
     name          TEXT NOT NULL,             -- original series name
     series_asin   TEXT,                      -- null when unresolved
     series_title  TEXT,
     books_json    TEXT NOT NULL,             -- JSON array of enriched books
     resolved_at   INTEGER NOT NULL,
     PRIMARY KEY (server_id, name_key)
   )`,

  // Durable per-user daily listening history. ABS keeps NO history (a re-finish
  // overwrites finishedAt; timeListening is a running sum), so trends, the full
  // heatmap, and durable longest-ever streaks are impossible from ABS alone. The
  // nightly stats-snapshot job (jobs/statsSnapshot.js) appends one immutable row
  // per user per local day from ABS's playbackSessions/mediaProgresses; these
  // accumulate into full history that survives ABS restarts/re-scans. Re-derivable
  // by re-running the job over recent days (backup: 'derived'). Keyed by day.
  `CREATE TABLE IF NOT EXISTS stats_daily (
     server_id        TEXT NOT NULL DEFAULT 'local',
     user_id          TEXT NOT NULL,
     date             TEXT NOT NULL,          -- 'YYYY-MM-DD' local day bucket
     seconds_listened INTEGER NOT NULL DEFAULT 0,
     sessions         INTEGER NOT NULL DEFAULT 0,
     books_finished   INTEGER NOT NULL DEFAULT 0,
     snapshot_at      INTEGER NOT NULL,       -- ms epoch this row was last written
     PRIMARY KEY (server_id, user_id, date)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_stats_daily_user
     ON stats_daily (server_id, user_id, date)`,

  // Durable per-user achievement unlocks. HS owns this - ABS has no concept of
  // achievements, and an unlock's timestamp is a fact only HS records. The
  // definitions live in code (lib/achievements/registry.js); these rows are just
  // the unlocks (immutable unlocked_at) plus a progress counter for tiered ones.
  // Written by the stats-snapshot job after it refreshes stats_daily. NOT
  // re-derivable if history is trimmed, so backed up in full. No UI yet (billing
  // deferred) - unlocks accumulate so the eventual reveal isn't empty.
  `CREATE TABLE IF NOT EXISTS user_achievements (
     server_id      TEXT NOT NULL DEFAULT 'local',
     user_id        TEXT NOT NULL,
     achievement_id TEXT NOT NULL,
     unlocked_at    INTEGER NOT NULL,
     progress       INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (server_id, user_id, achievement_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_achievements_user
     ON user_achievements (server_id, user_id)`,

  // Release subscriptions: a user follows an upcoming book (kind='book', keyed by
  // asin) or a whole series (kind='series', keyed by series_asin, auto-covering
  // its future books). The full display payload (title/author/cover/dates) is
  // stored here so clients + the Home banner never refetch Audible to render it;
  // the push job updates available/available_at as books land in ABS. One row per
  // (server_id, user_id, id).
  `CREATE TABLE IF NOT EXISTS subscriptions (
     server_id     TEXT NOT NULL DEFAULT 'local',
     user_id       TEXT NOT NULL,
     id            TEXT NOT NULL,             -- app-generated uuid
     kind          TEXT NOT NULL,             -- 'book' | 'series'
     asin          TEXT,                      -- book subs: the awaited product
     series_asin   TEXT,                      -- series subs + parent series of a book sub
     title         TEXT NOT NULL,
     author        TEXT,
     series_title  TEXT,
     sequence      TEXT,
     cover_art_url TEXT,
     narrator      TEXT,
     duration_min  INTEGER,
     release_date  TEXT,                      -- 'YYYY-MM-DD'
     publication_datetime TEXT,               -- ISO 8601
     available     INTEGER NOT NULL DEFAULT 0,-- 1 once the book is owned in ABS
     available_at  INTEGER,                   -- ms epoch when it landed, else null
     notified_json TEXT,                      -- JSON: which push signals already fired
     created_at    INTEGER NOT NULL,
     PRIMARY KEY (server_id, user_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_user
     ON subscriptions (server_id, user_id)`,

  // Expo push tokens per user+device. A user can have several devices; one row
  // per token. Refreshed on each app launch (upsert on token).
  `CREATE TABLE IF NOT EXISTS push_tokens (
     server_id     TEXT NOT NULL DEFAULT 'local',
     user_id       TEXT NOT NULL,
     token         TEXT NOT NULL,             -- ExponentPushToken[...]
     platform      TEXT,                      -- 'ios' | 'android'
     updated_at    INTEGER NOT NULL,
     PRIMARY KEY (server_id, token)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_push_tokens_user
     ON push_tokens (server_id, user_id)`,
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
  `ALTER TABLE server_identity ADD COLUMN server_name TEXT`,
  `ALTER TABLE ai_config ADD COLUMN discover_enabled INTEGER NOT NULL DEFAULT 1`,
  // Community social controls (see docs/social.md). Listening-now presence is
  // more sensitive than a reading list, so its default ships OFF; notes and
  // clubs are admin kill-switches, on by default.
  `ALTER TABLE community_config ADD COLUMN default_share_listening INTEGER DEFAULT 0`,
  `ALTER TABLE community_config ADD COLUMN notes_enabled INTEGER DEFAULT 1`,
  `ALTER TABLE community_config ADD COLUMN clubs_enabled INTEGER DEFAULT 1`,
  // Note visibility (public/personal) + spoiler-safe flag (see docs/social.md).
  // On existing installs pre-migration a note's audience was overloaded onto
  // club_id (empty = public); the backfill below promotes club_id != '' rows to
  // visibility='club', leaving empties at the DEFAULT 'public'. No personal rows
  // exist pre-migration. safe defaults 0.
  `ALTER TABLE book_notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
  `ALTER TABLE book_notes ADD COLUMN safe INTEGER NOT NULL DEFAULT 0`,
  // Club reading queue (see docs/social.md). queued_at set = the book is lined
  // up as up-next (not yet the current book). Existing rows stay NULL, so all
  // pre-migration books remain current/finished as before.
  `ALTER TABLE club_books ADD COLUMN queued_at INTEGER`,
  // Club next-book recommendations (see docs/social.md). The instance-wide AI
  // switch ships OFF - AI calls cost money, so an admin must allow clubs to make
  // them; with it off, clubs still get the deterministic heuristic. rec_basis is
  // the owner's per-club choice of what taste drives the pick; existing clubs
  // default to their own reading history.
  `ALTER TABLE community_config ADD COLUMN clubs_ai_enabled INTEGER DEFAULT 0`,
  `ALTER TABLE clubs ADD COLUMN rec_basis TEXT NOT NULL DEFAULT 'club-history'`,
  // Avatar provenance (see docs/database.md). Existing rows are all manual
  // uploads, so the DEFAULT 'upload' backfills them correctly; only the hosted
  // WebApp writes 'clerk' rows when it copies a user's SSO photo.
  `ALTER TABLE avatars ADD COLUMN source TEXT NOT NULL DEFAULT 'upload'`,
  // Durable hand-queued list, distinct from the ephemeral items_json Auto
  // rebuilds (see the listening_queue comment above). Existing rows default to
  // an empty manual list; their items_json is left as-is.
  `ALTER TABLE listening_queue ADD COLUMN manual_json TEXT NOT NULL DEFAULT '[]'`,
]

// One-time data backfills that must run AFTER their ALTERs land. Each is
// best-effort and idempotent (it only rewrites rows still at the default), so
// re-running on every boot is a no-op once the data is correct.
const BACKFILLS = [
  // Existing club notes carried club_id but no visibility column; give them
  // visibility='club'. Only touches rows still at the 'public' default, so it's
  // idempotent and never clobbers a later real 'public'/'personal' choice.
  `UPDATE book_notes SET visibility = 'club' WHERE club_id != '' AND visibility = 'public'`,
  // Must run after the queued_at ALTER above so the column exists. On a fresh DB
  // the CREATE TABLE already has queued_at, so this is a harmless no-op there.
  `CREATE INDEX IF NOT EXISTS idx_club_books_queue
     ON club_books (server_id, club_id, queued_at)`,
]

// Account-scoped setting keys, for the one-time app_settings fan-out below.
// Everything the old blob held that ISN'T in this set is treated as device
// scope. This mirrors the scope column of the @hearthshelf/core settings
// catalog (src/lib/settings.ts) - the server can't import that .ts directly (it
// runs plain .js, no bundler), so this list must stay in step with the catalog's
// account entries, same as stats.js mirrors core's stats math. Only used once at
// migration time; live reads/writes go through the catalog on the client.
const ACCOUNT_SETTING_KEYS = new Set([
  'theme',
  'accentMode',
  'accentHex',
  'glow',
  'coverStyle',
  'colorEverywhere',
  'hearthBgPlayer',
  'cardBg',
  'scrubber',
  'skipForward',
  'skipBack',
  'chapterBarrier',
  'defaultSpeed',
  'coverAspect',
  'glowMode',
  'queueMode',
  'queueAutoRules',
  'libraryFill',
  'unifiedHome',
  'showOthersBooks',
  'sleepRewindSec',
  'sleepFade',
  'sleepFadeLen',
  'sleepChime',
  'autoSleep',
  'autoSleepStart',
  'autoSleepEnd',
  'autoSleepDur',
  'useGravatar',
  'shareReadBooks',
  'clubsEnabled',
  'clubPlayerButton',
])

// One-time fan-out of the legacy app_settings blob into per-key user_settings
// rows. Idempotent: skips any (server_id, user_id) that already has rows, so it
// re-running or a later blob write can't double-import. Each key becomes an
// account or device row (device rows use device_id='' - a pre-sync backup the
// owning device adopts on first pull) stamped with the blob's updated_at as the
// seed LWW timestamp. Unknown keys (not in the catalog's account set and not a
// known device key) still import as device rows rather than being dropped, so no
// user data is lost; the client ignores keys it doesn't recognise. app_settings
// is left intact for rollback.
async function migrateSettingsToRows() {
  const blobs = await db.execute(
    'SELECT server_id, user_id, values_json, updated_at FROM app_settings',
  )
  for (const row of blobs.rows) {
    const serverId = String(row.server_id)
    const userId = String(row.user_id)
    const existing = await db.execute({
      sql: 'SELECT 1 FROM user_settings WHERE server_id = ? AND user_id = ? LIMIT 1',
      args: [serverId, userId],
    })
    if (existing.rows.length) continue // already migrated
    let values = null
    try {
      values = JSON.parse(String(row.values_json))
    } catch {
      values = null
    }
    if (!values || typeof values !== 'object') continue
    const updatedAt = Number(row.updated_at) || Date.now()
    for (const key of Object.keys(values)) {
      const scope = ACCOUNT_SETTING_KEYS.has(key) ? 'account' : 'device'
      await db.execute({
        sql: `INSERT OR IGNORE INTO user_settings (server_id, user_id, scope, device_id, key, value_json, updated_at)
              VALUES (?, ?, ?, '', ?, ?, ?)`,
        args: [serverId, userId, scope, key, JSON.stringify(values[key]), updatedAt],
      })
    }
  }
}

// Boot-time guard: diff the real tables against the data-domain registry so a
// new table can never ship without a lifecycle decision (backup/export/merge).
// Best-effort - a failure here must not stop the box from booting.
async function assertRegisteredTables() {
  try {
    const r = await db.execute(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    const names = r.rows.map((row) => String(row.name))
    assertDomainsCoverSchema(names)
  } catch (err) {
    // In dev the registry throws on an unregistered table - re-throw so it's
    // caught before commit. In production assertDomainsCoverSchema logs instead
    // of throwing, so anything that reaches here is a genuine query failure we
    // swallow (the box still boots).
    if (process.env.NODE_ENV !== 'production') throw err
  }
}

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
      for (const stmt of BACKFILLS) {
        try {
          await db.execute(stmt)
        } catch {
          // Best-effort: a fresh DB already has the right shape, so a backfill
          // that references a just-added column is harmless if it no-ops.
        }
      }
      await migrateSettingsToRows()
      await assertRegisteredTables()
    })()
  }
  return ready
}

// Close the current libSQL client so the hearthshelf.db file can be moved or
// replaced (Windows won't move an open file; a stale handle also risks the new
// file being opened against old WAL). Pair with reopenDb() after the swap. The
// proxy `db` will throw if used between close and reopen - the restore holds the
// busy gate across both so nothing else queries in that window. No-op on remote.
export function closeDb() {
  if (process.env.HS_DB_URL) return
  try {
    client.close?.()
  } catch {
    // best-effort
  }
  ready = null
  serverIdReady = null
}

// Reconnect to hearthshelf.db (after a restore replaced the file). Opens a fresh
// client against the same URL and re-runs schema + migrations so an older backup
// upgrades forward. No-op on the remote (Turso) path. Callers close first
// (closeDb), swap the file, then reopen.
export async function reopenDb() {
  if (process.env.HS_DB_URL) return // remote primary; nothing to reopen
  closeDb()
  client = createClient({ url, authToken })
  await initDb()
}

// Checkpoint the WAL so the main db file is complete before it's copied/moved
// (a restore's file swap must not miss uncommitted WAL pages). Best-effort.
export async function checkpointWal() {
  if (process.env.HS_DB_URL) return
  try {
    await db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // best-effort
  }
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

// The admin-chosen server name (how the server is referred to everywhere, and
// the default name sent at pairing). Null until set in onboarding / Settings.
export async function getServerName() {
  await getServerId() // ensures the row exists
  const r = await db.execute('SELECT server_name FROM server_identity WHERE id = 1')
  const v = r.rows[0]?.server_name
  return v ? String(v) : null
}

export async function setServerName(name) {
  await getServerId()
  const trimmed = (name ?? '').trim() || null
  await db.execute({
    sql: `UPDATE server_identity SET server_name = ? WHERE id = 1`,
    args: [trimmed],
  })
  return trimmed
}

export const DB_FILE = FILE
export const DB_DIR = DIR
export { LOCAL_SERVER }
