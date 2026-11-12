import { expect, test } from 'claude-code/testing'
import * as prm from '../hooks/prompts'
import { h, PROMPTS_DIR, SID, T0, longTest, pdirs, pfs } from './harness'
import { APISID, LEADSID, MGR_SESS, PIN, TURN, lane, leadReg, mgrAt, ownReg } from './fixtures'
import { LDIR, OFF_FILE, PDIR, QASK, QIN, QTEXT, SHORT, THASH, TID, TID2, addCondT, answerCall, answered, answerer, askCheck, askPost, at, beneathHooks, byCond, callOf, decFile, decOf, driveClock, handDecision, hookKinds, ledgerRows, noFiles, pcall, putFile, putFileAt, putQ, putRelay, putRelayT, readReq, refusal, relayQ, reqFiles, rowKinds, runRequest, said, startReq, stop, tier, waitingRow } from './answer-fixtures'

const QCALL = callOf('AskUserQuestion', QIN)
const answerBy = (index: number, label: string, over: Record<string, unknown> = {}) => ({ decision: 'answer', answer: { index, label }, why: 'settled by the lane brief', ...over })
const questionsRows = (): any[] => [...pfs.entries()].filter(([k]) => /\/questions-\d{4}-\d{2}\.jsonl$/.test(k)).flatMap(([, v]) => v.text.split('\n').filter(Boolean).map((l) => JSON.parse(l)))

longTest('prompts: a lane\'s own question under an asks scope: the request is written, a lead\'s answer lands after 30 s, and the live label comes back with the tier named from presence, never from the file', async ($, on) => {
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  const r = await runRequest($, [at(4000, () => {
    expect(readReq()).toMatchObject({ tool: 'AskUserQuestion', input: QIN, truncated: false })
    handDecision(readReq(), answerBy(1, '8080', { by: { level: 'lead', sid: LEADSID, name: 'EVIL' } }))
  })], QCALL.over, QCALL.check)
  expect(r).toEqual({ decision: { behavior: 'allow', updatedInput: { ...QIN, answers: { [QTEXT]: '8080 (answered by lead LEAD)' } } } })
  expect(h.nowMs - T0).toBe(30_000)
  expect(rowKinds()).toEqual(['requested', 'answered answer', 'returned answer'])
  const back = ledgerRows().find((x) => x.kind === 'returned')
  expect(back).toEqual(expect.objectContaining({ code: 'answer', opt: '1', tier: 'lead', by: LEADSID }))
  expect(back.lh).toMatch(/^[0-9a-f]{16}$/)
  expect(JSON.stringify(ledgerRows())).not.toContain('8080')
  expect(questionsRows()).toEqual([expect.objectContaining({ id: back.id, tier: 'lead', header: 'Port', question: QTEXT, options: ['3000', '8080'], label: '8080' })])
  expect(noFiles()).toBe(true)
})

for (const [name, input, code] of [
  ['the Person header', { questions: [{ ...QIN.questions[0], header: 'Person' }] }, 'question-person'],
  ['two questions', { questions: [QIN.questions[0], QIN.questions[0]] }, 'question-count'],
  ['multiSelect', { questions: [{ ...QIN.questions[0], multiSelect: true }] }, 'question-multi'],
  ['five options', { questions: [{ ...QIN.questions[0], options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}`, description: 'd' })) }] }, 'question-options'],
] as [string, unknown, string][]) {
  test(`prompts: ${name} stays the person's, with its own code and no request`, async ($, on) => {
    await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
    const c = callOf('AskUserQuestion', input)
    expect(await runRequest($, [stop(8000)], c.over, c.check)).toEqual({})
    expect(rowKinds()).toEqual([`not-judgeable ${code}`])
    expect(reqFiles().length).toBe(0)
  })
}

test('prompts: a Relay question in a covered lane stays the person\'s, untouched', async ($, on) => {
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  const relayIn = { questions: [{ question: 'Allow? (7a1b)', header: 'Relay 7a1b2c3d', options: [{ label: 'Yes', description: 'a' }, { label: 'No', description: 'b' }], multiSelect: false }] }
  const c = callOf('AskUserQuestion', relayIn)
  expect(await runRequest($, [stop(8000)], c.over, c.check)).toEqual({})
  expect(rowKinds().filter((k) => k.startsWith('requested'))).toEqual([])
  expect(reqFiles().length).toBe(0)
})

for (const [name, dec, over, code] of [
  ['an answer on a Bash request', answerBy(0, 'x'), 'bash', 'kind'],
  ['an index the question does not have', answerBy(3, '8080'), 'q', 'answer'],
  ['a label that is not the live one', answerBy(1, '9090'), 'q', 'answer'],
  ['a person\'s answer with no relay', answerBy(1, '8080', { via: 'person' }), 'q', 'relay'],
] as [string, Record<string, unknown>, string, string][]) {
  test(`prompts hook: ${name} is dropped ${code}, the wait goes on, and nothing is returned`, async ($, on) => {
    const q = over === 'q'
    await answerer($, on, [], { verdict: q ? QASK : undefined, asksScope: 'all' })
    const c = q ? QCALL : { check: {}, over: {} }
    const r = await runRequest($, [at(4000, () => handDecision(readReq(), dec, { via: dec.via as string | undefined })), stop(40_000)], c.over, c.check)
    expect(r).toEqual({})
    expect(hookKinds()).toEqual(['requested', `dropped ${code}`, 'off'])
  })
}

test('prompts hook: an agent\'s answer while a relay is in place is dropped relay; the person\'s pick through it is returned bare, with no tier named', async ($, on) => {
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  const r = await runRequest($, [
    at(4000, () => { putRelay(readReq()); pfs.set(`${PDIR}/${readReq().id}.asked`, { text: '{}', mtimeSec: h.nowMs / 1000 }); handDecision(readReq(), answerBy(0, '3000')) }),
    at(40_000, () => handDecision(readReq(), answerBy(1, '8080', { via: 'person', why: 'the person answered via the lead LEAD' }), { via: 'person' })),
  ], QCALL.over, QCALL.check)
  expect(r).toEqual({ decision: { behavior: 'allow', updatedInput: { ...QIN, answers: { [QTEXT]: '8080' } } } })
  expect(rowKinds()).toEqual(['requested', 'answered answer', 'dropped relay', 'answered answer', 'returned answer'])
  expect(questionsRows()).toEqual([expect.objectContaining({ label: '8080', via: 'person' })])
})

test('prompts hook: a click with no abort ends a waiting question superseded and returns nothing', async ($, on) => {
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  const r = await runRequest($, [at(10_000, async () => { h.sessions = { ...leadReg(), ...ownReg({ status: 'busy', waitingFor: null, statusUpdatedAt: T0 + 10_000 }) }; await $.classic.PostToolUse({ tool_name: 'AskUserQuestion', tool_input: QIN, tool_use_id: 'tu1', tool_response: {} } as any) }), at(12_000, () => handDecision(readReq(), answerBy(1, '8080')))], QCALL.over, QCALL.check)
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'superseded'])
  expect(noFiles()).toBe(true)
  expect(questionsRows()).toEqual([])
})

for (const [name, narrow] of [
  ['a value with no questions scope (an older one)', async ($: any) => { h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 }) }],
  ['an asks scope narrowed to another lane', async ($: any) => { h.store.set('answering', { scope: 'all', asks: false, asksScope: 'other-lane', savedAt: T0 }) }],
  ['the OFF file', async ($: any) => { pfs.set(OFF_FILE, { text: '', mtimeSec: h.nowMs / 1000 }) }],
] as [string, ($: any) => Promise<void>][]) {
  test(`prompts hook: ${name} ends a waiting question off, while a permission prompt keeps waiting`, async ($, on) => {
    await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
    const r = await runRequest($, [at(10_000, () => narrow($))], QCALL.over, QCALL.check)
    expect(r).toEqual({})
    expect(rowKinds()).toEqual(['requested', 'off'])
    if (name !== 'the OFF file') {
      pfs.delete(OFF_FILE)
      h.prVerdict = { decision: 'ask', rule: 'Bash(ssh:*)' }
      const r2 = await runRequest($, [at(4000, () => handDecision(readReq()))])
      expect(r2).toEqual({ decision: { behavior: 'allow' } })
    }
  })
}

// No per-lane command: the regular /callboard off in a lane's session takes that lane out, with the switch left on for the rest.
test('prompts: /callboard off in a lane\'s session takes it out of escalation: its prompt and its question stay the person\'s, no request and no notice', async ($, on) => {
  const argv: string[][] = []
  await answerer($, on, [], { asksScope: 'all', argv })
  // Control: while the session is a lane, a prompt is covered (a request is made and a lead answers it) and a question is too.
  expect(await runRequest($, [at(4000, () => handDecision(readReq()))])).toEqual({ decision: { behavior: 'allow' } })
  expect(rowKinds()).toEqual(['requested', 'answered allow', 'returned allow'])
  h.prVerdict = QASK
  const rq = await runRequest($, [at(4000, () => handDecision(readReq(), answerBy(0, '3000')))], QCALL.over, QCALL.check)
  expect(rq).toMatchObject({ decision: { behavior: 'allow', updatedInput: { answers: { [QTEXT]: expect.stringContaining('3000') } } } })
  expect(rowKinds()).toContain('returned answer')
  const rowsBefore = ledgerRows().length
  // The person takes the lane out; the stored switch is untouched, since it is the one switch for every lane.
  await $.command.run(lane('off'))
  expect(h.store.get('answering')).toMatchObject({ scope: 'all', asksScope: 'all' })
  for (const [verdict, call] of [[{ decision: 'ask', rule: 'Bash(ssh:*)' }, { check: {}, over: {} }], [QASK, QCALL]] as [any, { check: object; over: object }][]) {
    h.prVerdict = verdict
    h.prBeneathCalls = 0
    await askCheck($, call.check)
    h.sessions = waitingRow(T0 + 500)
    driveClock()
    const before = argv.length
    const r = await startReq($, call.over)
    // The chain beneath answers as if escalation did not exist: nothing is raised, waited on, written or sent.
    expect(r).toEqual({})
    expect(h.prBeneathCalls).toBe(1)
    expect(reqFiles().length).toBe(0)
    expect(noFiles()).toBe(true)
    expect(argv.slice(before).filter((a) => a.some((x) => typeof x === 'string' && x.includes('/prompts'))).length).toBe(0)
  }
  expect(ledgerRows().length).toBe(rowsBefore)
})

test('prompts: /callboard off in a lane\'s session during a wait ends it off: a decision made after is not applied', async ($, on) => {
  await answerer($, on, [])
  const r = await runRequest($, [at(4000, async () => { await $.command.run(lane('off')) }), at(6000, () => handDecision(readReq()))])
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'off'])
  expect(rowKinds()).not.toContain('returned allow')
  expect(h.store.get('answering')).toMatchObject({ scope: 'all' })
})

longTest('prompts hook: no tier answers a question: no deny at 20 minutes, abandoned expired at 21, the chain beneath returns; a Bash request is still denied at 20', async ($, on) => {
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  const r = await runRequest($, [], QCALL.over, QCALL.check)
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'abandoned expired'])
  expect(h.nowMs - T0).toBeGreaterThanOrEqual(21 * 60_000)
  expect(noFiles()).toBe(true)
})

// The tier's side: the same question as a request file the lane's hook made, read through prompt_list, answered with prompt_answer, relayed with prompt_escalate.
const putQQ = (over: Record<string, unknown> = {}) => putQ({ tool: 'AskUserQuestion', raisedBy: 'mode', input: QIN, ...over })
const optionQ = (n: number, over: Record<string, unknown> = {}) => pcall('prompt_answer', { id: TID, decision: 'answer', option: n, why: 'the brief settles it', ...over })

test('prompts tools: prompt_list shows a question numbered inside the untrusted frame with the question rubric; with no asks scope the question is not listed at all', async ($, on) => {
  await tier($, on)
  putQQ()
  expect(said(await $.tool.call(pcall('prompt_list')))).not.toContain(TID)
  h.store.set('answering', { scope: 'all', asks: false, asksScope: 'svc-api', savedAt: T0 })
  const t = said(await $.tool.call(pcall('prompt_list')))
  expect(t).toContain(`### ${TID}`)
  expect(t).toContain('lane: svc-api · question · open 0 s')
  expect(t).toContain('<untrusted-input>')
  expect(t).toContain(QTEXT)
  expect(t).toContain('1. 3000: dev')
  expect(t).toContain('2. 8080: alt')
  expect(t).toContain(prm.QUESTION_RUBRIC)
})

test('prompts tools: prompt_answer on a question takes only answer with an option shown: allow, deny, a bad option, a wrong echo and a truncated copy are refused and write nothing', async ($, on) => {
  await tier($, on, [], { asksScope: 'all' })
  putQQ()
  for (const [call, code] of [
    [answerCall(), 'question-answer-only'],
    [answerCall({ decision: 'deny' }), 'question-answer-only'],
    [optionQ(3), 'bad-answer'],
    [optionQ(0), 'bad-answer'],
    [optionQ(2, { answer: '3000' }), 'bad-answer'],
  ] as [any, string][]) expect(said(await $.tool.call(call))).toContain(refusal(code))
  expect(decFile()).toBeUndefined()
  expect(answered()).toEqual([])
  putQQ({ truncated: true })
  expect(said(await $.tool.call(optionQ(2)))).toContain(refusal('truncated-question'))
  putQ()
  expect(said(await $.tool.call(optionQ(1)))).toContain(refusal('bad-input'))
  expect(decFile()).toBeUndefined()
})

test('prompts tools: prompt_answer answer N writes the decision with the live label and its answered row with opt and lh; a label echo that matches (trimmed) is accepted', async ($, on) => {
  await tier($, on, [], { asksScope: 'all' })
  putQQ()
  const r = await $.tool.call(optionQ(2, { answer: '8080' }))
  expect(said(r)).toContain(`Recorded: answer 2 for ${TID}.`)
  expect(prm.parseDecision(decFile()!.text)).toEqual(expect.objectContaining({ decision: 'answer', answer: { index: 1, label: '8080' }, by: { level: 'lead', sid: SID, name: 'LEAD' } }))
  const row = answered()[0]
  expect(row).toEqual(expect.objectContaining({ code: 'answer', opt: '1', tool: 'AskUserQuestion', tier: 'lead' }))
  expect(row.lh).toMatch(/^[0-9a-f]{16}$/)
  expect(JSON.stringify(ledgerRows())).not.toContain('8080')
})

test('prompts tools: a label hash that cannot be made refuses the answer with write-failed and leaves no decision file', async ($, on) => {
  await tier($, on, [], { asksScope: 'all' })
  putQQ()
  h.shaFailsFor = (t) => t.startsWith(`${TID}\n`)
  expect(said(await $.tool.call(optionQ(2)))).toContain(refusal('write-failed'))
  h.shaFailsFor = undefined
  expect(decFile()).toBeUndefined()
  expect(answered()).toEqual([])
})

test('prompts tools: a question at the top tier: prompt_escalate writes the relay file and the relayed row and returns the steps with no label in them; a truncated one is refused with no relay file', async ($, on) => {
  await tier($, on, [], { asksScope: 'all' })
  putQQ()
  const t = said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'the brief does not settle it' })))
  expect(t).toContain(`header exactly "Relay ${SHORT}"`)
  expect(t).not.toContain('3000')
  expect(t).not.toContain('8080')
  expect(pfs.has(`${LDIR()}/${TID}.relay.json`)).toBe(true)
  expect(ledgerRows().filter((x) => x.kind === 'relayed').length).toBe(1)
  expect(said(await $.tool.call(optionQ(1)))).toContain(refusal('with-person'))
  pfs.delete(`${LDIR()}/${TID}.relay.json`)
  putQQ({ id: TID2, truncated: true })
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID2, why: 'x' })))).toContain(refusal('truncated-question'))
  expect(pfs.has(`${LDIR()}/${TID2}.relay.json`)).toBe(false)
})

// The question relay: the person's own pick, by a question in the top tier's session whose options are the lane's labels.
const relayQQ = (id: string, labels: string[] = ['3000', '8080'], over: Record<string, unknown> = {}) => ({ header: `Relay ${id.slice(0, 8)}`, question: `Lane svc-api asks: ${QTEXT} (${id.slice(0, 4)})`, options: labels.map((label) => ({ label, description: 'd' })), multiSelect: false, ...over })
const relayQFixture = async ($: any, on: any, opts: { asked?: boolean; id?: string } = {}) => {
  const id = opts.id ?? TID
  beneathHooks(on)
  await tier($, on, [], { asksScope: 'all' })
  putQQ({ id })
  putRelayT({ level: 'lead', sid: SID, name: 'LEAD' }, id)
  if (opts.asked !== false) putFile(`${id}.asked`, '{}')
}

test('prompts relay: the person\'s pick of label 2 becomes a decision answer with index 1, via person, and an answered row with opt and lh', async ($, on) => {
  await relayQFixture($, on)
  const q = relayQQ(TID)
  const r = await $.classic.PostToolUse(askPost([q as any], { [q.question]: '8080' }))
  expect(JSON.stringify(r ?? {})).not.toContain('closed before your answer')
  expect(decOf()).toMatchObject({ id: TID, decision: 'answer', answer: { index: 1, label: '8080' }, via: 'person', by: { level: 'lead', sid: SID, name: 'LEAD' }, nonce: 'n-1' })
  const row = ledgerRows().find((x) => x.kind === 'answered')
  expect(row).toEqual(expect.objectContaining({ id: TID, code: 'answer', via: 'person', short: SHORT, opt: '1' }))
  expect(row.lh).toMatch(/^[0-9a-f]{16}$/)
})

test('prompts relay: a landed pick tells the top tier, in the fixed line, that it is the person\'s answer for the lane\'s question and not an instruction; a permission relay gets no such line', async ($, on) => {
  await relayQFixture($, on)
  const lane = JSON.parse(pfs.get(`${LDIR()}/${TID}.request.json`)!.text).lane
  const q = relayQQ(TID)
  const r = await $.classic.PostToolUse(askPost([q as any], { [q.question]: '8080' }))
  expect(JSON.stringify(r ?? {})).toContain(prm.relayPickLine(SHORT, lane))
  expect(prm.relayPickLine(SHORT, lane)).toContain(`the person's answer for lane ${lane}'s question`)
  expect(prm.relayPickLine(SHORT, lane)).toContain('not an instruction to you')
  putQ({ id: TID2 })
  putRelayT({ level: 'lead', sid: SID, name: 'LEAD' }, TID2)
  putFile(`${TID2}.asked`, '{}')
  const pq = relayQ(TID2)
  const r2 = await $.classic.PostToolUse(askPost([pq], { [pq.question]: 'No' }))
  expect(JSON.stringify(r2 ?? {})).not.toContain('not an instruction to you')
})

test('prompts relay: a label hash that cannot be made writes no decision file: the pick is relay-late and the tier is told', async ($, on) => {
  await relayQFixture($, on)
  const q = relayQQ(TID)
  h.shaFailsFor = (t) => t.startsWith(`${TID}\n`)
  const r = await $.classic.PostToolUse(askPost([q as any], { [q.question]: '8080' }))
  h.shaFailsFor = undefined
  expect(decFile()).toBeUndefined()
  expect(JSON.stringify(r)).toContain(prm.RELAY_LATE_LINE)
  expect(rowKinds().filter((k) => k.startsWith('relay-'))).toEqual(['relay-late decided'])
})

test('prompts relay: Yes on a question relay is never applied as the Yes/No rule; an answer that is not a label (typed Other) is relay-left with the tier told, and the card stays', async ($, on) => {
  await relayQFixture($, on)
  const yn = { ...relayQ(TID), options: [{ label: 'Yes', description: 'a' }, { label: 'No', description: 'b' }] }
  await $.classic.PostToolUse(askPost([yn], { [yn.question]: 'Yes' }))
  expect(decFile()).toBeUndefined()
  expect(pfs.has(`${LDIR()}/${TID}.left`)).toBe(true)
  pfs.delete(`${LDIR()}/${TID}.left`)
  const q = relayQQ(TID)
  const r = await $.classic.PostToolUse(askPost([q as any], { [q.question]: 'something the person typed' }))
  expect(decFile()).toBeUndefined()
  expect(pfs.has(`${LDIR()}/${TID}.left`)).toBe(true)
  expect(rowKinds().filter((k) => k.startsWith('relay-'))).toEqual(['relay-left', 'relay-left'])
  expect(JSON.stringify(r)).toContain(prm.relayLeftLine(SHORT))
})

test('prompts relay: a dismissed question relay (the turn ends with it open) is relay-left and decides nothing', async ($, on) => {
  await relayQFixture($, on, { asked: false })
  await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: [relayQQ(TID)] } } as any)
  expect(pfs.has(`${LDIR()}/${TID}.asked`)).toBe(true)
  await $.turn.complete(TURN as any)
  expect(pfs.has(`${LDIR()}/${TID}.left`)).toBe(true)
  expect(decFile()).toBeUndefined()
  expect(rowKinds().filter((k) => k.startsWith('relay-'))).toEqual(['relay-left'])
})

test('prompts relay: step 0 denies options that are not the lane\'s labels with the options line and marks nothing; a corrected call is asked and marked', async ($, on) => {
  await relayQFixture($, on, { asked: false })
  for (const labels of [['Yes', 'No'], ['3000', '9090'], ['3000']]) {
    const r = await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: [relayQQ(TID, labels)] } } as any)
    expect(r).toEqual({ decision: { behavior: 'deny', message: prm.relayOptionsLine(SHORT) } })
    expect(pfs.has(`${LDIR()}/${TID}.asked`)).toBe(false)
  }
  expect(((await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: [relayQQ(TID)] } } as any)) ?? {})).toEqual({})
  expect(pfs.has(`${LDIR()}/${TID}.asked`)).toBe(true)
  const q = relayQQ(TID)
  await $.classic.PostToolUse(askPost([q as any], { [q.question]: '3000' }))
  expect(decOf()).toMatchObject({ decision: 'answer', answer: { index: 0, label: '3000' }, via: 'person' })
})

test('prompts relay: a request file that cannot be read, or whose card closed first, is relay-late closed with the fixed line and no decision', async ($, on) => {
  await relayQFixture($, on)
  pfs.set(`${LDIR()}/${TID}.request.json`, { text: '{not json', mtimeSec: T0 / 1000 })
  const q = relayQQ(TID)
  const r = await $.classic.PostToolUse(askPost([q as any], { [q.question]: '8080' }))
  expect(decFile()).toBeUndefined()
  expect(rowKinds().filter((k) => k.startsWith('relay-'))).toEqual(['relay-late closed'])
  expect(JSON.stringify(r)).toContain(prm.RELAY_LATE_LINE)
  pfs.delete(`${LDIR()}/${TID}.request.json`)
  pfs.delete(`${LDIR()}/${TID}.relay.json`)
  const r2 = await $.classic.PostToolUse(askPost([q as any], { [q.question]: '8080' }))
  expect(decFile()).toBeUndefined()
  expect(JSON.stringify(r2)).toContain(prm.RELAY_LATE_LINE)
})

test('prompts relay: a coalesced call with one permission relay and one question relay lands both decisions, each by its own short', async ($, on) => {
  beneathHooks(on)
  await tier($, on, [], { asksScope: 'all' })
  putQ({ id: TID2 })
  putRelayT({ level: 'lead', sid: SID, name: 'LEAD' }, TID2)
  putFile(`${TID2}.asked`, '{}')
  putQQ()
  putRelayT()
  putFile(`${TID}.asked`, '{}')
  const qa = relayQ(TID2)
  const qb = relayQQ(TID)
  await $.classic.PostToolUse(askPost([qa, qb as any], { [qa.question]: 'No', [qb.question]: '8080' }))
  expect(decOf(TID2)).toMatchObject({ decision: 'deny', via: 'person' })
  expect(decOf(TID)).toMatchObject({ decision: 'answer', answer: { index: 1, label: '8080' }, via: 'person' })
})

test('prompts relay: an agent\'s decision file already written, then the person\'s answer over it, stands as the person\'s', async ($, on) => {
  await relayQFixture($, on)
  putFile(`${TID}.decision.json`, JSON.stringify({ id: TID, inputHash: THASH, decision: 'answer', answer: { index: 0, label: '3000' }, why: 'agent', by: { level: 'lead', sid: SID, name: 'LEAD' }, at: T0, nonce: 'n-1' }))
  const q = relayQQ(TID)
  await $.classic.PostToolUse(askPost([q as any], { [q.question]: '8080' }))
  expect(decOf()).toMatchObject({ decision: 'answer', answer: { index: 1, label: '8080' }, via: 'person' })
})

test('prompts: a lead\'s own question stays the person\'s: no request, not-judgeable question-scope', async ($, on) => {
  await answerer($, on, [], { asLead: true, verdict: QASK, asksScope: 'all' })
  expect(await runRequest($, [stop(8000)], QCALL.over, QCALL.check)).toEqual({})
  expect(rowKinds().filter((k) => k.startsWith('requested'))).toEqual([])
  expect(reqFiles().length).toBe(0)
})

longTest('prompts hook: a question relay never asked is lost after 2 minutes, and a question held with the person past 20 minutes is never denied: it ends at the left mark', async ($, on) => {
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  addCondT()
  const r = await runRequest($, [at(4000, () => putFileAt(`${readReq().id}.relay.json`, JSON.stringify({ id: readReq().id, short: readReq().id.slice(0, 8), by: byCond, at: h.nowMs, nonce: readReq().nonce })))], QCALL.over, QCALL.check)
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'relay-lost not-asked', 'abandoned expired'])
})
longTest('prompts hook: a question relay held past 20 minutes returns no deny; the left mark ends it relay-left and the card stays', async ($, on) => {
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  const r = await runRequest($, [at(4000, () => { putRelay(readReq()); pfs.set(`${PDIR}/${readReq().id}.asked`, { text: '{}', mtimeSec: h.nowMs / 1000 }) }), at(25 * 60_000, () => pfs.set(`${PDIR}/${readReq().id}.left`, { text: '{}', mtimeSec: h.nowMs / 1000 }))], QCALL.over, QCALL.check)
  expect(r).toEqual({})
  expect(rowKinds()).toEqual(['requested', 'abandoned relay-left'])
  expect(h.nowMs - T0).toBeGreaterThan(25 * 60_000)
})

const qRow = (t: string) => `${JSON.stringify({ t, id: TID, tier: 'lead', by: LEADSID, header: 'Port', question: QTEXT, options: ['3000', '8080'], label: '8080' })}\n`
const seedQuestionFiles = () => {
  pdirs.add(PROMPTS_DIR)
  pfs.set(`${PROMPTS_DIR}/questions-2023-07.jsonl`, { text: qRow('2023-07-20T00:00:00.000Z'), mtimeSec: T0 / 1000 })
  pfs.set(`${PROMPTS_DIR}/questions-2023-08.jsonl`, { text: qRow('2023-08-10T00:00:00.000Z') + qRow('2023-08-20T00:00:00.000Z'), mtimeSec: T0 / 1000 })
  pfs.set(`${PROMPTS_DIR}/questions-2023-11.jsonl`, { text: qRow('2023-11-10T00:00:00.000Z'), mtimeSec: T0 / 1000 })
}
test('prompts: the questions file is pruned at 90 days: a month wholly older goes, the boundary month keeps its newer rows, the lock folder is left clean', async ($, on) => {
  await answerer($, on, [], { clock: true })
  seedQuestionFiles()
  await h.clock!.advance(62_000)
  expect(pfs.has(`${PROMPTS_DIR}/questions-2023-07.jsonl`)).toBe(false)
  expect(pfs.get(`${PROMPTS_DIR}/questions-2023-08.jsonl`)!.text).toBe(qRow('2023-08-20T00:00:00.000Z'))
  expect(pfs.get(`${PROMPTS_DIR}/questions-2023-11.jsonl`)!.text).toBe(qRow('2023-11-10T00:00:00.000Z'))
})
test('prompts: a prune that finds the lock folder held touches nothing', async ($, on) => {
  await answerer($, on, [], { clock: true })
  seedQuestionFiles()
  h.pfsFails = (a) => a[0] === '/bin/mkdir' && a.includes(`${PROMPTS_DIR}/questions.prune.lock`)
  await h.clock!.advance(62_000)
  h.pfsFails = undefined
  expect(pfs.has(`${PROMPTS_DIR}/questions-2023-07.jsonl`)).toBe(true)
  expect(pfs.get(`${PROMPTS_DIR}/questions-2023-08.jsonl`)!.text).toBe(qRow('2023-08-10T00:00:00.000Z') + qRow('2023-08-20T00:00:00.000Z'))
})
test('prompts tools (manager): the manager at the top relays a question: the relay file names the manager, and its relay question lands the person\'s pick', async ($, on) => {
  beneathHooks(on)
  await mgrAt($, on, [], { sess: MGR_SESS({ name: 'MANAGER', nameSource: 'user' }) })
  h.store.set('answering', { scope: 'all', asks: false, asksScope: 'all', savedAt: T0 })
  putQQ({ sid: APISID, pid: 4500, lane: 'API', repo: `${PIN}/api`, leadName: undefined })
  expect(said(await $.tool.call(pcall('prompt_escalate', { id: TID, why: 'x' })))).toContain(`header exactly "Relay ${SHORT}"`)
  expect(JSON.parse(pfs.get(`${LDIR(APISID)}/${TID}.relay.json`)!.text).by.level).toBe('manager')
  const q = relayQQ(TID)
  expect((await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions: [q] } } as any)) ?? {}).toEqual({})
  await $.classic.PostToolUse(askPost([q as any], { [q.question]: '3000' }))
  expect(JSON.parse(pfs.get(`${LDIR(APISID)}/${TID}.decision.json`)!.text)).toMatchObject({ decision: 'answer', answer: { index: 0, label: '3000' }, via: 'person', by: { level: 'manager' } })
})

test('prompts hook: a label that redaction changes is returned as the lane wrote it, never as its redacted copy; the questions file holds the redacted one', async ($, on) => {
  const tok = `${'gh'}p_abc123def`
  const tokenIn = { questions: [{ question: QTEXT, header: 'Auth', options: [{ label: tok, description: 'd' }, { label: 'no token', description: 'd' }], multiSelect: false }] }
  const c = callOf('AskUserQuestion', tokenIn)
  await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
  const r = await runRequest($, [at(4000, () => handDecision(readReq(), answerBy(0, '[REDACTED_GHTOKEN]')))], c.over, c.check)
  expect(r).toEqual({ decision: { behavior: 'allow', updatedInput: { ...tokenIn, answers: { [QTEXT]: `${tok} (answered by lead LEAD)` } } } })
  expect(JSON.stringify(questionsRows())).not.toContain(tok)
  expect(questionsRows()[0].label).toBe('[REDACTED_GHTOKEN]')
})

for (const [name, row] of [['option', { opt: '0', lh: 'a'.repeat(16) }], ['label hash', { lh: 'b'.repeat(16) }]] as [string, Record<string, unknown>][]) {
  test(`prompts hook: a decision file rewritten to another ${name} after its row is dropped no-answered-row: the row binds the option and the label hash`, async ($, on) => {
    await answerer($, on, [], { verdict: QASK, asksScope: 'all' })
    const r = await runRequest($, [at(4000, () => handDecision(readReq(), answerBy(1, '8080'), row)), stop(40_000)], QCALL.over, QCALL.check)
    expect(r).toEqual({})
    expect(hookKinds()).toEqual(['requested', 'dropped no-answered-row', 'off'])
  })
}
