# Admin Surface Unification — Pattern & POC

Status: **POC landed** (ConfigLogs unified end-to-end). Template for the full effort.

## The problem

The self-hosted SPA (`HearthShelf/src`) and the hosted WebApp
(`HearthShelf-WebApp/src`) each carry a full copy of the `src/pages/config/*`
admin surface. They have **fully drifted**: of ~19 shared config pages, **zero
were byte-identical** before this work. Fixes and features land in one and not
the other (e.g. the WebApp's Logs page was missing the HearthShelf app-log ring
entirely; the credential-health work had to be written twice).

## Why they drifted — the one real difference

The pages are ~the same JSX. They diverged for a **single structural reason: how
they reach a server.**

| | self-hosted SPA | hosted WebApp |
|---|---|---|
| servers | exactly one, same-origin | many linked servers |
| client | `absRequest(path)` | `absGet(target, path)` |
| token | `useAuthStore` | per-server `getAbsToken(serverId)` |
| ambient server | implicit (this origin) | `useActiveServer()` → `AbsTarget` |
| query keys | `['admin','logs']` | `adminSectionKeys.logs(serverId)` |

Everything else in a page — layout, formatting, download logic, modals — is
incidental duplication.

## The seam: `useAdminDataSource()`

Erase the one difference and the pages become shareable. Each app provides an
`AdminDataSourceProvider` that yields an identical hook:

```ts
interface AdminDataSource {
  target: { serverId: string; serverUrl: string } | null
  isMultiServer: boolean
  request: <T>(path: string, init?: RequestInit) => Promise<T>
}
```

- **Self-hosted** (`src/admin/adminDataSource.tsx`): a fixed same-origin target,
  `request` bound to `absRequest`.
- **Hosted** (`HearthShelf-WebApp/src/admin/adminDataSource.tsx`): target from
  `useActiveServer()`, `request` dispatched to `absGet/absPost/absPatch/absDelete`
  by method.

A page imports **only the hook**. Its body no longer knows whether it's single-
or multi-server. `isMultiServer` is there for the rare page that must render a
server switcher.

## What the POC did (ConfigLogs)

1. Moved the log types to `@hearthshelf/core` (`ABSLogEntry`, `ABSLoggerData`,
   `HSAppLogResponse`) — pure types belong in core, shared by both apps + the
   Node server + mobile.
2. Added `AdminDataSourceProvider` to each app and mounted it in `ConfigShell`.
3. Rewrote `ConfigLogs.tsx` to fetch via `useAdminDataSource().request`. The file
   is now **byte-identical in both repos** (verified by diff). As a bonus the
   WebApp gained the HearthShelf app-log ring it was missing.
4. Deleted the per-app log clients (`getLoggerData`/`getHearthShelfLogs`,
   `getLogs`); re-exported `ABSLogEntry` from core for any stragglers.

Both apps typecheck and build clean; the provider mounts with no runtime error.

## Where shared UI can and cannot live

- **`@hearthshelf/core` is React-free by contract** (it's also imported by the
  no-bundler Node server and by mobile). **Do not** put components/hooks there —
  only types and pure logic. Log *types* went to core; the *page* did not.
- **Shared components/pages** need a React-capable home. Options, in order of
  preference for the full effort:
  1. **A new `@hearthshelf/admin-ui` package** (React peer dep), consumed via the
     same submodule/alias mechanism as core. Hosts the single copy of each unified
     page + the shared `AdminDataSource` contract. This is the end state.
  2. **One repo owns the pages, the other aliases them.** WebApp is AGPL now, so
     it may import HS UI directly. Lighter than a package, but couples build dirs.
  3. **Prop-injected components** (e.g. `components/hosted/ServiceAccountHealth.tsx`,
     already byte-identical in both) — no shared package, each repo keeps a copy
     whose body is portable. Fine for a component or two; doesn't scale to 19 pages.

The POC uses (3)'s "identical copy" form because it needs zero new infra. The
provider seam is what makes (1) mechanical when you set the package up.

## Rollout plan for the full effort

1. **Stand up `@hearthshelf/admin-ui`** (or pick option 2). Move
   `AdminDataSource` there as the canonical contract; keep the two providers in
   their apps (they're the only per-app glue).
2. **Migrate pages easiest-first.** Order by how little app-specific data they
   touch: `ConfigLogs` (done) → `ConfigSessions` → `ConfigApiKeys` →
   `ConfigServiceAccounts` → `ConfigBackups` → … → `ConfigHosted`/`ConfigUsers`
   last (most divergent).
3. **Per page:** move shared types to core, rewrite fetches to
   `useAdminDataSource().request`, collapse the two copies into one in the shared
   home, delete the per-app clients. Verify: both typecheck + build, and diff the
   old vs new render.
4. **Query keys:** standardize on a `serverId`-scoped key factory in the shared
   home so multi-server cache isolation works in the WebApp and is a harmless
   constant (`'local'`) in the self-hosted app.
5. **Track coverage:** keep a checklist of pages migrated; the goal is the
   `src/pages/config/*` diff between the two repos shrinking to zero.

## Files (POC)

- `src/admin/adminDataSource.tsx` (both repos) — the seam.
- `src/pages/config/ConfigLogs.tsx` (both repos, identical) — first unified page.
- `src/pages/config/ConfigShell.tsx` (both repos) — provider mounted.
- `@hearthshelf/core` `src/types/abs.ts` — shared log types.
