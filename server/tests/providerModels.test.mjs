import test from 'node:test'
import assert from 'node:assert/strict'

// These tests exercise the public provider model-list seam without contacting
// vendors. Importing providers.js does not start Copilot; its SDK is lazy-loaded
// only when that provider is selected.
process.env.HS_DB_URL = 'file::memory:'
const { listModels } = await import('../providers.js')
const { publicConfig, setConfig } = await import('../config.js')

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('lists and sorts OpenAI-compatible models', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://models.example/v1/models')
    assert.equal(options.headers.Authorization, 'Bearer openai-test-key')
    return Response.json({ data: [{ id: 'z-model' }, { id: 'a-model' }] })
  }

  const models = await listModels({
    provider: 'openai',
    baseUrl: 'https://models.example/v1/',
    apiKey: 'openai-test-key',
  })
  assert.deepEqual(models, [
    { id: 'a-model', name: 'a-model' },
    { id: 'z-model', name: 'z-model' },
  ])
})

test('uses Anthropic display names', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/models?limit=1000')
    assert.equal(options.headers['x-api-key'], 'anthropic-test-key')
    return Response.json({
      data: [{ id: 'claude-example', display_name: 'Claude Example' }],
    })
  }

  const models = await listModels({ provider: 'anthropic', apiKey: 'anthropic-test-key' })
  assert.deepEqual(models, [{ id: 'claude-example', name: 'Claude Example' }])
})

test('keeps only Gemini models that support generateContent', async () => {
  globalThis.fetch = async (url) => {
    assert.equal(
      url,
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=gemini-test-key',
    )
    return Response.json({
      models: [
        {
          name: 'models/gemini-example',
          displayName: 'Gemini Example',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/text-embedding-example',
          displayName: 'Embedding Example',
          supportedGenerationMethods: ['embedContent'],
        },
      ],
    })
  }

  const models = await listModels({ provider: 'gemini', apiKey: 'gemini-test-key' })
  assert.deepEqual(models, [{ id: 'gemini-example', name: 'Gemini Example' }])
})

test('does not reuse a saved credential after changing providers', async () => {
  await setConfig({ provider: 'openai', apiKey: 'openai-secret' })

  await assert.rejects(() => listModels({ provider: 'copilot' }), /credential is not set/)

  await setConfig({ provider: 'anthropic' })
  assert.equal((await publicConfig()).hasKey, false)
})
