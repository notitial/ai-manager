import { expect, test } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import { leadBriefing, nudgeText } from '../hooks/core'
import { h, GOOD, PROMPTS_DIR, ROOT, SID, T0, leadFiles, longTest, pfs, submitted, toolDefs } from './harness'
import { APISID, APP2, COMPOSE, LEADPATH, LEADPS, LEADSID, MGR_SESS, OTHER, PIN, SVC, TURN, condOn, leadFileText, leadReg, logged, mgrAt, midCtx, ownReg, ownTurn, postBeneath, putStore, storeJson, tickTwice, ticks } from './fixtures'
import { APIQ, CNDT, LANESID, LDIR, LEAD2, MGRT, OFF_FILE, PCOMMENT, PDIR, THASH, TID, TID2, addCondT, addMgrT, answerCall, answered, answerer, asConductor, askCheck, at, byCond, byMgr, decFile, decideBy, driveClock, handDecision, hookKinds, leadLive, ledgerRows, pcall, putFile, putFileAt, putLedger, putQ, putRelayT, readReq, refusal, reqFiles, retRow, rowKinds, runRequest, said, startReq, stop, tier, tierSessions, waitingRow } from './answer-fixtures'

test('the lead is resolved record first: a record that names a lead is reached by the live lead of that name only, whatever lead the binding holds', async ($, on) => {
  await answerer($, on, [])
  expect((storeJson().lanes as { leadName?: string }[])[0].leadName).toBe('LEAD')
  // The lead the lane was bound to is still live by its presence file, but under another registry name now: the record names LEAD, so nobody can be asked.
  await askCheck($)
  h.sessions = { ...leadReg({ name: 'LEADX' }), ...ownReg({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: T0 + 500 }) }
  driveClock()
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual(['abandoned no-tier'])
  expect(reqFiles().length).toBe(0)
})
longTest('a bound lane whose record cannot be found reaches no lead, though one lead is live: no request, abandoned no-tier', async ($, on) => {
  await answerer($, on, [])
  // The binding stays (it names the lane and its lead) but the lane's record is gone from the store.
  putStore([])
  await askCheck($)
  h.sessions = waitingRow(T0 + 500)
  driveClock()
  expect(await startReq($)).toEqual({})
  expect(rowKinds()).toEqual(['abandoned no-tier'])
  expect(reqFiles().length).toBe(0)
})
test('a record that names its lead finds it by the registry name, so the request carries that name', async ($, on) => {
  await answerer($, on, [])
  expect((await runRequest($, [at(4000, () => handDecision(readReq()))]))).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
})
test('prompts: a lead\'s own prompt starts at the conductor, which does not exist yet: no request', async ($, on) => {
  await answerer($, on, [], { asLead: true })
  expect(await runRequest($, [])).toEqual({})
  expect(rowKinds()).toEqual(['abandoned no-tier'])
  expect(reqFiles().length).toBe(0)
})
const PREV_LEDGER = `${PROMPTS_DIR}/ledger-2023-10.jsonl`

test('prompts: prompt_list is empty while answering is off, and says so', async ($, on) => {
  await tier($, on, [], { off: true })
  putQ()
  const t = said(await $.tool.call(pcall('prompt_list')))
  expect(t).toContain('Escalation is off on this Mac. Nothing is waiting for you.')
  expect(t).not.toContain(TID)
})

test('prompts: prompt_list shows the open request of a lane in reach: the input in a frame, the age, the rubric after it', async ($, on) => {
  await tier($, on)
  putQ()
  const t = said(await $.tool.call(pcall('prompt_list')))
  expect(t).toContain('1 prompt waiting.')
  expect(t).toContain(`### ${TID}`)
  expect(t).toContain('lane: svc-api · tool: Bash · raised by: rule · open 0 s')
  expect(t).toContain('<untrusted-input>')
  expect(t).toContain('ssh host uptime')
  expect(t).toContain('held until the prompt has been open 30 s')
  expect(t).toContain('**Allow only if you can say yes to all of these:**')
  expect(t.indexOf('</untrusted-input>')).toBeLessThan(t.indexOf('**Allow only if'))
})

test('prompts: prompt_list leaves out what is not the lead\'s: an uncovered lane, a dead session, a closed, answered or passed-up request, its own prompt', async ($, on) => {
  await tier($, on, [], { scope: 'svc-api' })
  const A = '3a1b2c3d-0000-4000-8000-123456789abc'
  const B = '4a1b2c3d-0000-4000-8000-123456789abc'
  putQ({ id: TID2, lane: 'other-lane' })
  for (const id of [A, B]) putQ({ id })
  putFile(`${A}.done`)
  putFile(`${B}.decision.json`, '{}')
  putQ({ id: '1a1b2c3d-1111-4000-8000-123456789abc', sid: SID, lane: 'LEAD' })
  putQ({ id: '1a1b2c3d-2222-4000-8000-123456789abc', sid: '9a1b2c3d-0000-4000-8000-123456789abc', pid: 4301 })
  expect(said(await $.tool.call(pcall('prompt_list')))).toBe(prm.promptListText([], { on: true }))
  // The same kind of request, for the covered lane and not closed, is shown.
  putQ({ id: '1a1b2c3d-3333-4000-8000-123456789abc' })
  expect(said(await $.tool.call(pcall('prompt_list')))).toContain('1a1b2c3d-3333-4000-8000-123456789abc')
})

test('prompts: prompt_list shows a request that names no lead to any lead of the repo, but never one that names another lead', async ($, on) => {
  await tier($, on)
  putQ({ leadName: undefined })
  expect(said(await $.tool.call(pcall('prompt_list')))).toContain(TID)
  putQ({ leadName: 'ANOTHER' })
  expect(said(await $.tool.call(pcall('prompt_list')))).not.toContain(TID)
})

test('prompts: prompt_list says a truncated input cannot be allowed, and counts decisions dropped for a reason that can mean a forgery', async ($, on) => {
  await tier($, on)
  putQ({ truncated: true })
  putLedger([{ t: 'x', kind: 'dropped', code: 'no-answered-row', id: TID }, { t: 'x', kind: 'dropped', code: 'expired', id: TID2 }])
  const t = said(await $.tool.call(pcall('prompt_list')))
  expect(t).toContain('TRUNCATED: you have not seen all of it')
  expect(t).toContain('1 decision was dropped in the last two months')
})

test('prompts: prompt_answer writes the decision file and its answered row; the file is exactly what the hook applies', async ($, on) => {
  await tier($, on)
  const q = putQ()
  const r = await $.tool.call(answerCall())
  expect(said(r)).toContain(`Recorded: allow for ${TID}.`)
  expect(said(r)).toContain('yours, not the person\'s')
  const d = prm.parseDecision(decFile()!.text)!
  expect(d).toEqual({ id: TID, inputHash: THASH, decision: 'allow', why: 'read only, seen whole', by: { level: 'lead', sid: SID, name: 'LEAD' }, via: undefined, at: T0, nonce: 'n-1' })
  expect(answered()).toEqual([expect.objectContaining({ kind: 'answered', id: TID, nonce: 'n-1', code: 'allow', tier: 'lead', lane: 'svc-api', tool: 'Bash', pattern: 'ssh', hash: THASH, why: 'read only, seen whole' })])
  // The row carries the id as ledgerLine writes it, the needle the hook greps for.
  expect([...pfs.values()].some((v) => v.text.includes(`"id":"${TID}"`))).toBe(true)
  expect(prm.applyCheck({ req: { id: TID, nonce: q.nonce, inputHash: THASH, sid: LANESID }, decision: d, liveHash: THASH, awakeMs: 30_000, expiresAt: prm.EXPIRES_MS, floor: undefined, byOk: true, ledger: 'found', graceMs: 0 })).toEqual({ ok: true })
  expect(JSON.stringify(ledgerRows())).not.toContain('uptime')
})

test('prompts: a deny is recorded the same way; the why is required, one line, at most 200 characters; the arguments are exact', async ($, on) => {
  await tier($, on)
  putQ()
  for (const why of ['', '   ', 'two\nlines', 'x'.repeat(201), undefined]) expect(said(await $.tool.call(answerCall({ why })))).toContain(`prompt_answer refused: ${refusal('bad-input')}`)
  for (const decision of ['maybe', 'ALLOW', undefined, 3]) expect(said(await $.tool.call(answerCall({ decision })))).toContain(refusal('bad-input'))
  for (const id of ['', 'x', TID.toUpperCase(), `${TID}/../x`, 5]) expect(said(await $.tool.call(answerCall({ id })))).toContain(refusal('bad-input'))
  expect(decFile()).toBeUndefined()
  expect(said(await $.tool.call(answerCall({ decision: 'deny', why: 'not this lane\'s work' })))).toContain(`Recorded: deny for ${TID}.`)
  expect(prm.parseDecision(decFile()!.text)!.decision).toBe('deny')
  expect(answered().map((r) => r.code)).toEqual(['deny'])
})

test('prompts: two answers at once: the first wins, the second is told so, and there is one answered row', async ($, on) => {
  await tier($, on)
  putQ()
  const [a, b] = await Promise.all([$.tool.call(answerCall({ why: 'first' })), $.tool.call(answerCall({ decision: 'deny', why: 'second' }))])
  const texts = [said(a), said(b)]
  expect(texts.filter((t) => t.startsWith('Recorded')).length).toBe(1)
  expect(texts.filter((t) => t.includes(refusal('decided'))).length).toBe(1)
  expect(answered().length).toBe(1)
  expect(prm.parseDecision(decFile()!.text)!.why).toBe(answered()[0].why)
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('decided'))
  expect(answered().length).toBe(1)
})

test('prompts: prompt_answer refuses its own prompt, an unknown id, a request out of reach, a closed or passed-up one, and writes nothing', async ($, on) => {
  await tier($, on, [], { scope: 'svc-api' })
  const own = '1a1b2c3d-1111-4000-8000-123456789abc'
  putQ({ id: own, sid: SID, lane: 'LEAD' })
  expect(said(await $.tool.call(answerCall({ id: own })))).toContain(refusal('own-request'))
  expect(said(await $.tool.call(answerCall({ id: TID2 })))).toContain(refusal('unknown-request'))
  putQ({ id: TID, leadName: 'ANOTHER' })
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('unknown-request'))
  putQ({ id: TID, lane: 'uncovered' })
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('unknown-request'))
  putQ()
  putFile(`${TID}.done`)
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('closed'))
  pfs.delete(`${LDIR()}/${TID}.done`)
  tierSessions({}, null)
  putQ()
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('unknown-request'))
  expect(decFile()).toBeUndefined()
  expect(answered()).toEqual([])
})

test('prompts: prompt_answer refuses while answering is off or the OFF file exists, and a subagent\'s call', async ($, on) => {
  await tier($, on)
  putQ()
  expect(said(await $.tool.call({ ...answerCall(), agentId: 'a1' }))).toContain('for the main agent only')
  pfs.set(OFF_FILE, { text: '', mtimeSec: T0 / 1000 })
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('off'))
  pfs.delete(OFF_FILE)
  h.store.delete('answering')
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('off'))
  expect(decFile()).toBeUndefined()
})

test('prompts: a truncated input can be denied but never allowed', async ($, on) => {
  await tier($, on)
  putQ({ truncated: true })
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('truncated'))
  expect(decFile()).toBeUndefined()
  expect(said(await $.tool.call(answerCall({ decision: 'deny', why: 'cannot see it all, and it looks wrong' })))).toContain('Recorded: deny')
})

test('prompts: prompt_answer never answers a floor call, allow or deny', async ($, on) => {
  await tier($, on)
  const floorCalls: [string, unknown][] = [
    ['Bash', { command: 'echo x >> ~/.claude/hooks/guard.sh' }],
    ['Bash', { command: 'git config core.hooksPath /tmp/h' }],
    ['Bash', { command: 'eval "$X"' }],
    ['Write', { file_path: '/Users/x/.claude/settings.json', content: '{}' }],
    ['ExitPlanMode', {}],
  ]
  for (const [tool, input] of floorCalls) {
    putQ({ tool, input })
    for (const decision of ['allow', 'deny']) expect(said(await $.tool.call(answerCall({ decision })))).toContain(refusal('floor'))
  }
  expect(decFile()).toBeUndefined()
  expect(answered()).toEqual([])
})

for (const [name, tool, input] of [
  ['a merge', 'mcp__github__merge_pull_request', { owner: 'a', repo: 'b', pullNumber: 1 }],
  ['a force push', 'mcp__git-mcp__git_push', { path: SVC, force: true }],
  ['a push to main', 'mcp__git-mcp__git_push', { path: SVC, branch: 'main' }],
  ['a delete', 'Bash', { command: 'rm -rf /tmp/build' }],
] as [string, string, unknown][])
  test(`prompts: prompt_answer answers what left the floor: ${name}`, async ($, on) => {
    await tier($, on)
    putQ({ tool, input })
    expect(said(await $.tool.call(answerCall({ decision: 'allow' })))).toContain('Recorded: allow')
    expect(decFile()).toBeDefined()
  })

test('prompts: the comment cap: 2 --comments per PR refuse the next allow; a deny, another PR and a full review count apart; both months are read', async ($, on) => {
  await tier($, on)
  putQ({ tool: 'mcp__github__add_issue_comment', input: PCOMMENT, raisedBy: 'guard' })
  putLedger([retRow()])
  putLedger([retRow()], PREV_LEDGER)
  putLedger([retRow({ target: 'acme/app#8' }), retRow({ code: 'deny' }), retRow({ cap: 'full' }), retRow({ kind: 'answered' })])
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('cap'))
  expect(decFile()).toBeUndefined()
  expect(said(await $.tool.call(answerCall({ decision: 'deny', why: 'not needed' })))).toContain('Recorded: deny')
  pfs.delete(`${LDIR()}/${TID}.decision.json`)
  // One row fewer, and it goes through; its answered row carries the cap kind and target for the next count.
  pfs.delete(PREV_LEDGER)
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
  expect(answered().at(-1)).toMatchObject({ code: 'allow', cap: 'comments', target: 'acme/app#7' })
})

test('prompts: one full review per PR: an @claude body that is not the --comments form is a full review, whatever else it says', async ($, on) => {
  await tier($, on)
  putQ({ tool: 'mcp__github__add_issue_comment', input: { ...PCOMMENT, body: '@claude review --comments\nand also @claude review' }, raisedBy: 'guard' })
  putLedger([retRow({ cap: 'full' })])
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('cap'))
  putQ({ tool: 'mcp__github__create_pull_request', input: { owner: 'acme', repo: 'app', title: 't', head: 'h', base: 'b', body: 'ok' }, raisedBy: 'guard' })
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
})

test('prompts: a ledger that cannot be read counts as over the cap, and a call with no @claude body never reads it', async ($, on) => {
  await tier($, on)
  putQ({ tool: 'mcp__github__add_issue_comment', input: PCOMMENT, raisedBy: 'guard' })
  putLedger([retRow()])
  h.pfsFails = (a) => a[0] === '/usr/bin/grep'
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('cap'))
  expect(decFile()).toBeUndefined()
  putQ({ tool: 'mcp__github__add_issue_comment', input: { ...PCOMMENT, body: 'thanks' }, raisedBy: 'guard' })
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
})

test('prompts: with no tier above it, the lead is the top tier: prompt_escalate relays to the person (relay file, relayed row, the steps), and nothing is answered after it', async ($, on) => {
  await tier($, on)
  putQ()
  const r = await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'a decision for the person' }))
  expect(said(r)).toContain(`header exactly "Relay ${TID.slice(0, 8)}"`)
  expect(prm.parseRelay(pfs.get(`${LDIR()}/${TID}.relay.json`)!.text)).toEqual({ id: TID, short: TID.slice(0, 8), by: { level: 'lead', sid: SID, name: 'LEAD' }, at: T0, nonce: 'n-1' })
  expect(ledgerRows().filter((x) => x.kind === 'relayed')).toEqual([expect.objectContaining({ id: TID, tier: 'lead', code: 'lead', short: TID.slice(0, 8), by: SID, nonce: 'n-1' })])
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('with-person'))
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'again' })))).toContain(refusal('with-person'))
  expect(ledgerRows().filter((x) => x.kind === 'relayed').length).toBe(1)
  expect(decFile()).toBeUndefined()
  expect(said(await $.tool.call(pcall('prompt_list')))).toContain('With the person')
})

test('prompts: prompt_escalate refuses an unknown request, a bad why and a subagent; an answer may not follow an answer, and the top tier cannot relay a request that has one', async ($, on) => {
  await tier($, on)
  putQ()
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded')
  expect(said(await $.tool.call(answerCall({ decision: 'deny', why: 'again' })))).toContain(refusal('decided'))
  // The top tier cannot relay a request that already has a decision.
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'late' })))).toContain(refusal('decided'))
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID2, why: 'x' })))).toContain(refusal('unknown-request'))
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: '' })))).toContain(refusal('bad-input'))
  expect(said(await $.tool.call({ ...pcall('prompt_escalate', { id: TID, why: 'x' }), agentId: 'a1' }))).toContain('for the main agent only')
})

test('prompts: the three tools are declared with the lead grant', async ($, on) => {
  await tier($, on)
  expect(toolDefs.some((d) => d.includes('"prompt_list"'))).toBe(true)
  expect(toolDefs.some((d) => d.includes('"prompt_answer"') && d.includes('"allow"') && d.includes('"deny"'))).toBe(true)
  expect(toolDefs.some((d) => d.includes('"prompt_escalate"'))).toBe(true)
})

// ---- the notice ----
const promptNotices = () => submitted.filter((t) => t === prm.PROMPT_NOTICE_TEXT).length
const swapLead = (status: string) => tierSessions({ status })

test('prompts: an idle lead is told once of a waiting prompt, one notice for every open request, and a request already told is not told again', async ($, on) => {
  await tier($, on, [], { clock: true })
  await tickTwice()
  expect(promptNotices()).toBe(0)
  putQ()
  putQ({ id: TID2 })
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(1)
  await tickTwice()
  await tickTwice()
  expect(promptNotices()).toBe(1)
  putQ({ id: '1a1b2c3d-4444-4000-8000-123456789abc' })
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(2)
})

test('prompts: nothing is sent to a lead that is busy, or while answering is off; it goes out when the lead is idle', async ($, on) => {
  await tier($, on, [], { clock: true })
  swapLead('busy')
  putQ()
  await tickTwice()
  await tickTwice()
  expect(promptNotices()).toBe(0)
  swapLead('idle')
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(1)
  h.store.delete('answering')
  putQ({ id: TID2 })
  await tickTwice()
  await tickTwice()
  expect(promptNotices()).toBe(1)
})

test('prompts: no notice for a request that is not the lead\'s, nor for a closed one', async ($, on) => {
  await tier($, on, [], { clock: true })
  putQ({ leadName: 'ANOTHER' })
  putQ({ id: TID2, sid: SID, lane: 'LEAD' })
  putQ({ id: '1a1b2c3d-5555-4000-8000-123456789abc' })
  putFile('1a1b2c3d-5555-4000-8000-123456789abc.done')
  await tickTwice()
  await tickTwice()
  expect(promptNotices()).toBe(0)
})

test('prompts: the notice carries no approval and is a turn of the mod\'s own', async ($, on) => {
  await tier($, on, [], { clock: true })
  putQ()
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(1)
  expect(prm.PROMPT_NOTICE_TEXT).toContain('carries no approval, go or answer; never record it as one')
  await ownTurn($, prm.PROMPT_NOTICE_TEXT)
  expect(promptNotices()).toBe(1)
})

longTest('prompts: at most 30 notices an hour; a capped one stays owed, is logged once, and goes out once a slot frees', async ($, on) => {
  const stdins: string[] = []
  await tier($, on, stdins, { clock: true })
  for (let i = 1; i <= 31; i++) {
    putQ({ id: `${i.toString(16).padStart(8, '0')}-aaaa-4000-8000-123456789abc` })
    await h.clock!.advance(2000)
  }
  expect(promptNotices()).toBe(30)
  expect(logged(stdins).filter((e) => e === 'notice-capped:prompts').length).toBe(1)
  await h.clock!.advance(3_600_000)
  expect(promptNotices()).toBe(31)
})

// ---- the notice in the middle of a turn: a busy lead reads it beside a tool's result; the idle submit stays the fallback ----
// The tick's scan marks a request owed (busy lead or not); the hook only claims the mark. Time moves in tick-sized steps.
test('prompts: a busy lead is told of a waiting prompt beside a tool result, once for every open request, and no turn is submitted for it', async ($, on) => {
  postBeneath(on)
  const stdins: string[] = []
  await tier($, on, stdins, { clock: true })
  swapLead('busy')
  expect(await midCtx($)).toEqual([])
  putQ()
  putQ({ id: TID2 })
  await ticks(2)
  expect(await midCtx($)).toEqual([prm.PROMPT_NOTICE_TEXT])
  expect(logged(stdins)).toContain('notice:prompts mid-turn')
  expect(await midCtx($)).toEqual([])
  expect(await midCtx($, 'PostToolUseFailure')).toEqual([])
  // The idle submit has nothing left to say: the requests are told.
  swapLead('idle')
  await tickTwice()
  await tickTwice()
  expect(promptNotices()).toBe(0)
  // A request that comes later is told, mid-turn again.
  swapLead('busy')
  putQ({ id: '1a1b2c3d-4444-4000-8000-123456789abc' })
  await ticks(2)
  expect(await midCtx($)).toEqual([prm.PROMPT_NOTICE_TEXT])
})

test('prompts: a request is not told mid-turn before the tick has found it, and a request told mid-turn is not told again by the idle tick', async ($, on) => {
  postBeneath(on)
  await tier($, on, [], { clock: true })
  swapLead('busy')
  expect(await midCtx($)).toEqual([])
  putQ()
  expect(await midCtx($)).toEqual([])
  await ticks(2)
  expect(await midCtx($)).toEqual([prm.PROMPT_NOTICE_TEXT])
  putQ({ id: TID2 })
  swapLead('idle')
  await ticks(2)
  expect(promptNotices()).toBe(1)
  await tickTwice()
  expect(promptNotices()).toBe(1)
})

test('prompts: a request found by the tick while the lead is busy is told by the idle submit when the turn ends with no tool call (the fallback)', async ($, on) => {
  postBeneath(on)
  await tier($, on, [], { clock: true })
  swapLead('busy')
  putQ()
  await ticks(2)
  expect(promptNotices()).toBe(0)
  swapLead('idle')
  await ticks(2)
  expect(promptNotices()).toBe(1)
  expect(await midCtx($)).toEqual([])
})

test('prompts: a tool call that owes both a nudge and a notice carries two texts, the nudge first, never one merged', async ($, on) => {
  postBeneath(on)
  await tier($, on, [], { clock: true })
  swapLead('busy')
  expect(await midCtx($)).toEqual([])
  putQ()
  await ticks(2)
  h.tokensNow = 300_000
  expect(await midCtx($)).toEqual([nudgeText('idle'), prm.PROMPT_NOTICE_TEXT])
  expect(await midCtx($)).toEqual([])
})

test('prompts: a notice told mid-turn in a turn that ends with the request still open is told once more as the idle turn, and no more (the fallback)', async ($, on) => {
  postBeneath(on)
  await tier($, on, [], { clock: true })
  swapLead('busy')
  putQ()
  await ticks(2)
  expect(await midCtx($)).toEqual([prm.PROMPT_NOTICE_TEXT])
  await $.turn.complete(TURN as any)
  // The next turn starts before the idle tick: the request is owed again but is the idle turn's to send, not a second mid-turn one.
  expect(await midCtx($)).toEqual([])
  swapLead('idle')
  await ticks(2)
  expect(promptNotices()).toBe(1)
  // The resend is not a mid-turn one: nothing more follows, in a later turn or beside a later tool result.
  swapLead('busy')
  expect(await midCtx($)).toEqual([])
  await $.turn.complete(TURN as any)
  swapLead('idle')
  await ticks(3)
  expect(promptNotices()).toBe(1)
})

test('prompts: a subagent\'s turn end leaves the marks of a mid-turn notice alone', async ($, on) => {
  postBeneath(on)
  await tier($, on, [], { clock: true })
  swapLead('busy')
  putQ()
  await ticks(2)
  expect(await midCtx($)).toEqual([prm.PROMPT_NOTICE_TEXT])
  await $.turn.complete({ ...TURN, agentId: 'sub-1' } as any)
  swapLead('idle')
  await ticks(3)
  expect(promptNotices()).toBe(0)
})

test('prompts: a notice told mid-turn for a request that closed before the turn ended is not told again', async ($, on) => {
  postBeneath(on)
  await tier($, on, [], { clock: true })
  swapLead('busy')
  putQ()
  await ticks(2)
  expect(await midCtx($)).toEqual([prm.PROMPT_NOTICE_TEXT])
  putFile(`${TID}.done`)
  await $.turn.complete(TURN as any)
  swapLead('idle')
  await ticks(3)
  expect(promptNotices()).toBe(0)
})

for (const [what, withCond, text] of [['passed up', true, 'Passed up'], ['relayed', false, 'header exactly']] as const) {
  test(`prompts: a request the tier ${what} after its mid-turn notice is not told again when the turn ends`, async ($, on) => {
    postBeneath(on)
    await tier($, on, [], { clock: true })
    if (withCond) addCondT()
    swapLead('busy')
    if (withCond) h.sessions = { ...h.sessions, ...h.extraRows }
    putQ()
    await ticks(2)
    expect(await midCtx($)).toEqual([prm.PROMPT_NOTICE_TEXT])
    // Presence files carry a fresh mtime while the fake clock jumps (the live mod rewrites its own every tick).
    for (const f of leadFiles.values()) f.mtimeSec = Math.floor(h.nowMs / 1000)
    expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'x' })))).toContain(text)
    await $.turn.complete(TURN as any)
    swapLead('idle')
    await ticks(3)
    expect(promptNotices()).toBe(0)
  })
}

test('prompts: no notice is told mid-turn while the session has a compaction request of its own', async ($, on) => {
  postBeneath(on)
  await tier($, on, [], { clock: true })
  swapLead('busy')
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  putQ()
  await ticks(2)
  expect(await midCtx($)).toEqual([])
})

test('prompts: no mid-turn notice for a subagent\'s tool call, nor while answering is off, nor for a request that is not the lead\'s', async ($, on) => {
  postBeneath(on)
  await tier($, on, [], { clock: true })
  swapLead('busy')
  expect(await midCtx($)).toEqual([])
  putQ()
  await ticks(2)
  expect(await midCtx($, 'PostToolUse', { agent_id: 'sub-1' })).toEqual([])
  h.store.delete('answering')
  expect(await midCtx($)).toEqual([])
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  expect(await midCtx($)).toEqual([prm.PROMPT_NOTICE_TEXT])
  putQ({ id: TID2, leadName: 'ANOTHER' })
  putQ({ id: '1a1b2c3d-5555-4000-8000-123456789abc' })
  putFile('1a1b2c3d-5555-4000-8000-123456789abc.done')
  await ticks(2)
  expect(await midCtx($)).toEqual([])
})

// ---- the lead's section ----
test('prompts: a lead\'s system prompt carries the prompt section with the rubric, beside the briefing that is left as it was', async ($, on) => {
  await tier($, on)
  const r = await $.prompt.compose(COMPOSE)
  const s = r.sections.filter((x: any) => x.id === prm.LEAD_PROMPTS_ID)
  expect(s.length).toBe(1)
  expect(s[0].text).toBe(prm.LEAD_PROMPT_BRIEFING)
  expect(s[0].scope).toBe('session')
  expect(s[0].text).toContain(prm.RUBRIC)
  expect(r.sections.find((x: any) => x.id === 'callboard:lead').text).toBe(leadBriefing(PIN))
  expect((await $.prompt.compose({ ...COMPOSE, tools: ['Read'] })).sections.filter((x: any) => x.id === prm.LEAD_PROMPTS_ID).length).toBe(0)
  expect((await $.prompt.compose({ ...COMPOSE, traits: ['teammate'] })).sections.filter((x: any) => x.id === prm.LEAD_PROMPTS_ID).length).toBe(0)
})

test('prompts: a notice that could not be submitted is owed again, and goes out on the next tick', async ($, on) => {
  await tier($, on, [], { clock: true })
  putQ()
  h.submitFails = true
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(1)
  h.submitFails = false
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(2)
})

test('prompts: a request that was not the lead\'s when first looked at is looked at again after a minute', async ($, on) => {
  await tier($, on, [], { clock: true, scope: 'someone-else' })
  putQ()
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(0)
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  // In steps of one tick: a long advance runs ahead of the engine's own clock and the lead's presence file reads as from the future.
  await ticks(29)
  expect(promptNotices()).toBe(0)
  await ticks(4)
  expect(promptNotices()).toBe(1)
})

test('prompts: the three tools come back the same for a lead whose answering switch names another lane: nothing to list, nothing to answer', async ($, on) => {
  await tier($, on, [], { scope: 'someone-else' })
  putQ()
  expect(said(await $.tool.call(pcall('prompt_list')))).not.toContain(TID)
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('unknown-request'))
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'x' })))).toContain(refusal('unknown-request'))
})

test('prompts hook: a request names the lead the lane is bound to; a decision from another live lead is dropped', async ($, on) => {
  await answerer($, on, [])
  h.sessions = { ...h.sessions, '4243.json': JSON.stringify({ sessionId: LEAD2, name: 'LEAD2', cwd: PIN, status: 'idle', pid: 4243, procStart: LEADPS, startedAt: T0 - 3_600_000, statusUpdatedAt: T0 - 60_000 }) }
  leadFiles.set(`${ROOT}/leads/${LEAD2}.json`, { text: leadFileText({ sid: LEAD2, pid: 4243 }), mtimeSec: T0 / 1000 })
  await askCheck($)
  h.sessions = { ...h.sessions, ...waitingRow(T0 + 500) }
  driveClock()
  h.clockHooks.push(at(4000, () => {
    expect(readReq().leadName).toBe('LEAD')
    handDecision(readReq(), { by: { level: 'lead', sid: LEAD2, name: 'LEAD2' } }, { by: LEAD2 })
  }), stop(30_000))
  expect(await startReq($)).toEqual({})
  expect(hookKinds()).toContain('dropped by-sid')
})

test('prompts hook: with no lead, a live conductor of the repo is the tier: the request is made, its decision applies after 30 s, and the row names the tier', async ($, on) => {
  await answerer($, on, [])
  leadFiles.delete(LEADPATH)
  addCondT()
  const r = await runRequest($, [at(4000, () => decideBy(byCond))])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
  expect(ledgerRows()[0].tier).toBe('conductor')
  expect(ledgerRows()[2]).toEqual(expect.objectContaining({ tier: 'conductor', by: CNDT }))
})

test('prompts hook: with no lead and no conductor, the manager is the tier; its level comes from presence, never from the decision (a manager claiming to be a lead is dropped by-sid)', async ($, on) => {
  await answerer($, on, [])
  leadFiles.delete(LEADPATH)
  addMgrT()
  const r = await runRequest($, [at(4000, () => decideBy({ ...byMgr, level: 'lead' })), at(8000, () => { pfs.delete(`${PDIR}/${readReq().id}.decision.json`); decideBy(byMgr, { decision: 'deny', why: 'no' }) })])
  expect(r).toEqual({ decision: { behavior: 'deny', message: 'Denied by the manager MANAGER: no' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'dropped by-sid', 'answered deny', 'returned deny'])
})

test('prompts hook: a conductor whose list does not hold the lane\'s repo is not a tier: no-tier, the dialog stays', async ($, on) => {
  await answerer($, on, [])
  leadFiles.delete(LEADPATH)
  addCondT('CONDX', [APP2])
  expect(await runRequest($, [])).toEqual({})
  expect(rowKinds()).toEqual(['abandoned no-tier'])
})

test('prompts hook: a lead that has passed the request up can no longer answer it; the conductor above still can', async ($, on) => {
  await answerer($, on, [])
  addCondT()
  const r = await runRequest($, [at(4000, () => { putFileAt(`${readReq().id}.escalate-lead.json`, prm.escalateText({ id: readReq().id, tier: 'up', why: 'x', at: h.nowMs, level: 'lead', sid: LEADSID })); handDecision(readReq()) }), at(8000, () => { pfs.delete(`${PDIR}/${readReq().id}.decision.json`); decideBy(byCond) })])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'dropped by-sid', 'answered allow', 'returned allow'])
  expect(ledgerRows().at(-1).tier).toBe('conductor')
})

test('prompts hook: a lead\'s own prompt is judged by the live manager (no lead tier for it): the decision applies, and its level is the manager\'s', async ($, on) => {
  await answerer($, on, [], { asLead: true })
  addMgrT()
  const r = await runRequest($, [at(4000, () => decideBy(byMgr))])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
  expect(ledgerRows()[0].tier).toBe('manager')
})

test('prompts hook: a lead\'s own prompt stores the lead\'s own name as the request\'s lane, so a switch scoped to that lead reaches the tier above it', async ($, on) => {
  await answerer($, on, [], { asLead: true })
  addMgrT()
  const r = await runRequest($, [at(4000, () => { expect(typeof readReq().lane).toBe('string'); decideBy(byMgr) })])
  expect(r).toEqual({ decision: { behavior: 'allow' } })
})
const tierFixtures = (...which: ('mgr' | 'cond')[]) => {
  if (which.includes('mgr')) addMgrT()
  if (which.includes('cond')) addCondT()
  h.sessions = { ...h.sessions, ...h.extraRows }
}
const turnOf = (t: string) => t.split('\n').find((l) => /top tier|is above you|With the person/.test(l)) ?? ''

test('prompts tools: a lead with the manager above it is not the top tier: prompt_list says who is above, and prompt_escalate passes the request up (file per level, escalated row), once', async ($, on) => {
  await tier($, on)
  tierFixtures('mgr')
  putQ()
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('The manager MANAGER is above you.')
  const r = said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'beyond the rubric' })))
  expect(r).toContain(`Passed up: ${TID} goes to the next tier`)
  expect(prm.parseEscalate(pfs.get(`${LDIR()}/${TID}.escalate-lead.json`)!.text)).toEqual({ id: TID, tier: 'up', why: 'beyond the rubric', at: T0, level: 'lead', sid: SID })
  expect(ledgerRows().filter((x) => x.kind === 'escalated')).toEqual([expect.objectContaining({ id: TID, tier: 'lead', code: 'lead' })])
  expect(pfs.has(`${LDIR()}/${TID}.relay.json`)).toBe(false)
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('escalated'))
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'again' })))).toContain(refusal('escalated'))
  expect(said(await $.tool.call(pcall('prompt_list')))).not.toContain(TID)
})

test('prompts tools: a lead may answer while a higher tier waits: the decision names its own level from its grant', async ($, on) => {
  await tier($, on)
  tierFixtures('mgr', 'cond')
  putQ()
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
  expect(JSON.parse(decFile()!.text).by).toEqual({ level: 'lead', sid: SID, name: 'LEAD' })
})

test('prompts tools: a conductor whose pins do not hold the lane\'s repo is not above the lead: the lead is the top tier and its prompt_escalate relays', async ($, on) => {
  await tier($, on)
  addCondT('CONDX', [APP2])
  h.sessions = { ...h.sessions, ...h.extraRows }
  putQ()
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('You are the top tier')
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'x' })))).toContain('You are the top tier here')
  expect(pfs.has(`${LDIR()}/${TID}.relay.json`)).toBe(true)
})

test('prompts tools: a tier that is asking (its relay question is open) is skipped: the lead becomes the top tier, and the asking file is not the lead\'s own request\'s relay', async ($, on) => {
  await tier($, on)
  tierFixtures('mgr')
  putQ()
  pfs.set(`${PROMPTS_DIR}/asking/${MGRT}`, { text: '{}', mtimeSec: T0 / 1000 })
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('You are the top tier')
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'x' })))).toContain('You are the top tier here')
})

test('prompts tools: the manager is still excluded for new requests while it relays another, but it relays its own: asking is no bar to the request it relayed', async ($, on) => {
  await tier($, on)
  tierFixtures('mgr')
  putQ()
  putRelayT(byMgr)
  pfs.set(`${PROMPTS_DIR}/asking/${MGRT}`, { text: '{}', mtimeSec: T0 / 1000 })
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('With the person')
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('with-person'))
})

test('prompts tools: a request with a truncated input is denied with the cleaner-command message, never allowed, never relayed; the deny writes a deny-unclear row', async ($, on) => {
  await tier($, on)
  putQ({ truncated: true })
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('truncated'))
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'x' })))).toContain(refusal('truncated'))
  const why = prm.unclearMessage('the command is cut off.').slice(0, 190)
  expect(said(await $.tool.call(answerCall({ decision: 'deny', why })))).toContain('Recorded: deny')
  expect(rowKinds().filter((k) => k.startsWith('answered') || k.startsWith('deny-unclear'))).toEqual(['answered deny', 'deny-unclear deny'])
  expect(pfs.has(`${LDIR()}/${TID}.relay.json`)).toBe(false)
})

test('prompts tools: a plain deny writes no deny-unclear row', async ($, on) => {
  await tier($, on)
  putQ()
  expect(said(await $.tool.call(answerCall({ decision: 'deny', why: 'it writes outside the lane' })))).toContain('Recorded: deny')
  expect(rowKinds()).toEqual(['answered deny'])
})

test('prompts tools (conductor): with no lead and no manager the conductor is the top tier: it sees the request, answers it as a conductor, or relays it', async ($, on) => {
  await asConductor($, on)
  putQ({ ...APIQ, leadName: undefined })
  const t = said(await $.tool.call(pcall('prompt_list')))
  expect(t).toContain(`### ${TID}`)
  expect(turnOf(t)).toContain('You are the top tier')
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
  expect(JSON.parse(pfs.get(`${LDIR(APISID)}/${TID}.decision.json`)!.text).by).toEqual({ level: 'conductor', sid: SID, name: 'COND' })
  putQ({ ...APIQ, leadName: undefined, id: TID2 })
  const r = said(await $.tool.call(pcall('prompt_escalate', { id: TID2, why: 'a call for the person' })))
  expect(r).toContain(`header exactly "Relay ${TID2.slice(0, 8)}"`)
  expect(JSON.parse(pfs.get(`${LDIR(APISID)}/${TID2}.relay.json`)!.text).by).toEqual({ level: 'conductor', sid: SID, name: 'COND' })
  expect(ledgerRows().filter((x) => x.kind === 'relayed')).toEqual([expect.objectContaining({ id: TID2, tier: 'conductor', short: TID2.slice(0, 8), by: SID })])
})

test('prompts tools (conductor): with a live lead the conductor\'s window opens at 5 minutes, or at once when the lead passes the request up (30 s still bind)', async ($, on) => {
  await asConductor($, on, { lead: true })
  putQ({ ...APIQ })
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('Your window opens in 300 s')
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('window'))
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'x' })))).toContain(refusal('window'))
  h.nowMs = T0 + 299_000
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('window'))
  h.nowMs = T0 + 301_000
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
  // A pass-up by the lead at 40 s opens the conductor at 40 s.
  h.nowMs = T0 + 45_000
  putQ({ ...APIQ, id: TID2 })
  pfs.set(`${LDIR(APISID)}/${TID2}.escalate-lead.json`, { text: prm.escalateText({ id: TID2, tier: 'up', why: 'x', at: T0 + 40_000, level: 'lead', sid: LEADSID }), mtimeSec: T0 / 1000 })
  expect(said(await $.tool.call(answerCall({ id: TID2 })))).toContain('Recorded: allow')
})

test('prompts tools (conductor): a lower tier that goes live after the request does not move the conductor\'s window later', async ($, on) => {
  await asConductor($, on)
  putQ({ ...APIQ })
  // The conductor is the only tier at first: its window is the 30 s minimum, and the list says so.
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('You are the top tier')
  leadLive()
  h.nowMs = T0 + 31_000
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).not.toContain('window opens')
  expect(said(await $.tool.call(answerCall()))).toContain('Recorded: allow')
  // A request first seen with the lead already live still opens the conductor at 5 minutes.
  putQ({ ...APIQ, id: TID2, at: T0 + 31_000 })
  expect(said(await $.tool.call(answerCall({ id: TID2 })))).toContain(refusal('window'))
})

test('prompts tools (conductor): with the manager above it the conductor\'s prompt_escalate passes up (escalate-conductor.json); the manager\'s window is 10 minutes after the request with a lead and a conductor live', async ($, on) => {
  await asConductor($, on, { mgr: true })
  putQ({ ...APIQ, leadName: undefined })
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('The manager MANAGER is above you.')
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'x' })))).toContain('Passed up')
  expect(pfs.has(`${LDIR(APISID)}/${TID}.escalate-conductor.json`)).toBe(true)
  expect(pfs.has(`${LDIR(APISID)}/${TID}.relay.json`)).toBe(false)
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('escalated'))
})

test('prompts tools (lead): a request that records no lead (the hook found none for the lane) is not shown to a live lead of the repo, whichever other tier is there', async ($, on) => {
  await tier($, on)
  addCondT()
  putQ({ noLead: true })
  putQ({ id: TID2 })
  const t = said(await $.tool.call(pcall('prompt_list')))
  expect(t).toContain(`### ${TID2}`)
  expect(t).not.toContain(`### ${TID}`)
})

test('prompts tools (conductor): a request of a repo the conductor does not list is not in its reach', async ($, on) => {
  await asConductor($, on)
  putQ({ ...APIQ, leadName: undefined, repo: '/data/x/work/lab', sid: OTHER, pid: 4600 })
  expect(said(await $.tool.call(pcall('prompt_list')))).toContain('No prompt is waiting in your reach.')
  expect(said(await $.tool.call(answerCall()))).toContain(refusal('unknown-request'))
})

test('prompts tools (manager): the manager is the top tier for a lane of any repo: answers, or relays; it has the three prompt tools beside its five', async ($, on) => {
  const defs0 = toolDefs.length
  await mgrAt($, on, [], { sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }) })
  const defs = toolDefs.slice(defs0).join('')
  for (const t of ['lane_list', 'lane_resume', 'lane_compact', 'lane_terminate', 'lane_retire', 'prompt_list', 'prompt_answer', 'prompt_escalate']) expect(defs).toContain(`"${t}"`)
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  putQ({ sid: APISID, pid: 4500, lane: 'API', repo: `${PIN}/api`, leadName: undefined })
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('You are the top tier')
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'x' })))).toContain('You are the top tier here')
  expect(JSON.parse(pfs.get(`${LDIR(APISID)}/${TID}.relay.json`)!.text).by.level).toBe('manager')
})

test('prompts tools: a conductor and the manager have the three prompt tools, and only those besides their lane tools; a plain session has none', async ($, on) => {
  const defs0 = toolDefs.length
  await condOn($, on)
  const defs = toolDefs.slice(defs0).join('')
  for (const t of ['lane_list', 'lane_compact', 'lane_terminate', 'prompt_list', 'prompt_answer', 'prompt_escalate']) expect(defs).toContain(`"${t}"`)
  expect(defs).not.toContain('"lane_resume"')
})

// ---- notices to every tier, and the three tiers' briefings ----
test('prompts notice: a lead is told at once even with a manager above it; a request with a relay is told to nobody, and told again if the relay is lost', async ($, on) => {
  await tier($, on, [], { clock: true })
  tierFixtures('mgr')
  putQ()
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(1)
  putQ({ id: TID2 })
  putRelayT({ level: 'lead', sid: SID, name: 'LEAD' }, TID2)
  await h.clock!.advance(2000)
  await tickTwice()
  expect(promptNotices()).toBe(1)
  pfs.delete(`${LDIR()}/${TID2}.relay.json`)
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(2)
})

longTest('prompts notice: an idle conductor is told when its window opens (5 minutes after the request with a lead live), not before', async ($, on) => {
  await asConductor($, on, { lead: true, clock: true })
  putQ({ ...APIQ })
  await h.clock!.advance(2000)
  await tickTwice()
  expect(promptNotices()).toBe(0)
  // The presence files carry a fresh mtime while the clock runs on (the live mod rewrites its own every tick; this engine's fake clock jumps past it).
  const keep = async (ms: number) => {
    for (let t = 0; t < ms; t += 5_000) {
      await h.clock!.advance(5_000)
      for (const f of leadFiles.values()) f.mtimeSec = Math.floor(h.nowMs / 1000)
    }
  }
  await keep(280_000)
  expect(promptNotices()).toBe(0)
  await keep(30_000)
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(1)
})

test('prompts notice: an idle conductor with no lead is told at once; so is one told of a request the lead has passed up', async ($, on) => {
  await asConductor($, on, { clock: true })
  putQ({ ...APIQ, leadName: undefined })
  await h.clock!.advance(2000)
  expect(promptNotices()).toBe(1)
})

test('prompts briefing: the conductor and the manager get the tier section; the lead\'s names the chain and the cleaner-command deny; no other session has one', async ($, on) => {
  await condOn($, on, [], { clock: true })
  let r = await $.prompt.compose(COMPOSE)
  expect(r.sections.filter((x: any) => x.id === prm.TIER_PROMPTS_ID).map((x: any) => x.text)).toEqual([prm.tierPromptBriefing('conductor')])
  expect(prm.tierPromptBriefing('conductor')).toContain(prm.UNCLEAR_PREFIX)
  expect(prm.tierPromptBriefing('manager')).toContain('Relay <')
  expect(prm.LEAD_PROMPT_BRIEFING).toContain(prm.UNCLEAR_PREFIX)
})

test('prompts tools (manager): a lead that passed the request up leaves the manager its own 10-minute slot (the conductor between them is live)', async ($, on) => {
  await mgrAt($, on, [], { clock: true, sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }) })
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  h.extraRows = {}
  addCondT()
  h.sessions = { ...h.sessions, ...h.extraRows }
  leadLive()
  putQ({ sid: APISID, pid: 4500, lane: 'API', repo: `${PIN}/api`, leadName: 'LEAD' })
  await h.clock!.set(T0 + 60_000)
  // Presence files carry a fresh mtime while the fake clock jumps (the live mod rewrites its own every tick).
  for (const f of leadFiles.values()) f.mtimeSec = Math.floor(h.nowMs / 1000)
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('Your window opens in 540 s')
  pfs.set(`${LDIR(APISID)}/${TID}.escalate-lead.json`, { text: prm.escalateText({ id: TID, tier: 'up', why: 'x', at: T0 + 45_000, level: 'lead', sid: LEADSID }), mtimeSec: T0 / 1000 })
  expect(turnOf(said(await $.tool.call(pcall('prompt_list'))))).toContain('Your window opens in 540 s')
})
