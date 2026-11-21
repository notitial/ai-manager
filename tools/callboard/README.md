# callboard

callboard lets one Claude Code session run other sessions: it opens them, prompts them, keeps their cache warm,
asks them to compact, and stops them when their work is signed done. It is a plugin for Claude Code plus a VS Code
extension that opens the panels. This file is a guide for the person who runs it. The decisions and their reasons
are in the ADRs (`docs/adr/`, start with [ADR 0012](../../docs/adr/0012-callboard-plugin.md)); limits, codes and the
exact texts are in the code, and `/callboard help` lists every command. Nothing loads this file into a session.

## Parts

| Path | What |
|---|---|
| `plugin/` | The Claude Code plugin. A pure core in `plugin/hooks/core/` (no I/O, no text), adapters in `plugin/hooks/engine/` that feed it and act on what it returns, the texts table `plugin/hooks/texts.ts` and the one UI module `plugin/hooks/ui.ts` |
| `extension/` | The VS Code extension that opens, reopens and closes lane panels. It has no commands of its own. What it does: [`extension/README.md`](extension/README.md) |
| `link-extension.py` | Links that extension into VS Code from this checkout, once per machine (Install) |
| `patch-claude.py` | Optional: patches the installed Claude Code extension so a lane of any folder of a multi-folder window opens there, widens the composer, shows the composer's context pie always against your autocompact level, puts the session's folder name next to the model name, makes a restored or reopened panel resume in its conversation's folder, adds a command (`callboard active session`) that names the panel in front, and adds a command that files callboard sessions in the sidebar's Manager, Conductor, Lead and Lanes groups, in that order (docs/setup.md; `/patch-vs-claude`). Header comment: usage and exit codes |
| `test.sh` | The test entry point (Tests) |

## The sessions

Every session is managed unless callboard is off for it (`/callboard off`). A session has an id, a folder, a name, a
parent and a capability: none, lead or manager.

- **Lane.** Not a kind: any session with a lead or the manager above it. A lead makes one (`lane_create`, `lane_open`)
  or takes a loose session by name (`lane_adopt`). A lane does its work, writes its report, and signs it done: the
  last line of `<folder>/.archive/<LANE>/REPORT.md` is `status: done <its session id>`, appended, never overwritten.
  Only then can its parent retire it.
- **Lead.** `/callboard lead [PATH…]`, typed by you in the session that coordinates a repo's lanes. It may create and
  adopt lanes in its own folder and the folders you list, and holds the tools that open, prompt, park, retire and list
  its lanes and answer their asks. A lead can also request a go (below).
- **Conductor.** `/callboard conductor [PATH…]`, typed by you: a lead that also makes, starts and closes leads, one per
  repo, in the repos you list (`lane_create` with role `lead`). Type the paths once: callboard saves the list for that
  folder (`v2/conductors.json`), and a later `/callboard conductor` there needs none. A lead it makes acts only in its own
  folder, cannot make leads, and asks the conductor for a go. The conductor and everything under it count 8 live
  children per parent, leads and lanes together. [ADR 0013](../../docs/adr/0013-conductor.md).
- **Lead preset.** A folder may hold `.claude/callboard-lead.json`, `{ "command", "name", "model", "effort" }`, for
  example `{ "command": "sentinel", "name": "SENTINEL", "model": "sonnet", "effort": "high" }`. A session started
  there lists `/<command>`. Typed by you, it does what `/callboard lead` does (the name must be free,
  the model one of `LANE_MODELS`, the effort one of `LANE_EFFORTS`), then on the next quiet moment renames the session
  (its row takes the name only once the rename has landed) and sets its model and effort, and sends the lead one
  notice that names any step that failed. Only your typed turn
  runs it. A file that does not parse, or names a built-in or callboard's own command (`callboard`, `rest`,
  `unattended`), registers nothing. Any folder you start a session in can declare one, so read the file of a repo you
  do not know before you type its command.
- **Manager.** The one session that carries the name in `~/.claude/callboard/manager-name`, found by its registry name
  while it is live. It reaches every session on the Mac. Its role is in `docs/manager/README.md`.

The parent is computed, never stored: the session's lead if that is live (for a lead a conductor made, its conductor),
else the manager if live, else you.

Three kinds of stop, from least to most final: `lane_park` closes the tab and keeps the conversation (`lane_unpark`
reopens it with its history); `lane_retire` ends a signed-done session and removes the lane (final); `lane_terminate`
is the force stop and always asks you, and is refused while unattended mode is on.

## A normal day

1. Start Claude Code in the repo (VS Code or a terminal), name the session with `/rename`, and type `/callboard lead`.
   A session you do not touch is still managed: its asks rise to its parent.
2. Ask the lead for work. It writes each lane a brief (`<folder>/.archive/<LANE>/BRIEF.md`), opens a panel, and
   starts the lane with it.
3. The lanes work. When a lane waits on a permission prompt, the dialog is yours for the first 30 seconds; then its
   parent sees the ask and must allow, deny, answer or escalate it by its rubric. With no choice it reaches the
   manager at 5 minutes of awake time, and at 15 minutes an ask nobody answered is closed with a message that tells the
   session not to ask again. Your click always wins. By day an ask that reaches you is a pop-up in the manager's
   session, or you tell the manager in words (ADR 0012).
4. A session that waits on a pull request registers it with `pr_watch` and is told when checks finish, reviews arrive
   or the PR is mergeable, merged or closed. A merge is still yours.
5. A big session is asked to compact before it loses its notes, and compacts itself (`request_compact`). A lead that
   wants a lane compacted says so in an ordinary message.
6. A lane finishes, signs its report, and its lead retires it. The lead is told of a signature in a check-in. A lane
   you may need again is parked instead.
7. Before a long stretch, give a lead one go for the whole body of work (`/callboard go TEXT`, one to three lines) so
   its lanes do not ask again for each step; a lead can ask for one with `go_request`, which opens your dialog. A go
   lasts 24 hours or until `/callboard go off`, covers the session and the sessions under it, and never covers a merge,
   a force push, a push to main or production, a delete outside the work, or the rest of the list `go_status`
   prints (ADR 0009). It counts only while the protected-paths guard is in place.
8. Before you leave the Mac for hours, type `/callboard unattended 8h` (30 minutes to 14 hours, or a time such as
   `17:30`). Nothing else changes except timing: no pop-up opens at you, `go_request` is refused, a subagent's
   dialog is denied with "run it yourself", and the manager closes at once, with a note that you are away, every
   ask it may not or cannot decide. Anything nobody answers is closed at 15 minutes. `/callboard unattended off`, typed
   by you, ends it ([ADR 0008](../../docs/adr/0008-unattended-mode.md), amended by ADR 0012).

A lead you leave idle is told, in one check-in turn, what happened to its lanes: an ask that is its to decide, a lane
that signed done, is gone, has waited on a prompt for 5 minutes or has been idle, or a safe default callboard used.

## Commands

`/callboard help` prints the full table and is the authority.

- **Look:** `status`, `lanes`, `help`.
- **Roles and switches:** `lead [PATH…]`, `conductor [PATH…]`, `lead off`, `off`, `on`.
- **Settings:** `config [keepalive on|off | ping 30-55 | stop 1-8 | idle 150-800 | working 150-900 | reset]`,
  `rest` (or `/rest`), `go TEXT`, `go off [ID]`, `unattended Nm|Nh|HH:MM|off`.

Anything that widens what a session may do (a lead role, a go, a setting) needs your own typed turn: a model cannot run
a `/callboard` command at all, and the plugin refuses a form that changes what a session may do unless it came from
your own prompt or phone. `off`, `rest`, `go off` and the prints are open to narrowing.

`/callboard config` shows the settings with their defaults: keepalive on, a ping after 50 minutes, a stop after 2
hours, and the compaction nudge levels (300k and 400k tokens). `config reset` restores the defaults.

Reserved names: `MANAGER` and the manager's own name.

## Install

Callboard has no installer ([ADR 0003](../../docs/adr/0003-symlinked-install.md)). The plugin and the panels
extension load straight from your live checkout of this repo, which stays on `main` and moves only by a
fast-forward after a merge. Agents never edit that checkout; they work in clones under `/tmp`. Nothing needs sudo or
a fetch. `<checkout>` below is the clone's absolute path. The full order of steps is `docs/setup.md`.

Callboard reads the session list at `~/.claude/sessions` and supports sessions run under `~/.claude` (other
config folders: ADR 0002, the `CLAUDE_CONFIG_DIR` amendment).

### Default load (every session)

One line in the `env` block of `~/.claude/settings.json`, which Claude Code applies to every session it starts:
VS Code opened from the Dock, any terminal `claude`, peers and background workers.

```json
"CLAUDE_CODE_PLUGIN_DIRS": "<checkout>/tools/callboard/plugin"
```

Add it yourself. If `env.CLAUDE_CODE_PLUGIN_DIRS` holds another value, keep it and decide by hand. Otherwise this
keeps a backup, sets the key and leaves every other setting as it was; fill in `<checkout>` first, and the diff
should show only that line (and a comma on the line before it, when the key is new):

```
cp ~/.claude/settings.json ~/.claude/settings.json.bak-callboard && /usr/bin/python3 -I -c "import json,os;p=os.path.expanduser('~/.claude/settings.json');d=json.load(open(p));d.setdefault('env',{})['CLAUDE_CODE_PLUGIN_DIRS']='<checkout>/tools/callboard/plugin';open(p+'.tmp','w',encoding='utf-8').write(json.dumps(d,indent=2,ensure_ascii=False)+'\n');os.chmod(p+'.tmp',os.stat(p).st_mode&0o777);os.replace(p+'.tmp',p)" && diff ~/.claude/settings.json.bak-callboard ~/.claude/settings.json
```

Sessions pick it up when they next start. Settings `ask` rules do not gate the plugin's tools, so add none: their own
checks are the gate. A process running as you can repoint the variable by editing the settings file, and a launcher's
clean start (`env -i`, `--force-disable-user-env`) would not close that either.

### The panels extension

`link-extension.py` makes `~/.vscode/extensions/notitial.callboard-panels-<version>` a link to
`<checkout>/tools/callboard/extension` and registers it in VS Code's `extensions.json`. Without `--apply` it only
shows what it would do. Quit VS Code (Cmd+Q) first and run it from a plain Terminal:

```bash
/usr/bin/python3 -I <checkout>/tools/callboard/link-extension.py --apply
```

It refuses anything it would have to guess about (a real folder or a foreign link under a
`notitial.callboard-panels-*` name, a malformed `extensions.json`) and names the file; a refusal changes nothing.
`--remove --apply` undoes it. Details: `docs/setup.md` and `--help`.

The script does not look for the extension's earlier id `local.callboard-panels-*`. Such a copy would answer
every lane open as well and open every lane twice, so check for one yourself and remove it:

```bash
ls ~/.vscode/extensions | grep -i local.callboard-panels
```

The version is fixed, so an update is a fast-forward of the checkout plus a window reload (Command Palette,
Developer: Reload Window). Output > Callboard Panels shows the build it loaded. A change to
`extension/package.json` needs a version bump: quit VS Code, pull, run the script again, reopen VS Code.

A window answers a lane open only when the lane's folder is its first workspace folder, so open further windows from
inside VS Code (File, New Window). With the optional patch of the Claude Code extension (`patch-claude.py`,
docs/setup.md) one multi-folder window answers for every one of its folders.

### Manager setup: keep agents off the store (by hand)

One `permissions.deny` line in your global `~/.claude/settings.json` keeps an agent's Edit and Write tools off
callboard's store file (`~/.claude/plugins/store/callboard_*.json`, which holds this machine's callboard settings).
`docs/setup.md` has the line. It stops the file tools, not a shell write. The rest of `~/.claude/callboard/` (the
manager's name and rules files, the plugin's state under `v2/`) is kept from agents by ai-toolkit's protected-paths
hook and its marker file (`docs/setup.md`, Keep agents off the live checkout), which stops the file tools and a shell
line that names the path.

### Install check

The first test in `docs/setup.md` is the install check: in a restarted session, type `/callboard config ping 45`
yourself and see it apply; a model cannot run `/callboard` commands at all. Put the ping value back afterwards.

## How cost is kept down

A session's prompt cache lives an hour from its last call. An idle session pays about 1.25 times its context to
write that cache again, where a short turn inside the hour costs about 0.1 times. So the plugin pings an idle session
just before its cache expires (about 50 minutes), stops 2 hours after the last real work (two pings, with the
defaults), and sends nothing while the Mac sleeps. A big session is asked to compact instead of being pinged again.
A lane signed done is never pinged.

Type `/rest` in a session you will not touch for hours: it stops the pings for that idle gap and the cache expires.
Its next real turn restores them. An agent can set the same rest for its own session with the `rest` tool, when you
tell it to go idle or it expects you to be away for hours; it asks nothing, because it only narrows, and a
subagent's call is refused. A rest stops pings only: a PR notice still wakes a lane that rests while it waits on CI,
and that turn ends the rest. `/callboard config keepalive off` stops pings for every session on this Mac.

A compaction asked for by a nudge (past 300k tokens by default) is always the session's own act: it writes where it
is to its report or STATE file, calls `request_compact`, and carries on from its continuation. The nudge levels and
the ping times are settings.

## Where things live

Under `~/.claude/callboard/` (nothing in a repo is trusted):

| Path | Holds |
|---|---|
| `manager-name`, `manager-rules.md` | The two per-machine files you write: the manager's session name, and your standing rules for the manager (`docs/setup.md`) |
| `v2/` | The plugin's state: its session table (`v2/sessions.json`), the repos saved for each conductor folder (`v2/conductors.json`), and the requests for the panels extension (`v2/open/`) |
| `OFF` | When this file exists, no tier's answers count; remove it to allow them again |

The plugin's settings are in `~/.claude/plugins/store/callboard_*.json`. Lane briefs and reports stay in the repo
under `.archive/<LANE>/`.

## When something is refused

A tool's refusal reads `<tool> refused: <reason>` and says whether to retry; retry only when it does, and otherwise
tell the person the reason. Look at `/callboard status` and `/callboard lanes` in the session first.

- **A lane did not answer a cue.** The cue waits 20 seconds. The lane may still act on it: do not repeat the call; check
  `lane_list`.
- **The window refused an open.** If a panel is already open in that folder, `lane_start` it first; otherwise
  check that the extension is linked and VS Code was started after the link, and that a window has the lane's
  folder as its first folder (or the patch is in).
- **A stopped lane's tab stays.** Check the extension is linked and VS Code was started after the link.
- **`/callboard` does nothing.** The plugin loaded only if a session started after the Default load line was set.
- **No tier answers an ask.** A tier's answers count only while the protected-paths hook is wired in your settings,
  `~/.claude/callboard/.protected-checkout` exists and `~/.claude/callboard/OFF` is absent (`docs/setup.md`).

## What callboard does not guard against

It guards against an honest mistake, not against code running as you: any such process can write the state files, a go
or an answer file, and a registry file. The protected-paths guard keeps agents' file tools off the state folder, and a hook
that fails leaves the dialog with you with no deadline (ADR 0012, Consequences). Beyond that, specific to what you see:

- Messages between sessions carry no proof of who sent them.
- A PR notice's counts include the lane's own comments (ADR 0010).
- What a tier handles and what it passes up is guidance in its rubric, not a check in the plugin. A tier that
  misreads it, or is talked round by a lane's input, can allow what a guard or hook was written to put in front of
  you (ADR 0012, Open questions).
- The `/callboard` typeahead is tested against the test kit only: how a terminal, a VS Code panel or a phone draws
  the rows is not checked against a live engine.

## Tests

```bash
bash tools/callboard/test.sh
```

It runs the plugin's core and engine specs, the extension tests, `claude plugin validate` and `claude plugin test`
on the plugin, and the `link-extension.py` and `patch-claude.py` tests. CI runs all of it. The plugin's tests sit
beside its code (`plugin/hooks/**/*.spec.ts`) and in `plugin/test/`.

The script takes a machine-wide turn first (`tools/test-turn.sh`) and runs its steps at a lower priority, so two
local runs never overlap: while another run of it or of `tools/test-all.sh` holds the turn, it says so and waits.
A turn whose holder is gone is taken over at once. If the turn is older than 25 minutes and its holder is not
known to be gone, the script stops with exit 3. Check that no test run is still going, then clear it and run the
script again:

```bash
rm -r /tmp/ai-manager-fulltest.lock
```

Paths that act on cues, restores and compaction run only against mocks. Before a change reaches the live checkout,
try it in a lab VS Code (its own `--user-data-dir`, launched with `env -i`): rename, start, resume and compact end
to end, a real manager and several lanes at once.

## Where the detail is

| Topic | ADR |
|---|---|
| The plugin: one session model, one ask chain, unattended mode | [0012](../../docs/adr/0012-callboard-plugin.md) |
| The earlier design: cues, lanes, park, check-ins, keepalive (history) | [0002](../../docs/adr/0002-callboard.md) |
| Why it loads from a live checkout | [0003](../../docs/adr/0003-symlinked-install.md) |
| The go | [0009](../../docs/adr/0009-go-given-once.md) |
| PR notices | [0010](../../docs/adr/0010-pr-notices.md) |
