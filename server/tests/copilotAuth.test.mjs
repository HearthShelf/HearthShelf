import test from 'node:test'
import assert from 'node:assert/strict'

const { parseCopilotLoginOutput, resolveCopilotCliPath } = await import('../copilotAuth.js')

test('extracts the official CLI device URL and one-time code', () => {
  const parsed = parseCopilotLoginOutput(
    '\u001b[2JTo authenticate, visit https://github.com/login/device and enter code ABCD-1234\r\nWaiting for authorization…',
  )
  assert.deepEqual(parsed, {
    verificationUri: 'https://github.com/login/device',
    userCode: 'ABCD-1234',
  })
})

test('ignores unrelated Copilot CLI output', () => {
  assert.equal(parseCopilotLoginOutput('Waiting for authorization...'), null)
})

test('resolves the Copilot CLI bundled by the official SDK', () => {
  assert.match(resolveCopilotCliPath(), /@github[\\/]copilot-[^\\/]+[\\/]index\.js$/)
})
