// Supported GitHub Copilot sign-in for QuestGiver.
//
// The Copilot SDK bundles the official Copilot CLI. Its `login --device-code`
// command owns GitHub's OAuth flow and persists the credential without exposing
// it to HearthShelf. We keep that CLI state inside QG_DATA_DIR so the SDK and
// login process share one isolated account instead of inheriting a developer's
// personal ~/.copilot directory.

import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appLog } from './lib/appLog.js'

export const COPILOT_HOME = path.join(process.env.QG_DATA_DIR || '/app/data', 'copilot')
const CONNECTION_MARKER = path.join(COPILOT_HOME, 'hearthshelf-connected')

const LOGIN_START_TIMEOUT_MS = 20_000
const MAX_OUTPUT_LENGTH = 16 * 1024
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g
const LOGIN_PATTERN = /visit\s+(https:\/\/\S+)\s+and enter code\s+([A-Z0-9-]+)/i
const PLAINTEXT_PROMPT_PATTERN = /system keychain unavailable.*store token in plaintext/i

let activeLogin = null

function loginEnvironment() {
  const env = {
    ...process.env,
    COPILOT_HOME,
    COPILOT_DISABLE_KEYTAR: '1',
    GH_CONFIG_DIR: path.join(COPILOT_HOME, 'gh-cli'),
  }
  // `copilot login` otherwise accepts these instead of starting an interactive
  // account connection. QuestGiver only uses an env token when the admin puts it
  // in QG_API_KEY, which is passed explicitly by providers.js.
  delete env.COPILOT_GITHUB_TOKEN
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  return env
}

function platformPackageNames() {
  const variants = process.platform === 'linux' ? ['linux', 'linuxmusl'] : [process.platform]
  return variants.map((variant) => `@github/copilot-${variant}-${process.arch}`)
}

export function resolveCopilotCliPath() {
  for (const packageName of platformPackageNames()) {
    try {
      const sdkPath = fileURLToPath(import.meta.resolve(`${packageName}/sdk`))
      return path.join(path.dirname(path.dirname(sdkPath)), 'index.js')
    } catch {
      // Only the native package for this host is installed; try the next Linux
      // libc variant before reporting that the optional dependency is missing.
    }
  }
  throw new Error('The bundled GitHub Copilot CLI is not available for this platform')
}

export function parseCopilotLoginOutput(value) {
  const clean = String(value || '').replace(ANSI_PATTERN, '')
  const match = clean.match(LOGIN_PATTERN)
  if (!match) return null
  return {
    verificationUri: match[1].replace(/[.,;]+$/, ''),
    userCode: match[2],
  }
}

// Preserve the useful CLI failure while ensuring Admin > Logs never receives a
// one-time device code or token-shaped value. Routine sign-in instructions are
// omitted because they otherwise hide the final error line.
export function copilotDiagnostic(value) {
  const lines = String(value || '')
    .replace(ANSI_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^to authenticate, visit /i.test(line))
    .filter((line) => !/^waiting for authorization/i.test(line))
    .filter((line) => !/^failed to copy to clipboard/i.test(line))
  return [...new Set(lines)]
    .join(' | ')
    .replace(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/g, '[redacted-code]')
    .replace(/\b(?:github_pat_|gh[a-z]_)[A-Za-z0-9_]+\b/g, '[redacted-token]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted-token]')
    .slice(0, 700)
}

export function needsPlaintextStorageApproval(value) {
  return PLAINTEXT_PROMPT_PATTERN.test(String(value || '').replace(ANSI_PATTERN, ''))
}

function publicLogin(flow = activeLogin) {
  if (!flow) return { state: 'idle' }
  return {
    state: flow.state,
    ...(flow.verificationUri ? { verificationUri: flow.verificationUri } : {}),
    ...(flow.userCode ? { userCode: flow.userCode } : {}),
    ...(flow.error ? { error: flow.error } : {}),
  }
}

export function getCopilotLogin() {
  return publicLogin()
}

export async function hasCopilotConnection() {
  try {
    await access(CONNECTION_MARKER)
    return true
  } catch {
    return false
  }
}

export async function markCopilotConnected() {
  await mkdir(COPILOT_HOME, { recursive: true, mode: 0o700 })
  await writeFile(CONNECTION_MARKER, `${new Date().toISOString()}\n`, { mode: 0o600 })
}

export async function startCopilotLogin({ onConnected } = {}) {
  if (activeLogin?.state === 'starting' || activeLogin?.state === 'waiting') {
    return publicLogin()
  }

  await mkdir(COPILOT_HOME, { recursive: true, mode: 0o700 })
  const flow = {
    state: 'starting',
    output: '',
    verificationUri: null,
    userCode: null,
    error: null,
    child: null,
    plaintextApproved: false,
  }
  activeLogin = flow
  appLog.info('copilot', `starting GitHub device sign-in (${process.platform}/${process.arch})`)

  let cliPath
  try {
    cliPath = resolveCopilotCliPath()
  } catch (err) {
    flow.state = 'failed'
    flow.error = String(err).slice(0, 200)
    appLog.error('copilot', `could not locate the bundled CLI: ${flow.error}`)
    return publicLogin(flow)
  }

  const child = spawn(process.execPath, [cliPath, 'login', '--device-code'], {
    cwd: COPILOT_HOME,
    env: loginEnvironment(),
    windowsHide: true,
    // Headless Linux has no system keychain. The official CLI asks for
    // confirmation before falling back to COPILOT_HOME; keep stdin available so
    // the admin's explicit Connect action can approve that isolated storage.
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  flow.child = child

  let startResolved = false
  let resolveStart
  const started = new Promise((resolve) => {
    resolveStart = resolve
  })
  const finishStart = () => {
    if (startResolved) return
    startResolved = true
    resolveStart()
  }
  const startTimer = setTimeout(() => {
    if (flow.state === 'starting') {
      flow.state = 'failed'
      flow.error = 'GitHub Copilot sign-in did not start in time'
      const detail = copilotDiagnostic(flow.output)
      appLog.error('copilot', `${flow.error}${detail ? `: ${detail}` : ''}`)
      child.kill()
    }
    finishStart()
  }, LOGIN_START_TIMEOUT_MS)

  const receive = (chunk) => {
    flow.output = `${flow.output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_LENGTH)
    if (!flow.plaintextApproved && needsPlaintextStorageApproval(flow.output)) {
      flow.plaintextApproved = true
      appLog.info(
        'copilot',
        'system keychain unavailable; using the protected QuestGiver data directory',
      )
      try {
        child.stdin.write('y\n')
      } catch (err) {
        appLog.error('copilot', `could not approve CLI credential storage: ${String(err)}`)
      }
    }
    const parsed = parseCopilotLoginOutput(flow.output)
    if (!parsed || flow.state !== 'starting') return
    flow.state = 'waiting'
    flow.verificationUri = parsed.verificationUri
    flow.userCode = parsed.userCode
    clearTimeout(startTimer)
    finishStart()
  }
  child.stdout.on('data', receive)
  child.stderr.on('data', receive)

  child.once('error', (err) => {
    clearTimeout(startTimer)
    flow.state = 'failed'
    flow.error = String(err).slice(0, 200)
    appLog.error('copilot', `could not start GitHub sign-in: ${flow.error}`)
    finishStart()
  })
  // `close` fires after the output pipes close, so the final stderr line is
  // available when we build the diagnostic.
  child.once('close', async (code, signal) => {
    clearTimeout(startTimer)
    flow.child = null
    if (code === 0) {
      flow.state = 'finishing'
      try {
        await onConnected?.()
        flow.state = 'connected'
        flow.error = null
        appLog.info('copilot', 'GitHub account connected successfully')
      } catch (err) {
        flow.state = 'failed'
        flow.error = `GitHub connected, but QuestGiver could not save it: ${String(err).slice(0, 140)}`
        appLog.error('copilot', flow.error)
      }
    } else if (flow.state !== 'failed') {
      flow.state = 'failed'
      const summary = signal
        ? 'GitHub Copilot sign-in was cancelled'
        : `GitHub Copilot sign-in exited with code ${code ?? 'unknown'}`
      const detail = copilotDiagnostic(flow.output)
      flow.error = `${summary}${detail ? `: ${detail}` : ': the CLI produced no diagnostic output'}`
      appLog.error('copilot', flow.error)
    }
    finishStart()
  })

  await started
  return publicLogin(flow)
}

export function cancelCopilotLogin() {
  if (activeLogin?.child) {
    activeLogin.state = 'failed'
    activeLogin.child.kill()
  }
  activeLogin = null
  return { state: 'idle' }
}
