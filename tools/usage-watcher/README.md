# usage-watcher

A launchd job that runs every 5 minutes, reads only the usage metadata appended to Claude Code session logs since its last run, and writes one bounded file: `~/.local/state/usage-watcher/usage-summary.json` (≤4 KB). MANAGER reads that file and runs the runaway flow in `docs/manager/usage-watch.md` (ADR 0001, `docs/adr/0001-manager-role.md`). The keep-warm pings and compact-soon nudges are callboard's. The watcher only measures. It never messages a session.

Built from a design spec (not in this repo; "spec §N" below refers to it) with thresholds from the 10-17 to 10-24 token pass and a review folded in, then a code review and a security audit of the first build.

## Files

| File | Purpose |
|---|---|
| `watch.py` | The watcher. Python 3.9 stdlib only, run by the pinned `/usr/bin/python3 -I`. |
| `test_watch.py` | Fixture tests: `/usr/bin/python3 -I tools/usage-watcher/test_watch.py` |
| `io.notitial.usage-watcher.plist` | launchd template (`__HOME__` and `__CONFIG_DIR__` are filled in at install; see Install below). |
| `pace-vectors.tsv` | Pinned copy of the status line's pace answers, which `test_watch.py` checks `pace()` against (see Parity, below). |
| `account-stamp.sh` | SessionStart hook recording a session's account label (see Two accounts, below). Tests: `test-account-stamp.sh`. |
| `install.sh` | The installer: fetches a commit of `main` over HTTPS and installs from it (see Install below). |
| `test-install.sh` | The installer's sandboxed tests: `bash tools/usage-watcher/test-install.sh` |

The output dir (`--out-dir`, default `~/.local/state/usage-watcher/`) must be a real directory owned by the user; the watcher refuses a symlink or a foreign owner and tightens the mode to 0700. It holds:
- `usage-summary.json`
- `state.json`: per-file offsets and 10-minute buckets for 24h, and one dedupe-key map for all files (24h). Over 4 MB, it first drops dedupe keys older than 6h, then is discarded with `stateDropped: true` in the summary.
- `run.lock`: a mkdir lock, cleared when older than 10 min.
- `heartbeat.log`: one `start` and one `end` (or `skip`/`fail`) line per run, opened `O_NOFOLLOW`, truncated past 16 KB. A gap in it while the Mac was awake means launchd did not start the job.
- `meter-history.log`: the meter's past readings, since the statusline overwrites the meter file on every refresh. One line is appended when the readings differ from the last line's, or when the newest observation is an hour or more (`METER_LOG_REFRESH_S`) past the last line's `harvest` time (the refresh follows observations, not the wall clock, so nothing is added while no one observes): `harvest=<time> 5h=<pct>% reset5h=<time> 7d=<pct>% reset7d=<time>`, with `-` for a window the meter does not have (or whose reset has passed). `harvest` is the newest live observation of either window, so a meter with only a weekly reading (no five-hour reading since a reset) is still logged. A window whose own observation is older than its freshness limit (30 min for the five-hour, 6 h for the week) before that time is written as `-`, so a borrowed five-hour value is never stamped with the weekly time; a five-hour value whose `observed_at` is unknown is written as `-` too. The time alone never decides, because an `observed_at` moves on every render. Opened `O_NOFOLLOW`, mode 0600; past 256 KB the oldest half is dropped at a line boundary. A window whose `observed_at` is missing or `-1` does not count as an observation (its time would be the file's mtime, which moves on every statusline render), and a meter with no counted window is not logged. A write failure is logged to `watch.err` and never fails the run. Lines ending `src=tracker` were seeded once from the readings MANAGER wrote in its tracker (tick time, not harvest time).
- `meters.json`: the 5h and 7d windows per account with their pace, rewritten every run (see below). Readers use this file, not the readings.
- `limits/readings-<fp>.json`: raw readings, written by whoever sees a live number: the status line does, one file per account (the schema is below).
- `accounts/<sid>.json`: the labelled account a session runs on, written by `account-stamp.sh` at session start (see Two accounts, below). The watcher only reads it.
- `watch.err`: written by the watcher itself through an `O_NOFOLLOW` fd (launchd's stdout and stderr go to `/dev/null`), truncated past 64 KB.

Temp files come from `mkstemp`, and every file the watcher opens is opened with `O_NOFOLLOW` and must be a regular file.

## What it reads, and what it never reads

- **Reads:**
  - `<config-dir>/projects/*/<sid>.jsonl` and `*/<sid>/subagents/**/*.jsonl`: the top-level `type`, `timestamp`, `requestId`, `isSidechain`, `entrypoint`, `subtype`, `customTitle` and `agentName`, plus `message.id`, `message.model` and the `message.usage` token counts.
  - `<config-dir>/sessions/<pid>.json`: `sessionId`, `pid`, `name`, `kind`, `entrypoint` and the `cwd` basename. A file counts only when its name matches its `pid` and that pid is alive.
  - `<spool>/limits/personal-windows-*.json`, the status line's meter files, from an optional spool input (`--spool`), read only and only when present.
- **Never reads** `sessions/*.key`, `~/.claude.json`, settings, hooks, env or credentials. It does not open `subagents/*.meta.json`, because its `description` is task text and the model comes from the log records.
- **Message text:**
  - A line is parsed only when its raw bytes contain `"type":"assistant"`, `compact_boundary`, `"type":"custom-title"` or `"type":"agent-name"`.
  - The type is then checked on the top-level key. Only the fields above are copied into a fresh dict, with titles and entrypoints allowlisted at that point, and then the parsed object is dropped.
  - Content passes through memory during `json.loads` and nowhere else.
  - Errors log a path and byte offset, or an exception class name, never a line or an exception message.
- **Writes** nothing outside the output dir. No network, no messages.
- **Hostile input:** a usage field over 10^8, a timestamp more than 5 min in the future, or a non-finite meter value is rejected as corrupt. An error in one file is logged and that file skipped, and a run-level error exits 1.

## Copied history

A resumed or forked session's new log starts with the old session's records: the same `message.id`, `requestId` and original timestamps. In the last 24h on this Mac that was 98M tokens. So the dedupe keys are shared by every file and kept 24h. The file that first supplied a key owns it, and a copy adds only a later increase. On a rebuild, files are read oldest-created first, so the original owns the history and the copy's context ring holds only its own calls. Truncating or rotating a file drops the keys it owns and re-reads it.

## The summary

- `alerts` (at most 5) each carry `sid`, `sid8`, `name`, `live`, `kind`, `addr`, `src`, `level` and `why`.
  - `addr: true` means the session is live and interactive. Its name also came from the session registry unchanged by the allowlist and is unique among live sessions, so ListAgents shows exactly that string. Only such alerts are addressable, and only to a `ListAgents` row that is a session on this machine (usage-watch.md, Runaway sessions).
  - Ended sessions never alert.
  - A meter alert (`src: "meter"`) names the top live burner, or carries no `sid` when nothing on this Mac is burning.
  - A pace alert (`src: "pace"`, level always `warn`, never `runaway`) names no session. It fires per window when the current pace projects the window's end past its line (5h 100%, weekly 90%, the lines the status line used to colour on) and at least 25% is used; `why` is `["fivepace 200% >= 100%"]` or `["weekpace 140% >= 90%"]`. Only on a fresh reading: the five-hour window needs a five-hour reading seen within 30 minutes, the week its own reading seen within 6 hours (`WEEK_FRESH_S`). It is advice to the owner about their own burn rate, not a session to stop: it starts no stop-and-handover flow.
- `meter.fresh` and `meter.harvestedAt` describe the five-hour window only. `meter.weekFresh` and `meter.weekSeenAt` are the weekly window's own pair (fresh while seen in the last 6 hours), so a live weekly figure is not read as stale just because the five-hour one is.
- `meter.five_hour` and `meter.seven_day` each carry `pct`, `resetsAt`, `projectedEndPct` (used ÷ time elapsed, the status line's integer maths) and `paceState` (`idle`, `ok`, `watch`, `warn`, `hot`, or `stale` with a null projection when the meter is not fresh).
- `top` holds at most 8 sessions by window tokens, plus up to 4 leveled sessions outside them. Each row adds `nameSrc` (`registry`, `log` or `sid`), `entrypoint`, `project`, `tok`, `opus` and `sub` (fractions), `share`, `burnH`, `ctxNow`, `ctxAvg`, `compToday`, `calls` (last hour) and `last`.
  - The per-model split stays in `state.json`; only the opus and subagent fractions go out, to keep the summary under 4 KB. This is the review's "change §2 to match" option.
  - **Share trial (ran 2026-11-01, ended).** With `TRIAL_HOURS = (1, 2, 3)` each row also carried `shareH` (the session's share over the last 1, 2 and 3 hours) and the summary carried `shareHours`. The readings showed 1h is noisy and 2h and 3h track the 5-hour share within 0.03-0.08, so the 5-hour `share` stays and `TRIAL_HOURS` is `()`: neither field is written. The mechanism stays in `watch.py` for a later comparison. While on, no alert reads the fields, and if the summary would pass 4 KB they go first, before any row, with `trialDropped: true`.
- `cacheExpiring` (at most 5, largest context first) lists live sessions with `ctxNow` ≥200k (`--cache-ctx-min`; the keep-warm break-even sits near 200k) whose last main-thread call was 20–50 min ago, so their 1-hour prompt cache is about to lapse. Each entry has `sid`, `sid8`, `name`, `addr`, `ctxNow`, `idleMin`, `workIdleMin` and `due`.
  - `due: "ping"` while the session did real work (a main call with over 200 output tokens) in the last 3 hours; after that `due: "checkpoint"`, because compacting and parking is now cheaper than more pings.
  - A `[keepalive]` reply is a short main call, so it resets `idleMin` but not `workIdleMin`: a pinged session reappears at the next 30-minute MANAGER tick (about every 30 min) and turns `checkpoint` 3 hours after its last real work.
  - MANAGER ignores `due: "ping"` entries: the callboard keepalive pings idle sessions itself. It lists `due: "checkpoint"` sessions for the owner.
- `compactSoon` (at most 5, largest context first) lists live sessions active in the last 30 min whose `ctxNow` is ≥250k. Each entry has `sid`, `sid8`, `name`, `addr`, `ctxNow` and `crossedAt`.
  - `crossedAt` is the run that first saw the session over the line. `state.json` keeps it until the session's context drops back under 250k (a compaction), so one crossing keeps one `crossedAt`, and the list is kept for reports only: the callboard compact nudge replaced MANAGER's `[compact-soon]`.
  - When `state.json` is dropped, every session over the line gets a new `crossedAt`, and may be nudged once more.
- **Every string is data.** Session-controlled strings are reduced to `[A-Za-z0-9 _.-]` (anything else becomes `_`) and cut to 24 characters.
- Over 4096 bytes, things are dropped in this order: the trial figures, rows from the bottom of `top` (unleveled first), `compactSoon`, `cacheExpiring`, then the whole `accounts` list, then `alerts` (the runaway flow's only input). `meter` and `window` are never dropped. `"truncated": true` is set when `top`, `compactSoon`, `cacheExpiring` or `alerts` lost entries, and `"dropped": [...]` names every section that lost anything (`top`, `compactSoon`, `cacheExpiring`, `accounts`, `alerts`), so an emptied list reads as "cut for size", not "nothing due". The trial figures keep their own `trialDropped` and are not named in `dropped`.
- **Forgeable.** Any same-uid process can write the summary, so MANAGER treats it as a signal and drops a malformed one.

## Thresholds

Spec §3 as decided, with these changes from the reviews:
- No session gets a level with fewer than 10 calls in the last hour.
- `share` warns at 50% and runs away at 65% (was 35% and 50%, 2026-11-01). With two or three busy lanes one of them is always above 35%, and every share ask that day ended in "Don't send". The alert text carries the numbers in force (`share 52% >= 50%`).
- `ctxAvg ≥ 250k` warns only together with a burn or share warn; on its own it sits near the 202k median.
- The context and compaction lines count only for a session with a call in the last 30 min, so an idle or ended session stops alerting on its last big turn.

A warn needs its line on two consecutive runs; a runaway needs one. `burnH` is the last three complete 10-minute buckets (exactly 30 min, as calibrated) × 2, so it runs up to 10 min behind. `share` applies only when the window holds ≥100M and the session ≥30M.

## Window and meter

- **Window.** The window is `[resets_at − 5h, resets_at)` whenever the meter's 5-hour `resets_at` is in the future: the bounds don't move even when the harvest is old.
  - Otherwise (`window.source: "rolling"`, since 2026-11-01) it is the last 5 hours as whole 10-minute buckets: `start` is the bucket bound 5 h before `end`, and `end` is the close of the bucket holding now, so the call in progress counts. It covers 5 h minus up to 10 min of real time and moves every run. Before this, a guessed fixed block (`source: "estimate"`, carried in `state.json`) stood in; it misplaced `share` whenever the account had no live window, so it is gone.
  - `share`, the share gate and the session alerts use whichever window is current. The total in `window.tokens` is the machine's tokens in it.
  - **Ask dedupe on a rolling window (for usage-watch.md).** `window.start` moves every run, so "once per 5-hour window" cannot key on it. While `window.source` is `rolling`, ask at most once per sid and level per 5 hours of clock time, counted from the last ask for that pair; an escalation from warn to runaway still asks again. While the source is `meter`, key on the window as before (`window.end`, the meter's `resets_at`). Switching source between runs does not reset the record of a past ask.
- **Which meter file.** The statusline writes one `personal-windows-<fp>.json` per account. The fingerprint comes from `~/.claude.json`, which the watcher never reads. So the meter is used only when exactly one file exists, or when `--meter-fp <fp>` names one; when it is ambiguous the summary has no meter. A file of a labelled account (it carries a `label`, see Two accounts) is not counted, so a second account no longer takes the main meter away.
- **Freshness.** `meter.fresh` needs the 5-hour `resets_at` in the future and the 5-hour value last seen live in the last 30 min, from that window's `observed_at` (the statusline writes it since q5, 2026-10-27; `-1` means unknown and is never fresh).
  - The statusline rewrites the file on every render even without a new value, so the mtime says nothing about the value's age. A file from before q5 has no `observed_at`, and then the mtime is used as before, which can overstate; within one window the percentage only rises, so that makes a meter alert late, never false.
  - A window whose `resets_at` has passed is dropped (the weekly one too): its percentage describes the last window.
  - Meter alerts fire only on a fresh meter.
- **Scope.** The meter is account-wide; the per-session numbers cover this Mac only.
- **Keeping the meter fresh (spec §9, picked 2026-10-24): keep one CLI session rendering.** MANAGER runs in a CLI terminal, and each tick is an API turn that re-renders the statusline, so the meter stays as fresh as the tick while MANAGER runs.
  - Do not set `statusLine.refreshInterval` for this: an idle re-render re-stamps an old percentage as fresh.
  - When no CLI session renders, the watcher's log-based thresholds still work.

## Pace and `meters.json`

Designed 2026-10-29. This part ships dark: nothing reads `meters.json` yet.

- **Readings in.** Per account fingerprint, `<out-dir>/limits/readings-<fp>.json` first, else the spool's `personal-windows-<fp>.json` for an account the new directory lacks. Shape: `{"v":1,"account":"<fp>","label":"<label>","five_hour":{"used_percentage":7,"resets_at":<epoch>,"observed_at":<epoch>,"src":"statusline|mod|probe"},"seven_day":{...}}`. An unknown `src` reads as `statusline`; a missing `observed_at` falls back to the file mtime. `label` is present only for a labelled account and must match `[a-z0-9][a-z0-9_-]{0,15}` (else it is dropped). Files over 64 KB, symlinks, non-hex names and at most 8 accounts are skipped.
- **`meters.json` out.** `{"v":1,"generatedAt":<epoch>,"accounts":{"<fp>":{"fiveHour":W,"sevenDay":W,"label":"<label>"}}}` (`label` only for a labelled account), all times in epoch seconds, written atomically with mode 0600. `W` is `null` when the window is absent or past its reset, else `{used, windowStart, windowEnd, elapsedPct, projectedEndPct, state, hitsAt, observedAt, ageS, src, fresh}`.
- **Pace.** `elapsedPct` is the whole percent of the window gone (floored). `projectedEndPct = used*100 // elapsedPct`, the status line's overshoot, or `null` while `used` is 0 or `elapsedPct` is 5 or less. `state` is `idle`, `ok`, `watch`, `warn` or `hot` (or `stale`, below): the colour tiers of the status line's `rate_color_for` (ai-toolkit `tools/statusline.sh`) (grey, 144, 131, 168) with the same limits: 5h warns above 100, weekly above 90, and below 25% used it never goes past `watch`. `hitsAt` is when the pace reaches 100% (epoch), only if that is before the window ends.
- **Fresh.** 5h: seen live in the last 30 min. 7d: in the last 6 h. A reader dims anything not fresh and shows `ageS` (`null` when the reading carries an unknown age, such as `observed_at: -1`: that is never fresh, and only a file with no `observed_at` key at all uses its mtime); it never invents a value. A not-fresh window has `state: "stale"` and no `projectedEndPct` or `hitsAt`, because a projection divides an old reading by the time elapsed now. A percent above 100 is not accepted (the window is dropped). A readings file that parses keeps its account away from the spool fallback, even if both its windows are past. `generatedAt` older than 15 min means the watcher is down.
- **Parity.** `pace-vectors.tsv`, beside `watch.py`, holds the answers of the bash `rate_color_for` for 6.4k inputs; `test_watch.py` checks every row against `pace()`. It is a pinned copy of ai-toolkit's `tools/pace-vectors.tsv` (https://github.com/notitial/ai-toolkit), last changed there at commit 626d9be and unchanged at cf6fd3f. It is regenerated there (`bash tools/gen-pace-vectors.sh > tools/pace-vectors.tsv`) and copied over, never edited here.

## Two accounts (AIT_ACCOUNT)

A second account can run in the same `~/.claude` (launched with `CLAUDE_CODE_OAUTH_TOKEN`). Nothing a session writes says which account it is: the registry entry, the transcript stamps (`session-owner`, `bridge-session`) and the status line's fingerprint all come from the logged-in account in `~/.claude.json` (measured 2026-11-03: a token-launched CLI session and the VS Code sessions on the token account all stamped the main account). So the launcher sets a non-secret label next to the token, and two small writers record it. No credential is read, printed or stored anywhere in this path.

- **The label.** `AIT_ACCOUNT=<label>` in the session's environment, `[a-z0-9][a-z0-9_-]{0,15}`, for example `second`. No label is the main account; a label that is set but invalid is handled under "A typo'd label" below. For VS Code, set it the same way as the token (the process env of the running VS Code), since a launch-time env does not reach an already running instance.
- **The status line** (ai-toolkit `tools/statusline.sh`) keeps a labelled session's store apart: the fingerprint of a labelled account is the first 12 hex of sha256 of `label:<label>` (it cannot equal an account uuid's), its `personal-windows` and `readings` files carry `label`, its context record in `status-ext` is stamped with it, and it never writes the fleet harvest `rate-limits.json`. Before this a token session's render overwrote the main account's borrowed 5-hour bar, the watcher's meter and that harvest.
- **`account-stamp.sh`** is a SessionStart hook (no matcher) that writes `<out-dir>/accounts/<sid>.json` = `{"v":1,"label":"<label>","at":<epoch>}` (mode 0600, atomic), and removes the session's own file when it starts without a label. It is the only thing that reaches VS Code sessions, which never run the status line (measured: SessionStart fires in a `claude-vscode` transcript, and those sessions leave no `status-ext` file). Register it under `hooks.SessionStart` in `~/.claude/settings.json` (see Install below). Tests: `bash tools/usage-watcher/test-account-stamp.sh`.
- **In the summary (additive; `v` stays 5).**
  - `meter` and `window` keep meaning the main account. A labelled file never becomes `meter`; `window.tokens` and `window.opusShare` count the main account's sessions only; the meter alert never names a labelled session.
  - `alerts`, `cacheExpiring` and `compactSoon` still list a labelled account's sessions (MANAGER's compact-soon and runaway flows need them: the VS Code sessions are on the token account), and each such entry carries `acct: "<label>"`. An entry without `acct` is the main account's, as before.
  - A row of a labelled session carries `acct: "<label>"` (absent for the main account). Its `share` is measured against its own account's window, and `classify` gates on that account's total, since each account's quota is its own.
  - `accounts` (absent when there is no labelled account): one entry per label, `{"label","fresh","weekFresh","five_hour":{"pct","resetsAt","projectedEndPct","paceState"}|null,"seven_day":{...}|null,"window":{"start","end","source","tokens"}}`. The window is that account's own 5-hour window (`source: "meter"`) or the last 5 hours (`"rolling"`). When the summary passes 4 KB it is dropped only after `top` rows, `compactSoon` and `cacheExpiring` entries have gone (before `alerts`), with `accountsDropped: true` and `"accounts"` in `dropped`.
  - A labelled account raises no meter or pace alerts yet: it is shown, not alerted on.
- **A typo'd label** (`AIT_ACCOUNT` set but not matching the pattern) is not the main account: the status line keeps no store and writes no harvest for that session, and stamps its context record `unknown`. The hook writes no file for it, so the watcher counts its tokens as the main account's.
- **How it fails.** A session launched without the label counts as the main account, in the tokens, the shares and the meter. A label file is read from disk each run, so an old file for a session that now runs unlabelled is removed only when that session's hook runs (a resume does); files older than 30 days are ignored. Two accounts that both use the same label are one account to the watcher. The meter history log (`meter-history.log`) records the main account only. The `top` list and the 5 alert slots are shared by both accounts, so a busy labelled account can crowd main sessions out of `top` and its session alerts can push the main account's pace alerts (appended last) off the end. The hook leaves a `.stamp.*` temp file if it is killed mid-write, and the watcher reads up to 500 usable label files, newest first.

## Why a watcher-owned directory

The spec put the output in a shared spool directory, and the review asked for either a confirmation or a move. Other processes can write in that spool, and a writer there could forge the summary, or plant symlinks that turn this unsandboxed job against other files. So the output moved to a directory the watcher alone owns. The spool is an optional input, read only when present, and only its `limits/`.

## Install

macOS only. Needs the Command Line Tools and `/usr/bin/python3` 3.9 or later; `account-stamp.sh` also needs `jq`. Nothing installs itself: you run `tools/usage-watcher/install.sh`.

The installer fetches `main` from `https://github.com/notitial/ai-manager.git` over HTTPS, without credentials, into a temporary repository. It installs from that commit, never from your working tree, and never reads the checkout's objects or git config. That URL is fixed: no option, and no variable or git config the installer reads, changes it. The fetch ignores proxy environment variables.

The fetch has no credentials, so it works only once the repository is public.

Without `--apply` it changes nothing and prints what it would do. Pin a commit of `main` you have read with `--ref <full 40-hex commit>`, and run the installer from a checkout of that same commit: the pin covers what it installs, not the script you run. Without `--ref` it takes `main`'s tip and prints that commit.

```
bash tools/usage-watcher/install.sh --ref <commit>
```

```
bash tools/usage-watcher/install.sh --ref <commit> --apply
```

With `--apply` it does these steps:
- Runs the commit's watcher tests, on the same `watch.py` and `account-stamp.sh` bytes it installs.
- Installs `watch.py` (0444) and `account-stamp.sh` (0555) in `~/.local/share/usage-watcher/` (0700). The data folder is `~/.local/state/usage-watcher/` (0700).
- Writes `~/Library/LaunchAgents/io.notitial.usage-watcher.plist` from the commit's template. The rendered plist must hold only the template's keys with their expected values (Label, StartInterval 300, RunAtLoad, ProcessType, Nice, the two output paths). Its `ProgramArguments` must be exactly `/usr/bin/python3 -I <watch.py> --config-dir ${CLAUDE_CONFIG_DIR:-~/.claude}`. Anything else, such as `Program`, `EnvironmentVariables`, `WatchPaths`, `KeepAlive`, `UserName` or an extra argument, is refused, in the dry run too.
- Reloads the job with `launchctl bootout`, then `launchctl bootstrap gui/<uid>`, and checks it. If the bootstrap fails, the job stays unloaded with the files installed: fix the cause and run `--apply` again.

It refuses symlinks, folders it doesn't own and group- or world-writable folders on those paths, and it refuses to run as root. Without `jq` on your PATH, it warns that `account-stamp.sh` will record nothing. Run it again to update.

The job runs a copy, not the checkout, for two reasons. macOS privacy controls (TCC) keep a launchd job's python out of `~/Documents`. A copy also keeps a branch switch from changing what runs.

**The SessionStart hook is yours to add.** The installer prints the entry for `account-stamp.sh` and never edits a settings file. Add it under `hooks.SessionStart` in `~/.claude/settings.json` (or your `CLAUDE_CONFIG_DIR`).

**An older copy under another label.** If an older copy of the watcher runs under a different launchd label, unload it first. Then remove its plist from `~/Library/LaunchAgents/`, or it loads again at the next login. The data folder is shared and kept.

```
launchctl bootout gui/$(id -u)/<old label>
```

**Status and uninstall.** `--status` is read-only: the installed files and their hashes, whether the job is loaded, and whether `jq` is on your PATH. A missing `jq` counts as needing attention (exit 4). With `--ref`, it also says whether the installed files match that commit. `--uninstall --apply` unloads the job and removes the plist, `watch.py` and `account-stamp.sh`. It keeps `~/.local/state/usage-watcher/`. Remove the hook entry by hand.

```
bash tools/usage-watcher/install.sh --status --ref <commit>
```

```
bash tools/usage-watcher/install.sh --uninstall --apply
```

Tests: `bash tools/usage-watcher/test-install.sh`. They are sandboxed: a fake home, a stub `launchctl` and a local fixture repository. The tests run a copy of the installer with only its two source lines changed, and they check that nothing else changed. The installer itself has no test-only switch.

## Options

With more than one `personal-windows-*.json` in the optional spool's `limits/`, add `--meter-fp <fp>` to the plist's arguments, or the summary carries no meter.

To move the keep-warm floor, add `--cache-ctx-min <tokens>` to the plist's arguments (default 200000, at most 10^8).

Both are hand edits to the installed plist in `~/Library/LaunchAgents/`; reload the job after one. The next `install.sh --apply` overwrites the plist with the commit's template, so make the edit again after every update. `--status --ref` reports such a plist as differing from the commit.

## Cost

Measured on this Mac on 2026-10-24:
- The first run read 24h of logs in about 9 s; later runs take about 0.1–0.5 s.
- `state.json` was 540 KB (7.3k dedupe keys) and the summary 3.5 KB.
- launchd never starts a job while its previous run is still going, and `run.lock` covers a manual run that overlaps.
