// AI / QuestGiver config, stored in the ai_config table (single row, id=1).
//
// Precedence: ENV OVERRIDES DB, per field. For each field, if its environment
// variable is set, that value is used and the field is locked (the admin UI
// shows it as environment-managed and read-only). If the env var is unset, the
// editable database value is used. This lets a deployment pin specific values
// via env while leaving everything else configurable in the UI.
//
// The api_key is held server-side and never returned to the browser -
// publicConfig() reports only whether one is set.

import { db, initDb } from './db.js'

const VALID_PROVIDERS = ['openai', 'anthropic', 'gemini', 'copilot']

// An env var counts as "set" only when present and non-empty.
function envVal(name) {
  const v = process.env[name]
  return v != null && v !== '' ? v : null
}

function isFalsey(v) {
  return /^(0|false|off|no)$/i.test(v)
}

// Which fields are pinned by the environment, and to what. The presence of a key
// here means "env-locked"; the value is the effective value for that field.
function envOverrides() {
  const out = {}
  const provider = envVal('QG_PROVIDER')
  if (provider != null) {
    const p = provider.toLowerCase()
    out.provider = VALID_PROVIDERS.includes(p) ? p : null
  }
  const model = envVal('QG_MODEL')
  if (model != null) out.model = model
  const apiKey = envVal('QG_API_KEY')
  if (apiKey != null) out.apiKey = apiKey
  const baseUrl = envVal('QG_BASE_URL')
  if (baseUrl != null) out.baseUrl = baseUrl
  const limit = envVal('QG_LIMIT')
  if (limit != null) out.limit = limit.trim() || 'off'
  const enabled = envVal('QG_ENABLED')
  if (enabled != null) out.enabled = !isFalsey(enabled)
  const discover = envVal('DISCOVER_ENABLED')
  if (discover != null) out.discoverEnabled = !isFalsey(discover)
  return out
}

let ready = null
async function ensureRow() {
  if (ready) return ready
  ready = (async () => {
    await initDb()
    const r = await db.execute('SELECT id FROM ai_config WHERE id = 1')
    if (r.rows.length === 0) {
      // Empty editable defaults; env (if any) overrides at read time.
      await db.execute({
        sql: `INSERT INTO ai_config (id, provider, model, api_key, base_url, ai_limit, enabled, discover_enabled, updated_at)
              VALUES (1, NULL, NULL, NULL, NULL, 'off', 1, 1, ?)`,
        args: [Date.now()],
      })
    }
  })()
  return ready
}

// The editable (database) layer only - no env overlay. Used by setConfig so a
// write never clobbers a field env is pinning anyway, and so the UI can show the
// stored value behind an env lock.
async function getStored() {
  await ensureRow()
  const r = await db.execute('SELECT * FROM ai_config WHERE id = 1')
  const row = r.rows[0] ?? {}
  return {
    provider: row.provider ?? null,
    model: row.model ?? null,
    apiKey: row.api_key ?? null,
    baseUrl: row.base_url ?? null,
    limit: row.ai_limit ?? 'off',
    enabled: row.enabled == null ? true : Boolean(row.enabled),
    discoverEnabled: row.discover_enabled == null ? true : Boolean(row.discover_enabled),
  }
}

// The effective config the rest of the server runs on: env overrides layered on
// top of the stored values. Includes the secret key - server-internal use only.
export async function getConfig() {
  const stored = await getStored()
  return { ...stored, ...envOverrides() }
}

// Apply a partial admin update to the DATABASE layer. Fields currently pinned by
// env are ignored (they can't be edited from the UI). The api_key is only
// overwritten when a non-empty string is supplied (so a masked placeholder keeps
// the stored key).
export async function setConfig(patch) {
  await ensureRow()
  const env = envOverrides()
  const next = await getStored()
  const editable = (field) => field in patch && !(field in env)

  let providerChanged = false
  if (editable('provider')) {
    const p = (patch.provider || '').toLowerCase()
    const provider = p && VALID_PROVIDERS.includes(p) ? p : null
    providerChanged = provider !== next.provider
    next.provider = provider
  }
  if (editable('model')) next.model = patch.model || null
  if (editable('baseUrl')) next.baseUrl = patch.baseUrl || null
  if (editable('limit')) next.limit = (patch.limit || 'off').trim() || 'off'
  if (editable('enabled')) next.enabled = Boolean(patch.enabled)
  if (editable('discoverEnabled')) next.discoverEnabled = Boolean(patch.discoverEnabled)
  const hasNewKey = editable('apiKey') && typeof patch.apiKey === 'string' && patch.apiKey !== ''
  if (providerChanged && !hasNewKey) next.apiKey = null
  if (hasNewKey) {
    next.apiKey = patch.apiKey
  }
  await db.execute({
    sql: `UPDATE ai_config
          SET provider = ?, model = ?, api_key = ?, base_url = ?, ai_limit = ?, enabled = ?,
              discover_enabled = ?, updated_at = ?
          WHERE id = 1`,
    args: [
      next.provider,
      next.model,
      next.apiKey,
      next.baseUrl,
      next.limit,
      next.enabled ? 1 : 0,
      next.discoverEnabled ? 1 : 0,
      Date.now(),
    ],
  })
  return publicConfig()
}

// Public view for the admin UI - never leaks the key, just whether one is set.
// `env` lists which fields are pinned by the environment so the UI can lock them
// and label them "managed by environment".
export async function publicConfig() {
  const env = envOverrides()
  const c = await getConfig()
  return {
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl,
    limit: c.limit,
    enabled: c.enabled,
    discoverEnabled: c.discoverEnabled,
    hasKey: Boolean(c.apiKey),
    validProviders: VALID_PROVIDERS,
    env: {
      provider: 'provider' in env,
      model: 'model' in env,
      apiKey: 'apiKey' in env,
      baseUrl: 'baseUrl' in env,
      limit: 'limit' in env,
      enabled: 'enabled' in env,
      discoverEnabled: 'discoverEnabled' in env,
    },
  }
}
