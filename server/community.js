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
  return !/^(0|false|off|no|optin|opt-in)$/i.test(process.env.COMMUNITY_DEFAULT_SHARE ?? 'on')
}

// Whether clubs may make AI recommendation calls ships OFF unless the env opts
// in. AI calls cost money, so this is a deliberate admin choice.
function envClubsAi() {
  return /^(1|true|on|yes)$/i.test(process.env.CLUBS_AI_DEFAULT ?? 'off')
}

let ready = null
async function ensureSeeded() {
  if (ready) return ready
  ready = (async () => {
    await initDb()
    const r = await db.execute('SELECT id FROM community_config WHERE id = 1')
    if (r.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO community_config (id, default_share, clubs_ai_enabled, updated_at) VALUES (1, ?, ?, ?)`,
        args: [envDefaultShare() ? 1 : 0, envClubsAi() ? 1 : 0, Date.now()],
      })
    }
  })()
  return ready
}

// The community config:
//   defaultShare          - reading-list leaderboard default (opt-out, on)
//   defaultShareListening - listening-now presence default (off; presence is
//                           more sensitive than a historical reading list)
//   notesEnabled          - public-notes kill-switch (on)
//   clubsEnabled          - book-club kill-switch (on)
// The listening/notes/clubs columns are added by MIGRATIONS ALTERs (see db.js);
// on a database created before they existed the SELECT still returns them once
// the ALTER has run, and each read defaults defensively.
export async function getCommunityConfig() {
  await ensureSeeded()
  const r = await db.execute(
    'SELECT default_share, default_share_listening, notes_enabled, clubs_enabled, clubs_ai_enabled FROM community_config WHERE id = 1',
  )
  const row = r.rows[0] ?? {}
  return {
    defaultShare: row.default_share == null ? true : Boolean(row.default_share),
    // Presence default ships OFF, so a null column reads false.
    defaultShareListening: row.default_share_listening == null
      ? false
      : Boolean(row.default_share_listening),
    notesEnabled: row.notes_enabled == null ? true : Boolean(row.notes_enabled),
    clubsEnabled: row.clubs_enabled == null ? true : Boolean(row.clubs_enabled),
    // AI recommendations for clubs ship OFF, so a null column reads false.
    clubsAiEnabled: row.clubs_ai_enabled == null ? false : Boolean(row.clubs_ai_enabled),
  }
}

export async function setCommunityConfig(patch) {
  await ensureSeeded()
  const cur = await getCommunityConfig()
  const next = { ...cur }
  if ('defaultShare' in patch) next.defaultShare = Boolean(patch.defaultShare)
  if ('defaultShareListening' in patch) next.defaultShareListening = Boolean(patch.defaultShareListening)
  if ('notesEnabled' in patch) next.notesEnabled = Boolean(patch.notesEnabled)
  if ('clubsEnabled' in patch) next.clubsEnabled = Boolean(patch.clubsEnabled)
  if ('clubsAiEnabled' in patch) next.clubsAiEnabled = Boolean(patch.clubsAiEnabled)
  await db.execute({
    sql: `UPDATE community_config
          SET default_share = ?, default_share_listening = ?, notes_enabled = ?, clubs_enabled = ?, clubs_ai_enabled = ?, updated_at = ?
          WHERE id = 1`,
    args: [
      next.defaultShare ? 1 : 0,
      next.defaultShareListening ? 1 : 0,
      next.notesEnabled ? 1 : 0,
      next.clubsEnabled ? 1 : 0,
      next.clubsAiEnabled ? 1 : 0,
      Date.now(),
    ],
  })
  return next
}
