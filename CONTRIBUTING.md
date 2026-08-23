# Contributing to HearthShelf

Thanks for your interest in HearthShelf. This document covers how to contribute
and the legal terms that apply to contributions.

## License of the project

HearthShelf is licensed under the **GNU Affero General Public License v3.0**
(AGPLv3). By contributing, you agree that your contributions are licensed under
the same license. See [LICENSE.md](LICENSE.md).

## Developer Certificate of Origin (DCO)

To keep the project's provenance clean - and to keep the door open for
HearthShelf to be offered as a hosted service or under an additional license in
the future - every contribution must be signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).

The DCO is a lightweight statement that you wrote the patch or otherwise have
the right to submit it under the project's license. Its full text:

```
Developer Certificate of Origin
Version 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### How to sign off

Add a `Signed-off-by` line to each commit message, using your real name and a
real email address:

```
Signed-off-by: Jane Developer <jane@example.com>
```

Git can add this automatically with the `-s` flag:

```bash
git commit -s -m "improved: faster shelf rendering"
```

Pull requests whose commits are not signed off cannot be merged.

## What you're agreeing to

By signing off, you affirm the DCO above. You retain copyright in your
contribution; you grant it to the project under the AGPLv3, and you confirm you
have the right to do so. You also acknowledge that the maintainer may, in
addition to the AGPLv3, distribute the project (including your contribution)
under other license terms - for example as part of a hosted service. If you
cannot agree to that, do not submit a contribution.

## Commit message format

Commit summaries are user-facing via an automated changelog. Use plain language
and one of these prefixes:

- `new:` - a genuinely new feature
- `improved:` - an enhancement or refactor of existing behavior
- `fixes:` - a bug fix

**The subject line IS the changelog entry.** An automated changelog walks
`git log` between release tags, strips the prefix, and publishes the rest
verbatim to end users. Nobody rewrites it later.

**Who reads it:** someone with no idea this codebase exists and no interest in
it - a middle schooler, or a math teacher who does not care how any of it works.
They want one thing: **what bug, feature, or annoyance just got fixed or
improved?** They are not impressed by the hard part. They do not know what a
component is. They will never read the body.

So the question before committing is never "does this describe the change?" It
is **"would that person know what changed for them?"** Write it in everyday
words - what they can now do, or what stopped going wrong. Every technical
detail (component names, APIs, file paths, the how) goes in the body.

**Never put these in a subject line:** component or class names
(`InlineComposer`, `AuraContainer`), API or function names, file paths, internal
jargon ("rehydration", "debounce", "memoize", "state driver", "keyboard-aware"),
adjective piles that describe the code instead of the effect, or the names of
other apps and addons.

**Rewrites - the left column is what NOT to write:**

| Don't | Do |
| --- | --- |
| `new: Keyboard-aware inline club composer rises above keyboard` | `new: The keyboard no longer covers the box you type in` |
| `fixes: Debounce progress sync to avoid race on cold reload` | `fixes: Stop losing your place when the app restarts` |
| `improved: Refactor AuraContainer to use declarative filters` | `improved: Buff icons update faster and use less memory` |
| `new: Add RatingPromptActions component to notification tray` | `new: Rate a book right after you finish it` |
| `fixes: Null-guard getBookByMediaId in absdb resolver` | `fixes: Books missing from your library no longer break the page` |

Two tests. Read the subject to someone who does not code: if they ask "what does
that mean?", it is not ready. And if it names something they have never seen on
their own screen, it is not ready.

## Scope and positioning

HearthShelf is a UI layer over a server the user runs, plus a small backend for
HearthShelf-specific state. Contributions must respect the project's
positioning:

- HearthShelf does not host, source, or distribute content.
- Any integration that talks to an external service (downloaders, request
  backends, AI providers, etc.) must be **opt-in and unconfigured by default**,
  and **source-agnostic** - the user supplies and is responsible for the
  backend.
- No code, comment, commit message, or user-facing text may describe, imply, or
  encourage obtaining content the user is not entitled to. No "free books,"
  no piracy framing, no links to infringing sources.

See [AGENTS.md](AGENTS.md) for the full guardrails.
