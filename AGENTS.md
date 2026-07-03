# AGENTS.md

> **NAMING (hard rule): never write or say "hs.direct".** We do not own that
> domain. The remote-access feature is the **connect domain**. The current zone
> is **`d.hearthshelf.com`**; a dedicated connect domain will be registered
> later. Always read the zone from config (e.g. `HSDIRECT_ZONE`, default
> `d.hearthshelf.com`) - never hardcode a domain literal. Real hostnames are
> synthesized as `<ip-dashed>.<hash>.<zone>`; the cert is `*.<hash>.<zone>`.

Guardrails for AI agents and contributors working in the HearthShelf repo.
These are not style preferences - they exist to keep HearthShelf legally
defensible and correctly positioned. Treat them as hard rules.

## What HearthShelf is (and the line that keeps it safe)

HearthShelf is a **user interface** over a server the user runs (AudiobookShelf),
plus a small backend for HearthShelf-specific state (QuestGiver). It is in the
same legal category as Plex or Jellyfin: a tool you point at content **you
already have and are entitled to**.

Our safety rests on the *Sony* "substantial non-infringing use" doctrine and on
**not inducing infringement** (the *Grokster* line). The fastest way to lose
that protection is to design or describe the product as a way to **get** content
for free. Do not cross that line.

## Hard rules

1. **Never host, source, distribute, or bundle content.** HearthShelf provides
   plumbing to talk to servers/services the user configures. It never ships,
   embeds, or fetches copyrighted material itself.

2. **Acquisition/request integrations stay opt-in, source-agnostic, and
   unconfigured by default.** Features like ReadMeABook are pure plumbing: the
   user supplies the backend and is solely responsible for it. Never ship a
   default source, a preconfigured "free" catalog, or a one-click
   find-and-download-anything flow.

3. **No infringement-encouraging language anywhere.** Not in UI copy, button
   labels, docs, comments, commit messages, variable names, or log lines. Banned
   framings: "free books/audiobooks," "pirate," "torrent," "get any book,"
   "download for free," or anything implying you can obtain paid content at no
   cost. Prefer neutral, mechanical wording: "request," "source," "connect a
   backend," "fetch from your configured provider."

4. **No DRM circumvention.** Never add code that breaks, strips, or bypasses DRM
   or technical protection measures (DMCA 1201 risk).

5. **No links to infringing sources.** Do not reference, link, or point users to
   piracy sites, indexers of infringing content, or "where to get" copyrighted
   material.

6. **Keep the disclaimer intact.** The "you are responsible for the content you
   add and the backends you connect" disclaimer in the README must stay. Don't
   weaken or remove it.

## Licensing boundary

- This repo is **AGPLv3** (see `LICENSE.md`). All contributions are AGPLv3 and
  require a DCO sign-off (`git commit -s`); see `CONTRIBUTING.md`.
- The whole ecosystem is open source. The **servers** (this repo and
  `HearthShelf-WebApp`) are **AGPLv3** - the copyleft protects the service. The
  **client app** (`HearthShelf-Mobile`) and the shared **`@hearthshelf/core`**
  library are **MIT** (AGPL buys little on a phone app and conflicts with App
  Store terms, so MIT is the low-friction choice). MIT links cleanly into the
  AGPL servers, so consuming `@hearthshelf/core` everywhere is fine and expected.

## Standard engineering rules

The full engineering rules (Evidence-Based Development, TypeScript strict mode,
the `/abs-api/*` CORS discipline, persistent player bar, progress-sync cadence,
"never git push") live in `CLAUDE.md`. Read it. AGENTS.md adds the legal
guardrails on top; it does not replace `CLAUDE.md`.

## Related repositories

| Repo | What it is | License |
| --- | --- | --- |
| **HearthShelf** | This repo - self-hosted SPA + Node backend (`server/`) + Docker | AGPLv3 |
| **HearthShelf-WebApp** | Hosted front door (`app.hearthshelf.com`): SPA + control-plane Worker | AGPLv3 |
| **HearthShelf-Mobile** | Mobile app (Expo/RN); Android Auto via a native Media3 `MediaLibraryService` | MIT |
| **HearthShelf-Core** | `@hearthshelf/core`: shared ABS types + pure logic (git submodule) | MIT |
| **HearthShelf-Website** | Marketing site (`hearthshelf.com`) | AGPLv3 |
| **HearthShelf-Docs** | Docs site (`docs.hearthshelf.com`) | - |
| **HearthShelf-Direct-Infra** | VPS-side infra for the connect domain | - |
| **HearthShelf-DesignSystem** | Logos, favicon, shared design assets | - |

## Core submodule (`packages/core`) - do not desync it

`packages/core` is a git submodule pointing at `HearthShelf-Core`. Getting this
wrong breaks CI with `fatal: remote error: upload-pack: not our ref <sha>` /
`Direct fetching of that commit failed`. It has already happened more than once.

- **Never edit files under `packages/core`.** It is a separate clone with its own
  HEAD; a local commit there never reaches `HearthShelf-Core`'s `origin/main`, so
  the pointer this repo commits references a commit CI cannot fetch. Any
  `@hearthshelf/core` change belongs in `C:\code\HearthShelf-Core`: edit + commit
  + push **there** first.

- **Bump the pointer with fetch + reset, NEVER `git pull`.** A `git pull` inside
  the submodule merges a stale local-only "orphan" commit back in and produces a
  fresh orphan pointer - the exact CI break. Do this instead:

  ```sh
  git -C packages/core fetch origin main
  git -C packages/core reset --hard origin/main   # NOT git pull
  ```

- **Verify before committing the pointer** (all three must hold):

  ```sh
  git -C packages/core log --oneline origin/main..HEAD   # must be EMPTY
  git -C packages/core branch -r --contains HEAD | grep origin/main   # must match
  git ls-tree HEAD packages/core   # this sha must be on Core's origin/main
  ```

  If any check fails the pointer is an orphan - do not `git add packages/core`.

## If in doubt

If a change might read as helping someone obtain content they don't own - stop
and flag it to the maintainer rather than shipping it. A neutral tool that a
user wires to their own sources is fine; a turnkey "get it free" experience is
not.
