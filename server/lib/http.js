// Small HTTP helpers shared by every route module: JSON responses and a
// size-capped body reader. Plain Node http, no framework.

export function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

// Read the request body as raw bytes, capped at `limit`. Rejects with an error
// whose `.code` is 'payload_too_large' so callers can map it to a 413.
export async function readBodyBuffer(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        const err = new Error('payload too large')
        err.code = 'payload_too_large'
        reject(err)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function readBody(req, limit = 512 * 1024) {
  const buf = await readBodyBuffer(req, limit)
  return buf.toString('utf8')
}

// Parse a single-range `Range: bytes=...` header against a file of `size` bytes.
// Returns { start, end } (inclusive), 'unsatisfiable', or null to serve the whole
// file (no header, a unit other than bytes, a malformed value, or several ranges -
// a full 200 is a valid answer to any of those).
export function parseRange(header, size) {
  if (typeof header !== 'string' || !header.startsWith('bytes=')) return null
  const spec = header.slice(6).trim()
  if (!spec || spec.includes(',')) return null
  const m = spec.match(/^(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const n = Number(m[2])
    if (n === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

// Stream a file with HTTP Range support (206 / 416 / 200) - media players seek
// with byte ranges. `etag` lets If-Range fall back to a full response when the
// file has changed under a player that cached an older copy.
export async function sendFileWithRange(req, res, filePath, { contentType, etag, cacheControl }) {
  const { createReadStream } = await import('node:fs')
  const { stat } = await import('node:fs/promises')
  const st = await stat(filePath)
  const size = st.size
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
  }
  if (etag) headers.ETag = etag
  if (cacheControl) headers['Cache-Control'] = cacheControl

  let range = parseRange(req.headers['range'], size)
  const ifRange = req.headers['if-range']
  if (range && ifRange && etag && ifRange !== etag) range = null

  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
    res.end()
    return
  }

  let status = 200
  let start = 0
  let end = size - 1
  if (range) {
    status = 206
    start = range.start
    end = range.end
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || size === 0) {
    res.end()
    return
  }
  await new Promise((resolve) => {
    const stream = createReadStream(filePath, { start, end })
    stream.on('error', () => {
      res.destroy()
      resolve()
    })
    res.on('close', () => {
      stream.destroy()
      resolve()
    })
    stream.on('end', resolve)
    stream.pipe(res)
  })
}
