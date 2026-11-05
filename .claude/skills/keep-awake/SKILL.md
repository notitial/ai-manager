---
description: "Keep this Mac awake for a bounded time with caffeinate, check that it is held, and stop it. With ai-toolkit's settings template installed, every start asks for permission (permissions.ask). Every start needs a time limit (default 8h, at most 24h), and runs detached so it survives the terminal. Use on '/keep-awake', '/keep-awake 4h', '/keep-awake status', '/keep-awake stop'."
disable-model-invocation: true
---

# Keep awake

Holds a macOS power assertion so the machine does not sleep during long unattended work (a fleet run, an
overnight build). The assertion belongs to the machine that runs `caffeinate`, and lasts only while that
process lives: a reboot or logout clears it, and so does killing the process.

Argument: one of a duration, `status` or `stop`; nothing else is accepted.

## Start

1. **Seconds from the argument.** Accept only `<n>`, `<n>m` or `<n>h` (any case), where `<n>` is a whole
   number: a bare number is minutes, and no argument at all means 8h. Anything else (a fraction, a sign, a
   `d` or `s` unit, a second word, other characters) is refused, and so is a result below 1 or above 86400
   (24h). Write the computed integer into the command, never the user's text. There is no run without a limit.
2. **Record what is already running:** `pgrep -x caffeinate` lists the pids, and
   `ps -o pid=,etime=,args= -p <pid>` shows each one's age and flags. Sort each into one of two kinds:
   - **Another tool's short hold:** the flags are only `-i` and `-t` with 600 seconds or less, such as Claude
     Code's own `caffeinate -i -t 300`. If these are the only ones running, mention them in one line and go to
     step 3 without asking.
   - **A relevant hold:** a `-dims` hold from an earlier `/keep-awake`, any `-t` over 600, or no `-t` at all.
     If one is running, say so and ask whether to start another anyway.

   `stop` lets the user choose which to end.
3. **Start it detached, in exactly this form**, as an ordinary Bash call (not `run_in_background`, which
   ties the process to the tool's task), with nothing before `nohup` and nothing added around it:

   ```
   nohup caffeinate -dims -t <seconds> >/dev/null 2>&1 &
   ```

   `-d` display, `-i` idle sleep, `-m` disk, `-s` system sleep on AC power (on battery `-s` asserts
   nothing, so do not claim it). Never `-u`, and never omit `-t`. Measured 2026-10-23: the process keeps
   running, with its four assertions held, after the tool call that started it returns.
4. **Verify the new process:** run `pgrep -x caffeinate` again, then `ps -o pid=,args= -p <pid>` for each pid
   that was not listed before. Exactly one of them must show `caffeinate -dims -t <seconds>` (another tool may start
   its own short hold meanwhile), and `pmset -g assertions` must show `caffeinate asserting for <seconds> secs` for it. Report
   the pid with the end time (now + duration). No new pid means the start failed: say so.

## Status

`pgrep -x caffeinate`, then `ps -o pid=,etime=,args= -p <pid>` for each pid: how long it has run and its `-t`.
Say "none held" when `pgrep` lists nothing. Not every caffeinate is this skill's: Claude Code and other tools
start their own.

## Stop

1. List the caffeinate pids (`pgrep -x caffeinate`, then `ps -o pid=,etime=,args= -p <pid>`), and ask which
   to stop. The default is the ones this skill started (`-dims -t …`); another tool's caffeinate is only
   stopped when the user names it. Only pids from this list can be stopped.
2. Right before killing, re-check each chosen pid: `ps -o ucomm= -p <pid>` must print `caffeinate` (the
   kernel's name; `comm` follows argv[0] and truncates a full path). A pid that ended in the meantime may
   already belong to another process, so skip any pid that fails the check and say so. Then `kill <pid> …`.
   Where `kill` prompts, a pid can still change while the prompt waits: answer it promptly. When the user
   asks to stop all of them, that means every pid listed in step 1, each re-checked and killed by pid as above.
3. Verify with `pgrep -x caffeinate`: the stopped pids are gone.

## Permissions

ai-toolkit's settings template holds, in `permissions.ask`, `Bash(caffeinate:*)` and `Bash(nohup caffeinate:*)`, so a
start prompts the user, in auto mode too (an explicit ask rule runs before the classifier and wins over an
allow rule). Both forms are listed so the prompt does not depend on how the matcher treats the `nohup`
wrapper. A start written another way (`env … caffeinate`, `bash -c …`, `ssh …`) matches neither rule and
would not prompt; the fixed start form above is the only thing that keeps the command on a matching form.
`pmset -g` only reads. The template also asks for `pkill -x caffeinate`, which stops every caffeinate; this skill never runs it.
The template does not ask-gate `kill`: that prompts in default mode, and in auto mode the classifier decides. Permission prompts are invisible to the model: only the user can confirm a start prompted.

In a lock-armed checkout, the toolkit's workspace-lock guard lets a session that does not hold the lock
(MANAGER) run this skill's commands in exactly the forms above, and nothing near them: `pgrep -x caffeinate`,
`pmset -g assertions`, the start form with `-t` from 1 to 86400 as the whole command, `kill <pid> …` with
plain pids that are all running caffeinate, and `pkill -x caffeinate`. `ps` is a read already. Any other
form needs the lock. The guard cannot tell MANAGER from any other session, so every session without the
lock gets these forms. A session on the template, MANAGER included, is asked for the start, not for `kill`.

## Another machine (not built)

To keep another Mac awake, caffeinate must run on that machine, for example over SSH:
`ssh <host> 'nohup caffeinate -dims -t <seconds> >/dev/null 2>&1 &'`. This needs Remote Login on the target
(check first with `nc -z -G 3 <host> 22`), and its own ask rule in the same change that builds it, because
the rules above do not match a command that starts with `ssh`. Remote Login was off on the machine this was
meant for, so this mode is documented only.
