// Shared look for every HearthShelf-owned transactional email.
//
// Each feature used to build its own body inline - `<p>text</p><p><a>link</a></p>`
// with no styling at all - so a club invite, a mention and a release alert all
// arrived as bare browser-default text with a naked blue link, indistinguishable
// from anything else in the inbox. Reported as "these emails need to be themed".
//
// This is the one place that decides how they look. Callers pass content
// (title/body/action) and get back a complete HTML document plus a matching
// plain-text alternative, so a new email type cannot drift from the rest.
//
// Constraints that shaped it, in case this is edited later:
//   - Mail clients strip <style> blocks and ignore most modern CSS. Everything
//     here is INLINE styles on table/div elements, which is the only thing that
//     renders consistently across Gmail, Outlook and Apple Mail.
//   - No external images or webfonts: remote content is blocked by default in
//     most clients, so the wordmark is text and the palette is hex literals.
//   - Dark-on-light. Several clients invert or recolour dark backgrounds
//     unpredictably, and a light card renders the same everywhere.
//   - Every message ships a text/plain alternative. Some clients prefer it, and
//     it is what accessibility tooling and plain-text readers use.

// Hearth ember - the app's default accent (see EMBER in the mobile theme).
const ACCENT = '#e0654a'
const INK = '#1f1d1b'
const MUTED = '#6b6459'
const HAIRLINE = '#e6e1d8'
const PAGE_BG = '#f6f3ee'
const CARD_BG = '#ffffff'

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

/**
 * Build a themed HearthShelf email.
 *
 * @param {object} opts
 * @param {string} opts.title    Headline - what happened. Plain text; escaped here.
 * @param {string} [opts.body]   One or two sentences of detail. Plain text.
 * @param {string} [opts.quote]  Optional quoted content (a comment being replied
 *                               to, a mention). Rendered in an accent-barred
 *                               block so it reads as someone else's words.
 * @param {string} [opts.actionUrl]   Destination for the button.
 * @param {string} [opts.actionLabel] Button text. Defaults to "Open HearthShelf".
 * @param {string} [opts.footnote]    Small print under the button.
 * @returns {{ html: string, text: string }}
 */
export function renderEmail({
  title,
  body = '',
  quote = '',
  actionUrl = '',
  actionLabel = 'Open HearthShelf',
  footnote = '',
}) {
  const safeTitle = escapeHtml(title)
  const safeBody = escapeHtml(body)
  const safeQuote = escapeHtml(quote)
  const safeUrl = escapeHtml(actionUrl)
  const safeLabel = escapeHtml(actionLabel)
  const safeFootnote = escapeHtml(footnote)

  const quoteBlock = quote
    ? `<div style="margin:0 0 20px;padding:12px 16px;background:${PAGE_BG};border-left:3px solid ${ACCENT};border-radius:4px;color:${MUTED};font-size:15px;line-height:1.5;">${safeQuote}</div>`
    : ''

  // A bulletproof-ish button: a table cell with a background, which Outlook
  // renders where a styled <a> alone collapses to plain text.
  const button = actionUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;">
         <tr>
           <td align="center" bgcolor="${ACCENT}" style="border-radius:8px;">
             <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${safeLabel}</a>
           </td>
         </tr>
       </table>`
    : ''

  const footnoteBlock = footnote
    ? `<p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:${MUTED};">${safeFootnote}</p>`
    : ''

  const bodyBlock = body
    ? `<p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:${INK};">${safeBody}</p>`
    : ''

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:${CARD_BG};border:1px solid ${HAIRLINE};border-radius:12px;">
          <tr>
            <td style="padding:24px 28px 0;">
              <p style="margin:0 0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.2px;color:${ACCENT};">HearthShelf</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <h1 style="margin:0 0 12px;font-size:20px;line-height:1.35;font-weight:600;color:${INK};">${safeTitle}</h1>
              ${bodyBlock}
              ${quoteBlock}
              ${button}
              ${footnoteBlock}
            </td>
          </tr>
        </table>
        <p style="margin:16px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${MUTED};">
          You are getting this because of your HearthShelf notification settings.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`

  // Plain-text alternative. Built from the same inputs so the two can't diverge.
  const text = [
    title,
    body,
    quote ? `\n"${quote}"` : '',
    actionUrl ? `\n${actionLabel}: ${actionUrl}` : '',
    footnote,
  ]
    .filter(Boolean)
    .join('\n')

  return { html, text }
}
