// The series-roster job: for every series in the ABS library, resolve its full
// Audible roster and precompute a library-wide "owned" flag per book, then store
// it durably (series_roster). /hs/audible/series serves this precomputed data, so
// the "you're missing books" state is instant and ASIN-accurate instead of
// resolved live on each request.
//
// Ownership is computed globally from ABS's own database (lib/absdb.js) - no user
// token, no per-item API call, by the shared stamp in lib/seriesOwned.js (the
// /hs/audible/series route re-runs it on read so books added between sweeps are
// owned right away).

import { getAllSeries, getOwnedSeriesBooks, absDbAvailable } from '../lib/absdb.js'
import { resolveSeriesAsin, fetchSeriesBooks, currentRegion } from '../routes/audible.js'
import { saveSeriesRoster } from '../lib/seriesRosterStore.js'
import { backfillAbsSeriesIds } from '../lib/subscriptionsStore.js'
import { getServerId } from '../db.js'
import { stampOwned } from '../lib/seriesOwned.js'

// Do the owned books in one series come from authors with nothing in common?
//
// Deliberately conservative - it must not fire on the normal cases. Co-authored
// series list several names per book ("Andrew Karevik, LitRPG Freaks"), and ABS
// records one author per book, so a legitimate series can still show several
// author strings. We split every string on commas and only flag a conflict when
// NO single person appears across all of them, which is the real signature of
// two different series sharing a name.
function isAuthorConflict(ownedAuthors) {
  if (ownedAuthors.length < 2) return false
  const personSets = ownedAuthors.map(
    (a) =>
      new Set(
        String(a)
          .split(',')
          .map((n) =>
            n
              .toLowerCase()
              .replace(/[^\p{L}\p{N}\s]/gu, '')
              .replace(/\s+/g, ' ')
              .trim(),
          )
          .filter(Boolean),
      ),
  )
  if (personSets.some((s) => s.size === 0)) return false
  // Any person present in every book's author list means they're related.
  const [first, ...rest] = personSets
  for (const person of first) {
    if (rest.every((s) => s.has(person))) return false
  }
  return true
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

      // A single ABS series holding books by unrelated authors is almost always
      // two real series merged under one name (ABS matches series by name, so a
      // title collision silently fuses them). We cannot tell which one the user
      // means, and either roster would list the OTHER author's books as "missing
      // from your library" - a confidently wrong answer. Skip it and say so;
      // showing nothing is better, and the log tells the user what to fix.
      if (isAuthorConflict(ownedAuthors)) {
        unresolved++
        await saveSeriesRoster({
          seriesId: s.seriesId,
          name: s.name,
          seriesAsin: null,
          seriesTitle: null,
          books: [],
        })
        logger.warn(
          `[${i}/${seriesList.length}] ${s.name}: skipped - books by unrelated authors ` +
            `(${ownedAuthors.join(' / ')}) share this series. Two series are likely merged; ` +
            `split them in the book editor to get missing-book suggestions.`,
        )
        logger.progress(i, seriesList.length)
        if (PACING_MS > 0 && i < seriesList.length) await between(PACING_MS, signal)
        continue
      }

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
        const books = stampOwned(roster, owned, s.name)
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

  // Now that the ASIN <-> ABS-series map is fresh, link any series follows that
  // predate abs_series_id (or were made from an Audible search). Follows are
  // stored per user but the mapping is library-wide, so one pass covers all of
  // them - nobody has to unfollow and re-follow to be found by the library's
  // Following filter. Best-effort: a failure here must not fail the sweep.
  let linkNote = ''
  try {
    const serverId = await getServerId()
    const { linked, remaining, ambiguous } = await backfillAbsSeriesIds(serverId)
    if (linked > 0)
      logger.info(`Linked ${linked} existing series follow(s) to their library series`)
    if (remaining > 0) {
      logger.info(
        `${remaining} follow(s) still unlinked - their series is not in this library or has no Audible match yet`,
      )
    }
    if (ambiguous > 0) {
      logger.warn(
        `${ambiguous} Audible series map to more than one library series; their follows were left unlinked rather than guessed`,
      )
    }
    if (linked > 0 || remaining > 0) linkNote = `, linked ${linked} follow(s)`
  } catch (err) {
    logger.warn(`Could not link existing follows: ${String(err?.message ?? err)}`)
  }

  return `Resolved ${resolved}, unresolved ${unresolved} of ${seriesList.length} series${linkNote}`
}
