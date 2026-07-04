# Social features - design plan

> Design doc for the full Social feature set: leaderboard windows, "finished by"
> user chips, listening-now presence, public shared notes, and Book Club. It
> extends `docs/social-stats.md` (the leaderboard + finished-count foundation,
> already built) and follows the same rails: ABS stays the source of truth,
> cross-user reads go through `server/lib/absdb.js` read-only, all write-side
> social state lives in HearthShelf's own db, privacy resolves through the
> tri-state + community-default pattern.
>
> **Status: planned, not built.** Phases below are ordered and independently
> shippable.

## The features

1. **Leaderboard windows** - the existing leaderboard gains week/month/all-time
   tabs, and a bug fix so listen-only users (zero finished books) appear.
2. **Finished-by chips** - "finished by" goes from a count to avatar chips
   showing who (privacy-filtered), plus the already-built-but-unwired shelf
   count badges.
3. **Listening now** - see who else is actively listening to a book right
   now-ish. New privacy surface, default OFF.
4. **Public notes** - per-book notes visible to everyone on the server, with
   spoiler gating by playback position.
5. **Book Club** - persistent reading groups that move through books together.
   A club has a book history: past books and one current book; members can go
   back to any past book and read its chat. Timestamped notes form a per-book
   chat; when your playback crosses a note's timestamp you get a pop to read
   and reply; a progress UI shows every member's position in the current book.
   Spoiler-safe: you never see a note ahead of your own position in that book.

## Key design decisions (and why)

### Spoiler gating: server-side bodies, locked stubs for pops

The pop ("someone left a note at 1:02:05, you just got there") must fire at the
exact second, but note bodies ahead of the reader must never reach the wire -
one render bug in any of three independently built clients would otherwise leak
spoilers.

- `GET /hs/notes` takes the caller's `position` (seconds). The server returns
  **full notes** only where the note is **safe** (see below), `time_sec IS NULL`,
  `time_sec <= position`, the caller is the author, or the caller has **finished
  the book** (verified server-side from the caller's own `mediaProgresses` row
  when absdb is available; when absdb is absent the client's `finished` claim is
  accepted - the gate protects the reader from themselves, it is not a security
  boundary).
- It also returns **locked stubs** for timestamped ahead-notes: `{ id, timeSec }`
  only - no body, no author, no createdAt. Stubs power the local pop trigger
  (clubs) and the anonymous timeline tick marks on the scrubber (all scopes).
  Withholding author/date keeps the ahead-signal opaque (note density is the
  only unavoidable leak; accepted and documented). Replies do not get their own
  stubs (the parent's stub already marks the timestamp); they still count in
  `hiddenAhead`.
- `hiddenAhead` counts everything locked ("3 notes ahead of you"). Pops fire
  from **club** stubs only; public-note stubs render as timeline ticks but
  never pop.
- **Replies inherit the parent note's `time_sec` gate** - a reply to an
  ahead-note is itself ahead, whatever its own timestamp.
- The gate is a **plain filter in the route handler** (a WHERE clause plus a
  body-strip), deliberately NOT a mirrored copy of core's `gateNotes`. Core's
  `gateNotes` is client-side optimistic re-gating only (unlocking cached notes
  as position advances between polls). This avoids adding a second hand-synced
  server logic mirror whose silent drift would break spoiler safety.

### Note visibility (`visibility`) and the "safe" flag

Two author-set properties on every note, chosen in the composer:

**`visibility` = `'club' | 'public' | 'personal'`** - replaces the old
`club_id = '' means public` overloading (which couldn't distinguish "everyone"
from "just me"). It pairs with `club_id`, enforced server-side:

| visibility | club_id | Who can read it |
| --- | --- | --- |
| `club` | `<id>` | members of that club, on that book |
| `public` | `''` | everyone on the server |
| `personal` | `''` | only the author (`user_id = caller`) |

`club` is implicit - you get it by posting inside a club room, not from a
toggle. The **composer toggle is a 2-way Public / Personal** on general
(non-club) notes. `personal` notes are **fully invisible** to everyone else:
filtered out of every other caller's read, so no note, no stub, no timeline
marker, and no `hiddenAhead` count leaks their existence. Rejects: a `club`
note with no `club_id`, a `public`/`personal` note with a `club_id`.

The composer's Public/Personal default is **remember-last-choice**, a
per-device setting `noteDefaultVisibility` (`{ scope:'device', type:'enum',
values:['public','personal'], default:'public' }`) written on each post.

**`safe` (boolean, default false)** - a note the author declares spoiler-free
(a pronunciation tip, "great narration here"), exempting it from the position
gate: a safe note's body shows to everyone **regardless of playback position**,
while still carrying its `time_sec` for the scrubber marker. This is the
community self-regulation lever - authors marking their own harmless notes as
always-visible. It is one extra OR-term in the authoritative gate: *visible iff
`safe` OR `time_sec IS NULL` OR `time_sec <= position` OR author OR finished*.

Safe-flag rules (spoiler safety):
- The composer control sits next to Submit, labelled to make the consequence
  explicit ("Safe - show to everyone now (no spoilers)"), **default off**. A
  mis-flag is an un-undoable early reveal, so it is a deliberate opt-in.
- `safe` applies **only to the note it is set on**. **Replies never inherit
  it** - a reply still gates at its parent's `time_sec`, so a safe note cannot
  become an ahead-spoiler thread. Only top-level notes may be safe.
- `safe` composes with any `visibility` (safe-public = everyone always;
  safe-club = all members regardless of progress; safe-personal is harmless,
  only you see it anyway).
- No reader report/flag flow in this build (a v2 moderation item). The
  mitigations for a bad safe note are the existing ones: author, club owner
  (in-club), and admin can delete it.
- A safe note is **not a stub** - it ships as a full unlocked note to everyone,
  so its scrubber marker is an avatar dot (not an anonymous ahead-tick) for all
  readers.
- On pop, the client fetches the just-unlocked note (`GET /hs/notes?after=...&position=...`)
  and shows author + body in the toast. One sub-second fetch at pop time; the
  stub stays anonymous until then.
- Position is client-supplied and that's fine: lying only spoils the liar. When
  absdb is available the server additionally clamps position up to the caller's
  own `mediaProgresses.currentTime` so a stale client can't re-lock notes.

### Delivery: polling, no new channel (SSE explicitly deferred)

The pop needs no push - stubs arrive ahead of time and crossing detection is
local against the playback clock (`playerStore.currentTime` on web,
the 1s native `onProgress` position on mobile). Only *freshness* of other
people's notes/positions needs the network, and the house poll model covers it:

- While playing a club/noted book: refetch notes on the existing 30s
  `useProgress` cadence (web) / `syncProgress` throttle (mobile). No new timers.
- While a club room or notes panel is open: 15s poll (TanStack
  `refetchInterval` on web/WebApp; an interval in a `clubSync` module copied
  from `queueSync.ts` on mobile).
- Otherwise: pull on login/focus/foreground, exactly like queue/settings sync.
- Polls are cheap deltas via `after=<created_at>`, not full refetches.

The flagship scenario works screen-off on mobile: the Media3 foreground service
keeps JS alive and position ticking while playing. Android Auto playback
bypasses the JS store - pops defer until back on the phone (accepted, and
driving-distraction policy forbids car chat anyway). True closed-app push needs
FCM/APNs, which the self-hosted architecture has no path to - out of scope.

**SSE is a criteria-gated future phase**, only if 15-30s reply latency
measurably hurts. The recipe is pre-scoped: copy `proxy_http_version 1.1` /
buffering-off / long `proxy_read_timeout` from `nginx/abs_proxy.conf` into the
`/hs/` location in all THREE nginx files (`default.conf`,
`hsdirect-http.conf.template`, `hsdirect-ssl.conf.template`), plus an
EventSource auth workaround (no Authorization header) and an RN polyfill.

### Privacy model

One rule everywhere: **explicit choice wins; unset follows the admin default;
you always see yourself.** Extends the proven `shares()` +
`getExplicitSharePrefs` + `community_config` pipeline.

| Surface | Setting | Default resolution |
| --- | --- | --- |
| Leaderboard, finished-by chips | existing `shareReadBooks` (triBool) | community `default_share` (opt-out, unchanged) |
| Listening-now presence | **new** `shareCurrentlyListening` (triBool) | **new** community `default_share_listening`, seeded **OFF** |
| Public notes | posting under your name IS consent; delete anytime (author or admin) | admin kill-switch `notes_enabled` (on) |
| Club membership, in-club progress + chat | joining IS consent, scoped to members; leaving removes you | admin kill-switch `clubs_enabled` (on) |
| In-club `listeningNow` pulse | membership consent covers it when `shareCurrentlyListening` is unset, but an **explicit false always wins** - the member's progress still shows, only the live pulse hides | - |

Real-time presence is materially more sensitive than historical reading lists,
so it does NOT inherit the opt-out default - it ships default-off and the admin
turns it on deliberately (Config > Community).

Moderation (v1): author deletes own notes; **club owner** can delete any note
in their club and kick members (never the owner); server admin deletes
anything. The owner cannot leave their club - they archive it instead
(explicit, no silent ownership transfer). Note editing is
deliberately absent in v1 (delete-and-repost) - editing would allow
post-innocuous-edit-into-spoiler abuse after unlock. Report/flag flow and
invite-only clubs are named v2 items.

Guests and inactive ABS users are excluded everywhere; podcasts excluded
(`mediaItemType='book'`), matching the leaderboard.

### Clubs are multi-book groups, not per-book rooms

A club is a persistent group; the book is an attribute of the club's timeline,
not of the club itself. `club_books` holds every book a club touches, each in one
of three states: **queued** (`queued_at` set, up-next, not started), **current**
(`queued_at IS NULL AND finished_at IS NULL`, exactly one per club), and
**finished** (`finished_at` stamped). The owner lines up books in the queue
(`POST /hs/clubs/:id/queue`) and advances the club to a new current book
(`POST /hs/clubs/:id/books`), which stamps `finished_at` on the previous current
and clears `queued_at` on the new one; the chat for every past book stays
readable forever. `book_notes` already carries both `club_id` and
`library_item_id`, so per-book chat scoping falls out of the existing shape - no
notes migration needed when a club moves on.

Consequences:

- The book detail page lists open clubs whose **current** book is that item as
  joinable; the club page itself shows the full history.
- Spoiler gating applies per book against your position in *that* book - past
  books you never listened to stay gated (the finished-bypass covers most
  members revisiting).
- Pops and locked stubs only apply to the club's current book, and only while
  you're playing it.
- The progress race UI tracks the current book; past books render final chat +
  who-finished.
- The unread cursor stays **per club** (one `last_read_at`): note `created_at`
  is a single timeline across the club's books, so "unread = unlocked notes
  newer than the cursor" works unchanged even when someone comments on a past
  book.
- Book title/author are snapshotted into `club_books` at add time so history
  renders even if the item is later removed from ABS.

### Next-book recommendations

When a club is wrapping up its current book and has nothing queued, the owner
can ask HearthShelf to recommend the next one. It reuses the QuestGiver engine
end-to-end: the shared `craftClubPrompt` / `clubHeuristic` in `@hearthshelf/core`
(`lib/social.ts`), the same provider path (`server/providers.js` `complete()`)
and JSON envelope (`parseResult`), and the same durable rate limit.

Two independent gates decide *how* a pick is produced:

- **Admin AI switch** (`community_config.clubs_ai_enabled`, ships **off**, seeded
  from `CLUBS_AI_DEFAULT`). AI calls cost money, so an admin must opt in under
  Config > Community. With it off (or no provider configured), clubs still get
  the deterministic `clubHeuristic` - no AI, works on every install.
- **Owner basis** (`clubs.rec_basis`, per club, default `club-history`): a
  tri-state of `off` / `club-history` / `all-members-finished`. `off` hides the
  surface for that club; `club-history` weights the genres of the books the club
  has read together; `all-members-finished` weights the genres every member has
  finished across the whole library.

The candidate pool is the **owner's own unstarted library**, built client-side
(`qgBooks` -> `qgLibraryCandidates`) and posted to the endpoint - the same
pattern Discover uses, so the server never re-fetches the library. The server
drops any candidate already in the club, builds the taste from the chosen basis
(`club-history` from the posted genre lists of the club's read books;
`all-members-finished` from `getFinishedGenresForUsers` in `lib/absdb.js`, a
read-only aggregate of members' finished-book genres), then runs AI-or-heuristic
and resolves the picks back to real library items. The owner adds a pick straight
to the club's up-next queue (the existing `enqueueBook`). `all-members-finished`
needs ABS's db mounted; when it isn't, the endpoint returns `unavailable: true`
and the UI says so rather than recommending at random.

The player's club panel surfaces this **owner-only**: a basis selector, a
"Recommend next book" button, and pick cards, plus a self-surfacing nudge when a
member is >=90% through the current book and the queue is empty.

### Author identity without absdb

Notes and clubs are HS-db-only features and must work on a slim deploy with no
ABS db mount - but usernames live in ABS. So **`username` is snapshotted into
the row at write time** (it's already in hand: `resolveContext` validates the
caller against ABS `/api/me`). Rendered names never depend on absdb; avatars
come from the existing public `GET /hs/avatars/:userId` (initials fallback).
Snapshots refresh opportunistically on later writes by the same user. If an ABS
user is deleted, their notes persist under the snapshot name (admin can delete;
anonymization tooling is v2).

### Abuse controls

Write endpoints get per-user throttles reusing the durable `rate_limits` table
pattern from QuestGiver: notes 60/user/hour, club creation 10/user/day. Body
cap 2000 chars enforced server-side. Bulk lookup endpoints cap the id list at
100 (mirroring `readBody` size discipline).

## DB schema (HS embedded db, `server/db.js` SCHEMA array)

```sql
CREATE TABLE IF NOT EXISTS book_notes (
  id              TEXT PRIMARY KEY,               -- uuid
  server_id       TEXT NOT NULL DEFAULT 'local',
  user_id         TEXT NOT NULL,                  -- ABS user id (author)
  username        TEXT NOT NULL DEFAULT '',       -- snapshot at write time
  library_item_id TEXT NOT NULL,
  club_id         TEXT NOT NULL DEFAULT '',       -- '' for public/personal; a club id for club notes
  visibility      TEXT NOT NULL DEFAULT 'public', -- 'club' | 'public' | 'personal'
  parent_id       TEXT NOT NULL DEFAULT '',       -- '' = top-level; replies gate at the PARENT's time_sec
  time_sec        REAL,                           -- NULL = general (ungated) note
  safe            INTEGER NOT NULL DEFAULT 0,     -- author-declared spoiler-free -> bypasses the position gate
  body            TEXT NOT NULL,                  -- <= 2000 chars, server-validated
  created_at      INTEGER NOT NULL,               -- ms
  deleted         INTEGER NOT NULL DEFAULT 0      -- soft delete keeps threads intact
);
CREATE INDEX IF NOT EXISTS idx_book_notes_item
  ON book_notes (server_id, library_item_id, club_id, created_at);
-- MIGRATION (best-effort ALTERs for existing installs): add `visibility`
-- (backfill 'club' where club_id != '', else 'public') and `safe` (default 0).
-- Personal notes only ever exist post-migration, so no personal backfill needed.

CREATE TABLE IF NOT EXISTS clubs (
  id              TEXT PRIMARY KEY,
  server_id       TEXT NOT NULL DEFAULT 'local',
  name            TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  is_open         INTEGER NOT NULL DEFAULT 1,     -- open-join v1; column shaped for invite-only later
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  rec_basis       TEXT NOT NULL DEFAULT 'club-history' -- 'off' | 'club-history' | 'all-members-finished'
);

CREATE TABLE IF NOT EXISTS club_books (
  server_id       TEXT NOT NULL DEFAULT 'local',
  club_id         TEXT NOT NULL,
  library_item_id TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',       -- snapshot so history renders if the item leaves ABS
  author          TEXT NOT NULL DEFAULT '',       -- snapshot
  added_by        TEXT NOT NULL,
  started_at      INTEGER NOT NULL,                -- 0 while queued; set when promoted to current
  finished_at     INTEGER,                        -- stamped when the book is finished
  queued_at       INTEGER,                        -- set = queued (up-next); NULL = current or finished
  PRIMARY KEY (server_id, club_id, library_item_id)
);
-- states: queued (queued_at set, finished_at NULL) | current (both NULL) | finished (finished_at set)
CREATE INDEX IF NOT EXISTS idx_club_books_item
  ON club_books (server_id, library_item_id, finished_at);

CREATE TABLE IF NOT EXISTS club_members (
  server_id    TEXT NOT NULL DEFAULT 'local',
  club_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  username     TEXT NOT NULL DEFAULT '',          -- snapshot at join time
  role         TEXT NOT NULL DEFAULT 'member',    -- 'owner' | 'member'
  joined_at    INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,        -- unread cursor; PUT applies max(stored, incoming)
  PRIMARY KEY (server_id, club_id, user_id)
);
```

`community_config` grows via MIGRATIONS ALTERs: `default_share_listening
INTEGER DEFAULT 0` (off), `notes_enabled INTEGER DEFAULT 1`, `clubs_enabled
INTEGER DEFAULT 1`, `clubs_ai_enabled INTEGER DEFAULT 0` (off; the admin
opt-in for club AI recommendations). `clubs.rec_basis` is added the same way
for existing installs.

Unread state is the `last_read_at` cursor, not per-note rows. Unread = unlocked
notes with `created_at > last_read_at` - locked notes never count, so the badge
itself cannot leak that discussion exists ahead of you. The PUT is guarded
`max(stored, incoming)` so a stale device can't resurrect read badges.

## Backend API

ABS-read surfaces stay in `routes/social.js`; notes and clubs get their own
route modules per the house per-domain pattern (`routes/notes.js`,
`routes/clubs.js`, appended to ROUTES). Everything uses the standard `ctx` from
`resolveContext` (identical self-hosted/hosted) and returns 200
`{ available:false }` / `{ enabled:false }` degradations, never errors.

| Route | Method | Shape |
| --- | --- | --- |
| `/hs/social/leaderboard?window=week\|month\|all` | GET | existing envelope + `window` echoed |
| `/hs/social/finished-by?libraryItemId=` | GET | `{ available, users:[{userId,username,finishedAt}] }`, `shares()`-filtered |
| `/hs/social/listening-now` | GET `?libraryItemId=` / POST `{libraryItemIds}` (bulk, capped 100) | `{ available, users }` / `{ available, byItem }`, filtered by the new presence resolution; ~3 min recency threshold; label the UI "listening recently" |
| `/hs/social/community-config` | GET/PUT | + `defaultShareListening`, `notesEnabled`, `clubsEnabled`, `clubsAiEnabled` (PUT admin-only) |
| `/hs/notes?libraryItemId=&clubId=&position=&after=&finished=` | GET | `{ enabled, notes:[HSNote], locked:[{id,timeSec}], hiddenAhead, now }`; club scope requires membership (403); `locked` only for club scope. Public scope returns the caller's own `personal` notes plus everyone's `public` notes; a `personal` note is invisible to all other callers (never in `notes`, `locked`, or `hiddenAhead`). `safe` notes are always in `notes` regardless of `position` |
| `/hs/notes` | POST | `{ libraryItemId, clubId?, visibility?, parentId?, timeSec?, safe?, body }` -> HSNote; rate-limited. `visibility` defaults `'public'` (`'club'` forced when `clubId` set); reject `club`+no-club or `public`/`personal`+club; `safe` only on top-level notes (ignored on replies) |
| `/hs/notes/:id` | DELETE | author, club owner (own club), or admin -> soft delete |
| `/hs/clubs?libraryItemId=` | GET | `{ enabled, mine:[...], joinable:[...] }`; `joinable` = open clubs whose CURRENT book is the item; without the param, `mine` only |
| `/hs/clubs` | POST | `{ name, libraryItemId? }`; creator becomes owner; optional first current book; rate-limited |
| `/hs/clubs/:id/books` | POST | owner only, `{ libraryItemId }` -> becomes current (promotes a queued book too); previous current gets `finished_at` stamped |
| `/hs/clubs/:id/queue` | POST | owner only, `{ libraryItemId }` -> add to up-next queue; `{ ok, added }` (added:false if the book is already in the club) |
| `/hs/clubs/:id/queue/:itemId` | DELETE | owner only -> remove a queued book; `{ ok, removed }` |
| `/hs/clubs/:id/join` / `/leave` | POST | membership row; join UI states "members see your progress in this club's books" |
| `/hs/clubs/:id/kick` | POST | owner only, `{ userId }` |
| `/hs/clubs/:id?bookId=&position=` | GET | `{ club, books:[HSClubBook], queue:[HSClubBook], members:[{userId,username,currentTime,duration,isFinished,listeningNow}], notes:{notes,locked,hiddenAhead}, unreadCount }`; `books` excludes queued; `bookId` defaults to the current book; `members` progress is for that book; `locked` stubs only for the current book |
| `/hs/clubs/:id/read` | PUT | `{ lastReadAt }` -> `max()` cursor bump (per club) |
| `/hs/clubs/:id/rec-basis` | PUT | owner only, `{ basis }` (`off`\|`club-history`\|`all-members-finished`) -> `{ recBasis }` |
| `/hs/clubs/:id/recommend` | POST | owner only, `{ candidates:[ClubRecCandidate], historyGenres:[string[]] }` -> `ClubRecommendation` (`{ engine, basis, intro, picks:[ClubRecPick] }`, `+ unavailable` when `all-members-finished` and ABS db isn't mounted). AI when `clubs_ai_enabled` + a provider is configured (charged to the QuestGiver limit), else the heuristic; 403 when `rec_basis='off'` |
| `/hs/clubs/:id` | DELETE | owner or admin -> archive |

**`absdb.js` additions** (all ABS schema knowledge stays in this one file;
every function fails soft):

- Fix the confirmed `getLeaderboard` bug: entries are built only from the
  finished-counts query, silently dropping listen-only users. Merge both user
  sets (join `users` in the sessions query too).
- `getLeaderboard({limit, window})` - windowing via lexicographic
  `createdAt >= '<cutoff>'` string compare (ABS's own `userStats.js` pattern).
  **Gated on a boot-time format probe**: read one real `playbackSessions.createdAt`,
  verify the stored text format is lexicographic-safe; if not, serve all-time
  only and log. A session's whole `timeListening` attributes to its start
  window (no splitting; accepted).
- `getFinishedUsers(libraryItemId)` -> `[{userId, username, finishedAt}]` -
  the existing finished-count join plus `users` join.
- `getActiveListeners(libraryItemIds, cutoffMs)` - `playbackSessions` rows
  with `updatedAt` newer than cutoff, item via
  `json_extract(extraData,'$.libraryItemId')` / mediaId hop. **Presence derives
  only from `playbackSessions.updatedAt`** (server-sync-driven), never
  `mediaProgresses.updatedAt` (client-settable, even backwards).
- `getMemberProgress(userIds, libraryItemId)` -> per-member
  `{currentTime, duration, isFinished, updatedAt}` from `mediaProgresses` -
  the club progress-race UI costs zero new tracking.
- `getSelfProgress(userId, libraryItemId)` - the caller's own row, for the
  finished-bypass and position clamp in the notes gate.
- `getFinishedGenresForUsers(userIds)` -> `{ genre: count }` aggregate of the
  genres of every book the given users have finished (`mediaProgresses` ->
  `books.genres` JSON, counted in JS), for the club `all-members-finished`
  recommendation basis.
- `getChapters(libraryItemId)` - `books.chapters` JSON, so notes render
  "Chapter 14 - 1:02:05" on platforms that don't hold the chapter list.
- `playbackSessions` has NO secondary indexes and can't get any (read-only
  db): every scan-shaped query gets a 30-60s in-memory TTL cache keyed by args,
  cutoff-first WHERE ordering, and LIMITs. **Phase 3 includes a perf
  measurement step on a large session table** (10k+ rows) with a stated
  degradation path (lengthen TTL / disable listening-now above a row-count
  threshold).

## `@hearthshelf/core` additions

Edited ONLY in `C:\code\HearthShelf-Core`, then submodule bumps in consumers.
New domain per convention: `src/types/social.ts` + `src/lib/social.ts`, one
export line in each barrel.

- **Types**: relocate `HSLeaderboardEntry/Response`, `HSFinishedCount` out of
  `abs.ts` into `types/social.ts`, keeping **temporary re-exports in `abs.ts`**
  so the three consumer submodule bumps don't have to land atomically. Add
  `HSFinishedByUser`, `HSListeningNowUser`, `HSNote`, `HSNoteStub`, `HSClub`,
  `HSClubBook`, `HSClubMember`, `HSClubDetail`, `LeaderboardWindow`, and the
  envelope types.
- **Pure helpers** (`buildAutoQueue` style - plain data in, deterministic out):
  - `gateNotes(notes, position, meId, isFinished)` -> `{ visible, hiddenAhead }` -
    client-side optimistic re-gating between polls. Documented as NOT the
    authoritative gate (the server route filter is). A note is visible iff
    `note.safe` OR `timeSec == null` OR `timeSec <= position` OR author OR
    finished; a reply gates at its parent's time (safe/author bypasses still
    apply). `HSNote` gains `visibility: 'club'|'public'|'personal'` and
    `safe: boolean` fields; the server already filters `personal` notes to the
    author, so `gateNotes` never sees another user's personal notes.
  - `detectNotePops(prevPos, newPos, stubs, seenIds)` -> `{ pops, seeked }` -
    stubs crossed in `(prevPos, newPos]`; a jump beyond a threshold is a seek
    and crossed notes condense into one batch (no toast floods on scrub).
  - `clubUnreadCount(notes, lastReadAt)` (unlocked notes only),
    `sortMembersByProgress(members)`.
  - `clusterTimelineMarkers(items, durationSec, maxMarkers?)` - groups
    unlocked notes + locked stubs into scrubber markers (position fraction,
    kind, count), shared by the web and mobile players.
  - `craftClubPrompt(clubName, memberCount, taste, candidates, basis)` and
    `clubHeuristic(taste, candidates, basis, rand?)` - the club next-book
    recommender (QuestGiver-style prompt + deterministic fallback), with the
    `ClubRecBasis` / `ClubRecCandidate` / `ClubTaste` / `ClubRecommendation` /
    `ClubRecPick` types and `recBasis` on `HSClub`.
- **Settings catalog** (`lib/settings.ts` DEFS): `shareCurrentlyListening`
  `{ scope:'account', type:'triBool', default:null }`; `notePops`
  `{ scope:'device', type:'boolean', default:true }` (silence pops without
  leaving clubs); `noteDefaultVisibility` `{ scope:'device', type:'enum',
  values:['public','personal'], default:'public' }` (remembers the composer's
  last Public/Personal choice). **Dual edit rule**: mirror all in
  `server/lib/settingsCatalog.js` - core first, mirror second.
- **Drift tripwire**: a small check script in the HearthShelf repo (runnable in
  CI and by hand) that extracts the key list from the `packages/core` submodule
  catalog and diffs it against `server/lib/settingsCatalog.js`, failing on
  mismatch - a silently missed mirror otherwise manifests as `unknown_key`
  rejections on every client at once.

## Client behavior

- **Timeline note markers (scrubber)**: the player seek bar shows where notes
  live in the book. Notes you've passed (unlocked) render as small **avatar
  dot markers** at `timeSec/duration`; ahead-notes (locked stubs) render as
  thin **anonymous tick lines** - no avatar, deliberately, since author
  identity ahead of you is withheld. Tap/click a passed marker to open that
  note in the notes panel/sheet; tap an ahead tick for a teaser ("A note
  awaits at 1:02:05"), never content. Markers within ~1% of the duration
  cluster into one marker with a count badge (pure `clusterTimelineMarkers`
  helper in core, shared web + mobile; cap ~40 rendered markers). Club and
  public notes share the same marker style. No markers in car mode
  (distraction; car UI is native anyway).
- **Pop pipeline**: the watcher subscribes to the player position coarsely
  (zustand `subscribe` on web - never per-tick re-render; the 1s store tick on
  mobile, same place the sleep-timer check lives). On a stub crossing:
  fetch the newly unlocked note(s), toast "\<author>: \<body>" with a deep-link
  into the club panel (`playerStore.requestedPanel` on web; sheet `present` on
  mobile), haptic on mobile. Gated by the `notePops` setting.
- **Pop dedupe** is device-local v1: seen stub ids persist in `localStorage`
  (web/WebApp) and `AsyncStorage` (mobile), capped at 500 per club, keyed by
  club. Re-pop after reinstall/storage-clear is accepted. A server-side
  `note_acks` table is the named v2 upgrade path.
- **Feature detection**: every client degrades on 404/`available:false`/
  `enabled:false` (the `getHSStats` precedent), so box and clients ship on
  independent cadences.

### Surfaces per platform

Per-phase platform order: **self-hosted web -> hosted WebApp -> mobile**, and
"done" for a phase includes its parity plan, not implied simultaneity.

**Self-hosted web** (`HearthShelf/src`): StatsPage leaderboard gains window
pills; BookDetailPage gets finished-by avatar chips + listening-now chips near
the badges/meta-rows, a notes section, and a Book Club card (join/create) -
and finally wires the dormant `getFinishedCountsBulk` shelf badges; PlayerPage
gets a notes pop (cloned from the bookmark pop) and a club Panel: chat thread,
member progress race (avatar dots on a rail, chapter ticks), composer stamping
`playerStore.currentTime`; watcher hooks mount in AppShell beside
`useSettingsSync`/`useQueueSync`; new `src/api/notes.ts` / `clubs.ts` follow
the `social.ts` sFetch + query-key conventions.

**Hosted WebApp**: zero control-plane/Worker changes (verified - CP is never in
the data path). New client modules copy `absSocial.ts` (origin + bearer +
degrade). Each surface is a budgeted 1:1 port per the StatsPage-leaderboard
precedent. Clubs are naturally per-server (no aggregation). **Pre-task before
its Phase 4-5 ports**: a WebApp convergence pass (it still has local-only queue
and core type-name drift; the port estimates assume the core types are wired).

**Mobile**: leaderboard card on `stats.tsx` (Status-union pattern); chips +
club section on `item/[id].tsx` (Sheet); the reserved `'notes'`
PlayerActionKey stub becomes the notes/club sheet; a `clubSync.ts` module
copies `queueSync.ts` lifecycle (start on connect, AppState pull, stop on
sign-out); pops render as Toast + haptics. No new native capability needed.

## Phased rollout

Each phase is independently shippable and valuable; later phases land on rails
the earlier ones prove.

1. **Leaderboard windows + bug fix** - absdb-only: listen-only-user fix (first
   commit), date-format probe, `window=` param, window pills on all three
   Stats surfaces.
2. **Finished-by chips** - `getFinishedUsers` + `/hs/social/finished-by`,
   chips on the detail page, wire the dormant shelf count badges. Reuses
   `shares()` verbatim.
3. **Listening-now presence** - the new setting pair (core catalog + server
   mirror + tripwire script + community column, default OFF), cached
   `getActiveListeners`, chips. First new privacy surface; deliberately
   sequenced to validate the dual-catalog-edit workflow before phases 4-5
   depend on it. Includes the playbackSessions perf measurement gate.
4. **Public notes** - `book_notes` table, `routes/notes.js`, the server-side
   gate + `hiddenAhead`, rate limits, core `gateNotes`, detail-page notes
   section + player notes pop, admin kill-switch + delete. Proves the whole
   note pipeline without club complexity.
5. **Book Club** - clubs/members/club_books tables, `routes/clubs.js`, club
   detail with book history + current-book progress race, locked stubs +
   `detectNotePops` + pop pipeline, replies, unread cursors, owner moderation
   (kick/delete/advance-book), polling cadence. The headline moment, landing
   on four proven layers.
6. **(Deferred, criteria-gated) SSE for club chat** - only if 15-30s reply
   latency measurably hurts; nginx three-file recipe pre-scoped above.
7. **In-car + background note notifications (mobile)** - a real local
   notification for club note-pops so the alert lands when the app is not in
   the foreground: on the phone lock screen, and (the headline) inside Android
   Auto. See the dedicated section below.

## Phase 7 - in-car and background note notifications

Phases 4-5 deliver the note-pop as an **in-app toast**, which only shows while
the HearthShelf UI is foreground. Two cases it misses: the phone is
locked/backgrounded while playing, and Android Auto playback (a separate native
Kotlin service that never touches the JS player store, so the JS pop watcher
never fires). Phase 7 adds a **local notification** delivery path for both.

### Delivery model: one notification, two contexts

A single MessagingStyle notification per crossed note, behaving differently by
where it's shown:

- **Phone (locked / backgrounded)**: a standard heads-up notification titled
  with the author, body = the note text. Tapping it **deep-links to the club
  note screen** (`app/club/[id]` scrolled to the note) via the existing
  expo-router deep-link + the native->JS event bridge.
- **Android Auto (driving)**: Auto renders the same MessagingStyle
  notification. Tapping it makes the car **read the note aloud via TTS**, then
  offers a **voice reply** (`RemoteInput`), captured natively and POSTed to
  `/hs/notes` as a reply. This is the only Auto-sanctioned interaction (Auto
  blocks opening arbitrary app UIs while driving); tap-to-open-screen is the
  *phone* variant of the same notification, not the car one.

Still **not** covered: the app fully closed and nothing playing. There is no
FCM/APNs push and the self-hosted architecture has no path to one - a
notification only fires while *some* HearthShelf process is alive (foreground,
the phone Media3 foreground service, or the Auto service). That is exactly the
"you're listening and cross a note" scenario, so it covers the real cases.

### The Auto service already has the hooks

`plugins/hearthshelf-auto/android/HearthShelfAutoService.kt` already holds
`serverUrl`/`token` (SharedPreferences, written by `setAutoSession`), an `io`
executor, `currentItemId`, `chapters`, an HTTP-POST pattern (`bookmarkNow` /
`syncProgress` / `httpPostSync`), and a 5s `progressTick` reading
`rawPlayer.currentPosition`. Note detection drops into that tick; nothing new
architecturally.

Kotlin work (car service):
- On book load, if the current book belongs to a club the user is in, fetch its
  gated stubs + notes from `GET /hs/notes?clubId=&libraryItemId=&position=`
  (copy the `httpPostSync` request shape; GET with the bearer). Refresh on the
  existing tick cadence (~every 30-60s, not every 5s).
- In `progressTick`, detect crossings with the SAME rule as core's
  `detectNotePops` (prev < timeSec <= now; the 0:00 edge; seek-condense) -
  reimplement the tiny rule in Kotlin (it is ~5 lines; do not try to run core
  TS in Kotlin) and keep a device-local seen-set in SharedPreferences keyed by
  club, mirroring the JS `AsyncStorage` cap-500 dedupe.
- On a crossing, fetch that note's body (it's now unlocked at this position)
  and post a `NotificationCompat` **MessagingStyle** notification on a new
  `club-notes` channel, with a `RemoteInput` reply action whose
  `PendingIntent` routes to a small `BroadcastReceiver` that POSTs
  `{ libraryItemId, clubId, parentId, body }` to `/hs/notes`. The content
  `PendingIntent` (phone tap) launches the app with a `hearthshelf://club/<id>?note=<id>`
  deep link.

JS/RN work:
- Add a notification library capable of MessagingStyle + RemoteInput
  (`@notifee/react-native` - `expo-notifications` alone cannot do reply
  actions). Wire it as a config-plugin dep alongside `hearthshelf-auto`.
- Foreground/background phone path: extend the existing `notePops` watcher so
  that when the app is NOT foreground (AppState !== 'active') it fires a notifee
  notification instead of (or in addition to) the in-app toast; foreground stays
  a toast. Same seen-set as today so a note notifies once across toast+notif.
- Deep-link handler: `hearthshelf://club/:id?note=:noteId` -> push the club
  screen scrolled to the note (expo-router linking + the existing
  `NativeModules.HearthShelf` event bridge for cold-start intents).

### Shared seen-set caveat

Today the car service and the JS watcher are independent worlds with separate
dedupe stores. Phase 7 must reconcile them so a note crossed in the car does not
re-notify on the phone (and vice versa): either a single source of truth
(persist the car's seen-set where JS can read it - both use the app's
SharedPreferences/AsyncStorage-backed storage) or accept one duplicate at the
car<->phone handoff (documented). Prefer sharing the store; it's one
SharedPreferences file both sides can key into.

### Privacy / settings

Reuses the existing `notePops` device setting as the master on/off (it now
governs notifications too, not just toasts). No new server surface - the note
data and gating are unchanged; Phase 7 is purely a new *delivery* channel for
data phases 4-5 already produce. Voice replies post through the same
rate-limited `/hs/notes` POST with the same validation.

### Android Auto policy risk (real, gates the Play submission)

The notification MUST be a genuine MessagingStyle conversation notification on a
dedicated channel, not a repurposed media/alert notification, or Auto will
reject it (or worse, the app's Auto listing). No custom UI, no reading text off
the screen - TTS + voice reply only. Verify against the Desktop Head Unit
(DHU) before shipping. This is why Phase 7 is its own phase: it carries a
submission-review risk none of the pure-data phases do.

## Risks and accepted tradeoffs

- **Presence blind spots**: no isOpen flag in ABS - first-sync lag, offline
  mobile sessions surfacing late, abandoned sessions "listening" until the
  threshold lapses. UI copy says "listening recently", not "online".
- **playbackSessions full scans**: TTL cache + bounded queries + the Phase 3
  perf gate; can't add indexes to a read-only db.
- **Note timestamps vs editions**: `time_sec` is global to one ABS library
  item; re-ripped files don't align. Clubs are per-server; accepted v1.
- **Ahead-note density leak**: stubs reveal that notes exist at future
  timestamps (nothing else). Inherent to exact-second pops; documented.
- **Catalog mirror drift**: mitigated by the tripwire script, not just comments.
- **3x UI cost**: types + pure logic shared via core; every surface built three
  times. Phases ordered so platforms can lag without blocking.

## Out of scope (v2 candidates)

Invite-only clubs + hosted email invites (CP invite infra exists), reactions,
note editing, report/flag + block/mute moderation, server-side `note_acks`
cross-device pop dedupe, anonymization tooling for departed users, FCM/APNs
push (app fully closed), cross-server aggregation. Web/WebApp background
notifications (Notification API / service worker) are a possible sibling to
Phase 7 but out of scope for it - Phase 7 is mobile + Android Auto only.
