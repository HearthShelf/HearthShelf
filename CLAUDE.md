# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Summary

HearthShelf is a browser-first, self-hosted replacement UI/UX for AudiobookShelf (ABS).
ABS remains the backend server and the source of truth for all library data,
playback sessions, and progress. HearthShelf is mostly **the face** - a UI layer
over the ABS REST API and Socket.io interface - with one small backend of its own:
the QuestGiver service (`server/`), which holds the AI provider key, enforces rate
limits, and persists HearthShelf-specific state (app settings, QuestGiver config /
history, Discover feedback) in an embedded SQLite database. It never duplicates
ABS data. See `docs/database.md`.

Domain: hearthshelf.com - Type: static SPA + a small Node backend, served via
nginx in a Docker container.

## Documentation

Full specs live in `docs/`. Read the relevant file when working on a specific area:

- @docs/overview.md - Project overview, goals, what HearthShelf is and is not
- @docs/architecture.md - System architecture, CORS strategy, request flow
- @docs/reverse-proxy.md - Transparent ABS front-end: one host for HearthShelf + native ABS clients (ABSORB)
- @docs/tech-stack.md - Framework, build, styling, state, and tooling choices
- @docs/repository-structure.md - Directory layout and file responsibilities
- @docs/api-integration.md - ABS API client, endpoints, request patterns
- @docs/authentication.md - Login, token persistence, OAuth2/OIDC flow
- @docs/audio-streaming.md - Native audio playback, sessions, progress sync
- @docs/state-management.md - Zustand stores and TanStack Query patterns
- @docs/routing.md - React Router route definitions and protected layout
- @docs/component-system.md - shadcn/ui usage and v0.1 component list
- @docs/docker-setup.md - Dockerfile, nginx config, runtime env injection
- @docs/database.md - HearthShelf's embedded SQLite store (settings sync, QuestGiver config/history)
- @docs/coding-conventions.md - TypeScript, components, state, CSS standards
- @docs/scope.md - v0.1 in-scope and out-of-scope features
- @docs/init-commands.md - Scaffolding commands to bootstrap the project

## Evidence-Based Development

Never make changes without confirming functions, APIs, and types exist by observing them.

Verify through:
- AudiobookShelf API documentation (see `docs/api-integration.md` for endpoint references)
- Direct code observation in this repo
- Never guess or rely on memory for ABS response shapes - all shapes live in `src/api/types.ts`

When citing changes, reference specific endpoints, existing patterns, and line numbers
where applicable.

## Critical Rules

- **TypeScript strict mode**: No `any`. No unused imports (ts(6133) is an error).
- **All ABS response shapes** defined in `src/api/types.ts` - one source of truth.
- **No CORS hacks in app code**: all ABS calls go through `/abs-api/*` (nginx proxies).
- **Token handling**: Bearer token from `authStore`, persisted to `localStorage` (token only).
- **Player bar is persistent**: it stays rendered across route changes - never unmount it
  on navigation.
- **Progress sync discipline**: sync every 30s while playing + on session close via
  `navigator.sendBeacon` on `beforeunload`.
- **shadcn/ui components are owned source** in `src/components/ui/` - generated via CLI,
  treated as our code, not a node_modules dependency.
- **Tailwind utility classes only** - no custom CSS files except CSS variable definitions
  in `index.css`.
- **One component per file**, file name matches export name.
- **Never git push** unless explicitly told - pushes can trigger CI/CD.

## Out of Scope for v0.1

Podcasts, search, filtering/sorting, collections/playlists, bookmarks, offline/PWA,
admin controls, Chromecast, theme toggle (dark only), mobile-optimized layout, downloads,
ebook reader, stats, series browsing. See `docs/scope.md` for the full list.

## Tech Stack at a Glance

React 19 + TypeScript - Vite - Tailwind v4 - shadcn/ui - TanStack Query v5 - Zustand -
React Router v7 - socket.io-client - native `fetch` - nginx + Docker - Lucide React.
