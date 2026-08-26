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

export const COPILOT_HOME = path.join(process.env.QG_DATA_DIR || '/app/data', 'copilot')
const CONNECTION_MARKER = path.join(COPILOT_HOME, 'hearthshelf-connected')

const LOGIN_START_TIMEOUT_MS = 20_000
const MAX_OUTPUT_LENGTH = 16 * 1024
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g
const LOGIN_PATTERN = /visit\s+(https:\/\/\S+)\s+and enter code\s+([A-Z0-9-]+)/i

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
  }
  activeLogin = flow

  let cliPath
  try {
    cliPath = resolveCopilotCliPath()
  } catch (err) {
    flow.state = 'failed'
    flow.error = String(err).slice(0, 200)
    return publicLogin(flow)
  }

  const child = spawn(process.execPath, [cliPath, 'login', '--device-code'], {
    cwd: COPILOT_HOME,
    env: loginEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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
      child.kill()
    }
    finishStart()
  }, LOGIN_START_TIMEOUT_MS)

  const receive = (chunk) => {
    flow.output = `${flow.output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_LENGTH)
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
    finishStart()
  })
  child.once('exit', async (code, signal) => {
    clearTimeout(startTimer)
    flow.child = null
    if (code === 0) {
      flow.state = 'finishing'
      try {
        await onConnected?.()
        flow.state = 'connected'
        flow.error = null
      } catch (err) {
        flow.state = 'failed'
        flow.error = `GitHub connected, but QuestGiver could not save it: ${String(err).slice(0, 140)}`
      }
    } else if (flow.state !== 'failed') {
      flow.state = 'failed'
      flow.error = signal
        ? 'GitHub Copilot sign-in was cancelled'
        : `GitHub Copilot sign-in exited with code ${code ?? 'unknown'}`
    }
    finishStart()
  })

  await started
  return publicLogin(flow)
}

export function cancelCopilotLogin() {
  if (activeLogin?.child) activeLogin.child.kill()
  activeLogin = null
  return { state: 'idle' }
}
