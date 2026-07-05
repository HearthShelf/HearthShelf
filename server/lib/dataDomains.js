// The data-domain registry - the single declarative map of every piece of
// HearthShelf-owned state (tables in hearthshelf.db, file trees under
// QG_DATA_DIR) and what each lifecycle surface must do with it. Backups, the
// per-user export, and the merge engine all walk this list instead of a
// hand-maintained one, so they can never silently drift out of date as features
// are added. See docs/data-lifecycle/data-inventory.md section 5.
//
// The boot assertion (assertDomainsCoverSchema) diffs the real sqlite_master
// tables against the union of every domain's `tables` plus INTERNAL_TABLES. An
// unregistered table throws at boot in dev and logs an error in production, so
// adding a table without a lifecycle decision becomes impossible to do silently.
//
// A domain entry:
//   key           - stable id (kebab-case), used in manifests + reports
//   tables        - the hearthshelf.db tables it owns (drives the boot diff)
//   files         - null, or { root, pattern } for a file tree on the data volume
//   scope         - 'user' | 'server' | 'instance' (who the rows belong to)
//   secretColumns - { table: [column, ...] } - stripped from per-user exports
//   backup        - 'always' (snapshot it) | 'derived' (re-derivable but still
//                   snapshotted for convenience) | 'never' (control-plane etc.)
//   userExport    - true if it appears in a user's "export my data"
//   merge         - 'union' | 'lww' | 'skip' | 'custom' (Phase 4 uses this)
//   itemRefs      - columns holding ABS library-item ids (need re-map on merge)
//   userRefs      - 'key' (the user_id key column) or explicit [columns]

export const DATA_DOMAINS = [
  {
    key: 'server-identity',
    tables: ['server_identity'],
    files: null,
    scope: 'instance',
    secretColumns: {},
    backup: 'always',
    userExport: false,
    merge: 'skip', // identity is per-install; never merged
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'user-settings',
    tables: ['user_settings', 'app_settings'],
    files: null,
    scope: 'user',
    secretColumns: {},
    backup: 'always',
    userExport: true,
    merge: 'lww', // per-key last-writer-wins (app_settings is legacy, never merged)
    itemRefs: [],
    userRefs: 'key',
  },
  {
    key: 'connections',
    tables: ['connections'],
    files: null,
    scope: 'user',
    secretColumns: { connections: ['abs_user_key'] },
    backup: 'always',
    userExport: false, // holds a per-user ABS secret; export is the secret-free surface
    merge: 'lww',
    itemRefs: [],
    userRefs: 'key',
  },
  {
    key: 'listening-queue',
    tables: ['listening_queue'],
    files: null,
    scope: 'user',
    secretColumns: {},
    backup: 'always',
    userExport: true,
    merge: 'lww',
    itemRefs: [],
    userRefs: 'key',
  },
  {
    key: 'avatars',
    tables: ['avatars'],
    files: { root: 'avatars', pattern: '<server_id>_<user_id>.<ext>' },
    scope: 'user',
    secretColumns: {},
    backup: 'always',
    userExport: false, // the image is the user's, but export is JSON; file export TBD
    merge: 'custom', // file re-key on merge (rename <server>_<user>.<ext>)
    itemRefs: [],
    userRefs: 'key',
  },
  {
    key: 'narrator-images',
    tables: ['narrator_images'],
    files: { root: 'narrators', pattern: '<server_id>_<name_key>.<ext>' },
    scope: 'server',
    secretColumns: {},
    backup: 'derived', // re-derivable by the series-roster job; snapshot for convenience
    userExport: false,
    merge: 'skip',
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'finished-books',
    tables: ['finished_books'],
    files: null,
    scope: 'user',
    secretColumns: {},
    backup: 'always',
    userExport: true,
    merge: 'union', // reading history exists nowhere else; union on the UNIQUE key
    itemRefs: ['finished_books.library_item_id'],
    userRefs: 'key',
  },
  {
    key: 'book-notes',
    tables: ['book_notes'],
    files: null,
    scope: 'user',
    secretColumns: {},
    backup: 'always',
    userExport: true,
    merge: 'union',
    itemRefs: ['book_notes.library_item_id'],
    userRefs: 'key',
  },
  {
    key: 'clubs',
    tables: ['clubs', 'club_books', 'club_members'],
    files: null,
    scope: 'server',
    secretColumns: {},
    backup: 'always',
    userExport: false,
    merge: 'custom', // club_books.library_item_id needs item re-map; members need user re-map
    itemRefs: ['club_books.library_item_id'],
    userRefs: ['clubs.created_by', 'club_books.added_by', 'club_members.user_id'],
  },
  {
    key: 'discover',
    tables: ['qg_feedback', 'qg_monthly', 'qg_runs'],
    files: null,
    scope: 'user',
    secretColumns: {},
    backup: 'always',
    userExport: true,
    merge: 'lww', // Discover/QuestGiver state; low stakes
    itemRefs: [],
    userRefs: 'key',
  },
  {
    key: 'aggregates',
    tables: ['popular_signals', 'series_roster'],
    files: null,
    scope: 'server',
    secretColumns: {},
    backup: 'derived',
    userExport: false,
    merge: 'skip', // re-derivable aggregates; never merged
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'rate-limits',
    tables: ['rate_limits'],
    files: null,
    scope: 'user',
    secretColumns: {},
    backup: 'always',
    userExport: false,
    merge: 'skip', // resetting counts on migration is fine
    itemRefs: [],
    userRefs: 'key',
  },
  {
    key: 'backup-config',
    tables: ['backup_config'],
    files: null,
    scope: 'instance',
    secretColumns: {},
    backup: 'always',
    userExport: false,
    merge: 'skip',
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'community-config',
    tables: ['community_config'],
    files: null,
    scope: 'instance',
    secretColumns: {},
    backup: 'always',
    userExport: false,
    merge: 'skip',
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'ai-config',
    tables: ['ai_config'],
    files: null,
    scope: 'instance',
    secretColumns: { ai_config: ['api_key', 'base_url'] },
    backup: 'always',
    userExport: false,
    merge: 'skip', // env-overrides-DB; instance policy
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'integrations-config',
    tables: ['integrations_config'],
    files: null,
    scope: 'instance',
    secretColumns: { integrations_config: ['rmab_login_token', 'audplexus_key'] },
    backup: 'always',
    userExport: false,
    merge: 'skip',
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'hosted-config',
    tables: ['hosted_config'],
    files: null,
    scope: 'instance',
    // Pairing identity - see the hosted caveat in data-inventory.md. Backed up so
    // a replacement box re-attaches cleanly, plainly flagged as a secret.
    secretColumns: { hosted_config: ['server_secret', 'abs_admin_token'] },
    backup: 'always',
    userExport: false,
    merge: 'skip',
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'hosted-user-keys',
    tables: ['hosted_user_keys'],
    files: null,
    scope: 'server',
    secretColumns: { hosted_user_keys: ['abs_api_key'] },
    backup: 'derived', // a cache; safe to drop and re-mint
    userExport: false,
    merge: 'skip',
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'service-accounts',
    tables: ['service_accounts'],
    files: null,
    scope: 'instance',
    secretColumns: {},
    backup: 'always',
    userExport: false,
    merge: 'skip', // ABS user ids change across installs; re-resolved after migration
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'provisioning',
    tables: ['provisioning'],
    files: null,
    scope: 'instance',
    secretColumns: { provisioning: ['root_password'] },
    backup: 'always',
    userExport: false,
    merge: 'skip',
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'telemetry-config',
    tables: ['telemetry_config'],
    files: null,
    scope: 'instance',
    secretColumns: {},
    backup: 'always',
    userExport: false,
    merge: 'skip',
    itemRefs: [],
    userRefs: [],
  },
  {
    key: 'hardcover-accounts',
    tables: ['hardcover_accounts'],
    files: null,
    scope: 'user',
    secretColumns: { hardcover_accounts: ['token'] },
    backup: 'always',
    userExport: false, // holds a per-user PAT; export is secret-free
    merge: 'lww',
    itemRefs: [],
    userRefs: 'key',
  },
  {
    // Release subscriptions: the books/series a user follows for notifications.
    // The awaited book's identifiers are Audible ASINs (asin / series_asin), not
    // ABS library-item ids, so there are no itemRefs to re-map on merge.
    key: 'release-subscriptions',
    tables: ['subscriptions'],
    files: null,
    scope: 'user',
    secretColumns: {},
    backup: 'always',
    userExport: true, // the user's own follow list
    merge: 'union', // hand-picked follows from each device combine
    itemRefs: [],
    userRefs: 'key',
  },
  {
    // Expo push tokens per user+device. Device-specific and sensitive (a push
    // token targets a physical device), so never exported and never merged - each
    // device re-registers its own token on launch.
    key: 'push-tokens',
    tables: ['push_tokens'],
    files: null,
    scope: 'user',
    secretColumns: { push_tokens: ['token'] },
    backup: 'always',
    userExport: false,
    merge: 'skip',
    itemRefs: [],
    userRefs: 'key',
  },
]

// Tables that belong to no lifecycle domain by design: operational history and
// the job-log stream, plus the merge engine's own report log. They are backed up
// as part of the whole-DB snapshot (the backup copies the file, not per-domain),
// but they are never merged or exported, so they get an allowlist entry instead
// of a domain. Keeping this list explicit is the point: a NEW table must be a
// conscious choice between a domain and this allowlist, never an accident.
export const INTERNAL_TABLES = ['job_runs', 'job_run_logs', 'import_reports']

// The set of every table the registry knows about (domains + internal allowlist).
function knownTables() {
  const set = new Set(INTERNAL_TABLES)
  for (const d of DATA_DOMAINS) for (const t of d.tables) set.add(t)
  return set
}

// The file trees any domain declares, for the backup service to include.
export function backupFileRoots() {
  const roots = []
  for (const d of DATA_DOMAINS) {
    if (d.files && d.backup !== 'never') roots.push(d.files.root)
  }
  return roots
}

// Boot assertion: every real table must be registered. Called once from initDb
// after the schema is created. `sqliteMasterTables` is the list of table names
// from sqlite_master. In dev (NODE_ENV !== 'production') an unregistered table
// throws so it's caught before commit; in production it logs an error so a box
// still boots (a backup that misses a new table is bad, but a box that won't
// start is worse). SQLite's own internal tables (sqlite_*) are ignored.
export function assertDomainsCoverSchema(sqliteMasterTables) {
  const known = knownTables()
  const unregistered = sqliteMasterTables.filter(
    (t) => !t.startsWith('sqlite_') && !known.has(t),
  )
  if (unregistered.length === 0) return { ok: true, unregistered: [] }

  const msg =
    `[dataDomains] Unregistered table(s) in hearthshelf.db: ${unregistered.join(', ')}. ` +
    `Every table must be declared in server/lib/dataDomains.js (a DATA_DOMAINS entry) ` +
    `or the INTERNAL_TABLES allowlist. See docs/data-lifecycle/data-inventory.md.`
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.error(msg)
    return { ok: false, unregistered }
  }
  throw new Error(msg)
}

export function getDomain(key) {
  return DATA_DOMAINS.find((d) => d.key === key) ?? null
}
