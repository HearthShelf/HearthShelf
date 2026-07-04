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
- **AIO onboarding**: the wizard's final step enables ABS auto-backup
  (`30 1 * * *`, keep 2 - ABS's own conventions) unless the admin unticks it.
  Slim mode: don't touch a foreign ABS's settings silently; show the same
  card as a recommendation instead.
- Add the missing ABS actions our page lacks: download
  (`GET /api/backups/:id/download`), upload (`POST /api/backups/upload`),
  apply with a confirm that spells out "replaces ALL AudiobookShelf data with
  the backup's contents; HearthShelf data is separate."

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

- Directory: `${QG_DATA_DIR}/backups/` (same volume as the DB).
- Name: `hearthshelf-<server_name-slug>-<YYYY-MM-DDTHHmm>.hsbackup` (a zip).
- Schedule + retention are instance settings in a new `backup_config`
  singleton (env-overrides-DB per field like `ai_config`:
  `HS_BACKUP_SCHEDULE`, `HS_BACKUPS_TO_KEEP`). **Defaults: `0 1 * * *`
  (nightly 01:00), keep 7.** The DB is small; a week of dailies is cheap.
- Honest limitation, stated in the UI: backups on the same volume don't
  survive volume loss. "Download a copy" is the mitigation now; off-box
  targets (host mount via `HS_BACKUP_PATH`, control-plane/R2 push for hosted)
  are a registered future feature that slots into this same service.

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
- Off-box backup targets (registered future feature).
- Any merge/import behavior - restore is replace-only.
