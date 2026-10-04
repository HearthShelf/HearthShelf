import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A throwaway hearthshelf.db; db.js reads QG_DATA_DIR when it is first imported.
process.env.QG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-clubtx-'))
delete process.env.HS_DB_URL

const clubs = await import('../clubs.js')
const SERVER = 'local'

async function newClub() {
  return clubs.createClub(SERVER, {
    name: 'Test club',
    createdBy: 'owner',
    username: 'owner',
    libraryItemId: 'item-1',
    bookSnapshot: { title: 'Book' },
  })
}

test('deleting a club removes it and its members in one go', async () => {
  const clubId = await newClub()
  await clubs.addMember(SERVER, clubId, 'member', 'member')
  assert.equal(await clubs.deleteClub(SERVER, clubId), true)
  assert.equal(await clubs.getClub(SERVER, clubId), null)
  assert.equal(await clubs.memberCount(SERVER, clubId), 0)
  assert.equal(await clubs.deleteClub(SERVER, clubId), false)
})

test('accepting an invite marks it accepted and adds the member', async () => {
  const clubId = await newClub()
  const { id: inviteId } = await clubs.createClubInvite(SERVER, clubId, {
    inviterUserId: 'owner',
    inviterUsername: 'owner',
    inviteeUserId: 'friend',
    inviteeUsername: 'friend',
  })
  const res = await clubs.respondToClubInvite(SERVER, inviteId, 'friend', true)
  assert.equal(res?.status, 'accepted')
  assert.equal(await clubs.isClubMember(SERVER, clubId, 'friend'), true)
  // A second answer to the same invite is a no-op, not an error.
  assert.equal(await clubs.respondToClubInvite(SERVER, inviteId, 'friend', false), null)
})

test('an invite for someone else is refused without changing anything', async () => {
  const clubId = await newClub()
  const { id: inviteId } = await clubs.createClubInvite(SERVER, clubId, {
    inviterUserId: 'owner',
    inviterUsername: 'owner',
    inviteeUserId: 'friend',
    inviteeUsername: 'friend',
  })
  assert.equal(await clubs.respondToClubInvite(SERVER, inviteId, 'stranger', true), null)
  assert.equal((await clubs.getClubInvite(SERVER, inviteId))?.status, 'pending')
})

test('concurrent writes wait for each other instead of failing', async () => {
  const ids = await Promise.all(Array.from({ length: 20 }, () => newClub()))
  assert.equal(new Set(ids).size, 20)
  const deleted = await Promise.all(ids.map((id) => clubs.deleteClub(SERVER, id)))
  assert.deepEqual(deleted, Array(20).fill(true))
})
