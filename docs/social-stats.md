# Social stats (leaderboard + "finished by")

HearthShelf's first cross-user surface: a **server leaderboard** on the Stats
page and a per-book **"finished by N people"** count. Both show data about
*other* users - something AudiobookShelf deliberately keeps to admins through its
REST API. This doc explains how HearthShelf serves it to everyone without an
admin token, and how a user's visibility is controlled.

## Why this needed a different approach

ABS hard-scopes every cross-user endpoint to admins. The only API routes that
carry another user's reading progress - `GET /api/users` and `GET /api/users/:id`
(which holds `mediaProgress[]`) - both begin with
`if (!req.user.isAdminOrUp) return res.sendStatus(403)`. Same gate on
`/api/users/:id/listening-stats` and `/api/stats/year/:year`. There is **no
non-admin API path** to another user's data, so a leaderboard that every signed-in
listener can see can't be built on the ABS API without giving HearthShelf a
standing admin token.

So instead of the API, HearthShelf reads ABS's **SQLite database directly and
read-only**. This is strictly better for the aggregate workload (a leaderboard is
one indexed `GROUP BY`, versus the API's "fetch every user, scan each one's
progress on every refresh"), and it means the social reads need **no privileged
token at all** - the caller is still just identified by ABS `/api/me` like every
other request.

## How it reads ABS

All of ABS's internal schema knowledge lives in one file, `server/lib/absdb.js`,
so a future ABS schema change is a one-file fix. See `docs/database.md` >
"Reading ABS's database (read-only)" for the storage details. In short:

- Opens `absdatabase.sqlite` and runs `PRAGMA query_only = ON`, so SQLite rejects
  any write - HearthShelf can never corrupt ABS's data. ABS stays the sole writer.
- Path is `HS_ABS_DB_PATH` (default `/config/absdatabase.sqlite`). On the
  all-in-one image ABS's `/config` is already in-container, so the default works
  with no extra setup. On the slim image, mount ABS's config dir read-only
  (`abs-config:/abs-config:ro`) and point the env at the file.
- If the file isn't mapped (or can't be opened), the API returns
  `{ available: false }` and the UI hides the leaderboard - no error.

## Privacy: tri-state per user + an admin default

Whether a listener appears on the leaderboard resolves from two inputs:

1. **The user's own choice** - the `shareReadBooks` app setting, which is
   **tri-state**: unset (never chose), `true` (share), or `false` (hide). The
   "Share my reading list" toggle on the Settings > Library page writes it, and
   only writes it once the user actually flips it.
2. **The server default** - a single instance-wide value in `community_config`,
   seeded from the `COMMUNITY_DEFAULT_SHARE` env (default `on` = opt-out), edited
   by an admin under **Config > Community**.

Resolution: a user with an explicit choice always keeps it; a user who never
chose follows the server default. So changing the default is **retroactive for
the "never chose" crowd but never overrides an explicit choice**. A user always
sees their own row on the leaderboard even if they've hidden from others (it's
flagged so the UI can mark it "you").

The leaderboard filters opted-out users by reading `app_settings` and
`community_config` from *HearthShelf's* database - no write ever reaches ABS.

## Backend API

All under `/hs/social/*` on the HearthShelf backend, ABS-bearer like the other
`/hs/*` routes. Any authenticated user may call the reads.

| Route | Method | Who | Returns |
| --- | --- | --- | --- |
| `/hs/social/leaderboard` | GET | any user | `{ available, me, entries[] }` - ranked by books finished then hours listened; `me` is the caller's row |
| `/hs/social/finished-count?libraryItemId=…` | GET | any user | `{ available, count }` for one item |
| `/hs/social/finished-count` | POST | any user | `{ available, counts }` for a list of items (shelf badges) |
| `/hs/social/community-config` | GET | any user | `{ defaultShare, canEdit }` (so the user toggle can show the inherited default) |
| `/hs/social/community-config` | PUT | admin only | updates `defaultShare` |

Guests and inactive ABS users are excluded from the leaderboard. Books only
(podcasts are not counted).

## Frontend

- `src/api/social.ts` - client + TanStack Query keys, degrading to neutral values
  on failure so the page never breaks.
- `src/pages/StatsPage.tsx` - the leaderboard section (replaced the old
  "coming soon" banner), caller's row highlighted, hidden when unavailable.
- `src/pages/SettingsPage.tsx` - the "Share my reading list" toggle, showing the
  inherited server default until the user chooses.
- `src/pages/config/ConfigCommunity.tsx` - the admin Community page (default
  sharing on/off), under a new "Community" group in the config nav.

## Deployment

- **AIO**: nothing to do - `/config/absdatabase.sqlite` is already in-container.
- **Slim**: add `abs-config:/abs-config:ro` to the HearthShelf service and set
  `HS_ABS_DB_PATH=/abs-config/absdatabase.sqlite` (both are in
  `docker-compose.yml` as the default). Remove them to disable the leaderboard.
- `COMMUNITY_DEFAULT_SHARE` (`on`/`off`) seeds the initial sharing default; after
  first boot the admin controls it from Config > Community.

## Out of scope (future)

- Per-user comparison tiles, device breakdowns, top genres/authors, presence
  ("currently reading"), follow/friends.

**Book Club** (shared-book groups with per-book notes, a progress race, and
owner next-book recommendations) has since been built - see `docs/social.md`.
