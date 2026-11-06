# 3. Callboard loads from a live checkout, not a root-owned copy

**Status:** accepted
**Date:** 2026-11-06

Scope: how callboard's mod and panels extension get onto a Mac, where agents edit this repo, and the root-owned
`lanes.json`. It supersedes those parts of ADR 0002 (Decision, Install; the root lane list). Everything else in
ADR 0002 stands. ai-toolkit makes the same move for its own tools in its own repo.

## Context

ADR 0002 installed callboard as a root-owned copy. `install.sh` fetched a pinned commit of `main`, checked it against
`SHA256SUMS` and a hash from a PR description, and copied the mod into `/usr/local/libexec/callboard` with sudo. It
also copied the extension into `~/.vscode/extensions`. The copy guarded against two things. First, an agent editing
the live mod from its own shell. Second, a branch or half-done edit going live.

In practice every update cost a sudo run and three values copied from a PR description. A squash merge changes the
commit hash, which made the pinned `--ref` awkward. The person judged that a clear permission list is enough
protection for normal use, and that the second guard can come from where agents work rather than from copying.

## Options Considered

- **Keep the root-owned copy** (ADR 0002). It is the strongest against a hijacked agent's shell, and it costs sudo
  and pinned hashes on every update.
- **Load straight from the checkout agents work in.** It's cheap, but every branch switch and half-done edit goes
  live in every session at once.
- **Load from a live checkout that agents never edit** (chosen). One clone stays on `main` and moves only with
  `git pull --ff-only` after a merge. Agents edit in their own clones under `/tmp`.

For the root `lanes.json`, which only `install.sh --lanes` could write:

- **Keep it as an optional root file.** That leaves an undocumented uid-0 trust path and its tests, and nothing
  would use it.
- **Move it to a user path.** A same-user file that wins over the store is weaker than no file at all.
- **Drop it** (chosen). Lead-made and joined lanes in the store already cover every use.

## Decision

- **The live checkout is the install.** `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` names
  `<live checkout>/tools/callboard/mod`. `tools/callboard/link-extension.sh` makes
  `~/.vscode/extensions/notitial.callboard-panels-<version>` a link to `<live checkout>/tools/callboard/extension`,
  with the version read from `package.json`. A merge plus a pull is an update. A VS Code window reload, or a new
  session, picks it up.
- **Agents edit only in `/tmp` clones** (CLAUDE.md, Where agents edit). They never edit tracked files in the live
  checkout or switch its branch. `.archive/` stays in the live checkout.
- **Retired:** `install.sh`, its tests, `sums.sh` and `SHA256SUMS`, the `claude-callboard` terminal wrapper (the
  `env` line already covers terminal sessions), and `/usr/local/libexec/callboard`.
- **No root lanes.** The mod and the extension read lanes only from the store. The uid-0 file check, its parent-chain
  check, its refusal codes and the `root-lane` refusals of `lane_remove` and `lane_park` are gone. Every other
  ownership check, against the person's own uid, stays.
- **Permission rules** come from ai-toolkit's `/setup-claude`. It writes `Edit(//<live checkout>/tools/callboard/**)`
  into `permissions.deny` from the real path. The existing callboard store and list-file denies stay.
- **Deferred:** a guard that keeps the mod off, or warns, when the live checkout is not a clean `main`. The person
  chose to add it once development settles.

## Consequences

- An update needs no sudo, no fetch and no hashes, and it works while the repo is private.
- **Accepted risk.** A shell write to a live checkout file is not an Edit, so no permission rule stops it. Examples
  are `sed -i` on a mod file, or a `git checkout` in the live clone. It takes effect at the next window reload or
  session start. It needs a hijacked agent. ADR 0002's statement that "no agent can edit" the mod's files no longer
  holds.
- A pull of an unread commit goes live, so the person reads the incoming diff before pulling.
- The live checkout must stay on `main`. Nothing enforces that until the deferred guard lands.
- A lane that existed only in a root `lanes.json` has to be made again with `lane_create`.
- `/tmp` is wiped on reboot, so an agent pushes its branch before it stops.
- The extension's version is in its link name. A version bump needs `link-extension.sh --apply` again, which moves
  the link.
