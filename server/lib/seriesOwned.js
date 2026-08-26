// Which books of an Audible series roster the library already owns.
//
// Shared by the two producers of that verdict: the nightly series-roster job
// (jobs/seriesRoster.js), which precomputes it for every series, and the
// /hs/audible/series route, which re-stamps the stored roster on read so a book
// added since the last sweep is owned immediately instead of at the next sweep.
//
// Owned books come from ABS's own database (lib/absdb.js): { asin, title,
// sequence }. Roster books come from the Audible catalog (routes/audible.js).
//
// Keep in step with @hearthshelf/core missingSeriesBooks, which applies the same
// ranking client-side for servers that haven't stamped `owned`.

// Normalize a title the same way the client does (mirror of core's normalizeTitle
// - the server runs plain .js and can't import the .ts). Keep in step with
// @hearthshelf/core src/lib/series.ts.
function squash(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Strip a leading "<series name>:" / "<series name> -" prefix. Mirror of core's
// stripSeriesPrefix.
function stripSeriesPrefix(title, series) {
  const wantedSeries = squash(series)
  if (!wantedSeries) return title
  // The prefix often carries the volume number ("Federation Marine 2: Sergeant"),
  // so match the series name with an optional trailing number - otherwise the
  // numbered entries keep their prefix and lose their book name. Mirror of core's
  // stripSeriesPrefix.
  const matchesSeries = (candidate) =>
    candidate === wantedSeries ||
    candidate.replace(/\s*(book|volume|vol|part|#)?\s*\d+(\.\d+)?$/, '').trim() === wantedSeries
  const parts = String(title ?? '').split(/\s*[:–—-]\s+/)
  for (let i = parts.length - 1; i >= 1; i--) {
    if (matchesSeries(squash(parts.slice(0, i).join(' ')))) return parts.slice(i).join(': ')
  }
  return matchesSeries(squash(title)) ? '' : title
}

// Pass `series` whenever it's known: in a series whose books are all titled
// "<Series>: <Book Name>", dropping the subtitle normalizes EVERY book to the
// series name, so every owned book matches every roster entry and ownership is
// handed out in roster order. Stripping the series prefix instead keeps the part
// that names the book. Mirror of core's normalizeTitle.
export function normalizeTitle(title, series) {
  const raw = String(title ?? '')
  const stripped = series ? stripSeriesPrefix(raw, series) : raw
  const base = stripped || raw
  return squash(
    base
      .replace(/:\s.*$/, '')
      .replace(/[,\-–—]?\s*(book|volume|vol|part|#)\s*\d+(\.\d+)?\s*$/i, ''),
  )
}

export function seqKey(sequence) {
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
// book whose ASIN IS IN THIS ROSTER is never matched by title or sequence (a
// live ASIN that didn't match means it's a different book); and a sequence claim
// only stands when the two titles don't actively disagree - both sides having
// real titles that differ is contradicted metadata, not a match.
//
// The roster check is what makes the ASIN rule safe. An ASIN is only evidence
// while the edition it names is still on sale: when a book is re-issued under a
// new publisher, the ASIN of the copy in the library is DELISTED and appears
// nowhere in the current roster (Audible 404s it - "this title is no longer
// available"). Treating that dead ASIN as conclusive vetoed the title and
// sequence signals that would have matched the re-issue, so every owned book in
// a re-published series was stamped unowned and the series page listed the whole
// library back to the user as "not in library". An owned ASIN the roster doesn't
// contain tells us nothing, so the book falls through to the weaker signals.
export function stampOwned(audibleBooks, ownedBooks, series) {
  // Index owned books by each signal, keeping their identity so a match can
  // consume them. Only books without a LIVE asin are eligible for the weaker
  // signals.
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
    audibleBooks.map((b) => (b.asin ? String(b.asin).toLowerCase() : '')).filter(Boolean),
  )

  for (const b of ownedBooks) {
    const entry = { used: false, title: normalizeTitle(b.title, series) }
    const asin = b.asin ? String(b.asin).toLowerCase() : ''
    if (asin && rosterAsins.has(asin)) {
      push(byAsin, asin, entry)
      continue // live ASIN is conclusive for this book; don't weaken it
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
    if (!b.owned && claim(byTitle, normalizeTitle(b.title, series))) b.owned = true
  })
  out.forEach((b) => {
    if (b.owned) return
    const rosterTitle = normalizeTitle(b.title, series)
    const compatible = (e) => !e.title || !rosterTitle || e.title === rosterTitle
    if (claim(bySeq, seqKey(b.sequence), compatible)) b.owned = true
  })
  return out
}
