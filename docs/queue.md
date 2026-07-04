# Listening queue

The up-next queue used to live on-device only (sessionStorage on web, memory
on mobile), so switching devices meant losing it. It now persists server-side
per user, so whatever you queue on your phone shows up on the web player and
vice versa.

## What persists where

The queue is split across two places, matching how often each part changes:

- **Items + playlist id** - the ordered up-next list. This churns constantly
  (every auto-advance rebuild, every add/remove/reorder), so it gets its own
  table (`listening_queue`) and its own endpoint (`/hs/queue`).
- **Mode + auto-rules** (`off` / `manual` / `auto` / `playlist`, and which
  smart rules are on) - these are preferences, not session state, so they ride
  in the existing per-user settings blob (`app_settings`, `queueMode` /
  `queueAutoRules` keys) and sync through `/hs/settings` like every other
  setting. See `docs/database.md`.

Types (`QueueEntry`, `QueueMode`, `AutoRulePref`, `QueueState`) and the pure
Auto-mode rule logic (`buildAutoQueue`) live in `@hearthshelf/core` so web and
mobile share one implementation instead of two copies.

## Backend API

`/hs/queue`, ABS-bearer authenticated like the other `/hs/*` routes, keyed by
`(server_id, user_id)`.

| Route | Method | Returns |
| --- | --- | --- |
| `/hs/queue` | GET | `{ items, playlistId, updatedAt }` |
| `/hs/queue` | PUT | `{ items, playlistId, updatedAt, applied }` |

`PUT` takes `{ items, playlistId, updatedAt }`. `updatedAt` (ms, client clock)
is the conflict key: if the caller's `updatedAt` is older than what's already
stored, the write is rejected (`applied: false`) and the response carries the
current server state instead, so the stale device can adopt it rather than
clobbering a newer queue from another device. See `server/queue.js`.

## Sync model

No realtime channel - each client pulls on focus (app foreground / player
open) and pushes on change, debounced. An **active playback session is the
authority**: while a device is actively playing, it doesn't adopt a remote
queue mid-session; other, idle devices pick up the latest queue the next time
they come to the foreground. `resolveQueueConflict` in `@hearthshelf/core`
implements the last-writer-wins merge (`remote` wins when its `updatedAt` is
`>=` the local one).

## Frontend

- `src/api/queue.ts` - client (`getServerQueue` / `putServerQueue`).
- `src/hooks/useQueueSync.ts` - pulls on login/focus/player-open, pushes on
  change.
- `src/store/queueStore.ts` - the write-through cache the UI reads; mutations
  stamp a local `updatedAt` immediately, then sync pushes it.
- `src/hooks/useQueueAdvance.ts` - after an auto-rebuild or a manual/playlist
  pop, pushes the new queue alongside the existing mark-finished call.

## Out of scope

- Realtime push between devices (poll-on-focus is enough for a listening
  queue; revisit if it feels laggy in practice).
- Persisting playlist *contents* - only the chosen `playlistId` persists;
  items are re-fetched from ABS on advance since ABS is the source of truth
  for playlist contents.
