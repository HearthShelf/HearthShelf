// Drift tripwire for the server's settings gate (server/lib/settingsCatalog.js).
//
// The gate used to hand-mirror @hearthshelf/core's catalog as its own DEFS
// object, and a missed mirror surfaced as `unknown_key` rejections on every
// client at once (client validates from core, server rejects from a stale copy).
// It now imports core's catalog directly, so the drift is structurally
// impossible - and this script's job changed to keeping it that way:
//
//   1. the gate must import validateSetting + settingDef from core, and
//   2. it must not declare a catalog of its own (no local DEFS / catalog object).
//
// It also prints the catalog size as a sanity check that core actually loads.
//
// Usage: node scripts/check-settings-catalog.mjs  (npm run check:catalog)

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(root, 'server', 'lib', 'settingsCatalog.js')

const problems = []

let src = ''
try {
  src = readFileSync(GATE, 'utf8')
} catch {
  problems.push(`cannot read ${GATE}`)
}

if (src) {
  if (!/from\s+'@hearthshelf\/core\/lib\/settings'/.test(src)) {
    problems.push(
      "server/lib/settingsCatalog.js must import from '@hearthshelf/core/lib/settings' - " +
        'the core catalog is the one definition of every setting.',
    )
  }
  for (const decl of ['DEFS', 'CATALOG', 'SETTINGS']) {
    if (new RegExp(`\\bconst\\s+${decl}\\s*=`).test(src)) {
      problems.push(
        `server/lib/settingsCatalog.js declares its own \`${decl}\` - a second catalog will ` +
          "drift from core. Re-use core's instead.",
      )
    }
  }
}

// Load the gate for real: proves core resolves (from server/node_modules, where
// @hearthshelf/core is declared) and that the re-exports behave.
try {
  const gate = await import(pathToFileURL(GATE).href)
  if (typeof gate.validateSetting !== 'function') {
    problems.push('gate does not export validateSetting')
  }
  if (typeof gate.settingScope !== 'function') {
    problems.push('gate does not export settingScope')
  } else {
    // Two keys of each scope: if the gate resolved an empty or wrong catalog,
    // these come back null.
    if (gate.settingScope('theme') !== 'account') {
      problems.push("settingScope('theme') should be 'account' - is core's catalog loaded?")
    }
    if (gate.settingScope('useSharedSettings') !== 'device') {
      problems.push("settingScope('useSharedSettings') should be 'device'")
    }
    if (gate.settingScope('definitely-not-a-setting') !== null) {
      problems.push('an unknown key must resolve to a null scope')
    }
  }
  if (!problems.length) console.log("[check:catalog] OK - server gate re-uses core's catalog.")
} catch (err) {
  problems.push(`could not load the settings gate: ${err.message}`)
}

if (problems.length) {
  console.error('[check:catalog] PROBLEM:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
