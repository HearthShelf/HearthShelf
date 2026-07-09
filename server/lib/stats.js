// Pure listening-stats math for /hs/stats. Mirrors @hearthshelf/core's
// src/lib/stats.ts (the server is standalone ESM and doesn't bundle core, so the
// algorithm is duplicated here; keep the two in sync). Folds a raw ABS
// /api/me/listening-stats payload into the computed HSListeningStats shape.
//
// Day bucketing is in the CALLER's local time. The server can't know the
// caller's timezone, so the route reconstructs a caller-local `now` from a
// tzOffset (minutes, as from JS getTimezoneOffset) and passes it here.

function dayKey(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// `now` here is a Date already shifted into the caller's local wall-clock, read
// via its UTC accessors (so dayKey is stable regardless of the server's TZ).
function daySeconds(byDay, now, offset) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset))
  return byDay[dayKey(d)] ?? 0
}

function weekSeconds(byDay, now) {
  let total = 0
  for (let i = 0; i < 7; i++) total += daySeconds(byDay, now, i)
  return total
}

function computeStreak(byDay, now) {
  let streak = 0
  const startOffset = daySeconds(byDay, now, 0) > 0 ? 0 : 1
  for (let i = startOffset; i < 365; i++) {
    if (daySeconds(byDay, now, i) > 0) streak++
    else break
  }
  return streak
}

function activeDays(byDay) {
  let n = 0
  for (const k in byDay) if (byDay[k] > 0) n++
  return n
}

// Normalize ABS's dayOfWeek map into a dense '0'..'6' (Sun..Sat) map with every
// weekday present. Mirror of @hearthshelf/core's dayOfWeekTotals - keep in sync
// (this file is the server's hand-copy of core's stats math). ABS keys dayOfWeek
// by weekday NAME; fold both name and numeric-index shapes to the index.
const DOW_NAMES = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}
function dayOfWeekTotals(dayOfWeek) {
  const out = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  for (const [key, val] of Object.entries(dayOfWeek ?? {})) {
    const seconds = typeof val === 'number' ? val : 0
    const named = DOW_NAMES[String(key).trim().toLowerCase()]
    const idx = named !== undefined ? named : Number.parseInt(key, 10)
    if (Number.isInteger(idx) && idx >= 0 && idx <= 6) out[idx] += seconds
  }
  return out
}

// Average seconds per occurrence of each weekday, keyed 0..6 (Sun..Sat), derived
// from byDay. Mirror of @hearthshelf/core's dayOfWeekAverages - keep in sync.
// Unlike dayOfWeekTotals (a running sum), this divides each weekday's total by
// how many dates of that weekday appear in byDay, so weekdays are comparable.
function dayOfWeekAverages(byDay) {
  const sums = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  for (const [date, val] of Object.entries(byDay ?? {})) {
    const seconds = typeof val === 'number' ? val : 0
    const parts = String(date).split('-')
    if (parts.length !== 3) continue
    const y = Number.parseInt(parts[0], 10)
    const m = Number.parseInt(parts[1], 10)
    const d = Number.parseInt(parts[2], 10)
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) continue
    const idx = new Date(y, m - 1, d).getDay()
    sums[idx] += seconds
    counts[idx] += 1
  }
  const out = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  for (const idx of Object.keys(out)) out[idx] = counts[idx] ? sums[idx] / counts[idx] : 0
  return out
}

function mostListened(items) {
  return Object.entries(items ?? {})
    .map(([key, raw]) => {
      const md = raw.mediaMetadata || {}
      return {
        id: raw.id || key,
        title: md.title || 'Untitled',
        author: md.authorName || md.authors?.[0]?.name || '',
        narrator: md.narratorName || md.narrators?.[0] || '',
        timeSec: raw.timeListening ?? 0,
      }
    })
    .sort((a, b) => b.timeSec - a.timeSec)
}

/**
 * Reconstruct the caller's local "now" from a timezone offset in minutes
 * (JS Date.getTimezoneOffset(): minutes to ADD to local to get UTC, e.g. 300
 * for US Central). Returns a Date whose UTC fields read as the caller's local
 * wall clock, so dayKey lines up with ABS's local-day `days` keys.
 */
export function callerNow(tzOffsetMin) {
  const nowMs = Date.now()
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0
  return new Date(nowMs - off * 60_000)
}

// `extra` carries the ABS-db-derived fields the pure fold can't compute
// (booksFinished, booksThisYear, sessionCount); the route reads those and passes
// them in. Absent -> null, matching @hearthshelf/core's client fallback.
export function computeListeningStats(raw, now, extra = {}) {
  const byDay = raw?.days ?? {}
  return {
    totalTimeSec: raw?.totalTime ?? 0,
    todaySec: raw?.today ?? 0,
    weekSec: weekSeconds(byDay, now),
    dayStreak: computeStreak(byDay, now),
    activeDays: activeDays(byDay),
    byDay,
    byDayOfWeek: dayOfWeekTotals(raw?.dayOfWeek),
    byWeekdayAvg: dayOfWeekAverages(byDay),
    mostListened: mostListened(raw?.items),
    booksFinished: extra.booksFinished ?? null,
    booksThisYear: extra.booksThisYear ?? null,
    sessionCount: extra.sessionCount ?? null,
    highlights: extra.highlights ?? null,
  }
}
