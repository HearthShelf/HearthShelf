# HearthShelf — DesignSystem Parity: Open Items

> **Design source:** `C:\code\HearthShelf-DesignSystem\project\app` (Claude Design handoff bundle).
> This doc lists **only what still needs attention**. Completed work has been removed.
> Last reviewed: 2026-06-23.

> Design-system removals (reader prose features, RMAB personal-link) live in
> [claude-design-update-prompt.md](claude-design-update-prompt.md), not here.

## 1. Minor / cosmetic

- **series-authors-narrators**: SeriesDetail mobile `HeroCovers` omitted; Author detail
  missing Edit/RSS buttons (desktop + mobile).
- **podcasts**: "In library" badge unused on search results; `EpisodeCard` duration
  format `formatDuration` vs DS "X min".
- **questgiver**: admin provider `<select>` vs DS segmented group; admin discover-banner
  toggle / recommendations-per-quest slider (need `QgAdminConfig` schema fields);
  `QuestGiverEntry` icon `explore` should be `favorite`.
- **rmab-requests-discover**: Discover eyebrow/subtitle not search-aware; "Top-rated in
  {genre}" shelf variant; `RequestConfirmModal` accent glow.
- **modals-tools**: ItemEditModal footer Quick-match/Re-scan buttons; Details-tab read-only
  Series field; `BatchEditModal` Authors/Narrators fields (API-limited); PersonEditModal
  Sort-name; PersonDeleteModal rich warning UI; Upload auto-fetch-metadata toggle.

## 2. Backend-blocked — need server work before any UI

Verified against the ABS 2.35.1 source; building UI now would write to nowhere or show fake data.

- **Account display-name / interface-language** — ABS `User` model has no such columns, and
  there's no `/me` profile-update endpoint (only `/me/password`, `/me/ereader-devices`).
- **Hardcover personal link** — zero Hardcover references in the ABS server; needs
  HearthShelf's own backend to store a per-user token.
- **RMAB per-user attribution** — would need per-user token forwarding in the proxy (it uses
  one shared server token today). Ships as status-only; the design's personal-link is removed
  (tracked in the Claude Design prompt).
- **Readers / "who read this" AvatarStack + toggle** — ABS exposes no per-item reader list to
  non-admins via its API. Now unblocked: HearthShelf reads ABS's database read-only (see
  `docs/social-stats.md`), which already powers the per-book "finished by N people" count; an
  avatar list could be built the same way. A list of names is still gated on the per-user
  share preference.
- **Other API-pending bits**: book-detail eBook page count (`ABSEBookFile` has no `pages`);
  RMAB `releaseDate` + request `by` attribution; Sessions table User column (API doesn't
  expose username for all-users sessions).

## 3. Deferred — out of v0.1 scope

- **Stats depth** (cross-user aggregation, not in the ABS API): the **server leaderboard** on
  `StatsPage` and the per-book **"finished by N people"** count are now **shipped** - HearthShelf
  reads ABS's database read-only to aggregate them (see `docs/social-stats.md`). Still deferred:
  Compare/percentile tiles, `ConfigServerStats` device-breakdown, `ConfigLibraryStats`
  top-genres/authors, `ConfigUserDetail` per-user tiles. Those could use the same read-only path
  but each needs its own analysis.

## Notes

- **Likely-intentional architecture choices (not defects):** unified library replacing
  standalone `/authors` & `/series` index pages; reader on real epub.js (vs the DS
  generated-prose mockup); `ConfigMyStats` routing to `StatsPage`. RSS feeds read-only in
  admin — not yet investigated (TBD).
- **Naming:** the design-system file `bookdate.jsx` is just the prototype's old filename — its
  components are all `Questgiver*`. There is no "BookDate" feature; it is QuestGiver.
