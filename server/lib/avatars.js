// Profile photos (avatars) - a HearthShelf-native feature; ABS has no concept of
// one. The browser resizes/crops to a small square before upload, so the backend
// stays dependency-free: it only validates the type and a hard byte cap, writes
// the bytes to a file on the data volume, and tracks a row in the `avatars` table
// (content type, extension, version) so the GET route can find the file and the
// client can cache-bust on change.
//
// Files live at QG_DATA_DIR/avatars/<server_id>_<user_id>.<ext> on the same
// volume as hearthshelf.db, so the existing backup story covers them.

import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { db, initDb } from '../db.js'
import { DB_DIR } from '../db.js'

const AVATAR_DIR = path.join(DB_DIR, 'avatars')

// The browser sends a small square (~256px), so a 2MB cap is generous headroom
// while still refusing anything that didn't go through the client resize.
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

// Allowed image types -> file extension. webp is the client's default output.
const TYPE_EXT = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

export function extForType(contentType) {
  return TYPE_EXT[contentType] || null
}

// The Gravatar image URL for an email, sized to match our avatars. `d=404` makes
// Gravatar return a 404 (not a placeholder) when the user has no Gravatar, so the
// avatar route can fall through to initials instead of serving a generic icon.
// The hash is SHA-256 of the trimmed, lowercased email (Gravatar's current spec).
export function gravatarUrlFor(email, size = 256) {
  const normalized = String(email).trim().toLowerCase()
  if (!normalized) return null
  const hash = crypto.createHash('sha256').update(normalized).digest('hex')
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`
}

async function ensureDir() {
  await fs.mkdir(AVATAR_DIR, { recursive: true })
}

function fileName(serverId, userId, ext) {
  // Sanitise the ids defensively - they come from ABS but feed a filesystem path.
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '')
  return `${safe(serverId)}_${safe(userId)}.${ext}`
}

// The avatar metadata for one user, or null if they have none.
export async function getAvatarMeta(serverId, userId) {
  await initDb()
  const r = await db.execute({
    sql: `SELECT content_type, ext, version, updated_at
            FROM avatars WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
  const row = r.rows[0]
  if (!row) return null
  return {
    contentType: String(row.content_type),
    ext: String(row.ext),
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
  }
}

// Read the stored image bytes for one user, or null if missing (row or file).
export async function readAvatar(serverId, userId) {
  const meta = await getAvatarMeta(serverId, userId)
  if (!meta) return null
  try {
    const buf = await fs.readFile(
      path.join(AVATAR_DIR, fileName(serverId, userId, meta.ext))
    )
    return { buf, contentType: meta.contentType, version: meta.version }
  } catch {
    return null
  }
}

// Store (or replace) a user's avatar. Bumps the version so clients cache-bust.
export async function writeAvatar(serverId, userId, contentType, buf) {
  const ext = extForType(contentType)
  if (!ext) throw new Error('unsupported_type')
  await ensureDir()
  await initDb()

  const prev = await getAvatarMeta(serverId, userId)
  // If the extension changed (e.g. png -> webp), drop the old file so we don't
  // leave an orphan next to the new one.
  if (prev && prev.ext !== ext) {
    await fs
      .rm(path.join(AVATAR_DIR, fileName(serverId, userId, prev.ext)), { force: true })
      .catch(() => {})
  }

  await fs.writeFile(path.join(AVATAR_DIR, fileName(serverId, userId, ext)), buf)
  const version = prev ? prev.version + 1 : 1
  await db.execute({
    sql: `INSERT INTO avatars (server_id, user_id, content_type, ext, version, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(server_id, user_id) DO UPDATE SET
            content_type = excluded.content_type,
            ext = excluded.ext,
            version = excluded.version,
            updated_at = excluded.updated_at`,
    args: [serverId, userId, contentType, ext, version, Date.now()],
  })
  return { version }
}

// Remove a user's avatar (row + file). No-op if they had none.
export async function deleteAvatar(serverId, userId) {
  const prev = await getAvatarMeta(serverId, userId)
  if (!prev) return
  await fs
    .rm(path.join(AVATAR_DIR, fileName(serverId, userId, prev.ext)), { force: true })
    .catch(() => {})
  await db.execute({
    sql: `DELETE FROM avatars WHERE server_id = ? AND user_id = ?`,
    args: [serverId, userId],
  })
}
