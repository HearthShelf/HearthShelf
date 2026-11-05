// The build-then-download flow holds server secrets in a temp file, so these pin
// that it builds one at a time, can't be reached by a made-up id, and cleans up.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-archive-builds-'))
process.env.QG_DATA_DIR ??= dir
const { startArchiveBuild, getArchiveBuild, archiveBuildFile, finishArchiveBuild } = await import('../lib/archive.js')

const made = () => async () => ({ buffer: Buffer.from('archive'), filename: 'server.hsarchive' })

async function settled(id) {
  for (let i = 0; i < 200; i++) {
    const build = getArchiveBuild(id)
    if (build?.status !== 'building') return build
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('build never settled')
}

test('a second start returns the running build instead of starting another', async () => {
  let release
  let calls = 0
  const create = async () => {
    calls += 1
    await new Promise((resolve) => (release = resolve))
    return { buffer: Buffer.from('archive'), filename: 'a.hsarchive' }
  }
  const first = await startArchiveBuild('t', null, { create, dir })
  const second = await startArchiveBuild('t', null, { create, dir })
  assert.equal(second.id, first.id)
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5))
  release()
  await settled(first.id)
  assert.equal(calls, 1)
  await finishArchiveBuild(first.id)
})

test('a finished build can be fetched, then its file is gone', async () => {
  const { id } = await startArchiveBuild('t', null, { create: made(), dir })
  const build = await settled(id)
  assert.equal(build.status, 'ready')
  assert.equal(build.size, 7)
  const file = archiveBuildFile(id)
  assert.equal(await fs.readFile(file.path, 'utf8'), 'archive')
  await finishArchiveBuild(id)
  assert.equal(getArchiveBuild(id), null)
  assert.equal(archiveBuildFile(id), null)
  await assert.rejects(fs.stat(file.path))
})

test('an id that is not the current build reaches nothing', async () => {
  const { id } = await startArchiveBuild('t', null, { create: made(), dir })
  await settled(id)
  for (const bad of ['../../etc/passwd', '..', `${id}/..`, '']) {
    assert.equal(getArchiveBuild(bad), null)
    assert.equal(archiveBuildFile(bad), null)
  }
  await finishArchiveBuild(id)
})

test('a build nobody fetches is deleted after the timeout', async () => {
  const { id } = await startArchiveBuild('t', null, { create: made(), dir, ttlMs: 20 })
  await settled(id)
  const { path: file } = archiveBuildFile(id)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(getArchiveBuild(id), null)
  await assert.rejects(fs.stat(file))
})

test('a failed build reports its error and leaves no file', async () => {
  const create = async () => {
    throw new Error('disk full')
  }
  const { id } = await startArchiveBuild('t', null, { create, dir })
  const build = await settled(id)
  assert.equal(build.status, 'error')
  assert.equal(build.error, 'disk full')
  assert.equal(archiveBuildFile(id), null)
  await finishArchiveBuild(id)
  assert.deepEqual(
    (await fs.readdir(dir)).filter((f) => f.startsWith('.archive-build-')),
    [],
  )
})

test('leftover files from a dead process are removed by the next build', async () => {
  const stray = path.join(dir, '.archive-build-old.hsarchive')
  await fs.writeFile(stray, 'old')
  const { id } = await startArchiveBuild('t', null, { create: made(), dir })
  await settled(id)
  await assert.rejects(fs.stat(stray))
  await finishArchiveBuild(id)
})
