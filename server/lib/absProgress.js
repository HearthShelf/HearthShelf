// Writing finished-status back into ABS's own mediaProgress. This is how a
// Goodreads import (or the promotion job) makes a book count toward the
// ABS-derived stats page: the stats/social layer reads mediaProgresses.finishedAt
// directly (server/lib/absdb.js), so a HearthShelf-only finished_books row is
// invisible to it until we PATCH the finish into ABS.
//
// ABS has NO last-writer-wins guard on /api/me/progress/batch/update - the write
// always applies (see packages/core/docs/abs-api-reference.md). We therefore only
// ever SET a finish that isn't already there, never clobber a newer real finish;
// the caller passes rows already filtered to unsynced, and buildFinishPayload
// leaves currentTime/duration untouched so an in-progress listen isn't reset.

const ABS_URL = (process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378').replace(/\/$/, '')

// ISO 'YYYY-MM-DD' -> ms epoch at UTC midnight of that day. Goodreads only gives
// a date (no time), so the day is all we can honor; UTC midnight keeps the day
// bucket stable regardless of server timezone, matching how absdb buckets
// finishedAt by its leading 'YYYY-MM-DD'. Returns null for a malformed date.
export function dateFinishedToMs(dateFinished) {
  if (!dateFinished) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateFinished))
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(ms) ? ms : null
}

// One ABS batch-progress payload marking a library item finished on a past date.
export function buildFinishPayload(libraryItemId, dateFinished) {
  const finishedMs = dateFinishedToMs(dateFinished)
  const payload = {
    libraryItemId,
    isFinished: true,
    // lastUpdate backdates ABS's updatedAt to the finish day so the record reads
    // as a historical finish, not one made "now".
    lastUpdate: finishedMs ?? Date.now(),
  }
  // Only send finishedAt when we actually have a day; a finished row with an
  // unknown date still marks finished (ABS stamps its own finishedAt then).
  if (finishedMs != null) payload.finishedAt = finishedMs
  return payload
}

// PATCH a batch of finishes into ABS as the given bearer (a user's own token or a
// minted per-user key - both are self-scoped to /api/me). `rows` are
// finished_books rows ({ libraryItemId, dateFinished }). Returns the count the
// batch accepted, or 0 on any transport/HTTP failure (caller leaves those
// unsynced to retry). ABS silently skips per-item errors within an accepted
// batch, so this is a best-effort count, not a per-row guarantee.
export async function writeFinishesAsUser(userToken, rows, absUrl = ABS_URL) {
  const payloads = rows
    .filter((r) => r.libraryItemId)
    .map((r) => buildFinishPayload(r.libraryItemId, r.dateFinished))
  if (!payloads.length) return 0
  const res = await fetch(`${absUrl.replace(/\/$/, '')}/api/me/progress/batch/update`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payloads),
  }).catch(() => null)
  return res && res.ok ? payloads.length : 0
}
