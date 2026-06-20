// Editable AI config, stored in the ai_config table (single row, id=1).
//
// Precedence: on first boot the row is seeded from the QG_* env vars, so
// existing deployments keep working with zero changes. After that the admin
// edits the row through /qg/admin/config and the DB value wins. To revert to
// env-managed config, clear the row (the next boot reseeds from env).

import { db, initDb } from './db.js'

const VALID_PROVIDERS = ['openai', 'anthropic', 'gemini']

function envSeed() {
  return {
    provider: (process.env.QG_PROVIDER || '').toLowerCase() || null,
    model: process.env.QG_MODEL || null,
    apiKey: process.env.QG_API_KEY || null,
    baseUrl: process.env.QG_BASE_URL || null,
    limit: (process.env.QG_LIMIT || 'off').trim() || 'off',
    enabled: !/^(0|false|off|no)$/i.test(process.env.QG_ENABLED ?? 'true'),
  }
}

let ready = null
async function ensureSeeded() {
  if (ready) return ready
  ready = (async () => {
    await initDb()
    const r = await db.execute('SELECT id FROM ai_config WHERE id = 1')
    if (r.rows.length === 0) {
      const s = envSeed()
      await db.execute({
        sql: `INSERT INTO ai_config (id, provider, model, api_key, base_url, ai_limit, enabled, updated_at)
              VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        args: [s.provider, s.model, s.apiKey, s.baseUrl, s.limit, s.enabled ? 1 : 0, Date.now()],
      })
    }
  })()
  return ready
}

// Full config including the secret key - server-internal use only.
export async function getConfig() {
  await ensureSeeded()
  const r = await db.execute('SELECT * FROM ai_config WHERE id = 1')
  const row = r.rows[0] ?? {}
  return {
    provider: row.provider ?? null,
    model: row.model ?? null,
    apiKey: row.api_key ?? null,
    baseUrl: row.base_url ?? null,
    limit: row.ai_limit ?? 'off',
    enabled: row.enabled == null ? true : Boolean(row.enabled),
  }
}

// Apply a partial admin update. The api_key is only overwritten when a
// non-empty string is supplied, so the UI can show a masked placeholder and
// leave the stored key untouched on save.
export async function setConfig(patch) {
  await ensureSeeded()
  const cur = await getConfig()
  const next = { ...cur }
  if ('provider' in patch) {
    const p = (patch.provider || '').toLowerCase()
    next.provider = p && VALID_PROVIDERS.includes(p) ? p : null
  }
  if ('model' in patch) next.model = patch.model || null
  if ('baseUrl' in patch) next.baseUrl = patch.baseUrl || null
  if ('limit' in patch) next.limit = (patch.limit || 'off').trim() || 'off'
  if ('enabled' in patch) next.enabled = Boolean(patch.enabled)
  if ('apiKey' in patch && typeof patch.apiKey === 'string' && patch.apiKey !== '') {
    next.apiKey = patch.apiKey
  }
  await db.execute({
    sql: `UPDATE ai_config
          SET provider = ?, model = ?, api_key = ?, base_url = ?, ai_limit = ?, enabled = ?, updated_at = ?
          WHERE id = 1`,
    args: [
      next.provider,
      next.model,
      next.apiKey,
      next.baseUrl,
      next.limit,
      next.enabled ? 1 : 0,
      Date.now(),
    ],
  })
  return next
}

// Public view for the admin UI - never leaks the key, just whether one is set.
export async function publicConfig() {
  const c = await getConfig()
  return {
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl,
    limit: c.limit,
    enabled: c.enabled,
    hasKey: Boolean(c.apiKey),
    validProviders: VALID_PROVIDERS,
  }
}
