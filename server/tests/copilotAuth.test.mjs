import test from 'node:test'
import assert from 'node:assert/strict'

const {
  copilotDiagnostic,
  copilotLoginSpawn,
  needsPlaintextStorageApproval,
  parseCopilotLoginOutput,
  resolveCopilotCliPath,
} = await import('../copilotAuth.js')

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

test('keeps CLI errors while redacting device codes and tokens', () => {
  const diagnostic = copilotDiagnostic(
    'To authenticate, visit https://github.com/login/device and enter code ABCD-1234\n' +
      'Waiting for authorization...\n' +
      'Credential write failed for github_pat_secretvalue and Bearer ghu_secretvalue\n',
  )
  assert.equal(
    diagnostic,
    'Credential write failed for [redacted-token] and Bearer [redacted-token]',
  )
})

test('recognizes the headless CLI storage confirmation', () => {
  assert.equal(
    needsPlaintextStorageApproval(
      'System keychain unavailable. Store token in plaintext config file? (y/N)',
    ),
    true,
  )
})

test('allocates a pseudo-terminal for headless Linux login', () => {
  const spawn = copilotLoginSpawn('/app/server/copilot cli/index.js', 'linux')
  assert.equal(spawn.command, 'script')
  assert.deepEqual(spawn.args.slice(0, 4), ['-q', '-e', '-f', '-c'])
  assert.equal(
    spawn.args[4],
    `'${process.execPath.replace(/'/g, `'"'"'`)}' '/app/server/copilot cli/index.js' 'login' '--device-code'`,
  )
  assert.equal(spawn.args[5], '/dev/null')
})

test('resolves the Copilot CLI bundled by the official SDK', () => {
  assert.match(resolveCopilotCliPath(), /@github[\\/]copilot-[^\\/]+[\\/]index\.js$/)
})
