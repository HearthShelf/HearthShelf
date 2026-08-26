// QuestGiver routes: public config, admin AI config, recommend, run history,
// health. Mounted under /hs/questgiver/* (config + recommend + runs) plus the
// admin sub-path. Each handler returns true once it has written a response.

import { json, readBody } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import {
  complete,
  getCopilotAuthStatus,
  isProviderConfigured,
  listModels,
  providerInfo,
  resetCopilotRuntime,
} from '../providers.js'
import { check, consume } from '../ratelimit.js'
import { clearApiKey, getConfig, setConfig, publicConfig } from '../config.js'
import { getCopilotLogin, markCopilotConnected, startCopilotLogin } from '../copilotAuth.js'
import * as store from '../store.js'

// Extract the first {...} block and validate the QuestGiver result shape.
export function parseResult(text) {
  const m = text && text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('no json in model output')
  const o = JSON.parse(m[0])
  if (!o || !Array.isArray(o.picks)) throw new Error('bad result shape')
  return {
    intro: typeof o.intro === 'string' ? o.intro : '',
    picks: o.picks,
    newPicks: Array.isArray(o.newPicks) ? o.newPicks : [],
  }
}

const ASSESSMENT_VERDICTS = new Set(['strong', 'good', 'mixed', 'unlikely', 'unknown'])
const ASSESSMENT_CONFIDENCE = new Set(['high', 'medium', 'low'])

export function parseAssessment(text) {
  const m = text && text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('no json in model output')
  const o = JSON.parse(m[0])
  if (
    !o ||
    !ASSESSMENT_VERDICTS.has(o.verdict) ||
    !ASSESSMENT_CONFIDENCE.has(o.confidence) ||
    typeof o.summary !== 'string' ||
    !Array.isArray(o.reasons)
  ) {
    throw new Error('bad assessment shape')
  }
  return {
    verdict: o.verdict,
    confidence: o.confidence,
    summary: o.summary.slice(0, 300),
    reasons: o.reasons.filter((reason) => typeof reason === 'string').slice(0, 3),
    caution: typeof o.caution === 'string' ? o.caution.slice(0, 300) : null,
  }
}

export async function handleQuestGiver(req, res, url, ctx) {
  const p = url.pathname

  if (req.method === 'GET' && p === '/hs/questgiver/config') {
    const cfg = await getConfig()
    const info = await providerInfo()
    const rate = ctx
      ? await check(ctx.serverId, ctx.userId, cfg.limit)
      : { limit: null, remaining: null, period: null }
    json(res, 200, {
      featureEnabled: cfg.enabled,
      discoverEnabled: cfg.discoverEnabled,
      enabled: info.configured,
      provider: info.provider,
      model: info.model,
      limit: rate.limit,
      remaining: rate.remaining,
      period: rate.period,
    })
    return true
  }

  // Admin: connect the server to the admin's Copilot subscription using the
  // device-code flow owned by the official GitHub Copilot CLI. The browser sees
  // only the short user code; the OAuth token stays in the CLI credential store.
  if (p === '/hs/questgiver/admin/copilot') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    if (req.method === 'GET') {
      const login = getCopilotLogin()
      const auth =
        login.state === 'starting' || login.state === 'waiting' || login.state === 'finishing'
          ? { authenticated: false, login: null, host: null, authType: null }
          : await getCopilotAuthStatus({ force: login.state === 'connected' })
      return (json(res, 200, { ...auth, flow: login }), true)
    }
    if (req.method === 'POST') {
      const cfg = await publicConfig()
      if (cfg.env.apiKey) {
        return (json(res, 409, { error: 'copilot_auth_managed_by_environment' }), true)
      }
      if (cfg.env.provider && cfg.provider !== 'copilot') {
        return (json(res, 409, { error: 'copilot_provider_managed_by_environment' }), true)
      }
      const existing = await getCopilotAuthStatus()
      if (existing.authenticated) {
        await clearApiKey()
        await setConfig({ provider: 'copilot', model: 'auto' })
        return (json(res, 200, { ...existing, flow: { state: 'connected' } }), true)
      }
      const flow = await startCopilotLogin({
        onConnected: async () => {
          await resetCopilotRuntime()
          await clearApiKey()
          await setConfig({ provider: 'copilot', model: 'auto' })
          await markCopilotConnected()
        },
      })
      const status = flow.state === 'failed' ? 502 : 200
      return (json(res, status, { authenticated: false, flow }), true)
    }
    return (json(res, 405, { error: 'method_not_allowed' }), true)
  }

  // Admin: read / edit the AI config (provider, model, key, limit).
  if (p === '/hs/questgiver/admin/config') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    if (req.method === 'GET') return (json(res, 200, await publicConfig()), true)
    if (req.method === 'PUT') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return (json(res, 400, { error: 'invalid_body' }), true)
      }
      await setConfig(body ?? {})
      return (json(res, 200, await publicConfig()), true)
    }
    return (json(res, 405, { error: 'method_not_allowed' }), true)
  }

  // Admin: discover models using either the saved provider config or an
  // unpersisted draft from the setup form. Draft credentials are used for this
  // request only and are never returned in the response.
  if (req.method === 'POST' && p === '/hs/questgiver/admin/models') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)
    let body
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)) || '{}')
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    if (
      body == null ||
      typeof body !== 'object' ||
      (body.provider != null && typeof body.provider !== 'string') ||
      (body.baseUrl != null && typeof body.baseUrl !== 'string') ||
      (body.apiKey != null && typeof body.apiKey !== 'string') ||
      String(body.provider ?? '').length > 50 ||
      String(body.baseUrl ?? '').length > 2048 ||
      String(body.apiKey ?? '').length > 4096
    ) {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    try {
      return (json(res, 200, { models: await listModels(body) }), true)
    } catch (err) {
      return (
        json(res, 502, { error: 'model_list_error', detail: String(err).slice(0, 200) }),
        true
      )
    }
  }

  if (req.method === 'POST' && p === '/hs/questgiver/recommend') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    const cfg = await getConfig()
    if (!cfg.enabled) return (json(res, 403, { error: 'feature_disabled' }), true)
    if (!(await isProviderConfigured())) return (json(res, 503, { error: 'ai_unavailable' }), true)

    const rate = await check(ctx.serverId, ctx.userId, cfg.limit)
    if (!rate.allowed) {
      json(res, 429, {
        error: 'rate_limited',
        limit: rate.limit,
        remaining: 0,
        period: rate.period,
      })
      return true
    }

    let prompt
    try {
      const body = JSON.parse(await readBody(req))
      prompt = body?.prompt
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    if (typeof prompt !== 'string' || prompt.length < 10) {
      return (json(res, 400, { error: 'invalid_prompt' }), true)
    }

    try {
      const text = await complete(prompt)
      const result = parseResult(text)
      const after = await consume(ctx.serverId, ctx.userId, cfg.limit)
      json(res, 200, { ...result, engine: 'ai', remaining: after.remaining, limit: after.limit })
    } catch (err) {
      json(res, 502, { error: 'ai_error', detail: String(err).slice(0, 200) })
    }
    return true
  }

  if (req.method === 'POST' && p === '/hs/questgiver/assess') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    const cfg = await getConfig()
    if (!cfg.enabled) return (json(res, 403, { error: 'feature_disabled' }), true)
    if (!(await isProviderConfigured())) return (json(res, 503, { error: 'ai_unavailable' }), true)

    const rate = await check(ctx.serverId, ctx.userId, cfg.limit)
    if (!rate.allowed) {
      return (
        json(res, 429, {
          error: 'rate_limited',
          limit: rate.limit,
          remaining: 0,
          period: rate.period,
        }),
        true
      )
    }

    let prompt
    try {
      const body = JSON.parse(await readBody(req))
      prompt = body?.prompt
    } catch {
      return (json(res, 400, { error: 'invalid_body' }), true)
    }
    if (typeof prompt !== 'string' || prompt.length < 10 || prompt.length > 12_000) {
      return (json(res, 400, { error: 'invalid_prompt' }), true)
    }

    try {
      const result = parseAssessment(await complete(prompt))
      const after = await consume(ctx.serverId, ctx.userId, cfg.limit)
      return (json(res, 200, { ...result, remaining: after.remaining, limit: after.limit }), true)
    } catch (err) {
      return (json(res, 502, { error: 'ai_error', detail: String(err).slice(0, 200) }), true)
    }
  }

  if (req.method === 'GET' && p === '/hs/questgiver/health') {
    return (json(res, 200, { ok: true }), true)
  }

  // QuestGiver run history (per user, synced across devices).
  if (p === '/hs/questgiver/runs') {
    if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
    if (req.method === 'GET') {
      return (json(res, 200, { runs: await store.getRuns(ctx.serverId, ctx.userId) }), true)
    }
    if (req.method === 'POST') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return (json(res, 400, { error: 'invalid_body' }), true)
      }
      if (!body?.run || typeof body.run !== 'object') {
        return (json(res, 400, { error: 'invalid_run' }), true)
      }
      return (
        json(res, 200, { runs: await store.addRun(ctx.serverId, ctx.userId, body.run) }),
        true
      )
    }
    return (json(res, 405, { error: 'method_not_allowed' }), true)
  }

  return false
}
