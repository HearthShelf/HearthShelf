import assert from 'node:assert/strict'
import test from 'node:test'
import { renderEmail } from '../lib/emailTemplate.js'
import { remoteBookEmailMedia } from '../lib/emailMedia.js'

test('activity email carries person, book, action, and per-type controls', () => {
  const email = renderEmail({
    title: 'Jeremy mentioned you',
    quote: 'This chapter changes everything.',
    person: {
      name: 'Jeremy Powers',
      initials: 'JP',
      imageSrc: 'cid:hearthshelf-reader-avatar',
      attachment: { filename: 'avatar.webp', content: 'abc', content_id: 'avatar' },
    },
    book: {
      title: 'The Long Way Home',
      author: 'A. Reader',
      imageSrc: 'cid:hearthshelf-book-cover',
      attachment: { filename: 'cover.webp', content: 'def', content_id: 'cover' },
    },
    notificationType: 'mention',
    actionUrl: 'https://app.hearthshelf.com/club/one?note=two',
    actionLabel: 'Open the discussion',
  })

  assert.match(email.html, /Jeremy Powers/)
  assert.match(email.html, /Cover of The Long Way Home/)
  assert.match(email.html, /Notification settings/)
  assert.match(email.html, /disableEmail=mention/)
  assert.match(email.text, /Turn off mention emails/)
  assert.equal(email.attachments.length, 3)
})

test('activity email escapes user and book content', () => {
  const email = renderEmail({
    title: '<script>alert(1)</script>',
    book: { title: 'A & B' },
    notificationType: 'release',
  })
  assert.doesNotMatch(email.html, /<script>/)
  assert.match(email.html, /&lt;script&gt;/)
  assert.match(email.html, /A &amp; B/)
})

test('remote cover failure keeps the designed title fallback', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 503 })
  try {
    const book = await remoteBookEmailMedia(
      'The Long Way Home',
      'A. Reader',
      'https://images.example/cover.jpg',
    )
    assert.deepEqual(book, { title: 'The Long Way Home', author: 'A. Reader' })
  } finally {
    globalThis.fetch = originalFetch
  }
})
