// Server-side settings gate for the /hs/settings route: validates writes and
// routes each key to account/device scope. This is the authoritative gate so a
// buggy or hostile client can't poison a row. It re-uses the one catalog +
// validator from @hearthshelf/core (Node strips the TS types at import) rather
// than duplicating them, so the server can never drift from the client's rules -
// the drift that once let 'theme: auto' be rejected while the client accepted it.

import { validateSetting, settingDef } from '@hearthshelf/core/lib/settings'

export { validateSetting }

// The catalogued scope for a key, or null if the key isn't catalogued.
export function settingScope(key) {
  return settingDef(key)?.scope ?? null
}
