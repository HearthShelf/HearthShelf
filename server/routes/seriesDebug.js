// Admin-only series-matching debugger.
//
// Two reads (the series list, and a full pipeline report for one series) plus
// one explicit write (re-sweep a single series' stored roster). The reads never
// touch stored state; the write is deliberately its own endpoint rather than a
// side effect of reading, so opening the debugger can't quietly rewrite a roster.

import { json } from '../lib/http.js'
import { isAdmin } from '../lib/context.js'
import { debugSeries, listDebuggableSeries } from '../lib/seriesDebug.js'
import { currentRegion, resolveSeriesAsin, fetchSeriesBooks } from './audible.js'
import { stampOwned } from '../lib/seriesOwned.js'
import { getOwnedSeriesBooks, getAllSeries } from '../lib/absdb.js'
import { saveSeriesRoster } from '../lib/seriesRosterStore.js'

export async function handleSeriesDebug(req, res, url, ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/admin/series-debug')) return false
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)
  if (!isAdmin(ctx)) return (json(res, 403, { error: 'forbidden' }), true)

  // The series picker.
  if (p === '/hs/admin/series-debug/list' && req.method === 'GET') {
    try {
      return (json(res, 200, { series: await listDebuggableSeries() }), true)
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 240)
      return (json(res, 502, { error: 'series_list_failed', detail }), true)
    }
  }

  // Re-sweep ONE series' stored roster from a fresh live resolve. The nightly
  // job does this for every series; this is the "fix just this one now" button,
  // so a stale roster doesn't have to wait for the sweep.
  if (p === '/hs/admin/series-debug/resweep' && req.method === 'POST') {
    const seriesId = (url.searchParams.get('seriesId') ?? '').trim()
    if (!seriesId) return (json(res, 400, { error: 'series_id_required' }), true)
    try {
      const region = await currentRegion()
      const all = await getAllSeries()
      const entry = all.find((s) => s.seriesId === seriesId)
      if (!entry) return (json(res, 404, { error: 'series_not_found' }), true)

      const owned = await getOwnedSeriesBooks(seriesId)
      const authors = [...new Set(owned.map((b) => b.author).filter(Boolean))]
      const match = await resolveSeriesAsin(entry.name, region, authors)
      if (!match) return (json(res, 200, { resolved: false, books: 0 }), true)

      const books = stampOwned(await fetchSeriesBooks(match.asin, region), owned, entry.name)
      await saveSeriesRoster({
        seriesId,
        name: entry.name,
        seriesAsin: match.asin,
        seriesTitle: match.title,
        books,
      })
      return (json(res, 200, { resolved: true, books: books.length }), true)
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 240)
      console.warn(`[series-debug] resweep ${seriesId}: ${detail}`)
      return (json(res, 502, { error: 'series_resweep_failed', detail }), true)
    }
  }

  if (p !== '/hs/admin/series-debug') return false
  if (req.method !== 'GET') return (json(res, 405, { error: 'method_not_allowed' }), true)

  const seriesId = (url.searchParams.get('seriesId') ?? '').trim()
  if (!seriesId) return (json(res, 400, { error: 'series_id_required' }), true)

  try {
    const report = await debugSeries(seriesId, await currentRegion())
    return (json(res, 200, report), true)
  } catch (error) {
    if (error?.code === 'series_not_found') {
      return (json(res, 404, { error: 'series_not_found' }), true)
    }
    const detail = String(error?.message ?? error).slice(0, 240)
    console.warn(`[series-debug] series ${seriesId}: ${detail}`)
    return (json(res, 502, { error: 'series_debug_failed', detail }), true)
  }
}
