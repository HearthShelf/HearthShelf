# Discover unification

> Plan to make HearthShelf's own taste engine the single discovery source across
> web, mobile, and Android Auto - and to stop leaking ABS's native "discover"
> feed anywhere. Status: **planned, not built.**

## The problem

ABS's native personalized feed (`/api/libraries/:id/personalized`) is the
discovery source on **Home** on every platform, and it recommends books the user
has no interest in (e.g. household members' books - ABS scopes personalization to
the library, not the user's taste). HearthShelf's own, better taste engine is
only wired into the **web Discover page**. So the good system is boxed into one
screen while the bad feed fronts every Home.

Current sources, before this change:

| Surface | Discovery source | Issue |
| --- | --- | --- |
| Web Home (`src/pages/HomePage.tsx`) | ABS `/personalized` | Renders ABS's `discover` + `listen-again` shelves = irrelevant books |
| Web Discover (`src/pages/DiscoverPage.tsx`) | `buildDiscoverShelves()` + monthly AI + popular | This is the good one |
| Mobile Home (`app/(tabs)/index.tsx`) | ABS `/personalized` (fallback: first 20 items) | Same leak |
| Android Auto "Discover" tab | JS snapshot of mobile Home's ABS `/personalized` shelves (`setAutoDiscover`) | Empty when Home hasn't published; polluted when it has - this is the "no items in the car" report |
| Mobile Discover screen | none - does not exist | `buildDiscoverShelves()` sits unused in core |

## The two facts that make this clean

1. **`buildDiscoverShelves()` (`packages/core/src/lib/discover.ts`) is pure,
   deterministic, and always returns content** from the library + listening
   history alone - no QG run, no AI, no network. It returns
   `{ shelves, profile }`; `shelves[0]` is always `Recommended for you`, and a
   `Back to your library` fallback guarantees a non-empty result for any
   non-empty library. It is already shared web+mobile through the
   `@hearthshelf/core` submodule.
2. **Only the monthly AI shelf and QG runs need user interaction.** Everything
   else is available on first run. So the taste engine is the safe *base*, and
   QG/AI refinement layers *on top* when it exists - which is exactly the stated
   priority: **QuestGiver first, then programmatic inferred-interest discovery.**

## Design decisions (locked)

- **Cut scope: drop only the tainted ABS shelves.** Keep ABS's own-progress /
  own-library rows (`continue-listening`, `recently-added`, `recent-series`,
  `continue-series`) - they are the user's own data, not cross-user
  recommendations. Strip the recommendation shelves (`discover`, `listen-again`)
  and replace them with our taste engine. We keep calling `/personalized` but
  filter its output; we do **not** rebuild Continue/Recently-Added ourselves in
  this pass.
- **Home is a preview of Discover.** Home = resume hero + Continue + a small
  slice of the taste engine (the `Recommended for you` shelf, plus the monthly AI
  shelf if one exists). Discover = the full engine (all shelves + AI + popular).
  One ranking, two depths.
- **All platforms this pass.** Web Home + Discover, mobile Home + a new mobile
  Discover screen, and Android Auto's Discover tab all read the taste engine.

## Ranking contract (the "QG first, then programmatic" rule)

A single shared ordering, applied everywhere shelves are shown:

1. **QuestGiver-refined picks** - if the user has run QuestGiver, its latest
   accepted picks / feedback bias the ranking. Present first.
2. **Monthly AI shelf** - if generated for the current month, shown as one themed
   row near the top.
3. **Programmatic taste shelves** - `buildDiscoverShelves()` output, always
   present, fills the rest.
4. **Popular on server** - unchanged, tail of Discover only.

The deterministic layer (3) is the floor; it renders on first run with zero
setup, so no surface is ever empty. QG/AI only ever *reorders/prepends*, never
gates.

## Work items

### `@hearthshelf/core` (do in `C:\code\HearthShelf-Core`, push, then bump submodule)

- Add a shared helper that folds QG feedback / latest-run picks into the
  `buildDiscoverShelves()` ranking, so web and mobile agree. Likely a
  `rankWithQuestGiver(shelves, profile, feedback, lastRun)` or a `preview`
  selector that returns the Home slice. Keep it pure.
- Export any new types from the barrel.

### Web (`C:\code\HearthShelf`)

- **`src/pages/HomePage.tsx`**: stop rendering ABS's `discover` / `listen-again`
  shelves (filter them out of the `/personalized` result). Insert the taste
  engine's `Recommended for you` shelf and the monthly AI shelf (if present)
  into the Home layout. Reuse existing `useDiscover` hooks + core builder.
- **`src/pages/DiscoverPage.tsx`**: apply the shared QG-first ranking so Discover
  and Home order identically. Otherwise largely as-is.

### Mobile (`C:\code\HearthShelf-Mobile`)

- **`app/(tabs)/index.tsx`**: replace the `/personalized` shelves (and the
  first-20 fallback) with `buildDiscoverShelves()` output for the recommendation
  rows; keep Continue / Recently-Added from ABS. Publish the *taste-engine*
  shelves to Android Auto via `setAutoDiscover()` instead of the ABS feed.
- **New mobile Discover screen**: wire `buildDiscoverShelves()` + monthly AI +
  feedback (needs the mobile-side `/hs/discover*` API client, which does not
  exist yet - add it mirroring `src/api/discover.ts`).
- **Android Auto** (`HearthShelfAutoService.kt` reads the `discover` pref
  snapshot): no native change needed - once the JS side publishes taste-engine
  shelves, the car shows them. Because the engine is deterministic and offline,
  the car is populated on first run instead of empty.

## Out of scope (this pass)

- Rebuilding Continue Listening / Recently Added ourselves (we keep ABS's).
- Realtime push of shelves to the car (snapshot-on-publish is enough).
- Server-side pre-generation of the monthly AI shelf (stays user-triggered).
