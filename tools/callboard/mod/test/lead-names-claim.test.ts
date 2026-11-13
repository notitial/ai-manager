import { expect, test } from 'claude-code/testing'
import { STOPPABLE_BY_NAME, CLAIM_OTHER_UNNAMED, CLAIM_HINT, CLAIM_NOT_PERSON, CLAIM_NOT_LEAD, CLAIM_UNNAMED, CLAIM_NONE, claimQuestion, claimedText, claimRefusedText, reserveShowText, reserveAddedText, reserveRemovedText, reserveNotListedText, reserveManagerText, RESERVE_NOT_PERSON, RESERVE_USAGE, refusalText, attachQuestion, ATTACH_YES, ATTACH_NO, LANE_NO_LEAD, REASON_TEXT, LEAD_MORE, LEAD_PICK_QUESTION } from '../hooks/core'
import { h, NO, ROOT, SID, T0, YES, extraStat, laneSeed, leadFiles, lockLog, longTest, realMap, storeFiles, teeTexts } from './harness'
import { ANY, ATTACHED, GONE_ATT, HOME, LEADPATH, LEADPS, LEADSID, MGR_NOAPI, OTHER, OTHERLEAD, OTHERPATH, PERSON, PIN, SELFPATH, STATUS_NONE, STOREFILE, SVC, USAGE, attRec, attacher, bareList, bornWithTwoLeads, callCreate, ckRow, created, cue, cueSession, dirStat, doLane, lane, leadAt, leadCall, leadFileText, leadReg, leadSelfReg, listCall, logged, madeLane, mdBox, mdTable, mgrAt, mgrFile, mgrRow, noLaneWritten, ownReg, putStore, regAs, selfAs, started, storeJson, storeLaneNames, waitFor } from './fixtures'

longTest('lane_create stamps the lead name; another lead (or this one renamed) neither lists nor reaches that lane; a legacy lane stays in reach of both', async ($, on) => {
  await leadAt($, on, [], { sess: selfAs('LEADA') })
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  expect(storeJson().lanes[0].leadName).toBe('LEADA')
  putStore([...storeJson().lanes, { name: 'OLD', folder: SVC, brief: `${SVC}/B.md`, createdAt: 1 }], storeJson().creates)
  const api = ['API', 'api', 'none', '–']
  const old = ['OLD', 'svc', 'none', '–']
  const both = mdTable([['LEADA', 'app', [api]], ['Any lead', 'app', [old]]], '**Lead LEADA** · live')
  expect(await bareList($)).toBe(both)
  h.sessions = { ...selfAs('LEADB'), ...cueSession(OTHER, 'OLD', SVC, { pid: 4500 }) }
  // The lane that names LEADA is told by name, for the person's /callboard claim: LEADA is not running.
  expect(await bareList($)).toBe(`${mdBox(ANY, [['OLD', 'svc', 'live', '–']], '**Lead LEADB** · live')}\n\n${CLAIM_HINT(['API'])}`)
  for (const verb of ['resume', 'compact', 'start', 'rename', 'park', 'retire', 'terminate', 'open', 'unpark'])
    expect(JSON.stringify(await $.tool.call(leadCall(verb, { lane: 'API' })))).toContain(`lane_${verb} refused: other-lead: that lane belongs to another lead. Only that lead can reach it.`)
  expect((await $.tool.call(leadCall('resume', { lane: 'OLD' }))).result).toContain('cue resume acted')
  // No valid name: legacy lanes only.
  h.sessions = selfAs('LEAD A')
  const NOHEAD = '**Lead** · live'
  expect(await bareList($)).toBe(mdBox(ANY, [old], NOHEAD))
  // A twin row in another letter case voids the name; so does a reserved name.
  h.sessions = { ...selfAs('LEADA'), ...regAs(OTHER, 4600, 'leada') }
  expect(await bareList($)).toBe(mdBox(ANY, [old], NOHEAD))
  h.sessions = selfAs('MANAGER')
  expect(await bareList($)).toBe(mdBox(ANY, [old], NOHEAD))
  h.sessions = selfAs('LEADA')
  expect(await bareList($)).toBe(both)
  expect(storeJson().lanes.map((l: any) => [l.name, l.leadName])).toEqual([['API', 'LEADA'], ['OLD', undefined]])
})

test('an attached record carries the lead name and its briefing names that lead; a cue is refused no-lead while no live lead has that name; it still detaches', async ($, on) => {
  await attacher($, on, [], { clock: true })
  h.sessions = { ...regAs(LEADSID, 4242, 'LEADA'), ...ownReg() }
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect(storeJson().lanes).toEqual([{ name: 'svc-api', folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: T0, adopted: true, lead: LEADSID, sid: SID, leadName: 'LEADA' }])
  expect(h.appendRows[0].content[0].text).toContain(`Your lead is \`LEADA\` (session \`${LEADSID}\`)`)
  expect(await cue(91, 'resume\n')).toBe('resume ok - 91\n')
  leadFiles.clear()
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  h.sessions = { ...regAs(OTHERLEAD, 4243, 'LEADB'), ...ownReg() }
  expect(await cue(92, 'resume\n')).toBe('resume refused no-lead 92\n')
  leadFiles.set(LEADPATH, { text: leadFileText() })
  h.sessions = { ...h.sessions, ...regAs(LEADSID, 4242, 'LEADA') }
  expect(await cue(93, 'resume\n')).toBe('resume ok - 93\n')
  h.sessions = { ...h.sessions, ...regAs(LEADSID, 4242, 'LEADC') }
  expect(await cue(94, 'resume\n')).toBe('resume refused no-lead 94\n')
  await doLane($, 'lane off')
  expect(storeJson().lanes.map((l: any) => l.sid)).toEqual([undefined])
})

test('a legacy attached record (lead session id only) answers any lead of its repo and still detaches', async ($, on) => {
  await attacher($, on, [], { clock: true })
  h.sessions = { ...leadReg({ name: 'my lead' }), ...ownReg() }
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect('leadName' in storeJson().lanes[0]).toBe(false)
  leadFiles.clear()
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  h.sessions = { ...regAs(OTHERLEAD, 4243, 'LEADB'), ...ownReg() }
  expect(await cue(95, 'resume\n')).toBe('resume ok - 95\n')
  await doLane($, 'lane off')
  expect(storeJson().lanes.map((l: any) => l.sid)).toEqual([undefined])
})

test('with two leads in the repo, a born store lane naming its lead gets that lead in its briefing, whatever lead the rename cue names', async ($, on) => {
  const r = await bornWithTwoLeads($, on, `rename LABLANE ${LEADSID}\n`, { leadName: 'LEAD2' })
  expect(r.first).toContain(`Your lead is \`LEAD2\` (session \`${OTHERLEAD}\`)`)
})

test('a born store lane naming a lead that is not live gets the generic wording, not the lead the rename cue names', async ($, on) => {
  const r = await bornWithTwoLeads($, on, `rename LABLANE ${OTHERLEAD}\n`, { leadName: 'GONE' })
  expect(r.first).toContain('Your lead is the lead session of this repo.')
})

test('lane_create refuses a name a live session carries in any letter case, and lead-unnamed when the lead lost the name it had at its grant', async ($, on) => {
  await leadAt($, on, [], { sess: selfAs('LEADA') })
  expect(JSON.stringify(await callCreate($, created({ name: 'leada' })))).toContain('lane_create refused: name-in-use')
  h.sessions = selfAs('LEAD A')
  expect(JSON.stringify(await callCreate($))).toContain("lane_create refused: lead-unnamed: this lead's session name is not unique or not a valid lane name right now")
  h.sessions = { ...selfAs('LEADA'), ...regAs(OTHER, 4600, 'leada') }
  expect(JSON.stringify(await callCreate($))).toContain('lane_create refused: lead-unnamed')
  expect(storeLaneNames()).toEqual([])
})

test('a session with a reserved name is refused lead-name-reserved before the dialog, lone or not; a name reserved on this machine counts once added', async ($, on) => {
  const stdins: string[] = []
  await beside($, on, selfAs('MANAGER'), undefined, stdins)
  const n = h.askCount
  expect((await $.command.run(lane('lead'))).text).toBe(leadStaysOff('lead-name-reserved'))
  expect(h.askCount).toBe(n)
  expect(logged(stdins)).toContain('refused:lead-name-reserved')
  expect(leadFiles.has(SELFPATH)).toBe(false)
})

test('reserve: the live manager name cannot be removed; a reserve another session wrote meanwhile is kept', async ($, on) => {
  const stdins: string[] = []
  await beside($, on, selfAs('LEADX'), undefined, stdins)
  h.store.set('reserved', { names: ['HARBOR', 'WARDEN'] })
  mgrFile('HARBOR')
  h.sessions = { ...h.sessions, ...mgrRow('HARBOR') }
  expect((await $.command.run(lane('reserve remove harbor'))).text).toBe(reserveManagerText('HARBOR'))
  expect((h.store.get('reserved') as any).names).toEqual(['HARBOR', 'WARDEN'])
  expect((await $.command.run(lane('reserve remove WARDEN'))).text).toBe(reserveRemovedText('WARDEN'))
  expect((h.store.get('reserved') as any).names).toEqual(['HARBOR'])
  expect((await $.command.run(lane('reserve ab'))).text).toMatch(/too short/)
})

test('reserve: the person adds and removes a machine name; a lead may not carry it meanwhile; other origins are refused; a name in use is refused', async ($, on) => {
  const stdins: string[] = []
  await beside($, on, selfAs('HARBOR'), undefined, stdins)
  expect((await $.command.run(lane('reserve'))).text).toBe(reserveShowText([]))
  expect((await $.command.run(lane('reserve HARBOR', { kind: 'plugin' }))).text).toBe(RESERVE_NOT_PERSON)
  expect(logged(stdins)).toContain('refused:reserve-not-person:plugin')
  expect(h.store.has('reserved')).toBe(false)
  expect((await $.command.run(lane('reserve MANAGER'))).text).toMatch(/built in/)
  expect((await $.command.run(lane('reserve HARBOR'))).text).toBe(reserveAddedText('HARBOR'))
  expect((h.store.get('reserved') as any).names).toEqual(['HARBOR'])
  expect(logged(stdins)).toContain('reserve-add:prompt')
  expect((await $.command.run(lane('reserve harbor'))).text).toMatch(/reserved already on this machine/)
  expect((await $.command.run(lane('reserve'))).text).toBe(reserveShowText(['HARBOR']))
  expect((await $.command.run(lane('lead'))).text).toBe(leadStaysOff('lead-name-reserved'))
  expect((await $.command.run(lane('reserve remove harbor'))).text).toBe(reserveRemovedText('HARBOR'))
  expect((h.store.get('reserved') as any).names).toEqual([])
  expect((await $.command.run(lane('reserve remove HARBOR'))).text).toBe(reserveNotListedText('HARBOR'))
  expect((await $.command.run(lane('reserve a b'))).text).toBe(RESERVE_USAGE)
  expect((await $.command.run(lane('lead'))).text).toBe(LEAD_ON)
  expect((await $.command.run(lane('reserve HARBOR'))).text).toMatch(/the live lead HARBOR carries it/)
  expect((await $.command.run(lane('reserve HARB0R'))).text).toMatch(/the live lead HARBOR carries it/)
  expect((h.store.get('reserved') as any).names).toEqual([])
})

test('attach refuses a name a live session carries in another letter case', async ($, on) => {
  await attacher($, on, [])
  h.sessions = { ...regAs(LEADSID, 4242, 'LEADA'), ...ownReg() }
  expect((await doLane($, 'lane leada')).text).toBe(refusalText('name-taken'))
  await noLaneWritten($)
})

for (const [what, row] of [['renamed', regAs(LEADSID, 4242, 'LEADB')], ['no longer validly named', { '4242.json': leadReg({ name: 'LEAD A' })['4242.json'] }]] as const) {
  test(`attach is refused changed when the lead is ${what} while the dialog is open, before the store is touched`, async ($, on) => {
    await attacher($, on, [])
    h.sessions = { ...regAs(LEADSID, 4242, 'LEADA'), ...ownReg() }
    h.askHang = { then: (res: (v: string) => void) => { h.sessions = { ...row, ...ownReg() }; res('Join') } } as any
    expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('changed'))
    expect(lockLog).toEqual([])
    await noLaneWritten($)
  })
}

test('attach is refused changed when the lead is renamed after the re-check, under the store lock; nothing is written', async ($, on) => {
  await attacher($, on, [])
  h.sessions = { ...regAs(LEADSID, 4242, 'LEADA'), ...ownReg() }
  h.lockHook = (ev) => { if (ev === 'mkdir') h.sessions = { ...regAs(LEADSID, 4242, 'LEADB'), ...ownReg() } }
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('changed'))
  expect(lockLog[0]).toBe('mkdir')
  await noLaneWritten($)
})

test('an attach whose store write lands without the lead name is not bound', async ($, on) => {
  await attacher($, on, [])
  h.sessions = { ...regAs(LEADSID, 4242, 'LEADA'), ...ownReg() }
  h.mvHook = (to) => { if (to === STOREFILE) for (const [k, v] of teeTexts) teeTexts.set(k, v.replace(',"leadName":"LEADA"', '')) }
  expect((await doLane($, 'lane svc-api')).text.startsWith('Lane not changed: the record was not saved.')).toBe(true)
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
})

test('two leads in one repo, two lanes each: lane_list, lane_resume, lane_unpark and the stop tools reach only their own; a legacy lane is in reach of both', async ($, on) => {
  await leadAt($, on, [], { sess: { ...selfAs('LEADA'), ...regAs(OTHERLEAD, 4243, 'LEADB') } })
  putStore([madeLane('A1', 'LEADA'), madeLane('A2', 'LEADA'), madeLane('B1', 'LEADB'), madeLane('B2', 'LEADB'), madeLane('OLD')])
  for (const [me, other, mine, theirs] of [['LEADA', 'LEADB', ['A1', 'A2'], ['B1', 'B2']], ['LEADB', 'LEADA', ['B1', 'B2'], ['A1', 'A2']]] as const) {
    h.sessions = { ...selfAs(me), ...regAs(OTHERLEAD, 4243, other), ...cueSession(OTHER, mine[0], SVC, { pid: 4500 }) }
    const row = (n: string) => [n, 'svc', n === mine[0] ? 'live' : 'none', '–']
    expect(await bareList($)).toBe(mdTable([[me, 'app', mine.map(row)], ['Any lead', 'app', [row('OLD')]]], `**Lead ${me}** · live`))
    for (const n of theirs) for (const verb of ['resume', 'unpark', 'park', 'retire']) expect(JSON.stringify(await $.tool.call(leadCall(verb, { lane: n }))), `${me} ${verb} ${n}`).toContain(`lane_${verb} refused: other-lead`)
    expect((await $.tool.call(leadCall('resume', { lane: mine[0] }))).result).toContain('cue resume acted')
    // A retire of a lane no live session carries removes its record, so it is not in this list.
    for (const [verb, why] of [['unpark', 'no-saved-session'], ['park', 'no-live-session']]) expect(JSON.stringify(await $.tool.call(leadCall(verb, { lane: mine[1] }))), `${me} ${verb}`).toContain(why)
    h.sessions = { ...selfAs(me), ...regAs(OTHERLEAD, 4243, other), ...cueSession(OTHER, 'OLD', SVC, { pid: 4500 }) }
    expect((await $.tool.call(leadCall('resume', { lane: 'OLD' }))).result).toContain('cue resume acted')
  }
})

test('with two leads in the repo, each born store lane names its own lead in its briefing, whatever lead the rename cue names', async ($, on) => {
  const r = await bornWithTwoLeads($, on, `rename LABLANE ${OTHERLEAD}\n`, { leadName: 'LEAD' })
  expect(r.first).toContain(`Your lead is \`LEAD\` (session \`${LEADSID}\`)`)
})

// A session in PIN about to run /callboard lead, beside another live lead of PIN (its presence file and registry row with these fields) unless other is undefined.
async function beside($: any, on: any, me: Record<string, string>, other: Record<string, unknown> | undefined, stdins: string[] = [], clock = false) {
  laneSeed.text = undefined
  h.sessions = { ...me, ...(other ? { '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243, ...other })['4242.json'] } : {}) }
  await started($, on, stdins, { clock, seed: () => (other ? leadFiles.set(OTHERPATH, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) }) : undefined) })
  extraStat.set(`${PIN}/.git`, dirStat)
  h.callerCwd = PIN
  h.askAnswer = YES
}
const LEAD_ON = 'Lead is on from your next prompt.\nOnly a force stop asks you.'
const leadStaysOff = (code: string) => `Lead stays off: ${REASON_TEXT[code]}`

test('a second lead in a repo is allowed when both have distinct usable names, from any name source', async ($, on) => {
  await beside($, on, selfAs('LEADB', { nameSource: 'auto' }), { name: 'LEADA' })
  expect((await $.command.run(lane('lead'))).text).toBe(LEAD_ON)
  expect(leadFiles.has(SELFPATH)).toBe(true)
})

test('a lead grant is refused while the session list cannot be read safely: it cannot show whether another lead runs', async ($, on) => {
  await beside($, on, selfAs('LEADB'), undefined)
  h.sessionsUnsafe = true
  expect((await $.command.run(lane('lead'))).text).toBe(leadStaysOff('registry-unreadable'))
  h.sessionsUnsafe = false
  expect((await $.command.run(lane('lead'))).text).toBe(LEAD_ON)
})

test('a lone lead in a repo may stay unnamed', async ($, on) => {
  await beside($, on, selfAs('x y', { nameSource: 'auto' }), undefined)
  expect((await $.command.run(lane('lead'))).text).toBe(LEAD_ON)
})

for (const [code, me, other] of [
  ['lead-name-taken', selfAs('LEADA'), { name: 'leada', nameSource: 'user' }],
  ['lead-name-taken', selfAs('LEADA'), { name: 'LEADA', nameSource: 'user' }],
  ['lead-needs-name', selfAs('LEAD B'), { name: 'LEADA', nameSource: 'auto' }],
  ['lead-name-reserved', selfAs('MANAGER'), { name: 'LEADA', nameSource: 'user' }],
  ['other-lead-unnamed', selfAs('LEADB'), { name: 'LEAD A' }],
] as const) {
  test(`a second lead whose names do not allow it is refused ${code} before the dialog (${JSON.stringify(other.name)})`, async ($, on) => {
    const stdins: string[] = []
    await beside($, on, me, other, stdins)
    const n = h.askCount
    expect((await $.command.run(lane('lead'))).text).toBe(leadStaysOff(code))
    expect(h.askCount).toBe(n)
    expect(logged(stdins)).toContain(`refused:${code}`)
    expect((await $.command.run(lane('status'))).text).toContain('Lead: OFF')
    expect(leadFiles.has(SELFPATH)).toBe(false)
  })
}

for (const [code, other] of [['other-lead-unnamed', { name: 'LEAD A' }], ['lead-name-taken', { name: 'LEADB', nameSource: 'user' }]] as const) {
  test(`another lead that starts while the lead question is open is checked again after the yes: ${code}`, async ($, on) => {
    await beside($, on, selfAs('LEADB'), undefined)
    h.askScript = () => {
      h.sessions = { ...h.sessions, '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243, ...other })['4242.json'] }
      leadFiles.set(OTHERPATH, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
      return YES
    }
    expect((await $.command.run(lane('lead'))).text).toBe(leadStaysOff(code))
    expect((await $.command.run(lane('status'))).text).toContain('Lead: OFF')
    expect(leadFiles.has(SELFPATH)).toBe(false)
  })
}

test('an in-mark check for other leads that does not answer in time is refused lead-check-slow', async ($, on) => {
  const stdins: string[] = []
  await beside($, on, selfAs('LEADB'), undefined, stdins, true)
  let hung = false
  h.askScript = () => {
    h.leadsListHook = () => ((hung = true), new Promise<void>(() => undefined))
    return YES
  }
  const p = $.command.run(lane('lead'))
  await waitFor(() => hung)
  expect(hung).toBe(true)
  await h.clock!.advance(30_000)
  expect((await p).text).toBe(leadStaysOff('lead-check-slow'))
  expect(logged(stdins)).toContain('refused:lead-check-slow')
  h.leadsListHook = undefined
  expect((await $.command.run(lane('status'))).text).toContain('Lead: OFF')
})

test('lane_create by a lead with no usable name is refused lead-unnamed once another live lead runs in the repo', async ($, on) => {
  await leadAt($, on, [], { sess: selfAs('LEAD A') })
  h.sessions = { ...selfAs('LEAD A'), ...regAs(OTHERLEAD, 4243, 'LEADB') }
  leadFiles.set(OTHERPATH, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  expect(JSON.stringify(await callCreate($))).toContain('lane_create refused: lead-unnamed')
  expect(storeFiles.has(STOREFILE)).toBe(false)
  leadFiles.delete(OTHERPATH)
  expect((await callCreate($)).result).toContain(`.${LANE_NO_LEAD} Next:`)
})

// Two live leads of PIN for the attaching session in SVC: LEADA (LEADSID) and LEADB (OTHERLEAD); more: further leads as [sid, pid, name].
async function twoLeads($: any, on: any, stdins: string[] = [], opts: { clock?: boolean; more?: [string, number, string][]; b?: Record<string, unknown> } = {}) {
  await attacher($, on, stdins, { clock: opts.clock })
  h.sessions = { ...regAs(LEADSID, 4242, 'LEADA'), '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243, name: 'LEADB', nameSource: 'user', ...opts.b })['4242.json'], ...ownReg() }
  leadFiles.set(OTHERPATH, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  for (const [sid, pid, name] of opts.more ?? []) {
    h.sessions = { ...h.sessions, ...regAs(sid, pid, name) }
    leadFiles.set(`${ROOT}/leads/${sid}.json`, { text: leadFileText({ sid, pid }) })
  }
}
const picks = (...a: string[]) => (q: string) => (q === LEAD_PICK_QUESTION ? a.shift() ?? 'none left' : 'Join')

test('with two leads the Join dialog first asks which lead; the pick is stamped on the record, named in the question and in the briefing', async ($, on) => {
  await twoLeads($, on)
  h.askScript = picks('LEADB')
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect(h.askedOptions).toEqual([['LEADA', 'LEADB'], [ATTACH_YES, ATTACH_NO]])
  expect(h.lastQuestion).toBe(attachQuestion('svc-api', 'svc', 'app', false, 'LEADB'))
  expect(storeJson().lanes[0]).toMatchObject({ name: 'svc-api', lead: OTHERLEAD, leadName: 'LEADB' })
  expect(h.appendRows[0].content[0].text).toContain(`Your lead is \`LEADB\` (session \`${OTHERLEAD}\`)`)
})

test('with one usable name among several leads the picker still shows, with that name alone', async ($, on) => {
  await twoLeads($, on, [], { b: { name: 'LEAD B' } })
  h.askScript = picks(ATTACH_NO)
  expect((await doLane($, 'lane svc-api')).text).toBe('Cancelled. Nothing changed.')
  await noLaneWritten($)
  h.askedOptions = []
  h.askScript = picks('LEADA')
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect(h.askedOptions).toEqual([['LEADA', ATTACH_NO], [ATTACH_YES, ATTACH_NO]])
  expect(storeJson().lanes[0]).toMatchObject({ lead: LEADSID, leadName: 'LEADA' })
})

test('with more than 4 leads the picker shows 3 names and More…, which pages on and wraps to the first page', async ($, on) => {
  const more: [string, number, string][] = [3, 4, 5].map((n) => [`7${n}1b2c3d-0000-4000-8000-123456789abc`, 4250 + n, `LEAD${'CDE'[n - 3]}`])
  await twoLeads($, on, [], { more })
  h.askScript = picks(LEAD_MORE, LEAD_MORE, 'LEADB')
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  const first = ['LEADA', 'LEADB', 'LEADC', LEAD_MORE]
  expect(h.askedOptions).toEqual([first, ['LEADD', 'LEADE', LEAD_MORE], first, [ATTACH_YES, ATTACH_NO]])
  expect(storeJson().lanes[0]).toMatchObject({ lead: OTHERLEAD, leadName: 'LEADB' })
})

test('a dismissed, failed or timed-out lead picker changes nothing; a second /callboard lane meanwhile is busy', async ($, on) => {
  const stdins: string[] = []
  await twoLeads($, on, stdins, { clock: true })
  for (const a of ['', 'Cancel', 'LEADC', LEAD_MORE, 'Join']) {
    h.askScript = picks(a)
    expect((await doLane($, 'lane svc-api')).text, a).toBe('Cancelled. Nothing changed.')
    await noLaneWritten($)
  }
  expect(logged(stdins)).toContain('refused:attach-not-confirmed')
  h.askScript = () => new Promise<string>(() => undefined)
  const n = h.askCount
  const p = doLane($, 'lane svc-api')
  await waitFor(() => h.askCount !== n)
  expect((await doLane($, 'lane svc-api')).text).toBe('A callboard question is already open. Answer it first.')
  await h.clock!.advance(90_000)
  expect((await p).text).toBe('Nothing changed: the question timed out.')
  expect(h.askCount).toBe(n + 1)
  await noLaneWritten($)
  expect(logged(stdins)).toContain('refused:timed-out')
})

test('a lead picker whose dialog throws or rejects is cancelled; nothing changes', async ($, on) => {
  await twoLeads($, on)
  for (const fail of [() => { throw new Error('dialog failed') }, () => Promise.reject(new Error('dialog failed'))]) {
    h.askScript = (q) => (q === LEAD_PICK_QUESTION ? (fail() as never) : 'Join')
    expect((await doLane($, 'lane svc-api')).text).toBe('Cancelled. Nothing changed.')
    await noLaneWritten($)
  }
})

test('Cancel beside a lone lead name is a cancel, even when that lead is named Cancel', async ($, on) => {
  await twoLeads($, on, [], { b: { name: 'LEAD B' } })
  h.sessions = { ...h.sessions, ...regAs(LEADSID, 4242, 'Cancel') }
  h.askScript = picks(ATTACH_NO)
  expect((await doLane($, 'lane svc-api')).text).toBe('Cancelled. Nothing changed.')
  expect(h.askedOptions).toEqual([['Cancel', ATTACH_NO]])
  await noLaneWritten($)
})

test('the session folder checks refuse before the lead picker', async ($, on) => {
  await twoLeads($, on)
  realMap.set(SVC, `${PIN}/svc-real`)
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('folder-bad'))
  expect(h.askedOptions).toEqual([])
  await noLaneWritten($)
})

test('with one lead, a second named lead that appears while the Join question is open makes the attach changed', async ($, on) => {
  await attacher($, on, [])
  h.sessions = { ...regAs(LEADSID, 4242, 'LEADA'), ...ownReg() }
  h.askScript = () => {
    h.sessions = { ...h.sessions, ...regAs(OTHERLEAD, 4243, 'LEADB') }
    leadFiles.set(OTHERPATH, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
    return 'Join'
  }
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('changed'))
  expect(h.askedOptions).toEqual([[ATTACH_YES, ATTACH_NO]])
  expect(lockLog).toEqual([])
  await noLaneWritten($)
})

for (const [when, gone] of [['picker', LEAD_PICK_QUESTION], ['Join question', 'Make this session']] as const) {
  for (const [what, act] of [['gone', () => leadFiles.delete(OTHERPATH)], ['renamed', () => (h.sessions = { ...h.sessions, ...regAs(OTHERLEAD, 4243, 'LEADX') })]] as const) {
    test(`the picked lead ${what} while the ${when} is open: refused changed, nothing written`, async ($, on) => {
      await twoLeads($, on)
      h.askScript = (q) => {
        if (q.startsWith(gone)) act()
        return q === LEAD_PICK_QUESTION ? 'LEADB' : 'Join'
      }
      expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('changed'))
      expect(h.askedOptions.length).toBe(when === 'picker' ? 1 : 2)
      expect(lockLog).toEqual([])
      await noLaneWritten($)
    })
  }
}

test('/callboard status in a lane names the lane and its lead; /callboard on there changes nothing (the usage line); lane off makes it NONE', async ($, on) => {
  await attacher($, on, [], { clock: true })
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect((await $.command.run(lane('status'))).text).toBe("Lane: svc-api. Lead: OFF. This lane's lead: LEAD.")
  const asks = h.askCount
  expect((await $.command.run(lane('on'))).text).toBe(USAGE)
  expect(h.askCount).toBe(asks)
  expect((await $.command.run(lane('status'))).text).toBe("Lane: svc-api. Lead: OFF. This lane's lead: LEAD.")
  expect((await doLane($, 'lane off')).text).toBe(`This session is no longer lane svc-api.${STOPPABLE_BY_NAME('svc-api')}`)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

// ---- the rename carry ----
test('stuck lanes: a lead renamed carries the attached records its own session joined to its new name, and no other record', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true })
  const made = { name: 'MADE', folder: SVC, brief: `${SVC}/B.md`, createdAt: 1, leadName: 'LEAD' }
  putStore([GONE_ATT('MINE'), attRec(OTHERLEAD, 'THEIRS', { leadName: 'LEAD' }), made, GONE_ATT('ELSE', { leadName: 'elsewhere' }), attRec(SID, 'LEGACY')])
  const names = () => Object.fromEntries((storeJson().lanes as any[]).map((l) => [l.name, l.leadName]))
  h.sessions = selfAs('LEAD2')
  await h.clock!.advance(2000)
  expect(names()).toEqual({ MINE: 'LEAD2', THEIRS: 'LEAD', MADE: 'LEAD', ELSE: 'elsewhere', LEGACY: undefined })
  expect(logged(stdins)).toContain('lead-rename-carried:1')
  // The new name is cached: the next rename carries from it.
  h.sessions = selfAs('LEAD3')
  await h.clock!.advance(12_000)
  expect(names().MINE).toBe('LEAD3')
  // No usable name (reserved, or a twin row in another letter case) carries nothing, and keeps the name cached.
  h.sessions = selfAs('MANAGER')
  await h.clock!.advance(12_000)
  expect(names().MINE).toBe('LEAD3')
  h.sessions = { ...selfAs('LEAD4'), ...regAs(OTHER, 4600, 'lead4') }
  await h.clock!.advance(12_000)
  expect(names().MINE).toBe('LEAD3')
  h.sessions = selfAs('LEAD4')
  await h.clock!.advance(12_000)
  expect(names().MINE).toBe('LEAD4')
  expect(names().MADE).toBe('LEAD')
})

test('stuck lanes: a lead renamed also carries the lanes it made (its session id is on the record), not another lead\'s, and a record made before the field stays as it was', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true })
  const made = (name: string, extra: Record<string, unknown> = {}) => ({ name, folder: SVC, brief: `${SVC}/${name}.md`, createdAt: 1, leadName: 'LEAD', ...extra })
  putStore([made('MINE', { leadSid: SID }), made('THEIRS', { leadSid: OTHERLEAD }), made('OLD'), GONE_ATT('JOINED')])
  const names = () => Object.fromEntries((storeJson().lanes as any[]).map((l) => [l.name, l.leadName]))
  h.sessions = selfAs('LEAD2')
  await h.clock!.advance(2000)
  expect(names()).toEqual({ MINE: 'LEAD2', THEIRS: 'LEAD', OLD: 'LEAD', JOINED: 'LEAD2' })
  expect(logged(stdins)).toContain('lead-rename-carried:2')
  expect((storeJson().lanes as any[]).map((l) => l.leadSid)).toEqual([SID, OTHERLEAD, undefined, undefined])
  h.sessions = selfAs('LEAD3')
  await h.clock!.advance(12_000)
  expect(names()).toEqual({ MINE: 'LEAD3', THEIRS: 'LEAD', OLD: 'LEAD', JOINED: 'LEAD3' })
})

test('lane_create stamps the lead session id beside the lead name', async ($, on) => {
  await leadAt($, on, [], { sess: selfAs('LEADA') })
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  expect(storeJson().lanes[0]).toMatchObject({ name: 'API', leadName: 'LEADA', leadSid: SID })
})

test('a born store lane that carries its lead session id and no lead name gets that lead in its briefing, whatever lead the rename cue names', async ($, on) => {
  const r = await bornWithTwoLeads($, on, `rename LABLANE ${LEADSID}\n`, { leadSid: OTHERLEAD })
  expect(r.first).toContain(`Your lead is \`LEAD2\` (session \`${OTHERLEAD}\`)`)
})

test('stuck lanes: a rename that changes nothing, or a lead that never had a name, writes no store', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  putStore([GONE_ATT('MINE')])
  const before = storeFiles.get(STOREFILE)
  await h.clock!.advance(30_000)
  expect(storeFiles.get(STOREFILE)).toBe(before)
})

// ---- /callboard claim ----
const MADE_OLD = (name = 'API', leadName = 'old-aa') => ({ name, folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 1, leadName })
const claim = ($: any, origin: unknown = PERSON) => $.command.run(lane('claim', origin))
const leadNames = () => Object.fromEntries((storeJson().lanes as any[]).map((l) => [l.name, l.leadName]))

test('stuck lanes: lane_list tells a lead the lanes that name a lead nobody runs; /callboard claim asks, then makes them the lead\'s, all or none', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins)
  putStore([MADE_OLD(), attRec(OTHERLEAD, 'ATT', { leadName: 'old-bb' }), GONE_ATT('MINE'), { name: 'LEG', folder: SVC, brief: `${SVC}/B.md`, createdAt: 1 }])
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain(CLAIM_HINT(['API', 'ATT']))
  const asked = h.askCount
  // Only the person's own prompt or phone.
  for (const kind of ['plugin', 'peer', 'script']) expect((await claim($, { kind })).text).toBe(CLAIM_NOT_PERSON)
  expect(h.askCount).toBe(asked)
  h.askAnswer = NO
  expect((await claim($)).text).toBe('Cancelled. Nothing changed.')
  expect(h.lastQuestion).toBe(claimQuestion(['API', 'ATT'], PIN, ['old-aa', 'old-bb'], 'LEAD', HOME))
  expect(h.lastQuestion).toBe('Claim lanes API, ATT in ~/code/app for lead LEAD? They name leads that are not running (old-aa, old-bb). They answer LEAD afterwards.')
  expect(h.lastHeader).toBe('Claim Lanes')
  expect(h.askedOptions[h.askedOptions.length - 1]).toEqual(['Claim', 'Cancel'])
  expect(leadNames()).toEqual({ API: 'old-aa', ATT: 'old-bb', MINE: 'LEAD', LEG: undefined })
  h.askAnswer = YES
  expect((await claim($, { kind: 'bridge' })).text).toBe(claimedText(['API', 'ATT'], 'LEAD'))
  expect(leadNames()).toEqual({ API: 'LEAD', ATT: 'LEAD', MINE: 'LEAD', LEG: undefined })
  // Nothing else of the records changed.
  expect(storeJson().lanes[0]).toEqual({ ...MADE_OLD(), leadName: 'LEAD' })
  expect(logged(stdins)).toContain('lanes-claimed:2')
  expect(JSON.stringify(await $.tool.call(listCall()))).not.toContain('/callboard claim')
  expect((await claim($)).text).toBe(CLAIM_NONE)
})

test('stuck lanes: a lead name a live session carries (any letter case) is not claimed; one that appears while the dialog is open stops the claim', async ($, on) => {
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...regAs(OTHER, 4600, 'OLD-AA') } })
  putStore([MADE_OLD(), attRec(OTHERLEAD, 'ATT', { leadName: 'old-bb' })])
  h.askAnswer = YES
  expect((await claim($)).text).toBe(claimedText(['ATT'], 'LEAD'))
  expect(leadNames()).toEqual({ API: 'old-aa', ATT: 'LEAD' })
  putStore([MADE_OLD('API', 'old-aa'), MADE_OLD('API2', 'old-bb')])
  h.sessions = leadSelfReg()
  h.askScript = async () => {
    h.sessions = { ...leadSelfReg(), ...regAs(OTHER, 4600, 'old-bb') }
    return YES
  }
  expect((await claim($)).text).toBe(claimRefusedText('changed'))
  h.askScript = undefined
  expect(leadNames()).toEqual({ API: 'old-aa', API2: 'old-bb' })
})

test('stuck lanes: a lane the lead made that a live session carries is not claimed (its hash would break); one carried when the person clicks stops the whole claim', async ($, on) => {
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...ckRow() } })
  putStore([MADE_OLD('API', 'old-aa'), MADE_OLD('B', 'old-aa')].map((l, i) => (i === 0 ? { ...l, sid: OTHER } : l)))
  // lane_list tells only the lanes the claim would take.
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain(CLAIM_HINT(['B']))
  h.askAnswer = YES
  expect((await claim($)).text).toBe(claimedText(['B'], 'LEAD'))
  expect(leadNames()).toEqual({ API: 'old-aa', B: 'LEAD' })
  putStore([MADE_OLD('B', 'old-aa'), MADE_OLD('C', 'old-aa')])
  h.sessions = leadSelfReg()
  // A session carrying C right after the click is caught by the re-plan.
  h.askScript = async () => {
    h.sessions = { ...leadSelfReg(), ...cueSession(OTHER, 'C', `${PIN}/api`, { pid: 4500 }) }
    return YES
  }
  expect((await claim($)).text).toBe(claimRefusedText('changed'))
  h.askScript = undefined
  expect(leadNames()).toEqual({ B: 'old-aa', C: 'old-aa' })
  // And one that appears after the re-plan, as the store lock is taken, by the check inside the lock.
  h.sessions = leadSelfReg()
  h.lockHook = (event) => {
    if (event === 'mkdir') h.sessions = { ...leadSelfReg(), ...cueSession(OTHER, 'C', `${PIN}/api`, { pid: 4500 }) }
  }
  expect((await claim($)).text).toBe(claimRefusedText('name-in-use'))
  h.lockHook = undefined
  expect(leadNames()).toEqual({ B: 'old-aa', C: 'old-aa' })
})

test('stuck lanes: claim needs a named lead; a conductor and the manager have no claim (their reach ignores the lead name)', async ($, on) => {
  await leadAt($, on, [])
  putStore([MADE_OLD()])
  h.sessions = selfAs('LEAD A')
  expect((await claim($)).text).toBe(CLAIM_UNNAMED)
  expect(leadNames()).toEqual({ API: 'old-aa' })
})

test('stuck lanes: claim in a session that holds no lead grant, a conductor or the manager says so', async ($, on) => {
  await mgrAt($, on, [], { sess: MGR_NOAPI() })
  expect((await claim($)).text).toBe(CLAIM_NOT_LEAD)
})

test('stuck lanes: a claim leaves out the lanes of a live lead (attached record whose lead session runs), and waits while another live lead of the repo has no usable name', async ($, on) => {
  await leadAt($, on, [])
  putStore([GONE_ATT('ATT', { leadName: 'old-bb', lead: OTHERLEAD }), MADE_OLD()])
  // The lead session OTHERLEAD runs, under a name that is not valid (so no lane can name it): its attached lane is not up for claim.
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: JSON.stringify({ sid: OTHERLEAD, pid: 4700, procStart: LEADPS, repo: PIN }) })
  h.sessions = { ...leadSelfReg(), ...cueSession(OTHERLEAD, 'lead b', PIN, { pid: 4700 }) }
  h.askAnswer = YES
  expect((await claim($)).text).toBe(CLAIM_OTHER_UNNAMED)
  expect(leadNames()).toEqual({ ATT: 'old-bb', API: 'old-aa' })
  // A live lead with a usable name that is not the one the records name leaves the old names claimable; its own session's attached lane is still not.
  h.sessions = { ...leadSelfReg(), ...cueSession(OTHERLEAD, 'LEADB', PIN, { pid: 4700 }) }
  expect((await claim($)).text).toBe(claimedText(['API'], 'LEAD'))
  expect(leadNames()).toEqual({ ATT: 'old-bb', API: 'LEAD' })
})

test('stuck lanes: the claim checks the other leads again inside the store lock: one that appears unnamed, one whose attached lane is claimed, or an unreadable leads folder stops it', async ($, on) => {
  await leadAt($, on, [])
  const leadFile = () => leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: JSON.stringify({ sid: OTHERLEAD, pid: 4700, procStart: LEADPS, repo: PIN }) })
  h.askAnswer = YES
  // A second lead, with no usable name, that comes up as the store lock is taken.
  putStore([MADE_OLD()])
  leadFile()
  h.lockHook = (event) => {
    if (event === 'mkdir') h.sessions = { ...leadSelfReg(), ...cueSession(OTHERLEAD, 'lead b', PIN, { pid: 4700 }) }
  }
  expect((await claim($)).text).toBe(claimRefusedText('other-lead-unnamed'))
  h.lockHook = undefined
  expect(leadNames()).toEqual({ API: 'old-aa' })
  // The lead session an attached record names comes up (named) as the lock is taken: that lane is its lead's.
  h.sessions = leadSelfReg()
  putStore([attRec(OTHERLEAD, 'ATT', { leadName: 'old-bb' })])
  h.lockHook = (event) => {
    if (event === 'mkdir') h.sessions = { ...leadSelfReg(), ...cueSession(OTHERLEAD, 'LEADB', PIN, { pid: 4700 }) }
  }
  expect((await claim($)).text).toBe(claimRefusedText('changed'))
  h.lockHook = undefined
  expect(leadNames()).toEqual({ ATT: 'old-bb' })
  // A session that carries the old lead name comes up as the lock is taken: that name is live again, so the lanes are its.
  h.sessions = leadSelfReg()
  putStore([MADE_OLD()])
  h.lockHook = (event) => {
    if (event === 'mkdir') h.sessions = { ...leadSelfReg(), ...regAs(OTHER, 4600, 'old-aa') }
  }
  expect((await claim($)).text).toBe(claimRefusedText('changed'))
  h.lockHook = undefined
  expect(leadNames()).toEqual({ API: 'old-aa' })
  // The leads folder cannot be listed as the lock is taken: nothing is claimed.
  h.sessions = leadSelfReg()
  putStore([MADE_OLD()])
  h.lockHook = (event) => {
    if (event === 'mkdir')
      h.leadsListHook = async () => {
        throw new Error('list')
      }
  }
  expect((await claim($)).text).toBe(claimRefusedText('registry-unreadable'))
  h.lockHook = undefined
  h.leadsListHook = undefined
  expect(leadNames()).toEqual({ API: 'old-aa' })
})

test('stuck lanes: a lead can claim its own attached lanes that still name its old lead name (a re-grant under a new name); lane_list tells them', async ($, on) => {
  await leadAt($, on, [])
  putStore([attRec(SID, 'ATT', { leadName: 'old-bb' })])
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain(CLAIM_HINT(['ATT']))
  h.askAnswer = YES
  expect((await claim($)).text).toBe(claimedText(['ATT'], 'LEAD'))
  expect(leadNames()).toEqual({ ATT: 'LEAD' })
})

test('stuck lanes: a lead renamed only in letter case can claim the lanes it made under the old case', async ($, on) => {
  await leadAt($, on, [], { sess: selfAs('Twin') })
  putStore([MADE_OLD('API', 'Twin')])
  h.sessions = selfAs('TWIN')
  h.askAnswer = YES
  expect((await claim($)).text).toBe(claimedText(['API'], 'TWIN'))
  expect(leadNames()).toEqual({ API: 'TWIN' })
})

test('stuck lanes: a removal whose record was remade or re-pointed at another lead while the question was open removes nothing', async ($, on) => {
  await leadAt($, on, [])
  putStore([GONE_ATT()])
  h.askScript = async () => {
    putStore([GONE_ATT('ATT', { leadName: 'LEAD', lead: OTHERLEAD })])
    return YES
  }
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toContain('changed')
  h.askScript = undefined
  expect(storeJson().lanes.length).toBe(1)
})
