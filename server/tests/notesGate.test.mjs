// The spoiler gate is a privacy boundary: an ahead-of-position comment must
// reach the client as a placeholder carrying position + nesting ONLY. These
// tests pin that bodies and authors never ride along on a stub.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QG_DATA_DIR ??= process.env.TEMP || '/tmp'
const { gateNotes } = await import('../lib/notesQuery.js')

const rows = () => [
  { id: 'behind', parentId: '', timeSec: 10, body: 'behind body', createdAt: 1, userId: 'u1' },
  { id: 'ahead', parentId: '', timeSec: 600, body: 'SPOILER', createdAt: 2, userId: 'u2' },
  { id: 'aheadReply', parentId: 'ahead', timeSec: null, body: 'SPOILER2', createdAt: 3, userId: 'u3' },
  { id: 'behindReply', parentId: 'behind', timeSec: null, body: 'ok', createdAt: 4, userId: 'u4' },
]

const gate = (opts = {}) =>
  gateNotes(rows(), { position: 60, meId: 'nobody', isFinished: false, includeLocked: true, ...opts })

test('unlocked notes keep bodies, locked ones do not appear', () => {
  const g = gate()
  assert.deepEqual(
    g.notes.map((n) => n.id).sort(),
    ['behind', 'behindReply'],
  )
  assert.equal(g.hiddenAhead, 2)
})

test('a locked reply gets its own stub, nested under its parent', () => {
  const { locked } = gate()
  assert.deepEqual(locked, [
    { id: 'ahead', timeSec: 600 },
    // The reply has no timeSec of its own; it reports its parent's.
    { id: 'aheadReply', timeSec: 600, parentId: 'ahead' },
  ])
})

test('stubs never carry a body or an author', () => {
  const { locked } = gate()
  const serialized = JSON.stringify(locked)
  assert.equal(/SPOILER/.test(serialized), false, 'stub leaked a body')
  assert.equal(/u2|u3/.test(serialized), false, 'stub leaked an author')
  for (const stub of locked) {
    assert.deepEqual(
      Object.keys(stub).sort(),
      stub.parentId ? ['id', 'parentId', 'timeSec'] : ['id', 'timeSec'],
    )
  }
})

test('includeLocked=false withholds stubs but still counts them', () => {
  const g = gate({ includeLocked: false })
  assert.deepEqual(g.locked, [])
  assert.equal(g.hiddenAhead, 2)
})

test('finishing the book unlocks everything', () => {
  const g = gate({ isFinished: true })
  assert.equal(g.hiddenAhead, 0)
  assert.deepEqual(g.locked, [])
  assert.equal(g.notes.length, 4)
})

test('the author of an ahead note still reads their own', () => {
  const g = gate({ meId: 'u2' })
  assert.ok(g.notes.some((n) => n.id === 'ahead'))
  // The reply is someone else's and stays locked behind position.
  assert.ok(g.locked.some((s) => s.id === 'aheadReply'))
})
