// This backend's version. Shared by the backup service and the version reporter.
// CI bakes HS_BUILD_VERSION into the image; server/package.json is never bumped
// on release, so it is only a fallback for a local checkout outside Docker.
// Reading it first made every box report (and log) the same stale v0.1.0.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const HS_VERSION = (() => {
  const fromEnv = (process.env.HS_BUILD_VERSION || '').trim()
  if (fromEnv) return fromEnv
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null
  } catch {
    return null
  }
})()
