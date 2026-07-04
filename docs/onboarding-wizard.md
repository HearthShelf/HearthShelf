# Onboarding Wizard — UX Spec

> A handoff document for mocking up and revising the first-run setup wizard.
> Describes every screen, state, and branch in the current implementation so the
> flows can be redesigned end to end.
>
> Source of truth: `src/pages/OnboardingPage.tsx`,
> `src/components/layout/ProtectedLayout.tsx`, `src/api/runtime.ts`,
> `src/api/hosted.ts`, `server/routes/runtime.js`.

## What the wizard is

The onboarding wizard is the setup screen a **fresh HearthShelf install** lands
on the first time an admin signs in. It is a single page (`/onboarding`) rendered
inside a centered card, with the HearthShelf wordmark at the top. There is no
multi-step progress bar today — the "steps" are conditional states of one card.

Its job is to get a new self-hosted box from "just installed" to "ready to use,"
and to offer the optional step of connecting the box to **app.hearthshelf.com**
(the hosted control plane) so the library is reachable from anywhere and people
can be invited by email.

## Deployment modes (why there are two flows)

HearthShelf ships in three deployment modes. The wizard only ever serves two of
them; the third never reaches it.

| Mode | What it is | Onboarding flow |
| --- | --- | --- |
| **`aio`** (all-in-one) | HearthShelf bundles and provisions its own AudiobookShelf (ABS) server. The user installed one container and has no existing ABS. | **Flow A** below |
| **`slim`** | The admin already runs their own ABS and points HearthShelf at it. | **Flow B** below |
| **`hosted`** | Managed by the control plane (app.hearthshelf.com). | **Never sees the wizard** — onboarding is handled upstream. |

The two flows differ in two meaningful ways:

1. **Credentials.** In `aio`, HearthShelf generated the ABS admin (root) account
   itself, so the wizard reveals those credentials and signs the admin in
   automatically. In `slim`, the admin already has their own ABS login, so they
   sign in normally first.
2. **The "Connect to app.hearthshelf.com" default.** In `aio` the connect option
   is **checked by default** (opt-out, "Recommended"). In `slim` it is
   **unchecked by default** (opt-in, "Optional").

## How a user reaches the wizard

Routing into onboarding is decided in `ProtectedLayout.tsx`, on every protected
route:

- The user must be **authenticated**. If not → redirected to `/login`.
- The instance must be **`slim` or `aio`** and **not yet onboarded**
  (`runtime.onboarded === false`).
- The signed-in user must be an **admin or root**. Non-admins never see the
  wizard — they just use the app, because they can't run setup.

When all of those hold, the user is redirected to `/onboarding`. Once onboarding
is marked complete (`markOnboarded()` writes the flag server-side), this redirect
stops firing and the box routes normally.

> **Design note for mockups:** the wizard is gated to admins only. A regular
> invited user on a brand-new box will never see these screens. Mockups should
> assume the viewer is the server owner / admin.

---

## Flow A — All-in-one (`aio`)

The most frictionless path. HearthShelf already stood up the bundled ABS server
during container startup and generated a root admin account.

### A0. Loading (transient)

While runtime config loads and the connect-default is being resolved, the card
shows a centered **"Loading…"** state. Brief; not a real step, but it exists and
should be designed (or at least acknowledged) so there's no flash of empty card.

### A1. Auto-reveal + auto-sign-in (happens before the screen settles)

On an `aio` box, before showing the main screen, the wizard silently:

1. Calls the backend **once** to reveal the auto-generated root credentials
   (`username` + `password`). This endpoint **self-clears after the first read**,
   so the credentials can only ever be shown one time.
2. Signs the admin in with those credentials automatically.

The admin does not type anything to get in. If the auto-sign-in fails, the
credentials are still shown on screen so the admin can use the normal login form
manually (graceful degradation — worth a mockup variant).

### A2. "Your library is ready" — the main AIO screen

This is the primary screen for Flow A. Card contents, top to bottom:

- **Title:** "Your library is ready"
- **Credentials panel** (bordered, muted background):
  - Explanatory line: "We set up your audiobook server and signed you in. Save
    these admin credentials, then change the password in Settings."
  - Monospace block:
    - `user: <generated username>`
    - `pass: <generated password>`
  - *Design opportunity:* there is no copy-to-clipboard affordance today, no
    "I've saved these" confirmation, and no password reveal/hide. The credentials
    are shown in plaintext. This is the highest-value area to improve — a user
    who navigates away loses these forever.
- **"Connect to app.hearthshelf.com" checkbox** (bordered row):
  - **Checked by default** in AIO.
  - Label: "Connect to app.hearthshelf.com"
  - Sub-label: "Reach your library from anywhere and invite people by email.
    **Recommended.** You can change this later."
- **Error text** (only if a setup step failed): red, inline, role=alert.
- **Primary button** (full width):
  - If connect is checked → "Connect and continue"
  - If connect is unchecked → "Continue to HearthShelf"
  - While working → "Setting up…" (disabled)

### A3a. Branch: connect ON → "Almost there" (pairing code)

If the admin leaves connect checked and presses the button, the backend starts
pairing with the control plane and returns a short **pairing code**. The card
switches to:

- **Title:** "Almost there"
- Body: "Finish connecting on app.hearthshelf.com by entering this pairing code.
  It expires shortly."
- **Pairing code panel:** large, monospace, wide letter-spacing, centered (e.g.
  a 6-ish character code). This is the visual focal point.
- **Primary button:** "Open app.hearthshelf.com" — opens
  `…/pair?code=<code>` in a new tab so the admin can redeem it.
- **Secondary button (outline):** "Continue to HearthShelf" — proceeds into the
  app without waiting for the redemption to complete.

> Pairing is *finished* on app.hearthshelf.com, not here. The box marks itself
> onboarded regardless, so it stops routing back to the wizard. The code
> **expires shortly** — the time pressure is real and currently only conveyed by
> the word "shortly." A countdown / expiry timestamp is a candidate improvement.

### A3b. Branch: connect OFF → straight into the app

If the admin unchecks connect and presses "Continue to HearthShelf," the wizard
marks onboarding complete and navigates to the home route (`/`). No pairing code
screen. Local-only install.

---

## Flow B — Slim (`slim`)

The admin already runs their own ABS. HearthShelf does not own their credentials
and does not assume they want the hosted control plane.

### B0. Sign in first (redirect out and back)

On a `slim` box, if the admin is **not yet authenticated**, the wizard
immediately redirects to **`/login`** (the normal ABS login). They sign in with
their existing ABS admin account, then return to `/onboarding` authenticated.

> For mockups: Flow B's "first step" is effectively the standard login screen,
> which lives outside this page. The wizard proper starts *after* login.

### B1. "Connect HearthShelf" — the main slim screen

Once signed in as an admin, the card shows:

- **Title:** "Connect HearthShelf"
- **No credentials panel** (the admin owns their own ABS login — nothing to
  reveal).
- **"Connect to app.hearthshelf.com" checkbox** (bordered row):
  - **Unchecked by default** in slim.
  - Label: "Connect to app.hearthshelf.com"
  - Sub-label: "Reach your library from anywhere and invite people by email.
    **Optional.** You can change this later."
- **Error text** (if a step failed).
- **Primary button** (full width): same label logic as AIO —
  "Connect and continue" vs. "Continue to HearthShelf," "Setting up…" while busy.

> The connect checkbox only renders for admins (`isAio || isAdmin`). A non-admin
> who somehow lands here would see just the title and button — but per the
> routing rules above, non-admins are never routed here.

### B2a. Branch: connect ON → "Almost there" (pairing code)

Identical to **A3a**. If the admin opts in to the control plane, they get the
same pairing-code screen ("Almost there," code panel, "Open app.hearthshelf.com"
+ "Continue to HearthShelf").

### B2b. Branch: connect OFF → straight into the app

Identical to **A3b**. Marks onboarding complete and navigates to `/`. This is the
**default** path for slim, since connect is off by default.

---

## State map (for both flows)

```
                         ┌─────────────┐
                         │  /onboarding │
                         └──────┬───────┘
                                │
              ┌─────────────────┴──────────────────┐
              │ mode = aio                          │ mode = slim
              ▼                                     ▼
   ┌─────────────────────┐               not authed │ authed
   │ A0 Loading…         │                  ┌───────┴────────┐
   │ A1 reveal+autosignin│                  ▼                ▼
   └──────────┬──────────┘             redirect /login   B1 "Connect
              ▼                         (sign in,         HearthShelf"
   ┌─────────────────────┐              return here)      [connect OFF
   │ A2 "Your library     │                                default]
   │     is ready"        │                                   │
   │ [connect ON default] │                                   │
   └──────────┬──────────┘                                   │
              │                                                │
      ┌───────┴────────┐                              ┌───────┴────────┐
   connect ON      connect OFF                     connect ON      connect OFF
      ▼                ▼                               ▼                ▼
 "Almost there"   navigate /                    "Almost there"    navigate /
 (pairing code)   (into app)                    (pairing code)    (into app)
      │                                               │
   "Open app.hs.com" / "Continue to HearthShelf"   (same)
```

## Screen inventory (what to mock up)

| # | Screen / state | Flow | Notes |
| --- | --- | --- | --- |
| 1 | Loading… | A (and B momentarily) | Transient; minimal |
| 2 | "Your library is ready" (credentials + connect-on) | A | Primary AIO screen |
| 3 | "Your library is ready" with auto-sign-in **failed** | A | Credentials shown, admin must log in manually |
| 4 | "Connect HearthShelf" (connect-off, no credentials) | B | Primary slim screen |
| 5 | "Almost there" (pairing code) | A + B | Shared; reached when connect is on |
| 6 | Error state (inline red alert in the primary screen) | A + B | "Setup step failed. Please try again." |
| 7 | Standard `/login` (sign in) | B | Lives outside this page but is Flow B's real first step |

## Copy reference (current strings)

- Titles: "Your library is ready" (aio), "Connect HearthShelf" (slim),
  "Almost there" (pairing).
- Credentials blurb: "We set up your audiobook server and signed you in. Save
  these admin credentials, then change the password in Settings."
- Connect label: "Connect to app.hearthshelf.com"
- Connect sub-label: "Reach your library from anywhere and invite people by
  email. Recommended. / Optional. You can change this later."
- Pairing blurb: "Finish connecting on app.hearthshelf.com by entering this
  pairing code. It expires shortly."
- Buttons: "Connect and continue", "Continue to HearthShelf", "Setting up…",
  "Open app.hearthshelf.com".
- Error: "Setup step failed. Please try again."

## Known gaps / opportunities for the redesign

These are not in scope to fix here, but they're the obvious places a UX pass
adds value:

- **No copy / save affordance for the AIO credentials**, and no "I saved these"
  gate before the admin can move on. They are shown once, in plaintext, and lost
  if the page is left.
- **No real step indicator.** Everything is one card swapping contents. A wizard
  with explicit steps/progress may read better, especially for the
  connect → pair → redeem journey that spans two products (the box and
  app.hearthshelf.com).
- **Pairing-code expiry is only words** ("shortly"). No countdown or copy button
  on the code.
- **Auto-sign-in failure** falls back silently to "use the login form" but the
  screen doesn't explicitly say so — the admin sees credentials and a connect
  box with no clear "you're not actually signed in" signal.
- **Connect step is all-or-nothing here.** Inviting people by email
  (`inviteFromServer`) exists in the API but isn't surfaced in the wizard; it
  happens later. A redesign could fold a first-invite into onboarding.
- **No mobile-specific layout** — the card is `max-w-md` centered; fine on
  desktop, untested as a deliberate mobile flow.
