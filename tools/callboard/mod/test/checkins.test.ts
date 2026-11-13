import { expect, test } from 'claude-code/testing'
import { h, NO, PS_TABLE, T0, leadFiles, longTest, resultFiles } from './harness'
import { ANY, LEADPATH, MGR_SESS, MIN, OTHER, OTHERLEAD, OWN_ROW, PIN, QUIET, RESULT, TURN, bareList, checkins, ckLane, ckLead, ckRow, ckText, cueSession, grantAt, idleFor, lane, leadAt, leadCall, leadFileText, leadReg, leadSelfReg, logged, madeLane, mdBox, mgrAt, newTrace, notices, putStore, regAs, sleepFor, started, statusTable, ticks } from './fixtures'

longTest('check-in: a lane quiet 30 min gets one fixed notice from an idle lead, not before; once per since; again after it worked (seen busy twice)', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  await idleFor(28 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
  expect(logged(stdins).filter((x) => x.startsWith('checkin'))).toEqual(['checkin:quiet:1'])
  await idleFor(32 * MIN)
  expect(checkins().length).toBe(1)
  // The lane worked (seen busy at two observations) and went idle again: a new since, told again after 30 min.
  h.sessions = { ...leadSelfReg(), ...ckRow({ status: 'busy', statusUpdatedAt: h.nowMs }) }
  await idleFor(8 * MIN)
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
  await idleFor(28 * MIN)
  expect(checkins().length).toBe(1)
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(QUIET), ckText(QUIET)])
})

test('check-in: a lane waiting on a prompt 5 min is told only once the lead is idle 20 min; lane_list and /callboard lanes show waiting in minutes', async ($, on) => {
  await ckLead($, on, [], { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: T0 })
  await idleFor(12 * MIN)
  expect(checkins()).toEqual([])
  const row = (w: string) => mdBox(ANY, [['API', 'api', 'live', w]])
  expect((await $.command.run(lane('lanes'))).text).toBe(row(`${Math.floor((h.nowMs - T0) / MIN)}m`))
  expect(await bareList($)).toBe(row(`${Math.floor((h.nowMs - T0) / MIN)}m`))
  await idleFor(10 * MIN)
  expect(checkins()).toEqual([ckText('`API` (waiting on a prompt for over 5 min)')])
})

test('check-in: a lane whose session is gone is told', async ($, on) => {
  await ckLead($, on)
  await idleFor(4 * MIN)
  h.sessions = leadSelfReg()
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([ckText('`API` (session gone, report not signed done)')])
})
test('check-in: a lane signed done is not told, quiet or gone; a parked lane and a lane with no saved session never seen live are never gone', async ($, on) => {
  await ckLead($, on, [], {}, [{ name: 'LAB', folder: `${PIN}/lab`, brief: `${PIN}/lab/B.md`, createdAt: 1 }, ckLane(), { ...madeLane('PARKED'), sid: OTHERLEAD, parked: 5 }])
  h.reportFile = { text: `notes\nstatus: done ${OTHER}\n`, mtimeSec: T0 / 1000 }
  await idleFor(36 * MIN)
  expect((await bareList($)).split('\n').filter((l) => l.startsWith('| ↳ ')).map((l) => l.split('|')[1].trim().slice(2))).toEqual(['LAB', 'API', 'PARKED'])
  h.sessions = leadSelfReg()
  await idleFor(20 * MIN)
  expect(checkins()).toEqual([])
})

test('check-in: none within 30 min of a wake (the lanes slept too), then the notice', async ($, on) => {
  await ckLead($, on)
  await idleFor(8 * MIN)
  await sleepFor(30 * MIN)
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

longTest('/callboard checkin: only the person pauses (a fixed refusal otherwise), 1 min to 24 h; status shows it; on ends it; config checkin off stops them', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  const status = async () => (await $.command.run(lane('status'))).text
  expect(await status()).toBe(statusTable(['Lane', 'NONE'], ['Lead', 'ON'], ['Check-ins', 'ON']))
  for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'peer' }, null]) expect((await $.command.run(lane('checkin pause 2h', origin))).text).toBe('Only you can pause check-ins: type /callboard checkin yourself.')
  expect(logged(stdins).filter((x) => x.startsWith('refused:checkin'))).toEqual(['refused:checkin-not-person:plugin', 'refused:checkin-not-person:session', 'refused:checkin-not-person:other'])
  expect(await status()).toBe(statusTable(['Lane', 'NONE'], ['Lead', 'ON'], ['Check-ins', 'ON']))
  await $.command.run(lane('config checkin off'))
  expect((await $.command.run(lane('checkin on'))).text).toBe('Check-ins are on again in this session, but off on this Mac: /callboard config checkin on turns them on.')
  await $.command.run(lane('config checkin on'))
  for (const bad of ['checkin pause 25h', 'checkin pause 0m', 'checkin']) expect((await $.command.run(lane(bad))).text).toBe('Use /callboard checkin pause <N>m or <N>h (1 minute to 24 hours), or /callboard checkin on.')
  expect((await $.command.run(lane('checkin pause 1h'))).text).toBe('Check-ins paused in this session for 60 min.')
  expect(logged(stdins).at(-1)).toBe('checkin-pause:60m:prompt')
  await idleFor(40 * MIN)
  expect(await status()).toMatch(/^\*\*Callboard status\*\*\n\n\| Role \| State \|\n\|---\|---\|\n\| Lane \| NONE \|\n\| Lead \| ON \|\n\| Check-ins \| PAUSED for (19|20|21) more min \|$/)
  expect(checkins()).toEqual([])
  expect((await $.command.run(lane('checkin on'))).text).toBe('Check-ins are on again in this session.')
  expect(await status()).toBe(statusTable(['Lane', 'NONE'], ['Lead', 'ON'], ['Check-ins', 'ON']))
  await $.command.run(lane('config checkin off'))
  await idleFor(8 * MIN)
  expect(await status()).toBe(statusTable(['Lane', 'NONE'], ['Lead', 'ON'], ['Check-ins', 'OFF']))
  expect(checkins()).toEqual([])
  await $.command.run(lane('config checkin on'))
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: not with a draft in the box or a dialog open; owed until they clear', async ($, on) => {
  await ckLead($, on)
  h.draftNow = 'half a sentence'
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([])
  h.draftNow = ''
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const open = $.command.run(lane('off', { kind: 'plugin', name: 'x' }))
  // Under the dialog's own 90 s limit, and past a minute: one observation runs while it is open.
  await h.clock!.advance(64_000)
  expect(checkins()).toEqual([])
  release(NO)
  await open
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: shares the hourly cap with the lanes-changed notice; capped, it stays owed, logged once', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  for (let i = 1; i <= 12; i++) {
    putStore([ckLane()], Array.from({ length: i }, (_, k) => k))
    await h.clock!.advance(2000)
  }
  expect(notices()).toBe(12)
  await idleFor(40 * MIN)
  expect(checkins()).toEqual([])
  expect(logged(stdins).filter((x) => x === 'notice-capped:attention')).toEqual(['notice-capped:attention'])
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: the lead\'s own lane_resume starts what it saw of that lane over', async ($, on) => {
  await ckLead($, on)
  await idleFor(20 * MIN)
  expect((await $.tool.call(leadCall('resume', { lane: 'API' }))).result).toContain('cue resume acted')
  await idleFor(14 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(20 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a lane whose status time moves with no work seen (its own keepalive ping) is told once, not again', async ($, on) => {
  await ckLead($, on)
  await idleFor(32 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
  await idleFor(40 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a subagent\'s or a refused lane_resume leaves what the lead saw of the lane alone', async ($, on) => {
  await ckLead($, on, [], { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: T0 })
  await idleFor(16 * MIN)
  expect(JSON.stringify(await $.tool.call({ ...leadCall('resume', { lane: 'API' }), agentId: 'a1' }))).toContain('for the main agent only')
  h.autoAnswer = 'refused busy'
  expect(JSON.stringify(await $.tool.call(leadCall('resume', { lane: 'API' })))).toContain('lane_resume refused')
  await idleFor(5 * MIN)
  expect(checkins()).toEqual([ckText('`API` (waiting on a prompt for over 5 min)')])
})

test('/callboard checkin outside a lead is refused and stores nothing', async ($, on) => {
  const trace = newTrace()
  await started($, on, [], { trace })
  const writes = trace.log.length
  for (const a of ['checkin pause 1h', 'checkin on']) expect((await $.command.run(lane(a))).text).toBe('Check-ins are for a lead or manager, and this session is neither. Nothing changed.')
  expect(trace.log.slice(writes)).toEqual([])
})

test('check-in: a slow observation never holds the tick: a cue is claimed and answered meanwhile', async ($, on) => {
  await ckLead($, on)
  let release: () => void = () => undefined
  // The first tick reads the lanes once in its own steps, then starts the observation, whose lane read hangs (well inside its 60 s limit below).
  let reads = 0
  h.lanesListHook = () => {
    if (++reads < 2) return Promise.resolve()
    h.lanesListHook = undefined
    return new Promise<void>((r) => (release = r))
  }
  await h.clock!.advance(2000)
  h.cueFile = { ino: 77, text: 'resume\n', present: true, mtimeSec: Math.floor(h.nowMs / 1000) }
  await ticks(4)
  expect(resultFiles.get(RESULT)).toBe('resume refused not-eligible 77\n')
  release()
})

for (const [what, set, logLine, again] of [
  ['throws: its lanes are owed and sent at a later minute', () => { h.submitFails = true }, 'checkin-failed:quiet:1', true],
  ['times out: its lanes stay told', () => { h.submitHangs = true }, 'checkin-unconfirmed:quiet:1', false],
] as const) {
  test(`check-in: a notice whose submit ${what}`, async ($, on) => {
    const stdins: string[] = []
    await ckLead($, on, stdins)
    await idleFor(28 * MIN)
    set()
    await idleFor(4 * MIN)
    await h.clock!.advance(62_000)
    h.submitFails = false
    h.submitHangs = false
    await idleFor(8 * MIN)
    const lines = logged(stdins).filter((x) => x.startsWith('checkin'))
    expect(lines[0]).toBe(logLine)
    expect(lines.includes('checkin:quiet:1')).toBe(again)
    if (!again) expect(lines).toEqual([logLine])
  })
}

test('check-in: /callboard off ends the check-in memory: after lead again, a lane still quiet is told again once its new window passes', async ($, on) => {
  await ckLead($, on)
  await idleFor(32 * MIN)
  expect(checkins().length).toBe(1)
  await $.command.run(lane('off'))
  await grantAt($, PIN)
  await idleFor(28 * MIN)
  expect(checkins().length).toBe(1)
  await idleFor(8 * MIN)
  expect(checkins().length).toBe(2)
})

test('check-in: a plain session and a bound lane never get one', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { clock: true, bound: true, seed: () => putStore([ckLane()]) })
  h.sessions = { ...OWN_ROW(), ...ckRow() }
  await $.turn.complete(TURN as any)
  await idleFor(40 * MIN)
  await $.command.run(lane('lane off'))
  await idleFor(40 * MIN)
  expect(checkins()).toEqual([])
  expect(logged(stdins).filter((x) => x.startsWith('checkin'))).toEqual([])
})

test('check-in: quiet reads the signature of the live session: a report signed by an older session of the lane does not hide it', async ($, on) => {
  const NEWSID = '8a1b2c3d-0000-4000-8000-123456789abc'
  await ckLead($, on, [], undefined)
  h.sessions = { ...leadSelfReg(), ...cueSession(NEWSID, 'API', `${PIN}/api`, { pid: 4500 }) }
  h.reportFile = { text: `notes\nstatus: done ${OTHER}\n`, mtimeSec: T0 / 1000 }
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a minute with no usable lead name neither rebuilds what the lead saw nor forgets what it was told', async ($, on) => {
  await ckLead($, on, [], {}, [ckLane({ leadName: 'LEAD' })])
  await idleFor(32 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
  // A twin row in another letter case voids the lead's name for a while.
  h.sessions = { ...leadSelfReg(), ...ckRow(), ...regAs(OTHERLEAD, 4600, 'lead') }
  await idleFor(8 * MIN)
  h.sessions = { ...leadSelfReg(), ...ckRow() }
  await idleFor(36 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a lead that never had a name is still checked in on for a legacy lane', async ($, on) => {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg({ name: undefined }), ...ckRow() }, seed: () => putStore([ckLane()]) })
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  await idleFor(32 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('check-in: a status change after only 10 min of quiet starts the quiet window again', async ($, on) => {
  await ckLead($, on)
  await idleFor(10 * MIN)
  h.sessions = { ...leadSelfReg(), ...ckRow({ statusUpdatedAt: h.nowMs }) }
  await idleFor(26 * MIN)
  expect(checkins()).toEqual([])
  await idleFor(8 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('manager check-ins: only lanes no live lead reaches are told; a lane a lead reaches is told once that lead is gone', async ($, on) => {
  await mgrAt($, on, [], { clock: true, sess: { ...MGR_SESS({ name: 'MANAGER' }), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  await idleFor(32 * MIN)
  expect(checkins()).toEqual([ckText('`LABLANE` (quiet for 30 min, report not signed done)')])
  leadFiles.delete(LEADPATH)
  h.sessions = MGR_SESS({ name: 'MANAGER' })
  await idleFor(24 * MIN)
  expect(checkins()).toEqual([ckText('`LABLANE` (quiet for 30 min, report not signed done)'), ckText(QUIET)])
})
