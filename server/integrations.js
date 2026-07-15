// Integrations config: the external services HearthShelf can talk to.
//   - ReadMeABook (RMAB): acquisition backend (url + login token)
//   - Audplexus: library-sync diagnostics (url + key)
//   - Audible: catalog search region
//
// Precedence: ENV OVERRIDES DB, per field. For each field, if its environment
// variable is set, that value is used and the field is locked (the admin UI
// shows it as environment-managed and read-only). If the env var is unset, the
// editable database value is used. This lets a deployment pin specific values
// via env while leaving everything else configurable in the UI.
//
// Secrets (rmabLoginToken, audplexusKey) are held server-side and never returned
// to the browser - publicIntegrations() reports only whether each is set.

import { db, initDb } from './db.js'

const VALID_REGIONS = ['us', 'ca', 'uk', 'au', 'in', 'de', 'es', 'fr']

function stripSlash(v) {
  return (v || '').replace(/\/$/, '')
}

function loginUrlParts(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null
  try {
    const parsed = new URL(value.trim())
    const marker = '/auth/token/login'
    const markerAt = parsed.pathname.indexOf(marker)
    const token = parsed.searchParams.get('token')?.trim()
    if (markerAt < 0 || !token) return null
    const basePath = parsed.pathname.slice(0, markerAt)
    return { token, baseUrl: stripSlash(`${parsed.origin}${basePath}`) }
  } catch {
    return null
  }
}

export function normalizeIntegrationsPatch(input) {
  const patch = { ...input }
  const parts = loginUrlParts(patch.rmabLoginToken)
  if (parts) {
    patch.rmabLoginToken = parts.token
    if (!patch.rmabUrl) patch.rmabUrl = parts.baseUrl
  }
  return patch
}

// An env var counts as "set" only when present and non-empty - an empty string
// in the environment is treated as unset so it doesn't accidentally lock a field
// to a blank value.
function envVal(name) {
  const v = process.env[name]
  return v != null && v !== '' ? v : null
}

// Which fields are pinned by the environment, and to what. The presence of a key
// here means "env-locked"; the value is the effective value for that field.
function envOverrides() {
  const out = {}
  const rmabUrl = envVal('RMAB_URL')
  if (rmabUrl != null) out.rmabUrl = stripSlash(rmabUrl) || null
  const rmabLoginToken = envVal('RMAB_LOGIN_TOKEN')
  if (rmabLoginToken != null) out.rmabLoginToken = rmabLoginToken
  const audplexusUrl = envVal('AUDPLEXUS_URL')
  if (audplexusUrl != null) out.audplexusUrl = stripSlash(audplexusUrl) || null
  const audplexusKey = envVal('AUDPLEXUS_KEY')
  if (audplexusKey != null) out.audplexusKey = audplexusKey
  const region = envVal('AUDIBLE_REGION')
  if (region != null) {
    const r = region.toLowerCase()
    out.audibleRegion = VALID_REGIONS.includes(r) ? r : 'us'
  }
  return out
}

let ready = null
async function ensureRow() {
  if (ready) return ready
  ready = (async () => {
    await initDb()
    const r = await db.execute('SELECT id FROM integrations_config WHERE id = 1')
    if (r.rows.length === 0) {
      // Empty editable defaults; env (if any) overrides at read time.
      await db.execute({
        sql: `INSERT INTO integrations_config
                (id, rmab_url, rmab_login_token, audplexus_url, audplexus_key, audible_region, updated_at)
              VALUES (1, NULL, NULL, NULL, NULL, ?, ?)`,
        args: ['us', Date.now()],
      })
    }
  })()
  return ready
}

// The editable (database) layer only - no env overlay. Used by setIntegrations
// so a write never clobbers a field that env is currently pinning anyway, and so
// the UI can show the stored value behind an env lock.
async function getStored() {
  await ensureRow()
  const r = await db.execute('SELECT * FROM integrations_config WHERE id = 1')
  const row = r.rows[0] ?? {}
  const region = (row.audible_region ?? 'us').toLowerCase()
  return {
    rmabUrl: row.rmab_url ?? null,
    rmabLoginToken: row.rmab_login_token ?? null,
    audplexusUrl: row.audplexus_url ?? null,
    audplexusKey: row.audplexus_key ?? null,
    audibleRegion: VALID_REGIONS.includes(region) ? region : 'us',
  }
}

// The effective config the rest of the server runs on: env overrides layered on
// top of the stored values. Includes the secrets - server-internal use only.
export async function getIntegrations() {
  const stored = await getStored()
  return { ...stored, ...envOverrides() }
}

function applyStoredPatch(stored, patch, env) {
  const next = { ...stored }
  const editable = (field) => field in patch && !(field in env)

  if (editable('rmabUrl')) next.rmabUrl = stripSlash(patch.rmabUrl || '') || null
  if (editable('audplexusUrl')) next.audplexusUrl = stripSlash(patch.audplexusUrl || '') || null
  if (editable('audibleRegion')) {
    const region = (patch.audibleRegion || '').toLowerCase()
    next.audibleRegion = VALID_REGIONS.includes(region) ? region : next.audibleRegion
  }
  if (editable('rmabLoginToken')) {
    if (patch.rmabLoginToken === null) next.rmabLoginToken = null
    else if (typeof patch.rmabLoginToken === 'string' && patch.rmabLoginToken !== '') {
      next.rmabLoginToken = patch.rmabLoginToken
    }
  }
  if (editable('audplexusKey')) {
    if (patch.audplexusKey === null) next.audplexusKey = null
    else if (typeof patch.audplexusKey === 'string' && patch.audplexusKey !== '') {
      next.audplexusKey = patch.audplexusKey
    }
  }
  return next
}

// Preview the effective configuration without writing it. Used to validate a
// ReadMeABook URL/token pair before an invalid value replaces the working one.
export async function previewIntegrations(patch) {
  await ensureRow()
  const env = envOverrides()
  const next = applyStoredPatch(await getStored(), patch, env)
  return { ...next, ...env }
}

// Apply a partial admin update to the DATABASE layer. Fields currently pinned by
// env are ignored (they can't be edited from the UI). Secret fields are only
// overwritten when a non-empty string is supplied (so a masked placeholder keeps
// the stored secret); an explicit null clears the stored secret.
export async function setIntegrations(patch) {
  await ensureRow()
  const env = envOverrides()
  const next = applyStoredPatch(await getStored(), patch, env)
  await db.execute({
    sql: `UPDATE integrations_config
          SET rmab_url = ?, rmab_login_token = ?, audplexus_url = ?, audplexus_key = ?,
              audible_region = ?, updated_at = ?
          WHERE id = 1`,
    args: [
      next.rmabUrl,
      next.rmabLoginToken,
      next.audplexusUrl,
      next.audplexusKey,
      next.audibleRegion,
      Date.now(),
    ],
  })
  return publicIntegrations()
}

// Public view for the admin UI - never leaks secrets, just whether each is set.
// `env` lists which fields are pinned by the environment so the UI can lock them
// and label them "managed by environment". The shown url/region values are the
// effective (env-overridden) ones; secret fields only report presence.
export async function publicIntegrations() {
  const env = envOverrides()
  const c = await getIntegrations()
  return {
    rmabUrl: c.rmabUrl,
    rmabConfigured: Boolean(c.rmabUrl && c.rmabLoginToken),
    rmabHasToken: Boolean(c.rmabLoginToken),
    audplexusUrl: c.audplexusUrl,
    audplexusConfigured: Boolean(c.audplexusUrl && c.audplexusKey),
    audplexusHasKey: Boolean(c.audplexusKey),
    audibleRegion: c.audibleRegion,
    validRegions: VALID_REGIONS,
    // Per-field env locks (true = environment-managed, read-only in the UI).
    env: {
      rmabUrl: 'rmabUrl' in env,
      rmabLoginToken: 'rmabLoginToken' in env,
      audplexusUrl: 'audplexusUrl' in env,
      audplexusKey: 'audplexusKey' in env,
      audibleRegion: 'audibleRegion' in env,
    },
  }
}

export { VALID_REGIONS }
