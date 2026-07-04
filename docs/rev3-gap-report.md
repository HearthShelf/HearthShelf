# HearthShelf Rev 3 — Gap-Validation Report

## 1. Executive Summary

HearthShelf has reached solid parity on its core listening surfaces. Across 13 audited modules, 12 are **partial** and 1 (`reader-ebook`) is **absent**. Every confirmed gap in the dataset was verdict-validated as real (`isReal: true`). The biggest gaps cluster in four areas: (1) the **ebook reader** — an entirely unbuilt module (no Reader component, route, store, or progress wiring), which is an *expected* gap since CLAUDE.md explicitly scopes the ebook reader out of v0.1; (2) the **RMAB/ReadMeABook request flow** — the API layer exists but the front-end (RequestConfirmModal, RequestTile, Audible catalog search in Discover, RequestAction state machine, WatchToggle, ConnectRmabCard, HomeRequestsShelf) is largely unwired; (3) **admin-config editability** — Email, Auth/OIDC, Settings, Backups, Libraries, and Users pages are mostly read-only displays where Rev 3 expects editable forms, and most are blocked on missing ABS/HearthShelf API endpoints; and (4) **stats depth** — community comparison, leaderboards, device breakdowns, and top genres/authors are missing, all classed as **expected-stats-gaps** pending cross-user aggregation APIs. The healthy news: home, library browsing, book detail, player, podcasts, collections/playlists/search, and settings all have working cores, and most remaining gaps are additive UI or backend-blocked rather than broken behavior.

## 2. Per-Module Status

| Module | Current status | Confirmed gaps | Headline gap |
| --- | --- | --- | --- |
| home | partial | 5 | No RMAB requests shelf (`HomePage.tsx`) |
| library | partial | 11 | Authors/narrators multi-select + merge/delete absent (`LibraryPage.tsx:619-669`) |
| book-detail | partial | 7 | No eBook Read button / dual-format UI (`BookDetailPage.tsx`) |
| reader-ebook | **absent** | 9 | Entire Reader component + route missing (`reader.jsx` → no `src` equiv) |
| series-authors-narrators | partial | 7 | RMAB watch toggles + series missing-books display absent |
| collections-playlists-search | partial | 9 | RMAB search lane missing from `SearchPage.tsx:175` |
| player | partial | 7 | "Read along" reader panel + "Recent listens" popover missing (`PlayerPage.tsx`) |
| podcasts | partial | 4 | `PodcastQueuePage.tsx` fully stubbed (download queue) |
| sessions-stats | partial | 5 | "Compare to other listeners" absent (expected-stats-gap) |
| admin-config | partial | 16 | ReadMeABook config UI missing (`ConfigContentPages.tsx`) — blocker |
| questgiver-bookdate | partial | 9 | RMAB request integration discarded/unwired (`QuestGiverPage.tsx`, `questgiver.ts`) |
| rmab-requests-discover | partial | 13 | RequestConfirmModal + Discover Audible search missing — 3 blockers |
| settings-tweaks-account | partial | 13 | Reader settings pane + Connections pane absent (`SettingsPage.tsx`) — blocker |
| modals-tools | partial | 14 | ItemEditModal has 3 of 7 tabs; tool pages (ChapterEditor/FileReorder/ManageTool/Upload) missing |

## 3. Blockers & Majors

### Blockers

- **RequestConfirmModal missing** (`rmab-requests-discover`) — no request-submission modal anywhere; `submitRequest()`/`searchCatalog()` in `src/api/requests.ts:136-153` are defined but never called. *Fix:* create `src/components/requests/RequestConfirmModal.tsx` with confirm + success (`approved` vs `awaiting_approval`) states wired to `submitRequest()`.
- **RequestTile missing** for Discover catalog results (`rmab-requests-discover`) — `DiscoverPage.tsx` has zero requestable-tile rendering. *Fix:* create `RequestTile.tsx` mirroring `BookTile` plus a request action, integrated with the confirm modal.
- **Audible catalog search missing from DiscoverPage** (`rmab-requests-discover`) — `DiscoverPage.tsx` is recommendation-only; no query state or `searchCatalog()` call. *Fix:* add search input (`ab-search` class exists), `useState` query, call `searchCatalog()`, render RequestTile/BuyTile, dedupe owned items.
- **ReadMeABook config UI missing** (`admin-config`, `ConfigContentPages.tsx:179`) — admins cannot configure the RMAB server connection, blocking the whole request feature server-wide. *Fix:* add RMAB integration card (enable toggle, server URL, API token, test connection, user-settings toggle) plus external book-links section.
- **Settings page missing all editable config** (`admin-config`, `ConfigServerInfo.tsx`) — `/settings` shows read-only status only; ABS exposes `PATCH /api/settings`. *Fix:* add `getServerSettings`/`updateServerSettings` to `admin.ts` and a `ConfigSettings` form (library/scanner/display/web-client/security toggles).
- **Missing Reader settings pane** (`settings-tweaks-account`, `SettingsPage.tsx`) — no `readerTheme/readerFont/readerSize/readerLh/readerWidth/readerAlign/readerBright/readerLayout` in `settingsStore.ts`. *Fix:* add the 8 fields + a Reading pane with live preview. (Coupled to the reader-ebook module.)
- **Reader component + route missing** (`reader-ebook`, `severity: blocker`) — no `/read` route in `router.tsx`, no `ReaderPage`, no Reader component. *Note:* this is the **expected** out-of-scope ebook reader (see §5); treat as a deliberate v0.1 deferral, not a defect.

### Majors (selected, grouped)

- **People management in LibraryPage** (`library`, `LibraryPage.tsx:619-669`) — authors/narrators tabs render read-only cards with no multi-select, merge, edit, or delete. The modals (`MergeModal.tsx`, `PersonModals.tsx`) and `PersonCard` already exist and work in `AuthorsPage`/`NarratorsPage`. *Fix:* swap static cards for `PersonCard`, add selection state + people selection toolbar, render existing modals. (Note: this is an architectural divergence — the feature lives in dedicated pages today.)
- **eBook Read button + detection on BookDetailPage** (`book-detail`/`reader-ebook`) — only a Listen action; no `b.ebook` branching. Blocked on the reader module and on ABS ebook metadata in `types.ts`. *Fix bundled with reader-ebook.*
- **RMAB watch toggles + series missing-books** (`series-authors-narrators`) — `WatchToggle` and series "Not in library" requestable rows are absent (`SeriesDetailPage.tsx`, `AuthorDetailPage.tsx`). *Fix:* build `WatchToggle.tsx`, wire `toggleWatchAuthor/Series`, merge requestable items into series list with grayscale + lock styling.
- **Narrators table layout** (`series-authors-narrators`) — `NarratorsPage.tsx` uses card grid; Rev 3 specifies a 3-column table (Name/Books/Actions). *Fix:* refactor presentation to a table.
- **Player "Read along" + "Recent listens"** (`player`, `PlayerPage.tsx`) — Panel type lacks `'reader'`; no per-book session history popover though `getListeningSessions()` exists. *Fix:* add reader panel (blocked on reader module) and a `recent` pop reusing the sessions API.
- **PodcastQueuePage stubbed** (`podcasts`) — empty state only; download-queue endpoint is `@needs-verify` against ABS 2.35.1. *Fix:* confirm ABS endpoint, then add progress banner + queued-episodes table.
- **QuestGiver RMAB integration** (`questgiver-bookdate`) — explore-genre sliders, request/new-pick action handlers, and requestable candidate pool are unwired; `qgLibraryCandidates()` returns library-only. *Note:* `newPicks` mapping, the include-request toggle, and rate-limit exhaustion were auto-fixed this run (see §4); remaining work is the requestable catalog wiring (high risk, backend-coupled).
- **Admin editable forms** (`admin-config`) — Email (read-only), Auth/OIDC (read-only), RSS (missing Slug/Episodes/Updated columns), Notifications (no create UI), Backups (no settings fields), Libraries (no add/scan/edit/delete), Users (Add user button — auto-fixed §4), QuestGiver behavior tuning. Most are blocked on missing API endpoints in `admin.ts`. *Fix:* add update endpoints + editable forms incrementally.
- **modals-tools missing tabs/screens** — `ItemEditModal.tsx:122` has only Details/Match/Cover (missing Chapters/Files/Tools); full-page `ChapterEditor`/`FileReorder`/`ManageTool` and the `Upload` page (router points to `ComingSoonPage`) are unbuilt. Mostly backend-blocked per the in-file comment.

## 4. Low-Risk Fixes Auto-Applied This Run (in worktrees)

All passed `tsc --noEmit`; no new routes/API calls/`any` introduced unless noted.

- Add ebook format badge (`cv-fmt`) to `BookTile` — `types.ts`, `BookTile.tsx`, `design.css` (added `ebookFormat?` to `ABSBookMedia`).
- HoverActions "Read" affordance for ebook-only books — `BookTile.tsx`.
- Home unified-mode "across all libraries" messaging — `HomePage.tsx` (reads existing `unifiedHome` setting).
- Visible "Clear filters" button in library toolbar — `LibraryPage.tsx`.
- Edit/merge helper hint on person grid toolbar — `LibraryPage.tsx`.
- "Add to collection" dropdown item — `BookDetailPage.tsx` (reuses `AddToListModal`).
- "Bookmarks" dropdown item (toast stub) — `BookDetailPage.tsx`.
- "Share" dropdown item (copies URL) — `BookDetailPage.tsx`.
- Per-book ebook reader persistence store — new `src/store/readerStore.ts` (standalone; no Reader component to consume it yet).
- "New collection" button in Collections toolbar (toast stub) — `CollectionsPage.tsx`.
- "New playlist" button in Playlists toolbar (presentational) — `PlaylistsPage.tsx`.
- "Open RSS feed" + "Download" items in Collection detail dropdown — `CollectionDetailPage.tsx`.
- Playlist row `drag_indicator` icon replacing index — `PlaylistDetailPage.tsx`.
- Series search icon → `format_list_numbered` — `SearchPage.tsx`.
- Reorder ConfigShell nav groups to match Rev 3 — `ConfigShell.tsx`.
- Config side-nav footer shows server name + ABS version + host — `ConfigShell.tsx` (reuses `server-status` query).
- "Add user" button on Config Users page (modal explainer) — `ConfigUsers.tsx`.
- Include-requestable-books toggle in QuestGiver fine-tune (gated on `useRmabEnabled`) — `QuestGiverPage.tsx`.
- Map AI engine `newPicks` into rendered QuestGiver results — `QuestGiverPage.tsx`.
- Enforce QuestGiver rate-limit exhaustion (disable run + banner) — `QuestGiverPage.tsx`.
- Discover-banner state notice in QuestGiver admin config — `ConfigQuestGiver.tsx`.
- QuestGiver header icon `explore` → `favorite` — `QuestGiverPage.tsx`.

## 5. Expected Gaps (Not Defects)

- **Entire ebook reader module** (`reader-ebook`: Reader component, route, ReaderPanel, paged layout, read-along audio markers, chapter parsing, progress sync) — CLAUDE.md line 73 lists "ebook reader" as out-of-scope for v0.1. The persistence store was pre-built this run as a no-cost head start.
- **Community/stats comparisons** — "Compare to other listeners," server leaderboard, device breakdown, top genres/authors, server-library tiles, per-user stat tiles. Reported here as blocked on cross-user aggregation not present in `ABSListeningStats`/`ABSServerStats`/`ABSLibraryStats`. **Update (since this report):** the **server leaderboard** and per-book **"finished by N"** count have shipped - HearthShelf reads ABS's database read-only instead of waiting on its API (see `docs/social-stats.md`), and the StatsPage banner was replaced with the live leaderboard. The remaining comparison tiles are still open.
- **API-pending admin forms** — Email update, OIDC update, collection/playlist Edit, RSS Slug/Episodes/Updated, Backups settings, Library CRUD, user creation, BatchEdit Authors/Narrators, ItemEditModal Quick match/Re-scan: each lacks a corresponding endpoint in `admin.ts`/`libraries.ts` and is correctly deferred until backend support lands.
- **Book-level RSS feed / Share / external-link toggles** — ABS provides `feedUrl` only for podcasts, not books; per-service external-link toggles have no backend store.

## 6. Recommended Next Build Steps (Ordered)

1. **Unblock RMAB end-to-end (highest leverage).** Build the admin **ReadMeABook config card** (`ConfigContentPages.tsx`) first — nothing else in the request flow functions without server-side config. Then ship `RequestConfirmModal`, `RequestTile`, and `RequestAction` (the three blockers), wiring the already-present `submitRequest()`/`searchCatalog()` APIs.
2. **Add Audible catalog search to Discover** and the `RmabSearchLane` in `SearchPage`, reusing the new RequestTile. This delivers the headline Discover/search gaps and exercises the request flow from step 1.
3. **Wire RMAB watch + home shelf:** `WatchToggle` (author/series detail), `HomeRequestsShelf`, and `ConnectRmabCard` in Settings — completes the RMAB surface across home/detail/settings.
4. **Consolidate people management in LibraryPage** by reusing the existing `PersonCard` + `MergeModal`/`PersonModals` (low backend risk, components already exist) and refactor `NarratorsPage` to the table layout.
5. **Make admin config editable where APIs exist:** start with ABS `PATCH /api/settings` (Settings pane) and Library CRUD/scan, then Email/OIDC/Notifications/Backups as endpoints are confirmed.
6. **Finish podcasts + modals-tools backend-gated items:** verify the ABS podcast download-queue endpoint to fill `PodcastQueuePage`, then add ItemEditModal Chapters/Files/Tools tabs and the Upload page as their endpoints land.
7. **Defer the ebook reader module and stats comparisons** until their respective scopes/APIs are greenlit; the `readerStore` and reader settings groundwork can land incrementally ahead of the full Reader component.