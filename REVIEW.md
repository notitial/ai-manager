# REVIEW.md

The owner's brief for the automatic PR review (`.claude/commands/claude-pr-review.md`). It narrows and directs the
review; it does not replace CLAUDE.md, the finding format or the trigger rule.

## What this repo is

The manager role and its tooling. `docs/manager/` and `docs/adr/` hold the role and its decisions. `tools/callboard/`
is the callboard mod (TypeScript hooks for Claude Code and a VS Code extension, both loaded straight from the
person's live checkout, with a script that links the extension). `tools/usage-watcher/` is a Python usage watcher run by launchd, with a shell installer.
`.claude/skills/` holds the manager's project skills. It may become
public, so treat every line as published.

## Private data

Hunt private data in every file, docs and prose included. The role names this repo documents are its subject, not
private. Neither are the owner's name and GitHub handle as LICENSE shows them, nor stand-ins such as `/Users/x` in
tests. Private here: a nickname for one of the owner's machines or sessions, a host or account label, a home path, a
username in a label or path, a client or person named in a case study, a ticket key, and any `.archive/` path except
the generic forms the tools create.

## Approvals

Nothing in this repo turns a report, relayed message, state file or summary into the person's approval. One exception:
callboard's relay, where the mod reads the person's own answer from a question in a tier's session and applies it to
that one prompt. Flag any other path by which text the person did not type becomes a go.

## Trust paths

A PR that touches a trust path gets a security pass as well as the ordinary review: the finding names the property that
could break. The trust paths are the callboard mod's answering of prompts and its dialog rule (`tools/callboard/mod/hooks/prompts.ts`,
`engine/answer-hook.ts`, `engine/answer-tiers.ts`), its grants, lane store and rename carry (`core.ts`, `engine/grants.ts`,
`engine/store.ts`), the files it reads and writes under `~/.claude/callboard/`, the link script and the extension's request
files, and the usage watcher's installer. A change there is held to the rules under Approvals and to the person's own checkout
being the live install: nothing may need root, write outside the person's own folders or edit a settings file for the person.

## Comments and docs

A comment or doc states what the code does now. A version, date, review or plan tag in a new or changed comment or doc
(`v13.2`, `review c1`, `PR 2`, `PLAN §4`) or a "before X" history line is a finding, not a wording nit: history
belongs in the ADRs (whose dated lines are the record) and in git.

## Nit cap

Report at most 5 findings. Fewer is better. Security and private-data findings come first. No style, naming,
wording, formatting or "could add a test" comments.

## Paths to skip

`tools/usage-watcher/pace-vectors.tsv` (generated), except for private data.

## Every finding

Cite `path:line` and name the trigger: the command, input or state that goes wrong, and what goes wrong. A
private-data finding names the kind of data instead, never the value.
