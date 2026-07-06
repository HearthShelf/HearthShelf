// The series-roster job: for every series in the ABS library, resolve its full
// Audible roster and precompute a library-wide "owned" flag per book, then store
// it durably (series_roster). /hs/audible/series serves this precomputed data, so
// the "you're missing books" state is instant and ASIN-accurate instead of
// resolved live on each request.
//
// Ownership is computed globally from ABS's own database (lib/absdb.js) - no user
// token, no per-item API call. A roster book is owned when the library holds its
// ASIN; failing an ASIN match (ABS may lack one), we fall back to a series-
// sequence match, then a normalized-title match.

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
// owned books for this series (asin/sequence/title from ABS's db).
function stampOwned(audibleBooks, ownedBooks) {
  const ownedAsins = new Set()
  const ownedSeqs = new Set()
  const ownedTitles = new Set()
  for (const b of ownedBooks) {
    if (b.asin) ownedAsins.add(b.asin.toLowerCase())
    const s = seqKey(b.sequence)
    if (s) ownedSeqs.add(s)
    const t = normalizeTitle(b.title)
    if (t) ownedTitles.add(t)
  }
  return audibleBooks.map((b) => {
    const asin = b.asin ? String(b.asin).toLowerCase() : ''
    const s = seqKey(b.sequence)
    const t = normalizeTitle(b.title)
    const owned =
      (asin && ownedAsins.has(asin)) || (s && ownedSeqs.has(s)) || (!!t && ownedTitles.has(t))
    return { ...b, owned: Boolean(owned) }
  })
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
      const match = await resolveSeriesAsin(s.name, region)
      if (!match) {
        unresolved++
        await saveSeriesRoster({ name: s.name, seriesAsin: null, seriesTitle: null, books: [] })
        logger.info(`[${i}/${seriesList.length}] ${s.name}: no Audible match`)
      } else {
        const roster = await fetchSeriesBooks(match.asin, region)
        const owned = await getOwnedSeriesBooks(s.seriesId)
        const books = stampOwned(roster, owned)
        const missing = books.filter((b) => b.owned === false).length
        await saveSeriesRoster({
          name: s.name,
          seriesAsin: match.asin,
          seriesTitle: match.title,
          books,
        })
        resolved++
        logger.info(
          `[${i}/${seriesList.length}] ${s.name}: ${books.length} books, ${missing} not owned`,
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
