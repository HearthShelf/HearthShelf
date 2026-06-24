// Community (social) config, stored in the community_config table (single row,
// id=1). Instance-wide and admin-owned.
//
// Right now it holds one thing: the DEFAULT for whether a user appears on the
// server leaderboard. This default only governs users who have never set their
// own preference - a user who explicitly chose to share (or not) always keeps
// their own choice. Flipping the default is therefore retroactive for the
// "never chose" crowd but never overrides an explicit choice.
//
// Precedence: on first boot the row is seeded from COMMUNITY_DEFAULT_SHARE so a
// deployment can ship opt-in or opt-out out of the box; after that the admin
// edits it here and the DB value wins.

import { db, initDb } from './db.js'

// Default sharing is ON (opt-out) unless the env says otherwise.
function envDefaultShare() {
  return !/^(0|false|off|no|optin|opt-in)$/i.test(
    process.env.COMMUNITY_DEFAULT_SHARE ?? 'on'
  )
}

let ready = null
async function ensureSeeded() {
  if (ready) return ready
  ready = (async () => {
    await initDb()
    const r = await db.execute('SELECT id FROM community_config WHERE id = 1')
    if (r.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO community_config (id, default_share, updated_at) VALUES (1, ?, ?)`,
        args: [envDefaultShare() ? 1 : 0, Date.now()],
      })
    }
  })()
  return ready
}

// { defaultShare: boolean } - whether users who never chose appear by default.
export async function getCommunityConfig() {
  await ensureSeeded()
  const r = await db.execute('SELECT default_share FROM community_config WHERE id = 1')
  const row = r.rows[0] ?? {}
  return { defaultShare: row.default_share == null ? true : Boolean(row.default_share) }
}

export async function setCommunityConfig(patch) {
  await ensureSeeded()
  const cur = await getCommunityConfig()
  const next = { ...cur }
  if ('defaultShare' in patch) next.defaultShare = Boolean(patch.defaultShare)
  await db.execute({
    sql: `UPDATE community_config SET default_share = ?, updated_at = ? WHERE id = 1`,
    args: [next.defaultShare ? 1 : 0, Date.now()],
  })
  return next
}
