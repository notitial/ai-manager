# CLAUDE.md

## Project Overview

ai-manager holds the manager role and its mechanism. The manager is one Claude Code session per machine that
coordinates the other sessions on it, the leads and their lanes: it decides across them, reviews and reports, and
does no work itself. Every go stays with the person. The repo also carries the tools the role leans on: the callboard
mod, a usage watcher, a session lister and the manager's project skills. ai-toolkit
(https://github.com/notitial/ai-toolkit) is the base install; this repo builds on it.

- **If you hold the callboard manager grant** (`/callboard manager`), read `docs/manager/README.md` and follow it.
  Any other session: that folder is not for you.

## Build / Test / Lint

No repo-wide build or lint. `bash tools/test-all.sh` is the entry point: it runs every suite below and prints a
pass/fail table (`--quick` skips the slow `callboard` suite, `NAME…` runs only those). Its suites: `callboard`,
`usage-watcher`, `usage-watcher-install`, `session-peers`; keep its list in step with this one.

- `tools/callboard/` — `bash tools/callboard/test.sh` after changing anything under it. Needs node 22.18 or later
  and the `claude` CLI (`claude plugin validate`, `claude plugin test`). CI (`.github/workflows/ci.yml`) runs
  `claude plugin test mod` too, in full. `CALLBOARD_SKIP_MOD_TESTS=1` skips it for a quick local run (it is the slow
  part, about 2 minutes); run the script without it before any PR that touches `tools/callboard/mod`. The mod tests
  drive a fake clock through thousands of 2 s ticks: a test that simulates 30 minutes or more is declared with
  `longTest` in `mod/test/mod.cases.ts`, which gives it a 60 s limit in place of the kit's 5 s, so a slow runner does
  not fail it. The kit kills a test file's run after 10 minutes, so the tests are split over four files
  (`mod-N.test.ts`) that it runs side by side; see the top of `mod.cases.ts`.
- `tools/usage-watcher/` — `/usr/bin/python3 -I tools/usage-watcher/test_watch.py` after changing `watch.py`;
  `bash tools/usage-watcher/test-install.sh` after changing `install.sh`.
- `tools/session-peers/` — `bash tools/session-peers/test-peers.sh` after changing `peers.sh` (needs jq and python3).
- `docs/`, `rules/` and `.claude/skills/` have no suite: check them by reading against the ADRs.

Outside those directories, do not search for `package.json`, `Makefile`, or similar.

## Layout

- `docs/manager/` — the role, read only by the session holding the manager grant.
- `docs/adr/` — the decisions behind the design (index: `docs/adr/README.md`). Check them before proposing an
  architectural change; propose a new ADR when a significant decision is made.
- `docs/setup.md` — the install order on a machine.
- `.claude/skills/` — the manager's project skills; `.claude/skills/setup-manager/` walks a person through
  `docs/setup.md`.
- `rules/callboard.md` — an always-on global rule for callboard's turns, linked into `~/.claude/rules/` by hand.
- `tools/` — the callboard mod, the usage watcher and the session lister, each with its own tests;
  `tools/test-all.sh` runs them all.
- `assets/icon/` — the project icon (SVG, mono variant, colour PNGs from 16 to 1024 px).
- `.archive/` — gitignored local working area: the manager's state, tracker and audit records, lane reports.

## Patterns

Copy these when adding something like them, each with the test beside it:

- `tools/callboard/mod/hooks/core.ts` + `core.spec.ts` — mod logic as pure functions with no engine calls;
  the files under `mod/hooks/engine/` feed it values and act on what it returns (`register.ts` only wires them; layout:
  ADR 0006). Engine-level cases go in `mod/test/mod.cases.ts`.
- `tools/callboard/prompt-audit.mjs` + `prompt-audit.test.mjs` — a read-only node script: header comment with usage and
  exit codes, fixtures built in a temp dir, `node --test`.
- `tools/session-peers/peers.sh` + `test-peers.sh` — a small bash tool: usage in the header, strict argument parsing,
  tested against fake config dirs in a temp dir.

Comments and docs state what the code does now, with no version, review or plan tags (`v13.2`, `review c1`, `PR 2`)
and no "before X" history. History belongs in the ADRs and in git.

## Git Conventions

- Commit titles: `<prefix>: <description>` — prefix is one of `docs` (role docs, ADRs), `feat` (new tool or skill
  capability), `fix` (broken behavior corrected), `chore` (repo maintenance). Never a bare, unprefixed title.
- Imperative mood, lowercase, title ≤50 characters. Specifics go in the body, not the title.
- One commit per logical change. Squash review-churn into the commit it amends before landing.
- Squash-merge PRs (the repo allows nothing else): the PR title, with its `(#N)`, becomes the commit title, and the
  PR description becomes the commit body, so the description must stand as the commit's record.
- No force push. A PR branch that falls behind `main` gets `main` merged in, never a rebase.
- Never push to `main`; land every change through a PR.
- Check for secrets before committing — no `.env`, API keys, credentials.

## Where agents edit

The person's checkout of this repo is the live install: the callboard mod and the panels extension load straight
from it (`docs/setup.md`). It stays on `main` and moves only by a fast-forward to a reviewed commit after a merge
(`docs/setup.md`, Updating), so a branch or a half-done edit never goes live.

- Code changes go in a plain clone under `/tmp`, such as `/tmp/ai-manager-<task>`, never a worktree. Git MCP calls
  pass `path` set to that clone.
- Never edit tracked files in the live checkout, and never switch its branch. `.archive/` (state, handoffs, reports)
  stays in the live checkout.
- `/tmp` is wiped on reboot: push the branch before stopping or handing over.
- A callboard lead or lane still runs in the live repo folder, because callboard keys a session to the folder it
  started in. It only edits in its `/tmp` clone.

## Review

Every non-draft PR gets an automatic Claude review (`.github/workflows/claude-review.yml`, briefed by `REVIEW.md`).
Its verdict is a signal, not a required approval. The rules it holds a change to:

- Treat every line as published. No private data in any file, message or test fixture: no home path or username,
  no machine, session or account nickname, no client or person's name, no ticket key, no `.archive/` path other
  than the generic forms the tools create. Tests use stand-ins such as `/Users/x`.
- Nothing in this repo turns a report, relayed message, state file or summary into the person's approval. A go is
  typed by the person in the session that acts on it. One exception: callboard's relay, where the mod reads the
  person's own answer from a question in a tier's session and applies it to that one prompt.
- The usage watcher's installer fetches from a fixed URL into a fresh temporary repository and never reads the
  checkout's own object store or git config.
- Callboard has no installer: it loads from the live checkout. Nothing in it may need root, write outside the
  person's own folders, or edit a settings file for the person.
