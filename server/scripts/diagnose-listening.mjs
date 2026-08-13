/**
 * Diagnose why a profile shows "Nothing playing" despite recorded listening.
 *
 * Read-only. Run on the box (or anywhere HS_ABS_DB_PATH points at a copy of
 * ABS's absdatabase.sqlite):
 *
 *   node server/scripts/diagnose-listening.mjs <userId>
 *
 * Prints what getUserCurrentListen depends on, one layer at a time, so we can
 * see exactly which one is empty rather than guessing.
 */
import { createClient } from '@libsql/client'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const DB = process.env.HS_ABS_DB_PATH || '/config/absdatabase.sqlite'
const userId = process.argv[2]

if (!userId) {
  console.error('usage: node diagnose-listening.mjs <userId>')
  process.exit(1)
}
if (!fs.existsSync(DB)) {
  console.error(`ABS db not found at ${DB} (set HS_ABS_DB_PATH)`)
  process.exit(1)
}

const c = createClient({ url: pathToFileURL(DB).toString() })
await c.execute('PRAGMA query_only = ON')

const show = (label, value) => console.log(`${label.padEnd(52)} ${value}`)

async function one(sql, args = []) {
  try {
    const r = await c.execute({ sql, args })
    return r.rows[0] ?? null
  } catch (e) {
    return { __error: e.message }
  }
}

console.log(`\n=== playbackSessions for user ${userId} ===`)
const total = await one(`SELECT COUNT(*) AS n FROM playbackSessions WHERE userId = ?`, [userId])
show('total sessions (any type)', total?.n ?? total?.__error)

const byType = await c.execute({
  sql: `SELECT mediaItemType, COUNT(*) AS n FROM playbackSessions WHERE userId = ? GROUP BY mediaItemType`,
  args: [userId],
})
for (const r of byType.rows) show(`  mediaItemType='${r.mediaItemType}'`, r.n)

const bookN = await one(
  `SELECT COUNT(*) AS n FROM playbackSessions WHERE userId = ? AND mediaItemType = 'book'`,
  [userId],
)
show("book sessions", bookN?.n ?? bookN?.__error)

console.log(`\n=== updatedAt (drives ordering + isLive) ===`)
const upd = await one(
  `SELECT updatedAt, typeof(updatedAt) AS t FROM playbackSessions
   WHERE userId = ? AND mediaItemType = 'book' AND updatedAt IS NOT NULL
   ORDER BY updatedAt DESC LIMIT 1`,
  [userId],
)
show('sample updatedAt', upd ? `${JSON.stringify(upd.updatedAt)} (${upd.t})` : 'NONE')
if (upd?.updatedAt != null) {
  const ok = /^\d{4}-\d{2}-\d{2}([T ])\d{2}:\d{2}:\d{2}/.test(String(upd.updatedAt))
  show('  matches probeListenFormat regex?', ok ? 'yes' : 'NO  <-- isLive degrades')
}
const nullUpd = await one(
  `SELECT COUNT(*) AS n FROM playbackSessions
   WHERE userId = ? AND mediaItemType = 'book' AND updatedAt IS NULL`,
  [userId],
)
show('book sessions with NULL updatedAt', nullUpd?.n)

console.log(`\n=== extraData (branch 1: direct libraryItemId) ===`)
const invalid = await one(
  `SELECT COUNT(*) AS n FROM playbackSessions
   WHERE userId = ? AND mediaItemType = 'book' AND NOT json_valid(extraData)`,
  [userId],
)
show('rows with INVALID json extraData', invalid?.n ?? invalid?.__error)
const withId = await one(
  `SELECT COUNT(*) AS n FROM playbackSessions
   WHERE userId = ? AND mediaItemType = 'book'
     AND json_valid(extraData)
     AND json_extract(extraData, '$.libraryItemId') IS NOT NULL`,
  [userId],
)
show('rows WITH extraData.libraryItemId', withId?.n ?? withId?.__error)
const sampleExtra = await one(
  `SELECT substr(extraData, 1, 160) AS e FROM playbackSessions
   WHERE userId = ? AND mediaItemType = 'book' ORDER BY updatedAt DESC LIMIT 1`,
  [userId],
)
show('newest extraData (truncated)', JSON.stringify(sampleExtra?.e ?? null))

console.log(`\n=== mediaItemId hop (branch 2) ===`)
const mid = await one(
  `SELECT mediaItemId FROM playbackSessions
   WHERE userId = ? AND mediaItemType = 'book' ORDER BY updatedAt DESC LIMIT 1`,
  [userId],
)
show('newest session mediaItemId', JSON.stringify(mid?.mediaItemId ?? null))
if (mid?.mediaItemId) {
  const hop = await one(
    `SELECT id FROM libraryItems WHERE mediaId = ? AND mediaType = 'book' LIMIT 1`,
    [mid.mediaItemId],
  )
  show('  resolves via libraryItems.mediaId?', hop?.id ? `yes -> ${hop.id}` : 'NO  <-- hop fails')
  const asItem = await one(`SELECT id FROM libraryItems WHERE id = ? LIMIT 1`, [mid.mediaItemId])
  show('  is it already a libraryItems.id?', asItem?.id ? `YES -> ${asItem.id}` : 'no')
}
const hopN = await one(
  `SELECT COUNT(*) AS n
   FROM playbackSessions ps
   JOIN libraryItems li ON li.mediaId = ps.mediaItemId AND li.mediaType = 'book'
   WHERE ps.userId = ? AND ps.mediaItemType = 'book'`,
  [userId],
)
show('book sessions resolvable via the hop', hopN?.n ?? hopN?.__error)

console.log(`\n=== the actual getUserCurrentListen query ===`)
const real = await one(
  `SELECT libraryItemId, updatedAt FROM (
     SELECT json_extract(ps.extraData, '$.libraryItemId') AS libraryItemId, ps.updatedAt AS updatedAt
     FROM playbackSessions ps
     WHERE ps.userId = ? AND ps.mediaItemType = 'book'
       AND json_valid(ps.extraData)
       AND json_extract(ps.extraData, '$.libraryItemId') IS NOT NULL
     UNION ALL
     SELECT li.id AS libraryItemId, ps.updatedAt AS updatedAt
     FROM playbackSessions ps
     JOIN libraryItems li ON li.mediaId = ps.mediaItemId AND li.mediaType = 'book'
     WHERE ps.userId = ? AND ps.mediaItemType = 'book'
       AND (NOT json_valid(ps.extraData) OR json_extract(ps.extraData, '$.libraryItemId') IS NULL)
   )
   WHERE libraryItemId IS NOT NULL
   ORDER BY updatedAt DESC
   LIMIT 1`,
  [userId, userId],
)
if (real?.__error) show('RESULT', `THREW: ${real.__error}`)
else show('RESULT', real ? `${real.libraryItemId} @ ${real.updatedAt}` : '*** NULL (this is the bug) ***')

if (real?.libraryItemId) {
  const meta = await one(
    `SELECT b.title AS title FROM libraryItems li JOIN books b ON b.id = li.mediaId
     WHERE li.id = ? AND li.mediaType = 'book' LIMIT 1`,
    [real.libraryItemId],
  )
  show('  title', meta?.title ?? '(item row missing)')
}

console.log()
