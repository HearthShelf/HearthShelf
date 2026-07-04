# Phase 1: backups that protect the whole server

> Spec for the HearthShelf backup service and the unified Backups admin page.
> Goal: a fresh AIO protects itself by default, an admin can see and control
> both backup systems from one page, and nothing on the box is silently
> unprotected. Depends only on what exists today (jobs framework, ABS
> endpoints); no archive format needed yet.

## Outcomes (acceptance criteria up front)

1. A fresh AIO takes an ABS backup **and** an HS backup nightly with zero
   configuration (opt-out, not opt-in).
2. Config > Backups shows both systems, their schedules, retention, sizes,
   and last-run status; both schedules are editable in the UI.
3. An HS backup can be created, listed, downloaded, deleted, uploaded, and
   restored from the UI.
4. The backup modal copy states exactly what each backup covers.
5. The page warns when either system has auto-backups off, and states that
   audio files are in neither backup.

## Part A - expose ABS's native backup controls

ABS already has scheduling (`backupSchedule` cron, `backupsToKeep`,
`maxBackupSize`, `backupPath`) - our UI just never surfaced it. Default is
**off** (`ServerSettings.js:33`), which is the root cause of "0 backups."

- Extend Config > Backups with an ABS section: schedule (cron presets: daily
  01:30 / weekly / custom / off), retention count, size cap. Reads from
  `GET /api/settings` (fields on serverSettings), writes via ABS's
  server-settings update endpoint - `backupSchedule` changes reschedule the
  cron live (`MiscController.js:154`), no restart needed.
- **Slim gets the same controls** (decision D10): the scheduler runs on the
  ABS server and this is just its admin API - Thin exposing it is no
  different from any other admin page. What Thin never does is *auto*-trigger
  backups on the external ABS from its own schedule; the admin sets ABS's
  scheduler, ABS runs it.
- **AIO onboarding**: the wizard's final step enables ABS auto-backup
  (`30 1 * * *`, keep 2 - ABS's own conventions) unless the admin unticks it.
  Slim onboarding shows the same card as a recommendation (linking to the
  schedule controls) rather than changing a foreign ABS's settings by
  default.
- Add the missing ABS actions our page lacks: download
  (`GET /api/backups/:id/download`), upload (`POST /api/backups/upload`),
  apply with a confirm that spells out "replaces ALL AudiobookShelf data with
  the backup's contents; HearthShelf data is separate."
- **Apply always backs up first**: before calling `/api/backups/:id/apply`,
  trigger a fresh ABS backup of the current state (and an HS backup) so the
  restore itself is undoable. Same rule the merge engine follows.
- Version skew is ABS's problem and ABS solves it (verified): applying a
  backup calls `Database.reconnect()` -> `MigrationManager.runMigrations()`,
  which migrates an older backup's schema **up** to the running version and
  even runs **down** migrations when the backup is newer
  (`MigrationManager.js:80-100`). No HS-side gating needed on the ABS half;
  the HS half has its own gate (manifest `formatVersion` + forward-only boot
  migrations, below).

## Part B - the HS backup service

New job in the existing jobs framework (`server/jobs/`, runs recorded in
`job_runs` / `job_run_logs`, surfaced under Config > Tasks like other jobs).

### What a backup contains

Driven by the data-domain registry (`data-inventory.md` §5) - not a
hand-list:

- `hearthshelf.db` snapshot - taken with `VACUUM INTO '<tmp path>'` so the
  copy is consistent under WAL with zero downtime, then zipped.
- `avatars/` and `narrators/` file trees.
- `manifest.json`: format version, HS version, `server_id`, created-at,
  domain list with row counts, and flags (`includesSecrets: true`).

Secrets policy: **included**. This is an admin-trust server backup, exactly
like ABS's own backup (which carries `tokenSecret` and every user token).
The manifest flags it and the UI says "contains server secrets - store it
like a password." Per-user exports (Phase 5) are the secret-free surface.

### Location, naming, retention

- Directory: `HS_BACKUP_PATH` env (default `${QG_DATA_DIR}/backups/`).
  Pointing it at a host mount / NAS is the supported way to get backups off
  the data volume - the compose files show a commented-out example.
- Name: `hearthshelf-<server_name-slug>-<YYYY-MM-DDTHHmm>.hsbackup` (a zip).
- Schedule + retention are instance settings in a new `backup_config`
  singleton (env-overrides-DB per field like `ai_config`:
  `HS_BACKUP_SCHEDULE`, `HS_BACKUPS_TO_KEEP`). **Defaults: `0 1 * * *`
  (nightly 01:00), keep 7.** The DB is small; a week of dailies is cheap.
- Honest limitation, stated in the UI when `HS_BACKUP_PATH` is on the data
  volume: backups there don't survive volume loss - set the env var or
  download copies.

### Backup-target skeleton (cloud deferred, seam built now)

All storage I/O in the service goes through one small interface so a cloud
target later is an added class, not a refactor:

```js
// server/lib/backupTargets.js
// BackupTarget: { key, list(), put(name, stream), get(name), delete(name) }
// v1 ships exactly one implementation: LocalDirTarget(HS_BACKUP_PATH).
// Future (deferred by decision): R2/control-plane push for hosted - a new
// class registered here; the job, routes, and UI already speak the interface.
```

The `/hs/backups` routes and the job take the target from this module and
never touch `fs` directly. That is the whole skeleton - no config surface,
no second implementation, until cloud push is actually designed.

### API surface

New route module `server/routes/backups.js`, mounted at `/hs/backups`,
admin-gated via the standard `resolveContext` + `isAdmin` seam:

| Route | Method | Behavior |
| --- | --- | --- |
| `/hs/backups` | GET | `{ backups: [{ id, filename, size, createdAt, hsVersion }], config: { schedule, keep, envLocked }, lastRun }` |
| `/hs/backups` | POST | Run a backup now (enqueue the job; returns the run id) |
| `/hs/backups/config` | PUT | Update schedule/retention (rejects env-locked fields) |
| `/hs/backups/:id/download` | GET | Stream the zip |
| `/hs/backups/:id` | DELETE | Delete |
| `/hs/backups/upload` | POST | Multipart upload into the backups dir (manifest validated) |
| `/hs/backups/:id/restore` | POST | Restore (below) |

Wire shapes go in `@hearthshelf/core` (`types/portability.ts`) so web, WebApp,
and mobile admin screens share them. **Core changes are made in
`C:\code\HearthShelf-Core` and pushed, never in a consumer's submodule.**

### Restore semantics

Mirrors ABS's model (replace, not merge):

1. Validate manifest (format version supported; warn if `server_id` differs -
   that's a migration, link to the playbooks).
2. Quiesce: hold new writes (the backend is the single writer; a simple
   in-process gate suffices), checkpoint WAL.
3. Move current `hearthshelf.db` + dirs to `pre-restore-<ts>/` (automatic
   escape hatch, kept once).
4. Copy in the backup's DB and file trees; restart the DB connection; re-run
   boot migrations (an older backup on newer code upgrades forward - the
   normal migration path; a *newer* backup on older code is rejected by the
   manifest version check).
5. Emit a `job_runs` record + UI toast; the SPA refetches.

Hosted caveat surfaced in the confirm dialog: the backup carries
`hosted_config.server_secret`; restoring onto a second live box splits the
pairing identity (see `data-inventory.md` §3).

### Backup health (box-local only)

"0 backups" was found by accident; health must be visible without visiting
the page:

- The backup job's failures land in `job_runs` like any job; the Backups
  page and the Tasks page show last-run status and **last successful backup
  time** for both systems (ABS's is inferred from its newest backup's
  `createdAt`).
- A failure (or no success in > 2x the schedule interval) raises the same
  page banner as schedules-off, plus a one-time admin toast on next login.
- Decision D7: this stays **on the box**. The control plane is not told
  about backup state - backups are a per-box concern (consistent with the
  existing split; see the WebApp research: the control plane stores no
  backup metadata, and that remains true).

## Part C - the unified Backups page + copy

One page, two clearly labeled sections, one mental model:

- **AudiobookShelf backups** - "Your library database, book/author metadata,
  users, and listening progress. Does not include your audio files."
- **HearthShelf backups** - "HearthShelf's own data: settings, clubs, notes,
  reading history, profile photos, and integration config."
- A persistent banner when either schedule is off: "Automatic backups are
  off for <system>." (This banner alone would have caught the original
  report.)
- A footer note: "Audio files are not in either backup - protect the
  `abs-audiobooks` volume at the host level."
- Modal copy replaced accordingly (both in this repo's `ConfigBackups.tsx`
  and the WebApp's `src/pages/config/ConfigBackups.tsx` - two repos, same
  fix; shared strings can live alongside the shared types in core).

## Explicitly out of scope for Phase 1

- The combined `.hsarchive` bundle (Phase 2) - Phase 1's two backup lists
  stay separate.
- Cloud/off-box push targets (deferred; the target interface above is the
  only Phase 1 concession). `HS_BACKUP_PATH` host mounts ARE in Phase 1.
- Any merge/import behavior - restore is replace-only.
