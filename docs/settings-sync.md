# Server-backed settings sync

> Design doc for the centralized, cross-platform settings store. It supersedes
> the ad-hoc `app_settings` JSON blob described below under "What exists today,"
> defining the DB struct and sync contract so web, hosted, and mobile all
> read/write one thing.
>
> **Status.** Backend + shared definition are built: the `@hearthshelf/core`
> settings catalog (`src/lib/settings.ts`), the `user_settings` + `connections`
> tables with the one-time blob fan-out (`server/db.js`), and the per-key
> `/hs/settings` handler with server-side validation (`server/routes/settings.js`,
> `server/settings.js`, `server/connections.js`, `server/lib/settingsCatalog.js`).
> **Not yet built:** wiring the web and WebApp clients onto the catalog + the
> per-key sync (they still use the whole-blob store), and the per-device
> "Use shared settings" UI.

## Why this exists

As HearthShelf grows past the web SPA (hosted WebApp, mobile, Android Auto), the
same user preferences need to follow a person across every platform - the way the
listening queue already does (`docs/queue.md`). Today only the self-hosted web
client actually syncs settings, and each client has drifted into its own copy of
the setting list with different keys and defaults. This centralizes the
definition (in `@hearthshelf/core`) and the storage (one expandable table set)
so every platform agrees on what a setting is, what it defaults to, and where it
lives.

Two things the current design can't do that this must:

1. **Follow a user everywhere, per-key.** A change on the phone shouldn't clobber
   an unrelated change made on the web a minute later. Sync must merge at the
   setting level, not replace a 27-key blob wholesale.
2. **Distinguish account settings from device settings.** Reader typography, car
   mode, and the library grid size are per-device by nature; theme and skip
   intervals are per-account. And a device must be able to opt out of shared
   settings entirely.

## What exists today (the starting point)

- **Table `app_settings`** - one row per `(server_id, user_id)`, a single opaque
  `values_json` blob, one `updated_at` for the whole thing. See `server/db.js`
  and `server/settings.js`.
- **Endpoint `/hs/settings`** - GET returns `{ values, updatedAt }`; PUT replaces
  the entire blob. `server/routes/settings.js`.
- **Client** - a Zustand store (`hearthshelf:settings`, 27 keys) persisted to
  localStorage, pulled on login and pushed whole (debounced 1.2s) by
  `useSettingsSync.ts`. `src/store/settingsStore.ts`, `src/api/settings.ts`.

Known limits this design removes:

- **Whole-blob last-writer-wins.** The sync unit is the entire object, so two
  devices editing different settings race and the loser's edit is lost.
- **The blob is opaque to the backend.** Reading one setting server-side means
  parsing every user's blob - `getExplicitSharePrefs()` in `server/settings.js`
  literally `SELECT`s and `JSON.parse`s every row just to find who set
  `shareReadBooks`. That doesn't scale as more server-side features need to read
  a single key.
- **No per-setting migration.** Renaming or reshaping one key means a migration
  that rewrites everyone's blob.
- **Key drift across clients.** The WebApp `settingsStore` has diverged: extra
  keys (`cardBg`, `skipForwardCustom`/`skipBackCustom`, `carMode`,
  `carPlayerRect`, `carFadeEnabled`, `carFadeSec`, `showAdvanced`) and different
  defaults (`coverStyle`, `hearthBgPlayer`, `useGravatar`). There is no shared
  definition, so the two clients can't reliably sync the same account.

## Design decisions

- **Per-key rows.** One row per `(server_id, user_id, scope, key)`, each with its
  own `updated_at`. Enables per-key LWW merge, single-key server queries without
  parsing blobs, and per-setting migration. The queue's item list stays in its
  own `listening_queue` table (it churns far more often than a setting); this is
  only for discrete preferences.
- **Account sync + per-device opt-out toggle.** Account-scoped settings sync
  everywhere. A device carries a local **"Use shared settings"** switch: when
  off, the device stops pulling/applying server values and runs purely on its
  local copy (it may still push, or go fully local - see Sync model). Genuinely
  device-local prefs (reader typography, car mode, library view/scale) are not
  forced into the account store; they stay device-local as today, but are modeled
  by the same schema under a `device` scope so one system covers both.
- **Syncable ABS connection.** The bookshelf/ABS connection is modeled as
  centralized state so it can follow a user to a new platform (the memory note:
  "we already save and persist like bookshelf connection but we dont have the
  ability to connect it on all platforms"). The connection URL is a normal
  account setting; the per-user ABS key is a **secret**, so it never rides in the
  synced values payload - it lives in a server-side-only column and is never sent
  to the browser (mirroring how `hardcover_accounts.token` and
  `integrations_config` secrets are handled).
- **One definition in `@hearthshelf/core`.** The setting catalog (keys, types,
  defaults, scope, whether it's a secret) lives in a new
  `src/types/settings.ts` + `src/lib/settings.ts`, consumed by web, hosted, and
  mobile. Both clients unify onto it, ending the key drift.

## Schema

Two tables replace the single `app_settings` blob. Both follow the house
`(server_id, user_id, ...)` keying (see `server/db.js` header comment on why
every per-user table namespaces by `server_id`).

### `user_settings` - per-key account + device preferences

```sql
CREATE TABLE IF NOT EXISTS user_settings (
   server_id   TEXT NOT NULL DEFAULT 'local',
   user_id     TEXT NOT NULL,
   scope       TEXT NOT NULL DEFAULT 'account',  -- 'account' | 'device'
   device_id   TEXT NOT NULL DEFAULT '',         -- '' for account scope; a stable
                                                 -- per-install id for device scope
   key         TEXT NOT NULL,                    -- e.g. 'theme', 'skipForward'
   value_json  TEXT NOT NULL,                    -- the setting value, JSON-encoded
   updated_at  INTEGER NOT NULL,                 -- ms; per-key LWW conflict key
   PRIMARY KEY (server_id, user_id, scope, device_id, key)
);
CREATE INDEX IF NOT EXISTS idx_user_settings_lookup
   ON user_settings (server_id, user_id, scope, device_id);
```

- **`scope`** separates account-wide settings (`device_id = ''`) from
  device-scoped ones. Account settings sync to every device; device settings only
  round-trip for the matching `device_id`, giving cross-device backup of
  device-local prefs without leaking them onto other devices.
- **`value_json`** holds one value (a bool, number, string, or small array like
  `queueAutoRules`). Encoding as JSON keeps the column typeless so the catalog can
  add any shape without a schema change - the expandability requirement.
- **`updated_at` per row** is the merge key. A PUT carries each changed key with
  its client `updatedAt`; the server applies it only if newer than the stored row
  (per-key LWW), so concurrent edits to *different* keys never collide and
  concurrent edits to the *same* key resolve deterministically.
- **Reading one key server-side** is now `WHERE key = 'shareReadBooks'` across the
  server - one indexed query, no blob parsing. `getExplicitSharePrefs()` collapses
  to a single `SELECT`.

Deleting a key (reset to default) is a row delete; absence means "default from the
catalog," preserving the sparse-storage principle the project already follows
(defaults live in code, DB holds only what the user changed - see
`.context/ace3-guide.md` "Configuration Override Pattern", the same philosophy
applies here).

### `connections` - the syncable bookshelf connection (secret-bearing)

```sql
CREATE TABLE IF NOT EXISTS connections (
   server_id     TEXT NOT NULL DEFAULT 'local',
   user_id       TEXT NOT NULL,
   abs_url       TEXT NOT NULL,          -- the bookshelf the user connects to
   abs_user_key  TEXT,                   -- minted per-user ABS key: SECRET,
                                         -- never sent to the browser
   label         TEXT,                   -- optional display name for the box
   last_used_at  INTEGER,
   updated_at    INTEGER NOT NULL,
   PRIMARY KEY (server_id, user_id)
);
```

- `abs_url` and `label` are non-secret and may surface to the client (so a new
  platform can prefill "connect to this bookshelf").
- `abs_user_key` is a **secret**, handled exactly like `hardcover_accounts.token`:
  written server-side, never returned in any response - only a `connected: true`
  status is. This is what lets the connection *follow* a user without exposing the
  key to every device.
- Keyed one-per-user for now; if multi-bookshelf-per-user is ever needed, add a
  `conn_id` to the primary key - the table is shaped to grow into that.

### Where the per-device opt-out lives

The **"Use shared settings"** toggle is itself a device-scoped setting
(`scope='device'`, `key='useSharedSettings'`, default `true`), so it's visible
across a user's devices (you can see which devices opted out) but only governs the
device it belongs to. When `false`, that device's sync layer stops applying
account-scoped server values.

## Sync model

Mirrors the queue's proven pattern (`docs/queue.md`): no realtime channel, pull on
focus/login, push debounced on change, LWW resolves conflicts - but at per-key
granularity.

- **Pull** on login and on foreground: `GET /hs/settings` returns all rows for the
  user (account scope always; device scope for this `device_id`). The client
  merges each key with `resolveQueueConflict`-style per-key LWW (the generic
  helper in `@hearthshelf/core` already works on any `{ updatedAt }` - reuse it).
- **Push** debounced after a local change: `PUT /hs/settings` sends only the
  changed keys, each stamped with the client `updatedAt`. The server upserts each
  row only when the incoming `updatedAt` is `>=` the stored one, and returns the
  authoritative post-merge values for anything it rejected (so a stale device
  adopts the newer value instead of retrying).
- **Device opt-out**: when `useSharedSettings` is `false` on a device, that device
  skips the account-scope apply on pull. Device-scope settings still sync (they're
  backup, not shared).
- **Secrets never sync**: the `connections.abs_user_key` is resolved server-side
  when a request needs to reach ABS; it's never part of the settings payload.

### Endpoint shape (`/hs/settings`, extended)

```
GET /hs/settings?deviceId=<id>
  -> { account: { <key>: { value, updatedAt } },
       device:  { <key>: { value, updatedAt } },
       connection: { absUrl, label, connected } }   // no key ever

PUT /hs/settings
  { deviceId, changes: [ { scope, key, value, updatedAt } ] }
  -> { applied:  [<key>...],
       rejected: [ { key, updatedAt, value } ],          // stale (older updatedAt)
       invalid:  [ { key, reason, value } ] }            // failed validation
```

The response returns per-key results (not the whole blob) so a client can
reconcile exactly what the server accepted. This keeps the wire format aligned
with the per-key storage. A change can be `rejected` (a newer value already
won the LWW race) or `invalid` (it failed the catalog's validation) - the two
are distinct so a client can adopt the server's value for the former and surface
a fix for the latter rather than silently retrying.

## `@hearthshelf/core` additions

Following the package's domain-per-file convention (`src/types/queue.ts` +
`src/lib/queue.ts`):

- `src/types/settings.ts` - `SettingScope`, `SettingKey`, `SettingValue`,
  `SettingDef` (see below), `SettingsCatalog`, and the sync envelope types
  (`SettingChange`, `SettingsPullResult`, `SettingsPushResult`,
  `SettingValidation`).
- `src/lib/settings.ts` - the **catalog** (the single list of every setting with
  its scope, default, and constraints, unifying the web/WebApp key sets), plus
  pure helpers: `validateSetting(catalog, key, value)` (see Validation),
  `mergeSettings(local, remote)` (per-key LWW over the catalog),
  `resolveSetting(catalog, stored, key)` (value-or-default), and
  `changedKeys(prev, next)` for building a minimal push. `resolveQueueConflict`
  is reused for the per-key comparison rather than reimplemented.
- Export both from `src/index.ts` (`export * from './types/settings'` /
  `'./lib/settings'`), matching the existing barrel.

The catalog is the reconciliation point for the WebApp's divergent keys: settings
that are truly WebApp-only (car mode) are catalogued as `scope: 'device'` so they
have a home without polluting other platforms; genuinely shared ones (`coverStyle`
etc.) get one agreed default.

## Validation (first pass, not deferred)

Every setting's constraints live in the catalog as data, next to its type and
default, so the **same rules validate on the client and the server** - there is
one source of truth, no drift between "what the UI allows" and "what the backend
accepts." `SettingDef` carries the constraint inline:

```ts
type SettingDef =
  | { key: string; scope: SettingScope; secret?: boolean; type: 'boolean';
      default: boolean }
  | { key: string; scope: SettingScope; secret?: boolean; type: 'number';
      default: number; min?: number; max?: number; step?: number; int?: boolean }
  | { key: string; scope: SettingScope; secret?: boolean; type: 'string';
      default: string; pattern?: RegExp; maxLen?: number }
  | { key: string; scope: SettingScope; secret?: boolean; type: 'enum';
      default: string; values: readonly string[] }
  | { key: string; scope: SettingScope; secret?: boolean; type: 'json';
      default: unknown; validate: (v: unknown) => boolean }  // e.g. queueAutoRules
```

`validateSetting(catalog, key, value)` returns `{ ok: true, value }` (with the
value coerced/clamped where sensible - e.g. a number outside `min`/`max` is
clamped, not rejected) or `{ ok: false, reason }`. Examples the catalog encodes:

| Setting | Constraint in catalog |
| --- | --- |
| `glow` | number, `min 0`, `max 60`, `int` |
| `skipForward` / `skipBack` | number, `min 5`, `max 300`, `int` |
| `theme` | enum `['dark','light','flat','oled']` |
| `accentHex` | string, `pattern /^#[0-9a-fA-F]{6}$/` |
| `autoSleepStart` / `autoSleepEnd` | string, `pattern /^([01]\d|2[0-3]):[0-5]\d$/` |
| `queueAutoRules` | json, `validate`: array of `{ id: AutoRuleId, on: boolean }` |
| `shareReadBooks` | boolean-or-null (tri-state; `null` = follow server default) |

**Server-side** the PUT handler runs `validateSetting` on every incoming change
before the LWW upsert: invalid values go into the response's `invalid[]` and are
never written, so a malicious or buggy client can't poison a row that other
devices then read. Unknown keys (not in the catalog) are treated as invalid and
dropped. **Client-side** the same call gates the settings UI, so the check is
immediate and offline. Because both import the one catalog from
`@hearthshelf/core`, adding or tightening a constraint is a one-line edit that
takes effect everywhere at once.

## Migration

On boot, if `app_settings` has rows, fan each user's blob out into `user_settings`
rows: every catalog key present in the blob becomes an `(account|device, key,
value, updated_at)` row using the blob's single `updated_at` as the seed
timestamp; unknown keys are dropped (or parked under a `legacy` scope if we want
to be conservative). Then leave `app_settings` in place, renamed-in-spirit like
the `discover.json` -> `discover.json.migrated` precedent (`docs/database.md`), so
nothing is lost and a rollback is possible. The ABS connection is seeded into
`connections` from whatever the current per-platform auth stores hold.

## Out of scope (for this first build)

- Realtime push between devices (poll-on-focus is enough, same call as the queue).
- Multi-bookshelf-per-user (schema is shaped to grow into it; not built now).
- Cross-field / conditional validation (e.g. "`autoSleepEnd` must be after
  `autoSleepStart`"). The first pass validates each setting independently against
  its own catalog constraint; rules that span two settings can come later.
```
