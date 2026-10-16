// On-disk cache of ready-made audiobook parts (see lib/partPlan.js for why).
//
// Each part is cut from the ABS source file with a stream-copying ffmpeg run
// (never re-encoded) and stored under QG_DATA_DIR/parts-cache. Guarantees:
//
//   - One ffmpeg run per part, however many requests arrive at once: concurrent
//     callers share the in-flight job.
//   - Atomic: ffmpeg writes a temp file that is renamed into place only after a
//     clean exit, so a reader never sees a half-written part.
//   - Bounded work: at most `maxJobs` ffmpeg processes at a time (each one has to
//     load the source's whole sample table, which is big for exactly these
//     books). Background prefetches only start when nothing else is running, and
//     a listener's request always goes ahead of queued prefetches.
//   - Bounded disk: least-recently-used parts are evicted past `maxBytes`.
//
// The ffmpeg runner is injectable so the cache logic is testable without ffmpeg.

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const PART_EXT = '.m4a'
const TMP_SUFFIX = '.tmp'
// A temp file older than this is an orphan from a crashed run.
const STALE_TMP_MS = 2 * 60 * 60 * 1000
// How often a served part's LRU timestamp is refreshed (avoids a disk write on
// every range request a player makes).
const TOUCH_INTERVAL_MS = 60 * 1000
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000

export class PartError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// Stable cache key for a source file + part plan. Any change to the file (inode,
// size, mtime, duration) or to the cut points gives a new key, so stale parts
// are never served; the old ones simply age out of the LRU.
// `variant` names how the audio is produced ('aac-lc' when converting); it is
// left out of the basis when unset, so existing copied parts keep their keys.
export function partCacheKey(itemId, source, parts, variant) {
  const basis = JSON.stringify({
    ...(variant ? { variant } : {}),
    // v2: parts are written with the M4A brand (see ffmpegArgs).
    // v3: parts in a profile browsers can't all decode are re-encoded to
    // AAC-LC (see needsReencode); bumping re-cuts parts made before.
    v: 3,
    itemId,
    ino: source.ino,
    size: source.size || 0,
    mtimeMs: source.mtimeMs || 0,
    duration: source.duration,
    cuts: parts.map((p) => [p.start, p.duration]),
  })
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

// ffmpeg arguments for one part. The Authorization header is passed with
// -headers so the token never appears in the URL. Stream copy only.
export function ffmpegArgs({ sourceUrl, absToken, start, end, outPath }) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y']
  if (absToken) args.push('-headers', `Authorization: Bearer ${absToken}\r\n`)
  args.push(
    '-ss',
    String(start),
    '-to',
    String(end),
    '-i',
    sourceUrl,
    '-map',
    '0:a:0',
    // Chapters come from ABS on the book's own timeline; embedded ones would be
    // on the part's timeline and only confuse players.
    '-map_chapters',
    '-1',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    // The iPod/M4A muxer, not plain mp4: same audio and layout, but the file
    // header says "M4A" (audio) instead of ffmpeg's generic "isom" video brand.
    // Tesla's browser refused isom parts outright (MediaError 4) while playing
    // M4A/M4B files, and an audiobook part should look like one anyway.
    '-f',
    'ipod',
    outPath,
  )
  return args
}

// AAC profiles every browser decodes. Anything else (xHE-AAC/USAC above all,
// which Audible ships for some newer titles and older ffprobe builds label as
// plain "aac") plays on Windows and Android but not in Linux Chrome - the Tesla
// browser among them - so such parts are re-encoded to AAC-LC.
const BROWSER_SAFE_AAC_PROFILES = new Set(['LC', 'HE-AAC', 'HE-AACv2'])

export function needsReencode(probe) {
  if (!probe) return false // unknown: keep the copy, as before
  if (probe.codec !== 'aac') return true
  return !BROWSER_SAFE_AAC_PROFILES.has(probe.profile)
}

// ffmpeg arguments to re-encode a cut part to AAC-LC (local file to local file).
// ~64 kbit/s per channel, which is transparent for speech.
export function reencodeArgs({ inPath, outPath, channels }) {
  const ch = Math.min(Math.max(Number(channels) || 2, 1), 2)
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inPath,
    '-map',
    '0:a:0',
    '-map_chapters',
    '-1',
    '-c:a',
    'aac',
    '-ac',
    String(ch),
    '-b:a',
    `${64 * ch}k`,
    '-movflags',
    '+faststart',
    '-f',
    'ipod',
    outPath,
  ]
}

// ffmpeg arguments to cut AND re-encode one part straight from the ABS source, in
// one pass. Used for books whose audio needs converting (see needsReencode):
// such books are planned in short parts, so each one is ready in seconds.
export function transcodeArgs({ sourceUrl, absToken, start, end, outPath, channels }) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y']
  if (absToken) args.push('-headers', `Authorization: Bearer ${absToken}\r\n`)
  const ch = Math.min(Math.max(Number(channels) || 2, 1), 2)
  args.push(
    '-ss',
    String(start),
    '-to',
    String(end),
    '-i',
    sourceUrl,
    '-map',
    '0:a:0',
    '-map_chapters',
    '-1',
    '-c:a',
    'aac',
    '-ac',
    String(ch),
    '-b:a',
    `${64 * ch}k`,
    '-movflags',
    '+faststart',
    '-f',
    'ipod',
    outPath,
  )
  return args
}

// The first audio stream's codec + profile, or null if ffprobe is missing or
// fails. Takes a local file or an ABS file URL (with its token, sent as a header
// so it never appears in a URL). For a URL ffprobe only reads the file's index.
export function spawnProbe(filePath, absToken = '') {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(
      process.env.HS_FFPROBE_PATH || 'ffprobe',
      [
        ...(absToken ? ['-headers', `Authorization: Bearer ${absToken}\r\n`] : []),
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_name,profile,channels,sample_rate',
        '-of',
        'json',
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    timer.unref?.()
    child.stdout.on('data', (d) => {
      if (out.length < 8000) out += d.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve(null)
      try {
        const st = JSON.parse(out)?.streams?.[0]
        if (!st) return resolve(null)
        resolve({
          codec: String(st.codec_name || ''),
          profile: String(st.profile || ''),
          channels: Number(st.channels) || 0,
          sampleRate: Number(st.sample_rate) || 0,
        })
      } catch {
        resolve(null)
      }
    })
  })
}

// Default runner: spawn the system ffmpeg. Resolves on exit 0, rejects with a
// PartError otherwise. stderr is kept (capped) for the error message but the
// argument list - which holds the token - is never included in it.
export function spawnFfmpeg(args, { timeoutMs = DEFAULT_JOB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let settled = false
    const child = spawn(process.env.HS_FFMPEG_PATH || 'ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new PartError('ffmpeg_timeout', 'ffmpeg took too long to prepare the part'))
    }, timeoutMs)
    timer.unref?.()

    function finish(err) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }

    child.stderr.on('data', (d) => {
      if (stderr.length < 4000) stderr += d.toString()
    })
    child.on('error', (err) => {
      finish(
        err?.code === 'ENOENT'
          ? new PartError('ffmpeg_missing', 'ffmpeg is not installed on this server')
          : new PartError('ffmpeg_failed', String(err?.message || err)),
      )
    })
    child.on('close', (code) => {
      if (code === 0) finish(null)
      else
        finish(
          new PartError(
            'ffmpeg_failed',
            `ffmpeg exited with code ${code}: ${stderr.trim().slice(-500) || 'no output'}`,
          ),
        )
    })
  })
}

/**
 * @param {object} opts
 * @param {string} opts.dir         cache root
 * @param {number} opts.maxBytes    LRU cap for all cached parts
 * @param {number} [opts.maxJobs]   ffmpeg runs at once (default 2)
 * @param {(args: string[]) => Promise<void>} [opts.runFfmpeg]
 * @param {(level: 'info'|'warn', msg: string) => void} [opts.log]
 * @param {() => number} [opts.now]
 */
export function createPartCache(opts) {
  const dir = opts.dir
  const maxBytes = opts.maxBytes
  const maxJobs = Math.max(1, opts.maxJobs ?? 2)
  const runFfmpeg = opts.runFfmpeg ?? ((args) => spawnFfmpeg(args))
  // A test that fakes ffmpeg writes fake parts; probing those is pointless.
  const probeAudio = opts.probeAudio ?? (opts.runFfmpeg ? async () => null : spawnProbe)
  const log = opts.log ?? (() => {})
  const now = opts.now ?? (() => Date.now())

  const inflight = new Map() // finalPath -> Promise<string>
  const queue = [] // { run, prefetch }
  let running = 0
  const lastTouch = new Map() // finalPath -> ms
  let evicting = null

  function partPath(itemId, key, index) {
    return path.join(dir, `${itemId}_${key}`, `${index}${PART_EXT}`)
  }

  function pump() {
    while (queue.length) {
      const next = queue[0]
      // A prefetch only starts on an idle cache, so it can never hold up a
      // listener's own request for longer than one part takes.
      if (next.prefetch ? running > 0 : running >= maxJobs) return
      queue.shift()
      running++
      next.run().finally(() => {
        running--
        pump()
      })
    }
  }

  function schedule(run, prefetch, finalPath) {
    return new Promise((resolve, reject) => {
      const entry = {
        prefetch,
        finalPath,
        run: () => run().then(resolve, reject),
      }
      if (prefetch) {
        queue.push(entry)
      } else {
        // Listener requests go ahead of every queued prefetch, behind earlier
        // listener requests.
        const firstPrefetch = queue.findIndex((e) => e.prefetch)
        if (firstPrefetch === -1) queue.push(entry)
        else queue.splice(firstPrefetch, 0, entry)
      }
      pump()
    })
  }

  // A queued prefetch that a listener now wants is promoted to the front.
  function promote(finalPath) {
    const i = queue.findIndex((e) => e.prefetch && e.finalPath === finalPath)
    if (i === -1) return
    const [entry] = queue.splice(i, 1)
    entry.prefetch = false
    const firstPrefetch = queue.findIndex((e) => e.prefetch)
    if (firstPrefetch === -1) queue.push(entry)
    else queue.splice(firstPrefetch, 0, entry)
    pump()
  }

  async function generate(job, finalPath) {
    const partDir = path.dirname(finalPath)
    await fs.mkdir(partDir, { recursive: true })
    const tmpPath = `${finalPath}.${crypto.randomBytes(4).toString('hex')}${TMP_SUFFIX}`
    const started = now()
    let reencodePath = null
    try {
      const cut = {
        sourceUrl: job.sourceUrl,
        absToken: job.absToken,
        start: job.start,
        end: job.end,
        outPath: tmpPath,
      }
      await runFfmpeg(
        job.reencode ? transcodeArgs({ ...cut, channels: job.channels }) : ffmpegArgs(cut),
      )
      let st = await fs.stat(tmpPath).catch(() => null)
      if (!st || st.size === 0) {
        throw new PartError('ffmpeg_failed', 'ffmpeg finished without writing the part')
      }
      // A part planned for converting is already AAC-LC. A copied part is
      // checked, as a safety net for audio the plan-time check missed.
      const probe = job.reencode ? null : await probeAudio(tmpPath)
      const audio = job.reencode
        ? 'converted to AAC-LC'
        : probe
          ? `${probe.codec}${probe.profile ? ` ${probe.profile}` : ''}`
          : 'audio unknown'
      let note = ''
      if (!job.reencode && needsReencode(probe)) {
        // Copied audio some browsers cannot decode: re-encode this part.
        reencodePath = `${tmpPath}.aac${TMP_SUFFIX}`
        await runFfmpeg(
          reencodeArgs({ inPath: tmpPath, outPath: reencodePath, channels: probe.channels }),
        )
        st = await fs.stat(reencodePath).catch(() => null)
        if (!st || st.size === 0) {
          throw new PartError('ffmpeg_failed', 'ffmpeg finished without re-encoding the part')
        }
        await fs.rm(tmpPath, { force: true })
        await fs.rename(reencodePath, finalPath)
        reencodePath = null
        note = ', re-encoded to AAC-LC'
      } else {
        await fs.rename(tmpPath, finalPath)
      }
      const secs = ((now() - started) / 1000).toFixed(1)
      const mb = (st.size / (1024 * 1024)).toFixed(1)
      log(
        'info',
        `item ${job.itemId} part ${job.index} ready in ${secs}s (${mb} MB, ${audio}${note}${job.prefetch ? ', prepared ahead' : ''})`,
      )
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      if (reencodePath) await fs.rm(reencodePath, { force: true }).catch(() => {})
      log('warn', `item ${job.itemId} part ${job.index} failed: ${err?.message || err}`)
      throw err instanceof PartError
        ? err
        : new PartError('ffmpeg_failed', String(err?.message || err))
    }
    void evict(finalPath)
    return finalPath
  }

  /**
   * Resolve the path of a ready part, generating it if needed.
   * job: { itemId, key, index, start, end, sourceUrl, absToken, prefetch?,
   *        reencode?, channels? }
   */
  async function getPart(job) {
    const finalPath = partPath(job.itemId, job.key, job.index)
    if (fsSync.existsSync(finalPath)) return finalPath
    const existing = inflight.get(finalPath)
    if (existing) {
      if (!job.prefetch) promote(finalPath)
      return existing
    }
    const p = schedule(
      async () => {
        // It may have been produced while this job sat in the queue.
        if (fsSync.existsSync(finalPath)) return finalPath
        return generate(job, finalPath)
      },
      !!job.prefetch,
      finalPath,
    )
    const tracked = p.finally(() => inflight.delete(finalPath))
    inflight.set(finalPath, tracked)
    return tracked
  }

  // Fire-and-forget: prepare a part in the background if it is not ready yet.
  function prefetch(job) {
    const finalPath = partPath(job.itemId, job.key, job.index)
    if (inflight.has(finalPath) || fsSync.existsSync(finalPath)) return
    getPart({ ...job, prefetch: true }).catch(() => {})
  }

  // Record a read for LRU purposes (file mtime is the recency marker).
  async function touch(finalPath) {
    const t = now()
    if (t - (lastTouch.get(finalPath) ?? 0) < TOUCH_INTERVAL_MS) return
    lastTouch.set(finalPath, t)
    const d = new Date(t)
    await fs.utimes(finalPath, d, d).catch(() => {})
  }

  async function listEntries() {
    const entries = []
    let dirs = []
    try {
      dirs = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return entries
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const sub = path.join(dir, d.name)
      let files = []
      try {
        files = await fs.readdir(sub)
      } catch {
        continue
      }
      if (files.length === 0) {
        await fs.rmdir(sub).catch(() => {})
        continue
      }
      for (const f of files) {
        const full = path.join(sub, f)
        const st = await fs.stat(full).catch(() => null)
        if (!st?.isFile()) continue
        entries.push({
          path: full,
          size: st.size,
          mtimeMs: st.mtimeMs,
          tmp: f.endsWith(TMP_SUFFIX),
        })
      }
    }
    return entries
  }

  // Drop orphaned temp files and, past the cap, the least recently used parts.
  // `keep` (the part just produced) is never evicted, even if it alone is over
  // the cap. Serialized so two finishing jobs do not both scan and delete.
  function evict(keep) {
    evicting = (evicting ?? Promise.resolve()).then(() => evictNow(keep)).catch(() => {})
    return evicting
  }

  async function evictNow(keep) {
    const entries = await listEntries()
    const t = now()
    const parts = []
    for (const e of entries) {
      if (e.tmp) {
        if (t - e.mtimeMs > STALE_TMP_MS) await fs.rm(e.path, { force: true }).catch(() => {})
        continue
      }
      parts.push(e)
    }
    let total = parts.reduce((sum, e) => sum + e.size, 0)
    if (total <= maxBytes) return
    parts.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
    for (const e of parts) {
      if (total <= maxBytes) break
      if (e.path === keep || inflight.has(e.path)) continue
      try {
        await fs.rm(e.path, { force: true })
        total -= e.size
        lastTouch.delete(e.path)
        log('info', `evicted ${path.basename(path.dirname(e.path))}/${path.basename(e.path)}`)
      } catch {
        // A part being read on Windows cannot be removed; try the next one.
      }
    }
    // Tidy directories the eviction emptied.
    for (const e of parts) {
      await fs.rmdir(path.dirname(e.path)).catch(() => {})
    }
  }

  return {
    dir,
    partPath,
    getPart,
    prefetch,
    touch,
    evict,
    // Resolves once any eviction pass already started has finished.
    settled: () => evicting ?? Promise.resolve(),
    // Test/debug visibility.
    stats: () => ({ running, queued: queue.length, inflight: inflight.size }),
  }
}
