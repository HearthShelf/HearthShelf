# CI/CD Setup

HearthShelf ships with GitHub Actions for CI, releases, and Dependabot
auto-merge. The workflow files are in `.github/`, but a few **GitHub settings**
must be enabled once the repo has a remote — they can't be set from files.

## Workflows at a glance

| File | Trigger | Result |
|---|---|---|
| `.github/workflows/ci.yml` | push + PR | Typecheck & build (gate); lint (informational) |
| `.github/workflows/dev-release.yml` | push to `main`/`master` | Pushes `:canary` + `:main-<sha>` to both `ghcr.io/<owner>/hearthshelf` (slim) and `…/hearthshelf-aio` (all-in-one) |
| `.github/workflows/release.yml` | push tag `v1.2.3` | Pushes `:1.2.3 :1.2 :1 :latest` to both `hearthshelf` and `hearthshelf-aio` + GitHub Release with grouped changelog |
| `.github/workflows/dependabot-auto-merge.yml` | Dependabot PR | Merges patch/minor after CI passes; flags majors |
| `.github/dependabot.yml` | weekly (Mon) | Opens update PRs for npm, GitHub Actions, Docker |

## Required GitHub settings (one-time)

After `git remote add origin …` and the first push:

1. **Allow Actions to create/approve PRs and write contents**
   `Settings → Actions → General → Workflow permissions`
   - Select **Read and write permissions**
   - Check **Allow GitHub Actions to create and approve pull requests**
   (needed for `dependabot-auto-merge` to merge PRs)

2. **Allow auto-merge**
   `Settings → General → Pull Requests` → check **Allow auto-merge**

3. **GHCR package visibility** (after the first images are pushed)
   Each package is created private by default. There are now two:
   `hearthshelf` (slim) and `hearthshelf-aio` (all-in-one). To make pulls
   public, for each: `Packages → <package> → Package settings → Change
   visibility → Public` (or keep private and pull with a token).

4. **(Optional) Branch protection on `main`**
   `Settings → Branches → Add rule` for `main`:
   - Require status checks to pass → select **Typecheck & build**
   The auto-merge workflow already waits for CI in-workflow, so this is optional
   defense-in-depth, not required.

5. **(Optional) Dependabot secrets** — none needed; everything uses the built-in
   `GITHUB_TOKEN`.

## Cutting a release

```bash
# Bump version in package.json, commit, then:
git tag v1.0.0
git push origin v1.0.0
```

The `release` workflow builds both images (slim + all-in-one), publishes them
to GHCR, and creates a GitHub Release. The changelog is grouped from commit prefixes
(`new:` → Features, `improved:` → Changes, `fixes:` → Fixes); a prerelease tag
like `v1.0.0-rc1` is marked prerelease and does **not** move `:latest`.

## Dependabot auto-merge behavior

- **Patch + minor** updates: auto-merged (squash) once the **Typecheck & build**
  check succeeds on the PR.
- **Major** updates: a comment is posted and the PR is left for manual review.
- Updates are grouped (dev deps, prod minor/patch, actions) to reduce PR noise.
