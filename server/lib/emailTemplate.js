// Shared look for every HearthShelf-owned activity email. Content callers pass
// the event plus its real subjects (book/person); this module owns layout,
// preference links, fallbacks and the matching plain-text alternative.

import { FLAME_PNG_BASE64 } from './emailFlame.js'

const HEARTH_GOLD = '#bd863f'
const EMBER = '#e0654a'
const INK = '#1f1d1b'
const MUTED = '#6b6459'
const FAINT = '#6b6459'
const HAIRLINE = '#e6e1d8'
const PAGE = '#f6f3ee'
const WASH = '#f1ece4'
const COVER = '#2a2825'
const APP_ORIGIN = (process.env.HS_APP_ORIGIN || 'https://app.hearthshelf.com').replace(/\/$/, '')

const TYPE_LABELS = {
  release: 'book update',
  mention: 'mention',
  clubInvite: 'book club invitation',
  reaction: 'reaction',
  reply: 'reply',
  lateNote: 'heard-part comment',
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function shorten(value, max) {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text
}

function personBlock(person) {
  if (!person?.name) return ''
  const visual = person.imageSrc
    ? `<img src="${escapeHtml(person.imageSrc)}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;border-radius:999px;object-fit:cover;border:0;">`
    : `<table role="presentation" width="44" height="44" cellpadding="0" cellspacing="0" border="0"><tr><td width="44" height="44" align="center" valign="middle" bgcolor="${COVER}" style="width:44px;height:44px;border-radius:999px;color:#fffaf6;font-size:14px;font-weight:750;">${escapeHtml(person.initials || 'HS')}</td></tr></table>`
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
    <tr>
      <td style="padding-right:12px;vertical-align:middle;">${visual}</td>
      <td style="vertical-align:middle;color:${INK};font-size:15px;line-height:1.35;font-weight:700;">${escapeHtml(person.name)}</td>
    </tr>
  </table>`
}

function fallbackCover(book) {
  return `<table role="presentation" width="88" height="132" cellpadding="0" cellspacing="0" border="0" bgcolor="${COVER}" style="width:88px;height:132px;background:${COVER};border-radius:10px;">
    <tr><td valign="top" style="padding:12px 10px;color:#fffaf6;font-family:Georgia,'Times New Roman',serif;font-size:12px;line-height:1.35;font-weight:700;">
      <span style="display:block;width:24px;border-top:2px solid ${HEARTH_GOLD};margin-bottom:10px;"></span>${escapeHtml(shorten(book.title, 46))}
    </td></tr>
  </table>`
}

function bookBlock(book) {
  if (!book?.title) return ''
  const cover = book.imageSrc
    ? `<img src="${escapeHtml(book.imageSrc)}" width="88" alt="Cover of ${escapeHtml(book.title)}" style="display:block;width:88px;max-height:132px;border-radius:10px;object-fit:cover;border:0;">`
    : fallbackCover(book)
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;background:${WASH};border-radius:12px;">
    <tr>
      <td width="88" style="width:88px;padding:14px;vertical-align:middle;">${cover}</td>
      <td style="padding:16px 18px 16px 2px;vertical-align:middle;">
        <p style="margin:0;color:${INK};font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.35;font-weight:700;">${escapeHtml(book.title)}</p>
        ${book.author ? `<p style="margin:7px 0 0;color:${MUTED};font-size:13px;line-height:1.45;">${escapeHtml(book.author)}</p>` : ''}
      </td>
    </tr>
  </table>`
}

function preferencesBlock(notificationType) {
  const typeLabel = TYPE_LABELS[notificationType]
  if (!typeLabel) return ''
  const settingsUrl = `${APP_ORIGIN}/account/notifications`
  const disableUrl = `${settingsUrl}?disableEmail=${encodeURIComponent(notificationType)}`
  return `<p style="margin:16px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${FAINT};text-align:center;">
    <a href="${escapeHtml(settingsUrl)}" style="color:${MUTED};text-decoration:underline;text-underline-offset:2px;">Notification settings</a>
    <span aria-hidden="true">&nbsp;·&nbsp;</span>
    <a href="${escapeHtml(disableUrl)}" style="color:${MUTED};text-decoration:underline;text-underline-offset:2px;">Turn off ${escapeHtml(typeLabel)} emails</a>
  </p>`
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {string} [opts.quote]
 * @param {string} [opts.actionUrl]
 * @param {string} [opts.actionLabel]
 * @param {string} [opts.footnote]
 * @param {{name:string, initials?:string, imageSrc?:string, attachment?:object}} [opts.person]
 * @param {{title:string, author?:string, imageSrc?:string, attachment?:object}} [opts.book]
 * @param {'release'|'mention'|'clubInvite'|'reaction'|'reply'|'lateNote'} [opts.notificationType]
 */
export function renderEmail({
  title,
  body = '',
  quote = '',
  actionUrl = '',
  actionLabel = 'Open HearthShelf',
  footnote = '',
  person,
  book,
  notificationType,
}) {
  const safeTitle = escapeHtml(title)
  const safeBody = escapeHtml(body)
  const safeQuote = escapeHtml(quote)
  const safeUrl = escapeHtml(actionUrl)
  const safeLabel = escapeHtml(actionLabel)
  const safeFootnote = escapeHtml(footnote)

  const quoteBlock = quote
    ? `<div style="margin:0 0 22px;padding:14px 16px;background:${WASH};border:1px solid ${HAIRLINE};border-radius:12px;color:${MUTED};font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;">“${safeQuote}”</div>`
    : ''
  const bodyBlock = body
    ? `<p style="margin:0 0 20px;font-size:16px;line-height:1.65;color:${MUTED};">${safeBody}</p>`
    : ''
  const button = actionUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 8px;"><tr><td bgcolor="${EMBER}" style="border-radius:12px;"><a href="${safeUrl}" style="display:inline-block;padding:13px 22px;font-size:15px;line-height:1;font-weight:700;color:${INK};text-decoration:none;border-radius:12px;">${safeLabel}</a></td></tr></table>`
    : ''
  const footnoteBlock = footnote
    ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.55;color:${FAINT};">${safeFootnote}</p>`
    : ''

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:${PAGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safeBody || safeTitle}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid ${HAIRLINE};border-radius:16px;">
        <tr><td style="padding:26px 28px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding-right:9px;vertical-align:middle;"><img src="cid:hearthshelf-flame" width="24" height="27" alt="" style="display:block;border:0;"></td>
            <td style="vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:20px;line-height:1;"><span style="color:${HEARTH_GOLD};font-weight:400;">Hearth</span><span style="color:${INK};font-weight:700;">Shelf</span></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:0 28px 30px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          ${personBlock(person)}
          <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;letter-spacing:-0.02em;font-weight:750;color:${INK};">${safeTitle}</h1>
          ${bodyBlock}
          ${bookBlock(book)}
          ${quoteBlock}
          ${button}
          ${footnoteBlock}
        </td></tr>
      </table>
      ${preferencesBlock(notificationType)}
    </td></tr>
  </table>
</body>
</html>`

  const settingsUrl = `${APP_ORIGIN}/account/notifications`
  const disableUrl = notificationType
    ? `${settingsUrl}?disableEmail=${encodeURIComponent(notificationType)}`
    : ''
  const typeLabel = TYPE_LABELS[notificationType]
  const text = [
    person?.name ? `From: ${person.name}` : '',
    title,
    body,
    book?.title ? `Book: ${book.title}${book.author ? ` — ${book.author}` : ''}` : '',
    quote ? `\n“${quote}”` : '',
    actionUrl ? `\n${actionLabel}: ${actionUrl}` : '',
    footnote,
    notificationType ? `\nNotification settings: ${settingsUrl}` : '',
    notificationType && typeLabel ? `Turn off ${typeLabel} emails: ${disableUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const attachments = [
    {
      filename: 'hearthshelf-flame.png',
      content: FLAME_PNG_BASE64,
      content_id: 'hearthshelf-flame',
    },
    person?.attachment,
    book?.attachment,
  ].filter(Boolean)

  return { html, text, attachments }
}
