// Ready-made parts for oversized single-file MP4 audiobooks.
//
//   GET /hs/parts/:itemId         -> { parts: null } when the book plays fine as
//                                    is, otherwise
//                                    { parts: [{ index, start, duration, url }],
//                                      source: { ino, duration } }
//                                    Optional ?prepare=<index> starts preparing
//                                    that part in the background (no waiting).
//   GET /hs/parts/:itemId/:index  -> the part as audio/mp4 (.m4a), with HTTP
//                                    Range support. HEAD works too.
//
// Why: a 70-hour single-file m4b carries a sample table of 10+ million entries.
// Phone and car players load that whole table into memory and run out; parts of
// about four hours each have small tables of their own. Nothing in the library
// is ever changed - parts are stream-copied from the ABS file into a cache on
// the HearthShelf data volume (lib/partCache.js), split at chapter starts
// (lib/partPlan.js).
//
// Auth is the normal /hs ctx (Authorization: Bearer ...). Native players cannot
// set headers on a media URL, so both routes also accept ?token=, resolved
// through the same resolveContext as a header would be. Every request fetches
// the item from ABS AS THE CALLER (briefly cached per user), so library
// permissions apply to cached parts too.
//
// A single-file book whose audio not every browser can decode (xHE-AAC above all,
// see lib/partCache.js needsReencode) is served as parts at ANY length, and
// those parts are short and converted to AAC-LC - the way Plex transcodes in
// chunks: the first part is ready in seconds and the next is always prepared
// ahead. The format is read once per book with ffprobe (index only) and cached.
//
// Env: HS_PARTS_MIN_FRAMES, HS_PARTS_TARGET_SECONDS (lib/partPlan.js),
//      HS_PARTS_REENCODE_SECONDS (default 180: part length when converting),
//      HS_PARTS_CACHE_MB (default 20480), HS_PARTS_JOBS (default 2),
//      HS_FFMPEG_PATH (default 'ffmpeg'), QG_DATA_DIR.

import path from 'node:path'
import { json, sendFileWithRange } from '../lib/http.js'
import { resolveContext } from '../lib/context.js'
import { appLog } from '../lib/appLog.js'
import { includedAudioFiles, partSettings, partSource, planParts } from '../lib/partPlan.js'
import {
  createPartCache,
  needsReencode,
  partCacheKey,
  PartError,
  spawnProbe,
} from '../lib/partCache.js'

const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const PLAN_TTL_MS = 60 * 1000
const PLAN_CACHE_MAX = 500
// How long a request waits for its part before giving up (the part keeps being
// prepared; a retry picks it up).
const WAIT_MS = 15 * 60 * 1000
const DEFAULT_CACHE_MB = 20480
const DEFAULT_JOBS = 2
const DEFAULT_REENCODE_SECONDS = 180
// How long a parts-list request waits for the format check on first open. The
// check keeps running past this and its answer is cached for the next request.
const PROBE_WAIT_MS = 6000
const FORMAT_CACHE_MAX = 2000

function positiveInt(raw, fallback) {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

let cache = null
function partCache() {
  if (!cache) {
    const dataDir = process.env.QG_DATA_DIR || '/app/data'
    cache = createPartCache({
      dir: path.join(dataDir, 'parts-cache'),
      maxBytes: positiveInt(process.env.HS_PARTS_CACHE_MB, DEFAULT_CACHE_MB) * 1024 * 1024,
      maxJobs: positiveInt(process.env.HS_PARTS_JOBS, DEFAULT_JOBS),
      log: (level, msg) => appLog[level]('parts', msg),
    })
  }
  return cache
}

// itemId|ino|size|mtime -> Promise<probe|null>. The file's format never changes
// without its size or mtime changing, so this never expires; it is only bounded.
const formatCache = new Map()

function sourceFormat(ctx, itemId, source) {
  const key = `${itemId}|${source.ino}|${source.size}|${source.mtimeMs}`
  let p = formatCache.get(key)
  if (!p) {
    const url = `${ctx.absUrl}/api/items/${encodeURIComponent(itemId)}/file/${encodeURIComponent(source.ino)}`
    p = spawnProbe(url, ctx.absToken).then((probe) => {
      // A failed check is not cached, so a later open tries again.
      if (!probe) formatCache.delete(key)
      return probe
    })
    if (formatCache.size >= FORMAT_CACHE_MAX) formatCache.delete(formatCache.keys().next().value)
    formatCache.set(key, p)
  }
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), PROBE_WAIT_MS)
    timer.unref?.()
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

// userId|itemId -> { at, plan }. Players make many range requests per part;
// this keeps each one from re-fetching the item from ABS.
const planCache = new Map()

class RouteError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

async function loadPlan(ctx, itemId) {
  const cacheKey = `${ctx.userId}|${itemId}`
  const hit = planCache.get(cacheKey)
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan

  let res
  try {
    res = await fetch(`${ctx.absUrl}/api/items/${encodeURIComponent(itemId)}`, {
      headers: { Authorization: `Bearer ${ctx.absToken}` },
    })
  } catch {
    throw new RouteError(502, 'abs_unreachable')
  }
  if (res.status === 404) throw new RouteError(404, 'unknown_item')
  if (res.status === 401 || res.status === 403) throw new RouteError(403, 'forbidden')
  if (!res.ok) throw new RouteError(502, 'abs_error')
  const item = await res.json().catch(() => null)
  if (!item?.id) throw new RouteError(502, 'abs_error')

  const settings = partSettings()
  // Any single MP4-family file is a candidate when its audio needs converting;
  // otherwise only very long ones get parts.
  const anyLength = partSource(item, { ...settings, minFrames: 0 })
  const format = anyLength ? await sourceFormat(ctx, itemId, anyLength) : null
  const reencode = needsReencode(format)
  const source = reencode ? anyLength : partSource(item, settings)
  const formatName = format
    ? `${format.codec}${format.profile ? ` ${format.profile}` : ''}`
    : format === undefined
      ? 'format check still running'
      : 'format unknown'
  let plan = null
  if (!source) {
    // Leave a trace either way, so "the web player never asked for parts" can be
    // told apart from "the server said this book doesn't need them".
    const files = includedAudioFiles(item)
    const f = files[0]
    appLog.info(
      'parts',
      `item ${itemId} plays as is (${files.length} audio file(s)` +
        (files.length === 1
          ? `, ${f?.mimeType || f?.metadata?.ext || 'unknown type'}, ${Math.round(Number(f?.duration) / 3600)}h`
          : '') +
        (anyLength ? `, ${formatName}` : '') +
        ')',
    )
  }
  if (source) {
    const targetSeconds = reencode
      ? positiveInt(process.env.HS_PARTS_REENCODE_SECONDS, DEFAULT_REENCODE_SECONDS)
      : settings.targetSeconds
    const parts = planParts({
      duration: source.duration,
      chapters: item.media?.chapters,
      targetSeconds,
    })
    plan = {
      source,
      parts,
      reencode,
      channels: format?.channels || 2,
      key: partCacheKey(itemId, source, parts, reencode ? 'aac-lc' : undefined),
    }
    appLog.info(
      'parts',
      `item ${itemId} uses ${parts.length} parts (${(source.duration / 3600).toFixed(1)}h single file, ${formatName}` +
        (reencode ? ', converting to AAC-LC' : '') +
        ')',
    )
  }

  if (planCache.size >= PLAN_CACHE_MAX) {
    // Drop the oldest entry (Map keeps insertion order).
    planCache.delete(planCache.keys().next().value)
  }
  planCache.set(cacheKey, { at: Date.now(), plan })
  return plan
}

// The header ctx from index.js, or one resolved from ?token= for media URLs.
async function contextFor(req, url, ctx) {
  if (ctx) return ctx
  const token = url.searchParams.get('token')
  if (!token) return null
  const shim = {
    method: req.method,
    url: req.url,
    headers: { ...req.headers, authorization: `Bearer ${token}` },
  }
  return resolveContext(shim)
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PartError('part_not_ready', 'still preparing')), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function partJob(ctx, itemId, plan, index) {
  const part = plan.parts[index]
  return {
    itemId,
    key: plan.key,
    index,
    start: part.start,
    end: Math.round((part.start + part.duration) * 1000) / 1000,
    sourceUrl: `${ctx.absUrl}/api/items/${encodeURIComponent(itemId)}/file/${encodeURIComponent(plan.source.ino)}`,
    absToken: ctx.absToken,
    reencode: plan.reencode,
    channels: plan.channels,
  }
}

export async function handleParts(req, res, url, rawCtx) {
  const p = url.pathname
  if (p !== '/hs/parts' && !p.startsWith('/hs/parts/')) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return (json(res, 405, { error: 'method_not_allowed' }), true)
  }

  const m = p.match(/^\/hs\/parts\/([^/]+)(?:\/([^/]+))?\/?$/)
  if (!m) return (json(res, 404, { error: 'not_found' }), true)
  const itemId = decodeURIComponent(m[1])
  if (!ITEM_ID_RE.test(itemId)) return (json(res, 404, { error: 'unknown_item' }), true)

  const ctx = await contextFor(req, url, rawCtx)
  if (ctx?.appDenied === 'insufficient_scope') {
    return (
      json(res, 403, { error: 'insufficient_scope', required_scope: ctx.requiredScope }),
      true
    )
  }
  if (ctx?.appDenied === 'rate_limited') {
    res.setHeader('Retry-After', String(ctx.retryAfter ?? 60))
    return (json(res, 429, { error: 'rate_limited', retry_after: ctx.retryAfter ?? 60 }), true)
  }
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  let plan
  try {
    plan = await loadPlan(ctx, itemId)
  } catch (err) {
    if (err instanceof RouteError) return (json(res, err.status, { error: err.code }), true)
    throw err
  }

  // The part list.
  if (m[2] === undefined) {
    if (!plan) return (json(res, 200, { parts: null }), true)
    // Optional ?prepare=<index>: start preparing the part the listener is about
    // to play without waiting for it, so the first media request does not sit
    // behind a cold ffmpeg run (some players give up on a slow first byte).
    const prep = url.searchParams.get('prepare')
    if (prep !== null && /^\d+$/.test(prep) && Number(prep) < plan.parts.length) {
      partCache()
        .getPart(partJob(ctx, itemId, plan, Number(prep)))
        .catch(() => {})
    }
    return (
      json(res, 200, {
        parts: plan.parts.map((part) => ({
          index: part.index,
          start: part.start,
          duration: part.duration,
          url: `/hs/parts/${encodeURIComponent(itemId)}/${part.index}`,
        })),
        source: { ino: plan.source.ino, duration: plan.source.duration },
      }),
      true
    )
  }

  // One part's bytes.
  if (!plan) return (json(res, 409, { error: 'parts_not_needed' }), true)
  if (!/^\d+$/.test(m[2])) return (json(res, 404, { error: 'unknown_part' }), true)
  const index = Number(m[2])
  if (index >= plan.parts.length) return (json(res, 404, { error: 'unknown_part' }), true)

  const pc = partCache()
  let filePath
  try {
    filePath = await withTimeout(pc.getPart(partJob(ctx, itemId, plan, index)), WAIT_MS)
  } catch (err) {
    if (err?.code === 'part_not_ready') {
      res.setHeader('Retry-After', '30')
      return (json(res, 503, { error: 'part_not_ready' }), true)
    }
    return (json(res, 502, { error: err?.code || 'part_failed' }), true)
  }

  // Get the next part ready while this one plays.
  if (index + 1 < plan.parts.length) pc.prefetch(partJob(ctx, itemId, plan, index + 1))
  void pc.touch(filePath)

  try {
    await sendFileWithRange(req, res, filePath, {
      contentType: 'audio/mp4',
      etag: `"${plan.key}-${index}"`,
      // The URL stays the same if the source file changes; the ETag does not.
      cacheControl: 'private, no-cache',
    })
  } catch (err) {
    // Evicted between lookup and read: rare, and a retry regenerates it.
    if (!res.headersSent) {
      res.setHeader('Retry-After', '5')
      return (json(res, 503, { error: 'part_not_ready' }), true)
    }
    res.destroy(err)
  }
  return true
}
