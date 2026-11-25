// Preloaded into the bundled AudiobookShelf process on the all-in-one image
// (NODE_OPTIONS=--require, set by docker-entrypoint-aio.sh).
//
// ABS can add one folder to a library twice. A full library scan reads the list
// of existing items near its start (LibraryScanner.scanLibrary), spends minutes
// rescanning them, then adds every folder that was not on that stale list. If
// the folder watcher adds the folder in the meantime, the full scan adds it a
// second time, and the next scan marks one copy missing. Any tool that calls
// POST /api/libraries/:id/scan after dropping a book in triggers it (seen in the
// field: two items for one folder, created 4 minutes apart).
//
// Both the full scan and the watcher add items through one function,
// LibraryItemScanner.scanNewLibraryItem, and both callers already treat a null
// result as "nothing added". So this wraps that function: right before adding,
// it asks the database whether the library already has an item at that exact
// path, and skips the add if so. Adds for the same path are also serialized, so
// two scans racing on one folder cannot both pass the check.
//
// Any failure here falls back to ABS's own behaviour: ABS must start and scan
// even if this patch cannot apply.
'use strict'

const Module = require('module')
const Path = require('path')

const TARGET = /[\\/]server[\\/]scanner[\\/]LibraryItemScanner\.js$/
const originalLoad = Module._load
let patched = false

// One chain of pending adds per library + path.
const pathLocks = new Map()
function withPathLock(key, fn) {
  const prev = pathLocks.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  pathLocks.set(key, tail)
  tail.then(() => {
    if (pathLocks.get(key) === tail) pathLocks.delete(key)
  })
  return run
}

function patchScanner(scanner, scannerFile) {
  if (!scanner || typeof scanner.scanNewLibraryItem !== 'function' || scanner.__hsNoDuplicates) return
  const serverDir = Path.join(Path.dirname(scannerFile), '..')
  const original = scanner.scanNewLibraryItem

  scanner.scanNewLibraryItem = function scanNewLibraryItem(libraryItemData, librarySettings, libraryScan) {
    const libraryId = libraryItemData && libraryItemData.libraryId
    const itemPath = libraryItemData && libraryItemData.path
    if (!libraryId || !itemPath) return original.call(this, libraryItemData, librarySettings, libraryScan)

    return withPathLock(`${libraryId}\u0000${itemPath}`, async () => {
      let existing = null
      try {
        const Database = require(Path.join(serverDir, 'Database'))
        if (Database && Database.libraryItemModel) {
          existing = await Database.libraryItemModel.findOne({
            attributes: ['id', 'path'],
            where: { libraryId, path: itemPath },
          })
        }
      } catch (err) {
        console.warn('[aio] duplicate check failed, adding as usual:', err && err.message)
        existing = null
      }
      if (existing) {
        const msg = `[aio] "${libraryItemData.relPath || itemPath}" is already library item ${existing.id}; not adding it again`
        try {
          const Logger = require(Path.join(serverDir, 'Logger'))
          Logger.info(msg)
        } catch {
          console.info(msg)
        }
        if (libraryScan && typeof libraryScan.addLog === 'function') {
          try {
            const { LogLevel } = require(Path.join(serverDir, 'utils', 'constants'))
            libraryScan.addLog(LogLevel.INFO, msg)
          } catch {
            // The scan log is a nicety; the skip is what matters.
          }
        }
        return null
      }
      return original.call(this, libraryItemData, librarySettings, libraryScan)
    })
  }
  scanner.__hsNoDuplicates = true
  patched = true
}

try {
  Module._load = function load(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments)
    if (!patched && typeof request === 'string' && request.includes('LibraryItemScanner')) {
      try {
        const file = Module._resolveFilename(request, parent, isMain)
        if (TARGET.test(file)) patchScanner(exported, file)
      } catch (err) {
        console.warn('[aio] could not install the duplicate-item guard:', err && err.message)
      }
    }
    return exported
  }
} catch (err) {
  console.warn('[aio] could not install the duplicate-item guard:', err && err.message)
}
