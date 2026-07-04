# Phase 3: migration playbooks

> The concrete flows, one per real-world scenario. Each playbook states: what
> the user does, what the product does, which pieces exist today vs. get
> built, and the sharp edges discovered in source. Playbooks M1-M3 and M5 are
> Phase 3 (restore/move); M4 depends on the Phase 4 merge engine.

Shared foundations these rely on: Phase 1 backups, the Phase 2 `.hsarchive`,
and two facts from `data-inventory.md`: ABS restore preserves user ids from
the backup, and HS rows are `(server_id, user_id)`-keyed - so restoring the
*pair* keeps everything consistent, while mixing halves from different
moments/installs is what needs tooling.

---

## M1 - Disaster restore, same deployment shape

**"My AIO's host died; I have backups / an archive."**

1. Stand up a fresh AIO container with empty volumes; point `abs-audiobooks`
   at the (restored or surviving) audio files.
2. Onboarding wizard -> **Restore from backup** (new path, built in this
   phase) -> upload the `.hsarchive` -> `replace` mode.
3. Behind the scenes: wizard runs ABS `/init` with a throwaway root, uploads
   + applies the ABS half, restores the HS half, then reconciles (below).
4. Admin logs in with credentials **from the backup** (the throwaway root is
   gone - ABS restore replaced the users table).

**Sharp edge (must build): service-account reconciliation.** The AIO's
`provisioning` row (service root username/password) and `service_accounts`
ids refer to users that the ABS restore just replaced. After any ABS
restore/import, HS runs a reconcile step: verify the recorded service
accounts exist in ABS; if not, prompt the admin (now logged in with
backup-era credentials) to let HS re-provision its service root and re-mint
keys. Without this, QuestGiver/RMAB service paths break silently post-restore.

**Hosted**: the restored `hosted_config.server_secret` re-attaches the box to
its control-plane record automatically. If the secret was lost (bare-ABS-only
restore), use the existing `POST /servers/:id/reset-secret` hatch.

**Audio files**: not in any backup. The playbook doc says this first, in bold.

---

## M2 - Fresh AIO from an existing ABS backup (UC2)

**"ABS crashed / new system; first-time HS AIO setup; I have my ABS backup."**

Identical to M1 except the input is a bare ABS backup zip (no HS half):

1. Wizard -> Restore from backup -> upload `.audiobookshelf` zip.
2. Wizard `/init`s a throwaway root, `POST /api/backups/upload`, apply.
3. HS side starts fresh: new `server_id`, empty HS tables. The wizard states
   this: "Your library, users, and progress are restored. HearthShelf
   features (clubs, notes, settings sync) start fresh."
4. Service-account reconcile (as M1), then the wizard's normal steps
   (community defaults, backups-on card from Phase 1) continue.
5. Optional finishing move: Send invites to the restored users (the existing
   hosted invite flow; self-hosted gets the password-reset flow from the
   user-management work) so everyone can reach the new box.

Today this scenario is *possible* by hand-driving ABS endpoints but the
onboarding wizard fights it (assumes a fresh `/init`). The build here is the
wizard path + reconcile step.

---

## M3 - Thin -> AIO swap (UC3)

**"HS Thin runs beside my ABS; I want the AIO."** Two variants:

**M3a - keep the external ABS** (AIO fronts it instead of the bundled one):
mostly configuration, but note the AIO image always starts its bundled ABS
today - variant support (`ABS_SERVER_URL` external + bundled ABS disabled) is
a small build item, or we simply document M3b as the recommended path.

**M3b - adopt into the bundled ABS** (recommended; the ABS install moves
in-container):

1. Take an ABS backup on the existing ABS; take/download an HS backup from
   Thin (Phase 1 gives Thin this button; or archive the `hearthshelf-data`
   volume by hand pre-Phase-1).
2. Stand up the AIO. Attach the **same audio volume/path**.
3. Wizard -> Restore from backup: ABS half from step 1, HS half from step 1.
   Because both came from the same live pair, all `(server_id, user_id)` keys
   and item references line up. `connections.abs_url` rows are stale - the
   restore's reconcile step rewrites them to the new origin (small build
   item, flagged in the implementation plan).
4. Path check: if audio files mount at a different path than the old ABS used,
   ABS's library folders must be updated and a rescan matches items **by
   inode** (`LibraryScanner.js:672`) - same filesystem = ids survive; new
   filesystem = inode mismatch and this becomes an M4 import instead. The
   wizard should detect a zero-match rescan and say so rather than let the
   library silently duplicate.

---

## M4 - Merge another server in (UC1)

**"Old ABS and new AIO ran side by side; move everyone over, merge the two
accounts that used both."**

This is the Phase 4 merge engine (`merge-engine.md`). Product shape:

1. Config -> new **Import & Merge** page (registered in the config nav's
   Server group). Source: a live ABS URL + admin credentials, or an uploaded
   archive/ABS backup (`import` mode).
2. Engine produces a **dry-run report**: users matched (by email, then
   username, then manual), items matched (inode -> ASIN -> ISBN -> normalized
   title+author), and per-user row counts to import - with an explicit
   unmatched list.
3. Admin resolves ambiguities in the UI (this includes the "merge me + my
   friend's two accounts" case: map old-server user A onto existing user B).
4. Execute: per-user writes via minted ABS keys, HS-domain merges per
   registry policy, final report. Idempotent - re-running skips or
   LWW-refuses what's already applied.
5. Finish with invites to newly created users (passwords cannot migrate over
   the API - `POST /api/users` cannot set `pash`; see `merge-engine.md` for
   the offline alternative).

---

## M5 - Exit to plain ABS (UC4)

**"I want my data so I can go back to ABS."** Mostly a documentation promise,
kept by architecture:

- ABS is already the source of truth for the library, users, progress,
  sessions, and bookmarks - **on an AIO, the `abs-config` / `abs-metadata` /
  `abs-audiobooks` volumes ARE a stock ABS install.** Point the official ABS
  image at those volumes and it boots; or restore the ABS half of any
  archive onto a stock install. Nothing HS does locks the user in.
- What exits with you beyond ABS: the per-user export (Phase 5,
  `user-export.json` - finished-book history incl. Goodreads/Hardcover
  imports, notes, settings) and the full HS backup (admin, JSON-accessible
  sqlite) for anything else.
- Deliverable: a public "Leaving HearthShelf" doc page walking both routes,
  plus the export button. Trust feature - it costs little and defuses the
  "data hostage" fear that keeps people from adopting an AIO.

---

## M6 - Hosted re-pair / box replacement (operational appendix)

Covered by existing control-plane hatches (`reset-secret`, `public-url`,
`deregister`) - referenced here so operators find them in one place. A
restored box with its HS backup needs nothing; a rebuilt box without one
re-pairs and users' links/invites survive on the control plane.
