// Admin-only, read-only series-matching diagnostics.
//
// ABS knows the books you OWN in a series; Audible knows the whole series. Every
// "you're missing book 10" verdict is the output of a pipeline that resolves a
// series ASIN, fetches its children, drops phantoms and duplicate editions, and
// then matches what's left against the library by ASIN / title / sequence. When
// that pipeline gets a book wrong, the UI shows only the verdict - a book quietly
// present or quietly absent - with nothing to say WHICH stage decided it.
//
// This module re-runs the same pipeline and records the reasoning at every step,
// so a wrong verdict can be read off instead of guessed at. It calls the same
// helpers the real path does (resolveSeriesAsin, fetchSeriesBooks, stampOwned's
// normalizeTitle/seqKey) rather than reimplementing them - a debugger that
// disagrees with production is worse than none.
//
// Read-only: it never writes series_roster, never re-sweeps, never touches
// progress or settings. The one write in this feature (re-sweep a series) lives
// in the route, behind its own explicit request.

import { resolveSeriesAsin, fetchSeriesBooks } from '../routes/audible.js'
import { normalizeTitle, seqKey, stampOwned } from './seriesOwned.js'
import { getAllSeries, getOwnedSeriesBooks } from './absdb.js'
import { getSeriesRosterById } from './seriesRosterStore.js'

// Audible's placeholder date for an announced-but-unscheduled product. Mirrors
// isPlaceholderBook in routes/audible.js and core's series.ts.
const PLACEHOLDER_RELEASE_YEAR = '2200'

function isPlaceholder(book) {
  const rel = book.releaseDate ?? book.publicationDatetime ?? ''
  if (!String(rel).startsWith(PLACEHOLDER_RELEASE_YEAR)) return false
  return !book.narrator && !book.durationMinutes
}

// How much a roster entry tells us - the edition tiebreak. Mirror of core's
// editionScore.
function editionScore(b) {
  return (
    (b.owned ? 8 : 0) + (b.coverArtUrl ? 4 : 0) + (b.durationMinutes ? 2 : 0) + (b.narrator ? 1 : 0)
  )
}

// Why each raw roster entry did or didn't survive filtering, in the same order
// the real pipeline applies the rules: phantom placeholders first, then
// duplicate editions of one book.
//
// Returns one row per RAW entry so the UI can show the full Audible children
// list and mark what was dropped, rather than only the survivors.
function filterTrace(rawBooks, seriesName) {
  // Pass 1: phantom placeholders (a stub whose sequence a real product occupies).
  const phantom = new Map()
  for (const b of rawBooks) {
    if (!isPlaceholder(b)) continue
    const slot = seqKey(b.sequence)
    if (!slot) continue // unsequenced stub: nothing to supersede it, so it stays
    const superseder = rawBooks.find(
      (o) => o !== b && seqKey(o.sequence) === slot && !isPlaceholder(o),
    )
    if (superseder) phantom.set(b, superseder)
  }

  // Pass 2: duplicate editions, among what survived pass 1. Same sequence AND
  // same normalized title == the same book re-issued; the richer entry wins.
  const survivors = rawBooks.filter((b) => !phantom.has(b))
  const best = new Map()
  for (const b of survivors) {
    const slot = seqKey(b.sequence)
    if (!slot) continue
    const key = `${slot}|${normalizeTitle(b.title, seriesName)}`
    const cur = best.get(key)
    if (!cur || editionScore(b) > editionScore(cur)) best.set(key, b)
  }

  return rawBooks.map((b) => {
    const slot = seqKey(b.sequence)
    const normalized = normalizeTitle(b.title, seriesName)
    const row = {
      asin: b.asin ?? null,
      title: b.title ?? '',
      // The single most valuable field here: the title the matcher actually
      // compares. A normalized title that is the SERIES name plus a number
      // (rather than the book's own name) means the prefix strip missed.
      normalizedTitle: normalized,
      sequence: b.sequence ?? '',
      sequenceKey: slot,
      releaseDate: b.releaseDate ?? b.publicationDatetime ?? null,
      durationMinutes: b.durationMinutes ?? null,
      narrator: b.narrator ?? null,
      hasCover: Boolean(b.coverArtUrl),
      isPlaceholder: isPlaceholder(b),
      editionScore: editionScore(b),
      kept: true,
      droppedBy: null,
      droppedFor: null,
    }
    const supersededBy = phantom.get(b)
    if (supersededBy) {
      row.kept = false
      row.droppedBy = 'phantom-placeholder'
      row.droppedFor = supersededBy.asin ?? null
      return row
    }
    if (slot) {
      const winner = best.get(`${slot}|${normalized}`)
      if (winner && winner !== b) {
        row.kept = false
        row.droppedBy = 'duplicate-edition'
        row.droppedFor = winner.asin ?? null
      }
    }
    return row
  })
}

// Replay stampOwned's ranked matching, recording which signal claimed each
// roster entry and - when nothing did - which signal was tried and why it was
// refused. This mirrors stampOwned exactly; keep the two in step.
//
// The refusal reasons matter more than the matches: "sequence refused because
// the titles contradict" is what a mangled normalized title looks like from the
// outside, and it is indistinguishable from a genuine miss in the UI.
function matchTrace(keptBooks, ownedBooks, seriesName) {
  const byAsin = new Map()
  const byTitle = new Map()
  const bySeq = new Map()
  const push = (map, key, entry) => {
    if (!key) return
    const list = map.get(key)
    if (list) list.push(entry)
    else map.set(key, [entry])
  }

  const rosterAsins = new Set(
    keptBooks.map((b) => (b.asin ? String(b.asin).toLowerCase() : '')).filter(Boolean),
  )

  const ownedRows = ownedBooks.map((b) => {
    const asin = b.asin ? String(b.asin).toLowerCase() : ''
    const liveAsin = Boolean(asin && rosterAsins.has(asin))
    return {
      asin: b.asin ?? '',
      title: b.title ?? '',
      normalizedTitle: normalizeTitle(b.title, seriesName),
      sequence: b.sequence ?? '',
      sequenceKey: seqKey(b.sequence),
      author: b.author ?? '',
      // An ASIN is only evidence while its edition is still on sale. A dead
      // (delisted) ASIN must NOT veto the weaker signals - that bug listed a
      // whole re-published series back as "not in library".
      asinIsLive: liveAsin,
      eligibleFor: liveAsin ? ['asin'] : ['title', 'sequence'],
      claimedBy: null,
    }
  })

  for (const row of ownedRows) {
    const entry = { row, used: false, title: row.normalizedTitle }
    if (row.asinIsLive) {
      push(byAsin, String(row.asin).toLowerCase(), entry)
      continue
    }
    push(byTitle, row.normalizedTitle, entry)
    push(bySeq, row.sequenceKey, entry)
  }

  const claim = (map, key, accept) => {
    if (!key) return null
    const list = map.get(key)
    if (!list) return null
    const entry = list.find((e) => !e.used && (!accept || accept(e)))
    if (!entry) return null
    entry.used = true
    return entry
  }

  const results = keptBooks.map((b) => ({
    asin: b.asin ?? null,
    title: b.title ?? '',
    normalizedTitle: normalizeTitle(b.title, seriesName),
    sequence: b.sequence ?? '',
    sequenceKey: seqKey(b.sequence),
    owned: false,
    matchedBy: null,
    matchedOwned: null,
    attempts: [],
  }))

  // Strongest signal first across the WHOLE roster, exactly as stampOwned does.
  results.forEach((r) => {
    const key = r.asin ? String(r.asin).toLowerCase() : ''
    if (!key) {
      r.attempts.push({ signal: 'asin', outcome: 'skipped', detail: 'Roster entry has no ASIN' })
      return
    }
    const hit = claim(byAsin, key)
    if (hit) {
      r.owned = true
      r.matchedBy = 'asin'
      r.matchedOwned = hit.row.title
      hit.row.claimedBy = r.asin
      r.attempts.push({ signal: 'asin', outcome: 'matched', detail: 'Exact live-ASIN match' })
    } else {
      r.attempts.push({
        signal: 'asin',
        outcome: 'no-match',
        detail: 'No owned book carries this ASIN',
      })
    }
  })

  results.forEach((r) => {
    if (r.owned) return
    if (!r.normalizedTitle) {
      r.attempts.push({ signal: 'title', outcome: 'skipped', detail: 'Normalized title is empty' })
      return
    }
    const hit = claim(byTitle, r.normalizedTitle)
    if (hit) {
      r.owned = true
      r.matchedBy = 'title'
      r.matchedOwned = hit.row.title
      hit.row.claimedBy = r.asin
      r.attempts.push({
        signal: 'title',
        outcome: 'matched',
        detail: `Normalized title matched "${hit.row.title}"`,
      })
    } else {
      r.attempts.push({
        signal: 'title',
        outcome: 'no-match',
        detail: `No unclaimed owned book normalizes to "${r.normalizedTitle}"`,
      })
    }
  })

  results.forEach((r) => {
    if (r.owned) return
    if (!r.sequenceKey) {
      r.attempts.push({
        signal: 'sequence',
        outcome: 'skipped',
        detail: 'Roster entry has no parseable sequence',
      })
      return
    }
    // A sequence claim only stands when the titles don't actively disagree.
    const compatible = (e) => !e.title || !r.normalizedTitle || e.title === r.normalizedTitle
    const hit = claim(bySeq, r.sequenceKey, compatible)
    if (hit) {
      r.owned = true
      r.matchedBy = 'sequence'
      r.matchedOwned = hit.row.title
      hit.row.claimedBy = r.asin
      r.attempts.push({
        signal: 'sequence',
        outcome: 'matched',
        detail: `Same slot #${r.sequenceKey} as "${hit.row.title}", titles compatible`,
      })
    } else {
      // Distinguish "nobody at this slot" from "somebody, but contradicted" -
      // the latter is the signature of a mangled normalized title.
      const atSlot = (bySeq.get(r.sequenceKey) ?? []).filter((e) => !e.used)
      const contradicted = atSlot.filter((e) => !compatible(e))
      r.attempts.push({
        signal: 'sequence',
        outcome: contradicted.length ? 'refused' : 'no-match',
        detail: contradicted.length
          ? `Slot #${r.sequenceKey} holds "${contradicted[0].row.title}" (normalizes to ` +
            `"${contradicted[0].title}"), which contradicts "${r.normalizedTitle}"`
          : `No unclaimed owned book sits at slot #${r.sequenceKey}`,
      })
    }
  })

  return { results, ownedRows }
}

// Compare the stored (precomputed) roster against what we just resolved live.
// The two halves age differently: the Audible book list changes when the author
// publishes, ownership the moment a book lands in ABS. A stored roster that
// disagrees with live is the thing to look at when the UI is stale.
function storedComparison(stored, liveBooks, seriesName) {
  if (!stored) {
    return { present: false, resolvedAt: null, seriesAsin: null, bookCount: 0, drift: [] }
  }
  const liveByAsin = new Map(
    liveBooks.filter((b) => b.asin).map((b) => [String(b.asin).toLowerCase(), b]),
  )
  const storedByAsin = new Map(
    (stored.books ?? []).filter((b) => b.asin).map((b) => [String(b.asin).toLowerCase(), b]),
  )
  const drift = []
  for (const [asin, live] of liveByAsin) {
    const was = storedByAsin.get(asin)
    if (!was) {
      drift.push({ asin, title: live.title ?? '', kind: 'only-live' })
      continue
    }
    if (Boolean(was.owned) !== Boolean(live.owned)) {
      drift.push({
        asin,
        title: live.title ?? was.title ?? '',
        kind: 'owned-differs',
        stored: Boolean(was.owned),
        live: Boolean(live.owned),
      })
    }
  }
  for (const [asin, was] of storedByAsin) {
    if (!liveByAsin.has(asin)) drift.push({ asin, title: was.title ?? '', kind: 'only-stored' })
  }
  return {
    present: true,
    resolvedAt: stored.resolvedAt ?? null,
    seriesAsin: stored.seriesAsin ?? null,
    seriesTitle: stored.seriesTitle ?? null,
    name: stored.name ?? seriesName,
    bookCount: (stored.books ?? []).length,
    drift,
  }
}

// The full report for one ABS series. Every stage is reported even when a later
// one fails, so a series that resolves to nothing still shows WHY (which
// candidates were considered, what the library's authors were).
export async function debugSeries(seriesId, region) {
  const all = await getAllSeries()
  const entry = all.find((s) => s.seriesId === seriesId)
  if (!entry) {
    const error = new Error('series_not_found')
    error.code = 'series_not_found'
    throw error
  }
  const seriesName = entry.name

  const ownedBooks = await getOwnedSeriesBooks(seriesId)
  const ownedAuthors = [...new Set(ownedBooks.map((b) => b.author).filter(Boolean))]

  const report = {
    seriesId,
    name: seriesName,
    ownedCount: ownedBooks.length,
    resolution: null,
    roster: { seriesAsin: null, rawCount: 0, keptCount: 0, books: [] },
    matching: { results: [], owned: [] },
    stored: null,
    generatedAt: Date.now(),
  }

  // Stage 1: which Audible series did this name resolve to, and what else was
  // in the running? A series bound to the wrong roster shows up here.
  const match = await resolveSeriesAsin(seriesName, region, ownedAuthors)
  report.resolution = {
    query: seriesName,
    ownedAuthors,
    matched: match ? { asin: match.asin, title: match.title } : null,
    votes: match?.count ?? 0,
    authorHits: match?.authorHits ?? 0,
  }
  if (!match) return report

  // Stage 2: the raw Audible children, and what filtering did to each one.
  const rawBooks = await fetchSeriesBooks(match.asin, region)
  const traced = filterTrace(rawBooks, seriesName)
  const keptRaw = rawBooks.filter((_, i) => traced[i].kept)
  report.roster = {
    seriesAsin: match.asin,
    rawCount: rawBooks.length,
    keptCount: keptRaw.length,
    books: traced,
  }

  // Stage 3: ranked matching against the library, with refusal reasons.
  const { results, ownedRows } = matchTrace(keptRaw, ownedBooks, seriesName)
  report.matching = { results, owned: ownedRows }

  // Stage 4: stored vs live. Stamp the live roster the same way the real read
  // path does so the owned flags being compared are like for like.
  const stamped = stampOwned(keptRaw, ownedBooks, seriesName)
  const stored = await getSeriesRosterById(seriesId)
  report.stored = storedComparison(stored, stamped, seriesName)

  return report
}

// Every series in the library, for the debugger's picker. Cheap (one indexed
// read of ABS's db) and carries the owned count so a series can be found by
// size when its name is half-remembered.
export async function listDebuggableSeries() {
  const all = await getAllSeries()
  return all.map((s) => ({ seriesId: s.seriesId, name: s.name }))
}
