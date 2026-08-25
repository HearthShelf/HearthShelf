// Explain the pure Auto Queue builder without changing the stored queue.
//
// This intentionally mirrors @hearthshelf/core's buildAutoQueue rule order and
// filters, but never replaces it as the source of truth. The admin debugger runs
// both functions and reports a parity failure if their output ids ever diverge.
// That guard lets this file be verbose and diagnostic without risking a second
// production queue implementation silently taking over.

function isFinished(id, progressById) {
  return !!progressById.get(id)?.isFinished
}

function isStarted(id, progressById) {
  const progress = progressById.get(id)
  return !!progress && !progress.isFinished && Number(progress.progress) > 0
}

function entryOf(item) {
  const metadata = item.media?.metadata ?? {}
  return {
    libraryItemId: item.id,
    title: metadata.title ?? 'Untitled',
    author: metadata.authorName ?? '',
  }
}

function mergeBookClubs(existing, incoming) {
  if (!incoming?.length) return existing
  const merged = [...(existing ?? [])]
  const seen = new Set(merged.map((club) => club.id))
  for (const club of incoming) {
    if (!club?.id || seen.has(club.id)) continue
    seen.add(club.id)
    merged.push({ id: club.id, name: club.name })
  }
  return merged.length ? merged : undefined
}

function labelForRule(id) {
  return (
    {
      'finish-series': 'Current series',
      'in-progress': 'In progress',
      'new-in-series': 'Started series',
      'new-in-series-all': 'All remaining series books',
      'book-club': 'Book Club',
      manual: 'Hand queued',
    }[id] ?? id
  )
}

function makeRuleReports(rules) {
  return rules.map((rule, priority) => ({
    id: rule.id,
    label: labelForRule(rule.id),
    priority,
    enabled: !!rule.on,
    attempts: [],
    added: 0,
  }))
}

/**
 * Run an instrumented mirror of buildAutoQueue.
 *
 * `targetItemId` is optional. When supplied, the response includes the rule
 * reasons needed to answer why that exact GUID is present or absent. The full
 * trace still records sources for every item that reached a rule so included
 * queue rows can show all matches and the winning rule.
 */
export function traceAutoQueue({
  items,
  series,
  progressById,
  currentItemId,
  rules,
  clubBooks = [],
  manualBooks = [],
  dismissedSeriesIds,
  dismissedItemIds,
  targetItemId = null,
}) {
  const itemById = new Map(items.map((item) => [item.id, item]))
  const dismissedSeries = new Set(dismissedSeriesIds ?? [])
  const dismissedItems = new Set(dismissedItemIds ?? [])
  const collected = []
  const collectedById = new Map()
  const sourcesById = new Map()
  const ruleReports = makeRuleReports(rules)
  const ruleReportById = new Map(ruleReports.map((report) => [report.id, report]))
  const targetNotes = []

  const noteTarget = (ruleId, result, reason, context = {}) => {
    if (!targetItemId) return
    const report = ruleReportById.get(ruleId)
    if (!report) return
    report.attempts.push({ result, reason, ...context })
  }

  const recordSource = (id, source) => {
    const list = sourcesById.get(id) ?? []
    list.push(source)
    sourcesById.set(id, list)
  }

  const push = (ruleId, id, fallback, context = {}) => {
    if (!id) {
      if (targetItemId && fallback?.libraryItemId === targetItemId) {
        noteTarget(ruleId, 'excluded', 'missing_guid', context)
      }
      return false
    }

    let reason = 'added'
    let result = 'included'
    if (id === currentItemId) {
      reason = 'current_item'
      result = 'excluded'
    } else if (isFinished(id, progressById)) {
      reason = 'finished'
      result = 'excluded'
    } else if (dismissedItems.has(id)) {
      reason = 'dismissed_item'
      result = 'excluded'
    } else if (!itemById.has(id) && !fallback) {
      reason = 'missing_library_item'
      result = 'excluded'
    } else if (collectedById.has(id)) {
      reason = 'duplicate'
      result = 'matched'
    }

    const source = { ruleId, ruleLabel: labelForRule(ruleId), result, reason, ...context }
    recordSource(id, source)
    if (id === targetItemId) noteTarget(ruleId, result, reason, context)
    if (reason !== 'added') {
      if (reason === 'duplicate') {
        const existing = collectedById.get(id)
        existing.bookClubs = mergeBookClubs(existing.bookClubs, fallback?.bookClubs)
      }
      return false
    }

    const item = itemById.get(id)
    const entry = item ? entryOf(item) : { ...fallback }
    entry.bookClubs = mergeBookClubs(entry.bookClubs, fallback?.bookClubs)
    collectedById.set(id, entry)
    collected.push(entry)
    const report = ruleReportById.get(ruleId)
    if (report) report.added++
    return true
  }

  const seriesOf = (id) =>
    series.filter((candidate) => candidate.books.some((book) => book.id === id))
  const allNewInSeries = rules.some((rule) => rule.id === 'new-in-series-all' && rule.on)

  for (const rule of rules) {
    if (!rule.on) continue
    const id = rule.id
    if (id === 'finish-series') {
      if (!currentItemId) {
        if (targetItemId) noteTarget(id, 'not_candidate', 'no_current_item')
        continue
      }
      const currentSeries = seriesOf(currentItemId)
      let targetSharedSeries = false
      for (const current of currentSeries) {
        const targetIndex = targetItemId
          ? current.books.findIndex((book) => book.id === targetItemId)
          : -1
        if (targetIndex >= 0) targetSharedSeries = true
        if (dismissedSeries.has(current.id)) {
          if (targetIndex >= 0) {
            noteTarget(id, 'excluded', 'dismissed_series', {
              seriesId: current.id,
              seriesName: current.name,
            })
          }
          continue
        }
        const currentIndex = current.books.findIndex((book) => book.id === currentItemId)
        if (targetIndex >= 0 && targetIndex <= currentIndex) {
          noteTarget(id, 'not_candidate', 'not_after_current_item', {
            seriesId: current.id,
            seriesName: current.name,
          })
        }
        for (const book of current.books.slice(currentIndex + 1)) {
          push(id, book.id, undefined, { seriesId: current.id, seriesName: current.name })
        }
      }
      if (targetItemId && !targetSharedSeries) {
        noteTarget(id, 'not_candidate', 'not_in_current_series')
      }
    } else if (id === 'in-progress') {
      const started = items.filter((item) => isStarted(item.id, progressById))
      started.sort((a, b) => {
        const aTouched = Number(progressById.get(a.id)?.lastUpdate ?? 0)
        const bTouched = Number(progressById.get(b.id)?.lastUpdate ?? 0)
        return bTouched - aTouched
      })
      for (const item of started) push(id, item.id)
      if (targetItemId && !started.some((item) => item.id === targetItemId)) {
        const progress = progressById.get(targetItemId)
        noteTarget(
          id,
          'not_candidate',
          progress?.isFinished ? 'finished' : progress ? 'progress_is_zero' : 'no_progress',
        )
      }
    } else if (id === 'new-in-series') {
      const targetMemberships = []
      for (const candidate of series) {
        const targetInSeries = targetItemId
          ? candidate.books.some((book) => book.id === targetItemId)
          : false
        if (targetInSeries) targetMemberships.push(candidate.id)
        if (dismissedSeries.has(candidate.id)) {
          if (targetInSeries) {
            noteTarget(id, 'excluded', 'dismissed_series', {
              seriesId: candidate.id,
              seriesName: candidate.name,
            })
          }
          continue
        }
        const touched = candidate.books.some(
          (book) => isFinished(book.id, progressById) || isStarted(book.id, progressById),
        )
        const complete = candidate.books.every((book) => isFinished(book.id, progressById))
        if (!touched || complete) {
          if (targetInSeries) {
            noteTarget(id, 'not_candidate', touched ? 'series_complete' : 'series_not_started', {
              seriesId: candidate.id,
              seriesName: candidate.name,
            })
          }
          continue
        }
        for (const book of candidate.books) {
          if (isFinished(book.id, progressById)) {
            if (book.id === targetItemId) {
              noteTarget(id, 'excluded', 'finished', {
                seriesId: candidate.id,
                seriesName: candidate.name,
              })
            }
            continue
          }
          const added = push(id, book.id, undefined, {
            seriesId: candidate.id,
            seriesName: candidate.name,
          })
          if (added && !allNewInSeries) {
            if (
              targetItemId &&
              book.id !== targetItemId &&
              candidate.books
                .slice(candidate.books.indexOf(book) + 1)
                .some((rest) => rest.id === targetItemId)
            ) {
              noteTarget(id, 'not_candidate', 'earlier_series_book_won_limit', {
                seriesId: candidate.id,
                seriesName: candidate.name,
              })
            }
            break
          }
        }
      }
      if (targetItemId && targetMemberships.length === 0) {
        noteTarget(id, 'not_candidate', 'not_in_series_metadata')
      }
    } else if (id === 'new-in-series-all') {
      if (targetItemId) {
        noteTarget(id, 'modifier', allNewInSeries ? 'modifier_enabled' : 'modifier_disabled')
      }
    } else if (id === 'book-club') {
      const matches = clubBooks.filter((book) => book.libraryItemId === targetItemId)
      for (const [index, book] of clubBooks.entries()) {
        push(id, book.libraryItemId, book, {
          sourceIndex: index,
          clubs: book.bookClubs ?? [],
        })
      }
      if (targetItemId && matches.length === 0) noteTarget(id, 'not_candidate', 'not_in_club_input')
    } else if (id === 'manual') {
      const matches = manualBooks.filter((book) => book.libraryItemId === targetItemId)
      for (const [index, book] of manualBooks.entries()) {
        push(id, book.libraryItemId, book, { sourceIndex: index })
      }
      if (targetItemId && matches.length === 0) noteTarget(id, 'not_candidate', 'not_hand_queued')
    }
  }

  for (const [index, entry] of collected.entries()) {
    const sources = sourcesById.get(entry.libraryItemId) ?? []
    entry.debug = {
      position: index,
      winningRule: sources.find((source) => source.reason === 'added')?.ruleId ?? null,
      sources,
    }
  }

  let target = null
  if (targetItemId) {
    const item = itemById.get(targetItemId)
    const progress = progressById.get(targetItemId) ?? null
    const queueIndex = collected.findIndex((entry) => entry.libraryItemId === targetItemId)
    const sources = sourcesById.get(targetItemId) ?? []
    const memberships = seriesOf(targetItemId).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      dismissed: dismissedSeries.has(candidate.id),
      sequence:
        candidate.books
          .find((book) => book.id === targetItemId)
          ?.media?.metadata?.series?.find((ref) => ref.id === candidate.id)?.sequence ?? null,
    }))
    target = {
      libraryItemId: targetItemId,
      title: item?.media?.metadata?.title ?? null,
      author: item?.media?.metadata?.authorName ?? null,
      inVisibleLibrary: !!item,
      isCurrentItem: targetItemId === currentItemId,
      isFinished: !!progress?.isFinished,
      progress: progress
        ? {
            progress: Number(progress.progress ?? 0),
            currentTime: Number(progress.currentTime ?? 0),
            duration: Number(progress.duration ?? 0),
            isFinished: !!progress.isFinished,
            lastUpdate: Number(progress.lastUpdate ?? progress.updatedAt ?? 0),
          }
        : null,
      dismissedItem: dismissedItems.has(targetItemId),
      series: memberships,
      included: queueIndex >= 0,
      position: queueIndex >= 0 ? queueIndex : null,
      winningRule: sources.find((source) => source.reason === 'added')?.ruleId ?? null,
      sources,
      rules: ruleReports,
      notes: targetNotes,
    }
  }

  return { items: collected, target, rules: ruleReports }
}

export function queueIds(items) {
  return items.map((item) => item.libraryItemId)
}
