// Admin-only Auto Queue diagnostics. This loads the same server-owned inputs as
// the real queue compute, runs Core's builder, and pairs it with a verbose trace.
// It never writes queue, progress, settings, dismissals, or club state.

import { buildAutoQueue } from '@hearthshelf/core/lib/queue'
import { normalizeAutoRules } from '@hearthshelf/core/lib/settings'
import { getUserSetting } from '../settings.js'
import { getQueue } from '../queue.js'
import { getDismissals } from '../dismissals.js'
import { listMyClubs, currentBook, listQueue } from '../clubs.js'
import { traceAutoQueue, queueIds } from './queueTrace.js'

async function absJson(ctx, path) {
  const response = await fetch(`${ctx.absUrl}${path}`, {
    headers: { Authorization: `Bearer ${ctx.absToken}` },
  })
  if (!response.ok) {
    const error = new Error(`ABS ${path} returned ${response.status}`)
    error.stage = path
    throw error
  }
  return response.json()
}

function currentFromProgress(mediaProgress) {
  let best = null
  for (const progress of mediaProgress) {
    if (!progress.libraryItemId || progress.isFinished) continue
    if (!best || Number(progress.lastUpdate ?? 0) > Number(best.lastUpdate ?? 0)) best = progress
  }
  return best?.libraryItemId ?? null
}

function resolveCurrent(stored, progressById, mediaProgress) {
  if (stored.currentItemId && !progressById.get(stored.currentItemId)?.isFinished) {
    return { id: stored.currentItemId, source: 'stored-current-item' }
  }
  const fallback = currentFromProgress(mediaProgress)
  return { id: fallback, source: fallback ? 'latest-progress-fallback' : 'none' }
}

function userLibraryIds(user) {
  if (user.type === 'admin' || user.type === 'root') return null
  if (!user.permissions) return null
  const permissions = user.permissions ?? {}
  if (permissions.accessAllLibraries) return null
  return new Set(permissions.librariesAccessible ?? user.librariesAccessible ?? [])
}

function visibleByTagAndExplicit(item, user) {
  if (user.type === 'admin' || user.type === 'root') return true
  const permissions = user.permissions ?? {}
  if (!user.permissions) return true
  const metadata = item.media?.metadata ?? {}
  if (permissions.accessExplicitContent === false && metadata.explicit) return false
  if (permissions.accessAllTags !== false) return true
  const selected = new Set(permissions.itemTagsSelected ?? [])
  const tags = item.media?.tags ?? []
  const intersects = tags.some((tag) => selected.has(tag))
  return permissions.selectedTagsNotAccessible ? !intersects : intersects
}

async function clubInputs(serverId, userId) {
  const clubs = await listMyClubs(serverId, userId)
  const details = await Promise.all(
    clubs.map(async (club) => {
      const [current, queued] = await Promise.all([
        currentBook(serverId, club.id),
        listQueue(serverId, club.id),
      ])
      const rows = [
        ...(current ? [{ ...current, slot: 'current', sourceIndex: 0 }] : []),
        ...queued.map((book, index) => ({ ...book, slot: 'queued', sourceIndex: index })),
      ]
      return { id: club.id, name: club.name, books: rows }
    }),
  )
  const books = details.flatMap((club) =>
    club.books
      .filter((book) => book?.libraryItemId)
      .map((book) => ({
        libraryItemId: book.libraryItemId,
        title: book.title,
        author: book.author,
        bookClubs: [{ id: club.id, name: club.name }],
      })),
  )
  return { details, books }
}

async function loadLibraryInputs(ctx, user) {
  const libraryData = await absJson(ctx, '/api/libraries')
  const allowed = userLibraryIds(user)
  const libraries = (libraryData?.libraries ?? []).filter(
    (library) => library.mediaType === 'book' && (!allowed || allowed.has(library.id)),
  )
  const responses = await Promise.all(
    libraries.map(async (library) => {
      const [items, series] = await Promise.all([
        absJson(ctx, `/api/libraries/${encodeURIComponent(library.id)}/items?minified=1&limit=0`),
        absJson(ctx, `/api/libraries/${encodeURIComponent(library.id)}/series?limit=100000`),
      ])
      return { library, items: items?.results ?? [], series: series?.results ?? [] }
    }),
  )
  const adminItems = responses.flatMap((response) => response.items)
  const visibleItems = adminItems.filter((item) => visibleByTagAndExplicit(item, user))
  const visibleIds = new Set(visibleItems.map((item) => item.id))
  const visibleSeries = responses.flatMap((response) =>
    response.series.map((series) => ({
      ...series,
      books: series.books.filter((book) => visibleIds.has(book.id)),
    })),
  )
  return {
    libraries,
    items: visibleItems,
    series: visibleSeries,
    hiddenByPermissions: adminItems.filter((item) => !visibleIds.has(item.id)),
  }
}

function findEntryTitle(id, ...lists) {
  for (const list of lists) {
    const match = list.find((entry) => (entry.id ?? entry.libraryItemId) === id)
    const title = match?.media?.metadata?.title ?? match?.title
    if (title) return title
  }
  return null
}

// Explain a parity failure instead of only flagging one. Any difference is a
// bug in the diagnostic mirror (queueTrace.js), not in the queue the user gets -
// Core stays the source of truth - but knowing *which* books and *which* fields
// disagree is the difference between a five-minute fix and a re-read of both
// builders.
const PARITY_SAMPLE_LIMIT = 8

function describeEntry(entry) {
  return entry ? `${entry.title || 'Untitled'} (${entry.libraryItemId})` : 'nothing'
}

function diffParity(computed, traced) {
  const diffs = []
  const length = Math.max(computed.length, traced.length)
  for (let index = 0; index < length && diffs.length < PARITY_SAMPLE_LIMIT; index++) {
    const mine = computed[index]
    const theirs = traced[index]
    if (!mine || !theirs || mine.libraryItemId !== theirs.libraryItemId) {
      diffs.push({
        kind: 'order',
        position: index,
        libraryItemId: mine?.libraryItemId ?? theirs?.libraryItemId ?? null,
        detail: `Position ${index}: Core has ${describeEntry(mine)}, trace has ${describeEntry(theirs)}`,
      })
      continue
    }
    const fields = new Set([...Object.keys(mine), ...Object.keys(theirs)])
    for (const field of fields) {
      const a = JSON.stringify(mine[field])
      const b = JSON.stringify(theirs[field])
      if (a === b) continue
      diffs.push({
        kind: 'field',
        position: index,
        libraryItemId: mine.libraryItemId,
        field,
        detail: `${describeEntry(mine)}: field "${field}" is ${a ?? 'undefined'} in Core, ${b ?? 'undefined'} in the trace`,
      })
      if (diffs.length >= PARITY_SAMPLE_LIMIT) break
    }
  }
  if (computed.length !== traced.length) {
    diffs.unshift({
      kind: 'length',
      position: null,
      libraryItemId: null,
      detail: `Core built ${computed.length} entries, the trace built ${traced.length}`,
    })
  }
  return diffs
}

export async function debugUserQueue(ctx, userId, targetItemId = null) {
  const user = await absJson(ctx, `/api/users/${encodeURIComponent(userId)}`)
  if (!user?.id) throw new Error('ABS returned no user for that id')

  const [stored, modeValue, rulesValue, dismissals, clubs, library] = await Promise.all([
    getQueue(ctx.serverId, userId),
    getUserSetting(ctx.serverId, userId, 'queueMode'),
    getUserSetting(ctx.serverId, userId, 'queueAutoRules'),
    getDismissals(ctx.serverId, userId),
    clubInputs(ctx.serverId, userId),
    loadLibraryInputs(ctx, user),
  ])
  const mode = modeValue ?? 'off'
  const rules = normalizeAutoRules(rulesValue)
  const mediaProgress = user.mediaProgress ?? []
  const progressById = new Map(mediaProgress.map((progress) => [progress.libraryItemId, progress]))
  const current = resolveCurrent(stored, progressById, mediaProgress)
  const args = {
    items: library.items,
    series: library.series,
    progressById,
    currentItemId: current.id,
    rules,
    clubBooks: clubs.books,
    manualBooks: stored.manual,
    dismissedSeriesIds: dismissals.seriesIds,
    dismissedItemIds: dismissals.itemIds,
  }
  const computed = buildAutoQueue(args)
  const trace = traceAutoQueue({ ...args, targetItemId })
  const actualIds = queueIds(computed)
  const tracedIds = queueIds(trace.items)
  const tracedComparable = trace.items.map(({ debug: _debug, ...entry }) => entry)
  const parityDiff = diffParity(computed, tracedComparable)
  const parity = parityDiff.length === 0

  let target = trace.target
  if (targetItemId && target && !target.inVisibleLibrary) {
    const hidden = library.hiddenByPermissions.find((item) => item.id === targetItemId)
    if (hidden) {
      target = {
        ...target,
        title: hidden.media?.metadata?.title ?? target.title,
        author: hidden.media?.metadata?.authorName ?? target.author,
        hiddenByPermissions: true,
      }
    } else {
      try {
        const detail = await absJson(
          ctx,
          `/api/items/${encodeURIComponent(targetItemId)}?expanded=1`,
        )
        target = {
          ...target,
          title: detail?.media?.metadata?.title ?? target.title,
          author: detail?.media?.metadata?.authorName ?? target.author,
          existsOnServer: !!detail?.id,
          hiddenByPermissions: !!detail?.id,
        }
      } catch {
        target = { ...target, existsOnServer: false }
      }
    }
  }

  const storedIds = queueIds(stored.items)
  const computedSet = new Set(actualIds)
  const storedSet = new Set(storedIds)
  const tracedById = new Map(trace.items.map((entry) => [entry.libraryItemId, entry.debug]))
  const queue = computed.map((entry, index) => ({
    ...entry,
    position: index,
    winningRule: tracedById.get(entry.libraryItemId)?.winningRule ?? null,
    sources: tracedById.get(entry.libraryItemId)?.sources ?? [],
    storedPosition: storedIds.indexOf(entry.libraryItemId),
  }))

  return {
    generatedAt: Date.now(),
    user: { id: user.id, username: user.username ?? '', type: user.type ?? 'user' },
    mode,
    rules,
    current,
    stored: {
      items: stored.items,
      manual: stored.manual,
      currentItemId: stored.currentItemId,
      updatedAt: stored.updatedAt,
    },
    inputs: {
      libraries: library.libraries.map((entry) => ({ id: entry.id, name: entry.name })),
      libraryItems: library.items.length,
      series: library.series.length,
      progressRows: mediaProgress.length,
      clubs: clubs.details,
      clubBooks: clubs.books.length,
      manualBooks: stored.manual.length,
      dismissals: {
        items: dismissals.itemIds.map((id) => ({
          id,
          title: findEntryTitle(id, library.items, stored.items, stored.manual, clubs.books),
        })),
        series: dismissals.seriesIds.map((id) => ({
          id,
          title: library.series.find((entry) => entry.id === id)?.name ?? null,
        })),
      },
      hiddenByPermissions: library.hiddenByPermissions.length,
    },
    result: {
      parity,
      parityDiff,
      queue,
      storedOnly: stored.items.filter((entry) => !computedSet.has(entry.libraryItemId)),
      computedOnly: computed.filter((entry) => !storedSet.has(entry.libraryItemId)),
      sameOrder:
        storedIds.length === actualIds.length &&
        storedIds.every((id, index) => id === actualIds[index]),
    },
    target,
    warnings: [
      ...(parity
        ? []
        : [
            `Diagnostic trace does not match the Core queue builder, so trace reasons are unsafe. The queue this user actually gets is still Core's. First difference: ${parityDiff[0].detail}`,
          ]),
      ...(mode === 'auto'
        ? []
        : [`This user is in ${mode} mode; the computed preview is informational only.`]),
      ...(user.permissions?.accessAllTags === false
        ? ['This user has tag-filtered library access; hidden items are excluded from the preview.']
        : []),
    ],
  }
}
