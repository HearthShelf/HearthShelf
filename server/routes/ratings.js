// The caller's own star ratings. Mounted at /hs/ratings.
//
//   GET /hs/ratings                       -> { ratings: { [itemKey]: 1-5 } }
//   PUT /hs/ratings  { itemKey, rating }  -> { ratings }   (rating null clears)
//
// Per-user, no admin gate - the caller's own data, same posture as
// routes/finished-books.js and routes/stats.js.
//
// Note there is NO Discover feature-flag check here, unlike routes/discover.js.
// That is the point of this route existing: ratings are shown on the book page,
// series rows, and the finished-books page regardless of whether Discover is on.
// Discover reads these ratings, not the other way round.

import { json, readBody } from '../lib/http.js'
import { getRatings, setRating } from '../lib/ratingsStore.js'
import { isValidRating } from '@hearthshelf/core'

// A key is an ABS item id or 'fb:<uuid>'; neither is long. The cap only stops a
// buggy or hostile client bloating the table with junk keys.
const MAX_KEY_LEN = 256

export async function handleRatings(req, res, url, ctx) {
  if (url.pathname !== '/hs/ratings') return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  if (req.method === 'GET') {
    return (json(res, 200, { ratings: await getRatings(ctx.serverId, ctx.userId) }), true)
  }

  if (req.method === 'PUT') {
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
    const rating = body?.rating ?? null
    if (rating !== null && !isValidRating(rating)) {
      return (json(res, 400, { error: 'invalid_rating' }), true)
    }
    const ratings = await setRating(ctx.serverId, ctx.userId, itemKey, rating)
    return (json(res, 200, { ratings }), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
