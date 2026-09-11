// Resolve the visual subjects used by activity email. Images are attached by
// CID when the server can reach them, so covers and avatars still appear when a
// mail client blocks remote images. Every path is best-effort and falls back to
// a designed text cover / initials rather than blocking the notification.

const ABS_URL = (process.env.ABS_SERVER_URL || 'http://127.0.0.1:13378').replace(/\/$/, '')
// The control-plane relay caps each base64 attachment at 100k characters.
const MAX_INLINE_BYTES = 72_000

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function initials(name) {
  const parts = cleanText(name).split(/\s+/).filter(Boolean)
  if (!parts.length) return 'HS'
  return `${parts[0][0] || ''}${parts.length > 1 ? parts.at(-1)?.[0] || '' : ''}`.toUpperCase()
}

function inlineImage(buf, contentType, stem, contentId) {
  const ext = EXT_BY_TYPE[contentType]
  if (!ext || !buf?.length || buf.length > MAX_INLINE_BYTES) return null
  return {
    src: `cid:${contentId}`,
    attachment: {
      filename: `${stem}.${ext}`,
      content: Buffer.from(buf).toString('base64'),
      content_id: contentId,
    },
  }
}

async function fetchImage(url, headers = {}) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    const response = await fetch(parsed, {
      headers,
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return null
    const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase()
    if (!EXT_BY_TYPE[contentType]) return null
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_INLINE_BYTES) return null
    const buf = Buffer.from(await response.arrayBuffer())
    return buf.length <= MAX_INLINE_BYTES ? { buf, contentType } : null
  } catch {
    return null
  }
}

export async function personEmailMedia(serverId, userId, name) {
  const person = { name: cleanText(name) || 'A reader', initials: initials(name) }
  try {
    const { readAvatar } = await import('./avatars.js')
    const avatar = await readAvatar(serverId, userId)
    const inline = avatar
      ? inlineImage(avatar.buf, avatar.contentType, 'reader-avatar', 'hearthshelf-reader-avatar')
      : null
    return inline ? { ...person, imageSrc: inline.src, attachment: inline.attachment } : person
  } catch {
    return person
  }
}

export async function bookEmailMedia(libraryItemId, fallback = {}) {
  const book = {
    title: cleanText(fallback.title) || 'Your book',
    author: cleanText(fallback.author),
  }
  if (!libraryItemId) return book

  try {
    const { getServiceToken } = await import('./serviceCredential.js')
    const token = await getServiceToken()
    if (!token) return book
    const headers = { Authorization: `Bearer ${token}` }
    const itemResponse = await fetch(
      `${ABS_URL}/api/items/${encodeURIComponent(libraryItemId)}?minified=1`,
      { headers, signal: AbortSignal.timeout(8_000) },
    )
    if (itemResponse.ok) {
      const item = await itemResponse.json()
      const metadata = item?.media?.metadata ?? {}
      book.title = cleanText(metadata.title) || book.title
      book.author =
        cleanText(metadata.authorName) ||
        (Array.isArray(metadata.authors)
          ? metadata.authors
              .map((author) => cleanText(author?.name))
              .filter(Boolean)
              .join(', ')
          : '') ||
        book.author
    }

    const image = await fetchImage(
      `${ABS_URL}/api/items/${encodeURIComponent(libraryItemId)}/cover?width=160`,
      headers,
    )
    const inline = image
      ? inlineImage(image.buf, image.contentType, 'book-cover', 'hearthshelf-book-cover')
      : null
    return inline ? { ...book, imageSrc: inline.src, attachment: inline.attachment } : book
  } catch {
    return book
  }
}

export async function remoteBookEmailMedia(title, author, imageUrl) {
  const book = { title: cleanText(title) || 'Your book', author: cleanText(author) }
  const url = cleanText(imageUrl)
  if (!url) return book
  const image = await fetchImage(url)
  const inline = image
    ? inlineImage(image.buf, image.contentType, 'book-cover', 'hearthshelf-book-cover')
    : null
  if (inline) return { ...book, imageSrc: inline.src, attachment: inline.attachment }
  // A remote image would usually be blocked by the mail client and would also
  // bypass our deliberate title/author cover. Keep the designed fallback when
  // the artwork cannot be embedded.
  return book
}
