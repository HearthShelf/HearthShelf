// Drift tripwire: the server's settings catalog mirror
// (server/lib/settingsCatalog.js) MUST list exactly the same keys as the
// authoritative @hearthshelf/core catalog (packages/core/src/lib/settings.ts).
//
// The server runs plain ESM and can't import core's .ts, so the catalog is
// hand-mirrored. A silently missed mirror would surface as `unknown_key`
// rejections on every client at once (the client validates from core, the
// server rejects from its stale mirror). This script fails CI / a manual run on
// any key mismatch. See docs/social.md ("Drift tripwire").
//
// Usage: node scripts/check-settings-catalog.mjs  (npm run check:catalog)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(root, 'packages', 'core', 'src', 'lib', 'settings.ts')
const MIRROR = join(root, 'server', 'lib', 'settingsCatalog.js')

// Core's DEFS is an array of object literals, each opening with `key: '<name>'`
// (or "double" quotes). Pull every such key. There are no other `key:` uses in
// the file's DEFS section, but playerActions' default entries also use `key:`
// with a placement sibling - those live in DEFAULT_PLAYER_ACTIONS, above DEFS,
// with string-literal keys like 'chapters'/'speed' that are NOT settings. We
// scope extraction to the DEFS array to avoid picking them up.
function coreKeys() {
  const src = readFileSync(CORE, 'utf8')
  const start = src.indexOf('const DEFS')
  if (start === -1) throw new Error('could not locate DEFS in core settings.ts')
  // DEFS ends at the closing `]` that precedes SETTINGS_CATALOG.
  const end = src.indexOf('SETTINGS_CATALOG', start)
  const region = end === -1 ? src.slice(start) : src.slice(start, end)
  const keys = new Set()
  const re = /\bkey:\s*'([^']+)'|\bkey:\s*"([^"]+)"/g
  let m
  while ((m = re.exec(region)) !== null) keys.add(m[1] ?? m[2])
  return keys
}

// The server mirror's DEFS is a plain object literal: `const DEFS = { ... }`.
// Each catalog entry is `<key>: { scope: ... }`. Extract the top-level keys of
// that object by matching identifiers/quoted keys that are followed by `: {`.
function mirrorKeys() {
  const src = readFileSync(MIRROR, 'utf8')
  const start = src.indexOf('const DEFS')
  if (start === -1) throw new Error('could not locate DEFS in settingsCatalog.js')
  const braceOpen = src.indexOf('{', start)
  // Walk to the matching close brace so we only scan the DEFS object body.
  let depth = 0
  let end = -1
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) throw new Error('unbalanced braces in settingsCatalog.js DEFS')
  const region = src.slice(braceOpen + 1, end)
  const keys = new Set()
  // Match top-level entries only: a key at depth 1 followed by `: {`. We track
  // brace depth so nested `values: [...]` or `pattern` don't confuse us; catalog
  // entry values are always `{ ... }`, so a `<key>: {` at depth 0 (relative to
  // the region) is an entry.
  let d = 0
  const re = /([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\s*:\s*\{|[{}]/g
  let m
  while ((m = re.exec(region)) !== null) {
    const tok = m[0]
    if (tok === '{') {
      d++
      continue
    }
    if (tok === '}') {
      d--
      continue
    }
    // A `<key>: {` match; the regex consumed the opening brace, so account for it.
    if (d === 0) {
      let name = m[1]
      if (name.startsWith("'") || name.startsWith('"')) name = name.slice(1, -1)
      keys.add(name)
    }
    d++ // the `{` this match consumed
  }
  return keys
}

const core = coreKeys()
const mirror = mirrorKeys()

const missingInMirror = [...core].filter((k) => !mirror.has(k)).sort()
const extraInMirror = [...mirror].filter((k) => !core.has(k)).sort()

if (missingInMirror.length === 0 && extraInMirror.length === 0) {
  console.log(`[check:catalog] OK - ${core.size} keys match between core and server mirror.`)
  process.exit(0)
}

console.error('[check:catalog] MISMATCH between core catalog and server mirror:')
if (missingInMirror.length)
  console.error(`  missing from server/lib/settingsCatalog.js: ${missingInMirror.join(', ')}`)
if (extraInMirror.length)
  console.error(`  extra in server/lib/settingsCatalog.js (not in core): ${extraInMirror.join(', ')}`)
console.error('Update the server mirror to match packages/core/src/lib/settings.ts (core first, mirror second).')
process.exit(1)
