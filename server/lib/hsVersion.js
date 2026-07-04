// This backend's version, read once from server/package.json. Shared by the
// backup service, the version reporter, and runtime.js so there's one reader.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const HS_VERSION = (() => {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null
  } catch {
    return null
  }
})()
