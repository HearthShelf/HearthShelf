// The series-roster job: for every series in the ABS library, resolve its full
// Audible roster and precompute a library-wide "owned" flag per book, then store
// it durably (series_roster). /hs/audible/series serves this precomputed data, so
// the "you're missing books" state is instant and ASIN-accurate instead of
// resolved live on each request.
//
// Ownership is computed globally from ABS's own database (lib/absdb.js) - no user
// token, no per-item API call. A roster book is owned when the library holds its
// ASIN. Weaker signals (normalized title, then series sequence) only fill in for
// owned books ABS has no ASIN for - see stampOwned for why sequence is last and
// is consumed rather than shared.

import { getAllSeries, getOwnedSeriesBooks, absDbAvailable } from '../lib/absdb.js'
import { resolveSeriesAsin, fetchSeriesBooks, currentRegion } from '../routes/audible.js'
import { saveSeriesRoster } from '../lib/seriesRosterStore.js'

// Normalize a title the same way the client does (mirror of core's normalizeTitle
// - the server runs plain .js and can't import the .ts). Keep in step with
// @hearthshelf/core src/lib/series.ts.
function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/:\s.*$/, '')
    .replace(/[,\-–—]?\s*(book|volume|vol|part|#)\s*\d+(\.\d+)?\s*$/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function seqKey(sequence) {
  if (sequence == null) return ''
  const n = parseFloat(String(sequence).replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? String(n) : ''
}

// Stamp each Audible roster book with owned:true/false against the library's
// owned books for this series (asin/title/sequence from ABS's db).
//
// Signals are ranked, and each owned book is CONSUMED by the first roster entry
// it matches. Bare sequence used to be an unranked, unlimited OR, which produced
// two false "owned" verdicts that hid genuinely missing books:
//
//   - Mis-sequenced metadata: ABS tags an owned book "#4", so Audible's real
//     book 4 reads owned and silently leaves the missing list. Server flags are
//     authoritative for clients, so nothing downstream could recover it.
//   - Omnibus / boxed set: one owned bundle at sequence "1" claimed slot 1 while
//     the books it actually contains stayed unowned - inconsistent either way.
//
// Ranking (strongest first) fixes both: an ASIN match is conclusive; an owned
// book that HAS an ASIN is never matched by title or sequence (a real ASIN that
// didn't match means it's a different book); and a sequence claim only stands
// when the two titles don't actively disagree - both sides having real titles
// that differ is contradicted metadata, not a match.
//
// Keep in step with @hearthshelf/core missingSeriesBooks, which applies the same
// ranking client-side for servers that haven't stamped `owned`.
function stampOwned(audibleBooks, ownedBooks) {
  // Index owned books by each signal, keeping their identity so a match can
  // consume them. Only ASIN-less books are eligible for the weaker signals.
  const byAsin = new Map()
  const byTitle = new Map()
  const bySeq = new Map()
  const push = (map, key, entry) => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(entry)
    else map.set(key, [entry])
  }

  for (const b of ownedBooks) {
    const entry = { used: false, title: normalizeTitle(b.title) }
    if (b.asin) {
      push(byAsin, String(b.asin).toLowerCase(), entry)
      continue // ASIN is conclusive for this book; don't weaken it with title/seq
    }
    push(byTitle, entry.title, entry)
    push(bySeq, seqKey(b.sequence), entry)
  }

  const claim = (map, key, accept) => {
    if (!key) return false
    const list = map.get(key)
    if (!list) return false
    const entry = list.find((e) => !e.used && (!accept || accept(e)))
    if (!entry) return false // already claimed, or contradicted
    entry.used = true
    return true
  }

  // Strongest signal first across the WHOLE roster, so a definite ASIN match
  // always beats a weaker claim on the same owned book.
  const out = audibleBooks.map((b) => ({ ...b, owned: false }))
  out.forEach((b) => {
    if (claim(byAsin, b.asin ? String(b.asin).toLowerCase() : '')) b.owned = true
  })
  out.forEach((b) => {
    if (!b.owned && claim(byTitle, normalizeTitle(b.title))) b.owned = true
  })
  out.forEach((b) => {
    if (b.owned) return
    const rosterTitle = normalizeTitle(b.title)
    const compatible = (e) => !e.title || !rosterTitle || e.title === rosterTitle
    if (claim(bySeq, seqKey(b.sequence), compatible)) b.owned = true
  })
  return out
}

// Small delay so we don't hammer the Audible catalog API across a large library.
// Resolves early if the run is cancelled so a Kill doesn't wait out the pacing.
const between = (ms, signal) =>
  new Promise((r) => {
    if (signal?.aborted) return r()
    const t = setTimeout(r, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      r()
    })
  })
const PACING_MS = Number(process.env.HS_JOB_SERIES_PACING_MS || '250')

export async function runSeriesRoster(logger, signal) {
  if (!(await absDbAvailable())) {
    logger.warn('ABS database not available (HS_ABS_DB_PATH) - cannot enumerate series. Skipping.')
    return 'Skipped: ABS database not mounted'
  }

  const region = await currentRegion()
  const seriesList = await getAllSeries()
  logger.info(`Found ${seriesList.length} series in the library`)
  logger.progress(0, seriesList.length)

  let resolved = 0
  let unresolved = 0
  let i = 0
  for (const s of seriesList) {
    if (signal?.aborted) {
      logger.warn(`Cancelled after ${i} of ${seriesList.length} series`)
      return `Cancelled after ${i} of ${seriesList.length} series (${resolved} resolved)`
    }
    i++
    try {
      // Owned books first: their authors disambiguate the Audible match when two
      // distinct series share this name.
      const owned = await getOwnedSeriesBooks(s.seriesId)
      const ownedAuthors = [...new Set(owned.map((b) => b.author).filter(Boolean))]
      const match = await resolveSeriesAsin(s.name, region, ownedAuthors)
      if (!match) {
        unresolved++
        await saveSeriesRoster({
          seriesId: s.seriesId,
          name: s.name,
          seriesAsin: null,
          seriesTitle: null,
          books: [],
        })
        logger.info(`[${i}/${seriesList.length}] ${s.name}: no Audible match`)
      } else {
        const roster = await fetchSeriesBooks(match.asin, region)
        const books = stampOwned(roster, owned)
        const missing = books.filter((b) => b.owned === false).length
        await saveSeriesRoster({
          seriesId: s.seriesId,
          name: s.name,
          seriesAsin: match.asin,
          seriesTitle: match.title,
          books,
        })
        resolved++
        const how = match.authorHits > 0 ? 'author-matched' : 'name-only'
        logger.info(
          `[${i}/${seriesList.length}] ${s.name}: ${books.length} books, ${missing} not owned (${how})`,
        )
      }
    } catch (err) {
      unresolved++
      logger.warn(`[${i}/${seriesList.length}] ${s.name}: ${String(err?.message ?? err)}`)
    }
    logger.progress(i, seriesList.length)
    if (PACING_MS > 0 && i < seriesList.length) await between(PACING_MS, signal)
  }

  return `Resolved ${resolved}, unresolved ${unresolved} of ${seriesList.length} series`
}
