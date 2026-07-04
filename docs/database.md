# Database

HearthShelf keeps a small amount of state that AudiobookShelf has no concept of
(its own app settings, QuestGiver AI config and history, request/feedback data).
That state lives in an **embedded SQLite database** managed by the QuestGiver
backend service (`server/`), not in the browser and not in ABS.

## Engine

- Driver: [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts)
  (libSQL - the SQLite engine Turso runs), used **embedded against a local file**.
- File: `${QG_DATA_DIR}/hearthshelf.db` (default `/app/data/hearthshelf.db`),
  on the same `hearthshelf-data` Docker volume as before. WAL mode is on so
  readers and the single writer don't block each other.
- Sessions, playback progress, and all library data stay in **ABS** - HearthShelf
  never duplicates them. This database is only for HearthShelf-specific state.

### Going distributed later (optional)

libSQL means the same code can point at a remote Turso primary instead of a
local file by setting `HS_DB_URL` (a `libsql://…` URL) and `HS_DB_TOKEN`. With
neither set, it falls back to the embedded file. Self-hosters never need this;
it exists only if HearthShelf is ever run as a central multi-instance service.

## Reading ABS's database (read-only)

For cross-user features ABS won't expose to non-admins through its REST API - the
**server leaderboard** and per-book **"finished by N people"** counts - the
backend reads ABS's own SQLite database (`absdatabase.sqlite`) directly and
**read-only**. All of that ABS-schema knowledge is isolated in
`server/lib/absdb.js`; nothing else touches ABS's tables, so a future ABS schema
change is a one-file fix.

- The connection is opened with `?mode=ro`, so SQLite refuses any write - we can
  never corrupt ABS's data. ABS stays the sole writer of its own database.
- Path comes from `HS_ABS_DB_PATH` (default `/config/absdatabase.sqlite`). On the
  all-in-one image ABS's `/config` is already mounted in-container, so the default
  works with no extra config. On the slim image, mount ABS's config dir read-only
  (`abs-config:/abs-config:ro`) and point the env at the file.
- When the file isn't mapped (or can't be opened), the social API returns
  `{ available: false }` and the UI hides the leaderboard - no error.
- Privacy resolves per user from a **tri-state** `shareReadBooks` app setting:
  set (the user's own choice) always wins; unset means the user never chose, so
  the instance-wide **default** in `community_config` applies. Admins set that
  default under Config > Community (seeded from `COMMUNITY_DEFAULT_SHARE`, default
  on = opt-out). Changing it is retroactive for users who never chose, but never
  overrides an explicit choice. All of this reads `app_settings` /
  `community_config` from *our* database - no write ever reaches ABS.

## Schema

Created on boot via `CREATE TABLE IF NOT EXISTS` (see `server/db.js`):

| Table | Holds |
| --- | --- |
| `app_settings` | per-user app settings (theme, accent, sleep prefs, queue mode + auto-rules…), one JSON blob per ABS user id - drives cross-device sync |
| `listening_queue` | the user's up-next queue (ordered item list + playlist id), one row per ABS user id - see `docs/queue.md` |
| `ai_config` | the editable QuestGiver AI config (provider, model, key, rate limit, QuestGiver + Discover on/off) - single row; any `QG_*` / `DISCOVER_ENABLED` env var overrides its field |
| `integrations_config` | editable connections for external services (ReadMeABook url+token, Audplexus url+key, Audible region) - single row; any `RMAB_*` / `AUDPLEXUS_*` / `AUDIBLE_REGION` env var overrides its field |
| `community_config` | instance-wide community settings (leaderboard default sharing) - single row, seeded from `COMMUNITY_DEFAULT_SHARE` on first boot |
| `qg_feedback` | per-user Discover votes / ratings |
| `qg_monthly` | the per-user monthly AI shelf cache |
| `qg_runs` | per-user QuestGiver run history (last 30) |
| `popular_signals` | daily server-wide popular-item aggregate |
| `rate_limits` | durable per-user QuestGiver usage counts (survive restarts) |

## Config precedence (env overrides the DB, per field)

Two single-row tables hold editable config and follow the same rule, applied
**per field**: if a field's environment variable is set, that value is used and
**overrides the database** - the admin UI shows the field as read-only and
labeled "Set by environment". If the env var is unset, the editable database
value is used. So a deployment can pin individual values via env (e.g. the API
key in a secret store) while leaving everything else configurable in the UI.

An env var counts as "set" only when present and non-empty. Secrets (API keys,
the RMAB login token) are held server-side and never sent to the browser - the
admin UI only shows whether each is set, plus whether env is pinning it. To make
a field editable again, remove its env var and restart.

- `ai_config` - fields `QG_PROVIDER`, `QG_MODEL`, `QG_API_KEY`, `QG_BASE_URL`,
  `QG_LIMIT`, `QG_ENABLED`, `DISCOVER_ENABLED`; edited on the admin
  **QuestGiver** page.
- `integrations_config` - fields `RMAB_URL`, `RMAB_LOGIN_TOKEN`,
  `AUDPLEXUS_URL`, `AUDPLEXUS_KEY`, `AUDIBLE_REGION`; edited on the admin
  **Integrations** page.

## Migration from the old JSON file

Earlier builds stored Discover state in `discover.json`. On first boot the
backend imports that file into the database (feedback, monthly shelves, popular
signals) and renames it to `discover.json.migrated`, so nothing is lost.

## Backups

Back up `hearthshelf.db` (and its `-wal` / `-shm` sidecars while the service is
stopped) the same way you back up ABS's own `absdatabase.sqlite`. Losing it only
costs HearthShelf-specific state - your library, progress, and sessions are safe
in ABS.
