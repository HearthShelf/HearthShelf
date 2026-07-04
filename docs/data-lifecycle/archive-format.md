# Phase 2: the `.hsarchive` portability format

> One file that carries a whole HearthShelf server. Every migration flow in
> `migration-playbooks.md` consumes or produces this format; the merge engine
> (Phase 4) accepts it as a source. Designing it once, versioned, is what
> keeps the next dozen features from each inventing their own export.

## Why a bundle (and not "two downloads")

Phase 1 leaves an admin with two backup artifacts (ABS zip + HS zip) whose
pairing is implicit. Every real scenario - "move my server," "restore after a
crash," "import that old server" - needs both, from the same moment, plus
metadata about where they came from. The archive makes the pairing explicit
and self-describing.

## Container layout

A `.hsarchive` is a plain zip:

```
my-server-2026-07-03T0100.hsarchive
├── manifest.json
├── abs/
│   └── backup.audiobookshelf        # ABS's own backup zip, byte-for-byte
└── hs/
    └── backup.hsbackup              # the Phase 1 HS backup zip, byte-for-byte
```

Both inner artifacts stay in their native formats - the archive adds nothing
they can't already restore from individually, so a `.hsarchive` can always be
unzipped by hand and fed to stock tooling. That is the UC4 ("give me my data
back") guarantee at the server level: the ABS half restores on a plain ABS
install with no HearthShelf anywhere.

## `manifest.json` (format version 1)

Schema lives in `@hearthshelf/core` (`types/portability.ts`), validated by a
pure helper in `lib/portability.ts` (same pattern as the settings catalog).

```jsonc
{
  "format": "hsarchive",
  "formatVersion": 1,
  "createdAt": 1751536800000,
  "source": {
    "serverId": "…",              // HS server_identity UUID
    "serverName": "Family Library",
    "hsVersion": "0.4.2",
    "absVersion": "2.35.1",
    "mode": "aio"                  // aio | slim | hosted
  },
  "contents": {
    "abs": { "present": true, "filename": "backup.audiobookshelf", "size": 123, "absBackupId": "2026-07-03T0100" },
    "hs":  { "present": true, "filename": "backup.hsbackup", "size": 456,
             "domains": [{ "key": "finished-books", "rows": 812 }, ...] }
  },
  "includesSecrets": true,
  "checksums": { "abs/backup.audiobookshelf": "sha256:…", "hs/backup.hsbackup": "sha256:…" }
}
```

Rules:

- `formatVersion` gates everything. Readers reject versions above what they
  know; version bumps are additive where possible, and `lib/portability.ts`
  owns the compatibility table.
- Either half may be absent (`present: false`) - a Thin install exports an
  HS-only archive (it doesn't own the ABS server); an "ABS only" export is
  just re-wrapping an ABS backup. Consumers must handle both.
- `domains` comes straight from the data-domain registry - the manifest stays
  accurate as features are added, for free.
- Secrets: inherited from the halves (both include secrets; see
  `backups.md`). `includesSecrets` is informational for UI warnings.
  Passphrase encryption of the whole archive is an open question
  (`implementation-plan.md` Q3) - the format reserves an
  `"encryption"` manifest key but v1 ships without it.

## Producing an archive

- **UI**: Config > Backups gains "Download full archive" - the backend runs
  an HS backup, requests a fresh ABS backup (`POST /api/backups`, waits for
  the task via the existing task-finished socket event), wraps both, streams
  the result. On Thin, produces an HS-only archive and says so.
- **API**: `POST /hs/archive` (create + stream) and
  `GET /hs/archive/estimate` (sizes up front). Admin-gated.
- **Scheduled?** No. Nightly ABS + HS backups already exist separately;
  archives are an on-demand export. (Revisit if off-box push ships - the
  pushed unit would be an archive.)

## Consuming an archive

`POST /hs/archive/restore` (multipart upload, or a filename already in the
backups dir), admin-gated, with a mode flag:

| Mode | Behavior | Used by |
| --- | --- | --- |
| `replace` | Apply ABS half via upload+apply, then restore HS half (Phase 1 restore semantics). The full-server restore. | Playbooks M1, M2 |
| `hs-only` | Restore only the HS half. | Thin -> AIO variants |
| `import` | Hand both halves to the merge engine as a *source* - no in-place replacement. | Phase 4, playbook M4 |

`replace` ordering matters: ABS first (its restore replaces every user id
with the archive's ids), HS second (whose rows are keyed to exactly those
ids). Restoring an archive made on server A onto server B is therefore
internally consistent by construction - the pair moves together.

The onboarding wizard's "Restore from backup" path (playbook M2) accepts a
`.hsarchive` *or* a bare ABS backup zip; in the bare case the HS side starts
fresh and the wizard says which of the two happened.

## What this format is not

- Not a per-user export (Phase 5 defines a small, secret-free
  `user-export.json` - same core types file, different shape).
- Not an incremental/differential format. Full snapshots only; the data is
  small. Revisit only with evidence.
- Not a sync protocol. One-shot artifact, no LWW semantics of its own -
  merging is the engine's job, not the container's.
