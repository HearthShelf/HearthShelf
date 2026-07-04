# Data lifecycle: backups, migration, merge, and exit

> Planning package for HearthShelf's data-lifecycle features. This folder is the
> single home for how HearthShelf data is backed up, restored, moved between
> installs, merged from other servers, and exported when a user leaves. Written
> as an executable plan: an implementer should be able to work through
> `implementation-plan.md` without the original author.

## The problem that started this

An AIO admin opened Config > Backups and saw **0 backups**, despite ABS
"having auto backups." Investigation confirmed three distinct gaps:

1. **ABS auto-backups are off by default** (`backupSchedule = false`,
   `audiobookshelf/server/objects/settings/ServerSettings.js:33`), and the only
   UI that can enable them is ABS's native web UI - which HearthShelf replaces.
   Our Config > Backups page (`src/pages/config/ConfigBackups.tsx`) is a
   read/run-only proxy over `GET|POST /api/backups`; it never exposes schedule,
   retention, or path. So on an AIO, auto-backups can never be turned on.
2. **Nothing backs up HearthShelf's own data.** `hearthshelf.db`, `avatars/`,
   and `narrators/` on the `hearthshelf-data` volume are not in ABS backups and
   have no backup mechanism of their own. An ABS restore alone silently loses
   every club, note, setting, finished-book record, and integration config.
3. **The backup UI copy oversells.** The WebApp modal says it backs up "your
   AudiobookShelf data" - true, but a reasonable admin reads that as "my
   server," which today excludes everything HearthShelf added.

Fixing #1-#3 is Phase 1. But the use cases behind the report (merging two
servers, restoring onto fresh hardware, thin-to-AIO, exit-to-ABS) are one
product area - **data lifecycle** - and every future feature that adds a table
or a file on disk must slot into it. This folder plans the whole area.

## Documents in this folder

| Doc | What it specifies |
| --- | --- |
| `data-inventory.md` | The authoritative map of every piece of state (ABS-owned, HS-owned, control-plane), its keys, its secrets - plus the **data-domain registry**, the mechanism that keeps this map true as features are added |
| `backups.md` | Phase 1: the HS backup service, the unified Backups page (ABS + HS sections, schedule config for both), API surface, retention, copy fixes |
| `archive-format.md` | Phase 2: the versioned `.hsarchive` bundle (ABS backup + HS backup + manifest) - the unit of portability every migration flow consumes |
| `migration-playbooks.md` | Phase 3: step-by-step flows for each use case - fresh AIO from backup, thin-to-AIO, disaster restore, exit-to-ABS, hosted re-pair |
| `merge-engine.md` | Phase 4: the import/merge engine - item matching across installs, user matching, per-user writes via minted ABS keys, HS-table merge rules |
| `implementation-plan.md` | The build order: workstreams per repo, task lists, acceptance criteria, test plan, decisions made, open questions |

## Use cases (from the field, verbatim intent)

| # | Scenario | Covered by |
| --- | --- | --- |
| UC1 | Two servers ran side by side during testing; move all users + histories from the old ABS to the AIO, invite them, and **merge** the two accounts (mine + one other) that used both | `merge-engine.md`, playbook M4 |
| UC2 | ABS crashed / new hardware; set up HS AIO for the first time **from an existing ABS backup** | playbook M2 |
| UC3 | Running HS Thin next to an existing ABS; **swap to AIO** | playbook M3 |
| UC4 | "HS sucks, I want my data back" - **exit to plain ABS** with nothing held hostage | playbook M5 + per-user export |
| UC0 | (implicit) Routine protection: automatic, scheduled backups of *everything*, restorable | `backups.md` |

## Phasing at a glance

```
Phase 1  Backups that actually protect the whole server        (UC0)
Phase 2  One portable archive format (.hsarchive)              (enables all)
Phase 3  Restore + migration playbooks wired into onboarding   (UC2, UC3, UC4)
Phase 4  Import/merge engine                                   (UC1)
Phase 5  Per-user data export                                  (UC4 polish, trust)
```

Each phase ships value alone; none blocks daily use of the previous.

## The extensibility rule (read this before adding any feature)

Every new feature that persists state - a table in `hearthshelf.db`, a file
under `QG_DATA_DIR`, a config singleton - **must register a data domain** (see
`data-inventory.md` > "Data-domain registry"). The registry entry declares the
domain's scope, secret columns, and its backup / export / merge policy. A
boot-time assertion fails loudly when an unregistered table appears, so the
backup and export surfaces can never silently drift out of date again. That is
the structural fix for "we added 28 tables and no backup story."

## Terminology

- **ABS backup** - AudiobookShelf's native zip: `absdatabase.sqlite` +
  `metadata-items/` + `metadata-authors/`. Never audio files.
- **HS backup** - HearthShelf's own snapshot: `hearthshelf.db` + `avatars/` +
  `narrators/` (+ manifest). New in Phase 1.
- **Archive (`.hsarchive`)** - one bundle holding both, plus a manifest. The
  unit users download, upload, and restore from. New in Phase 2.
- **Re-key** - rewriting `(server_id, user_id)` keys on HS rows so data
  recorded against one ABS install follows users to another.
- **Merge** - combining two users' or two servers' histories under the
  per-domain rules in `merge-engine.md`.
