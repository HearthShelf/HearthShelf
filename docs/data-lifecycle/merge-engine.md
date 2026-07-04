# Phase 4: the import/merge engine

> Design for importing users and their histories from another ABS install into
> this one, including merging two accounts that belong to the same person
> (UC1). This is the hardest piece of the lifecycle area; everything here is
> grounded in verified ABS 2.35.1 behavior (see `data-inventory.md` §2).

## The three hard constraints (and how we route around them)

1. **All ABS ids are per-install UUIDs.** A book, user, or progress row on
   server A shares no id with its twin on server B.
   -> Build explicit **maps**: `userMap: sourceUserId -> targetUserId` and
   `itemMap: sourceMediaItemId -> targetMediaItemId`. Everything downstream
   consumes only these maps.

2. **No admin API writes another user's progress, sessions, or bookmarks**
   (`UserController.js:219`; progress/bookmark routes are `/api/me/...`).
   -> Write **as each user**. HearthShelf already mints per-user ABS API keys
   via its admin token (the HS-owned auth mechanism used by hosted mode /
   `hosted_user_keys`, and per-user keys in `connections`). The engine mints
   a key per target user and calls the self-scoped endpoints with it:
   - progress: `PATCH /api/me/progress/batch/update` (applies
     unconditionally - the engine pre-merges, see below)
   - listening sessions: `POST /api/session/local/all` - the offline-sync
     endpoint, LWW-guarded per session with per-item results
     (`ABS_OFFLINE_SYNC_RULES` in `@hearthshelf/core`), which makes session
     import **naturally idempotent**
   - bookmarks: `POST /api/me/item/:id/bookmark`
   This is the decisive design insight: the entire per-user import uses
   supported, already-exercised ABS endpoints - the same ones mobile offline
   sync uses - not database surgery.

3. **Passwords cannot migrate over the API** (`POST /api/users` cannot set
   `pash` or `token`).
   -> v1: created users arrive without their old password; the flow ends with
   invites (hosted) or admin-set temporary passwords / reset (self-hosted).
   An "offline mode" that copies `pash` by writing ABS's sqlite while ABS is
   stopped is documented as a possible v2 (open question Q4) - not built
   first, because the API path covers the need and touches nothing fragile.

## Pipeline

```
source (live ABS admin creds | .hsarchive | ABS backup zip)
   │  1. INVENTORY      read users, libraryItems→media, progress, sessions,
   │                    bookmarks (+ HS domains if archive has an HS half)
   │  2. ITEM MATCHING  source items → target items
   │  3. USER MATCHING  source users → target users (or “create”)
   │  4. DRY-RUN REPORT admin reviews + resolves in UI     ← always stops here first
   │  5. EXECUTE        create users → per-user writes → HS-domain merge
   └─ 6. REPORT         counts, skips, unmatched, per-user results (persisted as a job run)
```

Runs inside the jobs framework (`job_runs` / `job_run_logs`) for progress,
logs, and resumability. Reading a *backup zip* source: extract
`absdatabase.sqlite` to a temp path and read it with the same read-only
libSQL technique as `server/lib/absdb.js` - the schema knowledge extends that
one file (its documented single home for ABS-schema knowledge).

### Item matching (step 2)

Ordered chain; first hit wins, every decision recorded with its method:

| Order | Key | Notes |
| --- | --- | --- |
| 1 | file inode | What ABS's own rescan trusts (`LibraryScanner.js:672-711`). Only valid when both installs saw the same filesystem (thin->AIO, same-host merges) |
| 2 | ASIN | Sparse but precise |
| 3 | ISBN | Sparse but precise |
| 4 | normalized title + first author | Case/diacritic/articles-stripped; flagged "fuzzy" in the report |
| - | unmatched | Listed in the report; their progress is skipped (or held for later re-run after the admin fixes metadata) |

Mapping resolves source `mediaProgress.mediaItemId` (a **media** id) via
source libraryItem -> match -> target libraryItem -> target media id - the
two-hop is required because progress references media, not library items.

### Media-type scope

**Books only in v1** (decision D6). Podcast episode progress needs a
different matching key (feed GUID / enclosure URL, not inode/ASIN) and we
have no podcast data to test against. The engine reports podcast progress
rows as `skipped: podcast` in the dry-run - visible, honest, not silently
dropped - and the matcher grows an episode strategy when someone can test it.

### User matching (step 3)

Default proposal, admin-editable in the dry-run UI:

1. exact email match (emails are optional in ABS - only when present)
2. exact case-insensitive username match
3. otherwise **create** (via `POST /api/users` with the source's type,
   permissions, `isActive`)

The UC1 "merge my two accounts" case is just an edit: point source user X at
existing target user Y. Nothing else in the engine cares how a mapping arose.
Root/service accounts from the source are never auto-imported (flagged,
default skip).

### Per-field merge rules for ABS data (step 5)

When a target user already has progress for a matched item:

| Field | Rule |
| --- | --- |
| `isFinished` / `finishedAt` | OR; keep the **earliest** non-null `finishedAt` (first completion is the historical fact) |
| `currentTime` / `ebookLocation` / `ebookProgress` | From whichever side has the newer `lastUpdate` (LWW) |
| `hideFromContinueListening` | OR |
| sessions | Union - sessions are events, never conflict; the LWW guard on `session/local/all` deduplicates re-runs by id |
| bookmarks | Union by (item, time); skip exact duplicates |

The engine computes the merged row **before** writing, because
`meProgressBatchUpdate` applies unconditionally (no server-side guard - per
`ABS_OFFLINE_SYNC_RULES`). Idempotency therefore lives in the engine: a
re-run recomputes the same merged value (stable inputs -> stable output) and
skips writes whose target already equals the computed result.

### HS-domain merge (step 5, when the source has an HS half)

Walk the data-domain registry (`data-inventory.md` §5); each domain's
`merge` policy + `itemRefs`/`userRefs` drive a generic pass:

- re-key rows through `userMap` (and rename avatar files, whose filenames
  embed the key pair)
- re-map `itemRefs` columns through `itemMap`
- apply the policy: `union` (e.g. `finished_books`, notes), `lww` (settings,
  queue - reusing the per-key LWW helpers already in core), `skip`
  (rate_limits, job history), `custom` (clubs: union clubs by name with
  admin confirmation, then union members/books)

Instance singletons (`ai_config`, `integrations_config`, ...) never merge -
target wins, report says so.

### Safety properties

- **Dry-run is mandatory** - execute requires a report id produced by this
  engine version against the current target state.
- **Read-only toward the source.** Live-source reads use admin GETs; backup
  sources are files. The engine never writes to the source server.
- **Backup-before-import**: executing first triggers a Phase 1 HS backup and
  an ABS backup, and the report links them. Undo = restore those.
- **Resumable**: per-user progress recorded in `job_run_logs`; a crash
  mid-import re-runs safely because of idempotency above.

## Two more modes on the same engine

The pipeline generalizes beyond "import that other server" with two flags -
build them in Phase 4, they are where most of the engine's real-world value
lands:

### Restore-as-import (UC5 - selective restore)

Source = **an old backup of this same server**. The admin scopes the dry-run
to selected users (a user-subset filter in step 3's mapping table - needed
for this mode, cheap for all modes) and the engine recovers just their
progress/sessions/bookmarks/HS domains, leaving everyone else's newer data
untouched. Same-install ids mean matching is trivial (ids are equal; the
item matcher only kicks in for items deleted since the backup). This turns
every nightly backup into per-user undo, without ABS's all-or-nothing apply.

### Re-link after a library move (UC6)

Source = **this server's own past state** (the most recent backup) after the
audio files moved to a new disk/path and a rescan created all-new items.
Inodes are dead by definition, so the chain runs ASIN -> ISBN -> fuzzy from
old items to new items, producing an `itemMap` within one server. Execute
then: (a) rewrites HS `itemRefs` columns through the map, and (b) re-attaches
each user's orphaned progress/bookmarks to the new item ids via the same
per-user minted-key writes. Dry-run report doubles as a "what didn't
re-link" audit. The wizard's zero-match rescan detection (playbook M3)
points the admin here.

## Product surface

- Config > **Import & Merge** (admin): source picker, dry-run report with
  match-resolution UI (user mapping table, fuzzy-item review), execute,
  final report with invite shortcuts.
- API: `/hs/import/inspect` (dry-run), `/hs/import/execute`,
  `/hs/import/runs/:id`. Shapes in `@hearthshelf/core`
  (`types/portability.ts`), engine logic that is pure (matching chains,
  merge-rule functions) in `lib/portability.ts` so it is unit-testable and
  shared; the I/O-bound orchestration stays in `server/`.
