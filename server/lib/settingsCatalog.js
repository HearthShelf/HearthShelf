// Server-side mirror of the @hearthshelf/core settings catalog + validator
// (packages/core/src/lib/settings.ts). The server is standalone ESM and doesn't
// bundle core, so the catalog is duplicated here - keep the two in sync (same
// arrangement as lib/stats.js mirroring core's stats math). Used by the
// /hs/settings route to validate writes and route each key to account/device
// scope. The client validates from the real core catalog; this is the
// authoritative server-side gate so a buggy or hostile client can't poison a row.

const AUTO_RULE_IDS = ['finish-series', 'in-progress', 'new-in-series']

function isAutoRules(v) {
  if (!Array.isArray(v)) return false
  return v.every(
    (r) =>
      !!r && typeof r === 'object' && AUTO_RULE_IDS.includes(r.id) && typeof r.on === 'boolean',
  )
}

const ACTION_PLACEMENTS = ['onscreen', 'tray', 'hidden']

// Validate a playerActions arrangement's shape only (the action-key whitelist
// lives on the mobile client). Mirrors core's isPlayerActions.
function isPlayerActions(v) {
  if (!Array.isArray(v)) return false
  return v.every(
    (a) => !!a && typeof a === 'object' && typeof a.key === 'string' && ACTION_PLACEMENTS.includes(a.placement),
  )
}

// Mirror of core's DEFS. Each entry: { scope, type, ...constraint }. Keep in
// step with packages/core/src/lib/settings.ts.
const DEFS = {
  // Appearance (account)
  theme: { scope: 'account', type: 'enum', values: ['dark', 'light', 'flat', 'oled'] },
  accentMode: { scope: 'account', type: 'enum', values: ['dynamic', 'manual'] },
  accentHex: { scope: 'account', type: 'string', pattern: /^#[0-9a-fA-F]{6}$/ },
  glow: { scope: 'account', type: 'number', min: 0, max: 60, int: true },
  coverStyle: { scope: 'account', type: 'enum', values: ['floating', 'cards'] },
  colorEverywhere: { scope: 'account', type: 'boolean' },
  hearthBgPlayer: { scope: 'account', type: 'boolean' },
  cardBg: { scope: 'account', type: 'boolean' },
  playerBg: { scope: 'account', type: 'enum', values: ['blurred', 'gradient', 'hearth'] },
  // Playback (account)
  scrubber: { scope: 'account', type: 'enum', values: ['chapter', 'book'] },
  skipForward: { scope: 'account', type: 'number', min: 5, max: 300, int: true },
  skipBack: { scope: 'account', type: 'number', min: 5, max: 300, int: true },
  chapterBarrier: { scope: 'account', type: 'boolean' },
  defaultSpeed: { scope: 'account', type: 'number', min: 0.5, max: 3.5 },
  // Cover display (account) - mobile
  coverAspect: { scope: 'account', type: 'enum', values: ['square', 'portrait'] },
  glowMode: { scope: 'account', type: 'enum', values: ['gradient', 'image'] },
  // Queue (account)
  queueMode: { scope: 'account', type: 'enum', values: ['off', 'manual', 'auto', 'playlist'] },
  queueAutoRules: { scope: 'account', type: 'json', validate: isAutoRules },
  // Library & home (account)
  libraryFill: { scope: 'account', type: 'boolean' },
  unifiedHome: { scope: 'account', type: 'boolean' },
  showOthersBooks: { scope: 'account', type: 'boolean' },
  // Sleep (account)
  sleepRewindSec: { scope: 'account', type: 'number', min: 0, max: 300, int: true },
  sleepFade: { scope: 'account', type: 'boolean' },
  sleepFadeLen: { scope: 'account', type: 'number', min: 3, max: 60, int: true },
  sleepChime: { scope: 'account', type: 'boolean' },
  sleepShakeExtend: { scope: 'account', type: 'boolean' },
  sleepShakeMinutes: { scope: 'account', type: 'number', min: 1, max: 30, int: true },
  autoSleep: { scope: 'account', type: 'boolean' },
  autoSleepStart: { scope: 'account', type: 'string', pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
  autoSleepEnd: { scope: 'account', type: 'string', pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
  autoSleepDur: { scope: 'account', type: 'number', min: 5, max: 180, int: true },
  // Account & privacy (account)
  useGravatar: { scope: 'account', type: 'boolean' },
  shareReadBooks: { scope: 'account', type: 'triBool' },
  shareCurrentlyListening: { scope: 'account', type: 'triBool' },
  // Device-scoped
  useSharedSettings: { scope: 'device', type: 'boolean' },
  notePops: { scope: 'device', type: 'boolean' },
  libraryView: { scope: 'device', type: 'enum', values: ['grid', 'list'] },
  libraryScale: { scope: 'device', type: 'number', min: 120, max: 240, int: true },
  homeHero: { scope: 'device', type: 'enum', values: ['comfy', 'compact'] },
  skipForwardCustom: { scope: 'device', type: 'number', min: 5, max: 300, int: true },
  skipBackCustom: { scope: 'device', type: 'number', min: 5, max: 300, int: true },
  carMode: { scope: 'device', type: 'enum', values: ['auto', 'on', 'off'] },
  carFadeEnabled: { scope: 'device', type: 'boolean' },
  carFadeSec: { scope: 'device', type: 'number', min: 0, max: 120, int: true },
  showAdvanced: { scope: 'device', type: 'boolean' },
  // Haptics + player-button layout (device) - mobile
  haptics: { scope: 'device', type: 'enum', values: ['off', 'minimal', 'all'] },
  hapticIntensity: { scope: 'device', type: 'enum', values: ['light', 'medium'] },
  playerActionsIconOnly: { scope: 'device', type: 'boolean' },
  playerActions: { scope: 'device', type: 'json', validate: isPlayerActions },
}

// The catalogued scope for a key, or null if the key isn't catalogued.
export function settingScope(key) {
  return DEFS[key] ? DEFS[key].scope : null
}

// Validate (and clamp/coerce where sensible) a value against its catalog
// constraint. Mirrors core's validateSetting. Returns { ok: true, value } with
// the possibly-clamped value, or { ok: false, reason }. Unknown keys reject.
export function validateSetting(key, value) {
  const d = DEFS[key]
  if (!d) return { ok: false, reason: 'unknown_key' }

  switch (d.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return { ok: false, reason: 'not_boolean' }
      return { ok: true, value }
    case 'triBool':
      if (value !== null && typeof value !== 'boolean') return { ok: false, reason: 'not_tribool' }
      return { ok: true, value }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return { ok: false, reason: 'not_number' }
      let n = d.int ? Math.round(value) : value
      if (d.min != null && n < d.min) n = d.min
      if (d.max != null && n > d.max) n = d.max
      return { ok: true, value: n }
    }
    case 'string': {
      if (typeof value !== 'string') return { ok: false, reason: 'not_string' }
      if (d.maxLen != null && value.length > d.maxLen) return { ok: false, reason: 'too_long' }
      if (d.pattern && !d.pattern.test(value)) return { ok: false, reason: 'pattern' }
      return { ok: true, value }
    }
    case 'enum':
      if (typeof value !== 'string' || !d.values.includes(value))
        return { ok: false, reason: 'not_in_enum' }
      return { ok: true, value }
    case 'json':
      if (!d.validate(value)) return { ok: false, reason: 'invalid_shape' }
      return { ok: true, value }
    default:
      return { ok: false, reason: 'unknown_type' }
  }
}
