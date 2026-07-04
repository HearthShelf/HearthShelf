# HearthShelf

[![CI](https://github.com/HearthShelf/HearthShelf/actions/workflows/ci.yml/badge.svg)](https://github.com/HearthShelf/HearthShelf/actions/workflows/ci.yml)
[![Release](https://github.com/HearthShelf/HearthShelf/actions/workflows/release.yml/badge.svg)](https://github.com/HearthShelf/HearthShelf/actions/workflows/release.yml)
[![Website](https://img.shields.io/badge/site-hearthshelf.com-2c6e6b)](https://hearthshelf.com)
[![Docs](https://img.shields.io/badge/docs-docs.hearthshelf.com-2c6e6b)](https://docs.hearthshelf.com)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE.md)

Browser-first, self-hosted replacement UI/UX for [AudiobookShelf](https://www.audiobookshelf.org/) (ABS).

HearthShelf is **mostly the face** - ABS remains the backend server and the source of truth
for all library data, playback, and progress. HearthShelf runs as a self-hosted Docker
container (a static SPA served via nginx) plus one small backend of its own, QuestGiver,
which holds HearthShelf-specific state (app settings, AI recommendation config/history,
request/feedback data) in an embedded SQLite database. It never duplicates ABS data, does no
file management, and all library data comes from a user-configured ABS server via its REST
API and Socket.io interface.

- Website: [hearthshelf.com](https://hearthshelf.com) &middot; Docs: [docs.hearthshelf.com](https://docs.hearthshelf.com)
- Stack: React 19 + TypeScript, Vite, Tailwind v4, shadcn/ui, TanStack Query, Zustand,
  React Router, socket.io-client, nginx + Docker
- Backend: a small Node service (`server/`) with an embedded SQLite database for
  HearthShelf-specific state (settings, QuestGiver AI config/history, Discover feedback)

## Install

Run it with Docker. The [All-in-One image](https://docs.hearthshelf.com/setup/all-in-one)
bundles AudiobookShelf; the slim image fronts an ABS server you already run. Full
setup, configuration, and reverse-proxy guides live in the
[documentation](https://docs.hearthshelf.com/setup/docker).

## Documentation

User-facing setup and usage docs live at [docs.hearthshelf.com](https://docs.hearthshelf.com).
Design specs for individual subsystems live in this repo's [`docs/`](docs/)
directory (database, queue, settings sync, social stats, and more).

For contributor guidance and critical rules, see [CLAUDE.md](CLAUDE.md).

## Related repositories

HearthShelf spans several repos, all under the [HearthShelf](https://github.com/HearthShelf) org:

- [HearthShelf-WebApp](https://github.com/HearthShelf/HearthShelf-WebApp) - hosted front door (`app.hearthshelf.com`)
- [HearthShelf-Mobile](https://github.com/HearthShelf/HearthShelf-Mobile) - React Native app (Android Auto + CarPlay)
- [HearthShelf-Core](https://github.com/HearthShelf/HearthShelf-Core) - shared ABS types + pure logic (`@hearthshelf/core`)
- [HearthShelf-Docs](https://github.com/HearthShelf/HearthShelf-Docs) - the documentation site
- [HearthShelf-Website](https://github.com/HearthShelf/HearthShelf-Website) - the marketing landing page

## License

HearthShelf is licensed under the **GNU Affero General Public License v3.0**
(AGPLv3) - see [LICENSE.md](LICENSE.md). The AGPL's network clause means anyone
who runs a modified HearthShelf as a network service must make their source
available.

Contributions are welcome and must be signed off under the Developer Certificate
of Origin (`git commit -s`). See [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md).

## Legal / disclaimer

HearthShelf is a user interface. It does **not** host, store, source, or
distribute audiobooks, ebooks, or any other content, and it is not affiliated
with AudiobookShelf.

**You are responsible for the legality of the content you add to your library
and for any backends or services you connect to HearthShelf.** Integrations that
talk to external services (for example ReadMeABook) are opt-in, unconfigured by
default, and source-agnostic: you supply the backend and are responsible for it.
HearthShelf provides the plumbing, not the content, and is not a means of
obtaining it.
