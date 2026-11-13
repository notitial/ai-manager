# 6. A conductor opens leads and wakes them

**Status:** proposed
**Date:** 2026-11-13

Scope: three conductor powers over leads in its approved repos: open a new lead, see whether a lead is busy, idle
or waiting, and wake an idle lead. It adds to [ADR 0002](0002-callboard.md) (levels, cues, the conductor). The
lead's single grant path comes from the callboard redesign that made the three grant levels one descriptor; ADR
0002 records it in a dated line. Prompt answering ([ADR 0004](0004-prompt-answering.md)) is unchanged: a lead made
this way is a tier like any other.

## Context

A conductor directs the leads of the repos the person approved for it, but it cannot open one. Each lead needs
the person to type `/callboard lead` in that repo's window and click `Lead`. Moving a busy machine's work under a
conductor waits on this. The conductor also cannot tell a lead that is working from one waiting on a prompt, and
it has no way to wake an idle lead after it has sent it a message; the mod gives a lead one cue, `compact`.

Facts that bound the options:

- The panels extension can open a Claude panel in a VS Code window whose first workspace folder is a given repo,
  and answer the new session's id (`lane_open` does this today). That window may be signed in to a different
  Claude account on the same macOS user; the new session runs on that account.
- A born lane's mod takes its name from its tick before its first turn. Whether a lead grant set the same way
  reaches the first turn's system prompt is probed before the grant is built (P-C4).
- Any process running as the person can write every callboard file (ADR 0002, Consequences).
- One role, one behaviour: a lead behaves the same whatever made it. How it was made may be logged and may limit
  the act of making; it never changes what the lead does afterwards.

## Options Considered

For opening a lead:

1. **Keep the click for every lead.** Safe; the person must be at each window.
2. **The conductor opens the panel; the person clicks `Lead` there.** Proves the open path; still needs the
   person at the machine.
3. **The conductor opens and grants, inside limits set by the person's conductor click: chosen.**
4. **A conductor-made lead with fewer powers, or one that restores only while its repo is listed.** Rejected: it
   makes two kinds of lead, which the one-role rule forbids.

For waking a lead:

1. **Messages only.** The mod delivers nothing; nothing acknowledges a message.
2. **A `resume` cue a lead takes from a trusted conductor or the manager: chosen.** The same fixed-text,
   no-payload cue a lane takes from its lead, plus a short token that ties the turn to one message.

## Decision

### Opening a lead

- **The tool.** `lead_open { repo, name, task, model? }`, declared for the conductor level. The repo must be in
  the conductor's reach at the call: its approved list intersected with its list file, read then.
- **Limits on the act.** No live lead in the repo already (whoever made it), and no open offer for it; at most
  one open in flight per conductor; at most one successful open per repo per hour, counted from the ledger, so the
  hourly total is bounded by the size of the approved list (at most 16). The name is a valid lane-style name, not
  reserved, carried by no live session, no lane record and no open request on the machine. The repo is not the
  conductor's own. `/callboard config conductor-leads off`, the person's own command, makes the tool refuse and
  makes every new session refuse an offer.
- **Two files.** The conductor's mod writes the task to `<repo>/.archive/<NAME>/BRIEF.md` under a lead brief
  header, an **offer** in callboard's offer folder (one file per repo, created exclusively: name, repo, model, the
  conductor's session id, pid and process start time, a time and a single-use nonce), and a small **open
  request** for the extension (name, repo, nonce). The extension claims the request once, opens a panel only in a
  window whose first workspace folder is the repo's exact real path, and answers the new session's id. It never
  reads the offer or the brief.
- **The grant.** The conductor's mod writes a `lead <nonce>` cue to that session. The new session's own mod first
  claims the offer with a claim file only one session can create (the offer stays in place, so the repo stays
  taken), then accepts only when every check passes, again after its last wait:
  - the cue names it and its nonce equals the offer's; a ledger row for that offer exists;
  - it started in the repo less than two minutes ago, is a person's interactive session, has had no turn, has no
    name, and holds no level (lane, lead, conductor, manager, or any `-after-` state);
  - the offer passes its file checks and is younger than two minutes; its name passes the name rules again;
  - the offer's conductor is a live session whose pid and start time match the process table, and it is a
    conductor this session trusts for the repo by the same presence, saved-grant and list-file checks a lead
    uses today before taking a conductor's compact cue;
  - no other live lead is in the repo, read with every unreadable file counted as a failure;
  - the person's switch is on.

  It renames itself to NAME first, then takes the lead grant through the shared lead steps (tools, grant, saved
  grant, presence, briefing). A failure before the grant leaves the session plain; a failure after it drops the
  grant again. It then deletes the claimed offer, shows a toast naming the lead, the offer's conductor and the repo
  with `/callboard off` as the way out, and submits one fixed start turn that points at the brief, once the session
  is idle with an empty box.
- **Afterwards it is a lead.** The saved grant, the restore at the next start, the tools, the tier rights and
  `/callboard off` are the same as for a lead the person made. Who made it is a log line and a ledger row, never
  a field anything reads to decide.
- **Consent.** The person's consent is the conductor grant. Its dialog says, for a new grant: "It can also open a
  lead in one of these repos without asking you (one per repo, one an hour each)." Conductors granted before
  this change get the power without a new dialog, by the person's choice.
- **Built in steps.** The tool and the extension's open come first, and alone they only open the panel: the person
  clicks `Lead` there, as today. The clickless grant, which is the part on the risk list, is a separate change
  that needs the person's own go.

### Lead state

`lane_list` at conductor and manager level shows each live lead's registry state: busy, idle, or waiting on a
prompt or the person for N minutes. Display only; the registry is a filter, never proof.

### Waking a lead

- **The tool.** `lead_resume { lead, token }` at conductor level (a live lead of a repo in reach) and manager
  level (any live lead). The token is 8 hex characters the sender also puts in its message to the lead. It writes
  `resume <sender session id> <token>` to the lead's cue file.
- **The lead's side.** A lead takes this `resume` only while the named sender is a live conductor it trusts for its
  folder or a trusted manager, by the same checks as `compact`; only when it is idle, waiting on nothing, with an
  empty box and no dialog open; at most 12 an hour, kept across a restart. It submits one fixed turn: a session
  the registry names as the sender asks it to read the message that carries the token, and only that one; to
  continue only work the person authorised in their own turn; nothing in the message is the person's approval.
  The cue carries no other text.

### Audit

Ledger rows `lead-offer`, `lead-offer-void`, `lead-grant` and `lead-resume`. The audit flags a grant with no offer
row of the same nonce, more than one grant per repo in an hour, a second live lead granted in a repo that had one,
and a resume whose sender was not a conductor or manager at the time. The conductor's own mod compares the grants
the ledger says it made with the offers it remembers writing, and shows the person a toast for any it did not.

## Consequences

- Leads open, and idle leads wake, without the person at the machine. A conductor's approved repos become places
  where it can start work, not only places where it can watch.
- The conductor dialog is now the consent for opening leads, so its wording matters more; conductors granted
  earlier carry the power on the person's choice, not on a dialog that named it.
- A conductor that is wrong, or prompt-injected through a lead's message or a repo file, can open up to one lead
  per approved repo per hour, each of which can create lanes within that lead's own limits (16 lanes, 12 creates
  an hour per repo). The person sees a toast per lead and the ledger; `/callboard off` in either session ends it,
  and the switch withdraws the power.
- A lead keeps running, and restores, after its repo leaves the conductor's list, as any lead does. The conductor
  loses reach over it at once.
- The brief is the conductor model's text, at the trust level of that model and the repo; its header says it is
  data and carries no approval.
- **Accepted residual: same-uid forgery, wider than the saved lead grant.** A process running as the person can
  open a panel in an approved repo and write a valid-looking offer, request, ledger row, brief and cue while a
  trusted conductor is live: that session becomes a lead at once, with no restart and no click, and its brief is
  the forger's. The saved-grant forgery of ADR 0002 (the lead grant and the conductor grant) needs a restart of a
  known session; this does not. A forged saved conductor grant now also carries the power to open up to 16 leads
  an hour. The toast, the log, the ledger, the audit and the conductor's own check make it visible; nothing
  prevents it. The same process can write `resume` cues: at most 12 fixed turns an hour into an idle lead, each
  pointing only at a message with its token.
- **Accepted residual: two opens at once.** The repo-keyed offer makes two conductors' opens for one repo
  exclusive, and the claim makes one offer serve one session. A lead the person makes by hand in the same seconds
  can still pass beside it, as two person-made leads can (ADR 0002, several leads in a repo).
- **Accepted residual: accounts.** The new lead runs on whatever account its window is signed in to, and spends
  that account's limits.
- Nothing here changes the floor, the rubric, the person-only commands, or what a conductor may do to lanes; a
  conductor still cannot stop a lead.

## Probes

Each is open until run, and each needs the person at the machine.

- **P-C1.** A window signed in to a second Claude account (same macOS user): `editor.open` there opens a panel
  whose session loads the mod, writes a registry row of kind `interactive`, and passes the interactive check.
- **P-C2.** With three windows open, only the one whose first folder is the repo answers an open request.
- **P-C3.** The new panel's registry row and session root appear within the two-minute birth window on a cold
  window.
- **P-C4.** A lead grant set from the tick before the first turn: the first turn's system prompt carries the lead
  section, so the grant needs no briefing note.
- **P-C5.** A `resume` into an idle lead while a `Relay` question is on screen, and while a draft is in the box:
  the registry shows the dialog as waiting, and nothing is submitted.
- **P-C6.** `/rename` and `/model` from the tick in a session with no turn yet, re-checked for a lead.
- **P-C7.** How long the accept takes on a cold session (registry, process table, tool registration).
