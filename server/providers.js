// AI provider adapters for QuestGiver. Each takes a prompt and returns raw model
// text; the caller extracts the JSON. The provider, model, key, and base URL
// come from the editable AI config (see config.js); the key never leaves the
// server.

import { getConfig } from './config.js'
import { COPILOT_HOME, hasCopilotConnection } from './copilotAuth.js'

const TIMEOUT_MS = 30000
const MAX_MODELS = 1000

async function withTimeout(promise) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await promise(ctrl.signal)
  } finally {
    clearTimeout(t)
  }
}

function cleanBaseUrl(value, fallback) {
  return (value || fallback).replace(/\/+$/, '')
}

// OpenAI / OpenAI-compatible (OpenRouter, Ollama, LM Studio, etc.)
async function callOpenAI({ baseUrl, model, key }, prompt) {
  const url = `${cleanBaseUrl(baseUrl, 'https://api.openai.com/v1')}/chat/completions`
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return data.choices?.[0]?.message?.content ?? ''
  })
}

// Anthropic Claude
async function callAnthropic({ baseUrl, model, key }, prompt) {
  const url = `${cleanBaseUrl(baseUrl, 'https://api.anthropic.com')}/v1/messages`
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return data.content?.[0]?.text ?? ''
  })
}

// Google Gemini
async function callGemini({ baseUrl, model, key }, prompt) {
  const m = model || 'gemini-1.5-flash'
  const base = cleanBaseUrl(baseUrl, 'https://generativelanguage.googleapis.com')
  const url = `${base}/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    })
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  })
}

// GitHub Copilot is not an OpenAI-compatible HTTP endpoint. Its supported SDK
// owns a small local runtime process and bills requests to the GitHub account
// represented by the supplied user token. Keep one runtime warm for the active
// token, but create a fresh, tool-free session for every QuestGiver request so
// prompts and conversation state never cross users or features.
let copilotState = null
let copilotAuthCache = null

async function copilotClient(key = null) {
  const credential = key ? `token:${key}` : 'logged-in-user'
  if (copilotState?.credential === credential) return copilotState.ready

  if (copilotState) {
    try {
      const old = await copilotState.ready
      await old.stop()
    } catch {
      // A failed/stale runtime should not prevent a new credential from trying.
    }
  }

  const { CopilotClient } = await import('@github/copilot-sdk')
  const client = new CopilotClient({
    ...(key ? { gitHubToken: key, useLoggedInUser: false } : { useLoggedInUser: true }),
    mode: 'empty',
    baseDirectory: COPILOT_HOME,
    logLevel: 'error',
    // Do not silently adopt a generic GitHub token from the server process.
    // Admins can still pin QG_API_KEY, which is passed explicitly above.
    env: {
      COPILOT_GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_CONFIG_DIR: `${COPILOT_HOME}/gh-cli`,
    },
  })
  const state = {
    credential,
    client,
    ready: client.start().then(() => client),
  }
  copilotState = state
  try {
    return await state.ready
  } catch (err) {
    if (copilotState === state) copilotState = null
    throw err
  }
}

export async function resetCopilotRuntime() {
  const current = copilotState
  copilotState = null
  copilotAuthCache = null
  if (!current) return
  try {
    const client = await current.ready
    await client.stop()
  } catch {
    // Reset is best-effort; the next request starts a fresh runtime.
  }
}

export async function getCopilotAuthStatus({ force = false } = {}) {
  // The runtime can discover a developer's ambient `gh`/Copilot login on a
  // desktop. Only trust logged-in-user auth after an admin has completed
  // HearthShelf's own connection flow in this QG_DATA_DIR.
  if (!(await hasCopilotConnection())) {
    return { authenticated: false, login: null, host: null, authType: null }
  }
  if (!force && copilotAuthCache && Date.now() - copilotAuthCache.at < 5000) {
    return copilotAuthCache.value
  }
  try {
    const client = await copilotClient()
    const status = await client.getAuthStatus()
    const value = {
      authenticated: status.isAuthenticated === true,
      login: status.login || null,
      host: status.host || null,
      authType: status.authType || null,
    }
    copilotAuthCache = { at: Date.now(), value }
    return value
  } catch {
    const value = { authenticated: false, login: null, host: null, authType: null }
    copilotAuthCache = { at: Date.now(), value }
    return value
  }
}

async function callCopilot({ model, key }, prompt) {
  const client = await copilotClient(key)
  const session = await client.createSession({
    model: model || 'auto',
    availableTools: [],
    enableSessionStore: false,
  })
  try {
    const response = await session.sendAndWait({ prompt }, TIMEOUT_MS)
    return response?.data?.content ?? ''
  } catch (err) {
    try {
      await session.abort()
    } catch {
      // Preserve the provider error; abort is only cleanup.
    }
    throw err
  } finally {
    try {
      await session.disconnect()
      await client.deleteSession(session.sessionId)
    } catch {
      // The response/error is more useful than a disposable-session cleanup error.
    }
  }
}

function model(id, name = id) {
  return { id, name: name || id }
}

async function listOpenAIModels({ baseUrl, key }) {
  const url = `${cleanBaseUrl(baseUrl, 'https://api.openai.com/v1')}/models`
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      signal,
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) throw new Error(`OpenAI models ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return (Array.isArray(data.data) ? data.data : [])
      .filter((item) => typeof item?.id === 'string')
      .map((item) => model(item.id))
  })
}

async function listAnthropicModels({ baseUrl, key }) {
  const url = `${cleanBaseUrl(baseUrl, 'https://api.anthropic.com')}/v1/models?limit=1000`
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    })
    if (!res.ok) throw new Error(`Anthropic models ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return (Array.isArray(data.data) ? data.data : [])
      .filter((item) => typeof item?.id === 'string')
      .map((item) => model(item.id, item.display_name))
  })
}

async function listGeminiModels({ baseUrl, key }) {
  const base = cleanBaseUrl(baseUrl, 'https://generativelanguage.googleapis.com')
  const url = `${base}/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`
  return withTimeout(async (signal) => {
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`Gemini models ${res.status}: ${await res.text()}`)
    const data = await res.json()
    return (Array.isArray(data.models) ? data.models : [])
      .filter(
        (item) =>
          typeof item?.name === 'string' &&
          Array.isArray(item.supportedGenerationMethods) &&
          item.supportedGenerationMethods.includes('generateContent'),
      )
      .map((item) => model(item.name.replace(/^models\//, ''), item.displayName))
  })
}

async function listCopilotModels({ key }) {
  const client = await copilotClient(key)
  const models = await client.listModels()
  const available = models
    .filter((item) => !item.policy || item.policy.state === 'enabled')
    .map((item) => model(item.id, item.name))
  if (!available.some((item) => item.id === 'auto')) available.unshift(model('auto', 'Automatic'))
  return available
}

const ADAPTERS = {
  openai: callOpenAI,
  anthropic: callAnthropic,
  gemini: callGemini,
  copilot: callCopilot,
}

const MODEL_LISTERS = {
  openai: listOpenAIModels,
  anthropic: listAnthropicModels,
  gemini: listGeminiModels,
  copilot: listCopilotModels,
}

// List models for either the saved config or a draft from the admin form. A
// draft provider never inherits a key saved for a different provider; that
// would accidentally send one vendor's credential to another vendor.
export async function listModels(overrides = {}) {
  const saved = await getConfig()
  const provider = String(overrides.provider ?? saved.provider ?? '').toLowerCase()
  const providerChanged = provider !== String(saved.provider ?? '').toLowerCase()
  const suppliedKey = typeof overrides.apiKey === 'string' ? overrides.apiKey.trim() : ''
  const key = suppliedKey || (providerChanged ? null : saved.apiKey)
  const baseUrl =
    typeof overrides.baseUrl === 'string'
      ? overrides.baseUrl.trim() || null
      : providerChanged
        ? null
        : saved.baseUrl
  const list = MODEL_LISTERS[provider]
  if (!list) throw new Error(`Unknown or unset AI provider: "${provider}"`)
  if (!key) {
    if (provider !== 'copilot' || !(await getCopilotAuthStatus()).authenticated) {
      throw new Error('AI credential is not set')
    }
  }

  const items = await list({ baseUrl, key })
  const unique = new Map()
  for (const item of items) {
    if (typeof item?.id !== 'string' || !item.id.trim()) continue
    const id = item.id.trim().slice(0, 200)
    unique.set(id, model(id, String(item.name || id).slice(0, 200)))
    if (unique.size >= MAX_MODELS) break
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function isProviderConfigured() {
  const c = await getConfig()
  const provider = (c.provider || '').toLowerCase()
  if (!c.enabled || !ADAPTERS[provider]) return false
  if (provider === 'copilot') {
    return Boolean(c.apiKey || (await getCopilotAuthStatus()).authenticated)
  }
  return Boolean(c.apiKey)
}

export async function providerInfo() {
  const c = await getConfig()
  return {
    provider: (c.provider || '').toLowerCase() || null,
    model: c.model || null,
    configured: await isProviderConfigured(),
  }
}

// Call the configured provider. Throws if not configured or on any provider error.
export async function complete(prompt) {
  const c = await getConfig()
  const provider = (c.provider || '').toLowerCase()
  const adapter = ADAPTERS[provider]
  if (!adapter) throw new Error(`Unknown or unset AI provider: "${provider}"`)
  if (!c.apiKey) {
    if (provider !== 'copilot' || !(await getCopilotAuthStatus()).authenticated) {
      throw new Error('AI API key is not set')
    }
  }
  return adapter({ baseUrl: c.baseUrl, model: c.model, key: c.apiKey }, prompt)
}
