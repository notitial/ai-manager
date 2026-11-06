# Setup

From nothing to a working manager setup on one Mac: callboard installed and loaded in every session, the settings
that keep agents off its files, the usage watcher running, and the callboard rule linked.

You run every install step yourself. An agent never edits settings or permissions: where a step changes
`~/.claude/settings.json`, you make the edit. The `setup-manager` skill walks through the same steps (see
[The guided way](#the-guided-way)).

`<checkout>` below is your checkout of this repo, on an up-to-date `main`, and `<commit>` a full 40-character commit
of `main` you have read. For callboard it is the squash commit of the pull request that last changed `tools/callboard`.

Both installers fetch `main` from the fixed URL `https://github.com/notitial/ai-manager.git` over HTTPS, without
credentials, into a fresh temporary repository, and install from the commit there, never from your working tree or the
checkout's git store. So callboard and the usage watcher install only once the repo is public: while it is private
both fetches fail and nothing is installed. The deny lines (step 1) and the rule link (step 3) work either way.

## Prerequisites

- macOS.
- The repo is public on GitHub, for the two installers (see above), and the Mac has network access: a dry run fetches
  too.
- [ai-toolkit](https://github.com/notitial/ai-toolkit) installed as the base (`/setup-claude`). Its status line
  writes the meter the usage watcher reads.
- node 22.18 or later, the `claude` CLI, `/usr/bin/python3` 3.9 or later (from the Command Line Tools) and `jq`.
- The checkout sits outside the ai-toolkit checkout (see [ai-toolkit's setup and cleanup](#ai-toolkits-setup-and-cleanup)).

```
node --version && claude --version && /usr/bin/python3 --version && jq --version && xcode-select -p
```

## 1. Callboard

Details: [tools/callboard/README.md](../tools/callboard/README.md), Install. Design: [ADR 0002](adr/0002-callboard.md).

- **Only once the repo is public.** The installer fetches `main` from the fixed URL, with no credentials, into a
  fresh temporary repository. While the repo is private it stops with "fetching main ... failed" and installs nothing.

### Check the installer

The installer installs from a pinned commit of `main`, never from the working tree. Take three values from the
description of the pull request that last changed `tools/callboard`, which lists them: its squash commit
(`<commit>`), the SHA-256 of `SHA256SUMS` at that commit (`--sums-sha`) and the SHA-256 of `install.sh`. The
installer checks `SHA256SUMS` against `--sums-sha` itself, in the commit it fetched. It cannot verify itself, so
check its hash before you run it: with the checkout on an up-to-date `main`, this must print the `install.sh` value
from that description. If it differs, stop.

```
shasum -a 256 <checkout>/tools/callboard/install.sh
```

### Dry run, then apply

Run it as your user, never with `sudo`: the script calls sudo itself for the root-owned parts and refuses to run as
root. Without `--apply` it only shows what it would do. It prints its own hash first: compare it again.
`<sha256 of SHA256SUMS>` is the `--sums-sha` value from the pull request's description.

```
cd <checkout> && bash tools/callboard/install.sh --all --ref <commit> --sums-sha <sha256 of SHA256SUMS>
```

```
cd <checkout> && bash tools/callboard/install.sh --all --ref <commit> --sums-sha <sha256 of SHA256SUMS> --apply
```

- `--all` installs the mod (root-owned, in `/usr/local/libexec/callboard/mod`), the terminal wrapper
  `claude-callboard` and the VS Code panels extension. `--terminal` or `--vscode` installs one route only.
- `--lanes FILE --lanes-sha <sha256 of the file you reviewed>` also installs a root-owned `lanes.json`. Optional;
  it needs node on the PATH of the shell you install from (callboard README, Install).
- Reload open VS Code windows to load the panels extension.
- The installer ends by saying that settings ask rules do not gate the mod's tools. Add none.

### Load it in every session

Once `/usr/local/libexec/callboard/mod/.claude-plugin/plugin.json` exists, add this line to the `env` block of
`~/.claude/settings.json`:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/usr/local/libexec/callboard/mod"
```

- Claude Code applies it to every session it starts: VS Code opened from the Dock, any terminal `claude`, peers and
  background workers.
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
- **Installed files.** Neither touches `/usr/local/libexec/callboard` or the usage-watcher job.

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
| Callboard installed | `ls -l /usr/local/libexec/callboard/mod/.claude-plugin/plugin.json` | the file exists, owned by root |
| Panels extension | `ls ~/.vscode/extensions/notitial.callboard-panels-1.0.0` | the folder exists (`--vscode` or `--all`) |
| Default load | type `! echo $CLAUDE_CODE_PLUGIN_DIRS` in a new session | `/usr/local/libexec/callboard/mod` |
| Mod loaded | type `/callboard status` in a session | it answers `Lane: NONE. Lead: OFF.` or similar |
| Reserved names | type `/callboard reserve` | the manager's name, when it is not `MANAGER`, is listed |
| Deny lines | read `permissions.deny` in `~/.claude/settings.json` | all four lines are there |
| Usage watcher | `bash tools/usage-watcher/install.sh --status --ref <commit>` | exit 0, the job loaded |
| Summary | `ls -l ~/.local/state/usage-watcher/usage-summary.json` | written in the last 5 minutes |
| SessionStart hook | read `hooks.SessionStart` in `~/.claude/settings.json` | the `account-stamp.sh` entry is there |
| Old watcher | `launchctl list \| grep usage-watcher` | only `io.notitial.usage-watcher` |
| Rule link | `ls -l ~/.claude/rules/callboard.md` | it points at `<checkout>/rules/callboard.md` |
| Tests | `bash tools/test-all.sh` | every suite passes or skips |

## Updating

Pull, read the new commit, and run the same installers with the new `--ref` (for callboard, the new `--ref`,
`--sums-sha` and installer hash from the description of the pull request that last changed `tools/callboard`).
Restart every session after a callboard update. The rule link follows the checkout by itself, so a change to
`rules/` is a change to a rule every session loads: read the incoming diff before you pull.

## The guided way

Type `/setup-manager` in a session in this checkout. The skill
([.claude/skills/setup-manager/SKILL.md](../.claude/skills/setup-manager/SKILL.md)) runs the read-only checks and
the dry runs itself, shows you every `--apply`, settings edit, link and `launchctl bootout` as an exact command to
run, and ends with the status table above.
