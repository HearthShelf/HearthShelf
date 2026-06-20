// AI provider adapters for QuestGiver. Each takes a prompt and returns raw model
// text; the caller extracts the JSON. The provider, model, key, and base URL
// come from the editable AI config (see config.js); the key never leaves the
// server.

import { getConfig } from './config.js'

const TIMEOUT_MS = 30000

async function withTimeout(promise) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await promise(ctrl.signal)
  } finally {
    clearTimeout(t)
  }
}

// OpenAI / OpenAI-compatible (OpenRouter, Ollama, LM Studio, etc.)
async function callOpenAI({ baseUrl, model, key }, prompt) {
  const url = `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`
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
  const url = `${baseUrl || 'https://api.anthropic.com'}/v1/messages`
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
  const base = baseUrl || 'https://generativelanguage.googleapis.com'
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

const ADAPTERS = {
  openai: callOpenAI,
  anthropic: callAnthropic,
  gemini: callGemini,
}

export async function isProviderConfigured() {
  const c = await getConfig()
  const provider = (c.provider || '').toLowerCase()
  return Boolean(c.enabled && ADAPTERS[provider] && c.apiKey)
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
  if (!c.apiKey) throw new Error('AI API key is not set')
  return adapter({ baseUrl: c.baseUrl, model: c.model, key: c.apiKey }, prompt)
}
