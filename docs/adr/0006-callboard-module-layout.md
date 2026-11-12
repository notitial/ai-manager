# 6. Callboard's module layout: one hooks module, split into files by area

**Status:** proposed
**Date:** 2026-11-12

Scope: how the callboard mod's code is divided into files (`tools/callboard/mod/hooks/`). It changes no behaviour and no
trust rule of [ADR 0002](0002-callboard.md) or [ADR 0004](0004-prompt-answering.md).

## Context

`register.ts` held every engine call of the mod in one file of about 8,000 lines. A reviewer of a trust rule (a grant
check, a stop, the answering hook) had to find its pieces across the whole file, and a change anywhere meant reading
around everything. `core.ts` (pure logic) and `prompts.ts` (pure logic and the floor) already follow a rule worth
keeping: a file is pure or it takes `$`, never both.

What the mod validator (`claude plugin validate`, engine 2.1.322) allows bounds the split. It reads the hooks module's
source to list what the mod hooks and calls:

- It follows `import { fn } from './x.ts'` into a function declaration called with `$`, across two hops and across an
  import cycle, and a hook registered by reference (`on('turn.start', turnStart)`).
- It refuses `import * as x` of a file that takes `$` ("`$` itself is passed as an argument"), an exported const arrow
  called with `$` ("past an import `$` is followed only into a function declaration"), a `$.state` key declared in one
  file and used in another, and an exported function that touches `$.state` but that no hook reaches.
- `hooks.json` keeps one module: module memory has to be shared, and the engine takes one `prompt.compose` hook per
  module.

## Options Considered

- **Leave it as one file.** No risk, and no gain in reviewability.
- **Several hooks modules.** Refused: module memory would not be shared, and there is one `prompt.compose` hook per
  module.
- **Namespace imports of the engine files** (`import * as lanes`). Refused by the validator.
- **A fine split, about 25 files** (one per concern: process calls, logging, locks, one file per grant level). More
  files than a reviewer can hold; the extra boundaries cut across the trust rules.
- **About ten files by area, one hooks module** (chosen).

## Decision

`register.ts` only wires: what is registered, in order. Every hook body is a named, exported function declaration in the
file of its area, registered by reference (a loop variable such as the stop verb is passed by a one-line arrow in
`register.ts`). The rest, one area to a file:

| File | Owns |
|---|---|
| `mem.ts` | the module state (the former module-level `let`s as properties of `mem`) and the per-session maps and sets; imports no engine file |
| `engine/base.ts` | process calls, log, dialogs and toasts, private-file reads, the one sender of the mod's own fixed turns |
| `engine/store.ts` | the lane store, registry rows, lock folders, cue, result and brief files |
| `engine/grants.ts` | lead, manager and conductor grants, check-ins, presence, config, reserved names, briefings |
| `engine/lanes.ts` | lane binding, birth, rebind, cue handling, the stops, the lane tools |
| `engine/compaction.ts` | `request_compact`, nudges, the keepalive ping, orders, turn marks |
| `engine/tick.ts` | the tick, its timer and steps, session start |
| `engine/commands.ts` | the `/callboard` command handler and the commands under it |
| `engine/answer-hook.ts`, `engine/answer-tiers.ts` | the prompt-answering hook, and the tiers, tier tools and notices |

Rules for the files:

1. A file is pure (`core.ts`, `prompts.ts`) or takes `$` (`engine/`), never both. Each file opens with a header naming
   what it owns and which trust rules it holds.
2. Every function that takes `$` and is used outside its file is an exported `function` declaration, imported by name;
   engine files are never imported as namespaces.
3. Module state lives only in `mem.ts`, which imports no engine file. Every other file holds declarations only, so an
   import cycle between engine files cannot reach a constant that is not yet initialised.
4. Each `$.state` key constant is declared again in each file that uses it (the validator reads a key where it is used).
5. Every import inside the mod uses a `.ts` specifier, so node's type stripping and the engine load the same files.

The split moved code only. The proof is in the pull request that made it: a script that extracts every function and
constant by name before and after and fails on any difference beyond the five form changes above, plus a check that the
validator's lists (hooks, calls, env and state reads and writes) are equal before and after.

## Consequences

- A reviewer reads one file per trust rule, and a change touches the file of its area.
- The validator's "via" names now point at files, which makes its output a map of which area calls what.
- The rules cost something: no exported const arrow takes `$`, no engine namespace import, and a key constant is
  repeated per file. A new `$.state` key means declaring it in each file that reads or writes it.
- Import cycles between engine files exist (lanes, grants, compaction and tick call each other). They are safe because
  of rule 3; a constant computed at load from another engine file's value would not be.
- `core.ts` and `prompts.ts` are unchanged. Splitting them, and sharing helpers across the grant levels, are separate
  decisions.
