import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAutoQueue } from '@hearthshelf/core/lib/queue'
import { traceAutoQueue, queueIds } from '../lib/queueTrace.js'

const item = (id, title = id) => ({
  id,
  libraryId: 'library',
  media: { metadata: { title, authorName: 'Author', series: [] }, tags: [] },
})

const series = (id, books) => ({ id, name: id, books })
const rules = (...ids) => ids.map((id) => ({ id, on: true }))

function run(overrides = {}) {
  const args = {
    items: [item('b1'), item('b2'), item('b3'), item('b4')],
    series: [series('series', [item('b1'), item('b2'), item('b3'), item('b4')])],
    progressById: new Map(),
    currentItemId: 'b1',
    rules: rules('book-club', 'finish-series', 'in-progress', 'new-in-series', 'manual'),
    clubBooks: [],
    manualBooks: [],
    dismissedSeriesIds: [],
    dismissedItemIds: [],
    ...overrides,
  }
  const actual = buildAutoQueue(args)
  const traced = traceAutoQueue(args)
  assert.deepEqual(queueIds(traced.items), queueIds(actual))
  return traced
}

test('Book Club wins position while Current series remains a secondary match', () => {
  const traced = run({
    clubBooks: [
      { libraryItemId: 'b2', title: 'Book 2', bookClubs: [{ id: 'club', name: 'Club' }] },
    ],
    targetItemId: 'b2',
  })
  assert.equal(traced.target.included, true)
  assert.equal(traced.target.winningRule, 'book-club')
  assert.deepEqual(
    traced.target.sources.map((source) => [source.ruleId, source.reason]),
    [
      ['book-club', 'added'],
      ['finish-series', 'duplicate'],
    ],
  )
})

test('an item dismissal explains exclusion from every matching rule', () => {
  const traced = run({
    clubBooks: [{ libraryItemId: 'b2', title: 'Book 2' }],
    dismissedItemIds: ['b2'],
    targetItemId: 'b2',
  })
  assert.equal(traced.target.included, false)
  assert.equal(traced.target.dismissedItem, true)
  assert.ok(traced.target.sources.length >= 2)
  assert.ok(traced.target.sources.every((source) => source.reason === 'dismissed_item'))
})

test('the current item is excluded from club, series, and in-progress candidates', () => {
  const progressById = new Map([['b1', { libraryItemId: 'b1', progress: 0.25, isFinished: false }]])
  const traced = run({
    progressById,
    clubBooks: [{ libraryItemId: 'b1', title: 'Book 1' }],
    targetItemId: 'b1',
  })
  assert.equal(traced.target.included, false)
  assert.equal(traced.target.isCurrentItem, true)
  assert.ok(traced.target.sources.every((source) => source.reason === 'current_item'))
})

test('finished items are excluded even when Club and series both supply them', () => {
  const progressById = new Map([['b2', { libraryItemId: 'b2', progress: 1, isFinished: true }]])
  const traced = run({
    progressById,
    clubBooks: [{ libraryItemId: 'b2', title: 'Book 2' }],
    targetItemId: 'b2',
  })
  assert.equal(traced.target.included, false)
  assert.equal(traced.target.isFinished, true)
  assert.ok(traced.target.sources.every((source) => source.reason === 'finished'))
})

test('Book Club fallback can queue an item outside the visible library', () => {
  const traced = run({
    currentItemId: null,
    rules: rules('book-club'),
    clubBooks: [{ libraryItemId: 'external', title: 'External club book', author: 'Author' }],
    targetItemId: 'external',
  })
  assert.equal(traced.target.included, true)
  assert.equal(traced.target.inVisibleLibrary, false)
  assert.equal(traced.items[0].title, 'External club book')
})

test('a dismissed series blocks series rules but not an independent Club match', () => {
  const traced = run({
    rules: rules('finish-series', 'book-club'),
    clubBooks: [{ libraryItemId: 'b2', title: 'Book 2' }],
    dismissedSeriesIds: ['series'],
    targetItemId: 'b2',
  })
  assert.equal(traced.target.included, true)
  assert.equal(traced.target.winningRule, 'book-club')
  assert.ok(
    traced.target.rules
      .find((rule) => rule.id === 'finish-series')
      .attempts.some((attempt) => attempt.reason === 'dismissed_series'),
  )
})

test('the one-book started-series limit explains why a later item is not selected', () => {
  const progressById = new Map([['b1', { libraryItemId: 'b1', progress: 1, isFinished: true }]])
  const traced = run({
    currentItemId: null,
    progressById,
    rules: rules('new-in-series'),
    targetItemId: 'b3',
  })
  assert.deepEqual(queueIds(traced.items), ['b2'])
  assert.ok(
    traced.target.rules
      .find((rule) => rule.id === 'new-in-series')
      .attempts.some((attempt) => attempt.reason === 'earlier_series_book_won_limit'),
  )
})

test('manual matches are retained as provenance after a higher-priority match', () => {
  const traced = run({
    rules: rules('book-club', 'manual'),
    clubBooks: [{ libraryItemId: 'b2', title: 'Book 2' }],
    manualBooks: [{ libraryItemId: 'b2', title: 'Book 2' }],
    targetItemId: 'b2',
  })
  assert.equal(traced.target.winningRule, 'book-club')
  assert.deepEqual(
    traced.target.sources.map((source) => source.reason),
    ['added', 'duplicate'],
  )
})
