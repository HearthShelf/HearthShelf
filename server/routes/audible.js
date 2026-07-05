// HearthShelf's own Audible catalog search. Mounted at /hs/audible/search.
// HearthShelf owns discovery; this works regardless of whether RMAB is
// connected (RMAB is only the request/download executor). Calls Audible's
// public catalog API directly - no auth, no third-party dependency.
//
// Verified against the Audible catalog API shape: GET {apiBase}/1.0/catalog/
// products?keywords=&num_results=&page=&response_groups=... returns
// { products: [...], total_results }. We map each product to the same result
// shape the request UI already consumes (mirrors RMAB's search result).
//
// The catalog region (us|ca|uk|au|in|de|es|fr) lives in the integrations_config
// table, editable from Config > Integrations and seeded from AUDIBLE_REGION on
// first boot. See server/integrations.js.

import { json } from '../lib/http.js'
import { getIntegrations } from '../integrations.js'
import { getSeriesRoster } from '../lib/seriesRosterStore.js'

const PAGE_SIZE = 25
const RESPONSE_GROUPS =
  'contributors,product_desc,product_attrs,product_extended_attrs,media,rating,series,category_ladders,product_details'

// Region -> Audible catalog API host. Mirrors the public marketplaces.
const REGION_API = {
  us: 'https://api.audible.com',
  ca: 'https://api.audible.ca',
  uk: 'https://api.audible.co.uk',
  au: 'https://api.audible.com.au',
  in: 'https://api.audible.in',
  de: 'https://api.audible.de',
  es: 'https://api.audible.es',
  fr: 'https://api.audible.fr',
}

function apiBase(region) {
  return REGION_API[region] || REGION_API.us
}

// Resolve the configured Audible region from the integrations config.
export async function currentRegion() {
  const { audibleRegion } = await getIntegrations()
  return audibleRegion || 'us'
}

// Map a raw Audible catalog product to our search-result shape.
function mapProduct(product) {
  const author = (product.authors ?? []).map((a) => a.name).join(', ')
  const authorAsin = product.authors?.[0]?.asin ?? undefined
  const narrator =
    product.narrators && product.narrators.length > 0
      ? product.narrators.map((n) => n.name).join(', ')
      : undefined
  const description = product.publisher_summary ?? product.merchandising_summary ?? undefined
  const coverArtUrl = product.product_images?.['500'] ?? undefined

  let series
  let seriesAsin
  if (Array.isArray(product.series) && product.series.length > 0) {
    const preferred =
      product.series.find((s) => s.sequence && String(s.sequence).trim() !== '') ??
      product.series[0]
    series = preferred.title ?? undefined
    seriesAsin = preferred.asin ?? undefined
  }

  // Precise publication instant (better for day-accurate countdowns than the
  // date-only release_date); `upcoming` is a future release relative to now.
  const publicationDatetime = product.publication_datetime ?? undefined
  const releaseDate = product.release_date ?? undefined
  const relMs = Date.parse(publicationDatetime || releaseDate || '')
  const upcoming = Number.isNaN(relMs) ? undefined : relMs > Date.now()

  return {
    asin: product.asin,
    title: product.title ?? '',
    author,
    authorAsin,
    narrator,
    description,
    coverArtUrl,
    durationMinutes: product.runtime_length_min ?? undefined,
    releaseDate,
    publicationDatetime,
    upcoming,
    rating: product.rating?.overall_distribution?.display_stars ?? undefined,
    series,
    seriesAsin,
  }
}

// Short in-memory TTL cache, keyed by region+query+page, to cut repeat Audible
// calls and smooth rate limits. Bounded so it can't grow unbounded.
const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 200
const cache = new Map() // key -> { at, value }

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), value })
}

async function searchAudible(query, page, region) {
  const base = apiBase(region)
  const params = new URLSearchParams({
    keywords: query,
    num_results: String(PAGE_SIZE),
    page: String(Math.max(0, page - 1)),
    response_groups: RESPONSE_GROUPS,
  })
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(`${base}/1.0/catalog/products?${params.toString()}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return { results: [], totalResults: 0, page, hasMore: false }
    const data = await res.json()
    const products = data?.products ?? []
    const totalResults = data?.total_results ?? 0
    const results = products.map(mapProduct)
    return {
      results,
      totalResults,
      page,
      hasMore:
        results.length > 0 &&
        (totalResults > 0 ? totalResults > page * PAGE_SIZE : results.length >= PAGE_SIZE),
    }
  } catch {
    return { results: [], totalResults: 0, page, hasMore: false }
  } finally {
    clearTimeout(t)
  }
}

// Resolve a series name to its Audible series ASIN by searching and picking the
// most common series whose title matches the query (case-insensitive). ABS
// exposes no series ASIN, so this is the bridge - best-effort, returns null when
// no confident match.
export async function resolveSeriesAsin(name, region) {
  const norm = name.trim().toLowerCase()
  const { results } = await searchAudible(name, 1, region)
  const tally = new Map() // seriesAsin -> { title, asin, count }
  for (const r of results) {
    if (!r.seriesAsin || !r.series) continue
    if (r.series.trim().toLowerCase() !== norm) continue
    const cur = tally.get(r.seriesAsin) ?? { title: r.series, asin: r.seriesAsin, count: 0 }
    cur.count++
    tally.set(r.seriesAsin, cur)
  }
  let best = null
  for (const v of tally.values()) if (!best || v.count > best.count) best = v
  return best // { title, asin, count } | null
}

// Fetch the child books of a series by its ASIN, ordered by series sequence.
export async function fetchSeriesBooks(seriesAsin, region) {
  const base = apiBase(region)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15000)
  try {
    // 1) the series product -> child relationships (asin + sequence).
    const relRes = await fetch(
      `${base}/1.0/catalog/products/${encodeURIComponent(seriesAsin)}?response_groups=relationships`,
      { signal: ctrl.signal, headers: { Accept: 'application/json' } },
    )
    if (!relRes.ok) return []
    const relData = await relRes.json()
    const rels = (relData?.product?.relationships ?? []).filter(
      (r) => r.relationship_to_product === 'child' && r.asin,
    )
    if (!rels.length) return []
    const seqByAsin = new Map(rels.map((r) => [r.asin, r.sequence ?? null]))
    const asins = rels.map((r) => r.asin).slice(0, 50)

    // 2) batch-fetch the child products for display details.
    const params = new URLSearchParams({ asins: asins.join(','), response_groups: RESPONSE_GROUPS })
    const prodRes = await fetch(`${base}/1.0/catalog/products?${params.toString()}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    })
    if (!prodRes.ok) return []
    const prodData = await prodRes.json()
    const products = prodData?.products ?? []
    const mapped = products.map((p) => ({
      ...mapProduct(p),
      sequence: seqByAsin.get(p.asin) ?? null,
    }))
    // Order by numeric sequence when available.
    mapped.sort((a, b) => (parseFloat(a.sequence) || 0) - (parseFloat(b.sequence) || 0))
    return mapped
  } catch {
    return []
  } finally {
    clearTimeout(t)
  }
}

// Fetch a single Audible product by ASIN, mapped to our result shape. null when
// not found. Used by the upcoming-book page (reachable fresh, e.g. from a push
// deep-link, without the series roster in hand).
export async function fetchProduct(asin, region) {
  const base = apiBase(region)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15000)
  try {
    const params = new URLSearchParams({ response_groups: RESPONSE_GROUPS })
    const r = await fetch(
      `${base}/1.0/catalog/products/${encodeURIComponent(asin)}?${params.toString()}`,
      { signal: ctrl.signal, headers: { Accept: 'application/json' } },
    )
    if (!r.ok) return null
    const data = await r.json()
    return data?.product ? mapProduct(data.product) : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

export async function handleAudible(req, res, url, ctx) {
  const p = url.pathname
  if (!p.startsWith('/hs/audible/')) return false
  if (req.method !== 'GET') return (json(res, 405, { error: 'method_not_allowed' }), true)
  if (!ctx) return (json(res, 401, { error: 'unauthorized' }), true)

  const region = await currentRegion()

  // Catalog search: GET /hs/audible/search?q=
  if (p === '/hs/audible/search') {
    const q = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim()
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
    if (q.length < 2) {
      return (
        json(res, 200, { query: q, results: [], totalResults: 0, page, hasMore: false }),
        true
      )
    }
    const key = `${region}|${q.toLowerCase()}|${page}`
    const cached = cacheGet(key)
    if (cached) return (json(res, 200, { query: q, ...cached }), true)
    const result = await searchAudible(q, page, region)
    cacheSet(key, result)
    return (json(res, 200, { query: q, ...result }), true)
  }

  // Single product by ASIN: GET /hs/audible/product?asin=<asin>
  if (p === '/hs/audible/product') {
    const asin = (url.searchParams.get('asin') ?? '').trim()
    if (!asin) return (json(res, 400, { error: 'asin_required' }), true)
    const key = `product|${region}|${asin}`
    const cached = cacheGet(key)
    if (cached) return (json(res, 200, cached), true)
    const product = await fetchProduct(asin, region)
    if (!product) return (json(res, 404, { error: 'not_found' }), true)
    cacheSet(key, product)
    return (json(res, 200, product), true)
  }

  // Series books by name: GET /hs/audible/series?q=<series name>
  // Prefers the precomputed roster (the nightly series-roster job) - it carries a
  // library-wide `owned` flag per book and needs no live Audible call. Falls back
  // to resolving live for a series the job hasn't swept yet (new series, or job
  // never run), so a cold instance still works while the sweep catches up.
  if (p === '/hs/audible/series') {
    const name = (url.searchParams.get('q') ?? '').trim()
    if (name.length < 2) return (json(res, 200, { name, seriesAsin: null, books: [] }), true)

    // 1) Precomputed (owned-flagged) roster, if the job has recorded this series.
    const precomputed = await getSeriesRoster(name)
    if (precomputed) {
      return (
        json(res, 200, {
          name: precomputed.name,
          seriesAsin: precomputed.seriesAsin,
          seriesTitle: precomputed.seriesTitle,
          books: precomputed.books,
        }),
        true
      )
    }

    // 2) Live resolve (in-memory TTL cache), for a series not yet swept.
    const key = `series|${region}|${name.toLowerCase()}`
    const cached = cacheGet(key)
    if (cached) return (json(res, 200, cached), true)

    const match = await resolveSeriesAsin(name, region)
    if (!match) {
      const empty = { name, seriesAsin: null, books: [] }
      cacheSet(key, empty)
      return (json(res, 200, empty), true)
    }
    const books = await fetchSeriesBooks(match.asin, region)
    const out = { name, seriesAsin: match.asin, seriesTitle: match.title, books }
    cacheSet(key, out)
    return (json(res, 200, out), true)
  }

  return (json(res, 404, { error: 'not_found' }), true)
}
