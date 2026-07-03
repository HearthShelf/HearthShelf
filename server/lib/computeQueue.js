// Server-authoritative Auto-mode queue. The self-hosted server is the single
// source of truth for the listening queue: it runs the SAME buildAutoQueue the
// clients ship in @hearthshelf/core (imported directly - Node 26 strips the TS
// types, no build step), persists the result, and every client just displays
// it. That's why no client recomputes the queue.
//
// Only 'auto' mode is computed here. 'manual'/'playlist'/'off' leave the stored
// queue alone (manual is the user's hand-ordered list, synced via PUT /hs/queue).
//
// Inputs the builder needs, and where they come from:
//   - library items + series: ABS, per user (ctx.absUrl + ctx.absToken)
//   - the user's media progress: ABS /api/me
//   - the current book per club the user is in: clubs.js (book-club rule)

import { buildAutoQueue, DEFAULT_AUTO_RULES } from '../../packages/core/src/lib/queue.ts'
import { getUserSetting } from '../settings.js'
import { getQueue, setQueue } from '../queue.js'
import { listMyClubs, currentBook } from '../clubs.js'

async function absJson(ctx, path) {
  const res = await fetch(`${ctx.absUrl}${path}`, {
    headers: { Authorization: `Bearer ${ctx.absToken}` },
  })
  if (!res.ok) throw new Error(`abs ${path} ${res.status}`)
  return res.json()
}

// Book libraries only - series/queue are a book concept; podcasts don't apply.
async function fetchBookLibraries(ctx) {
  const data = await absJson(ctx, '/api/libraries')
  const libs = data?.libraries ?? []
  return libs.filter((l) => l.mediaType === 'book')
}

// The user's current listening item: the most recently touched, not-finished
// progress row. buildAutoQueue drops this from the queue and uses it to seed the
// "finish current series" rule.
function currentItemIdFromProgress(mediaProgress) {
  let best = null
  for (const p of mediaProgress) {
    if (!p.libraryItemId || p.isFinished) continue
    if (!best || Number(p.lastUpdate ?? 0) > Number(best.lastUpdate ?? 0)) best = p
  }
  return best?.libraryItemId ?? null
}

// Each club the user is in contributes its current book (the book-club rule
// queues these). Snapshot title/author come straight from club_books, so a club
// pick queues even if it's outside the user's own library list.
async function clubBooksFor(serverId, userId) {
  const clubs = await listMyClubs(serverId, userId)
  const books = await Promise.all(clubs.map((c) => currentBook(serverId, c.id)))
  return books
    .filter((b) => b && b.libraryItemId)
    .map((b) => ({ libraryItemId: b.libraryItemId, title: b.title, author: b.author }))
}

/**
 * Compute (for 'auto' mode) or read (other modes) the user's queue and return
 * the QueueState shape { items, playlistId, updatedAt }. Auto results are
 * persisted with a server-stamped updatedAt so they always win the sync.
 *
 * Never throws for the caller: if ABS is unreachable mid-compute, falls back to
 * the last stored queue so the player still gets a usable response.
 */
export async function resolveQueue(ctx) {
  const { serverId, userId } = ctx
  const stored = await getQueue(serverId, userId)

  const mode = (await getUserSetting(serverId, userId, 'queueMode')) ?? 'off'
  if (mode !== 'auto') return stored

  const rules = (await getUserSetting(serverId, userId, 'queueAutoRules')) ?? DEFAULT_AUTO_RULES

  let items
  try {
    const [libraries, me, clubBooks] = await Promise.all([
      fetchBookLibraries(ctx),
      absJson(ctx, '/api/me'),
      clubBooksFor(serverId, userId),
    ])

    const itemLists = await Promise.all(
      libraries.map((l) =>
        Promise.all([
          absJson(ctx, `/api/libraries/${encodeURIComponent(l.id)}/items?minified=1&limit=0`),
          absJson(ctx, `/api/libraries/${encodeURIComponent(l.id)}/series?limit=0`),
        ]),
      ),
    )
    const allItems = itemLists.flatMap(([it]) => it?.results ?? [])
    const allSeries = itemLists.flatMap(([, se]) => se?.results ?? [])

    const mediaProgress = me?.mediaProgress ?? []
    const progressById = new Map(mediaProgress.map((p) => [p.libraryItemId, p]))

    items = buildAutoQueue({
      items: allItems,
      series: allSeries,
      progressById,
      currentItemId: currentItemIdFromProgress(mediaProgress),
      rules,
      clubBooks,
    })
  } catch {
    // ABS unreachable or a fetch failed: keep the last good queue rather than
    // wiping it or 500-ing the player.
    return stored
  }

  // Server-stamped write always applies (updatedAt >= any client's), so the
  // freshly computed auto queue becomes the shared truth across devices.
  const saved = await setQueue(serverId, userId, {
    items,
    playlistId: null,
    updatedAt: Date.now(),
  })
  return { items: saved.items, playlistId: saved.playlistId, updatedAt: saved.updatedAt }
}
