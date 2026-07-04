# Implementation plan

> The build order for the data-lifecycle area. Written to be executed without
> the author: each workstream lists its tasks in dependency order, which repo
> each touches, and what "done" means. Read `README.md` first for context and
> `data-inventory.md` for the facts every task leans on.

## Ground rules for the implementer

- **Repos**: `@hearthshelf/core` changes are made in `C:\code\HearthShelf-Core`
  (commit + push there, then bump the submodule ref in consumers) - never
  edited inside a consumer's `packages/core` checkout. Web changes land in
  `C:\code\HearthShelf` and, where the hosted admin UI mirrors a page, in
  `C:\code\HearthShelf-WebApp`. No pushes except HearthShelf-Core.
- **Evidence-based**: every ABS behavior this plan relies on is cited in
  `data-inventory.md` with file:line into `C:\code\audiobookshelf`. Re-verify
  before building on anything marked "verify."
- Commit per meaningful step, `new:`/`improved:`/`fixes:`/`docs:` prefixes,
  6th-grade summaries.

## Workstream 0 - Foundations (do first, small)

| # | Task | Repo | Notes |
| --- | --- | --- | --- |
| 0.1 | `server/lib/dataDomains.js`: registry with one entry per existing table/file group per `data-inventory.md` §3, + boot assertion (dev: throw; prod: log error) with an `INTERNAL_TABLES` allowlist | HearthShelf | The extensibility keystone; unblocks 1.x and 4.x |
| 0.2 | Core: `types/portability.ts` (manifest, backup list/config shapes, import report shapes) + `lib/portability.ts` stub (manifest validate, version table) + barrel exports | **HearthShelf-Core** | Push, bump submodules |
| 0.3 | Docs: add `docs/data-lifecycle/` to `CLAUDE.md`'s doc list | HearthShelf | Done in the same commit as this folder |

## Workstream 1 - Phase 1 backups (the reported problem)

| # | Task | Repo | Notes |
| --- | --- | --- | --- |
| 1.1 | ABS section on Config > Backups: read/edit `backupSchedule`, `backupsToKeep`, `maxBackupSize`; add download/upload/apply actions; off-schedule warning banner; audio-files footer note | HearthShelf | Schedule write path: ABS server-settings update (`MiscController.js:154` reschedules live) |
| 1.2 | Same page updates in the hosted admin UI | HearthShelf-WebApp | Mirrors 1.1; fix modal copy per `backups.md` Part C |
| 1.3 | `backup_config` singleton (env-overrides-DB: `HS_BACKUP_SCHEDULE`, `HS_BACKUPS_TO_KEEP`) + backup job in `server/jobs/` (VACUUM INTO snapshot, zip with avatars/narrators + manifest, retention sweep), registered in the scheduler, **default on** (nightly 01:00, keep 7) | HearthShelf | Contents driven by the 0.1 registry |
| 1.4 | `server/routes/backups.js`: list/create/config/download/delete/upload/restore per `backups.md`; restore = quiesce, `pre-restore-<ts>/` escape hatch, swap, re-migrate, reconnect | HearthShelf | Admin-gated via `resolveContext` |
| 1.5 | HS section on Config > Backups (both UIs) using 1.4 + core shapes | HearthShelf + WebApp | |
| 1.6 | AIO onboarding: final wizard step enables ABS auto-backup by default (opt-out); Slim shows recommendation card | HearthShelf | |

**Done when** the five acceptance criteria in `backups.md` pass on a fresh AIO
and on a Thin against live ABS. **This workstream alone closes the original
report** - ship it before starting Phase 2.

## Workstream 2 - Archive format

| # | Task | Repo |
| --- | --- | --- |
| 2.1 | Manifest schema + validation + version table in core (extends 0.2) | HearthShelf-Core |
| 2.2 | `POST /hs/archive` (+ estimate): run HS backup, trigger ABS backup and await its task-finished socket event, wrap, stream; HS-only on Thin | HearthShelf |
| 2.3 | `POST /hs/archive/restore` with `replace` / `hs-only` modes (`import` arrives in WS4); ABS-first ordering; hosted `server_secret` warning | HearthShelf |
| 2.4 | "Download full archive" + "Restore archive" on Config > Backups (both UIs) | HearthShelf + WebApp |

## Workstream 3 - Restore & migration flows

| # | Task | Repo | Playbook |
| --- | --- | --- | --- |
| 3.1 | Onboarding "Restore from backup" path: accepts `.hsarchive` or bare ABS zip; throwaway `/init` root -> upload -> apply -> HS restore (if half present) -> honest summary of what was/wasn't restored | HearthShelf | M1, M2 |
| 3.2 | **Post-restore reconcile step**: verify `service_accounts` / `provisioning` users exist in ABS, prompt re-provision + re-mint; rewrite stale `connections.abs_url`; detect zero-match rescan (inode mismatch) and surface it | HearthShelf | M1-M3 |
| 3.3 | Playbook docs published to the docs site (incl. M5 "Leaving HearthShelf" page and M6 operator appendix) | HearthShelf-Docs | M1-M6 |
| 3.4 | Invite-the-restored-users shortcut at the end of 3.1 (reuses hosted invite flow / password reset from user-mgmt work) | HearthShelf (+WebApp for hosted) | M2 |

## Workstream 4 - Import/merge engine

Build strictly in this order; each step is independently testable:

| # | Task | Repo |
| --- | --- | --- |
| 4.1 | Pure matching + merge-rule functions in core (`lib/portability.ts`): item-match chain, user-match proposal, per-field progress merge, LWW/union helpers reused from queue/settings | HearthShelf-Core |
| 4.2 | Source readers: live-ABS admin reader; backup-zip reader (extract sqlite, read via the `absdb.js` read-only technique - extend that file, it is the single home of ABS-schema knowledge) | HearthShelf |
| 4.3 | Dry-run: `/hs/import/inspect` producing the persisted report (job run) | HearthShelf |
| 4.4 | Execute: user creation, per-user minted-key writes (progress batch, `session/local/all`, bookmarks), HS-domain registry merge incl. avatar-file re-key; backup-before-import; resumable + idempotent | HearthShelf |
| 4.5 | Config > Import & Merge UI: source picker, mapping-resolution tables, execute, final report + invite shortcuts | HearthShelf (+WebApp) |

## Workstream 5 - Per-user export

| # | Task | Repo |
| --- | --- | --- |
| 5.1 | `GET /hs/export/me`: walk `userExport: true` domains, strip `secretColumns`, emit `user-export.json` (+ CSV for finished books); settings page button | HearthShelf (+ core types) |

## Test plan (minimum bar)

- **Unit (core)**: manifest version gating; item-match chain incl. fuzzy
  normalization; progress per-field merge (finished-OR, earliest finishedAt,
  LWW currentTime); idempotency (same inputs -> same merged rows).
- **Integration (server, against a scratch ABS container)**: HS backup ->
  restore round-trip equality; archive `replace` restore onto a fresh AIO ->
  users log in with backup credentials, HS rows resolve; import dry-run vs.
  execute row counts match report; re-run import -> zero new writes;
  boot assertion fails on an unregistered table.
- **Manual smoke (the four use cases, on the real AIO)**: UC0 nightly backups
  appear; UC2 wizard restore; UC3 thin->AIO; UC1 two-server merge with one
  deliberate two-account user; M5 volume handoff to stock ABS image boots.

## Decisions made (don't relitigate without new information)

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | HS backups default **on** (nightly, keep 7); ABS schedule enabled by onboarding default | The reported failure was silent unprotection; opt-out beats opt-in for safety features |
| D2 | Server backups include secrets, plainly labeled | Matches ABS's own backup (carries `tokenSecret`, user tokens); a secret-free server backup can't actually restore a server |
| D3 | Per-user writes via minted per-user ABS keys + self-scoped endpoints; no ABS DB writes in v1 | Supported APIs the mobile offline sync already exercises; keeps ABS the sole writer of its DB (house rule) |
| D4 | Restore is replace; merge is only ever the explicit import flow | Two clear mental models; no "smart" restore that guesses |
| D5 | Registry + boot assertion is mandatory for every future persisted feature | The structural fix; review happens on one declarative object |

## Open questions (answer before the workstream that names them)

| # | Question | Owner suggestion | Blocks |
| --- | --- | --- | --- |
| Q1 | Off-box backup targets: host mount (`HS_BACKUP_PATH`) now, or wait for control-plane/R2 push design? | Ship the env-var host mount in 1.3 (cheap), design push separately | none (additive) |
| Q2 | Should Thin's backup job also *trigger* ABS backups on the external ABS (admin token permitting), or only recommend? | Recommend-only in v1; triggering a foreign server's backups is surprising | WS1 |
| Q3 | Archive passphrase encryption (manifest reserves the key) | Defer; revisit with hosted off-box push | WS2 |
| Q4 | Offline password migration (copy `pash` via direct sqlite write while ABS is stopped) as merge-engine v2? | Defer; invites cover it. If built: only in `import` from *backup* sources, never against a live DB | WS4 |
| Q5 | Club merge UX when both servers have same-name clubs (auto-union vs. always-ask) | Always-ask in v1 (`custom` policy) | WS4 |
| Q6 | Does the AIO support fronting an external ABS (M3a) or do we document M3b only? | Document M3b as the path; M3a variant only if users ask | WS3 |
