// Rating-prompt suppression. Mounted at /hs/rating-prompts/skip.
//
//   POST /hs/rating-prompts/skip  { itemKey }  -> { ok: true }
//
// Records "Skip rating" so nothing asks about that book again. This is its own
// route rather than a flag on the notification because dismissing the
// NOTIFICATION and declining to rate the BOOK are different statements: the
// notification row is what the prompt job dedupes against, so deleting it alone
// would let the next hourly pass recreate the prompt.
//
// Per-user, no admin gate - the caller's own data, same posture as
// routes/ratings.js.

import { json, readBody } from '../lib/http.js'
import { skipRatingPrompt } from '../lib/ratingPrompts.js'

// An ABS item id is not long; the cap only stops a buggy or hostile client
// bloating the table with junk keys. Same bound as routes/ratings.js.
const MAX_KEY_LEN = 256

export async function handleRatingPrompts(req, res, url, ctx) {
  if (url.pathname !== '/hs/rating-prompts/skip') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (req.method !== 'POST') return (json(res, 405, { error: 'method_not_allowed' }), true)

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return (json(res, 400, { error: 'invalid_body' }), true)
  }
  const itemKey = body?.itemKey
  if (typeof itemKey !== 'string' || !itemKey || itemKey.length > MAX_KEY_LEN) {
    return (json(res, 400, { error: 'invalid_item' }), true)
  }

  await skipRatingPrompt(ctx.serverId, ctx.userId, itemKey)
  return (json(res, 200, { ok: true }), true)
}
