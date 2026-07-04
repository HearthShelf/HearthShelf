// Profile photos. Mounted at /hs/avatars/:userId.
//
//   GET    /hs/avatars/:userId  -> the image bytes (public; photos aren't secret
//                                  and <img> tags can't send auth headers). 404
//                                  when the user has no avatar.
//   PUT    /hs/avatars/:userId  -> upload/replace. Body is the raw image bytes,
//                                  Content-Type is the format. Allowed: self, or
//                                  any admin (admins manage anyone's photo).
//   DELETE /hs/avatars/:userId  -> clear it. Same permission rule as PUT.
//
// The browser resizes/crops to a small square before PUT, so the backend stays
// dependency-free (see lib/avatars.js).

import { json, readBodyBuffer } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { getServerId } from '../db.js'
import { getUserEmail } from '../lib/absdb.js'
import { getUserSetting } from '../settings.js'
import {
  readAvatar,
  writeAvatar,
  deleteAvatar,
  extForType,
  gravatarUrlFor,
  MAX_AVATAR_BYTES,
} from '../lib/avatars.js'

export async function handleAvatars(req, res, url, ctx) {
  const m = url.pathname.match(/^\/hs\/avatars\/([^/]+)$/)
  if (!m) return false
  const targetUserId = decodeURIComponent(m[1])

  // GET is public so <img src> works without a token. It still namespaces by the
  // instance's server_id, which the route resolves on its own.
  //
  // Priority chain (explicit intent beats an automatic default):
  //   1. Manual upload      - the user deliberately picked this photo
  //   2. Gravatar, if the user EXPLICITLY turned it on (useGravatar === true)
  //   3. Clerk photo        - the hosted WebApp's copy of their SSO photo
  //   4. Gravatar, by default (useGravatar unset - the polite fallback)
  //   5. 404                - the client renders initials
  // A synced Clerk photo (2/3) only exists on the hosted deployment; self-hosted
  // has no Clerk, so the chain there is simply upload -> Gravatar -> initials.
  if (req.method === 'GET') {
    const serverId = await getServerId()
    const avatar = await readAvatar(serverId, targetUserId)
    const serveStored = () => {
      res.writeHead(200, {
        'Content-Type': avatar.contentType,
        'Content-Length': avatar.buf.length,
        // The path includes no version, so allow caching but let the client
        // cache-bust with a ?v= query param after an upload.
        'Cache-Control': 'public, max-age=300',
      })
      res.end(avatar.buf)
      return true
    }

    // 1. A manual upload always wins.
    if (avatar && avatar.source === 'upload') return serveStored()

    // Gravatar tri-state: true = explicit on (a preference), null/unset = default
    // on (a fallback), false = off. The explicit choice ranks above a Clerk photo;
    // the default ranks below it.
    const gravatarPref = await getUserSetting(serverId, targetUserId, 'useGravatar')
    const email = await getUserEmail(targetUserId)
    const gravatar = email && gravatarUrlFor(email)
    const redirectGravatar = () => {
      res.writeHead(302, {
        Location: gravatar,
        // Short cache so toggling the preference or setting a Gravatar takes
        // effect promptly; the client also cache-busts with ?v= on upload.
        'Cache-Control': 'public, max-age=300',
      })
      res.end()
      return true
    }

    // 2. Gravatar explicitly enabled - beats a Clerk photo.
    if (gravatarPref === true && gravatar) return redirectGravatar()

    // 3. A synced Clerk photo.
    if (avatar) return serveStored()

    // 4. Gravatar by default (not explicitly turned off).
    if (gravatarPref !== false && gravatar) return redirectGravatar()

    // 5. Nothing available - the client renders initials.
    return (json(res, 404, { error: 'no_avatar' }), true)
  }

  // Writes require auth: the user themselves, or any admin.
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  const isSelf = ctx.userId === targetUserId
  if (!isSelf && !isAdmin(ctx)) {
    return (json(res, 403, { error: 'forbidden' }), true)
  }
  const serverId = ctx.serverId

  if (req.method === 'PUT') {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim()
    if (!extForType(contentType)) {
      return (json(res, 415, { error: 'unsupported_type' }), true)
    }
    let buf
    try {
      buf = await readBodyBuffer(req, MAX_AVATAR_BYTES)
    } catch (err) {
      if (err?.code === 'payload_too_large') {
        return (json(res, 413, { error: 'too_large' }), true)
      }
      return (json(res, 400, { error: 'read_failed' }), true)
    }
    if (!buf.length) return (json(res, 400, { error: 'empty' }), true)
    // Provenance header: 'clerk' when the hosted WebApp copies a user's SSO photo,
    // 'upload' (default) for a deliberate upload. Unknown values fall back to
    // 'upload' so a stray header can't demote a real upload.
    const source = req.headers['x-avatar-source'] === 'clerk' ? 'clerk' : 'upload'
    const { version, skipped } = await writeAvatar(serverId, targetUserId, contentType, buf, source)
    return (json(res, 200, { ok: true, version, skipped: !!skipped }), true)
  }

  if (req.method === 'DELETE') {
    await deleteAvatar(serverId, targetUserId)
    return (json(res, 200, { ok: true }), true)
  }

  return (json(res, 405, { error: 'method_not_allowed' }), true)
}
