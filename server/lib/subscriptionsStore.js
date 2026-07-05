// Per-user release subscriptions + Expo push tokens. A subscription follows an
// upcoming book (kind='book') or a whole series (kind='series'); the full display
// payload is stored so clients + the Home countdown banner render without
// refetching Audible. The push job reads these, marks books available as they
// land in ABS, and records which push signals already fired (notified_json) so a
// notification never repeats. See jobs/seriesRoster.js (producer of availability)
// and routes/subscriptions.js (CRUD).

import { db, getServerId } from '../db.js'

// Map a DB row to the HSSubscription shape the clients consume.
function rowToSub(row) {
  let notified = {}
  try {
    notified = row.notified_json ? JSON.parse(String(row.notified_json)) : {}
  } catch {
    notified = {}
  }
  return {
    id: String(row.id),
    kind: String(row.kind),
    asin: row.asin == null ? undefined : String(row.asin),
    seriesAsin: row.series_asin == null ? undefined : String(row.series_asin),
    title: String(row.title),
    author: row.author == null ? undefined : String(row.author),
    seriesTitle: row.series_title == null ? undefined : String(row.series_title),
    sequence: row.sequence == null ? null : String(row.sequence),
    coverArtUrl: row.cover_art_url == null ? undefined : String(row.cover_art_url),
    narrator: row.narrator == null ? undefined : String(row.narrator),
    durationMinutes: row.duration_min == null ? undefined : Number(row.duration_min),
    releaseDate: row.release_date == null ? undefined : String(row.release_date),
    publicationDatetime:
      row.publication_datetime == null ? undefined : String(row.publication_datetime),
    available: Number(row.available) === 1,
    availableAt: row.available_at == null ? null : Number(row.available_at),
    createdAt: Number(row.created_at) || 0,
    // Internal (not part of HSSubscription, but handy for the push job).
    notified,
  }
}

/** All of a user's subscriptions, newest first. */
export async function listSubscriptions(serverId, userId) {
  const res = await db.execute({
    sql: `SELECT * FROM subscriptions WHERE server_id = ? AND user_id = ?
          ORDER BY created_at DESC`,
    args: [serverId, userId],
  })
  return res.rows.map(rowToSub)
}

/** Every subscription across all users on this instance (for the push job). */
export async function allSubscriptions(serverId) {
  const res = await db.execute({
    sql: `SELECT * FROM subscriptions WHERE server_id = ?`,
    args: [serverId],
  })
  return res.rows.map((r) => ({ ...rowToSub(r), userId: String(r.user_id) }))
}

/** Create (or upsert by id) a subscription. `sub` is HSSubscriptionCreate plus a
 *  caller-supplied id + createdAt. */
export async function saveSubscription(serverId, userId, sub) {
  await db.execute({
    sql: `
      INSERT INTO subscriptions
        (server_id, user_id, id, kind, asin, series_asin, title, author,
         series_title, sequence, cover_art_url, narrator, duration_min,
         release_date, publication_datetime, available, available_at,
         notified_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '{}', ?)
      ON CONFLICT (server_id, user_id, id) DO UPDATE SET
        kind = excluded.kind, asin = excluded.asin,
        series_asin = excluded.series_asin, title = excluded.title,
        author = excluded.author, series_title = excluded.series_title,
        sequence = excluded.sequence, cover_art_url = excluded.cover_art_url,
        narrator = excluded.narrator, duration_min = excluded.duration_min,
        release_date = excluded.release_date,
        publication_datetime = excluded.publication_datetime
    `,
    args: [
      serverId,
      userId,
      sub.id,
      sub.kind,
      sub.asin ?? null,
      sub.seriesAsin ?? null,
      sub.title,
      sub.author ?? null,
      sub.seriesTitle ?? null,
      sub.sequence ?? null,
      sub.coverArtUrl ?? null,
      sub.narrator ?? null,
      sub.durationMinutes ?? null,
      sub.releaseDate ?? null,
      sub.publicationDatetime ?? null,
      sub.createdAt,
    ],
  })
}

export async function deleteSubscription(serverId, userId, id) {
  await db.execute({
    sql: `DELETE FROM subscriptions WHERE server_id = ? AND user_id = ? AND id = ?`,
    args: [serverId, userId, id],
  })
}

/** Mark a book subscription available (it landed in ABS). */
export async function markSubscriptionAvailable(serverId, userId, id, availableAt) {
  await db.execute({
    sql: `UPDATE subscriptions SET available = 1, available_at = ?
          WHERE server_id = ? AND user_id = ? AND id = ?`,
    args: [availableAt, serverId, userId, id],
  })
}

/** Record that a push signal (e.g. 'available', 'release', 'reminder') fired for
 *  a subscription, so it never repeats. `notified` is the merged map. */
export async function setSubscriptionNotified(serverId, userId, id, notified) {
  await db.execute({
    sql: `UPDATE subscriptions SET notified_json = ?
          WHERE server_id = ? AND user_id = ? AND id = ?`,
    args: [JSON.stringify(notified ?? {}), serverId, userId, id],
  })
}

// --- Expo push tokens -------------------------------------------------------

/** Register (upsert) an Expo push token for a user+device. */
export async function savePushToken(serverId, userId, token, platform) {
  await db.execute({
    sql: `
      INSERT INTO push_tokens (server_id, user_id, token, platform, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (server_id, token) DO UPDATE SET
        user_id = excluded.user_id, platform = excluded.platform,
        updated_at = excluded.updated_at
    `,
    args: [serverId, userId, token, platform ?? null, Date.now()],
  })
}

/** All push tokens for a user (they may have several devices). */
export async function listPushTokens(serverId, userId) {
  const res = await db.execute({
    sql: `SELECT token, platform FROM push_tokens WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  return res.rows.map((r) => ({ token: String(r.token), platform: r.platform ?? null }))
}

/** Drop a token (e.g. Expo reported it as DeviceNotRegistered). */
export async function deletePushToken(serverId, token) {
  await db.execute({
    sql: `DELETE FROM push_tokens WHERE server_id = ? AND token = ?`,
    args: [serverId, token],
  })
}

export { getServerId }
