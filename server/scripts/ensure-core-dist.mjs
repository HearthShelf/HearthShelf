// Guarantee the server runs against a FRESH @hearthshelf/core dist, never a
// stale build artifact. Runs as the server's npm `prestart` hook.
//
// Background: the server imports @hearthshelf/core/lib/*.js (compiled dist), not
// the .ts source. dist/ is gitignored, so a clone has none, and a working tree
// can carry an OLD dist from a previous build. When core's src changes but dist
// doesn't get rebuilt, the server silently runs old logic. That exact drift
// shipped a stale Auto-queue rule once - this script exists so it can't recur.
//
// Behavior on `npm start`:
//   1. If core has its dev deps (tsc available), always rebuild dist from src.
//      Cheap, and it's the only way to be certain dist matches src.
//   2. If tsc is NOT available but a dist already exists, proceed with a warning
//      (production-style layout, e.g. the Docker image, which builds dist during
//      the image build - see Dockerfile).
//   3. If tsc is NOT available and there's NO dist, fail loudly with how to fix,
//      rather than crash later with an opaque module-not-found.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = dirname(dirname(fileURLToPath(import.meta.url)))
const coreDir = join(serverDir, '..', 'packages', 'core')
const distEntry = join(coreDir, 'dist', 'lib', 'queue.js')
const tscBin = join(
  coreDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
)

if (existsSync(tscBin)) {
  const res = spawnSync(tscBin, ['-p', 'tsconfig.build.json'], {
    cwd: coreDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (res.status !== 0) {
    console.error('[server:prestart] core dist build failed.')
    process.exit(res.status ?? 1)
  }
  console.log('[server:prestart] rebuilt @hearthshelf/core dist from src.')
} else if (existsSync(distEntry)) {
  console.log(
    '[server:prestart] no TypeScript in packages/core (production layout) - using the dist as built.',
  )
} else {
  console.error(
    '[server:prestart] @hearthshelf/core dist is missing and TypeScript is not installed to build it.\n' +
      '  Fix: install core dev deps once so dist can be built:\n' +
      '    npm --prefix ../packages/core install\n' +
      '  (that runs core\'s `prepare` and emits dist/). Then `npm start` again.',
  )
  process.exit(1)
}
