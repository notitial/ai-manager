# Setup

From nothing to a working manager setup on one Mac: callboard loaded from your checkout in every session, the settings
that keep agents off its files, the usage watcher running, and the callboard rule linked.

You run every install step yourself. An agent never edits settings or permissions: where a step changes
`~/.claude/settings.json`, you make the edit. The `setup-manager` skill walks through the same steps (see
[The guided way](#the-guided-way)).

`<checkout>` below is your live checkout of this repo: the absolute path of one clone that stays on `main` and moves
only with `git -C <checkout> pull --ff-only` after a merge. Callboard loads straight from it, so a pull is
callboard's install. Agents never edit it: they work in their own clones under `/tmp` (CLAUDE.md, Where agents edit).
`<commit>` is a full 40-character commit of `main` you have read, for the usage watcher.

The usage watcher's installer fetches `main` from the fixed URL `https://github.com/notitial/ai-manager.git` over
HTTPS, without credentials, into a fresh temporary repository, and installs from the commit there, never from your
working tree or the checkout's git store. So it installs only once the repo is public: while it is private the fetch
fails and nothing is installed. Callboard (step 1) and the rule link (step 3) work either way.

## Prerequisites

- macOS.
- The repo is public on GitHub, for the usage watcher's installer (see above), and the Mac has network access: its
  dry run fetches too.
- [ai-toolkit](https://github.com/notitial/ai-toolkit) installed as the base (`/setup-claude`). Its status line
  writes the meter the usage watcher reads.
- node 22.18 or later, the `claude` CLI, `/usr/bin/python3` 3.9 or later (from the Command Line Tools) and `jq`.
- The checkout sits outside the ai-toolkit checkout (see [ai-toolkit's setup and cleanup](#ai-toolkits-setup-and-cleanup)).

```
node --version && claude --version && /usr/bin/python3 --version && jq --version && xcode-select -p
```

## 1. Callboard

Details: [tools/callboard/README.md](../tools/callboard/README.md), Install. Design: [ADR 0002](adr/0002-callboard.md)
and [ADR 0003](adr/0003-symlinked-install.md).

Callboard has no installer. The mod loads from `<checkout>/tools/callboard/mod`, and the panels extension is a link
to `<checkout>/tools/callboard/extension`. Nothing needs sudo, and nothing is fetched.

### Switching from the root-owned install

Skip this unless `/usr/local/libexec/callboard` exists: callboard's earlier installer made it. Remove it and the
extension folder that installer copied:

```
sudo rm -rf /usr/local/libexec/callboard
```

```
rm -rf ~/.vscode/extensions/notitial.callboard-panels-1.0.0
```

The earlier installer only ever wrote version 1.0.0. If `link-extension.sh` below names another real folder, remove
that one the same way.

- In the next steps, the `CLAUDE_CODE_PLUGIN_DIRS` value **replaces** `/usr/local/libexec/callboard/mod`. Never add a
  second folder: two folders holding a `callboard` mod would both load. Until you replace it, a session that starts
  finds no mod, so do the whole section in one go and then restart every session.
- The root-owned `lanes.json` goes with that folder. Lanes now come only from the lane store, where `lane_create`
  writes them; a lane that was only in the root file has to be made again.
- The `claude-callboard` terminal wrapper goes too: the `env` line below loads the mod in terminal sessions as well.

### Link the panels extension (VS Code)

Dry run, then apply:

```
bash <checkout>/tools/callboard/link-extension.sh
```

```
bash <checkout>/tools/callboard/link-extension.sh --apply
```

- It links `~/.vscode/extensions/notitial.callboard-panels-<version>` to `<checkout>/tools/callboard/extension`,
  with the version from `extension/package.json`. Run it again after a version bump: it makes the new link and
  removes the old one.
- It refuses, and names the entry, when a real folder or a link to anywhere else sits under a
  `notitial.callboard-panels-*` name: an old copy would shadow the link. Remove that entry yourself and run it again.
- `--remove --apply` takes the links off again.
- Reload open VS Code windows to load the extension.

### Load it in every session

Add this line to the `env` block of `~/.claude/settings.json`, with `<checkout>` written as an absolute path:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "<checkout>/tools/callboard/mod"
```

- Claude Code applies it to every session it starts: VS Code opened from the Dock, any terminal `claude`, peers and
  background workers.
- Settings ask rules do not gate the mod's tools, so add none: their own checks are the gate, and `lane_terminate`
  asks for itself.
- If `env.CLAUDE_CODE_PLUGIN_DIRS` already holds another value, keep it and decide by hand. Callboard should be the
  only plugin on this variable: another plugin loaded in a session can run `/callboard` and may answer its dialogs
  (ADR 0002, Consequences).
- The callboard README, Default load (every session), has a one-line command that backs the file up, adds the key
  and shows the diff.
- Restart every session, not only new ones: a session on an older mod can drop fields from the lane store.

**Install check.** In a restarted session, type `/callboard config ping 45` once yourself, and once ask the model to
run it. First type `/callboard config` and note the ping value. The typed one must apply; the model-run one must be
refused with "Only you can change callboard settings". If the model-run one applies, report it (callboard README,
Keepalive and settings (v13.2)). Then type `/callboard config ping <the value you noted>`. Do not use
`/callboard config reset` for this: it puts every callboard setting on this Mac back to its default.

### Manager setup: keep agents off the list file and the store (by hand)

Why, and what these lines do not cover: [callboard README, Manager setup: keep agents off the list file and the
store (by hand)](../tools/callboard/README.md#manager-setup-keep-agents-off-the-list-file-and-the-store-by-hand). Do it
now, by hand: an agent must not edit permission settings, and the `/setup-claude` templates do not carry these lines.

Add these four lines to `permissions.deny` in your global `~/.claude/settings.json`:

```json
"Edit(**/.claude/callboard-conductor.json)",
"Write(**/.claude/callboard-conductor.json)",
"Edit(~/.claude/plugins/store/callboard_*.json)",
"Write(~/.claude/plugins/store/callboard_*.json)"
```

They keep an agent's Edit and Write tools off a conductor repo's list file and off the mod's store file, which holds
the saved grants and this machine's reserved names; they do not stop a shell write. A pattern without a leading `/`,
`~/` or `//` is relative to the session's folder, so the `**/` lines cover only sessions started in or above the
conductor repo: for each conductor repo, add the absolute form too
(`Edit(//Users/x/cond/.claude/callboard-conductor.json)` and the same with `Write`).

### Keep agents off the live mod

By hand too: ai-toolkit carries nothing about callboard. Add these two lines to `permissions.deny` in your global
`~/.claude/settings.json`, with `/<checkout>` written as your checkout's real path. `<checkout>` starts with `/`, so
each rule starts with `//`, as in `Edit(//Users/x/ai-manager/tools/callboard/**)`:

```json
"Edit(/<checkout>/tools/callboard/**)",
"Write(/<checkout>/tools/callboard/**)"
```

They keep an agent's Edit and Write tools off the mod and the extension every session loads. Agents never need them:
they edit in `/tmp` clones. Like the lines above, they do not stop a shell write
([ADR 0003](adr/0003-symlinked-install.md), Consequences).

If you run a conductor repo: callboard refuses its `.claude` folder as unsafe when group or other may write it (as
under umask 002). Run this once:

```
chmod go-w <conductor repo>/.claude
```

## 2. The usage watcher

Details: [tools/usage-watcher/README.md](../tools/usage-watcher/README.md), Install. What the manager does with its
summary: [docs/manager/usage-watch.md](manager/usage-watch.md).

- **Only once the repo is public.** The installer fetches `main` over plain HTTPS from a fixed URL, with no
  credentials, so it fails while the repo is private. Until then the manager reports "usage summary never created;
  install pending" and acts on nothing.
- **The meter** comes from ai-toolkit's status line, which writes
  `${AGENT_DISPATCH_SPOOL:-~/.agent-dispatch/spool}/limits/personal-windows-*.json` as a session renders. The
  watcher reads it as an optional input: without it the summary has no meter, and the per-session numbers still
  work. The launchd job does not see your shell's `AGENT_DISPATCH_SPOOL`, so it reads the default path.

### An older watcher first

Only when you are about to install this one (the repo is public): if an older usage-watcher job is loaded under
another label, unload it first: `launchctl bootout gui/$(id -u)/<old label>`.
Then remove its plist from `~/Library/LaunchAgents/`, or it loads again at the next login. The data folder is shared
and kept. This repo's job is `io.notitial.usage-watcher`.

```
launchctl list | grep usage-watcher
```

```
launchctl bootout gui/$(id -u)/<old label>
```

### Dry run, apply, status

```
cd <checkout> && bash tools/usage-watcher/install.sh --ref <commit>
```

```
cd <checkout> && bash tools/usage-watcher/install.sh --ref <commit> --apply
```

```
cd <checkout> && bash tools/usage-watcher/install.sh --status --ref <commit>
```

`--apply` runs the commit's watcher tests, installs a copy under `~/.local/share/usage-watcher/`, writes the plist
and loads the job. `--status` is read-only; a missing `jq` counts as needing attention (exit 4).

### The SessionStart hook (by hand)

The installer prints one entry for `account-stamp.sh` and never edits a settings file. Add it, with the path it
prints, to the `SessionStart` list under `hooks` in `~/.claude/settings.json` (no matcher), unless it is there:

```json
{"hooks": [{"type": "command", "command": "<path the installer prints>/account-stamp.sh"}]}
```

## 3. The callboard rule

[rules/callboard.md](../rules/callboard.md) is an always-on rule: how a session answers callboard's keepalive,
nudges and notices, and that none of them carries an approval. Link it into your global rules:

```
mkdir -p ~/.claude/rules && ln -s <checkout>/rules/callboard.md ~/.claude/rules/callboard.md
```

If `~/.claude/rules/` holds an older keepalive rule from an earlier setup, unlink it: this rule replaces it.

## ai-toolkit's setup and cleanup

ai-toolkit's `/setup-claude` and `/cleanup-claude` leave everything in this guide alone.

- **The rule link.** `/setup-claude` installs only ai-toolkit's own `rules/*.md`, so it never looks at
  `callboard.md`: it does not overwrite, remove or list the link. If the link dangles (the checkout moved), its rules
  step reports it as a conflict and still deletes nothing. `/cleanup-claude` unlinks only links that resolve into
  the ai-toolkit checkout, or dangle at a path through `/ai-toolkit/`. This link is neither, so it stays, and the
  cleanup report does not mention it. Keep this checkout outside the ai-toolkit checkout, or cleanup counts the link
  as the toolkit's. After moving the checkout, remove the old link (`rm ~/.claude/rules/callboard.md`) and run the
  `ln -s` again.
- **Settings.** `/setup-claude` never alters an `env` key outside its template and never removes a deny entry or a
  custom hook. `/cleanup-claude` removes only entries its template lists. So the `CLAUDE_CODE_PLUGIN_DIRS` line, the
  four deny lines and the SessionStart hook survive both.
- **Installed files.** Neither touches the panels extension link or the usage-watcher job. `link-extension.sh
  --remove --apply` takes the link off.

## 4. Start the manager

Follow [docs/manager/README.md](manager/README.md), Starting and resuming. In short: a plain session in this
checkout, without `CLAUDE_CONFIG_DIR`, on Opus (`/model opus`), then type `/callboard manager [NAME]` yourself. With
no NAME the session is named `MANAGER`. The grant lives in memory, so every start and resume needs the command again.

The only name callboard reserves built in is `MANAGER`. A manager on a second machine needs a different name, because
Remote Control lists every machine's sessions. Reserve it on that machine first, typed yourself, then use it:

```
/callboard reserve BLUE
```

```
/callboard manager BLUE
```

The reserved list is kept per machine, in the mod's store: `/callboard reserve` shows it and
`/callboard reserve remove NAME` takes a name off. Only you can change it, from your own prompt or phone; a name a
lane or a live lead carries cannot be reserved. Details: callboard README, The manager (v14, 2026-11-03/04), its
"Reserved names (v15.1, 2026-11-05)" bullet; design: ADR 0002, Design addition v15.1: per-machine reserved names.

## 5. Final check

| Part | Check | Good when |
|---|---|---|
| Live checkout | `git -C <checkout> status -sb` | `## main...origin/main` and nothing else |
| Old install gone | `ls /usr/local/libexec/callboard` | No such file or directory |
| Panels extension | `ls -l ~/.vscode/extensions \| grep callboard-panels` | one link, to `<checkout>/tools/callboard/extension` |
| Default load | type `! echo $CLAUDE_CODE_PLUGIN_DIRS` in a new session | `<checkout>/tools/callboard/mod` |
| Mod loaded | type `/callboard status` in a session | it answers `Lane: NONE. Lead: OFF.` or similar |
| Reserved names | type `/callboard reserve` | the manager's name, when it is not `MANAGER`, is listed |
| Deny lines | read `permissions.deny` in `~/.claude/settings.json` | the four lines and the two live-mod lines are there |
| Usage watcher | `bash tools/usage-watcher/install.sh --status --ref <commit>` | exit 0, the job loaded |
| Summary | `ls -l ~/.local/state/usage-watcher/usage-summary.json` | written in the last 5 minutes |
| SessionStart hook | read `hooks.SessionStart` in `~/.claude/settings.json` | the `account-stamp.sh` entry is there |
| Old watcher | `launchctl list \| grep usage-watcher` | only `io.notitial.usage-watcher` |
| Rule link | `ls -l ~/.claude/rules/callboard.md` | it points at `<checkout>/rules/callboard.md` |
| Tests | `bash tools/test-all.sh` | every suite passes or skips |

## Updating

Read the incoming diff, then pull: `git -C <checkout> fetch`, then `git -C <checkout> pull --ff-only`. The pull is
callboard's update, and the rule link follows the checkout too, so a change to `tools/callboard/` or `rules/` reaches
every session: never pull a commit you haven't read. After a callboard update, run `link-extension.sh --apply` when
the extension's version changed, reload the VS Code windows and restart every session. For the usage watcher, run
its installer again with the new `--ref`.

## The guided way

Type `/setup-manager` in a session in this checkout. The skill
([.claude/skills/setup-manager/SKILL.md](../.claude/skills/setup-manager/SKILL.md)) runs the read-only checks and
the dry runs itself, shows you every `--apply`, settings edit, link and `launchctl bootout` as an exact command to
run, and ends with the status table above.
