// The one reader of a user's notification delivery preferences.
//
// Every delivery path (release job, club invites, @mentions) asks this module
// "may I send `type` on `channel` to this user?" rather than reading settings
// keys itself. Before this existed, jobs/releaseNotify.js carried its own copy
// of the prefs read, which is exactly how two delivery paths drift apart.
//
// Preferences live in ONE account-scoped settings key, `notifyPrefs`, whose
// shape + inheritance rules (global channels, per-type overrides, the
// club-invite floor) are defined in @hearthshelf/core. Absent or malformed
// values fall back to core's all-on defaults: a notification the user never
// opted out of should reach them.

import { getUserSetting } from '../settings.js'
import {
  DEFAULT_NOTIFY_PREFS,
  normalizeNotifyPrefs,
  resolveChannels,
  shouldNotify as coreShouldNotify,
} from '@hearthshelf/core/lib/notifications'

/** A user's full, normalized notification preferences. Never throws. */
export async function notifyPrefsFor(serverId, userId) {
  try {
    const raw = await getUserSetting(serverId, userId, 'notifyPrefs')
    if (raw == null) return DEFAULT_NOTIFY_PREFS
    return normalizeNotifyPrefs(raw)
  } catch {
    // An unreadable settings row must not silence a user's notifications.
    return DEFAULT_NOTIFY_PREFS
  }
}

/** The channels `type` delivers on for this user, global + per-type override. */
export async function channelsFor(serverId, userId, type) {
  return resolveChannels(await notifyPrefsFor(serverId, userId), type)
}

/**
 * Whether one notification should go out on one channel.
 *
 * Pass `prefs` when you already loaded them (delivering three channels for the
 * same user shouldn't cost three settings reads).
 */
export function shouldNotify(prefs, type, channel) {
  return coreShouldNotify(prefs, type, channel)
}
