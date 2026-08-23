// Release-notification job: walks every user's subscriptions and delivers the
// three signals to the user's chosen destinations - a followed book is now in the ABS library
// ("available"), its Audible release date has arrived ("release"), or it's within
// the user's reminder window ("reminder"). Each signal fires at most once per
// book, tracked in the subscription's notified_json. Per-user preferences come
// from the settings catalog (notify* keys). Runs after the series-roster sweep
// (scheduled alongside it) so the library-owned view is fresh.

import { getServerId } from '../db.js'
import { getUserSetting } from '../settings.js'
import { absDbAvailable, getOwnedAsins, getUserEmail } from '../lib/absdb.js'
import { getSeriesRoster, getSeriesRosterByAsin } from '../lib/seriesRosterStore.js'
import {
  allSubscriptions,
  markSubscriptionAvailable,
  setSubscriptionNotified,
  listPushTokens,
  deletePushToken,
} from '../lib/subscriptionsStore.js'
import { sendPushMessages } from '../lib/expoPush.js'
import { sendTransactionalEmail } from '../lib/emailRelay.js'
import { createNotification } from '../notifications.js'
import { renderEmail } from '../lib/emailTemplate.js'
import { notifyPrefsFor, shouldNotify } from '../lib/notificationPrefs.js'

const APP_ORIGIN = (process.env.HS_APP_ORIGIN || 'https://app.hearthshelf.com').replace(/\/$/, '')

const DAY = 86_400_000
function releaseMs(sub) {
  const raw = sub.publicationDatetime || sub.releaseDate
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : t
}
function daysUntil(sub, now) {
  const ms = releaseMs(sub)
  if (ms === null) return null
  return Math.ceil((ms - now) / DAY)
}

// Decide which one-shot alert (if any) a book subscription should fire now.
// Returns { signal, title, body } or null. `owned` = the book is in ABS.
function decideBookPush(sub, prefs, owned, now) {
  const notified = sub.notified || {}
  // 1) Available in library - the strongest signal, supersedes the others.
  if (owned && prefs.types.release.availableInLibrary && !notified.available) {
    return {
      signal: 'available',
      title: 'Ready to listen',
      body: `${sub.title} is now in your library.`,
    }
  }
  if (owned) return null // owned but that alert already fired (or is off)

  const d = daysUntil(sub, now)
  if (d === null) return null
  // 2) Release day (d <= 0 means out today / past but not yet synced to ABS).
  if (d <= 0 && prefs.types.release.onReleaseDate && !notified.release) {
    return {
      signal: 'release',
      title: 'Out today',
      body: `${sub.title} releases today on Audible.`,
    }
  }
  // 3) Early reminder, within the reminder window (but not on release day).
  if (
    d > 0 &&
    prefs.types.release.reminderDaysBefore > 0 &&
    d <= prefs.types.release.reminderDaysBefore &&
    !notified.reminder
  ) {
    return {
      signal: 'reminder',
      title: 'Coming soon',
      body: `${sub.title} releases in ${d} day${d === 1 ? '' : 's'}.`,
    }
  }
  return null
}

export async function runReleaseNotify(logger) {
  const serverId = await getServerId()
  const subs = await allSubscriptions(serverId)
  if (subs.length === 0) {
    logger.info('No subscriptions to check.')
    return 'No subscriptions'
  }

  // Library-owned ASIN set (best-effort; without the ABS db we can still do the
  // release-date / reminder alerts, just not "available in library").
  const ownedAsins = (await absDbAvailable()) ? await getOwnedAsins() : new Set()
  const now = Date.now()

  // Cache per-user prefs + push tokens across that user's subscriptions.
  const prefsCache = new Map()
  const tokensCache = new Map()
  const emailCache = new Map()
  const getPrefs = async (userId) => {
    if (!prefsCache.has(userId)) prefsCache.set(userId, await notifyPrefsFor(serverId, userId))
    return prefsCache.get(userId)
  }
  const getTokens = async (userId) => {
    if (!tokensCache.has(userId)) tokensCache.set(userId, await listPushTokens(serverId, userId))
    return tokensCache.get(userId)
  }
  const getEmail = async (userId) => {
    if (!emailCache.has(userId)) emailCache.set(userId, await getUserEmail(userId))
    return emailCache.get(userId)
  }

  let pushed = 0
  let inboxed = 0
  let emailed = 0
  const invalidTokens = new Set()

  const deliver = async ({ userId, entityId, asin, signal, title, body, prefs }) => {
    const data = { asin, signal }
    if (shouldNotify(prefs, 'release', 'inApp')) {
      await createNotification(serverId, userId, {
        kind: 'release',
        entityId,
        title,
        body,
        data,
      })
      inboxed += 1
    }
    // Push is its own channel now - a reader can keep the tray but silence the
    // phone, which the old combined notifyInApp flag made impossible.
    if (shouldNotify(prefs, 'release', 'push')) {
      const tokens = await getTokens(userId)
      if (tokens.length) {
        const { sent, invalidTokens: bad } = await sendPushMessages(
          tokens.map((token) => ({
            to: token.token,
            title,
            body,
            channelId: 'releases',
            data: { kind: 'release', ...data },
          })),
        )
        pushed += sent
        bad.forEach((token) => invalidTokens.add(token))
      }
    }
    if (shouldNotify(prefs, 'release', 'email')) {
      const to = await getEmail(userId)
      const href = asin
        ? `${APP_ORIGIN}/upcoming/${encodeURIComponent(asin)}`
        : `${APP_ORIGIN}/upcoming`
      const result = await sendTransactionalEmail({
        to,
        subject: `${title}: ${body}`,
        ...renderEmail({ title, body, actionUrl: href, actionLabel: 'Open HearthShelf' }),
      })
      if (result.sent) emailed += 1
    }
  }

  for (const sub of subs) {
    try {
      const prefs = await getPrefs(sub.userId)
      if (!prefs.types.release.enabled) continue

      // Book subscription: the awaited book itself.
      if (sub.kind === 'book' && sub.asin) {
        const owned = ownedAsins.has(String(sub.asin).toLowerCase())
        // Persist availability the first time we see it owned (even if the alert
        // is off), so the app can reflect "available now".
        if (owned && !sub.available) {
          await markSubscriptionAvailable(serverId, sub.userId, sub.id, now)
          sub.available = true
        }
        const decision = decideBookPush(sub, prefs, owned, now)
        if (decision) {
          await deliver({
            userId: sub.userId,
            entityId: `${sub.id}:${decision.signal}`,
            asin: sub.asin,
            signal: decision.signal,
            title: decision.title,
            body: decision.body,
            prefs,
          })
          // Mark the signal fired regardless of destination availability, so it
          // doesn't retry forever for a user with no email or registered device.
          const notified = { ...(sub.notified || {}), [decision.signal]: now }
          await setSubscriptionNotified(sub.serverId ?? serverId, sub.userId, sub.id, notified)
          sub.notified = notified
        }
      }

      // Series subscription: notify when a NEW book in the series lands in ABS.
      // Tracked per-asin in notified_json so each book alerts at most once.
      if (sub.kind === 'series' && sub.seriesTitle) {
        // Prefer the subscription's resolved series ASIN - a name can match two
        // distinct series, and the name lookup returns null when it's ambiguous.
        const roster = sub.seriesAsin
          ? await getSeriesRosterByAsin(sub.seriesAsin)
          : await getSeriesRoster(sub.seriesTitle)
        const books = roster?.books ?? []
        const notified = { ...(sub.notified || {}) }
        let changed = false
        for (const b of books) {
          if (!b.asin) continue
          const key = `book:${String(b.asin).toLowerCase()}`
          const owned = ownedAsins.has(String(b.asin).toLowerCase())
          if (owned && prefs.types.release.availableInLibrary && !notified[key]) {
            await deliver({
              userId: sub.userId,
              entityId: `${sub.id}:${key}`,
              asin: b.asin,
              signal: 'series-available',
              title: 'New in your series',
              body: `${b.title} (${sub.seriesTitle}) is now in your library.`,
              prefs,
            })
            notified[key] = now
            changed = true
          }
        }
        if (changed) {
          await setSubscriptionNotified(sub.serverId ?? serverId, sub.userId, sub.id, notified)
          sub.notified = notified
        }
      }
    } catch (err) {
      logger.warn(`subscription ${sub.id}: ${String(err?.message ?? err)}`)
    }
  }

  // Prune tokens Expo rejected as no-longer-registered.
  for (const tok of invalidTokens) {
    try {
      await deletePushToken(serverId, tok)
    } catch {
      // best-effort
    }
  }

  return `Checked ${subs.length} subscriptions; inbox ${inboxed}, email ${emailed}, push ${pushed}`
}
