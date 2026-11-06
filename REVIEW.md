# REVIEW.md

The owner's brief for the automatic PR review (`.claude/commands/claude-pr-review.md`). It narrows and directs the
review; it does not replace CLAUDE.md, the finding format or the trigger rule.

## What this repo is

The manager role and its tooling. `docs/manager/` and `docs/adr/` hold the role and its decisions. `tools/callboard/`
is the callboard mod (TypeScript hooks for Claude Code and a VS Code extension, both loaded straight from the
person's live checkout, with a script that links the extension). `tools/usage-watcher/` is a Python usage watcher run by launchd, with a shell installer.
`tools/session-peers/` is a shell session lister. `.claude/skills/` holds the manager's project skills. It may become
public, so treat every line as published.

## Private data

Hunt private data in every file, docs and prose included. The role names this repo documents are its subject, not
private. Neither are the owner's name and GitHub handle as LICENSE shows them, nor stand-ins such as `/Users/x` in
tests. Private here: a nickname for one of the owner's machines or sessions, a host or account label, a home path, a
username in a label or path, a client or person named in a case study, a ticket key, and any `.archive/` path except
the generic forms the tools create.

## Nit cap

Report at most 5 findings. Fewer is better. Security and private-data findings come first. No style, naming,
wording, formatting or "could add a test" comments.

## Paths to skip

`tools/usage-watcher/pace-vectors.tsv` (generated), except for private data.

## Every finding

Cite `path:line` and name the trigger: the command, input or state that goes wrong, and what goes wrong. A
private-data finding names the kind of data instead, never the value.
