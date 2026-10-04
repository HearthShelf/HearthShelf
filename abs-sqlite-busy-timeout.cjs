// Preloaded into the bundled AudiobookShelf process on the all-in-one image
// (NODE_OPTIONS=--require, set by docker-entrypoint-aio.sh).
//
// ABS gives up on a locked database after a few seconds and treats the
// resulting SQLITE_BUSY as fatal: an unhandled rejection exits the process
// (Server.js), so a progress sync or the startup cleanup can take ABS down.
// The HearthShelf backend never queries ABS's live file (server/lib/absReplica.js
// copies it under one short read lock), but anything else that briefly holds
// the file - that copy on a slow disk, ABS's own concurrent connections, a
// backup tool - should make ABS wait its turn, not crash. This raises ABS's wait
// to HS_ABS_SQLITE_BUSY_TIMEOUT_MS (default 15s) on every connection it opens.
//
// Any failure here is swallowed: ABS must start even if this patch cannot apply.
'use strict'

const BUSY_TIMEOUT_MS = Number(process.env.HS_ABS_SQLITE_BUSY_TIMEOUT_MS) || 15000

try {
  const sqlite3 = require(require.resolve('sqlite3', { paths: [process.cwd()] }))
  const Original = sqlite3.Database
  if (typeof Original === 'function' && !Original.__hsBusyTimeout) {
    const Patched = function Database(...args) {
      const db = new Original(...args)
      db.configure('busyTimeout', BUSY_TIMEOUT_MS)
      return db
    }
    Object.setPrototypeOf(Patched, Original)
    Patched.prototype = Original.prototype
    Patched.__hsBusyTimeout = true
    sqlite3.Database = Patched
  }
} catch (err) {
  console.warn('[aio] could not raise the AudiobookShelf sqlite busy timeout:', err && err.message)
}
