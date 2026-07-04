# Data inventory and the data-domain registry

> The authoritative map of every piece of persistent state in a HearthShelf
> deployment, verified against source on 2026-07-03. Every other doc in this
> folder builds on this map. The second half specifies the **data-domain
> registry** - the mechanism that keeps this inventory true forever.

## 1. The three owners

A HearthShelf deployment has up to three independent state owners. A complete
backup/migration story must account for each, and must never confuse them.

| Owner | Store | Who writes it | Covered by |
| --- | --- | --- | --- |
| **ABS** | `absdatabase.sqlite` + `/metadata` (items, authors) on the `abs-config`/`abs-metadata` volumes | ABS only (HS reads read-only via `server/lib/absdb.js`) | ABS native backups (`/api/backups`) |
| **HearthShelf** | `hearthshelf.db` + `avatars/` + `narrators/` under `QG_DATA_DIR` (default `/app/data`, volume `hearthshelf-data`) | The QuestGiver backend (`server/`) | **Nothing today** - Phase 1 fixes this |
| **Control plane** (hosted only) | D1 on Cloudflare: `servers`, `links`, `pending_invites`, `user_prefs`, certs, keys | The control-plane Worker | Cloudflare's durability; *not* part of any box backup, and must never be - a box restore never touches pairing |

Audio files themselves are in a fourth category: **irreplaceable user media**
(`abs-audiobooks` volume). Neither ABS nor HS backs them up (ABS's backup
explicitly excludes them, `BackupManager.js:249-251`). Our docs must say so
plainly and recommend host-level protection.

One more file lives outside these stores: the hs.direct TLS material at
`/config/hsdirect/` (cert, key, `stable_host`) - written by
`server/lib/hsdirect.js` but persisted on the **abs-config** volume. It is
re-obtainable (re-pair mints a new cert) but including it in backups avoids a
re-pair on restore.

## 2. ABS-owned state (what an ABS backup carries)

Verified in `audiobookshelf/server/managers/BackupManager.js`:

- **In the zip**: `absdatabase.sqlite` (all users, libraries, items, media,
  progress, sessions, server settings incl. `tokenSecret`), `metadata-items/`,
  `metadata-authors/`, a details file (id, key, timestamp, server version).
- **Not in the zip**: audio files, cover cache beyond metadata dirs, logs.
- **Schedule**: `serverSettings.backupSchedule` cron; **default `false`**
  (`ServerSettings.js:33`). Retention `backupsToKeep` (default 2), size cap
  `maxBackupSize` (default 1 GB). Updating the setting through ABS's
  server-settings endpoint reschedules the cron live
  (`MiscController.js:154`).
- **Restore** (`GET /api/backups/:id/apply`): stops DB, replaces sqlite +
  metadata dirs, reconnects, purges caches, emits `backup_applied` socket
  event. No process restart. All user ids, tokens, and the JWT `tokenSecret`
  come back exactly as backed up - sessions survive unless `JWT_SECRET_KEY`
  env differs between installs.
- **Endpoints** (all admin-gated, `BackupController.js:164-168`): list/create
  (`GET|POST /api/backups`), delete, download, apply, upload
  (`POST /api/backups/upload`), set path (`PATCH /api/backups/path`).
  `backupPath` default `/metadata/backups`, env `BACKUP_PATH` overrides.

### Identity facts that constrain migration (verified)

- Every ABS entity id (user, libraryItem, book, mediaProgress, session) is a
  **per-install UUID v4**. There is no stable cross-install id.
- On rescan, the scanner matches existing items **only by file inode**
  (`LibraryScanner.js:672-711`) - not path, not ASIN/ISBN, not metadata. A
  fresh install pointed at the same files generates all-new ids.
- `mediaProgress.mediaItemId` references the **book/podcastEpisode id**, not
  the libraryItem id. Cross-install mapping must hop libraryItem -> media.
- **No admin API writes another user's progress.** `PATCH /api/users/:id`
  explicitly cannot touch progress/bookmarks (`UserController.js:219`);
  progress endpoints are self-scoped (`/api/me/progress/...`). Sessions can be
  *created* self-scoped via the offline-sync endpoints (`POST
  /api/session/local`, `.../local/all` - LWW-guarded, see
  `@hearthshelf/core` `ABS_OFFLINE_SYNC_RULES`). This shapes the whole merge
  engine: per-user writes happen *as the user*, via minted per-user API keys.
- `POST /api/users` cannot set `id`, `pash`, or `token` - passwords cannot be
  carried over the API; migrated users need a reset/invite flow (or the
  advanced offline path, see `merge-engine.md`).

## 3. HearthShelf-owned state (the full table map)

From `server/db.js` (verified 2026-07-03). Scope legend: **U** = per-user
`(server_id, user_id)`-keyed, **S** = per-server, **I** = instance singleton.

| Table | Scope | Secrets | Notes for lifecycle |
| --- | --- | --- | --- |
| `server_identity` | I | - | The HS `server_id` UUID + name. Restoring `hearthshelf.db` carries identity - deliberate (keeps all U-rows valid) |
| `user_settings` | U (+scope, device_id, key) | - | Per-key LWW; merge = per-key LWW |
| `app_settings` | U | - | Legacy blob, superseded; back up, never merge |
| `connections` | U | `abs_user_key` | Per-user minted ABS key + `abs_url`. URL goes stale on migration |
| `listening_queue` | U | - | LWW on `updated_at` |
| `avatars` (+ files) | U | - | Files at `avatars/<server_id>_<user_id>.<ext>` - file names embed the key pair; re-key must rename files |
| `narrator_images` (+ files) | S | - | Re-derivable by the series-roster job; back up as convenience |
| `finished_books` | U | - | Reading history incl. Goodreads/Hardcover imports - exists nowhere else; merge = union on the UNIQUE key |
| `book_notes` | U | - | References ABS `library_item_id` - needs item re-mapping on cross-server merge |
| `clubs` / `club_books` / `club_members` | S / per-club | - | `club_books.library_item_id` needs item re-mapping; `club_members.user_id` needs user re-mapping |
| `qg_feedback`, `qg_monthly`, `qg_runs` | U | - | Discover/QuestGiver state; merge = LWW / union, low stakes |
| `popular_signals`, `series_roster` | S | - | Aggregates; re-derivable, back up as convenience |
| `rate_limits` | U | - | Do not merge; reset on migration is fine |
| `community_config` | I | - | Instance policy |
| `ai_config` | I | `api_key`, `base_url` | Env-overrides-DB per field |
| `integrations_config` | I | `rmab_login_token`, `audplexus_key` | Env-overrides-DB per field |
| `hosted_config` | I | `server_secret`, `abs_admin_token` | Pairing identity - see "hosted caveat" below |
| `hosted_user_keys` | per-(server, Clerk sub) | `abs_api_key` | Cache; safe to drop and re-mint |
| `service_accounts` | I | - | ABS user ids tagged as machine accounts - ids change across ABS installs; must re-resolve after migration |
| `provisioning` | I | `root_password` | AIO onboarding state incl. service-root creds - invalid after an ABS restore replaces users (see playbook M2) |
| `telemetry_config` | I | - | Opt-in flag + id |
| `hardcover_accounts` | U | `token` | Per-user PAT |
| `job_runs`, `job_run_logs` | per-job | - | Operational history; back up, never merge |

**Hosted caveat**: `hosted_config.server_secret` identifies this box to the
control plane. Restoring an HS backup onto a *replacement* box carries the
secret and re-attaches cleanly; restoring the same backup onto a *second,
simultaneous* box would make two boxes claim one identity. The restore flow
must warn about this, and the existing `POST /servers/:id/reset-secret`
recovery hatch (control plane) covers the lost-secret case.

## 4. What breaks when, today (gap summary)

| Event | ABS data | HS data |
| --- | --- | --- |
| Volume loss, no backups | gone | gone |
| ABS backup restored, HS volume intact | restored | **desynced** if user ids changed; fine if same-install restore (ids preserved) |
| Fresh AIO + old ABS backup | restored (UC2) | empty - and `provisioning`'s service root no longer exists in ABS |
| Thin -> AIO, same ABS | untouched | fine if the `hearthshelf-data` volume moves; `connections.abs_url` stale |
| New ABS install, same audio files | new ids everywhere | **all U-rows orphaned** (user ids changed), item references dangle |

The `(server_id, user_id)` keying is the right seam: HS data survives anything
that preserves ABS user ids, and everything else reduces to a **re-key**
(user-id map) plus an **item re-map** (library-item map) - exactly what the
merge engine produces.

## 5. The data-domain registry (the "next dozen features" answer)

New module: `server/lib/dataDomains.js`. A catalog in the same spirit as the
settings catalog in `@hearthshelf/core`: one declarative list, consumed by
every lifecycle surface, enforced at boot.

```js
// server/lib/dataDomains.js
export const DATA_DOMAINS = [
  {
    key: 'finished-books',
    tables: ['finished_books'],
    files: null,                    // or { root: 'avatars', pattern: ... }
    scope: 'user',                  // 'user' | 'server' | 'instance'
    secretColumns: {},              // table -> [column]
    backup: 'always',               // 'always' | 'derived' (re-derivable, still included)
    userExport: true,               // appears in per-user "export my data"
    merge: 'union',                 // 'union' | 'lww' | 'skip' | 'custom'
    itemRefs: ['finished_books.library_item_id'],  // columns holding ABS item ids (need re-map)
    userRefs: 'key',                // 'key' = the user_id key column; or explicit columns
  },
  // ... one entry per domain
]
```

Consumers:

- **Backup service** (`backups.md`) walks the registry to know what to
  snapshot and which files to include - never a hand-maintained list.
- **Per-user export** (Phase 5) walks `userExport: true` domains and strips
  `secretColumns`.
- **Merge engine** (Phase 4) walks `merge` policies, `itemRefs`, `userRefs`
  to re-key and combine rows.
- **User-delete purge**: when an ABS user is deleted through HS's user
  management, walk every `user`-scoped domain via `userRefs` and delete the
  rows (and keyed files - avatars). Today those rows linger orphaned,
  including per-user secrets (`connections.abs_user_key`,
  `hardcover_accounts.token`). The registry makes the purge complete by
  construction and keeps it complete as domains are added.
- **Boot assertion**: on startup, diff `sqlite_master` table names against the
  union of all `tables` (plus an explicit `INTERNAL_TABLES` allowlist for
  things like `job_run_logs`). An unregistered table throws at boot in dev and
  logs an error in production. Adding a table without a lifecycle decision
  becomes impossible to do silently.

Registry entries are **server-side** (they name real tables/columns); the
*shapes* that cross the wire (archive manifest, export payloads, merge
reports) live in `@hearthshelf/core` under the domain-per-file convention:
`types/portability.ts` + `lib/portability.ts` (see `archive-format.md`).

### How a future feature slots in

1. Create the table/file in `server/db.js` as usual.
2. Add a `DATA_DOMAINS` entry - forced by the boot assertion.
3. Choosing `merge`, `userExport`, and `secretColumns` *is* the lifecycle
   design review, and it is one code-reviewable object.
4. Backup, export, and merge pick the domain up with zero further code.
