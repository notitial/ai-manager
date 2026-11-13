import { expect, test } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import { h, NO, PROMPTS_DIR, SID, T0, YES, extraStat, leadFiles, longTest, pdirs, pfs, psFail, realMap } from './harness'
import { HOOK_BUDGET_MS, LEADPATH, LEADPS, LEADSID, OTHER, PIN, SVC, attRec, lane, leadReg, ownReg, putStore, sleeps, started } from './fixtures'
import { GONE, LDIR, LEAD2, LEDGER_FILE, OFF_FILE, PCOMMENT, PDIR, PRQ, TID, answerCall, answered, answerer, askCheck, at, callOf, decFile, driveClock, handDecision, hookKinds, hookRows, ledgerRows, noFiles, putLedger, putQ, putRelay, readReq, refusal, reqFiles, retRow, rowKinds, runRequest, said, startReq, stop, tier, waitingRow } from './answer-fixtures'

longTest('prompts: a lead\'s answer after 30 s of awake time is returned, the ledger says so, and the files are removed', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await answerer($, on, stdins, { argv })
  expect((await askCheck($)).decision).toBe('ask')
  h.sessions = waitingRow(T0 + 500)
  driveClock()
  let made = false
  h.clockHooks.push((rel) => {
    if (rel >= 4000 && !made) {
      made = true
      expect(rowKinds()).toEqual(['requested'])
      expect(readReq()).toMatchObject({ sid: SID, pid: 4300, procStart: LEADPS, level: 'lane', lane: 'svc-api', tool: 'Bash', raisedBy: 'rule', input: PRQ, truncated: false, repo: SVC })
      expect(readReq().expiresAt).toBe(readReq().at + 21 * 60_000)
      handDecision(readReq())
    }
  })
  h.clockSlept = 0
  const r = await startReq($)
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  // Not before 30 s of awake time with the dialog open, and never with a decision that lands early.
  expect(h.nowMs - T0).toBe(30_000)
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
  expect(noFiles()).toBe(true)
  // The wait goes through /bin/sleep, never $.clock.sleep (a hook has 10 s of its own time per dispatch).
  expect(sleeps(argv).length).toBeGreaterThan(10)
  expect(h.clockSlept).toBeLessThan(HOOK_BUDGET_MS / 2)
  // The ledger holds no input text.
  expect(JSON.stringify(ledgerRows())).not.toContain('uptime')
})

longTest('prompts hook: the cleaner-command text ends a long unclear deny, however long the reason is', async ($, on) => {
  await answerer($, on, [])
  const why = prm.unclearMessage('é'.repeat(100)).slice(0, 190)
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'deny', why }))])
  expect(r.decision.behavior).toBe('deny')
  expect(r.decision.message.endsWith(prm.UNCLEAR_SUFFIX)).toBe(true)
  expect(new TextEncoder().encode(r.decision.message).length).toBeLessThanOrEqual(300 + prm.UNCLEAR_SUFFIX.length)
})

test('prompts: a decision of deny comes back as a deny with the tier named, and never as updatedPermissions', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'deny', why: 'not this one' }))])
  expect(r).toEqual({ decision: { behavior: 'deny', message: 'Denied by the lead LEAD: not this one' } })
  expect(rowKinds()).toEqual(['requested', 'answered deny', 'returned deny'])
  expect(JSON.stringify(r)).not.toContain('updatedPermissions')
})

test('prompts: off by default: with no switch stored there is no request, no row and no wait', async ($, on) => {
  const argv: string[][] = []
  await answerer($, on, [], { switchOn: false, argv })
  const r = await runRequest($, [])
  expect(r).toEqual({})
  expect(rowKinds()).toEqual([])
  expect(pfs.size === 0 || noFiles()).toBe(true)
  expect(reqFiles().length).toBe(0)
  expect(sleeps(argv).length).toBe(0)
})

test('prompts: the emergency OFF file wins over the stored switch, at request time and during a wait', async ($, on) => {
  await answerer($, on, [])
  pfs.set(OFF_FILE, { text: '', mtimeSec: T0 / 1000 })
  expect(await runRequest($, [])).toEqual({})
  expect(reqFiles().length).toBe(0)
  expect(rowKinds()).toEqual([])
})

test('prompts: touch OFF during a wait closes it within one poll: row off, dialog left to the person, files removed', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), {}, true)), at(8000, () => { pfs.set(OFF_FILE, { text: '', mtimeSec: h.nowMs / 1000 }) })])
  expect(r).toEqual({})
  expect(h.nowMs - T0).toBeLessThanOrEqual(10_000)
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'off'])
  expect(noFiles()).toBe(true)
})

test('prompts: /callboard escalation off during a wait closes it too, and a decision made after is not applied', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, async () => { await $.command.run(lane('escalation off', { kind: 'plugin' })) }), at(6000, () => handDecision(readReq()))])
  expect(r).toEqual({})
  expect(rowKinds()).toContain('off')
  expect(rowKinds()).not.toContain('returned allow')
  expect(h.store.has('answering')).toBe(false)
})

longTest('prompts: P-I5: a subagent\'s ask returns the chain beneath at once: no request, no wait, no row', async ($, on) => {
  const argv: string[][] = []
  await answerer($, on, [], { argv })
  await askCheck($)
  h.sessions = waitingRow(T0 + 500)
  driveClock()
  const before = argv.length
  const r = await startReq($, { agent_id: 'a1', agent_type: 'general-purpose' })
  expect(r).toEqual({})
  expect(h.prBeneathCalls).toBe(1)
  expect(reqFiles().length).toBe(0)
  expect(rowKinds()).toEqual([])
  expect(argv.slice(before).length).toBe(0)
  // Even a subagent's ask the observer saw (it never stores one) leaves nothing a later main-agent request could join.
  // Nor does the observer keep a subagent's ask: had it stored one (a second entry on one hash), the main agent's own request would read as two calls in flight
  // and be left to the person. It is judged, answered by the lead.
  await askCheck($, { agentId: 'a1', tool_use_id: 'tu2' })
  h.clockHooks.push(at(4000, () => handDecision(readReq())))
  expect(await startReq($)).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
})

test('prompts: a non-empty result from beneath (a settings hook\'s deny) stands whole, and the chain beneath runs once', async ($, on) => {
  await answerer($, on, [], { beneath: () => ({ decision: { behavior: 'deny', message: 'settings hook says no' } }) })
  await askCheck($)
  const r = await startReq($)
  expect(r).toEqual({ decision: { behavior: 'deny', message: 'settings hook says no' } })
  expect(h.prBeneathCalls).toBe(1)
  expect(reqFiles().length).toBe(0)
  expect(rowKinds()).toEqual([])
})

test('prompts: the chain beneath runs exactly once on every path', async ($, on) => {
  await answerer($, on, [])
  await runRequest($, [at(4000, () => handDecision(readReq()))])
  expect(h.prBeneathCalls).toBe(1)
  h.prBeneathCalls = 0
  expect(await startReq($)).toEqual({})
  expect(h.prBeneathCalls).toBe(1)
})

for (const verdict of [{ decision: 'ask', rule: 'Bash(ssh:*)' }, { decision: 'ask', hook: 'PreToolUse', reason: 'x' }, { decision: 'allow' }, { decision: 'deny', reason: 'no', rule: 'Bash(rm:*)' }]) {
  test(`prompts: tool.check returns the engine's verdict unchanged, every time (${JSON.stringify(verdict)})`, async ($, on) => {
    await answerer($, on, [], { verdict })
    expect(await askCheck($)).toEqual(verdict)
    expect(await askCheck($, { approver: 'host', tool_use_id: 'tu9' })).toEqual(verdict)
    expect(await askCheck($, { tool: 'Write', input: { file_path: '/x/a' } })).toEqual(verdict)
  })
}

test('prompts: no tool.check entry, or two calls in flight on one hash, leave the prompt to the person', async ($, on) => {
  await answerer($, on, [])
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual(['not-judgeable no-check'])
  await askCheck($, { tool_use_id: 'a' })
  await askCheck($, { tool_use_id: 'b' })
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual(['not-judgeable no-check', 'not-judgeable no-check'])
  expect(reqFiles().length).toBe(0)
})

test('prompts: an entry older than its minute is not used', async ($, on) => {
  await answerer($, on, [])
  await askCheck($)
  h.nowMs += 61_000
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual(['not-judgeable no-check'])
})

for (const approver of ['host', undefined]) {
  test(`prompts: approver ${approver}: nobody can be asked or a host answers: no request and no row`, async ($, on) => {
    await answerer($, on, [])
    await askCheck($, { approver })
    expect(await startReq($)).toEqual({})
    expect(reqFiles().length).toBe(0)
    expect(rowKinds()).toEqual([])
  })
}

// ---- the classifier, as the hook reads tool.check ----
const RULE = { decision: 'ask', rule: 'Bash(ssh:*)' }
const GUARD = (extra: Record<string, unknown> = {}) => ({ decision: 'ask', hook: 'PreToolUse', reason: 'github-mcp-guard: ask', ...extra })
const CLASSIFY: [string, any, string, unknown, string][] = [
  ['rule only', RULE, 'Bash', PRQ, 'requested rule'],
  ['the mode\'s own ask', { decision: 'ask' }, 'Bash', PRQ, 'requested mode'],
  ['the guard on a PR open', GUARD(), 'mcp__github__create_pull_request', { owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' }, 'requested guard'],
  ['the guard on a comment', GUARD(), 'mcp__github__add_issue_comment', { owner: 'o', repo: 'r', issue_number: 3, body: 'hi' }, 'requested guard'],
  ['the guard marking a PR ready (draft false)', GUARD({ reason: 'github-mcp-guard: update_pull_request on "o"/"r" #3 sets draft false; nothing else. Setting draft to false marks the PR ready for review' }), 'mcp__github__update_pull_request', { owner: 'o', repo: 'r', pullNumber: 3, draft: false }, 'requested guard'],
  ['a hook ask', { decision: 'ask', hook: 'PreToolUse', reason: 'x' }, 'Bash', PRQ, 'not-judgeable hook'],
  ['a rule and a hook', { decision: 'ask', rule: 'Bash(ssh:*)', hook: 'PreToolUse', reason: 'rule' }, 'Bash', PRQ, 'not-judgeable hook'],
  ['the guard\'s prefix on another tool (an imitator)', GUARD(), 'Bash', PRQ, 'not-judgeable hook'],
  ['the guard on a tool an ask rule also covers', GUARD({ rule: 'mcp__github__actions_run_trigger' }), 'mcp__github__actions_run_trigger', { owner: 'o', repo: 'r' }, 'not-judgeable hook'],
  ['a setting', { decision: 'ask', setting: 'permissions.x' }, 'Bash', PRQ, 'not-judgeable setting-plugin-ceiling'],
  ['a plugin', { decision: 'ask', plugin: 'other' }, 'Bash', PRQ, 'not-judgeable setting-plugin-ceiling'],
  ['a question with no asks scope (stays his)', { decision: 'ask' }, 'AskUserQuestion', { questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }, { label: 'b' }] }] }, 'not-judgeable question-scope'],
]
for (const [name, verdict, tool, input, want] of CLASSIFY) {
  test(`prompts: classifier: ${name}`, async ($, on) => {
    await answerer($, on, [], { verdict })
    const c2 = callOf(tool, input)
    const r = await runRequest($, [stop(8000)], c2.over, c2.check)
    expect(r).toEqual({})
    const [kind, code] = want.split(' ')
    if (kind === 'requested') {
      expect(rowKinds()).toEqual(['requested', 'off'])
      expect(ledgerRows()[0].tier).toBe('lead')
      expect(JSON.stringify(ledgerRows())).not.toContain('"input"')
    } else {
      expect(rowKinds()).toEqual([`${kind} ${code}`])
      expect(reqFiles().length).toBe(0)
    }
  })
}
test('prompts: classifier: a request raised by the guard says so in its file', async ($, on) => {
  await answerer($, on, [], { verdict: GUARD() })
  const c2 = callOf('mcp__github__create_pull_request', { owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' })
  await runRequest($, [at(4000, () => { expect(readReq().raisedBy).toBe('guard') }), stop(6000)], c2.over, c2.check)
})

// ---- the floor, at the request: no request is written and the dialog stays the person's ----
const FLOOR_CASES: [string, string, unknown, string][] = [
  ['an edit of settings.json', 'Write', { file_path: '/Users/x/.claude/settings.json', content: 'x' }, 'settings'],
  ['an edit of callboard\'s folder', 'Edit', { file_path: '/Users/x/.claude/callboard/prompts/ledger-2026-11.jsonl', old_string: 'a', new_string: 'b' }, 'settings'],
  ['a shell command naming the callboard folder', 'Bash', { command: 'echo x >> ~/.claude/callboard/prompts/ledger-2026-11.jsonl' }, 'settings'],
  ['workspace-lock clear', 'Bash', { command: '/x/workspace-lock.sh --id a clear' }, 'settings'],
  ['ExitPlanMode', 'ExitPlanMode', { plan: 'p' }, 'dialog'],
  ['a git config that sets the hooks folder', 'Bash', { command: 'git config core.hooksPath /tmp/h' }, 'settings'],
  ['a database client, which can run a shell', 'Bash', { command: 'psql -h h -c "select 1"' }, 'settings'],
  ['a shell line that cannot be read', 'Bash', { command: 'eval "$X"' }, 'settings'],
  ['removing ~/.claude', 'Bash', { command: 'rm -rf /Users/x/.claude' }, 'settings'],
]
for (const [name, tool, input, cat] of FLOOR_CASES) {
  test(`prompts: floor at the request: ${name}: no request, a floor ${cat} row, the dialog stays`, async ($, on) => {
    const argv: string[][] = []
    await answerer($, on, [], { argv })
    const c2 = callOf(tool, input)
    const r = await runRequest($, [], c2.over, c2.check)
    expect(r).toEqual({})
    expect(rowKinds()).toEqual([`floor ${cat}`])
    expect(reqFiles().length).toBe(0)
    expect(sleeps(argv).length).toBe(0)
  })
}
// What left the floor reaches the tiers: a request is written, and the rubric judges it.
const REACH_CASES: [string, string, unknown][] = [
  ['a merge', 'mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 1 }],
  ['a machine-ops merge', 'mcp__machine-ops__pr_merge', { owner: 'o', repo: 'r', number: 1 }],
  ['a force push', 'mcp__git-mcp__git_push', { path: '/r', branch: 'feat/x', force: true }],
  ['a push to main', 'mcp__git-mcp__git_push', { path: '/r', branch: 'main' }],
  ['a push with no branch', 'mcp__git-mcp__git_push', { path: '/r' }],
  ['any Bash git push', 'Bash', { command: 'git push origin feat/x' }],
  ['a Bash merge', 'Bash', { command: 'git -C /r checkout main && git -C /r merge feat/x' }],
  ['gh pr merge', 'Bash', { command: 'gh -R o/r pr merge 5' }],
  ['git_clean', 'mcp__git-mcp__git_clean', { path: '/r' }],
  ['git reset hard', 'mcp__git-mcp__git_reset', { path: '/r', mode: 'hard' }],
  ['rm -rf', 'Bash', { command: 'rm -rf /tmp/build' }],
  ['SQL in a tool input', 'mcp__db__query', { sql: 'DELETE FROM users' }],
  ['a commit to main through the GitHub server', 'mcp__github__create_or_update_file', { owner: 'o', repo: 'r', path: 'a', content: 'x', message: 'm', branch: 'main' }],
  ['a GitHub file delete', 'mcp__github__delete_file', { owner: 'o', repo: 'r', path: 'a', message: 'm', branch: 'feat/x' }],
]
for (const [name, tool, input] of REACH_CASES) {
  test(`prompts: reaches the tiers: ${name}: a request is written and no floor row`, async ($, on) => {
    await answerer($, on, [])
    const c2 = callOf(tool, input)
    await runRequest($, [stop(8000)], c2.over, c2.check)
    expect(rowKinds()).toEqual(['requested', 'off'])
  })
}

test('prompts: floor at apply: a call that was fine at the request and edits a guard folder by the time of the decision is dropped', async ($, on) => {
  await answerer($, on, [])
  const c2 = callOf('Edit', { file_path: '/Users/x/code/toolkit/hooks/a.sh', old_string: 'a', new_string: 'b' })
  const r = await runRequest($, [at(4000, () => {
    handDecision(readReq())
    h.hooksList = ['guard.sh']
    realMap.set('/Users/x/.claude/hooks/guard.sh', '/Users/x/code/toolkit/hooks/guard.sh')
  }), stop(40_000)], c2.over, c2.check)
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'dropped floor', 'off'])
})

// ---- apply: each refusal is a dropped row and the wait goes on; a decision that would have landed at 30 s does not ----
const DROPS: [string, (req: any) => void, string][] = [
  ['a wrong hash', (r) => handDecision(r, { inputHash: 'b'.repeat(64) }), 'hash'],
  ['a wrong nonce', (r) => handDecision(r, { nonce: 'other' }), 'nonce'],
  ['a wrong id', (r) => handDecision(r, { id: OTHER }), 'id'],
  ['no answered row', (r) => handDecision(r, {}, false), 'no-answered-row'],
  ['an answered row for another nonce', (r) => handDecision(r, {}, { nonce: 'n' }), 'no-answered-row'],
  ['an answered row that says something else', (r) => handDecision(r, {}, { kind: 'dropped', code: undefined }), 'no-answered-row'],
  ['an author that is the asker', (r) => handDecision(r, { by: { level: 'lead', sid: SID, name: 'svc-api' } }), 'by-sid'],
  ['an author that is no live lead', (r) => handDecision(r, { by: { level: 'lead', sid: OTHER, name: 'X' } }), 'by-sid'],
  ['an author that claims a tier the lane\'s own hook does not have', (r) => handDecision(r, { by: { level: 'manager', sid: LEADSID, name: 'LEAD' } }), 'by-sid'],
]
for (const [name, make, code] of DROPS) {
  test(`prompts: apply: ${name}: dropped ${code}, not applied, the wait goes on`, async ($, on) => {
    await answerer($, on, [])
    const r = await runRequest($, [at(4000, () => make(readReq())), stop(40_000)])
    expect(r).toEqual({})
    expect(rowKinds().filter((k) => k.startsWith('dropped '))).toEqual([`dropped ${code}`])
    expect(rowKinds()).not.toContain('returned allow')
    expect(rowKinds()[rowKinds().length - 1]).toBe('off')
    expect(h.nowMs - T0).toBeGreaterThanOrEqual(40_000)
  })
}
test('prompts: apply: a decision file of the wrong shape, or one that is not ours, is dropped and ignored', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => pfs.set(`${PDIR}/${readReq().id}.decision.json`, { text: '{"id": 1}', mtimeSec: h.nowMs / 1000 })), stop(20_000)])
  expect(r).toEqual({})
  expect(rowKinds().filter((k) => k.startsWith('dropped'))).toEqual(['dropped shape'])
})
test('prompts: apply: a decision file with another mode or a second link is dropped as a file', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => { handDecision(readReq()); pfs.get(`${PDIR}/${readReq().id}.decision.json`)!.mode = '666' }), stop(40_000)])
  expect(r).toEqual({})
  expect(rowKinds().filter((k) => k.startsWith('dropped'))).toEqual(['dropped file'])
})
test('prompts: apply: a ledger that cannot be read keeps the prompt his: dropped ledger-unreadable', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => { handDecision(readReq()); h.pfsFails = (a) => a[0] === '/usr/bin/grep' }), stop(40_000)])
  expect(r).toEqual({})
  expect(rowKinds()).toContain('dropped ledger-unreadable')
  expect(rowKinds()).not.toContain('returned allow')
})
test('prompts: apply: a decision seen a moment before its row is held, then lands when the row does', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), {}, false)), at(8000, () => { const q = readReq(); const l = pfs.get(LEDGER_FILE)!; pfs.set(LEDGER_FILE, { ...l, text: `${l.text}${JSON.stringify({ t: 'x', kind: 'answered', id: q.id, nonce: q.nonce, code: 'allow', by: LEADSID })}\n` }) })])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds().some((k) => k.startsWith('dropped'))).toBe(false)
  expect(h.nowMs - T0).toBe(30_000)
})
test('prompts: apply: a decision made by hand with a ledger row lands, as the plan says it must; the audit finds it by the transcript', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => handDecision(readReq()))])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
})

// ---- the person's click ends the wait: a Yes fires no signal, so the done events and the dialog's own row carry it ----
for (const ev of ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
  test(`prompts: ${ev} with the call's id closes the wait as superseded, and a decision made later is not applied`, async ($, on) => {
    await answerer($, on, [])
    const r = await runRequest($, [at(10_000, async () => { await $.classic[ev]({ tool_name: 'Bash', tool_input: PRQ, tool_use_id: 'tu1', tool_response: {} } as any) }), at(12_000, () => handDecision(readReq()))])
    expect(r).toEqual({})
    expect(rowKinds()).toEqual(['requested', 'superseded'])
    expect(h.nowMs - T0).toBeLessThan(14_000)
    expect(noFiles()).toBe(true)
  })
}
test('prompts: another call\'s end does not close the wait', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(10_000, async () => { await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: PRQ, tool_use_id: 'other', tool_response: {} } as any) }), stop(14_000)])
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'off'])
})
test('prompts: the dialog\'s own row going from waiting to empty closes the wait: a Yes on a long tool', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(10_000, () => { h.sessions = { ...leadReg(), ...ownReg({ status: 'busy', waitingFor: null, statusUpdatedAt: T0 + 10_000 }) } }), at(14_000, () => handDecision(readReq()))])
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'superseded'])
  expect(h.nowMs - T0).toBeLessThanOrEqual(12_000)
})
test('prompts: a row that never showed this request waiting is unknown, not closed: the wait goes on and a decision lands', async ($, on) => {
  await answerer($, on, [])
  await askCheck($)
  h.sessions = { ...leadReg(), ...ownReg() }
  driveClock()
  h.clockHooks.push(at(4000, () => handDecision(readReq())))
  expect(await startReq($)).toEqual({ decision: { behavior: 'allow' } })
})
test('prompts: a stale waiting row from an earlier prompt does not count as this one\'s', async ($, on) => {
  await answerer($, on, [])
  await askCheck($)
  h.sessions = waitingRow(T0 - 5000)
  driveClock()
  h.clockHooks.push(at(6000, () => { h.sessions = { ...leadReg(), ...ownReg() } }), at(8000, () => handDecision(readReq())))
  expect(await startReq($)).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).not.toContain('superseded')
})
test('prompts: a registry row that goes missing or ambiguous is unknown, never closed', async ($, on) => {
  await answerer($, on, [])
  // The mock gives every session a row of its own unless it is told not to; here the row really is gone.
  h.ownEntryAuto = false
  const r = await runRequest($, [at(6000, () => { h.sessions = { ...leadReg() } }), at(10_000, () => { h.sessions = { ...waitingRow(T0 + 500), '4301.json': JSON.stringify({ ...JSON.parse(waitingRow(T0 + 500)['4300.json']), pid: 4301 }) } }), at(12_000, () => handDecision(readReq()))])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).not.toContain('superseded')
})
test('prompts: P-I6: a Yes during the chain beneath ends it with no request: the done event is looked at again after next(e)', async ($, on) => {
  await answerer($, on, [], { beneath: async () => { await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: PRQ, tool_use_id: 'tu1', tool_response: {} } as any); return {} } })
  await askCheck($)
  expect(await startReq($)).toEqual({})
  expect(reqFiles().length).toBe(0)
  expect(rowKinds()).toEqual([])
})
// Live test A, 4c: a Yes that reached the dialog's own row while the decision was being checked still wins over the lead's answer.
test('prompts: the dialog\'s own row is read once more right before a decision is returned: a click that came meanwhile wins', async ($, on) => {
  await answerer($, on, [])
  let flipped = false
  const r = await runRequest($, [at(4000, () => {
    handDecision(readReq())
    // The row changes while the decision is being checked (the ledger look-up is a grep), after the poll's own row read.
    h.pfsFails = (a) => {
      if (a[0] === '/usr/bin/grep' && h.nowMs - T0 >= 30_000 && !flipped) {
        flipped = true
        h.sessions = { ...leadReg(), ...ownReg({ status: 'busy', waitingFor: null, statusUpdatedAt: h.nowMs }) }
      }
      return false
    }
  })])
  expect(flipped).toBe(true)
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'superseded'])
  expect(noFiles()).toBe(true)
})

// Live test A, 4b and 6: a No click cuts the dispatch off and the closing row could not be written. The files stay, and the tick writes the row, then removes them.
test('prompts: a closing row that could not be written keeps the request files; the next retry (the tick, or the next prompt) writes the row and removes them', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(10_000, () => {
    h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a[1] === '-a'
    pfs.set(OFF_FILE, { text: '', mtimeSec: h.nowMs / 1000 })
  })])
  expect(r).toEqual({})
  h.pfsFails = undefined
  pfs.delete(OFF_FILE)
  // No closing row yet, and the request is still on disk.
  expect(rowKinds()).toEqual(['requested'])
  expect(reqFiles().length).toBe(1)
  const first = readReq().id
  // It is marked closed at once: a lead cannot list or answer a request nobody waits for.
  expect(pfs.has(`${PDIR}/${first}.done`)).toBe(true)
  // The next prompt of the session retries first: the row is written, the files go, then the new request goes on as usual.
  const c3 = callOf('Bash', { command: 'ssh other uptime' })
  await askCheck($, { ...c3.check, tool_use_id: 'tu2' })
  h.sessions = waitingRow(h.nowMs)
  driveClock()
  h.clockHooks.push(stop(8000))
  expect(await startReq($, c3.over)).toEqual({})
  expect(pfs.has(`${PDIR}/${first}.request.json`)).toBe(false)
  expect(rowKinds()).toEqual(['requested', 'off', 'requested', 'off'])
  expect(ledgerRows()[1].id).toBe(first)
})
test('prompts: after its own answer the hook\'s next done event is the tool\'s own: nothing is read as a click', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => handDecision(readReq()))])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: PRQ, tool_use_id: 'tu1', tool_response: {} } as any)
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
})

// ---- timing: the awake clock, expiry, a missing tier ----
longTest('prompts: a request nobody answers is denied after 20 minutes of awake time: expired-denied, the lane told why', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [])
  expect(r).toEqual({ decision: { behavior: 'deny', message: prm.DENY_TIMEOUT_MESSAGE } })
  expect(h.nowMs - T0).toBe(20 * 60_000)
  expect(rowKinds()).toEqual(['requested', 'expired-denied timeout'])
  expect(noFiles()).toBe(true)
})
test('prompts: a closed lid does not age a prompt: the sleep gap adds 10 s, so the decision still waits out its 30 s with the dialog open', async ($, on) => {
  await answerer($, on, [])
  let wake = 0
  const r = await runRequest($, [at(4000, () => handDecision(readReq())), at(6000, () => { h.nowMs += 3_600_000; wake = h.nowMs })])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(h.nowMs - wake).toBeGreaterThanOrEqual(12_000)
  expect(rowKinds()).not.toContain('abandoned expired')
})
test('prompts: a lid closed for over 21 minutes does not expire the prompt on wake', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => { h.nowMs += 30 * 60_000 }), stop(60_000 + 30 * 60_000)])
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'off'])
})
test('prompts: no live lead: no request, an abandoned no-tier row, the dialog stays', async ($, on) => {
  await answerer($, on, [])
  leadFiles.delete(LEADPATH)
  expect(await runRequest($, [])).toEqual({})
  expect(rowKinds()).toEqual(['abandoned no-tier'])
  expect(reqFiles().length).toBe(0)
})
test('prompts: a plain session (no lane, no lead) is never covered', async ($, on) => {
  on('classic.PermissionRequest', () => ({}))
  await started($, on, [])
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual([])
})

// ---- the switch's scope ----
for (const [scope, covered] of [['all', true], ['svc-api', true], ['LEAD', true], ['svc-ap', false], ['svc-api2', false], ['OTHERLEAD', false]] as const) {
  test(`prompts: scope ${scope}: ${covered ? 'covers' : 'does not cover'} a lane named svc-api under the lead LEAD`, async ($, on) => {
    await answerer($, on, [], { scope })
    const r = await runRequest($, [stop(8000)])
    expect(r).toEqual({})
    expect(rowKinds()).toEqual(covered ? ['requested', 'off'] : [])
  })
}

// ---- failures leave the dialog; abandoned rows ----
test('prompts: a throwing hook answers nothing: the dialog stays, and the row says hook-failed', async ($, on) => {
  await answerer($, on, [])
  h.pfsFails = (a) => a[0] === '/usr/bin/uuidgen'
  await askCheck($)
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual(['abandoned hook-failed'])
  expect(reqFiles().length).toBe(0)
})
test('prompts: a request file that cannot be written leaves the dialog and says hook-failed', async ($, on) => {
  await answerer($, on, [])
  h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a[1] === '--'
  await askCheck($)
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual(['abandoned hook-failed'])
})
test('prompts: a wait whose /bin/sleep fails ends at once, abandoned hook-failed, and does not spin', async ($, on) => {
  const argv: string[][] = []
  await answerer($, on, [], { argv })
  h.sleepFails = true
  await askCheck($)
  h.sessions = waitingRow(T0 + 500)
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'abandoned hook-failed'])
  expect(sleeps(argv).length).toBe(1)
})
test('prompts: redaction: the request file holds a redacted, capped copy; the ledger holds neither input nor secret', async ($, on) => {
  await answerer($, on, [])
  const secret = `curl -H "Authorization: Bear${'er abc123xyz'}" https://x.example/${'y'.repeat(prm.STRING_CAP + 1000)}`
  const c2 = callOf('Bash', { command: secret })
  await runRequest($, [at(4000, () => {
    const q = readReq()
    expect(JSON.stringify(q)).not.toContain('abc123xyz')
    expect(q.input.command).toContain('[REDACTED]')
    expect(q.truncated).toBe(true)
    expect(new TextEncoder().encode(q.input.command).length).toBeLessThanOrEqual(prm.STRING_CAP)
  }), stop(8000)], c2.over, c2.check)
  expect(JSON.stringify(ledgerRows())).not.toContain('abc123xyz')
  expect(ledgerRows()[0].pattern).toBe('curl')
})
const RID = (n: number) => `${n}a1b2c3d-0000-4000-8000-123456789abc`
test('prompts: sweep: a request of a session that is gone, and one older than a day, are closed with a row and removed; a live fresh one stays', async ($, on) => {
  await answerer($, on, [], { clock: true })
  const put = (sid: string, id: string, ageS: number) => {
    pdirs.add(`${PROMPTS_DIR}/${sid}`)
    pfs.set(`${PROMPTS_DIR}/${sid}/${id}.request.json`, { text: '{}', mtimeSec: T0 / 1000 - ageS })
    pfs.set(`${PROMPTS_DIR}/${sid}/${id}.decision.json`, { text: '{}', mtimeSec: T0 / 1000 - ageS })
  }
  put(GONE, RID(3), 10)
  put(LEADSID, RID(4), 90_000)
  put(LEADSID, RID(5), 10)
  await h.clock!.advance(62_000)
  expect(ledgerRows().map((r) => `${r.kind} ${r.code} ${r.id}`).sort()).toEqual([`abandoned session-gone ${RID(3)}`, `abandoned swept ${RID(4)}`].sort())
  expect(pfs.has(`${PROMPTS_DIR}/${GONE}/${RID(3)}.request.json`)).toBe(false)
  expect(pfs.has(`${PROMPTS_DIR}/${GONE}/${RID(3)}.decision.json`)).toBe(false)
  expect(pfs.has(`${PROMPTS_DIR}/${LEADSID}/${RID(4)}.request.json`)).toBe(false)
  expect(pfs.has(`${PROMPTS_DIR}/${LEADSID}/${RID(5)}.request.json`)).toBe(true)
})
test('prompts: sweep: with no prompts folder the tick makes no process call for it', async ($, on) => {
  const argv: string[][] = []
  await answerer($, on, [], { clock: true, argv })
  const before = argv.length
  await h.clock!.advance(62_000)
  expect(argv.slice(before).filter((a) => a.some((x) => typeof x === 'string' && x.includes('/prompts'))).length).toBe(0)
})

// ---- /callboard escalation and /callboard prompts ----
const EXPECT_Q = prm.ESCALATION_QUESTION
const ESC_VALUE = { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 }
test('prompts: /callboard prompts shows escalation off by default, with the floor', async ($, on) => {
  await started($, on, [])
  expect((await $.command.run(lane('prompts'))).text).toContain('| Escalation | off |')
  expect((await $.command.run(lane('prompts'))).text).toContain('| Open requests | 0 |')
  expect((await $.command.run(lane('prompts'))).text).toContain('Floor (never answered by an agent)')
})
test('prompts: /callboard escalation: the person\'s own command, one dialog naming exactly what turns on, stored on Allow with the two ledger rows the audit reads', async ($, on) => {
  await started($, on, [])
  h.askAnswer = YES
  const r = await $.command.run(lane('escalation'))
  expect(h.askCount).toBe(1)
  expect(h.lastQuestion).toBe(EXPECT_Q)
  expect(h.lastHeader).toBe('Escalation')
  expect(h.askedOptions[0]).toEqual(['Allow', 'Cancel'])
  // Scope all for permission prompts and questions alike; `asks: false` stays for an older mod.
  expect(h.store.get('answering')).toEqual(ESC_VALUE)
  expect(r.text).toContain('Escalation: on for all lanes and leads; questions: answered for all lanes.')
  expect(r.text).toContain('Floor (never answered by an agent)')
  expect(rowKinds()).toEqual(['answering-on', 'answering-on asks'])
  for (const row of ledgerRows()) expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
  expect(ledgerRows()[0].hash).toBe(ledgerRows()[1].hash)
  expect((await $.command.run(lane('prompts'))).text).toContain('| Escalation | on for all lanes and leads |\n| Questions | answered for all lanes |')
})
test('prompts: the old /callboard answering command is gone: every form is the main usage line, nothing asked or stored', async ($, on) => {
  await started($, on, [])
  h.askAnswer = YES
  for (const old of ['answering', 'answering on all', 'answering asks all', 'answering off', 'answering off asks']) {
    const r = await $.command.run(lane(old))
    expect(r.text).not.toMatch(/answering/i)
    expect(r.text).toMatch(/^Use \/callboard /)
  }
  expect(h.askCount).toBe(0)
  expect(h.store.has('answering')).toBe(false)
  expect(ledgerRows()).toEqual([])
})
test('prompts: /callboard escalation with anything after it but off gets the usage line, nothing asked or stored', async ($, on) => {
  await started($, on, [])
  h.askAnswer = YES
  for (const bad of ['escalation on', 'escalation on all', 'escalation all', 'escalation asks all', 'escalation off asks', 'escalation off all', 'escalation svc-api']) {
    expect((await $.command.run(lane(bad))).text).toBe(prm.ESCALATION_USAGE)
  }
  expect(h.askCount).toBe(0)
  expect(h.store.has('answering')).toBe(false)
  expect(ledgerRows()).toEqual([])
})
test('prompts: /callboard escalation again writes a fresh value and both rows again', async ($, on) => {
  await started($, on, [])
  h.askAnswer = YES
  h.store.set('answering', { scope: 'svc-api', asks: false, savedAt: T0 - 1 })
  await $.command.run(lane('escalation'))
  expect(h.store.get('answering')).toEqual(ESC_VALUE)
  expect(rowKinds()).toEqual(['answering-on', 'answering-on asks'])
})
test('prompts: /callboard escalation: Cancel or a timeout stores nothing', async ($, on) => {
  await started($, on, [])
  h.askAnswer = NO
  expect((await $.command.run(lane('escalation'))).text).toBe('Cancelled. Nothing changed.')
  expect(h.store.has('answering')).toBe(false)
  expect(ledgerRows()).toEqual([])
})
for (const kind of ['plugin', 'peer', 'other']) {
  test(`prompts: /callboard escalation from another origin (${kind}) is refused with no dialog and nothing stored`, async ($, on) => {
    await started($, on, [])
    h.askAnswer = YES
    const r = await $.command.run(lane('escalation', { kind }))
    expect(r.text).toBe(prm.ESCALATION_NOT_PERSON)
    expect(h.askCount).toBe(0)
    expect(h.store.has('answering')).toBe(false)
    expect(ledgerRows()).toEqual([])
  })
}
test('prompts: /callboard escalation off from any origin: no dialog, everything stored is cleared (an old narrowed value too), a row is written', async ($, on) => {
  await started($, on, [])
  for (const old of [{ scope: 'all', asks: true, savedAt: T0 }, ESC_VALUE, { scope: 'svc-api', asks: false, asksScope: 'svc-api', savedAt: T0 }]) {
    h.store.set('answering', old)
    const r = await $.command.run(lane('escalation off', { kind: 'plugin' }))
    expect(r.text).toBe('Escalation is off on this Mac.')
    expect(h.askCount).toBe(0)
    expect(h.store.has('answering')).toBe(false)
  }
  expect(rowKinds()).toEqual(['answering-off off', 'answering-off off', 'answering-off off'])
})
test('prompts: /callboard escalation: a ledger that cannot take its rows leaves nothing on, with no store value kept', async ($, on) => {
  await started($, on, [])
  h.askAnswer = YES
  h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a[1] === '-a'
  const r = await $.command.run(lane('escalation'))
  expect(r.text).toBe('Escalation could not be turned on: the ledger did not answer. Nothing changed.')
  expect(h.store.has('answering')).toBe(false)
})
test('prompts: /callboard escalation: a ledger that cannot take its rows puts back what was stored before, an earlier narrower value included', async ($, on) => {
  await started($, on, [])
  h.askAnswer = YES
  for (const old of [ESC_VALUE, { scope: 'svc-api', asks: false, asksScope: 'svc-api', savedAt: T0 - 5 }]) {
    h.store.set('answering', old)
    h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a[1] === '-a'
    const r = await $.command.run(lane('escalation'))
    expect(r.text).toBe('Escalation could not be turned on: the ledger did not answer. Nothing changed.')
    expect(h.store.get('answering')).toEqual(old)
    h.pfsFails = undefined
  }
})
test('prompts: /callboard escalation: the plain row lands and the asks row fails: the value before is back and the ledger ends on a row that says so', async ($, on) => {
  await started($, on, [])
  h.askAnswer = YES
  const cases: [string, unknown, string[]][] = [
    ['nothing stored', undefined, ['answering-on', 'answering-off off']],
    ['an earlier narrower value with a questions scope', { scope: 'svc-api', asks: false, asksScope: 'svc-api', savedAt: T0 - 5 }, ['answering-on', 'answering-on', 'answering-on asks']],
    ['an earlier value with no questions scope', { scope: 'svc-api', asks: false, savedAt: T0 - 5 }, ['answering-on', 'answering-on']],
    ['an earlier value that is not a valid switch', { scope: 5 }, ['answering-on', 'answering-off off']],
  ]
  for (const [, old, rows] of cases) {
    h.store.delete('answering')
    pfs.delete(LEDGER_FILE)
    if (old !== undefined) h.store.set('answering', old)
    let appends = 0
    h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a[1] === '-a' && ++appends === 2
    const r = await $.command.run(lane('escalation'))
    expect(r.text).toBe('Escalation could not be turned on: the ledger did not answer. Nothing changed.')
    if (old === undefined) expect(h.store.has('answering')).toBe(false)
    else expect(h.store.get('answering')).toEqual(old)
    expect(rowKinds()).toEqual(rows)
    h.pfsFails = undefined
  }
})
test('prompts: the state line reads a value an earlier version stored (a narrowed scope, the old asks flag) and names the OFF file', async ($, on) => {
  await started($, on, [])
  h.store.set('answering', { scope: 'svc-api', asks: false, asksScope: 'svc-api', savedAt: T0 })
  expect((await $.command.run(lane('prompts'))).text).toContain('| Escalation | on for svc-api |\n| Questions | answered for svc-api |')
  h.store.set('answering', { scope: 'LEAD', asks: true, savedAt: T0 })
  expect((await $.command.run(lane('prompts'))).text).toContain('| Escalation | on for LEAD |\n| Questions | yours |')
  pfs.set(OFF_FILE, { text: '', mtimeSec: T0 / 1000 })
  expect((await $.command.run(lane('prompts'))).text).toContain('The OFF file exists')
})
test('prompts: /callboard prompts counts open requests', async ($, on) => {
  await started($, on, [])
  pdirs.add(`${PROMPTS_DIR}/${LEADSID}`)
  pfs.set(`${PROMPTS_DIR}/${LEADSID}/${RID(3)}.request.json`, { text: '{}', mtimeSec: T0 / 1000 })
  expect((await $.command.run(lane('prompts'))).text).toContain('| Open requests | 1 |')
})

// ---- review fixes ----
test('prompts: a switch narrowed to another scope during a wait ends it: row off, dialog left to the person', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => { h.store.set('answering', { scope: 'OTHERLANE', asks: false, savedAt: h.nowMs }) }), at(6000, () => handDecision(readReq()))])
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'off'])
  expect(noFiles()).toBe(true)
})
for (const scope of ['LEAD', 'svc-api']) {
  test(`prompts: scope ${scope}: the lead's answer lands`, async ($, on) => {
    await answerer($, on, [], { scope })
    const r = await runRequest($, [at(4000, () => handDecision(readReq()))])
    expect(r).toEqual({ decision: { behavior: 'allow' } })
    expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
  })
}
test('prompts: a session the scope does not cover leaves no row, even for an ask on the floor or one a hook raised', async ($, on) => {
  await answerer($, on, [], { scope: 'OTHERLANE' })
  const c2 = callOf('Bash', { command: 'git push origin x' })
  expect(await runRequest($, [], c2.over, c2.check)).toEqual({})
  h.prVerdict = { decision: 'ask', hook: 'PreToolUse', reason: 'x' }
  await askCheck($, { tool_use_id: 'tu3' })
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual([])
})
test('prompts: a ledger that cannot take the requested row leaves the dialog: no wait, no files', async ($, on) => {
  const argv: string[][] = []
  await answerer($, on, [], { argv })
  h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a[1] === '-a'
  await askCheck($)
  h.sessions = waitingRow(T0 + 500)
  expect(await startReq($)).toEqual({})
  expect(sleeps(argv).length).toBe(0)
  expect(noFiles()).toBe(true)
})
test('prompts: a poll reads this session\'s own row by one file: no table of every process is read while waiting', async ($, on) => {
  const argv: string[][] = []
  await answerer($, on, [], { argv })
  let mark = -1
  let during: string[][] = []
  const r = await runRequest($, [at(4000, () => { mark = argv.length }), at(18_000, () => { during = argv.slice(mark) }), at(20_000, () => handDecision(readReq()))])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(during.length).toBeGreaterThan(10)
  expect(during.filter((a) => a[0] === '/bin/ps').length).toBe(0)
  expect(during.some((a) => a[0] === '/usr/bin/stat' && a.some((x) => String(x).endsWith('/4300.json')))).toBe(true)
})
test('prompts: floor: an edit under the folder that the hooks of ~/.claude link into (the toolkit checkout) is settings', async ($, on) => {
  await answerer($, on, [])
  h.hooksList = ['guard.sh']
  realMap.set('/Users/x/.claude/hooks/guard.sh', '/Users/x/code/toolkit/hooks/guard.sh')
  const c2 = callOf('Edit', { file_path: '/Users/x/code/toolkit/rules/a.md', old_string: 'a', new_string: 'b' })
  expect(await runRequest($, [], c2.over, c2.check)).toEqual({})
  expect(rowKinds()).toEqual(['floor settings'])
  // Elsewhere stays judged.
  const c3 = callOf('Edit', { file_path: '/Users/x/code/other/a.md', old_string: 'a', new_string: 'b' })
  await askCheck($, { ...c3.check, tool_use_id: 'tu2' })
  h.sessions = waitingRow(T0 + 500)
  driveClock()
  h.clockHooks.push(stop(8000))
  expect(await startReq($, c3.over)).toEqual({})
  expect(rowKinds()).toEqual(['floor settings', 'requested', 'off'])
})
// ---- the lane's own report under a live checkout: the one write a tier may answer ----
// The lane svc-api's repo is PIN, made a live root here the way the toolkit's is: through a link from ~/.claude/hooks.
const OWN_REPORT = `${PIN}/.archive/svc-api/REPORT.md`
const liveRootIsPin = () => {
  h.hooksList = ['guard.sh']
  realMap.set('/Users/x/.claude/hooks/guard.sh', `${PIN}/hooks/guard.sh`)
}
test('prompts: floor: a lane\'s own REPORT.md under a live root raises a request; every other path under it stays the floor', async ($, on) => {
  await answerer($, on, [])
  liveRootIsPin()
  const held: [string, string, Record<string, unknown>][] = [
    ['another lane\'s report', 'Write', { file_path: `${PIN}/.archive/OTHER/REPORT.md`, content: 'x' }],
    ['the lane\'s own brief', 'Write', { file_path: `${PIN}/.archive/svc-api/BRIEF.md`, content: 'x' }],
    ['a file of the checkout', 'Edit', { file_path: `${PIN}/docs/a.md`, old_string: 'a', new_string: 'b' }],
    ['the report with another case', 'Write', { file_path: `${PIN}/.archive/SVC-API/REPORT.md`, content: 'x' }],
    ['the report through a dot-dot road to another lane', 'Write', { file_path: `${PIN}/.archive/svc-api/../OTHER/REPORT.md`, content: 'x' }],
    ['a shell append to the own report', 'Bash', { command: `echo 'status: done x' >> ${OWN_REPORT}` }],
  ]
  let n = 0
  for (const [, tool, input] of held) {
    const c2 = callOf(tool, input)
    expect(await runRequest($, [], c2.over, { ...c2.check, tool_use_id: `tu${++n}` })).toEqual({})
  }
  expect(rowKinds()).toEqual(held.map(() => 'floor settings'))
  expect(reqFiles().length).toBe(0)
  // A link in place of the report, a second hard link to it, and a real path that is somewhere else: held.
  realMap.set(OWN_REPORT, `${PIN}/tools/callboard/mod/hooks/register.ts`)
  const cw = callOf('Write', { file_path: OWN_REPORT, content: 'x' })
  expect(await runRequest($, [], cw.over, { ...cw.check, tool_use_id: 'tu20' })).toEqual({})
  realMap.delete(OWN_REPORT)
  extraStat.set(OWN_REPORT, '501 600 2 Regular File 55 40 1700000000\n')
  expect(await runRequest($, [], cw.over, { ...cw.check, tool_use_id: 'tu21' })).toEqual({})
  extraStat.set(OWN_REPORT, '501 600 1 Symbolic Link 55 40 1700000000\n')
  expect(await runRequest($, [], cw.over, { ...cw.check, tool_use_id: 'tu22' })).toEqual({})
  expect(rowKinds().slice(held.length)).toEqual(['floor settings', 'floor settings', 'floor settings'])
  expect(reqFiles().length).toBe(0)
})
longTest('prompts: floor: the lane\'s own REPORT.md (Write, Edit or MultiEdit) gets a request that names the file, and a decision on it is applied', async ($, on) => {
  await answerer($, on, [])
  liveRootIsPin()
  for (const [tool, input] of [
    ['Write', { file_path: OWN_REPORT, content: 'x' }],
    ['Edit', { file_path: OWN_REPORT, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: OWN_REPORT, edits: [{ old_string: 'a', new_string: 'b' }] }],
  ] as [string, Record<string, unknown>][]) {
    pfs.delete(LEDGER_FILE)
    const c2 = callOf(tool, input)
    let seenReq: any
    const r = await runRequest($, [at(4000, () => { seenReq = readReq(); handDecision(seenReq) })], c2.over, c2.check)
    expect(seenReq.ownReport, tool).toBe(OWN_REPORT)
    expect(r, tool).toEqual({ decision: { behavior: 'allow' } })
    expect(rowKinds(), tool).toEqual(['requested', 'answered allow', 'returned allow'])
  }
  // A write of any other file raises its request with no ownReport on it.
  pfs.delete(LEDGER_FILE)
  const other = callOf('Write', { file_path: '/Users/x/code/other/a.md', content: 'x' })
  let otherReq: any
  await runRequest($, [at(4000, () => { otherReq = readReq() }), stop(6000)], other.over, { ...other.check, tool_use_id: 'tu30' })
  expect(otherReq.ownReport).toBeUndefined()
})
test('prompts: floor: a decision on the own report is not applied if the file became a second hard link while the request waited', async ($, on) => {
  await answerer($, on, [])
  liveRootIsPin()
  const c2 = callOf('Write', { file_path: OWN_REPORT, content: 'x' })
  const r = await runRequest($, [at(4000, () => { extraStat.set(OWN_REPORT, '501 600 2 Regular File 55 40 1700000000\n') }), at(5000, () => handDecision(readReq())), stop(9000)], c2.over, c2.check)
  expect(r).toEqual({})
  expect(rowKinds()).not.toContain('returned allow')
})
test('prompts: floor: with no verified own report on the request the old rule holds for a tier too (floor), and with one it is answered', async ($, on) => {
  await tier($, on)
  liveRootIsPin()
  // The lane's record, as the tier's own store has it (an attached lane in SVC, whose repo is PIN).
  putStore([attRec(LEADSID, 'svc-api')])
  const w = (file_path: string) => ({ tool: 'Write', input: { file_path, content: 'x' } })
  // The request carries no ownReport, or one for another lane or another file: the floor, whichever way the tier decides.
  for (const over of [{ ...w(OWN_REPORT) }, { ...w(OWN_REPORT), ownReport: `${PIN}/.archive/OTHER/REPORT.md` }, { ...w(`${PIN}/.archive/OTHER/REPORT.md`), ownReport: OWN_REPORT }, { ...w(`${PIN}/docs/a.md`), ownReport: OWN_REPORT },
    // The request's lane has no record that gives that path.
    { ...w(`${PIN}/.archive/ghost/REPORT.md`), ownReport: `${PIN}/.archive/ghost/REPORT.md`, lane: 'ghost' },
    { ...w(OWN_REPORT), ownReport: `${PIN}/.archive/svc-api/../svc-api/REPORT.md` }, { ...w(OWN_REPORT), ownReport: `${PIN}/.archive/svc-api/BRIEF.md` }, { ...w(OWN_REPORT), ownReport: 'REPORT.md' }]) {
    putQ(over)
    for (const decision of ['allow', 'deny']) expect(said(await $.tool.call(answerCall({ decision }))), JSON.stringify(over)).toContain(refusal('floor'))
  }
  expect(decFile()).toBeUndefined()
  putQ({ ...w(OWN_REPORT), ownReport: OWN_REPORT })
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
  expect(decFile()).toBeDefined()
})
test('prompts: sweep: folders past the first 64 are reached on a later tick; an old orphan file and the empty folder of a gone session go', async ($, on) => {
  await answerer($, on, [], { clock: true })
  const sids = Array.from({ length: 70 }, (_, i) => `${(i + 16).toString(16).padStart(8, '0')}-0000-4000-8000-123456789abc`)
  for (const sid of sids) pdirs.add(`${PROMPTS_DIR}/${sid}`)
  pfs.set(`${PROMPTS_DIR}/${sids[1]}/${RID(6)}.decision.json`, { text: '{}', mtimeSec: T0 / 1000 - 90_000 })
  pfs.set(`${PROMPTS_DIR}/${sids[1]}/${RID(7)}.done`, { text: '', mtimeSec: T0 / 1000 - 10 })
  pfs.set(`${PROMPTS_DIR}/${sids[69]}/${RID(8)}.request.json`, { text: '{}', mtimeSec: T0 / 1000 - 10 })
  // A fresh mod sweeps at its first tick, then once a minute.
  await h.clock!.advance(5_000)
  const state = () => ({ d0: pdirs.has(`${PROMPTS_DIR}/${sids[0]}`), d1: pdirs.has(`${PROMPTS_DIR}/${sids[1]}`), orphan: pfs.has(`${PROMPTS_DIR}/${sids[1]}/${RID(6)}.decision.json`), fresh: pfs.has(`${PROMPTS_DIR}/${sids[1]}/${RID(7)}.done`), req: pfs.has(`${PROMPTS_DIR}/${sids[69]}/${RID(8)}.request.json`) })
  // The first tick looks at the first 64 folders: the empty ones of a gone session go, a day-old orphan goes, a fresh orphan stays, the last folder is not reached.
  expect(state()).toEqual({ d0: false, d1: true, orphan: false, fresh: true, req: true })
  await h.clock!.advance(62_000)
  expect(pfs.has(`${PROMPTS_DIR}/${sids[69]}/${RID(8)}.request.json`)).toBe(false)
  expect(ledgerRows().map((r) => `${r.kind} ${r.code} ${r.id}`)).toEqual([`abandoned session-gone ${RID(8)}`])
})

test('prompts: floor: a git call that rewrites the work tree of the toolkit checkout (found through the linked hooks) is settings; a read there is judged', async ($, on) => {
  await answerer($, on, [])
  h.hooksList = ['guard.sh']
  realMap.set('/Users/x/.claude/hooks/guard.sh', '/Users/x/code/toolkit/hooks/guard.sh')
  const c2 = callOf('mcp__git-mcp__git_checkout', { path: '/Users/x/code/toolkit', target: 'feat/x' })
  expect(await runRequest($, [], c2.over, c2.check)).toEqual({})
  expect(rowKinds()).toEqual(['floor settings'])
  expect(reqFiles().length).toBe(0)
  // The lane's own clone, named by its path, is not a live checkout.
  const c3 = callOf('mcp__git-mcp__git_checkout', { path: SVC, target: 'feat/x' })
  await askCheck($, { ...c3.check, tool_use_id: 'tu2', cwd: SVC })
  h.sessions = waitingRow(T0 + 500)
  driveClock()
  h.clockHooks.push(stop(8000))
  expect(await startReq($, { ...c3.over, cwd: SVC })).toEqual({})
  expect(rowKinds()).toEqual(['floor settings', 'requested', 'off'])
  // With no path the git server acts in its own folder, which cannot be placed: it stays the person's, whatever folder the session runs in.
  pfs.delete(OFF_FILE)
  const c4 = callOf('mcp__git-mcp__git_checkout', { target: 'feat/x' })
  await askCheck($, { ...c4.check, tool_use_id: 'tu3' })
  h.sessions = waitingRow(T0 + 500)
  driveClock()
  expect(await startReq($, { ...c4.over, cwd: SVC })).toEqual({})
  expect(rowKinds().filter((k) => k === 'floor settings').length).toBe(2)
})
test('prompts: sweep: a request older than a day whose own process is still live is kept; one of another process of that session is swept', async ($, on) => {
  await answerer($, on, [], { clock: true })
  const old = T0 / 1000 - 90_000
  pdirs.add(PDIR)
  pfs.set(`${PDIR}/${RID(9)}.request.json`, { text: JSON.stringify({ pid: 4300, procStart: LEADPS }), mtimeSec: old })
  pfs.set(`${PDIR}/${RID(1)}.request.json`, { text: JSON.stringify({ pid: 9999, procStart: LEADPS }), mtimeSec: old })
  await h.clock!.advance(5_000)
  expect(pfs.has(`${PDIR}/${RID(9)}.request.json`)).toBe(true)
  expect(pfs.has(`${PDIR}/${RID(1)}.request.json`)).toBe(false)
  expect(ledgerRows().map((r) => `${r.kind} ${r.code} ${r.id}`)).toEqual([`abandoned swept ${RID(1)}`])
})
test('prompts: a wait whose request file disappears ends without a second closing row, and the dialog is left to the person', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => { pfs.delete(reqFiles()[0]) })])
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested'])
  expect(noFiles()).toBe(true)
})

// ---- the lane's own hook: a passed-up request ends the wait, and the comment cap is read at apply ----
const GUARD_ASK = { decision: 'ask', hook: 'PreToolUse', reason: 'github-mcp-guard: ask for the lab' }
const COMMENT_CALL = callOf('mcp__github__add_issue_comment', PCOMMENT)

test('prompts hook: the comment cap is read at apply: a decision over it is dropped as cap and the wait goes on', async ($, on) => {
  await answerer($, on, [], { verdict: GUARD_ASK })
  putLedger([retRow(), retRow()])
  const r = await runRequest($, [at(4000, () => handDecision(readReq())), stop(20_000)], COMMENT_CALL.over, COMMENT_CALL.check)
  expect(r).toEqual({})
  // The `answered` row of a hand-made decision is the seeded one, not the hook's.
  expect(hookKinds()).toEqual(['requested', 'dropped cap', 'off'])
  expect(noFiles()).toBe(true)
})

test('prompts hook: a decision under the cap lands, and its returned row carries the cap kind and the target for the next count', async ($, on) => {
  await answerer($, on, [], { verdict: GUARD_ASK })
  putLedger([retRow()])
  const r = await runRequest($, [at(4000, () => handDecision(readReq()))], COMMENT_CALL.over, COMMENT_CALL.check)
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(hookRows().filter((x) => x.kind === 'returned')).toEqual([expect.objectContaining({ code: 'allow', cap: 'comments', target: 'acme/app#7' })])
  expect(h.nowMs - T0).toBe(30_000)
})

test('prompts hook: a ledger that cannot be read at apply counts as over the cap: the prompt stays the person\'s', async ($, on) => {
  await answerer($, on, [], { verdict: GUARD_ASK })
  putLedger([retRow()])
  const r = await runRequest($, [at(4000, () => { handDecision(readReq()); h.pfsFails = (a) => a[0] === '/usr/bin/grep' && a.some((x) => x.startsWith('"target"')) }), stop(20_000)], COMMENT_CALL.over, COMMENT_CALL.check)
  expect(r).toEqual({})
  expect(hookKinds()).toContain('dropped cap')
  expect(hookKinds()).not.toContain('returned allow')
})

test('prompts hook: a call with no @claude body never reads the cap', async ($, on) => {
  await answerer($, on, [], { verdict: GUARD_ASK })
  const c = callOf('mcp__github__add_issue_comment', { ...PCOMMENT, body: 'thanks' })
  putLedger([retRow(), retRow()])
  const r = await runRequest($, [at(4000, () => handDecision(readReq()))], c.over, c.check)
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(hookRows().filter((x) => x.kind === 'returned')[0].cap).toBeUndefined()
  expect(hookRows().filter((x) => x.kind === 'returned')[0].target).toBeUndefined()
})

test('prompts floor: a relative write with no folder from the engine is floor; with the event\'s folder it is judged', async ($, on) => {
  await answerer($, on, [])
  const wr = { command: 'echo x > notes.txt' }
  expect(await runRequest($, [], { tool_input: wr, cwd: undefined }, { input: wr })).toEqual({})
  expect(rowKinds()).toEqual(['floor settings'])
  await askCheck($, { input: wr, tool_use_id: 'tu2', cwd: '/w/svc' })
  h.sessions = waitingRow(T0 + 500)
  driveClock()
  h.clockHooks.push(stop(8000))
  await startReq($, { tool_input: wr, cwd: '/w/svc' })
  expect(rowKinds()).toContain('requested')
})

test('prompts: a request id found in two folders is answered in neither', async ($, on) => {
  await tier($, on)
  putQ()
  putQ({ sid: '2a1b2c3d-0000-4000-8000-123456789abc' })
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('unknown-request'))
  expect(decFile()).toBeUndefined()
})

test('prompts: a folder at the decision path reads as an answer already there, and nothing is recorded', async ($, on) => {
  await tier($, on)
  putQ()
  pdirs.add(`${LDIR()}/${TID}.decision.json`)
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('decided'))
  expect(answered()).toEqual([])
})

test('prompts: an answered row that cannot be written takes the decision file back', async ($, on) => {
  await tier($, on)
  putQ()
  h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a.includes('-a')
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('write-failed'))
  expect(decFile()).toBeUndefined()
})

test('prompts: the temporary name of a decision is drawn from a fresh uuid, never from a counter two processes could share', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await tier($, on, stdins, { argv })
  putQ()
  await $.tool.call(answerCall())
  const tmp = argv.filter((a) => a[0] === '/usr/bin/install' && a.at(-1)!.endsWith('.tmp') && a.at(-1)!.includes('.decision.json.')).map((a) => a.at(-1)!)
  expect(tmp.length).toBe(1)
  expect(tmp[0]).toMatch(/\.decision\.json\.\d{10,}\.tmp$/)
})

test('prompts hook: a lead\'s deny over the cap is applied: the cap binds an allow only', async ($, on) => {
  await answerer($, on, [], { verdict: GUARD_ASK })
  putLedger([retRow(), retRow()])
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'deny', why: 'not needed' }))], COMMENT_CALL.over, COMMENT_CALL.check)
  expect(r).toEqual({ decision: { behavior: 'deny', message: 'Denied by the lead LEAD: not needed' } })
  expect(hookKinds()).toEqual(['requested', 'returned deny'])
})

test('prompts hook: a decision file rewritten after its row (a deny turned into an allow) is not found: no returned row, dropped after the grace', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), { decision: 'allow' }, { code: 'deny' })), stop(30_000)])
  expect(r).toEqual({})
  expect(hookKinds()).not.toContain('returned allow')
  expect(hookKinds()).toContain('dropped no-answered-row')
})

test('prompts hook: the row must name the same author as the file', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), {}, { by: LEAD2 })), stop(30_000)])
  expect(r).toEqual({})
  expect(hookKinds()).toContain('dropped no-answered-row')
})

test('prompts hook: the returned row names the author and the call (tuid), for the audit to match one for one', async ($, on) => {
  await answerer($, on, [])
  await runRequest($, [at(4000, () => handDecision(readReq()))])
  const row = hookRows().find((x) => x.kind === 'returned')!
  expect(row).toMatchObject({ code: 'allow', by: LEADSID, tuid: 'tu1' })
})

test('prompts hook: a person\'s answer that lands between two polls, after the question spent the asked mark just before the 2-minute check, is applied, not lost as not-asked', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => putRelay(readReq())), at(121_000, () => handDecision(readReq(), { decision: 'deny', via: 'person', why: 'the person answered No via the lead LEAD' }, { via: 'person' }))])
  expect(r).toEqual({ decision: { behavior: 'deny', message: 'Denied by the person via the lead LEAD.' } })
  expect(rowKinds()).not.toContain('relay-lost not-asked')
})

test('prompts hook: a dropped decision is taken away, so the request is open to the tiers again (a file left in place would refuse every answer and pass-up as decided)', async ($, on) => {
  await answerer($, on, [])
  const gone: boolean[] = []
  const r = await runRequest($, [
    at(4000, () => { putRelay(readReq()); pfs.set(`${PDIR}/${readReq().id}.asked`, { text: '{}', mtimeSec: h.nowMs / 1000 }); handDecision(readReq()) }),
    at(8000, () => gone.push(!pfs.has(`${PDIR}/${readReq().id}.decision.json`))),
    at(12_000, () => pfs.set(`${PDIR}/${readReq().id}.decision.json`, { text: '{"id": 1}', mtimeSec: h.nowMs / 1000 })),
    at(16_000, () => gone.push(!pfs.has(`${PDIR}/${readReq().id}.decision.json`))),
    stop(20_000),
  ])
  expect(r).toEqual({})
  expect(gone).toEqual([true, true])
  expect(rowKinds().filter((k) => k.startsWith('dropped'))).toEqual(['dropped relay', 'dropped shape'])
})

test('prompts hook: a decision whose author could not be looked up (a ps that failed) is held, not dropped: it lands at the next poll that can; a clear no is still dropped at once', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, () => { handDecision(readReq()); psFail.add('4242') }), at(10_000, () => { expect(pfs.has(`${PDIR}/${readReq().id}.decision.json`)).toBe(true); expect(rowKinds().some((k) => k.startsWith('dropped'))).toBe(false); psFail.clear() })])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
})
