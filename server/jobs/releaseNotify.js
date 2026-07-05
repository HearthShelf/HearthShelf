// Release-notification job: walks every user's subscriptions and fires Expo
// pushes for the three signals - a followed book is now in the ABS library
// ("available"), its Audible release date has arrived ("release"), or it's within
// the user's reminder window ("reminder"). Each signal fires at most once per
// book, tracked in the subscription's notified_json. Per-user preferences come
// from the settings catalog (notify* keys). Runs after the series-roster sweep
// (scheduled alongside it) so the library-owned view is fresh.

import { getServerId } from '../db.js'
import { getUserSetting } from '../settings.js'
import { absDbAvailable, getOwnedAsins, getLibraryItemByAsin } from '../lib/absdb.js'
import { getSeriesRoster } from '../lib/seriesRosterStore.js'
import {
  allSubscriptions,
  markSubscriptionAvailable,
  setSubscriptionNotified,
  listPushTokens,
  deletePushToken,
} from '../lib/subscriptionsStore.js'
import { sendPushMessages } from '../lib/expoPush.js'

// Read a user's notification prefs from the settings catalog, with the same
// defaults core ships (DEFAULT_NOTIFICATION_PREFS).
async function prefsFor(serverId, userId) {
  const get = (k, d) => getUserSetting(serverId, userId, k).then((v) => (v == null ? d : v))
  const [enabled, avail, release, reminder, window] = await Promise.all([
    get('notifyEnabled', true),
    get('notifyAvailableInLibrary', true),
    get('notifyOnReleaseDate', true),
    get('notifyReminderDaysBefore', 3),
    get('notifyCountdownWindowDays', 14),
  ])
  return {
    enabled: enabled !== false,
    notifyAvailableInLibrary: avail !== false,
    notifyOnReleaseDate: release !== false,
    reminderDaysBefore: Number(reminder) || 0,
    countdownWindowDays: Number(window) || 14,
  }
}

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

// Decide which one-shot push (if any) a book subscription should fire now.
// Returns { signal, title, body } or null. `owned` = the book is in ABS.
function decideBookPush(sub, prefs, owned, now) {
  const notified = sub.notified || {}
  // 1) Available in library - the strongest signal, supersedes the others.
  if (owned && prefs.notifyAvailableInLibrary && !notified.available) {
    return {
      signal: 'available',
      title: 'Ready to listen',
      body: `${sub.title} is now in your library.`,
    }
  }
  if (owned) return null // owned but that push already fired (or is off)

  const d = daysUntil(sub, now)
  if (d === null) return null
  // 2) Release day (d <= 0 means out today / past but not yet synced to ABS).
  if (d <= 0 && prefs.notifyOnReleaseDate && !notified.release) {
    return {
      signal: 'release',
      title: 'Out today',
      body: `${sub.title} releases today on Audible.`,
    }
  }
  // 3) Early reminder, within the reminder window (but not on release day).
  if (
    d > 0 &&
    prefs.reminderDaysBefore > 0 &&
    d <= prefs.reminderDaysBefore &&
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
  // release-date / reminder pushes, just not "available in library").
  const ownedAsins = (await absDbAvailable()) ? await getOwnedAsins() : new Set()
  const now = Date.now()

  // Cache per-user prefs + push tokens across that user's subscriptions.
  const prefsCache = new Map()
  const tokensCache = new Map()
  const getPrefs = async (userId) => {
    if (!prefsCache.has(userId)) prefsCache.set(userId, await prefsFor(serverId, userId))
    return prefsCache.get(userId)
  }
  const getTokens = async (userId) => {
    if (!tokensCache.has(userId)) tokensCache.set(userId, await listPushTokens(serverId, userId))
    return tokensCache.get(userId)
  }

  let pushed = 0
  const invalidTokens = new Set()

  for (const sub of subs) {
    try {
      const prefs = await getPrefs(sub.userId)
      if (!prefs.enabled) continue

      // Book subscription: the awaited book itself.
      if (sub.kind === 'book' && sub.asin) {
        const owned = ownedAsins.has(String(sub.asin).toLowerCase())
        // Persist availability the first time we see it owned (even if the push
        // is off), so the app can reflect "available now".
        if (owned && !sub.available) {
          await markSubscriptionAvailable(serverId, sub.userId, sub.id, now)
          sub.available = true
        }
        const decision = decideBookPush(sub, prefs, owned, now)
        if (decision) {
          const tokens = await getTokens(sub.userId)
          if (tokens.length) {
            const { sent, invalidTokens: bad } = await sendPushMessages(
              tokens.map((t) => ({
                to: t.token,
                title: decision.title,
                body: decision.body,
                data: { kind: 'release', asin: sub.asin, signal: decision.signal },
              })),
            )
            pushed += sent
            bad.forEach((tok) => invalidTokens.add(tok))
          }
          // Mark the signal fired regardless of token availability, so it doesn't
          // retry forever for a user with no device registered.
          const notified = { ...(sub.notified || {}), [decision.signal]: now }
          await setSubscriptionNotified(sub.serverId ?? serverId, sub.userId, sub.id, notified)
          sub.notified = notified
        }
      }

      // Series subscription: notify when a NEW book in the series lands in ABS.
      // Tracked per-asin in notified_json so each book pushes at most once.
      if (sub.kind === 'series' && sub.seriesTitle) {
        const roster = sub.seriesTitle ? await getSeriesRoster(sub.seriesTitle) : null
        const books = roster?.books ?? []
        const notified = { ...(sub.notified || {}) }
        let changed = false
        for (const b of books) {
          if (!b.asin) continue
          const key = `book:${String(b.asin).toLowerCase()}`
          const owned = ownedAsins.has(String(b.asin).toLowerCase())
          if (owned && prefs.notifyAvailableInLibrary && !notified[key]) {
            const tokens = await getTokens(sub.userId)
            if (tokens.length) {
              const { sent, invalidTokens: bad } = await sendPushMessages(
                tokens.map((t) => ({
                  to: t.token,
                  title: 'New in your series',
                  body: `${b.title} (${sub.seriesTitle}) is now in your library.`,
                  data: { kind: 'release', asin: b.asin, signal: 'series-available' },
                })),
              )
              pushed += sent
              bad.forEach((tok) => invalidTokens.add(tok))
            }
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

  return `Checked ${subs.length} subscriptions, sent ${pushed} notifications`
}
