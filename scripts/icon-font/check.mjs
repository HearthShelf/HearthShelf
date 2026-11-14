// Fails the build when the source names an icon that the embedded font lacks,
// which would otherwise render as its plain-text name ("play_arrow").
// Fix by running `npm run icons`. Mirrors the scan in build.py.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const all = new Set(JSON.parse(readFileSync(join(here, 'all-icons.json'), 'utf8')))
const included = new Set(JSON.parse(readFileSync(join(here, 'icons.json'), 'utf8')))
const token = /['"`]([a-z0-9_]{2,})['"`]|>\s*([a-z0-9_]{2,})\s*</g
const exts = new Set(['.ts', '.tsx', '.css', '.html'])

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (exts.has(extname(p)) && basename(p) !== 'icon-font.css') yield p
  }
}

const missing = new Set()
for (const dir of [join(root, 'src'), join(root, 'packages', 'core', 'src')]) {
  for (const file of walk(dir)) {
    for (const m of readFileSync(file, 'utf8').matchAll(token)) {
      const name = m[1] || m[2]
      if (all.has(name) && !included.has(name)) missing.add(name)
    }
  }
}

if (missing.size) {
  console.error(`Icons used but missing from the embedded font: ${[...missing].sort().join(', ')}`)
  console.error('Run `npm run icons` to rebuild src/icon-font.css.')
  process.exit(1)
}
console.log(`icon font ok (${included.size} icons)`)
