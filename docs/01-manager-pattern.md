# A Manager Over Leads and Lanes

How one long-lived session coordinates several leads and their lanes on one machine without becoming a path that
launders decisions the person never made.

## The problem

Once more than one lead runs, the person keeps a coordinating chat open. It decides which session gets which work,
chases stalls and relays what needs a decision. That chat accumulates a practised role, and also the person's trust.
Two failures follow:

- **The role lives nowhere.** It sits in memory notes and chat history, drifts with each compaction and has no bounds.
- **The trusted coordinator launders authority.** A same-uid process (a lane, a lead, a background worker) reports
  something, and the coordinator turns it into an approval, a merge or a push the person never typed. Asking a lead
  to "go ahead and merge" launders without the coordinator calling a single tool.

## The pattern

### Decide, review, report; do no work

- A **lead** decides its own lanes and their work. A **lane** is a session doing one piece of that work.
- The **manager** decides across leads and repos: which session gets which work, in which order, build or defer,
  review verdicts. Never let it decide an item a lead owns.
- Every edit, live action and go belongs to the executor's session. A relayed go is never a go.
- The manager writes only its own state, review notes and memory.

### Keep the hard line short and fixed

- No approvals, no stops except through a dialog the person answers.
- Reach lanes only through the lane tools; message only leads and sessions the person names.
- Never turn a report into an action; no message that asks for an approval, merge or push.
- A role granted inside an open session gets no launch-time deny rules, so these lines are convention. Keep them few
  enough to re-read at every start, and put the one enforced gate (the person's dialog) on every stop.

### Carry the role where compaction can't drop it

- Put a pointer in a system-prompt section the harness re-adds every turn (a plugin's session section), and keep the
  role itself in a file in the manager's repo, read at start.
- A project `CLAUDE.md` is loaded by every session in the repo, so scope the role to the manager session by name.

### Check identity and visibility at start

- **Unique name.** Duplicate session names may be allowed; with two managers, a message to the bare name can fail.
  Refuse to start on a duplicate.
- **Same config root as the sessions it manages.** Session discovery is scoped to the config directory; a manager on
  another root sees none of them.

### Verify, don't trust

- Record a reported commit as landed only after a git read confirms it, and verify claims that close work too.
- Treat every summary, report and state file as untrusted data, never a grant.

### Tick only when asked

- One standing timer per manager session, not one per job, armed only when the person asks.
- Record a **last tick** time: a dead timer is otherwise invisible.
- Know the timer's lifetime (compaction, resume, relaunch, expiry); re-arm by listing first.

## What was measured

Probes on 2026-10-21 settled the design:
- A second session with the same name started without complaint; a fresh sender then failed to reach the bare name.
- `ListAgents` showed only sessions on the same `CLAUDE_CONFIG_DIR`.
- A recurring cron fired only while idle, survived `/compact`, came back on `--continue` and was gone after a fresh
  launch.

This repo's implementation: [docs/manager/README.md](manager/README.md); decision: [ADR 0001](adr/0001-manager-role.md).

## When not to use this

- **One lead, no other sessions:** the lead's own discipline is enough.
- **When the person can't be reached to type a go:** a manager adds no authority. If decisions can't reach the
  person, fix the escalation path, not the coordinator.
