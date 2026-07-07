# Listening queue

The up-next queue used to live on-device only (sessionStorage on web, memory
on mobile), so switching devices meant losing it. It now persists server-side
per user, so whatever you queue on your phone shows up on the web player and
vice versa.

## What persists where

The queue is split across two places, matching how often each part changes:

- **Items + manual list + playlist id** - the `listening_queue` table, one row
  per user, its own endpoint (`/hs/queue`):
  - `items_json` is the **active** up-next list the player pops from. In
    Auto/Playlist mode it's rebuilt (ephemeral); in Manual mode it mirrors the
    manual list.
  - `manual_json` is the user's **durable** hand-queued list. It drives Manual
    mode and, in Auto mode, feeds the `manual` rule (see below) so a hand-picked
    queue survives every Auto rebuild instead of being overwritten. Auto never
    writes this column.
- **Mode + auto-rules** (`off` / `manual` / `auto` / `playlist`, and which
  smart rules are on and in what order) - these are preferences, not session
  state, so they ride in the existing per-user settings blob (`app_settings`,
  `queueMode` / `queueAutoRules` keys) and sync through `/hs/settings` like
  every other setting. See `docs/database.md`.

### Manual as an Auto rule

Auto mode fills the queue from an ordered, toggleable list of rules
(finish-series, in-progress, new-in-series, book-club) run in priority order.
`manual` is one of those rules: wherever the user drags it in the order decides
whether their hand-queued books play before or after the machine-picked ones. It
ships **last** by default ("when I finish the series and the new releases, this
is what I want next"). Because Auto's de-dupe is first-rule-wins, a book an
earlier rule already surfaced won't queue twice - the manual list is a fallback
for whatever the other rules didn't add. Toggling the `manual` rule off drops
the hand-queued books from Auto without deleting them.

The same manual list is the whole queue in Manual mode, so there's one durable
hand-queued list, not two.

Types (`QueueEntry`, `QueueMode`, `AutoRulePref`, `QueueState`) and the pure
Auto-mode rule logic (`buildAutoQueue`, which takes the manual list as its
`manualBooks` input) live in `@hearthshelf/core` so web and mobile share one
implementation instead of two copies.

## Backend API

`/hs/queue`, ABS-bearer authenticated like the other `/hs/*` routes, keyed by
`(server_id, user_id)`.

| Route | Method | Returns |
| --- | --- | --- |
| `/hs/queue` | GET | `{ items, manual, playlistId, updatedAt }` |
| `/hs/queue` | PUT | `{ items, manual, playlistId, updatedAt, applied }` |

`PUT` takes `{ items, manual?, playlistId, updatedAt }`. `updatedAt` (ms, client
clock) is the conflict key: if the caller's `updatedAt` is older than what's
already stored, the write is rejected (`applied: false`) and the response
carries the current server state instead, so the stale device can adopt it
rather than clobbering a newer queue from another device. `manual` is optional:
omit it to preserve the stored hand-queued list (the server's Auto rebuild does
this when it recomputes `items`); pass an array to replace it. See
`server/queue.js`.

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
