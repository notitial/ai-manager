# 2. Callboard: one session runs others through cues

**Status:** accepted
**Date:** 2026-10-24

Scope: the callboard mod, its VS Code panels extension and its sender, as they stand at v15. The user-facing guide is `tools/callboard/README.md`; the code is `tools/callboard/mod/hooks/core.ts` (pure logic) and `register.ts` (engine calls). The manager role that uses callboard is ADR 0001.

## Context

The person runs several Claude Code sessions at once: lanes doing the work, a lead per repo directing them, and one manager over all of them. Most sessions are VS Code panels. A lead needs to name a new session, give it its first prompt, resume it, time its compaction and stop it, without the person typing each step.

Facts that bound the options (Claude Code 2.1.310 and later):

- **No hook route.** No hook output, setting or peer message runs `/compact`. A slash command in a peer message arrives as plain text.
- **Typing into a terminal is not viable.** VS Code panels have no tty; TIOCSTI fails because hooks have no controlling terminal; a terminal typer needs a macOS Automation grant that lets any process under that app type into any session; Enter can land in a permission dialog that opens mid-type.
- **From outside, a panel cannot be named, prompted, resumed or compacted.** The extension's URI only pre-fills a prompt.
- **A mod inside the session can.** `$.command.run` (`/rename`, `/compact`, `/model`), `$.prompt.submit` (a turn of its own once the session is idle), `$.tool.register` (model-callable tools), `$.ui.ask` (the engine's own dialog), `$.state` (per session; survives a reload, not a restart) and `$.store` (one plugin-wide file; survives a restart). The engine holds a submitted action while the session is busy or a permission prompt is open, and marks it `origin: plugin`.
- **Settings `ask` rules do not gate a mod's own tools** (probe P-L). A tool that must ask has to do it itself.

So a lead needs one outside input that selects an action and its moment, and the session's own mod must do the acting.

## Options Considered

1. **Status quo.** The person types `/compact`, pastes the continuation, opens, names and prompts every lane by hand. Safe, but it needs the person at the keyboard for every step.
2. **Terminal typer** (AppleScript, Ghostty `input text`, tmux `send-keys`). Rejected: no VS Code coverage, no reliable self-binding, a machine-wide Automation grant, and the dialog race above.
3. **Lower `autoCompactWindow` through a live settings edit.** Dropped by the owner: it would make an agent a routine settings editor.
4. **A cue that carries text** (a message bus into sessions). Not taken: any process running as the person can write the cue folder, so text in a cue would be an injection channel into every session. The cue selects; all text is fixed in the mod or written by the session itself.
5. **Trust a same-uid file for a lane binding** (a binding file, or the `$.store` restore hint taken without a question). Declined for the lane binding: a forged file would bind a session and unlock `start` and `resume` turns into it. Taken later, for named grants only, with stated residuals (v13 lead grant, v15 conductor grant).
6. **Lane stores inside the repo** (`.callboard/`). Rejected in design review: a shipped or cloned store would pass owner checks and be trusted with no grant. Stores live under `~/.claude/callboard/lanes/` instead (v10).
7. **A root-owned VS Code launcher with a clean environment.** Built, then removed: VS Code re-reads the login shell's environment, the flag that stops it is undocumented, and the settings `env` line reaches every session. The terminal wrapper `claude-callboard` stays for testing.
8. **A session that ends itself.** Not built: it needs its own pid, which only a forgeable registry file gives. The target confirms; the lead signals.
9. **`/callboard on`, a per-session enable.** Built in v7, retired in v13.5: every capability it guarded found its own route (below), and a session that is not a lane now takes no lead cue at all.
10. **A mod in each session, driven by cue files: chosen.**

## Decision

One mod, `callboard`, loaded into every session from a root-owned copy. A cue file picks an action and its moment and carries no text. Every limit lives in the reader: the session that acts. Everything a writer, a registry row or a store record says is a filter between honest sessions, never proof.

### The cue

- **File.** `~/.claude/callboard/cue/<sid>.cue`: folder 0700, file 0600, owned by the person, a regular file with one link, not older than 120 s and not dated in the future. A writer writes a temp file and renames it into place.
- **Grammar.** Exactly one line plus `\n`, at most 96 bytes, matched on raw bytes before any trim (`CUE_RE` in `core.ts`). The verbs are fixed:

  | Verb | What the target does |
  |---|---|
  | `rename NAME [LEADSID]` | Birth bind: a fresh, unnamed, zero-turn session in the lane's folder, within 120 s of its start, takes the lane name |
  | `start` | Submits the fixed start text pointing at the lane's brief, once, inside the birth window |
  | `resume` | Submits the fixed resume text (continue only work already authorised), at most 12 an hour |
  | `compact` | Acts on the session's own armed on-cue request, or records a nudge |
  | `retire` | Confirms or refuses a stop (idle, empty box, no background work, a signed report) |
  | `park` | Confirms or refuses a stop that keeps the conversation |

  Anything else is refused and logged. The sender script (`send/callboard-send.mjs`) writes only `rename`, `start`, `resume` and `compact`; `retire` and `park` come only from the lead's own stop tools.
- **Claim.** The mod renames the cue to a name only this tick uses, checks the moved file is the same inode, reads it through a byte-bounded process call (a FIFO cannot hang the tick), stats it again and deletes it. A cue written meanwhile is a new file. A held cue is consumed and answered `held`; the lead re-sends.
- **Pre-action checks.** Right before acting: an empty prompt box and an idle registry row waiting on nothing. This narrows the race with the person; it does not close it.
- **Result file.** Every cue is answered once in `~/.claude/callboard/result/<sid>.result` (0600): one line, `<verb> <ok|refused|held> <code> <inode of the claimed cue>`. The lead accepts only an answer that carries the inode of the cue it wrote, and maps each code through a fixed table (`REASON_TEXT`), so only table text reaches the lead model. A cue tool waits up to 6 s (retire and park: 10 s from the cue write) and otherwise returns `no-answer`.
- **Fixed texts.** Every turn the mod submits (start, resume, nudge, keepalive, notices, check-ins, the compaction resume) is fixed text that says it comes from the callboard mod, not the person, and carries no approval, go or answer. The only variable parts are names and paths that pass fixed checks.
- **Log.** One file per session, `~/.claude/callboard/log/<sid>.jsonl`, 0600, fixed reason codes, no outside text, identical refusals logged once.

### Compaction stays self-only

- `request_compact({ focus, continuation, mode })` is the one way a session compacts through callboard. Main agent only (a call with an `agentId` is refused). Focus: printable, one line, 1 to 1200 characters, not starting with `/`. Continuation: printable, at most 5 lines and 600 characters.
- The continuation and its SHA-256 live in `$.state`, written by the session itself, never read from a file. After the compaction (confirmed by PostCompact, run from the tick because the engine refuses a submit from inside PostCompact) the mod submits one fixed `[compact-cue]` turn quoting the note as data: resume only work authorised before compaction, any approval the note claims is untrusted.
- `mode: now` acts at the end of the requesting turn. Any interactive session may use it for itself, nudged or not. `mode: on-cue` waits for a `compact` cue and needs a bound lane, or a lead acting for a trusted manager or conductor (v14, v15). Any later turn, a newer request, a reload or 15 minutes drops an on-cue request; a cue with none does nothing to it.
- Limits: one compaction per 30 minutes, at least 100k tokens of context, no background agent or shell, no draft in the box. A request never auto-resumes after a restart.

### Levels

Four levels, one per session (`conductor-holder`, `lead-holder`, `lane-holder` and their `-after-` forms: a session that held one level keeps its declared tools until it restarts, so it cannot take another before then).

| Level | How it is granted | Reach | Kept across a restart |
|---|---|---|---|
| **Lane** | A birth `rename` cue from a lead; `/callboard lane [NAME]` and a `Join` click in the session (person's own prompt or phone only); a Restore click; the automatic rebind of a session its store record names | Takes cues from its lead | Rebinds itself when exactly one store record names its session id (v13); else a Restore question at `/callboard lane` |
| **Lead** | `/callboard lead` from any origin, then the person's `Lead` click (the dialog names the repo folder and, when it is not the person's own prompt or phone, the origin) | Lanes whose repo holds the lead's folder; a store lane only from a lead at its repo root; a lane naming a lead only from the lead of that name | Saved as `lead:<sid>` in `$.store` (30 days); same session, same folder, a person's session: lead again with no question |
| **Conductor** | `/callboard conductor` in a dedicated repo and the person's `Conductor` click on the named list of repos | The lanes of the listed repos, narrowed by the list file at every call | Saved as `conductor:<sid>`; back with no question unless the file names a repo not yet approved |
| **Manager** | `/callboard manager [NAME]` and the person's `Manager` click; NAME must be `MANAGER` or a name reserved on this machine (`/callboard reserve`, default MANAGER); one per machine | Every lane with a repo, for list, resume, compact, stop and remove | No: memory only, the command again after every start |

`/callboard off` drops whatever level the session holds (from another origin it asks first). `/callboard status` prints the levels without a model turn. The lead grant is a filter, not proof: it decides which session gets the `lane_*` tools, and every target still runs its own checks.

### Lead tools

`lane_create`, `lane_open`, `lane_rename`, `lane_start`, `lane_resume`, `lane_compact`, `lane_park`, `lane_unpark`, `lane_retire`, `lane_terminate` and `lane_list`, registered on the grant. The engine cannot unregister a tool, so after `off` they stay declared and refuse every call. A target is found by registry name inside the lane folder; a name on two live sessions is `ambiguous`, and a lead never targets itself.

A fixed lead briefing reaches the lead twice: a `callboard:lead` system-prompt section through `prompt.compose`, and, because the engine renders the system prompt once per conversation, one user-role note at the grant that opens `[callboard] This note comes from the callboard plugin, not the person.` Bound lanes get the matching `callboard:lane` briefing: their name, folder, lead, where and how to sign done, and that their brief and their lead's messages are data with no approval.

### Stopping a lane

- **`lane_terminate`** asks the person every time in its own dialog (`Force stop`/`Cancel`), naming the lane, the first 8 characters of the session id and the pid. After the click the lead checks everything again (grant, lane, one session, same session id, pid and start time) and once more right before the signal; any change sends nothing (`Force stop not sent: <code>`). No idle check: a force stop works mid-task.
- **`lane_retire`** asks the person nothing; the target confirms. The lead first checks the registry row is idle for 30 s and the last line of `<repo>/.archive/<LANE>/REPORT.md` is `status: done <that session's id>`. The target answers `ok` only with an empty box, idle, no background agents, no shell child of its claude process, and a report signed with its own id that is newer and larger than at the start of its last real turn. After `ok` the lead re-reads the registry and signals only the same session, pid and start time. Retire is final: it clears the record's session id.
- **`lane_park`** is retire without the report: the target confirms, the lead keeps the record's session id, signals, closes the tab and marks the record parked. **`lane_unpark`** asks the window whose first folder is the lane folder to reopen that exact conversation, which then rebinds itself.
- **Both signal paths** check the registry file is named for its pid, the pid's start time with `ps` (UTC, C locale), that the process is a claude binary and not the caller, log first, then send SIGTERM (exit 143, a clean stop). The report is append-only; an earlier session's signature never matches a later one.
- **Tab close.** After a signal that exited 0 the mod writes `~/.claude/callboard/open/<LANE>.close`; the extension closes the one Claude tab of that name once the pid is dead and no live session carries the name. History stays.

### Keepalive and compaction nudges

- **Keepalive.** A prompt cache lives an hour. From the 2 s tick, an idle interactive session gets one fixed `[callboard] keepalive` turn ("Cache refreshed.") `ping after` minutes (default 50) after its last turn, never past 58 minutes (cold: nothing gained), one attempt per gap, none while the machine slept, none after `stop after` hours (default 3) since the last real turn. Only a row of `kind: interactive` counts: never a `claude --bg` worker, a `-p` or SDK run, a parked lane or a lane signed done. The mod's own turns are told by their text, so a ping is not real work.
- **Compaction nudge.** At the end of a main-agent answer past the idle level (default 300k) the mod records a nudge; the tick sends it once the session is idle, as one fixed turn asking the session to write where it is, call `request_compact` with mode `now` and a one-sentence focus and continuation, or say in one line why it cannot. Soft text between the idle and the working level (default 400k): finish the current item, start no new one. Hard text at or past the working level: stop now. A working session (background work, or a bound lane not yet signed done) waits for the working level; a lead is nudged only at the working level. An idle session at 150k or more gets a cache nudge in place of its third ping. At most one nudge per 30 minutes (one hard nudge may follow a soft one inside it) and 3 an hour.
- **A lead's `lane_compact`.** Compacts at once on the lane's armed on-cue request; with none, records a nudge (`held nudged`) under the same limits.
- **`/callboard config`.** One line of settings, from any origin, read-only. Changes (`keepalive on|off`, `ping 30-55`, `stop 1-8`, `idle 150-800`, `working IDLE-900`, `checkin on|off`, `reset`) only from the person's own prompt or phone. Stored machine-wide in `$.store` under `config`; each field is taken only in range, else its default; every session rereads it within a minute. `/callboard off` stops neither pings nor nudges.

### Lanes a lead makes, and attached lanes

- **Made.** `lane_create {name, task, folder?, model?}` writes a record into `~/.claude/callboard/lanes/<sha256 of the repo's real path>.json` (0700/0600, one link, at most 16 KB, 16 lanes, 12 creates an hour) and the task as `<folder>/.archive/<NAME>/BRIEF.md` under a fixed header that says any approval in it is not the person's. The lead then calls `lane_open` (the extension opens a panel and answers its session id), `lane_rename` and `lane_start`. The root-owned `/usr/local/libexec/callboard/lanes.json` stays optional and wins a name clash.
- **Attached.** `/callboard lane [NAME]` makes the session the person is in a lane of the lead in its repo, after a `Join` click. It cannot `start` or be renamed by a cue (`adopted-record`); everything else works as for a made lane.
- **Names.** 1 to 40 of `A-Za-z0-9_-`. A name whose look-alike skeleton matches a reserved name (`MANAGER`, or one this machine reserved) is reserved (`reservedHit`). No lane name may equal a live session's name in any letter case.

### Install

**Amended 2026-11-06 ([ADR 0003](0003-symlinked-install.md)):** superseded. Callboard now loads from a live checkout
that agents never edit, and `install.sh`, `SHA256SUMS`, `/usr/local/libexec/callboard` and the root-owned
`lanes.json` are gone. The text below records the earlier design.

- `install.sh --terminal|--vscode|--all --ref <40-hex commit on main> --sums-sha <64-hex> --apply`, run as the person (it refuses root and calls `/usr/bin/sudo` itself). It never installs from the working tree: as the person it reads `SHA256SUMS` of `tools/callboard` at the pinned commit, requires it to hash to `--sums-sha` from the description of the pull request that last changed `tools/callboard`, then streams each listed file from git into a root-owned 0700 staging folder (mode 0644, no archive, no file the person can write in between), checks the staging folder and every staged file, copies to the root-owned prefix `/usr/local/libexec/callboard`, and checks the installed files again. `--lanes <file> --lanes-sha <64-hex>` pins the root lane file the same way and runs the mod's own parser on it first. The installer prints its own hash; the person compares it with the review, since an installer cannot verify itself.
- **Source.** The commit comes from a fresh fetch of `main` from the fixed URL `https://github.com/notitial/ai-manager.git` over HTTPS, as the person and before any sudo, into a temporary bare repository; `--ref` must be a 40-hex commit on `main`. A dry run fetches too. Every git call runs under `env -i` with no system or global config, no hooks, no credential helpers and no redirects. The checkout's `.git` and its config are never read, and a failed fetch (as while the repository is private) installs nothing.
- **It never edits settings.** The person adds one line to the `env` block of `~/.claude/settings.json` (`CLAUDE_CODE_PLUGIN_DIRS=/usr/local/libexec/callboard/mod`), which loads the mod into every session Claude Code starts. Without `--apply` the installer only shows what it would do.
- The mod's files are root-owned, so no agent can edit them. Any source change needs a new security review before it is loaded. macOS only (BSD `stat`, `/usr/bin/install`).
- **Process calls.** The mod API's `$.fs` has no owner, mode, link count, rename or delete, so the mod uses `$.process.run` with fixed absolute executables and argv arrays (no shell), and no argument taken from a cue or model text: `id`, `stat`, `mv -n`, `rm -f`, `mkdir`, `install`, `tee -a`, `shasum`, `realpath`, `head -c`, `ps`, `kill`.

## Design additions

Each addition is part of the decision above; these sections hold what it decided beyond the summary and its residuals.

### Design addition v10: lanes a lead makes

- Lanes must be creatable without sudo, from the phone. The lead grant is the only gate for create, open and start; a stop still asks.
- Store rules: authority in the person's own callboard folder, the file name is the hash of the repo it names, no walk-up from any folder, the repo is its own real path, a git root (a `.git` folder holding `HEAD`, or a `gitdir: ` file; not a link) and not too broad (not the home folder, its standard folders, `/tmp`, a volume root). A store with one bad record is ignored whole; a name in two stores is dropped from both. A lane folder may not sit in a dot folder of the repo (`folder-dot`).
- A bound session keeps a hash of its lane record; `start` and `resume` refuse `record-changed` or `wrong-folder`. Folder checks read the folder the session started in (`$.session.root()`), so a shell `cd` does not move a lane.
- **The lane model (v12).** `model` is `opus`, `sonnet`, `haiku` or `fable` (default `sonnet`). At `start` the lane runs `/model` in itself and reads the name back; a mismatch refuses `model-failed` and the lane is not started.
- **Residuals.** The lead-less chain: any process running as the person can write a store record, an open request and the cues, and so start a session on a brief of its choice in a git repo, with no lead. Bounds: the 120 s birth window, 6 panels a minute and 10 s per name in the extension, 8 live sessions per repo, 12 creates an hour. To switch the chain off, keep `~/.claude/callboard/lanes` absent or read-only (mode 0500): `lane_create` then fails and no forged store is possible without a chmod. A brief is the first instructions of a started session, at the trust level of the repo's `CLAUDE.md` plus the lead model that wrote it. Lanes outlive the grant.

### Design addition v11, PR two: an existing session joins as a lane

- `/callboard lane [NAME]` runs only from the person's own prompt or phone (the engine refuses a plugin's origin rewrite). The dialog (header `Join Lane`, `Join`/`Cancel`) names the lane and the repo folder; the checks run again after the click and must name the same lead, repo, folder and name (`changed`).
- The record carries `adopted` and the lead's identity; it counts in the 16 lanes, not in the hourly creates. A lane joined to a named lead answers only that lead; a legacy record (no lead name) answers any lead of its repo.
- **The lead's presence file** `~/.claude/callboard/leads/<sid>.json` (0600, at most 30 s old, rewritten each tick) is a filter, never a route: a reader accepts it only when the registry holds that pid's own row with the same start time, `ps` agrees and the process is claude. Nothing is ever sent to the sid in it.
- **The lead is told.** When its repo's lane list changes, an idle lead gets one fixed turn ("The lanes in this repo changed. Call lane_list to see them."), at most 12 an hour; a change held by the cap stays owed. `lane_list` and `/callboard lanes` draw the lanes as boxes per repo and per lead.
- **Detach.** `/callboard lane off` or `/callboard off` clears the binding first, then removes only the session's own record; a record that cannot be removed is reported, never claimed done.
- **The store lock.** Store writes take `<root>/lanes/.<key>.lock` (an `mkdir` folder with an owner file of pid, start time and nonce), wait at most 2 s, then refuse `store-busy`. A lock whose owner is gone is broken by one process at a time. It is advisory.
- **The registry is read with a bound.** Every row is read through stat, `head -c`, stat again; at most 512 files; rows whose process is gone are dropped only when a whole `ps` table is trusted; a scan that cannot be trusted refuses (`registry-unreadable`), never reads as "no sessions".
- **Residuals.** Consent given under one lead carries to the next lead of that repo for a legacy record. A same-uid writer can forge an answer file, so a forged `retire ok` with the right inode can trigger the signal, within the bound of the lead's own filters and anything such a process could do by itself. The store lock and the presence file are advisory. A shell child the session keeps for good blocks its retire (denial only; terminate remains).

### Design addition v12: the compaction nudge and the nudge grant (Item 1b)

- A nudge is fixed text chosen by the mod; the session writes its own focus and continuation, and the compaction is the existing `now` path. No new compaction path.
- Item 1b: a session that is not a lane could call `request_compact` once, mode `now`, within 15 minutes of a nudge. Since any interactive session may compact itself, the grant only changes the log code (`requested now-nudged`).
- A nudge is recorded in hooks and sent only from the tick, last in each tick, once the session is idle; it is cleared and counted before the submit, so a slow submit sends it once and is not retried. It survives a reload and is dropped after 10 minutes.
- **Residuals.** Any process that can write a `compact` cue can make a lane take one fixed nudge turn per 30 minutes. The restore hint does not carry nudge counts, so a restore can cost one extra nudge.

### Design addition v13: park, unpark and the automatic rebind

- **Records name their session.** A store record carries `sid` (the bound session) and, while parked, `parked` (a time). Neither is in the record hash or the lead's watch hash. A bound session writes its own id once per binding; off, retire and terminate clear it; park keeps it.
- **`lane_park` / `lane_unpark`** as above. `lane_unpark` writes `~/.claude/callboard/open/<LANE>.reopen` with the record's session id; the extension reopens that conversation only for a lane whose record names it. Refusals: `no-saved-session`, `session-live`, `name-in-use`, `reopen-timeout`.
- **Automatic rebind.** At start, a session that exactly one record names, sitting in the lane folder, in a person's session, with no other live session on the name and no lead grant, binds as a restore binds (it can never `start`; its limits carry over) and appends the lane note once.
- **Lead re-grant.** `lead:<sid>` = `{ pin, savedAt }` in `$.store` makes the session lead again at its next start in the same folder, with no question. Off and Cancel delete it; an off during a restore wins.
- **Retire or park.** Retire is final (the record's session id is cleared); park a lane that may be needed again.
- **Residuals.** Any same-uid process can write `lead:<sid>` and make a session a lead at its next start with no dialog (terminate still asks; retire and park need the target's confirmation; the store lanes it reaches were already in reach of such a process). It can set `sid` and `parked` to rebind a chosen session into a lane whose folder it sits in, or have a window reopen a chosen conversation there. Each rebind appends one note. A terminal lane is reopened as a panel. A session on an older mod that writes the store drops `sid` and `parked`: restart all sessions after install.

### Design addition v13.2: keepalive pings and `/callboard config`

- Decisions: the mod sends the keepalive the manager sent by hand, and the manager stops (D1); a session past its level is nudged instead of pinged, never both (D2); only the person changes a setting (D3); every interactive session is pinged (D4, amended in v13.5 from "only sessions with callboard on"); a lane signed done is not pinged (D5).
- **What is real work.** The ping, nudge, notice, check-in and lanes-changed turns are not; the person's prompts, a peer's message, a lead's start and resume and the compaction continuation are. The engine skips a plugin's own hooks for that plugin's own submits and hands `turn.start` the text in a fixed frame ("The callboard plugin sent a message:"), so the mod tells its own turns by their text. If the engine changes the frame, own turns read as real again: the stop clock never runs out and a ping moves a lane's turn mark.
- **A late change wins.** Right before a ping or nudge the step reads the box and the submits again; any change misses that gap.
- **Sleep.** A gap of more than 5 minutes between two timer calls means the machine slept; that idle gap gets no ping.
- **`CLAUDE_CONFIG_DIR` (v13.3).** A session's own row is looked up under that variable only when it is exactly `~/.claude` or a clean folder under `~/.claude-conductor`, its own real path; anything else gives no row and logs `error config-dir-rejected`. Everything about other sessions and cues still reads `~/.claude/sessions` alone, so lanes and leads must start without the variable.
- **Install check (C11 re-probe).** After install, run `/callboard config ping 45` once through the model and once typed. The typed one must apply and the model-run one must be refused (`refused config-not-person`). If the model-run one applies, the origin check guards nothing and only the bounds stand.
- **Residuals.** Any process running as the person can write the `config` key; the origin check is a convenience. The bounds are the control: at worst a ping every 30 minutes for 8 hours after the last real work (16 pings, each about 0.1x of the context in cache reads), keepalive off, or levels anywhere from 150k to 900k. A forged `kind: interactive` row makes a worker pingable and nudgeable. An idle chat the person forgot is kept warm for up to 3 h.

### Design addition: lanes name their lead, several leads in a repo (levels S2, S2b)

- A store record may carry `leadName`: the lead's session name, read only from the live registry (exactly one row for the session id, a valid lane-style name, not reserved, carried by no other live row in any letter case). The name is the key because a lead restarts with a new session id and keeps its name. Any name source counts.
- A second `/callboard lead` in a repo needs a usable name for this session and every other lead there (`lead-name-taken`, `lead-needs-name`, `other-lead-unnamed`), checked before the dialog and again after a yes; a lead restore runs the same gate.
- With several live leads the Join dialog first asks "Which lead should this lane join?" (up to 4 names, then `More…`).
- **Residuals.** The lead's name may be an automatic title; a retitle puts its lanes out of reach, and a later session that takes the title and becomes lead reaches them. Lanes made while a lead was alone and unnamed stay legacy. Two leads that start at the same moment can both pass. The registry and presence files are same-uid writable: the name is a filter between honest sessions.

### Design addition: lead check-ins and the grouped lane list

- **What it watches.** Once a minute, beside the tick (a slow read never holds a cue), the lanes in the lead's reach and the registry; parked lanes skipped; a failed read is no observation, never "all gone".
- **Triggers.** `gone`: no live row for 3 observations, the lane was live and its report is not signed done. `prompt`: waiting on a permission prompt or input for 5 minutes. `quiet`: idle for 30 minutes without signing done. Reports are read only once a notice is due and every gate holds.
- **When.** Check-ins on, not paused, no wake from sleep in the last 30 minutes, the lead idle 20 minutes or more, and the keepalive's gates (no dialog, request, nudge, background work or draft, an idle interactive row). One fixed turn listing lane names only (at most 8), once per lane, trigger and start time, sharing the cap of 12 an hour with the lanes-changed notice.
- **Pause and switch.** `/callboard checkin pause <N>m|<N>h` (person only, up to 24 h) and `/callboard config checkin on|off`.
- **Residuals.** The pause and what the lead saw are lost at a restart. A sleep under 5 minutes is not seen. A legacy lane notifies every lead of its repo. A forged registry row can make a lane look waiting or quiet: the worst case is a wasted lead turn. A step that hangs on an engine read stops check-ins in that session until a reload (`checkin-stalled`).

### Design addition: manager level, manager tools and check-ins (v14, 2026-11-04)

- **Grant.** `/callboard manager [NAME]` from any origin, one dialog (header `Manager`). Refused before and after the dialog in a lane, a lead, a session that was a lead, and while another live session holds a valid manager presence file (or a fresh one whose check could not be made). The presence file says `level: manager` and the name, never a repo; it must be written or the grant steps back, and two managers written at once both step back. The session is renamed to NAME from the tick.
- **Tools.** `lane_list` (every repo), `lane_resume`, `lane_compact`, `lane_terminate`, `lane_retire` (and `lane_remove` until v15.3); every other lane tool refuses `manager-tool`. This is the one exception to the manager role's hard line in ADR 0001: a stop or a remove at manager reach only through its own dialog, which the person answers every time, never unattended. `lane_retire` asks first ("Retire lane X in REPO?"). Both stops refuse a target that holds a presence file of any level (`target-is-lead`) and a lane whose record names another session (`sid-mismatch`), before and after the dialog, and check the grant level once more right before the signal (`grant-changed`).
- **`lane_remove` (v14.1; dropped in v15.3).** One lane, or up to 12 lanes of one repo, behind one dialog (`Remove`/`Cancel`) that names any parked lane. Refused whole, naming the lane, for an unknown lane, a root-file lane, mixed repos, a lane a live session carries by name or by recorded session, or a presence holder; every check runs again after the click and inside the store lock, and all go in one write or none.
- **Compacting a lead.** `lane_compact` with a live lead's session name sends that lead a `compact` cue. A lead acts on it only on its own armed on-cue request, only while another session's manager file passes every presence check and the registry gives that session a reserved name. A lead's system prompt carries a `callboard:lead-manager` section while its tick sees such a manager (looked for once a minute, never read from a file at render time).
- **An adopted lane with no live lead** takes `resume`, `compact` and `retire` from a trusted manager; anything else stays `no-lead`.
- **Check-ins** as a lead's, over lanes no live lead reaches.
- **Soft and hard nudges** (see Keepalive and compaction nudges).
- **Residuals.** The grant is memory-only. One manager per machine rests on the presence-file check, so a same-uid process whose file names a live claude pid can block a manager's start. Where a manager file is trusted, such a process can at most make a lead act on its own on-cue request, or a lead-less adopted lane take a cue it confirms itself. A stale record `sid` blocks the manager's stop until the lane restarts; the lead or the person can still stop it. Root-file and older records have no `sid` and are matched by name and folder, still behind the dialog. The manager runs with no settings file of its own: its deny and ask limits are convention in its role, not enforced. The rename right after the grant is unprobed; its outcome is logged.

### Design addition: conductor level (v15, PR 2 of the levels plan)

- A conductor is a bigger lead: a session in a small repo of its own whose reach is a list of repos. It lists their lanes, compacts their leads (only a lead that asked on-cue) or a lane in reach, and force stops a lane through the person's dialog. It never creates, opens, starts, resumes, parks, unparks, retires or removes a lane (`conductor-tool`) and cannot stop a lead. No check-ins, no lanes-changed notice.
- **The list.** `<conductor repo>/.claude/callboard-conductor.json`: `{ "repos": [...] }`, entries `../NAME` or an absolute path, at most 16 entries and 4096 bytes, each resolved to its own real path, a git root, not too broad, never the conductor repo or a repo inside or around it or another listed one. The conductor repo must have no lanes and no lead. The writer and reader refuse a `.claude` folder or file that is a link, has two links or is writable by group or other.
- **Changing it.** `/callboard conductor add` (person only, a dialog naming the repo and the whole resulting list) and `remove` (person only, no dialog: it only narrows). Paths in dialogs show a sibling as `../NAME`, anything else in full, never cut; a list no question could carry is refused (`conductor-list-long`).
- **The file only narrows.** Reach is the file, resolved, intersected with the approved list, at every tool call and every 10 s. A repo written into the file by anything but an `add` click in this session is not reached until the person approves it in a dialog that names it first. A repo that leaves the file also leaves the approved list.
- **Restore.** `conductor:<sid>` (the conductor repo and the approved list) brings the grant back at the next start of the same conversation, in the same folder, in a person's session, not a lane on its way back and not a lead. A file naming a repo not yet approved asks first, once the session is idle; Cancel deletes the saved grant.
- **The lead's side.** A lead takes `compact` from a conductor only on its own on-cue request and only while the conductor checks out: a live presence file listing the lead's repo, its home a real git root, its saved grant approving the repo, its list file listing it. While one does, the lead's briefing (`callboard:lead-conductor`) names it: act only on messages from exactly that session name, follow them when safe, take a stop as a pause and ask the person, reply with branch, tests and review verdict. The manager's `lane_list` shows each live conductor as a box holding its repos' lead boxes.
- **Setup.** The setup guide (`docs/setup.md`) lists deny rules for the Edit and Write tools on `**/.claude/callboard-conductor.json` and `~/.claude/plugins/store/callboard_*.json` for the global settings, added by hand. They stop an agent's edit tools, not a shell write.
- **Residuals.** A same-uid process, the conductor's own shell included, can write the saved grant and the list file and so restore a conductor with up to 16 repos of its choice at its next restart, with no dialog; it gains a read of lanes, a lead's compaction on its own request or a lane nudge, and a force stop behind the person's dialog. A forged `kind: interactive` row passes the person gate. Messages between sessions have no sender proof. Conductor names are not reserved. The first grant opens from any origin, as `/callboard lead`.

### Design addition v15.3: manager restore, shorter list headers, waiting retire and park, retire and terminate remove the lane (2026-11-06)

- **Manager restore.** The person's yes to `/callboard manager` saves `manager:<sid>` (the name and a time) in the mod's store, refreshed daily while the manager runs; `/callboard off` and a Cancel on the restore question remove it. When the same conversation starts again, the tick shows the usual Manager dialog (a restore question, `Manager` and `Cancel`) once the session is a person's (a registry row of kind `interactive`), idle, with an empty prompt box, and holds no grant in memory (a compaction keeps it, so it asks nothing). Manager runs the usual grant with every check again after the yes; Cancel deletes the mark; no answer keeps it and restores nothing; a failed check is logged and restores nothing. Modelled on the conductor's saved grant. Residual: a same-uid process can write the mark, but every restore still goes through the person's dialog. This replaces "the grant is memory-only" above and in ADR 0001, which are left as written.
- **List headers.** A `lane_list` box header names the repo by its folder name, not its path; a lane's own Folder column is unchanged.
- **Retire and terminate remove the lane; `lane_remove` is dropped.** Once the session has ended after its signal (a survivor keeps its record), `lane_retire` and `lane_terminate` delete the lane's store record (the `.archive/<LANE>/` folder and signed report stay); a lane a session joined keeps its record; `lane_park` is the only stop that keeps a lane. A lane with no live session is cleared the same way: `lane_retire` needs no signed report (nothing runs) and asks only for a parked lane or at manager reach, `lane_terminate` asks the person, and the v14.1 liveness checks run before the dialog, after the click and inside the store lock. The manager's batch remove is folded into the two stops, one lane per call. Decided by the person (2026-11-06): a record kept after a retire left lanes that only `lane_remove` could clear, and a second tool was one more thing for a lead to mis-time. The conductor's `lane_terminate`, which asks the person, can now remove a record too. A lane a session joined keeps its record, and with `lane_remove` gone nothing removes it but `/callboard lane off` in that session (an open question for the person). Residual: a stop that removes a record is not undone by lane_unpark; the session's conversation file is still on disk.
- **Retire and park wait for idleness.** The lead's call polls the registry every second for up to 40 seconds for the 30 idle seconds the target must have, then refuses `not-idle` naming the seconds left. A lead that called early used to be refused and retry in a loop. The lane's own confirmation is unchanged.

### Design addition v15.1: per-machine reserved names

- **The built-in list is `MANAGER` alone.** A machine reserves its own names with `/callboard reserve NAME` (list: `/callboard reserve`; remove: `/callboard reserve remove NAME`). The list is kept in the mod's store, so no other machine gets those names, and no session name of one machine is written into the code.
- **Who changes it.** Only the person: the prompt or the phone. Any other origin is refused with a fixed text. An add is refused while a lane record, a lead stamp or a live lead carries the name or a look-alike of it; a name under 3 characters or with no letter is refused; the live manager's name cannot be removed. The change is applied to a fresh read just before the write.
- **What it guards.** A reserved name, or a look-alike (other case, `-` or `_`, trailing digits, look-alike digits), cannot be taken by a new lane, a join, a rename or a lead: `/callboard lead` in a session with such a name is refused `lead-name-reserved`. The manager may carry a reserved name exactly as written. Stored lane lists and lead stamps are judged by `MANAGER` alone, so a later reservation never makes a store unreadable.
- **Freshness.** Lane creation, joins, `/callboard lead` and `/callboard manager` read the list fresh; other checks see a change within a minute. A failed read keeps the last good list and is retried.
- **Residuals.** The list is a store value a same-uid process can write: a convenience, not a control. A cleared list unreserves the machine's names; a forged one can reserve a live lead's name, whose lanes then refuse its cues until `reserve remove`. Manager trust is unchanged: a lead still needs a verified manager presence file. The panels extension knows `MANAGER` only.

## Probes

Probes named by the design and the README. Status as recorded; "open" means not run against a live engine.

**Compaction (P1-P8, from the first design).**

- P1: CLI and VS Code: a request is followed by a compaction after the turn ends, then one `[compact-cue]` resume turn. Open.
- P2: a request made mid-turn waits for the turn's end; a direct `$.session.compact` during a turn rejects. Open.
- P3: a background subagent still running at the turn's end gives `background-work` and no compaction. Open.
- P4: a draft in the prompt box gives `draft-in-box`; the draft is kept and no turn is submitted. Open.
- P5: a PreCompact hook that blocks gives a skip, then the fixed notice turn. Open.
- P6: in auto mode the plugin-origin turn is not treated as the person (no approval, no intent signal). Open; an install gate.
- P7: a subagent calling `request_compact` is refused, and the tool call carries `agentId`. Open.
- P8: quit or `--resume` between compaction and resume: no resume after the restart, the request logged `dropped`. Answered in part by L8: `$.state` does not survive a VS Code restart.
- P-L: a settings `ask` rule on a mod-registered tool does not prompt in a Manual-mode panel. Answered, live: ask rules do not gate mod tools.

(The callboard README's manager section ("unprobed (P6)") and its `/color` note ("P2") are probes of the levels plan, not the P1-P8 above: a rename right after the manager grant, and a command run from a timer rather than from inside a hook.)

**Lanes (L1-L9).**

- L1, L2: owner, mode and link count through `$.fs.stat`; read, rename, delete and append under the cue folder. Superseded by the build: `$.fs` has none of these, so the mod uses fixed process calls, which the live checks still owe.
- L3: a restored panel runs the mod. Open.
- L4: a session that is not bound ignores every verb. Open.
- L5: several panels opened one after another each get their own identity. Open.
- L6: a real MANAGER sender, several lanes at once, Remote Control with a cue-driven panel. Open.
- L7: session start time and turn count exist. Answered in part in the lab: the turn count exists, and the rename itself writes one turn, so `start` compares with the count stored at the bind.
- L8: `$.state` across a restart. Answered in the lab: lost on a VS Code restart; `$.store` survives.
- L9: owner and mode of the `$.store` file; another plugin cannot read or write this plugin's keys. Partly answered by C13.

**Commands and actions (C1-C13).**

- C1: no definition survives in the design record; the check-in section names a C1 for a clock-time pause (`pause HH:MM`), not built and not run.
- C2: the focus is carried through `command.run` in a panel. Open.
- C3: origin marking on `command.run` actions. Open.
- C4: hold behaviour in auto mode. Open.
- C5: `$.prompt.submit` and `command.run` from a mod in a terminal session. Open.
- C6: PostCompact is visible to the mod. Open.
- C7: a person's message during the resume cancels it in a panel. Open.
- C8: a cancel for a held `command.run` or submit. Open; until one exists, a held action runs after a Deny (a recorded residual for every verb).
- C9: a draft typed between the draft check and the action. Open.
- C10: a second plugin named `callboard` does not get the mod's origin exemption. Open; own turns are told by exact text, not by plugin name.
- C11: a model cannot invoke the `/callboard` slash command with a person's origin. Open; re-probe at install (see v13.2).
- C12: `$.ui.ask` in a panel is answered only by the person and rejects when dismissed. Open; another loaded plugin may answer it (install rule below).
- C13: a plugin passing a `composer` origin to `$.command.run` is still refused, `$.state.set` on callboard's keys from another plugin is denied, and another plugin's `$.store.keys()` does not list callboard's. Answered in the lab.

**Engine findings (probed, engine 2.1.316).** A plugin's own `$.prompt.submit` skips that plugin's own `prompt.submit` hook; `turn.start` carries the submitted text inside a fixed frame. `prompt.compose` renders once per conversation, so a mid-session grant needs the user-role note.

## Not verified live

- The cue-to-action paths (tick, claim, rename, start, resume, compact, the PostCompact resume, the deferred `now` compaction) run against mocks only. The installer's sudo branches run in tests only through `--no-sudo`.
- Every design addition from v12 on is built and mock-tested, not live-tested: the nudge and its texts, park, unpark and the rebind, the keepalive and `/callboard config`, the `CLAUDE_CONFIG_DIR` lookup (and whether `$.store` follows the config root), the check-ins, the manager level and `lane_remove`, the conductor level.
- Checked live: the Join dialog in a panel and in a terminal, the deferred rename, `lane_list`, the lanes-changed turn, the `adopted-record` refusal, detach and the presence file's removal at session end (2026-10-30); the short dialogs and `lane_remove` of a made and an attached lane (2026-10-31); the default load from the settings `env` line with VS Code opened from the Dock (2026-11-01); `lane_start` answering within its 6 s deadline (lab).
- Still owed: a stop in the middle of a tool call; a hot reload with a pending request; the real `ps` and `kill` paths of both stops; the terminate re-check after a click; whether the tab label equals the registry name; an install-time check that no other hook-capable plugin loads.

## Consequences

- A lead names, starts, resumes, compacts, parks and stops lanes with nothing typed by the person, in panels and terminals, and no text from a cue ever reaches a model. Every interactive session keeps its cache warm and is told to compact before its context grows costly.
- New surface: the cue, result, open and leads folders under `~/.claude/callboard/`, the lane stores, the `$.store` keys (`lead:`, `conductor:`, `sess:`, `cmp:`, `config`), the conductor list file and the brief files.
- **Accepted residual: same-uid forgery.** Any process running as the person can write cues, result files, open and close requests, store records, presence files, registry rows, `$.store` keys, the conductor list and the settings line that loads the mod. Nothing here defends against code already running as the person; that code could send the signal or edit the files itself. What bounds the gain:
  - cues carry no text; every submitted turn is fixed text that carries no approval;
  - the target runs its own checks (binding, record hash, folder, birth window, idle, empty box, background work, signed report);
  - limits in the reader: 12 resumes an hour, one compaction per 30 minutes over 100k tokens, one nudge per 30 minutes and 3 an hour, 16 pings per idle stretch, 12 notices an hour, 12 creates an hour, 16 lanes per repo, 6 panels a minute and 8 live sessions per repo;
  - each prompt notice to a lead is a full-context cache read on that session; capped at 30 notices an hour per lead (its own counter, separate from the lanes-changed counter); at the cap with a 200k context that is about 6M cached tokens an hour, normal load about a quarter of that;
  - every force stop and every remove asks the person; retire and park need the target's own confirmation; a stopped session is resumable from history;
  - the read-only stores folder switches off the lead-less chain.
- **Accepted residual: other plugins.** Another plugin loaded in the session can run `/callboard` and may answer its dialogs. The install rule is that callboard is the only plugin on `CLAUDE_CODE_PLUGIN_DIRS`; plugins that load from a repo's `.claude/skills` remain an open gap.
- **Accepted residual: briefs and messages.** A brief, a lead's message or a lane's report is data at the trust level of its writer; risk-list work still needs the person's own turn.
- Ask rules cannot gate mod tools, so `request_compact` and `lane_retire` run unattended; their safeguards are the self-only content path, the idle check, the signed report and the repo scope.
- Dependencies: mods are new (2.1.299 and later); `$.session.root()` needs 2.1.316 (older engines fall back to the live folder). If the person declines the engine's mods question, the mod is inert and the manual path remains.
