// Hardcover (hardcover.app) GraphQL client. Auth is a per-user Personal
// Access Token (Settings > Hardcover API on hardcover.app), NOT OAuth -
// stored per ABS user in hardcover_accounts (see lib/finishedBooks.js).
//
// Query/mutation shapes below are confirmed against the live schema via
// introspection (api.hardcover.app/v1/graphql) and the published schema at
// github.com/hardcoverapp/hardcover-docs. Notable non-obvious bits:
//   - `me` and `user_books` are Hasura array fields (return arrays, not
//     single objects), even though there's exactly one caller/row.
//   - `books(where: ...)` rejects `_ilike` ("not permitted on this server");
//     book lookup must go through the `search()` Typesense function instead,
//     whose hits are shaped as `{ document: { id (string!), title,
//     contributions: [{ author: { name } }] } }`.
//   - `UserBookCreateInput` has no date-finished field. status_id comes from
//     `user_book_statuses` (3 = "Read"), and the actual finish date is set by
//     a separate `insert_user_book_read` call with `DatesReadInput.finished_at`.
//   - `insert_user_book` can fail "successfully": a duplicate/invalid insert
//     comes back as 200 OK with `{ error: "..." }` in the payload, not a
//     GraphQL `errors[]` array.
//
// A snapshot of the full schema (as of 2026-07-07) is kept alongside this
// file at ./hardcover.schema.graphql for offline reference - docs.hardcover.app
// 403s automated fetches, so re-pull it from
// github.com/hardcoverapp/hardcover-docs/blob/main/schema.graphql if it goes stale.

const ENDPOINT = 'https://api.hardcover.app/v1/graphql'

// Reported as 60 req/min; keep well under it with a simple per-process
// sliding window since this only ever runs one sync at a time per user.
const RATE_LIMIT_PER_MIN = 60
const WINDOW_MS = 60_000
const callTimes = []

async function throttle() {
  const now = Date.now()
  while (callTimes.length && now - callTimes[0] > WINDOW_MS) callTimes.shift()
  if (callTimes.length >= RATE_LIMIT_PER_MIN) {
    const waitMs = WINDOW_MS - (now - callTimes[0]) + 50
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  callTimes.push(Date.now())
}

async function gql(token, query, variables) {
  await throttle()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    const err = new Error(`hardcover ${res.status}`)
    err.code = res.status === 401 ? 'invalid_token' : 'hardcover_error'
    throw err
  }
  const body = await res.json()
  if (body.errors?.length) {
    const err = new Error(body.errors[0]?.message || 'hardcover graphql error')
    err.code = 'hardcover_error'
    err.graphqlErrors = body.errors
    throw err
  }
  return body.data
}

// Verify a PAT and return the account's username, or null if invalid.
export async function verifyToken(token) {
  try {
    const data = await gql(token, `query { me { id username } }`)
    const me = data?.me?.[0]
    return me?.username ? String(me.username) : me?.id ? String(me.id) : null
  } catch (err) {
    if (err.code === 'invalid_token') return null
    throw err
  }
}

// Resolve a Hardcover book id from title/author/isbn via the Typesense-backed
// `search` function (plain `where`/`_ilike` book queries are rejected by the
// server). Returns { id, title } where id is the string book id used by
// insert_user_book's book_id (Int) after Number() conversion.
export async function searchBook(token, { title, author }) {
  const data = await gql(
    token,
    `query SearchBooks($query: String!) {
       search(query: $query, query_type: "Book", per_page: 5, page: 1) {
         results
       }
     }`,
    { query: title },
  )
  const hits = data?.search?.results?.hits || []
  if (!hits.length) return null
  const candidates = hits.map((h) => h.document).filter(Boolean)
  if (!candidates.length) return null
  if (!author) return { id: candidates[0].id, title: candidates[0].title }
  const authorLower = author.toLowerCase()
  const match = candidates.find((b) =>
    (b.contributions || []).some((c) => c.author?.name?.toLowerCase().includes(authorLower)),
  )
  const best = match || candidates[0]
  return { id: best.id, title: best.title }
}

// Mark a book as read with a finish date and optional rating.
// status_id 3 = "Read" per the user_book_statuses lookup table. The finish
// date isn't a field on UserBookCreateInput - it's set via a follow-up
// insert_user_book_read call. insert_user_book can fail "successfully" (200
// OK with an `error` string in the payload, no GraphQL errors[]), so that
// case is checked explicitly.
export async function upsertReadBook(token, { bookId, dateFinished, rating }) {
  const data = await gql(
    token,
    `mutation UpsertReadBook($object: UserBookCreateInput!) {
       insert_user_book(object: $object) {
         error
         id
       }
     }`,
    {
      object: {
        book_id: Number(bookId),
        status_id: 3,
        ...(rating ? { rating } : {}),
      },
    },
  )
  if (data?.insert_user_book?.error) {
    const err = new Error(data.insert_user_book.error)
    err.code = 'hardcover_error'
    throw err
  }
  const userBookId = data?.insert_user_book?.id ?? null
  if (userBookId && dateFinished) {
    await gql(
      token,
      `mutation SetFinishedDate($userBookId: Int!, $read: DatesReadInput!) {
         insert_user_book_read(user_book_id: $userBookId, user_book_read: $read) {
           error
         }
       }`,
      { userBookId, read: { finished_at: dateFinished } },
    )
  }
  return userBookId
}
