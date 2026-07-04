// The import/merge engine orchestration (Phase 4). The PURE matching + merge
// logic lives in @hearthshelf/core (lib/portability.js); this file is the I/O
// around it: read source + target inventories, run the matchers, persist the
// dry-run report, and (in importExecute.js) apply it. See
// docs/data-lifecycle/merge-engine.md.
//
// A dry-run (inspect) always runs first and is persisted as an import_reports
// row; execute requires that report id. The report is regenerated if stale.

import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import { db, getServerId, DB_DIR } from '../db.js'
import { readTargetInventory } from './absdb.js'
import { readUploadedSource, readLiveSource } from './importSource.js'

// Where a dry-run stashes the read source inventory so execute can apply it
// without a re-upload. One file per report, cleaned up after execute (or on a
// sweep of old reports). The HS-backup buffer, if any, is stashed alongside.
const IMPORT_STAGE_DIR = path.join(DB_DIR, 'import-staging')

async function stashSource(reportId, source) {
  await fs.mkdir(IMPORT_STAGE_DIR, { recursive: true })
  // The HS-backup buffer is binary; keep it as a separate file and store only its
  // presence in the JSON so JSON.stringify doesn't balloon.
  const { hsBackupBuf, ...rest } = source
  await fs.writeFile(
    path.join(IMPORT_STAGE_DIR, `${reportId}.json`),
    JSON.stringify(rest),
  )
  if (hsBackupBuf) {
    await fs.writeFile(path.join(IMPORT_STAGE_DIR, `${reportId}.hsbackup`), hsBackupBuf)
  }
}

// Read back the stashed source inventory for execute. Returns null if missing
// (an old report whose staging was swept - the admin must re-run inspect).
export async function readStashedSource(reportId) {
  try {
    const json = await fs.readFile(path.join(IMPORT_STAGE_DIR, `${reportId}.json`), 'utf8')
    const source = JSON.parse(json)
    try {
      source.hsBackupBuf = await fs.readFile(path.join(IMPORT_STAGE_DIR, `${reportId}.hsbackup`))
    } catch {
      source.hsBackupBuf = null
    }
    return source
  } catch {
    return null
  }
}

export async function clearStashedSource(reportId) {
  await fs.rm(path.join(IMPORT_STAGE_DIR, `${reportId}.json`), { force: true }).catch(() => {})
  await fs.rm(path.join(IMPORT_STAGE_DIR, `${reportId}.hsbackup`), { force: true }).catch(() => {})
}
import {
  buildTargetIndex,
  matchItem,
  matchUser,
  IMPORT_ENGINE_VERSION,
} from '@hearthshelf/core'

// Books only in v1 - podcast progress needs a different matching key. Podcast
// progress is reported as skipped, never silently dropped.
function splitPodcastProgress(progress) {
  const book = []
  let podcastSkipped = 0
  for (const p of progress) {
    if (p.mediaItemType === 'podcastEpisode' || p.mediaItemType === 'podcast') {
      podcastSkipped++
      continue
    }
    book.push(p)
  }
  return { book, podcastSkipped }
}

// Produce (and persist) a dry-run report. `opts`:
//   mode: 'import' | 'restore-as-import' | 'relink'
//   source: { uploadBuf } | { absUrl, adminToken }
//   allowInode: bool (same-filesystem sources)
//   userSubset: string[] | null (restrict to these source user ids)
export async function importInspect(opts) {
  const serverId = await getServerId()
  const mode = opts.mode || 'import'

  // --- read inventories ---
  const target = await readTargetInventory()
  if (!target) {
    throw new Error('This server\'s AudiobookShelf database is not readable - import needs it mounted.')
  }
  let source
  if (opts.source?.uploadBuf) {
    source = await readUploadedSource(opts.source.uploadBuf)
  } else if (opts.source?.absUrl && opts.source?.adminToken) {
    source = await readLiveSource(opts.source.absUrl, opts.source.adminToken)
  } else {
    throw new Error('No import source was provided.')
  }

  const sameServer = Boolean(source.serverId && source.serverId === serverId)
  // Same-server (restore/relink) trusts ids; relink specifically expects new
  // inodes so it must NOT use the inode strategy (that's what broke). import from
  // the same filesystem may use inode.
  const allowInode = mode === 'relink' ? false : Boolean(opts.allowInode)
  const useSameServerIds = (mode === 'restore-as-import' || mode === 'relink') && sameServer

  // --- item matching ---
  const index = buildTargetIndex(target.items.filter((i) => !i.isPodcast))
  const itemMatches = source.items
    .filter((i) => !i.isPodcast)
    .map((i) => matchItem(i, index, { allowInode, sameServer: useSameServerIds }))
  const matched = itemMatches.filter((m) => m.targetMediaId)
  const fuzzy = matched.filter((m) => m.fuzzy)
  const unmatched = itemMatches.filter((m) => !m.targetMediaId)
  // sourceMediaId -> targetMediaId, for counting per-user writable progress.
  const mediaMap = new Map()
  for (const m of matched) mediaMap.set(m.sourceMediaId, m.targetMediaId)

  // --- user matching ---
  let sourceUsers = source.users
  if (opts.userSubset && opts.userSubset.length) {
    const subset = new Set(opts.userSubset.map(String))
    sourceUsers = sourceUsers.filter((u) => subset.has(u.id))
  }
  const userMatches = sourceUsers.map((u) => matchUser(u, target.users))

  // --- per-user plan counts ---
  const { book: bookProgress, podcastSkipped } = splitPodcastProgress(source.progress)
  const progressByUser = new Map()
  for (const p of bookProgress) {
    if (!progressByUser.has(p.userId)) progressByUser.set(p.userId, [])
    progressByUser.get(p.userId).push(p)
  }
  const bookmarksByUser = new Map()
  for (const b of source.bookmarks) {
    if (!bookmarksByUser.has(b.userId)) bookmarksByUser.set(b.userId, [])
    bookmarksByUser.get(b.userId).push(b)
  }
  const perUser = {}
  const includedUserIds = new Set(
    userMatches.filter((u) => u.action !== 'skip').map((u) => u.sourceUserId),
  )
  for (const uid of includedUserIds) {
    const prog = progressByUser.get(uid) ?? []
    // Only progress whose media maps to a target item is writable.
    const writable = prog.filter((p) => mediaMap.has(p.mediaItemId))
    perUser[uid] = {
      progress: writable.length,
      sessions: 0, // sessions come from the source's session data (live/backup) - counted in execute; 0 here in v1
      bookmarks: (bookmarksByUser.get(uid) ?? []).length,
    }
  }

  // --- HS-domain plan (archive sources only) ---
  const domains = []
  if (source.hsBackupBuf) {
    // Detailed per-domain counts require unzipping the HS backup and reading each
    // table; for the dry-run we note the halves are present and defer the exact
    // counts to execute (which re-keys row-by-row). This keeps inspect fast.
    domains.push({ key: 'hs-data', policy: 'custom', toWrite: 0, skipped: 0, note: 'HearthShelf data will be merged on execute (clubs ask before combining).' })
  }

  const warnings = []
  if (podcastSkipped > 0) warnings.push(`${podcastSkipped} podcast progress entries are skipped (books only for now).`)
  if (unmatched.length > 0) warnings.push(`${unmatched.length} books had no match here; their progress is skipped. Fix metadata (ASIN/ISBN/title) and re-run to catch more.`)
  if (fuzzy.length > 0) warnings.push(`${fuzzy.length} books matched by title + author (fuzzy) - review them below.`)

  const report = {
    reportId: crypto.randomUUID(),
    engineVersion: IMPORT_ENGINE_VERSION,
    mode,
    createdAt: Date.now(),
    source: { serverId: source.serverId, serverName: source.serverName, kind: source.kind },
    sameServer,
    users: userMatches,
    items: {
      matched: matched.length,
      fuzzy: fuzzy.length,
      unmatched: unmatched.slice(0, 500), // cap the persisted list
      podcastSkipped,
    },
    perUser,
    domains,
    warnings,
  }

  await db.execute({
    sql: `INSERT INTO import_reports (id, server_id, mode, source_kind, status, report_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'dry-run', ?, ?, ?)`,
    args: [report.reportId, serverId, mode, source.kind, JSON.stringify(report), report.createdAt, report.createdAt],
  })

  // Stash the source inventory so execute can apply it without a re-upload.
  await stashSource(report.reportId, source)

  return report
}

// Fetch a persisted report by id (for the execute path + the UI).
export async function getImportReport(reportId) {
  const serverId = await getServerId()
  const r = await db.execute({
    sql: `SELECT report_json, status, result_json FROM import_reports WHERE id = ? AND server_id = ?`,
    args: [reportId, serverId],
  })
  const row = r.rows[0]
  if (!row) return null
  let report = null
  let result = null
  try {
    report = JSON.parse(String(row.report_json))
  } catch {
    report = null
  }
  if (row.result_json) {
    try {
      result = JSON.parse(String(row.result_json))
    } catch {
      result = null
    }
  }
  return { report, status: String(row.status), result }
}

// Recent reports for the UI list.
export async function listImportReports(limit = 20) {
  const serverId = await getServerId()
  const r = await db.execute({
    sql: `SELECT id, mode, source_kind, status, created_at, updated_at FROM import_reports
          WHERE server_id = ? ORDER BY created_at DESC LIMIT ?`,
    args: [serverId, limit],
  })
  return r.rows.map((row) => ({
    id: String(row.id),
    mode: String(row.mode),
    sourceKind: String(row.source_kind),
    status: String(row.status),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }))
}
