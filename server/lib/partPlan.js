// Part planning for oversized single-file MP4 audiobooks.
//
// A very long single-file m4b (70 h, 10+ million AAC frames) carries an MP4
// sample table so large that phone and car players run out of memory loading
// it. Instead of asking anyone to split their files, the backend serves such a
// book as a few ready-made parts, each with its own small index. This module is
// the pure half of that: deciding WHETHER a book needs parts and WHERE to cut.
// It never touches the network or disk, so it is fully unit-testable.
//
// Clients cache the part list, so the plan must be deterministic: the same item
// (duration + chapters) and the same settings always produce the same parts.

// Worst-case AAC frame rate: 1024 samples per frame at 48 kHz. Using the worst
// case keeps the check conservative when the real sample rate is lower.
const FRAMES_PER_SECOND = 48000 / 1024

const DEFAULT_MIN_FRAMES = 4_500_000 // ~26.7 hours at 48 kHz
const DEFAULT_TARGET_SECONDS = 14400 // 4 hours

// A chapter start is only used as a cut if it lands between half and one and a
// half target lengths into the part, and leaves at least half a target after it.
// That keeps every part except a short book's single remainder reasonably sized.
const MIN_PART_RATIO = 0.5
const MAX_PART_RATIO = 1.5

const MP4_MIME = 'audio/mp4'
const MP4_EXTS = new Set(['.m4b', '.m4a', '.mp4'])

function positiveNumber(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Settings read from the environment on each call so tests (and a restart) pick
// up changes without module caching surprises.
export function partSettings(env = process.env) {
  return {
    minFrames: positiveNumber(env.HS_PARTS_MIN_FRAMES, DEFAULT_MIN_FRAMES),
    targetSeconds: positiveNumber(env.HS_PARTS_TARGET_SECONDS, DEFAULT_TARGET_SECONDS),
  }
}

export function estimateFrames(durationSeconds) {
  return durationSeconds * FRAMES_PER_SECOND
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}

// The audio files ABS would actually play: not excluded by the admin, not
// flagged invalid by the scanner (ABS's own Book.includedAudioFiles filters on
// `exclude`; `invalid` is honoured too for older/newer ABS shapes).
export function includedAudioFiles(item) {
  const files = item?.media?.audioFiles
  if (!Array.isArray(files)) return []
  return files.filter((af) => af && !af.exclude && !af.invalid)
}

function isMp4Family(af) {
  if (typeof af?.mimeType === 'string' && af.mimeType.toLowerCase() === MP4_MIME) return true
  const ext = typeof af?.metadata?.ext === 'string' ? af.metadata.ext.toLowerCase() : ''
  return !af?.mimeType && MP4_EXTS.has(ext)
}

// The single MP4-family source file of an item that needs splitting, or null.
// `settings` defaults to the env-backed ones.
export function partSource(item, settings = partSettings()) {
  if (item?.mediaType && item.mediaType !== 'book') return null
  const files = includedAudioFiles(item)
  if (files.length !== 1) return null
  const af = files[0]
  if (!isMp4Family(af)) return null
  if (typeof af.ino !== 'string' && typeof af.ino !== 'number') return null
  const duration = Number(af.duration)
  if (!Number.isFinite(duration) || duration <= 0) return null
  if (estimateFrames(duration) <= settings.minFrames) return null
  return {
    ino: String(af.ino),
    duration,
    size: Number(af.metadata?.size) || 0,
    mtimeMs: Number(af.metadata?.mtimeMs) || 0,
  }
}

// Sorted, de-duplicated chapter starts strictly inside (0, duration).
function chapterStarts(chapters, duration) {
  if (!Array.isArray(chapters)) return []
  const starts = chapters
    .map((c) => Number(c?.start))
    .filter((s) => Number.isFinite(s) && s > 0 && s < duration)
    .map(round3)
    .sort((a, b) => a - b)
  return starts.filter((s, i) => i === 0 || s !== starts[i - 1])
}

/**
 * Plan contiguous parts covering [0, duration].
 *
 * Greedy from the start of the book. For each part beginning at S:
 *   - if what is left fits in one and a half targets, it all becomes the last part;
 *   - else cut at the chapter start closest to S + target among those between
 *     S + 0.5 target and S + 1.5 target that also leave at least half a target
 *     behind (ties go to the earlier chapter);
 *   - else (a chapter longer than that window, or no chapters) cut at S + target.
 *
 * Returns [{ index, start, duration }] in seconds, sorted by index.
 */
export function planParts({ duration, chapters, targetSeconds }) {
  const total = Number(duration)
  const target = Number(targetSeconds)
  if (!Number.isFinite(total) || total <= 0) return []
  if (!Number.isFinite(target) || target <= 0) {
    return [{ index: 0, start: 0, duration: round3(total) }]
  }

  const starts = chapterStarts(chapters, total)
  const cuts = [0]
  let s = 0
  // Hard stop so a pathological input can never spin forever.
  const maxParts = Math.ceil(total / (target * MIN_PART_RATIO)) + 2
  while (cuts.length < maxParts) {
    const remaining = total - s
    if (remaining <= target * MAX_PART_RATIO) break

    const lo = s + target * MIN_PART_RATIO
    const hi = Math.min(s + target * MAX_PART_RATIO, total - target * MIN_PART_RATIO)
    const ideal = s + target
    let best = null
    for (const c of starts) {
      if (c < lo) continue
      if (c > hi) break
      if (best === null || Math.abs(c - ideal) < Math.abs(best - ideal)) best = c
    }
    const next = best ?? round3(ideal)
    if (next <= s) break
    cuts.push(next)
    s = next
  }

  return cuts.map((start, index) => {
    const end = index + 1 < cuts.length ? cuts[index + 1] : total
    return { index, start: round3(start), duration: round3(end - start) }
  })
}
