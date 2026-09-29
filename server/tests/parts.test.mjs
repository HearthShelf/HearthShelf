import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import {
  planParts,
  partSource,
  partSettings,
  estimateFrames,
  includedAudioFiles,
} from '../lib/partPlan.js'
import {
  createPartCache,
  partCacheKey,
  ffmpegArgs,
  spawnFfmpeg,
  PartError,
} from '../lib/partCache.js'
import { parseRange, sendFileWithRange } from '../lib/http.js'

const H = 3600
const T = 4 * H

function sum(parts) {
  return parts.reduce((s, p) => s + p.duration, 0)
}

function assertContiguous(parts, total) {
  assert.equal(parts[0].start, 0)
  parts.forEach((p, i) => {
    assert.equal(p.index, i)
    assert.ok(p.duration > 0, `part ${i} has a positive length`)
    if (i > 0) {
      const prev = parts[i - 1]
      assert.ok(
        Math.abs(prev.start + prev.duration - p.start) < 0.002,
        `part ${i} follows part ${i - 1}`,
      )
    }
  })
  assert.ok(Math.abs(sum(parts) - total) < 0.01, 'parts cover the whole book')
}

// --- planner ---------------------------------------------------------------

test('no chapters: cuts at the target length, remainder joins the last part', () => {
  const total = 70 * H
  const parts = planParts({ duration: total, chapters: [], targetSeconds: T })
  assertContiguous(parts, total)
  // 70 h: 16 x 4 h = 64 h leaves 6 h, which is exactly 1.5 targets -> one last part.
  assert.equal(parts.length, 17)
  parts.slice(0, -1).forEach((p) => assert.equal(p.duration, T))
  assert.equal(parts.at(-1).duration, 6 * H)
})

test('chapters: cuts land on chapter starts closest to the target', () => {
  // 30-minute chapters for 40 hours.
  const total = 40 * H
  const chapters = []
  for (let s = 0; s < total; s += 1800)
    chapters.push({ id: chapters.length, start: s, end: s + 1800 })
  const parts = planParts({ duration: total, chapters, targetSeconds: T })
  assertContiguous(parts, total)
  const starts = new Set(chapters.map((c) => c.start))
  parts.forEach((p) => assert.ok(starts.has(p.start), `part starts on a chapter (${p.start})`))
  parts.slice(0, -1).forEach((p) => assert.equal(p.duration, T))
})

test('chapters: grouping never exceeds 1.5x the target', () => {
  // Irregular chapters between 20 min and 3 h.
  const total = 50 * H
  const lens = [1200, 7200, 10800, 3600, 5400, 9000, 2400, 10800, 1800, 7200]
  const chapters = []
  let s = 0
  let i = 0
  while (s < total) {
    const len = lens[i++ % lens.length]
    chapters.push({ id: i, start: s, end: Math.min(total, s + len) })
    s += len
  }
  const parts = planParts({ duration: total, chapters, targetSeconds: T })
  assertContiguous(parts, total)
  parts.forEach((p) =>
    assert.ok(p.duration <= 1.5 * T + 0.001, `part ${p.index} is ${p.duration}s`),
  )
  parts.slice(0, -1).forEach((p) => assert.ok(p.duration >= 0.5 * T, `part ${p.index} is not tiny`))
})

test('a single chapter longer than the window is cut at the target length', () => {
  const total = 30 * H
  // Chapter 2 runs from 1 h to 29 h.
  const chapters = [
    { id: 0, start: 0, end: H },
    { id: 1, start: H, end: 29 * H },
    { id: 2, start: 29 * H, end: total },
  ]
  const parts = planParts({ duration: total, chapters, targetSeconds: T })
  assertContiguous(parts, total)
  // The 1 h chapter start is too early to be a cut, so the first cut is a time cut.
  assert.equal(parts[1].start, T)
  parts.forEach((p) => assert.ok(p.duration <= 1.5 * T + 0.001))
})

test('does not leave a tiny tail before the end', () => {
  const total = 13 * H
  // A chapter at 12.9 h would leave a 6-minute last part if chosen.
  const chapters = [
    { id: 0, start: 0, end: 5.9 * H },
    { id: 1, start: 5.9 * H, end: 12.9 * H },
    { id: 2, start: 12.9 * H, end: total },
  ]
  const parts = planParts({ duration: total, chapters, targetSeconds: T })
  assertContiguous(parts, total)
  parts.forEach((p) => assert.ok(p.duration >= 0.5 * T, `part ${p.index} is ${p.duration}s`))
})

test('plan is deterministic and ignores chapter order and duplicates', () => {
  const total = 60 * H
  const chapters = []
  for (let s = 0; s < total; s += 2700)
    chapters.push({ id: chapters.length, start: s + 0.123456, end: s + 2700 })
  const a = planParts({ duration: total, chapters, targetSeconds: T })
  const shuffled = [...chapters].reverse().concat(chapters.slice(0, 5))
  const b = planParts({ duration: total, chapters: shuffled, targetSeconds: T })
  assert.deepEqual(a, b)
  assert.deepEqual(a, planParts({ duration: total, chapters, targetSeconds: T }))
})

test('garbage chapters are ignored', () => {
  const total = 30 * H
  const chapters = [null, { start: 'x' }, { start: -5 }, { start: total + 10 }, { start: NaN }]
  const parts = planParts({ duration: total, chapters, targetSeconds: T })
  assertContiguous(parts, total)
})

// --- needs-parts decision ---------------------------------------------------

function book(files, extra = {}) {
  return { id: 'li_1', mediaType: 'book', media: { audioFiles: files, chapters: [] }, ...extra }
}
function file(duration, over = {}) {
  return {
    index: 1,
    ino: '12345',
    duration,
    mimeType: 'audio/mp4',
    metadata: { filename: 'a.m4b', ext: '.m4b', size: 3_700_000_000, mtimeMs: 1700000000000 },
    ...over,
  }
}

const settings = { minFrames: 4_500_000, targetSeconds: T }
const thresholdSeconds = 4_500_000 / (48000 / 1024) // 96000 s

test('threshold edges: exactly at the threshold does not split, just over does', () => {
  assert.equal(estimateFrames(thresholdSeconds), 4_500_000)
  assert.equal(partSource(book([file(thresholdSeconds)]), settings), null)
  const src = partSource(book([file(thresholdSeconds + 1)]), settings)
  assert.ok(src)
  assert.equal(src.ino, '12345')
  assert.equal(src.size, 3_700_000_000)
})

test('the 70-hour book needs parts; a 10-hour one does not', () => {
  assert.ok(partSource(book([file(70 * H)]), settings))
  assert.equal(partSource(book([file(10 * H)]), settings), null)
})

test('only single-file MP4-family books are split', () => {
  assert.equal(partSource(book([file(70 * H, { mimeType: 'audio/mpeg' })]), settings), null)
  assert.equal(partSource(book([file(40 * H), file(40 * H, { ino: '2' })]), settings), null)
  assert.equal(partSource(book([]), settings), null)
  assert.equal(partSource({ id: 'x', mediaType: 'podcast', media: {} }, settings), null)
  // Excluded and invalid files do not count.
  const withExcluded = book([file(70 * H), file(1 * H, { ino: '2', exclude: true })])
  assert.ok(partSource(withExcluded, settings))
  const withInvalid = book([file(70 * H), file(1 * H, { ino: '3', invalid: true })])
  assert.ok(partSource(withInvalid, settings))
  assert.equal(includedAudioFiles(withInvalid).length, 1)
  // No mimeType: fall back to the extension.
  const noMime = file(70 * H, { mimeType: undefined })
  assert.ok(partSource(book([noMime]), settings))
})

test('settings come from the environment with safe fallbacks', () => {
  assert.deepEqual(partSettings({}), { minFrames: 4_500_000, targetSeconds: 14400 })
  assert.deepEqual(partSettings({ HS_PARTS_MIN_FRAMES: '100', HS_PARTS_TARGET_SECONDS: '600' }), {
    minFrames: 100,
    targetSeconds: 600,
  })
  assert.deepEqual(partSettings({ HS_PARTS_MIN_FRAMES: 'abc', HS_PARTS_TARGET_SECONDS: '-1' }), {
    minFrames: 4_500_000,
    targetSeconds: 14400,
  })
})

// --- cache key + ffmpeg args ------------------------------------------------

test('cache key changes when the file or the plan changes', () => {
  const src = { ino: '1', size: 10, mtimeMs: 5, duration: 100 }
  const parts = [{ index: 0, start: 0, duration: 100 }]
  const k = partCacheKey('li_1', src, parts)
  assert.equal(k, partCacheKey('li_1', { ...src }, [...parts]))
  assert.notEqual(k, partCacheKey('li_1', { ...src, mtimeMs: 6 }, parts))
  assert.notEqual(k, partCacheKey('li_1', { ...src, ino: '2' }, parts))
  assert.notEqual(k, partCacheKey('li_1', src, [{ index: 0, start: 0, duration: 99 }]))
  assert.notEqual(k, partCacheKey('li_2', src, parts))
})

test('ffmpeg args stream-copy and keep the token out of the URL', () => {
  const args = ffmpegArgs({
    sourceUrl: 'http://abs/api/items/li_1/file/9',
    absToken: 'secret',
    start: 10,
    end: 20,
    outPath: '/tmp/x.tmp',
  })
  assert.ok(args.includes('copy'))
  assert.equal(args[args.indexOf('-c') + 1], 'copy')
  assert.equal(args[args.indexOf('-headers') + 1], 'Authorization: Bearer secret\r\n')
  assert.ok(!args.some((a) => a.startsWith('http') && a.includes('secret')))
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'))
  assert.ok(args.indexOf('-to') < args.indexOf('-i'))
  assert.equal(args.at(-1), '/tmp/x.tmp')
  assert.ok(args.includes('+faststart'))
})

// --- cache / in-flight / scheduling -----------------------------------------

const madeDirs = []
async function tmpDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-parts-'))
  madeDirs.push(d)
  return d
}
test.after(async () => {
  await Promise.all(madeDirs.map((d) => fs.rm(d, { recursive: true, force: true })))
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// A fake ffmpeg: records each run and lets the test decide when it finishes.
function fakeRunner({ bytes = 1000, auto = true } = {}) {
  const runs = []
  const run = async (args) => {
    const out = args.at(-1)
    const d = deferred()
    runs.push({ args, out, d })
    if (auto) d.resolve()
    await d.promise
    await fs.writeFile(out, Buffer.alloc(bytes, 1))
  }
  return { run, runs }
}

function job(index, extra = {}) {
  return {
    itemId: 'li_1',
    key: 'k1',
    index,
    start: index * 10,
    end: index * 10 + 10,
    sourceUrl: 'http://abs/src',
    absToken: 't',
    ...extra,
  }
}

const tick = () => new Promise((r) => setImmediate(r))

async function waitFor(cond, label) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}
const runIndexes = (f) => f.runs.map((r) => path.basename(r.out).split('.')[0])

test('concurrent requests share one ffmpeg run, and the result is atomic', async () => {
  const dir = await tmpDir()
  const f = fakeRunner({ auto: false })
  const pc = createPartCache({ dir, maxBytes: 1e9, runFfmpeg: f.run })
  const a = pc.getPart(job(0))
  const b = pc.getPart(job(0))
  const c = pc.getPart(job(0))
  await tick()
  await tick()
  assert.equal(f.runs.length, 1)
  // Nothing at the final path while ffmpeg is still writing.
  assert.equal(fsSync.existsSync(pc.partPath('li_1', 'k1', 0)), false)
  f.runs[0].d.resolve()
  const [pa, pb, pcc] = await Promise.all([a, b, c])
  assert.equal(pa, pb)
  assert.equal(pb, pcc)
  assert.ok(fsSync.existsSync(pa))
  const leftovers = (await fs.readdir(path.dirname(pa))).filter((n) => n.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
  // Cached now: no second run.
  await pc.getPart(job(0))
  assert.equal(f.runs.length, 1)
})

test('a failed run leaves no file and can be retried', async () => {
  const dir = await tmpDir()
  let fail = true
  const run = async (args) => {
    await fs.writeFile(args.at(-1), 'partial')
    if (fail) throw new PartError('ffmpeg_failed', 'boom')
  }
  const pc = createPartCache({ dir, maxBytes: 1e9, runFfmpeg: run })
  await assert.rejects(pc.getPart(job(0)), (err) => err.code === 'ffmpeg_failed')
  const partDir = path.dirname(pc.partPath('li_1', 'k1', 0))
  assert.deepEqual(await fs.readdir(partDir), [])
  fail = false
  const p = await pc.getPart(job(0))
  assert.equal(await fs.readFile(p, 'utf8'), 'partial')
})

test('an empty output counts as a failure', async () => {
  const dir = await tmpDir()
  const pc = createPartCache({
    dir,
    maxBytes: 1e9,
    runFfmpeg: async (args) => fs.writeFile(args.at(-1), ''),
  })
  await assert.rejects(pc.getPart(job(0)), (err) => err.code === 'ffmpeg_failed')
})

test('jobs are bounded, and prefetches wait for an idle cache', async () => {
  const dir = await tmpDir()
  const f = fakeRunner({ auto: false })
  const pc = createPartCache({ dir, maxBytes: 1e9, maxJobs: 2, runFfmpeg: f.run })
  const p0 = pc.getPart(job(0))
  pc.prefetch(job(1))
  const p2 = pc.getPart(job(2))
  const p3 = pc.getPart(job(3))
  // Two listener jobs run; the third listener and the prefetch wait.
  await waitFor(() => f.runs.length === 2, 'two runs')
  assert.deepEqual(runIndexes(f), ['0', '2'])
  assert.equal(pc.stats().queued, 2)
  f.runs[0].d.resolve()
  await p0
  // The listener's part 3 goes before the queued prefetch of part 1.
  await waitFor(() => f.runs.length === 3, 'third run')
  assert.equal(runIndexes(f)[2], '3')
  f.runs[1].d.resolve()
  f.runs[2].d.resolve()
  await Promise.all([p2, p3])
  // Idle now, so the prefetch runs.
  await waitFor(() => f.runs.length === 4, 'prefetch run')
  assert.equal(runIndexes(f)[3], '1')
  f.runs[3].d.resolve()
  await waitFor(() => fsSync.existsSync(pc.partPath('li_1', 'k1', 1)), 'prefetched part')
})

test('a listener asking for a queued prefetch promotes it', async () => {
  const dir = await tmpDir()
  const f = fakeRunner({ auto: false })
  const pc = createPartCache({ dir, maxBytes: 1e9, maxJobs: 2, runFfmpeg: f.run })
  const p0 = pc.getPart(job(0))
  pc.prefetch(job(1))
  await waitFor(() => f.runs.length === 1, 'first run')
  await tick()
  // The prefetch cannot start while part 0 runs...
  assert.equal(f.runs.length, 1)
  // ...but a listener asking for the same part can, and shares the job.
  const p1 = pc.getPart(job(1))
  await waitFor(() => f.runs.length === 2, 'promoted run')
  assert.equal(runIndexes(f)[1], '1')
  f.runs[0].d.resolve()
  f.runs[1].d.resolve()
  await Promise.all([p0, p1])
  await tick()
  assert.equal(f.runs.length, 2)
})

test('prefetch is a no-op for a part that is ready or in flight', async () => {
  const dir = await tmpDir()
  const f = fakeRunner()
  const pc = createPartCache({ dir, maxBytes: 1e9, runFfmpeg: f.run })
  await pc.getPart(job(0))
  pc.prefetch(job(0))
  await tick()
  assert.equal(f.runs.length, 1)
})

test('LRU eviction removes the least recently used parts past the cap', async () => {
  const dir = await tmpDir()
  let clock = 1_000_000
  const f = fakeRunner({ bytes: 400 })
  const pc = createPartCache({ dir, maxBytes: 1000, runFfmpeg: f.run, now: () => clock })
  const p0 = await pc.getPart(job(0))
  await pc.evict()
  const p1 = await pc.getPart(job(1))
  await pc.evict()
  // Make part 0 the most recent and part 1 the oldest.
  await fs.utimes(p1, new Date(clock - 50_000), new Date(clock - 50_000))
  clock += 120_000
  await pc.touch(p0)
  const p2 = await pc.getPart(job(2))
  await pc.evict()
  // 1200 bytes > 1000: the oldest (part 1) goes, the just-made part 2 stays.
  assert.ok(fsSync.existsSync(p0))
  assert.equal(fsSync.existsSync(p1), false)
  assert.ok(fsSync.existsSync(p2))
})

test('the part just produced is kept even when it alone exceeds the cap', async () => {
  const dir = await tmpDir()
  const f = fakeRunner({ bytes: 5000 })
  const pc = createPartCache({ dir, maxBytes: 1000, runFfmpeg: f.run })
  const p = await pc.getPart(job(0))
  // The pass started by the run itself must spare the new part.
  await pc.settled()
  assert.ok(fsSync.existsSync(p))
  // A later pass (nothing just made) may evict it.
  await pc.evict()
  assert.equal(fsSync.existsSync(p), false)
})

test('stale temp files are cleaned up; fresh ones are left alone', async () => {
  const dir = await tmpDir()
  const clock = Date.now()
  const pc = createPartCache({ dir, maxBytes: 1e9, runFfmpeg: fakeRunner().run, now: () => clock })
  const sub = path.join(dir, 'li_9_k')
  await fs.mkdir(sub, { recursive: true })
  const stale = path.join(sub, '0.m4a.aaaa.tmp')
  const fresh = path.join(sub, '1.m4a.bbbb.tmp')
  await fs.writeFile(stale, 'x')
  await fs.writeFile(fresh, 'x')
  const old = new Date(clock - 3 * 60 * 60 * 1000)
  await fs.utimes(stale, old, old)
  await pc.evict()
  assert.equal(fsSync.existsSync(stale), false)
  assert.ok(fsSync.existsSync(fresh))
})

// --- HTTP range serving -----------------------------------------------------

test('parseRange handles the common forms', () => {
  assert.equal(parseRange(undefined, 100), null)
  assert.equal(parseRange('items=0-1', 100), null)
  assert.equal(parseRange('bytes=0-1,5-6', 100), null)
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 })
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 })
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=20-10', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable')
})

async function withFileServer(filePath, fn) {
  const server = http.createServer((req, res) => {
    sendFileWithRange(req, res, filePath, { contentType: 'audio/mp4', etag: '"v1"' })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/`
  try {
    await fn(base)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('sendFileWithRange serves 200, 206, 416 and honours If-Range', async () => {
  const dir = await tmpDir()
  const fp = path.join(dir, 'f.m4a')
  const data = Buffer.from([...Array(256).keys()])
  await fs.writeFile(fp, data)
  await withFileServer(fp, async (base) => {
    let r = await fetch(base)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('accept-ranges'), 'bytes')
    assert.equal(r.headers.get('content-length'), '256')
    assert.equal(r.headers.get('content-type'), 'audio/mp4')
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), data)

    r = await fetch(base, { headers: { Range: 'bytes=10-19' } })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), 'bytes 10-19/256')
    assert.equal(r.headers.get('content-length'), '10')
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(10, 20))

    r = await fetch(base, { headers: { Range: 'bytes=-6' } })
    assert.equal(r.status, 206)
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(250))

    r = await fetch(base, { headers: { Range: 'bytes=999-' } })
    assert.equal(r.status, 416)
    assert.equal(r.headers.get('content-range'), 'bytes */256')
    await r.arrayBuffer()

    r = await fetch(base, { headers: { Range: 'bytes=0-9', 'If-Range': '"old"' } })
    assert.equal(r.status, 200)
    await r.arrayBuffer()

    r = await fetch(base, { method: 'HEAD', headers: { Range: 'bytes=0-9' } })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-length'), '10')
  })
})

// --- ffmpeg integration (skipped when ffmpeg is not installed) ---------------

const FFMPEG = process.env.HS_FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.HS_FFPROBE_PATH || 'ffprobe'
const hasFfmpeg =
  spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status === 0

function probeDuration(file) {
  const out = spawnSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  )
  return Number(out.stdout.trim())
}

// Top-level MP4 boxes in file order: [{ type, size }].
function topBoxes(buf) {
  const boxes = []
  let off = 0
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8))
    else if (size === 0) size = buf.length - off
    boxes.push({ type, size })
    if (size < 8) break
    off += size
  }
  return boxes
}

test(
  'ffmpeg splits a real AAC m4a read over authenticated HTTP',
  { skip: hasFfmpeg ? false : 'ffmpeg/ffprobe not installed' },
  async () => {
    const dir = await tmpDir()
    const src = path.join(dir, 'source.m4a')
    const made = spawnSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=60',
      '-c:a',
      'aac',
      '-f',
      'mp4',
      src,
    ])
    assert.equal(made.status, 0, String(made.stderr))
    const total = probeDuration(src)

    // A stand-in for ABS: range-capable, and it insists on the bearer token.
    const server = http.createServer((req, res) => {
      if (req.headers['authorization'] !== 'Bearer tok') {
        res.writeHead(401)
        res.end()
        return
      }
      sendFileWithRange(req, res, src, { contentType: 'audio/mp4' })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const sourceUrl = `http://127.0.0.1:${server.address().port}/api/items/li_1/file/1`
    try {
      const plan = planParts({ duration: total, chapters: [], targetSeconds: 20 })
      assert.equal(plan.length, 3)
      const pc = createPartCache({
        dir: path.join(dir, 'cache'),
        maxBytes: 1e9,
        runFfmpeg: (args) => spawnFfmpeg(args),
      })
      const srcMoov = topBoxes(await fs.readFile(src)).find((b) => b.type === 'moov').size
      let partsTotal = 0
      for (const p of plan) {
        const file = await pc.getPart({
          itemId: 'li_1',
          key: 'int',
          index: p.index,
          start: p.start,
          end: p.start + p.duration,
          sourceUrl,
          absToken: 'tok',
        })
        const d = probeDuration(file)
        assert.ok(
          Math.abs(d - p.duration) < 0.2,
          `part ${p.index}: ${d}s vs planned ${p.duration}s`,
        )
        partsTotal += d
        const boxes = topBoxes(await fs.readFile(file))
        const types = boxes.map((b) => b.type)
        assert.ok(
          types.indexOf('moov') !== -1 && types.indexOf('moov') < types.indexOf('mdat'),
          'moov first',
        )
        const moov = boxes.find((b) => b.type === 'moov').size
        assert.ok(
          moov < srcMoov,
          `part ${p.index} has its own smaller index (${moov} < ${srcMoov})`,
        )
      }
      assert.ok(Math.abs(partsTotal - total) < 0.3, `parts sum ${partsTotal}s vs source ${total}s`)
    } finally {
      await new Promise((r) => server.close(r))
    }
  },
)
