// The user's own 1-5 star ratings (book_ratings, served by routes/ratings.js).
//
// Deliberately NOT in server/store.js: that file is the QuestGiver/Discover
// persistence layer, and coupling ratings to it is exactly what this change
// undoes. Ratings are site-wide and live whether or not Discover is enabled.
//
// Keys are ABS library item ids for owned books, or 'fb:<finished_books.id>' for
// an imported stub the server doesn't own. See @hearthshelf/core lib/ratings.ts.

import { db, initDb } from '../db.js'

export async function getRatings(serverId, userId) {
  await initDb()
  const r = await db.execute({
    sql: `SELECT item_key, rating FROM book_ratings WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  const out = {}
  for (const row of r.rows) out[String(row.item_key)] = Number(row.rating)
  return out
}

// Upsert or clear one rating. `rating` null deletes the row - absence is how an
// unrated book is stored, so the table only ever holds real scores. Returns the
// full refreshed map so a client can adopt the server state wholesale rather than
// patching its cache from a partial response.
export async function setRating(serverId, userId, itemKey, rating) {
  await initDb()
  if (rating == null) {
    await db.execute({
      sql: `DELETE FROM book_ratings WHERE server_id = ? AND user_id = ? AND item_key = ?`,
      args: [serverId, userId, itemKey],
    })
  } else {
    await db.execute({
      sql: `INSERT INTO book_ratings (server_id, user_id, item_key, rating, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (server_id, user_id, item_key) DO UPDATE SET
              rating = excluded.rating, updated_at = excluded.updated_at`,
      args: [serverId, userId, itemKey, rating, Date.now()],
    })
  }
  return getRatings(serverId, userId)
}

// Ratings for a known set of keys, as a Map. The Hardcover sync needs a rating
// per book it is about to push; without this it would query once per book.
export async function getRatingsForKeys(serverId, userId, keys) {
  const out = new Map()
  if (!keys?.length) return out
  await initDb()
  const placeholders = keys.map(() => '?').join(',')
  const r = await db.execute({
    sql: `SELECT item_key, rating FROM book_ratings
           WHERE server_id = ? AND user_id = ? AND item_key IN (${placeholders})`,
    args: [serverId, userId, ...keys],
  })
  for (const row of r.rows) out.set(String(row.item_key), Number(row.rating))
  return out
}

// Seed a rating without overwriting one the user already set. Used by the
// Goodreads import: re-running an import must not clobber a score the listener
// has since changed in the app.
export async function seedRating(serverId, userId, itemKey, rating) {
  if (rating == null) return
  await initDb()
  await db.execute({
    sql: `INSERT OR IGNORE INTO book_ratings (server_id, user_id, item_key, rating, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [serverId, userId, itemKey, rating, Date.now()],
  })
}
