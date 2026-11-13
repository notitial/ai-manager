import { expect, test } from 'claude-code/testing'
import { LANES_CHANGED_NOTE, REASON_TEXT, terminateQuestion, removeQuestion } from '../hooks/core'
import { h, NO, PS_TABLE, REPORT, ROOT, SID, T0, YES, headArgs, killedPids, laneSeed, leadFiles, longTest, psCalls, resultFiles, submitted, teeTexts, toasts, toolDefs } from './harness'
import { APISID, ATTSESS, GONE_ATT, HOME, HOOK_BUDGET_MS, LEADPS, LEAD_LANES, MGR_NOAPI, NEWSID, OTHER, OTHERLEAD, PARK_API, PIN, REG, REGFILE, REPORT_OK, SELFREG, SVC, allEvents, armNow, attRec, attacher, ckLane, closeWrites, condOn, cue, cueSession, doLane, events, grantAt, killed, lane, lead, leadAt, leadCall, leadSelfReg, logged, mgrAt, mgrCall, newTrace, noArchiveRm, park, parkSess, parker, putStore, recOf, renameThroughTick, retireCue, retireTarget, settle, sleeps, started, storeJson, storeNames, unanswered } from './fixtures'

test('the stop dialog is decided only by its own label: Allow, Deny and free text stop nothing', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  for (const a of ['Allow', 'Deny', 'stop session', 'Stop', '']) {
    h.askAnswer = a
    expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('did not confirm')
  }
  expect(argv.some((x) => x[0] === '/bin/kill')).toBe(false)
})

test('lane_terminate asks the person every time and signals only a verified process', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  for (const a of ['Cancel', 'terminate', '']) {
    h.askAnswer = a
    expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('did not confirm')
  }
  expect(killed(argv).length).toBe(0)
  h.askAnswer = 'Force stop'
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('pid-changed')
  expect(killed(argv).length).toBe(0)
  h.psOut = 'Tue Oct 27 20:37:50 2026\n'
  expect((await $.tool.call(leadCall('terminate'))).result).toContain('SIGTERM sent to process 4242')
  expect(h.psEnv).toEqual({ TZ: 'UTC', LC_ALL: 'C' })
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('terminating:LABLANE')
})

// The dialog stays open while the test changes the world; then the person clicks Force stop.
async function terminateDuring($: any, change: () => void | Promise<void>, call = leadCall('terminate')) {
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const p = $.tool.call(call)
  await new Promise((r) => setTimeout(r, 20))
  await change()
  release(YES)
  const out = JSON.stringify(await p)
  h.askHang = undefined
  return out
}

test('the stop dialog names the process: short session id and pid; one click sends exactly one signal to that pid', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  expect(await terminateDuring($, () => undefined)).toContain('SIGTERM sent to process 4242')
  expect(h.lastQuestion).toBe(`Force stop lane LABLANE's session (${OTHER.slice(0, 8)}, pid 4242)? It ends at once, even mid-task. The lane's record is then removed.`)
  expect(h.lastQuestion).toBe(terminateQuestion('LABLANE', OTHER, 4242, undefined, true))
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  expect(logged(stdins)).toContain('terminating:LABLANE')
})

test('lane_terminate: a click after /callboard off does not stop the session', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  const out = await terminateDuring($, async () => {
    expect((await $.command.run(lane('off'))).text).toContain('off')
  })
  expect(out).toContain('lead tools are off')
  expect(killed(argv).length).toBe(0)
  expect(logged(stdins)).toContain('refused:lead-off')
  expect(logged(stdins)).not.toContain('terminating:LABLANE')
})

test('lane_terminate: a lane that was removed or detached during the dialog is not stopped', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  expect(await terminateDuring($, () => { laneSeed.text = JSON.stringify({ lanes: [] }) })).toContain('unknown-lane')
  expect(killed(argv).length).toBe(0)
  laneSeed.text = LEAD_LANES('/data/x/work')
  expect((await $.tool.call(leadCall('terminate'))).result).toContain('SIGTERM sent to process 4242')
  expect(killed(argv).length).toBe(1)
})

test('lane_terminate: an attached lane that was detached during the dialog is not stopped', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...ATTSESS() }, argv })
  putStore([attRec(OTHERLEAD)])
  expect(await terminateDuring($, () => putStore([]), leadCall('terminate', { lane: 'ATT' }))).toContain('unknown-lane')
  expect(killed(argv).length).toBe(0)
})

test('lane_terminate: a /clear during the dialog (same pid and start time, new session id) is not stopped', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  const out = await terminateDuring($, () => { h.sessions = cueSession('2a1b2c3d-0000-4000-8000-123456789abc', 'LABLANE') })
  expect(out).toContain('session-changed')
  expect(out).toContain('No signal was sent')
  expect(killed(argv).length).toBe(0)
})

test('lane_terminate: a pid, a start time or a second registry entry that changed during the dialog is not stopped', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  expect(await terminateDuring($, () => { h.sessions = cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { pid: 4243 }) })).toContain('session-changed')
  h.sessions = cueSession(OTHER, 'LABLANE')
  expect(await terminateDuring($, () => { h.sessions = cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { procStart: 'Wed Oct 28 01:00:00 2026' }) })).toContain('session-changed')
  h.sessions = cueSession(OTHER, 'LABLANE')
  expect(await terminateDuring($, () => { h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(OTHER, 'ELSEWHERE', '/data/x/work/lab', { pid: 4244 }) } })).toContain('session-changed')
  h.sessions = cueSession(OTHER, 'LABLANE')
  expect(await terminateDuring($, () => { h.sessions = {} })).toContain('no-live-session')
  h.sessions = cueSession(OTHER, 'LABLANE')
  expect(await terminateDuring($, () => { h.psOut = 'Wed Oct 28 01:00:00 2026\n' })).toContain('pid-changed')
  expect(killed(argv).length).toBe(0)
})

test('lane_terminate: a doubled session id or a pid that is not a live claude process is refused before the dialog is asked', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  const before = h.askCount
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(OTHER, 'ELSEWHERE', '/data/x/work/lab', { pid: 4244 }) }
  const dup = JSON.stringify(await $.tool.call(leadCall('terminate')))
  expect(dup).toContain('session-duplicate')
  expect(dup).toContain('No signal was sent')
  h.sessions = cueSession(OTHER, 'LABLANE')
  h.psArgsOut = '/usr/bin/vim /tmp/notes\n'
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('not-claude')
  h.psArgsOut = '/x/native-binary/claude --output-format stream-json\n'
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('pid-changed')
  expect(h.askCount).toBe(before)
  expect(killed(argv).length).toBe(0)
  expect(toasts.some((t) => t.includes('not sent'))).toBe(false)
})

test('lane_retire: a doubled session id is refused before the cue is sent', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  h.reportFile = REPORT_OK()
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(OTHER, 'ELSEWHERE', '/data/x/work/lab', { pid: 4244 }) }
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('session-duplicate')
  expect(stdins).not.toContain('retire\n')
  expect(killed(argv).length).toBe(0)
})

test('lane_terminate: a refused click toasts the code; Cancel and a good click toast no "not sent"', async ($, on) => {
  await lead($, on, [])
  expect(await terminateDuring($, async () => { await $.command.run(lane('off')) })).toContain('lead tools are off')
  expect(toasts).toContain('Force stop not sent: off')
  toasts.length = 0
  await grantAt($, '/data/x/work/lab')
  expect(await terminateDuring($, () => { h.sessions = cueSession('2a1b2c3d-0000-4000-8000-123456789abc', 'LABLANE') })).toContain('session-changed')
  expect(toasts).toContain('Force stop not sent: session-changed')
  toasts.length = 0
  h.sessions = cueSession(OTHER, 'LABLANE')
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('did not confirm')
  h.askAnswer = YES
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('SIGTERM sent')
  expect(toasts.some((t) => t.includes('not sent'))).toBe(false)
})

test('a stop that sent the signal asks the VS Code window to close the dead tab: one .close request with session id, pid and lane name', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  h.reportFile = REPORT_OK()
  h.askAnswer = YES
  expect((await $.tool.call(leadCall('retire'))).result).toContain('SIGTERM sent')
  let w = closeWrites(argv)
  expect(w.length).toBe(1)
  expect(w[0][w[0].length - 1]).toBe(`${ROOT}/open/LABLANE.close`)
  expect(teeTexts.get(w[0][3])).toBe(`${OTHER}\n4242\nLABLANE\n`)
  expect(logged(stdins)).toContain('close-requested:LABLANE')
  // The retire removed the lane's record: seed it again for the stop that follows.
  laneSeed.text = LEAD_LANES('/data/x/work')
  killedPids.clear()
  expect((await $.tool.call(leadCall('terminate'))).result).toContain('SIGTERM sent')
  w = closeWrites(argv)
  expect(w.length).toBe(2)
  expect(teeTexts.get(w[1][3])).toBe(`${OTHER}\n4242\nLABLANE\n`)
})

test('a stop whose kill exits non-zero writes no close request', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  h.reportFile = REPORT_OK()
  h.askAnswer = YES
  h.killFails = true
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('the signal failed')
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('the signal failed')
  expect(killed(argv).length).toBe(2)
  expect(closeWrites(argv).length).toBe(0)
  expect(logged(stdins)).not.toContain('close-requested:LABLANE')
  h.killFails = false
  expect((await $.tool.call(leadCall('retire'))).result).toContain('SIGTERM sent')
  expect(closeWrites(argv).length).toBe(1)
})

test('a stop that sent no signal writes no close request', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.fastSleep = () => undefined
  h.sessions = retireOk({ status: 'busy' })
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('not-idle')
  h.sessions = retireOk()
  h.autoAnswer = 'held draft-in-box'
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('draft-in-box')
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('did not confirm')
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  h.askAnswer = YES
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('pid-changed')
  expect(closeWrites(argv).length).toBe(0)
  expect(killed(argv).length).toBe(0)
})

test('lane_terminate refuses the same targets as the cue tools', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.askAnswer = 'Force stop'
  await grantAt($, '/elsewhere')
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('other-repo')
  await grantAt($, '/data/x/work/lab')
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession('2a1b2c3d-0000-4000-8000-123456789abc', 'LABLANE', '/data/x/work/lab', { pid: 4243 }) }
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('ambiguous')
  expect(JSON.stringify(await $.tool.call({ ...leadCall('terminate'), agentId: 'a1' }))).toContain('main agent only')
  expect(killed(argv).length).toBe(0)
})

test('lane_retire does nothing unless the session is idle and has signed its report', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  h.askAnswer = 'Cancel'
  // A busy or waiting session is waited for up to 40 s (virtual here) before the refusal.
  h.fastSleep = () => undefined
  const retire = async () => JSON.stringify(await $.tool.call(leadCall('retire')))
  const refused: [string, () => void][] = [
    ['report-missing', () => { h.reportFile = undefined }],
    ['report-not-done', () => { h.reportFile = { text: 'status: done 9a1b2c3d-0000-4000-8000-123456789abc\n', mtimeSec: (T0 - 1000) / 1000 } }],
    ['report-not-done', () => { h.reportFile = { text: `status: done ${OTHER}\nmore work after\n`, mtimeSec: (T0 - 1000) / 1000 } }],
    ['report-file', () => { h.reportFile = REPORT_OK(); h.reportGrown = 'x'.repeat(1_048_577) }],
    ['report-file', () => { h.reportFile = REPORT_OK(); h.headFails = true }],
    ['report-old', () => { h.reportFile = { ...REPORT_OK(), mtimeSec: (T0 - 7_200_000) / 1000 } }],
    ['not-idle', () => { h.reportFile = REPORT_OK(); h.sessions = cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { status: 'busy' }) }],
    ['not-idle', () => { h.sessions = cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { waitingFor: 'input' }) }],
    ['not-idle', () => { h.sessions = cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { status: 'waiting' }) }],
    ['pid-changed', () => { h.sessions = cueSession(OTHER, 'LABLANE'); h.psOut = 'Wed Oct 28 01:00:00 2026\n' }],
    // A lane no live session carries is no refusal (its record is removed): the sessionless tests below cover it.
    ['not-claude', () => { h.psOut = 'Tue Oct 27 20:37:50 2026\n'; h.sessions = cueSession(OTHER, 'LABLANE'); h.psArgsOut = '/usr/bin/vim /tmp/notes\n' }],
  ]
  for (const [why, setup] of refused) {
    h.reportGrown = undefined
    h.headFails = false
    setup()
    const out = await retire()
    expect(out).toContain(why)
    if (why === 'not-idle') expect(out).toContain('do not loop')
    else expect(out).not.toContain('do not loop')
  }
  h.reportGrown = undefined
  h.headFails = false
  expect(new Set(headArgs)).toEqual(new Set(['1048577']))
  expect(killed(argv).length).toBe(0)
  h.psOut = 'Tue Oct 27 20:37:50 2026\n'
  h.psArgsOut = 'claude --resume LABLANE\n'
  expect((await $.tool.call(leadCall('retire'))).result).toContain('SIGTERM sent to process 4242')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('retiring:LABLANE')
})

test('lane_retire needs the lead in the lane repo', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  await grantAt($, '/elsewhere')
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('other-repo')
  expect(killed(argv).length).toBe(0)
})

// ---- retire is confirmed by the target, then the lead signals ----
const retireOk = (extra: Record<string, unknown> = {}) => cueSession(OTHER, 'LABLANE', '/data/x/work/lab', extra)

test('lane_retire sends a retire cue first and signals once, only on the target\'s ok', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  h.reportFile = REPORT_OK()
  h.askAnswer = NO
  expect((await $.tool.call(leadCall('retire'))).result).toContain('SIGTERM sent to process 4242')
  expect(stdins).toContain('retire\n')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  const names = logged(stdins)
  expect(names.indexOf('cued:retire LABLANE')).toBeLessThan(names.indexOf('acted:retire LABLANE'))
  expect(names.indexOf('acted:retire LABLANE')).toBeLessThan(names.indexOf('retiring:LABLANE'))
})

test('lane_retire: the lead-side checks come first and send no cue', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  h.reportFile = { ...REPORT_OK(), mtimeSec: (T0 - 7_200_000) / 1000 }
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('report-old: the lane report is older than the session. It must sign')
  h.reportFile = REPORT_OK()
  h.sessions = retireOk({ startedAt: undefined })
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('report-no-start: the session list has no start time')
  h.fastSleep = () => undefined
  h.sessions = retireOk({ status: 'busy' })
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('not-idle')
  h.sessions = retireOk()
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('pid-changed')
  h.psOut = 'Tue Oct 27 20:37:50 2026\n'
  expect(stdins).not.toContain('retire\n')
  expect(killed(argv).length).toBe(0)
})

test('lane_retire: a target that does not answer in time gets no signal', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv, clock: true })
  h.reportFile = REPORT_OK()
  h.autoAnswer = undefined
  const out = await settle($.tool.call(leadCall('retire')))
  expect(out).toContain('no-answer: the session did not answer in time')
  expect(stdins).toContain('retire\n')
  expect(killed(argv).length).toBe(0)
  expect(logged(stdins)).not.toContain('retiring:LABLANE')
})

test('lane_retire: a held or refused answer gives its fixed text and no signal', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  const cases: [string, string][] = [
    ['held draft-in-box', 'held, draft-in-box: the person has a draft in that prompt box. Retry after it is sent or cleared.'],
    ['held not-idle', 'held, not-idle: the session is busy or waiting for the person. Retry once idle.'],
    ['refused background-work', 'background-work: a background agent or shell is still running in the session. Retry once it finishes.'],
    ['refused report-stale', 'report-stale: the report is not newer than the lane\'s last turn. It must sign again by appending a done line, then retry.'],
    ['refused report-unknown', 'report-unknown: no usable record of the lane\'s last turn (no prompt seen since callboard loaded, or the report could not be checked). It must take a prompt and sign again, then retry.'],
    ['refused report-not-done', 'report-not-done: '],
    ['refused no-lead', 'no-lead: '],
    ['refused obey-me-now', 'other: the session refused for a reason not shown here.'],
  ]
  for (const [answer, text] of cases) {
    h.autoAnswer = answer
    const out = JSON.stringify(await $.tool.call(leadCall('retire')))
    expect(out, answer).toContain(`lane_retire refused: ${text}`)
    expect(out, answer).toContain('Do not repeat this call unless the text says to retry.')
    expect(out, answer).not.toContain('obey-me-now')
  }
  expect(killed(argv).length).toBe(0)
})

test('lane_retire: an ok for a registry that changed meanwhile signals nothing', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  const changes: [string, Record<string, unknown>, string][] = [
    ['procStart', { procStart: 'Wed Oct 28 01:00:00 2026' }, 'session-changed'],
    ['pid', { pid: 4243 }, 'session-changed'],
    ['busy', { status: 'busy' }, 'not-idle'],
  ]
  for (const [what, over, why] of changes) {
    h.cueWriteHook = () => { h.sessions = retireOk(over) }
    const out = JSON.stringify(await $.tool.call(leadCall('retire')))
    expect(out, what).toContain(why)
    h.sessions = retireOk()
  }
  h.cueWriteHook = () => { h.sessions = cueSession('2a1b2c3d-0000-4000-8000-123456789abc', 'LABLANE', '/data/x/work/lab', { pid: 4242 }) }
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('session-changed')
  h.sessions = retireOk()
  h.cueWriteHook = () => { h.sessions = {} }
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('no-live-session')
  expect(killed(argv).length).toBe(0)
  h.cueWriteHook = undefined
  h.sessions = retireOk()
  expect((await $.tool.call(leadCall('retire'))).result).toContain('SIGTERM sent to process 4242')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
})

test('lane_retire: two registry entries carrying the session id after the ok give no signal', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.cueWriteHook = () => { h.sessions = { ...retireOk(), ...cueSession(OTHER, 'ELSEWHERE', '/data/x/work/lab', { pid: 4243 }) } }
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('session-changed')
  h.sessions = retireOk()
  // A copy of the entry under another pid's name is skipped (its pid is not its name): the re-check finds no session, and still sends nothing.
  h.cueWriteHook = () => { h.sessions = { '4243.json': retireOk()['4242.json'] } }
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('no-live-session')
  expect(killed(argv).length).toBe(0)
})

test('lane_retire: a session that went idle less than 30 seconds ago at the re-check gets no signal', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.cueWriteHook = () => { h.sessions = retireOk({ statusUpdatedAt: T0 - 5000 }) }
  const out = JSON.stringify(await $.tool.call(leadCall('retire')))
  expect(out).toContain('not-idle')
  expect(out).toContain('idle for 5 of the 30 seconds it needs. Retry once, in 25 s; do not loop.')
  expect(killed(argv).length).toBe(0)
})

// ---- lane_retire and lane_park wait for the lane's idle time themselves ----
test('lane_retire waits for the 30 s idle time itself: a lane idle for 5 s is retired once the time is up, with no refusal', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.askAnswer = NO
  h.sessions = retireOk({ statusUpdatedAt: h.nowMs - 5000 })
  const slept: number[] = []
  h.fastSleep = (ms) => void slept.push(ms)
  expect((await $.tool.call(leadCall('retire'))).result).toContain('SIGTERM sent to process 4242')
  expect(slept.filter((ms) => ms === 2000).length).toBe(13)
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
})

test('lane_retire and lane_park on a lane idle for 30 s or more wait for nothing', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.askAnswer = NO
  const slept: number[] = []
  h.fastSleep = (ms) => void slept.push(ms)
  h.sessions = retireOk({ statusUpdatedAt: h.nowMs - 30_000 })
  expect((await $.tool.call(leadCall('retire'))).result).toContain('SIGTERM sent to process 4242')
  expect(slept.filter((ms) => ms === 2000)).toEqual([])
})

test('lane_retire on a lane that stays busy refuses after 40 s, once, with the busy words and no cue', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  h.reportFile = REPORT_OK()
  const t0 = h.nowMs
  h.sessions = retireOk({ status: 'busy' })
  const slept: number[] = []
  h.fastSleep = (ms) => void slept.push(ms)
  const out = JSON.stringify(await $.tool.call(leadCall('retire')))
  expect(out).toContain('not-idle: the session is busy or waiting for the person. Retry once it is idle for 30 seconds; do not loop.')
  expect(slept.filter((ms) => ms === 2000).length).toBe(20)
  expect(h.nowMs - t0).toBe(40_000)
  expect(stdins).not.toContain('retire\n')
  expect(killed(argv).length).toBe(0)
})

test('lane_retire on a lane that went idle only just before the wait ended refuses naming the seconds left', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.sessions = retireOk({ status: 'busy' })
  let total = 0
  h.fastSleep = (ms) => {
    total += ms
    if (total === 38_000) h.sessions = retireOk({ statusUpdatedAt: h.nowMs })
  }
  const out = JSON.stringify(await $.tool.call(leadCall('retire')))
  expect(out).toContain('not-idle: the session has been idle for 2 of the 30 seconds it needs. Retry once, in 28 s; do not loop.')
  expect(killed(argv).length).toBe(0)
})

test('lane_retire: a lane that turns idle while the call waits is retired at once, and the cue gets its own full answer wait', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.askAnswer = NO
  h.sessions = retireOk({ status: 'busy' })
  let total = 0
  h.fastSleep = (ms) => {
    total += ms
    if (total === 8000) h.sessions = retireOk({ statusUpdatedAt: h.nowMs - 31_000 })
  }
  expect((await $.tool.call(leadCall('retire'))).result).toContain('SIGTERM sent to process 4242')
  expect(total).toBeGreaterThanOrEqual(8000)
  expect(total).toBeLessThan(10_000)
})

test('lane_retire: the session must stay the same process while the call waits (session-changed), and an off meanwhile ends it (grant-changed)', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  h.reportFile = REPORT_OK()
  h.sessions = retireOk({ status: 'busy' })
  h.fastSleep = () => void (h.sessions = retireOk({ status: 'busy', pid: 4243 }))
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('session-changed')
  h.sessions = retireOk({ status: 'busy' })
  h.fastSleep = async () => void (await $.command.run(lane('off')))
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('grant-changed')
  expect(stdins).not.toContain('retire\n')
  expect(killed(argv).length).toBe(0)
})

test('lane_terminate never waits for idleness: a busy lane gets its dialog at once', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.sessions = retireOk({ status: 'busy' })
  h.askAnswer = NO
  const slept: number[] = []
  h.fastSleep = (ms) => void slept.push(ms)
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('did not confirm')
  expect(slept.filter((ms) => ms === 2000)).toEqual([])
})

longTest('lane_park waits for the idle time too: a lane idle for 5 s is parked after 25 polls; a busy one is refused after 40', async ($, on) => {
  const argv: string[][] = []
  await parker($, on, [], argv)
  const slept: number[] = []
  h.fastSleep = (ms) => void slept.push(ms)
  h.sessions = parkSess({ statusUpdatedAt: h.nowMs - 5000 })
  expect((await park($)).result).toContain('lane API parked')
  expect(slept.filter((ms) => ms === 2000).length).toBe(13)
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4500']])
  slept.length = 0
  putStore([PARK_API({ sid: OTHER })])
  h.sessions = parkSess({ status: 'busy' })
  expect(JSON.stringify(await park($))).toContain('do not loop')
  expect(slept.filter((ms) => ms === 2000).length).toBe(20)
  expect(killed(argv).length).toBe(1)
})

longTest('lane_retire waits for its answer 10 seconds from the cue write; the other cue tools keep 6 seconds from the call', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv, clock: true })
  h.reportFile = REPORT_OK()
  h.autoAnswer = undefined
  const p = $.tool.call(leadCall('retire'))
  for (let i = 0; i < 14; i++) await h.clock!.advance(500)
  resultFiles.set(`${ROOT}/result/${OTHER}.result`, 'retire ok - 12\n')
  for (let i = 0; i < 4; i++) await h.clock!.advance(500)
  expect((await p).result).toContain('SIGTERM sent to process 4242')
  expect(killed(argv).length).toBe(1)
  // The retire removed the lane's record: seed it again for the cues that follow.
  laneSeed.text = LEAD_LANES('/data/x/work')
  killedPids.clear()
  const q = $.tool.call(leadCall('resume'))
  for (let i = 0; i < 14; i++) await h.clock!.advance(500)
  expect(JSON.stringify(await q)).toContain('no-answer')
  h.autoAnswer = undefined
  const r = $.tool.call(leadCall('retire'))
  for (let i = 0; i < 26; i++) await h.clock!.advance(500)
  expect(JSON.stringify(await r)).toContain('no-answer')
  expect(killed(argv).length).toBe(1)
})

test('two parallel lane_retire calls to one lane take turns: the second does not send a cue while the first waits', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv, clock: true })
  h.reportFile = REPORT_OK()
  h.autoAnswer = undefined
  const cues = () => argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === `${ROOT}/cue/${OTHER}.cue`).length
  const first = $.tool.call(leadCall('retire'))
  const second = $.tool.call(leadCall('retire'))
  for (let i = 0; i < 26; i++) await h.clock!.advance(500)
  expect(JSON.stringify(await first)).toContain('no-answer')
  expect(JSON.stringify(await second)).toContain('cue-busy')
  expect(cues()).toBe(1)
  expect(killed(argv).length).toBe(0)
})

test('lane_terminate sends no cue: the person confirms it', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins)
  h.askAnswer = 'Force stop'
  await $.tool.call(leadCall('terminate'))
  expect(stdins).not.toContain('retire\n')
})

test('a retire cue is confirmed by the target when it is idle, has no draft, no background agents and a report newer than its last prompt', async ($, on) => {
  const stdins: string[] = []
  await retireTarget($, on, stdins)
  h.agentsNow = [{ status: 'completed' }, { status: 'failed' }]
  expect(await retireCue(90)).toBe('retire ok - 90\n')
  expect(logged(stdins)).toContain('retire-confirmed:LABLANE')
  expect(submitted).toEqual(['work on it'])
})

test('a retire cue is claimed on a tick whose request step threw, and a retire that cannot list agents is refused other, never ok', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  const trace = newTrace()
  await retireTarget($, on, stdins, trace, argv)
  armNow(trace)
  h.agentListThrows = true
  expect(await retireCue(140)).toBe('retire refused other 140\n')
  expect(logged(stdins)).toContain('error:request')
  expect(logged(stdins)).not.toContain('retire-confirmed:LABLANE')
  expect(argv.some((a) => a[0] === '/bin/kill')).toBe(false)
})

test('a retire cue is held on a draft in the box and on a session that is not idle', async ($, on) => {
  await retireTarget($, on)
  h.draftNow = 'half a sentence'
  expect(await retireCue(91)).toBe('retire held draft-in-box 91\n')
  h.draftNow = ''
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  expect(await retireCue(92)).toBe('retire held not-idle 92\n')
  h.sessions = { [REGFILE]: REG({ waitingFor: 'input' }) }
  expect(await retireCue(93)).toBe('retire held not-idle 93\n')
  h.sessions = SELFREG()
  expect(await retireCue(94)).toBe('retire ok - 94\n')
})

test('a retire cue is refused while a background shell runs under the session, whatever its flags; other children do not count', async ($, on) => {
  await retireTarget($, on)
  expect(await retireCue(130)).toBe('retire ok - 130\n')
  for (const cmd of ['/bin/zsh -c source /x/shell-snapshots/snapshot-zsh-1.sh && eval sleep 150', '/bin/bash -c sleep 90', '/bin/sh -c sleep 90', 'zsh -c sleep 5', '/usr/bin/zsh -l -c sleep 5', '/bin/zsh -lc sleep 5', '/bin/bash -ec sleep 5', '/usr/bin/env bash -c sleep 5', 'env FOO=1 -i /bin/sh -c x', 'dash -c sleep 5', '/bin/ksh -c x', '/opt/homebrew/bin/fish -c x', '/bin/zsh', '/bin/zsh -i', 'sh']) {
    h.psTable = `${PS_TABLE} 4400  4300 ${cmd}\n`
    expect(await retireCue(131), cmd).toBe('retire refused background-work 131\n')
  }
  for (const cmd of ['/usr/local/bin/zshrc-tool -c x', 'node /x/bash -c x', '/usr/local/sh-tools/runner --x', '/opt/fish-tools/bin/node x', '/usr/bin/env node x', '/usr/bin/env', '/usr/bin/caffeinate -i']) {
    h.psTable = `${PS_TABLE} 4400  4300 ${cmd}\n`
    expect(await retireCue(132), cmd).toBe('retire ok - 132\n')
  }
  h.psTable = `${PS_TABLE} 4400  4311 /bin/zsh -c sleep 90\n 4403  4999 /bin/zsh -c sleep 90\n`
  expect(await retireCue(133)).toBe('retire ok - 133\n')
})

test('the process query is narrowed to the children of the session: the pid table first, then only those pids', async ($, on) => {
  await retireTarget($, on)
  psCalls.length = 0
  expect(await retireCue(150)).toBe('retire ok - 150\n')
  expect(psCalls).toEqual(['-A -o pid=,ppid=,comm=', '-o pid=,ppid=,command= -p 4310,4311'])
  h.psTable = '    1     0 /sbin/launchd\n 4300     1 /x/native-binary/claude --resume LABLANE\n 4311     1 /usr/bin/caffeinate -i\n'
  psCalls.length = 0
  expect(await retireCue(151)).toBe('retire ok - 151\n')
  expect(psCalls).toEqual(['-A -o pid=,ppid=,comm='])
  h.psTable = PS_TABLE + Array.from({ length: 501 }, (_, i) => ` ${5000 + i}  4300 /usr/bin/true`).join('\n') + '\n'
  expect(await retireCue(152)).toBe('retire refused background-unknown 152\n')
})

test('the ps that lists the processes is a child of the session too: it is skipped, so a session with no other child still retires', async ($, on) => {
  await retireTarget($, on)
  const bare = '    1     0 /sbin/launchd\n 4300     1 /x/native-binary/claude --resume LABLANE\n'
  h.psTable = `${bare} 4500  4300 /bin/ps -A -o pid=,ppid=,comm=\n`
  psCalls.length = 0
  expect(await retireCue(160)).toBe('retire ok - 160\n')
  expect(psCalls).toEqual(['-A -o pid=,ppid=,comm='])
  h.psTable = `${PS_TABLE} 4500  4300 /bin/ps -A -o pid=,ppid=,comm=\n`
  expect(await retireCue(161)).toBe('retire ok - 161\n')
  h.psTable = `${bare} 4500  4300 /bin/ps -A -o pid=,ppid=,comm=\n 4400  4300 /bin/zsh -c sleep 150\n`
  expect(await retireCue(162)).toBe('retire refused background-work 162\n')
})

test('a retire cue fails closed when the session cannot be found in the process table', async ($, on) => {
  await retireTarget($, on)
  h.sessions = {}
  expect(await retireCue(133)).toBe('retire refused background-unknown 133\n')
  // Two entries carrying the session id: registryOf answers none (exactly one, as attach), so the retire is held before the process table is read.
  h.sessions = { ...SELFREG(), '4301.json': REG({ pid: 4301, procStart: 'Tue Oct 27 20:37:50 2026' }) }
  expect(await retireCue(134)).toBe('retire held registry-unreadable 134\n')
  h.sessions = SELFREG({ procStart: 'Wed Oct 28 01:00:00 2026' })
  expect(await retireCue(135)).toBe('retire refused background-unknown 135\n')
  // An entry with no pid, or under another pid's name, is not the session's own entry: the session is not in the registry, so the retire is held there.
  h.sessions = SELFREG({ pid: undefined })
  expect(await retireCue(136)).toBe('retire held registry-unreadable 136\n')
  h.sessions = { '4999.json': SELFREG()['4300.json'] }
  expect(await retireCue(137)).toBe('retire held registry-unreadable 137\n')
  h.sessions = SELFREG()
  h.psTableFails = true
  expect(await retireCue(138)).toBe('retire refused background-unknown 138\n')
  h.psTableFails = false
  h.psRowsFail = true
  expect(await retireCue(142)).toBe('retire refused background-unknown 142\n')
  h.psRowsFail = false
  h.psTable = '    1     0 /sbin/launchd\n'
  expect(await retireCue(139)).toBe('retire refused background-unknown 139\n')
  h.psTable = PS_TABLE
  h.psOversize = true
  expect(await retireCue(140)).toBe('retire refused background-unknown 140\n')
  h.psOversize = false
  expect(await retireCue(141)).toBe('retire ok - 141\n')
})

test('a retire cue is refused while a background agent is running', async ($, on) => {
  await retireTarget($, on)
  for (const status of ['pending', 'running', 'waiting']) {
    h.agentsNow = [{ status }]
    expect(await retireCue(95)).toBe('retire refused background-work 95\n')
  }
  h.agentsNow = []
  expect(await retireCue(96)).toBe('retire ok - 96\n')
})

test('a retire cue is refused report-stale once the session took another prompt after it signed', async ($, on) => {
  await retireTarget($, on)
  expect(await retireCue(97)).toBe('retire ok - 97\n')
  await $.prompt.submit({ text: 'one more thing' } as any)
  expect(await retireCue(98)).toBe('retire refused report-stale 98\n')
  h.reportFile = { text: `${h.reportFile!.text}status: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(1000)
  expect(await retireCue(99)).toBe('retire ok - 99\n')
})

test('a prompt the mod submitted itself (the hook sees it as its own) also makes the report stale', async ($, on) => {
  await retireTarget($, on)
  await cue(100, 'resume\n')
  expect(submitted.length).toBe(2)
  await h.clock!.advance(1000)
  await $.prompt.submit({ text: submitted[1] } as any)
  expect(await retireCue(101)).toBe('retire refused report-stale 101\n')
})

test('a retire cue is refused report-unknown when no prompt was ever seen, because the signature cannot be shown to be last', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  h.sessions = SELFREG()
  h.reportFile = { text: `status: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(102)).toBe('retire refused report-unknown 102\n')
})

test('a prompt taken before the session was bound records no report size: the signature is unknown until the next turn', async ($, on) => {
  await renameThroughTick($, on, [], 1, undefined, async () => {
    await $.prompt.submit({ text: 'before the lane' } as any)
    await h.clock!.advance(1000)
  })
  h.sessions = SELFREG()
  await h.clock!.advance(1000)
  h.reportFile = { text: `status: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(110)).toBe('retire refused report-unknown 110\n')
  await $.prompt.submit({ text: 'now a lane' } as any)
  await h.clock!.advance(1000)
  h.reportFile = { text: `${h.reportFile.text}status: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(111)).toBe('retire ok - 111\n')
})

test('a turn that starts without a prompt (a wake, a queued message) makes an earlier signature stale; a subagent turn does not', async ($, on) => {
  await retireTarget($, on)
  expect(await retireCue(112)).toBe('retire ok - 112\n')
  await h.clock!.advance(1000)
  await $.turn.start({ turnId: 't9', agentId: 'a1' } as any)
  expect(await retireCue(113)).toBe('retire ok - 113\n')
  await h.clock!.advance(1000)
  await $.turn.start({ turnId: 't10' } as any)
  expect(await retireCue(114)).toBe('retire refused report-stale 114\n')
  await h.clock!.advance(1000)
  h.reportFile = { text: `${h.reportFile!.text}status: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(115)).toBe('retire ok - 115\n')
})

test('a report whose time is fresh but whose size has not grown since the last turn is stale', async ($, on) => {
  await retireTarget($, on)
  expect(await retireCue(116)).toBe('retire ok - 116\n')
  await $.prompt.submit({ text: 'one more thing' } as any)
  await h.clock!.advance(1000)
  h.reportFile = { text: h.reportFile!.text, mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(1000)
  expect(await retireCue(117)).toBe('retire refused report-stale 117\n')
  h.reportFile = { text: `${h.reportFile.text}status: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(118)).toBe('retire ok - 118\n')
})

test('a report stat that fails for any reason but a missing file records the size as unknown: report-unknown, not a pass on a touch', async ($, on) => {
  await retireTarget($, on)
  expect(await retireCue(130)).toBe('retire ok - 130\n')
  h.reportStatErr = `stat: ${REPORT}: Permission denied`
  await $.prompt.submit({ text: 'one more thing' } as any)
  h.reportStatErr = undefined
  await h.clock!.advance(1000)
  h.reportFile = { text: h.reportFile!.text, mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(1000)
  expect(await retireCue(131)).toBe('retire refused report-unknown 131\n')
  await $.prompt.submit({ text: 'again' } as any)
  await h.clock!.advance(1000)
  h.reportFile = { text: `${h.reportFile.text}status: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(132)).toBe('retire ok - 132\n')
})

test('a turn mark that could not be written fails closed: report-unknown until a later write succeeds', async ($, on) => {
  const trace = newTrace()
  const stdins: string[] = []
  await retireTarget($, on, stdins, trace)
  expect(await retireCue(119)).toBe('retire ok - 119\n')
  trace.failKeys = new Set(['lastTurnAt'])
  await $.prompt.submit({ text: 'one more thing' } as any)
  expect(logged(stdins)).toContain('error:last-turn')
  expect(await retireCue(120)).toBe('retire refused report-unknown 120\n')
  await h.clock!.advance(1000)
  h.reportFile = { text: `${h.reportFile!.text}status: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(121)).toBe('retire refused report-unknown 121\n')
  trace.failKeys = undefined
  await $.prompt.submit({ text: 'again' } as any)
  await h.clock!.advance(1000)
  h.reportFile = { text: `${h.reportFile.text}status: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(122)).toBe('retire ok - 122\n')
})

test('a retire cue needs the session\'s own signature and a readable report', async ($, on) => {
  await retireTarget($, on)
  h.reportFile = { text: `status: done ${OTHER}\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(103)).toBe('retire refused report-not-done 103\n')
  h.reportFile = { text: `status: done ${SID}\nmore\n`, mtimeSec: h.nowMs / 1000 }
  expect(await retireCue(104)).toBe('retire refused report-not-done 104\n')
  h.reportFile = undefined
  expect(await retireCue(105)).toBe('retire refused report-missing 105\n')
})

test('a retire cue passes the same gates as resume: the record, the lane and, for an attached lane, a lead', async ($, on) => {
  await retireTarget($, on)
  laneSeed.text = JSON.stringify({ lanes: [{ name: 'LABLANE', folder: '/data/x/work/lab', brief: '/data/x/work/lab/OTHER.md', repo: '/data/x/work' }] })
  expect(await retireCue(106)).toBe('retire refused record-changed 106\n')
  laneSeed.text = LEAD_LANES('/data/x/work')
  expect(await retireCue(107)).toBe('retire ok - 107\n')
})

test('a retire cue to an attached lane with no lead running is refused no-lead', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane svc-api')
  leadFiles.clear()
  expect(await retireCue(108)).toBe('retire refused no-lead 108\n')
})

test('a retire cue to a session that is not a lane is refused', async ($, on) => {
  await started($, on, [], { clock: true })
  expect(await retireCue(109)).toBe('retire refused not-eligible 109\n')
})

// ---- #215 follow-ups: the stop tools' texts, the ps -p confirm of a dropped row, exactly one registry row of one's own ----
test('the stop tools give the full text of a process refusal, still starting with the code, and the Force-stop toast keeps the code only', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  h.reportFile = REPORT_OK()
  const changed = JSON.stringify(await $.tool.call(leadCall('terminate')))
  expect(changed).toContain('lane_terminate refused: pid-changed: the process behind that pid no longer has the start time the session list records (it ended, the pid was reused, or ps could not be read). No signal was sent.')
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('pid-changed: the process behind that pid')
  h.psOut = 'Tue Oct 27 20:37:50 2026\n'
  h.psArgsOut = '/usr/bin/vim /tmp/notes\n'
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('lane_terminate refused: not-claude: the process behind that pid is not a Claude session. No signal was sent.')
  h.psArgsOut = '/x/native-binary/claude --output-format stream-json\n'
  h.sessions = cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { procStart: undefined })
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('lane_terminate refused: no-pid: the session list has no usable pid and start time for that session. No signal was sent.')
  h.sessions = cueSession(OTHER, 'LABLANE')
  const t0 = toasts.length
  expect(await terminateDuring($, () => { h.psOut = 'Wed Oct 28 01:00:00 2026\n' })).toContain('pid-changed: the process behind that pid')
  expect(toasts.slice(t0)).toContain('Force stop not sent: pid-changed')
  expect(killed(argv).length).toBe(0)
})

test('retire and terminate of a joined lane keep its record and clear the stopped session id from it after a kill that exited 0, and not after one that failed', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { sess: { ...leadSelfReg(), ...ATTSESS() } })
  const rec = attRec(SID, 'ATT')
  putStore([{ ...rec, sid: OTHER, parked: 3 }])
  h.askAnswer = 'Force stop'
  h.killFails = true
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toContain('the signal failed')
  expect(recOf('ATT').sid).toBe(OTHER)
  h.killFails = false
  const out = (await $.tool.call(leadCall('terminate', { lane: 'ATT' }))).result as string
  expect(out).toBe('lane ATT terminated: SIGTERM sent to process 4500. The record stays because a session joined it. With that session gone, call lane_terminate again to remove it.')
  expect(h.lastQuestion).toBe(terminateQuestion('ATT', OTHER, 4500, undefined, false))
  expect(h.lastQuestion).not.toContain('record is then removed')
  expect(recOf('ATT')).toEqual(rec)
  expect(logged(stdins)).toContain('sid-cleared:ATT')
  expect(logged(stdins)).not.toContain('lane-removed:ATT')
  putStore([{ ...rec, sid: OTHER }])
  killedPids.clear()
  h.reportAt = `${PIN}/.archive/ATT/REPORT.md`
  h.reportFile = REPORT_OK()
  expect((await $.tool.call(leadCall('retire', { lane: 'ATT' }))).result).toBe('lane ATT retired: SIGTERM sent to process 4500. The record stays because a session joined it. With that session gone, call lane_retire again to remove it.')
  expect(recOf('ATT')).toEqual(rec)
})

// ---- lane_retire and lane_terminate end the lane for good: its record goes with its session ----
// A lead's tool result, less the note that the lanes changed (the test wrote the store itself).
const stopText = (r: any) => (r.result as string).replace(` ${LANES_CHANGED_NOTE}`, '')
const liveApi = () => ({ ...leadSelfReg(), ...cueSession(OTHER, 'API', `${PIN}/api`, { pid: 4500 }) })
const OLD_REC = { name: 'OLD', folder: SVC, brief: `${SVC}/B.md`, createdAt: 2, sid: NEWSID, parked: 5 }

test('lane_retire of a live lane removes its record once the signal went out; other records and the .archive folder stay', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await leadAt($, on, stdins, { sess: liveApi(), argv })
  const att = attRec(OTHERLEAD, 'ATT')
  putStore([OLD_REC, PARK_API({ sid: OTHER }), att], [T0 - 5])
  h.reportAt = `${PIN}/.archive/API/REPORT.md`
  h.reportFile = REPORT_OK()
  expect(stopText(await $.tool.call(leadCall('retire', { lane: 'API' })))).toBe('lane API retired and removed: SIGTERM sent to process 4500. Its .archive/API/ folder and report stay.')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4500']])
  expect(storeJson()).toEqual({ repo: PIN, lanes: [OLD_REC, att], creates: [T0 - 5] })
  expect(logged(stdins)).toContain('lane-removed:API')
  expect(noArchiveRm(argv)).toBe(true)
})

test('lane_terminate of a live lane removes its record too; its dialog says so', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await leadAt($, on, stdins, { sess: liveApi(), argv })
  putStore([PARK_API({ sid: OTHER, parked: 3 }), OLD_REC])
  h.askAnswer = YES
  expect(stopText(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toBe('lane API terminated and removed: SIGTERM sent to process 4500. Its .archive/API/ folder and report stay.')
  expect(h.lastQuestion).toBe(terminateQuestion('API', OTHER, 4500, undefined, true))
  expect(h.lastQuestion!.endsWith(" The lane's record is then removed.")).toBe(true)
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4500']])
  expect(storeJson().lanes).toEqual([OLD_REC])
  expect(logged(stdins)).toContain('lane-removed:API')
  expect(noArchiveRm(argv)).toBe(true)
})

test('a stop whose record cannot be removed after the signal says so with the code; the record stays', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { sess: liveApi() })
  // The record names another session than the one stopped: a lead's stop goes on, and the removal refuses changed.
  putStore([PARK_API({ sid: NEWSID })])
  h.askAnswer = YES
  expect(stopText(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toBe('lane API terminated: SIGTERM sent to process 4500. Its record could not be removed (changed); call lane_terminate again to remove it.')
  expect(recOf('API').sid).toBe(NEWSID)
  expect(logged(stdins).some((x) => x.startsWith('error:lane-unremoved'))).toBe(true)
  expect(logged(stdins)).not.toContain('lane-removed:API')
})

test('a stop whose process is still running 10 seconds after the signal keeps the record and says so', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { sess: liveApi() })
  putStore([PARK_API({ sid: OTHER, parked: 3 })])
  h.askAnswer = YES
  h.survivesKill = true
  const slept: number[] = []
  h.fastSleep = (ms) => void slept.push(ms)
  expect(stopText(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toBe('lane API terminated: SIGTERM sent to process 4500, but the session was still running 10 seconds later, so its record stays. Call lane_terminate again if it does not end.')
  expect(slept.filter((ms) => ms === 500).length).toBe(20)
  // The record stays but stops naming the stopped session (and is no longer parked), so a by-hand reopen of that conversation asks Restore.
  expect(recOf('API').name).toBe('API')
  expect(recOf('API').sid).toBeUndefined()
  expect(recOf('API').parked).toBeUndefined()
  expect(logged(stdins)).toContain('sid-cleared:API')
  expect(logged(stdins)).not.toContain('lane-removed:API')
})

test('a stop whose ps read keeps failing after the signal is no end of the process: the record stays', async ($, on) => {
  await leadAt($, on, [], { sess: liveApi() })
  putStore([PARK_API({ sid: OTHER, parked: 3 })])
  h.askAnswer = YES
  h.psFailsAfterKill = true
  h.fastSleep = () => undefined
  expect(stopText(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toContain('still running 10 seconds later, so its record stays')
  expect(recOf('API').name).toBe('API')
})

test('lane_retire of a lane no live session carries removes its record with no dialog and no report; a joined lane too once its session is gone', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await leadAt($, on, stdins, { argv })
  const att = attRec(SID, 'ATT')
  putStore([OLD_REC, PARK_API({ sid: OTHER }), att])
  const asked = h.askCount
  expect(stopText(await $.tool.call(leadCall('retire', { lane: 'API' })))).toBe('lane API retired and removed: it had no live session. Its .archive/API/ folder and report stay.')
  expect(storeJson().lanes).toEqual([OLD_REC, att])
  // A record that names no session goes the same way.
  putStore([PARK_API()])
  expect((await $.tool.call(leadCall('retire', { lane: 'API' }))).result).toContain('retired and removed')
  expect(storeJson().lanes).toEqual([])
  expect(h.askCount).toBe(asked)
  expect(logged(stdins)).toContain('lane-removed:API')
  expect(killed(argv)).toEqual([])
  expect(noArchiveRm(argv)).toBe(true)
  // A lane a session joined, whose session is gone, goes the same way (stuck lanes): retire needs no report and no dialog.
  putStore([OLD_REC, att])
  expect(stopText(await $.tool.call(leadCall('retire', { lane: 'ATT' })))).toBe('lane ATT retired and removed: it had no live session. Its .archive/ATT/ folder and report stay.')
  expect(storeJson().lanes).toEqual([OLD_REC])
  expect(h.askCount).toBe(asked)
})

test('lane_retire of a parked lane no live session carries asks the Remove question; Cancel removes nothing, Remove removes the record', async ($, on) => {
  await leadAt($, on, [])
  putStore([PARK_API({ sid: OTHER, parked: 3 })])
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(leadCall('retire', { lane: 'API' })))).toContain('did not confirm')
  expect(h.lastQuestion).toBe(removeQuestion('API', PIN, true, HOME))
  expect(recOf('API').parked).toBe(3)
  h.askAnswer = YES
  expect(stopText(await $.tool.call(leadCall('retire', { lane: 'API' })))).toBe('lane API retired and removed: it had no live session. Its .archive/API/ folder and report stay.')
  expect(storeJson().lanes).toEqual([])
})

test('lane_terminate of a lane no live session carries always asks the Remove question (the parked sentence when parked); Cancel removes nothing; Remove removes the record', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await leadAt($, on, stdins, { argv })
  putStore([PARK_API({ sid: OTHER })])
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toContain('lane_terminate refused: the person did not confirm. Nothing was removed.')
  expect(h.lastQuestion).toBe(removeQuestion('API', PIN, false, HOME))
  expect(h.lastQuestion).toBe('Remove lane API in ~/code/app? It has no live session.')
  expect(h.lastHeader).toBe('Stop Lane')
  expect(h.askedOptions[h.askedOptions.length - 1]).toEqual(['Remove', 'Cancel'])
  expect(storeJson().lanes.length).toBe(1)
  putStore([PARK_API({ sid: OTHER, parked: 3 })])
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toContain('did not confirm')
  expect(h.lastQuestion).toBe(removeQuestion('API', PIN, true, HOME))
  expect(h.lastQuestion).toContain('It is parked: its saved conversation is no longer reachable from callboard.')
  expect(recOf('API').parked).toBe(3)
  h.askAnswer = YES
  expect(stopText(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toBe('lane API terminated and removed: it had no live session. Its .archive/API/ folder and report stay.')
  expect(storeJson().lanes).toEqual([])
  expect(logged(stdins)).toContain('lane-removed:API')
  expect(killed(argv)).toEqual([])
})

test('a sessionless lane whose recorded session is live under another name or holds a presence file is refused before the dialog, and again when it comes while the dialog is open', async ($, on) => {
  await leadAt($, on, [])
  putStore([PARK_API({ sid: OTHER })])
  const asked = h.askCount
  const renamed = { ...leadSelfReg(), ...cueSession(OTHER, 'RENAMED', `${PIN}/api`, { pid: 4500 }) }
  h.sessions = renamed
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toContain(`lane_terminate refused: name-in-use: ${REASON_TEXT['name-in-use']}`)
  expect(JSON.stringify(await $.tool.call(leadCall('retire', { lane: 'API' })))).toContain(`lane_retire refused: name-in-use: ${REASON_TEXT['name-in-use']}`)
  leadFiles.set(`${ROOT}/leads/${OTHER}.json`, { text: JSON.stringify({ sid: OTHER, pid: 4500, procStart: LEADPS, repo: PIN }) })
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toContain('lane_terminate refused: target-is-lead: ')
  expect(JSON.stringify(await $.tool.call(leadCall('retire', { lane: 'API' })))).toContain('lane_retire refused: target-is-lead: ')
  expect(h.askCount).toBe(asked)
  leadFiles.delete(`${ROOT}/leads/${OTHER}.json`)
  h.sessions = leadSelfReg()
  h.askAnswer = YES
  h.askScript = () => {
    h.sessions = renamed
    return YES
  }
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toContain('lane_terminate refused: name-in-use: ')
  expect(h.askCount).toBe(asked + 1)
  expect(recOf('API').sid).toBe(OTHER)
})

test('no lane_remove is declared for a lead or the manager', async ($, on) => {
  await leadAt($, on, [])
  expect(toolDefs.some((d) => d.includes('"lane_create"'))).toBe(true)
  expect(toolDefs.some((d) => d.includes('"lane_remove"'))).toBe(false)
})

test('lane_retire waits for the idle time through /bin/sleep, not $.clock.sleep (a hook has 10 s of its own time)', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.sessions = retireOk({ status: 'busy' })
  h.fastSleep = () => undefined
  h.clockSlept = 0
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('not-idle')
  expect(sleeps(argv).length).toBe(20)
  expect(sleeps(argv).every((a) => a[1] === '2')).toBe(true)
  expect(h.clockSlept).toBeLessThan(HOOK_BUDGET_MS / 2)
  expect(killed(argv).length).toBe(0)
})

test('lane_park waits for the idle time through /bin/sleep, not $.clock.sleep', async ($, on) => {
  const argv: string[][] = []
  await parker($, on, [], argv)
  h.fastSleep = () => undefined
  h.sessions = parkSess({ statusUpdatedAt: h.nowMs - 5000 })
  h.clockSlept = 0
  expect((await park($)).result).toContain('lane API parked')
  expect(sleeps(argv).length).toBe(13)
  expect(h.clockSlept).toBeLessThan(HOOK_BUDGET_MS / 2)
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4500']])
})

test('the stop poll after the signal waits through /bin/sleep too: 20 half-second waits, none on $.clock.sleep', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { sess: liveApi(), argv })
  putStore([PARK_API({ sid: OTHER, parked: 3 })])
  h.askAnswer = YES
  h.survivesKill = true
  h.fastSleep = () => undefined
  h.clockSlept = 0
  expect(stopText(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toContain('still running 10 seconds later, so its record stays')
  expect(sleeps(argv).length).toBe(20)
  expect(sleeps(argv).every((a) => a[1] === '0.5')).toBe(true)
  expect(h.clockSlept).toBeLessThan(HOOK_BUDGET_MS / 2)
})

test('a wait that cannot run ends the idle wait with the refusal naming the seconds left, and does not spin', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.sessions = retireOk({ statusUpdatedAt: h.nowMs - 10_000 })
  h.sleepFails = true
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('not-idle: the session has been idle for 10 of the 30 seconds it needs. Retry once, in 20 s; do not loop.')
  expect(sleeps(argv).length).toBe(1)
  expect(killed(argv).length).toBe(0)
})

test('a wait that fails after the signal answers signalled with the record unknown, never "failed closed", and logs the code', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await leadAt($, on, stdins, { sess: liveApi(), argv })
  putStore([PARK_API({ sid: OTHER, parked: 3 })])
  h.askAnswer = YES
  h.survivesKill = true
  h.sleepFails = true
  const out = stopText(await $.tool.call(leadCall('terminate', { lane: 'API' })))
  expect(out).toBe('lane API: SIGTERM sent to process 4500, but the call failed afterwards, so what became of its record is not known. Call lane_list, then lane_terminate again if the lane is still listed.')
  expect(killed(argv).length).toBe(1)
  expect(logged(stdins)).toContain('error:after-signal-terminate')
})

test('a call that throws before any signal answers failed closed and logs the kind of the failure, never its text', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await lead($, on, stdins, { argv })
  h.reportFile = REPORT_OK()
  h.sessions = retireOk({ status: 'busy' })
  h.fastSleep = () => void (h.nowThrowsOnce = true)
  const out = JSON.stringify(await $.tool.call(leadCall('retire')))
  expect(out).toContain('lane_retire failed closed.')
  expect(logged(stdins)).toContain('error:lane_retire-hook-throw')
  expect(JSON.stringify(allEvents(stdins))).not.toContain('secret')
  expect(killed(argv).length).toBe(0)
})

test('the retire cue waits for its answer through /bin/sleep: an answer 8 s after the cue lands, with no $.clock.sleep spent', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.autoAnswer = undefined
  let total = 0
  h.fastSleep = (ms) => {
    total += ms
    if (total >= 8000) resultFiles.set(`${ROOT}/result/${OTHER}.result`, 'retire ok - 12\n')
  }
  h.clockSlept = 0
  expect((await $.tool.call(leadCall('retire'))).result).toContain('SIGTERM sent to process 4242')
  expect(total).toBeGreaterThanOrEqual(8000)
  expect(sleeps(argv).length).toBeGreaterThan(30)
  expect(h.clockSlept).toBeLessThan(HOOK_BUDGET_MS / 2)
})
const REMOVED_NO_SESSION = (verb: string, name = 'ATT') => `lane ${name} ${verb === 'retire' ? 'retired' : 'terminated'} and removed: it had no live session. Its .archive/${name}/ folder and report stay.`

test('stuck lanes: lane_retire of an attached lane no live session carries removes its record, with no dialog, no report and no signal; its cleared session id changes nothing', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await leadAt($, on, stdins, { argv })
  putStore([OLD_REC, GONE_ATT('ATT', { sid: OTHER }), GONE_ATT('KEEP')])
  h.reportFile = undefined
  const asked = h.askCount
  expect(stopText(await $.tool.call(leadCall('retire', { lane: 'ATT' })))).toBe(REMOVED_NO_SESSION('retire'))
  expect(storeJson().lanes.map((l: any) => l.name)).toEqual(['OLD', 'KEEP'])
  expect(h.askCount).toBe(asked)
  expect(killed(argv)).toEqual([])
  expect(logged(stdins)).toContain('lane-removed:ATT')
  expect(noArchiveRm(argv)).toBe(true)
})

test('stuck lanes: lane_terminate of an attached lane no live session carries asks the Remove question every time; Cancel and a timeout remove nothing; Remove removes the record', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { argv, clock: true })
  putStore([GONE_ATT()])
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toContain('lane_terminate refused: the person did not confirm. Nothing was removed.')
  expect(h.lastQuestion).toBe('Remove lane ATT in ~/code/app? It has no live session.')
  expect(h.lastHeader).toBe('Stop Lane')
  expect(h.askedOptions[h.askedOptions.length - 1]).toEqual(['Remove', 'Cancel'])
  expect(storeJson().lanes.length).toBe(1)
  h.askHang = new Promise<string>(() => undefined)
  const t = JSON.stringify(await unanswered($.tool.call(leadCall('terminate', { lane: 'ATT' }))))
  h.askHang = undefined
  expect(t).toContain('question timed out')
  expect(storeJson().lanes.length).toBe(1)
  h.askAnswer = YES
  expect(stopText(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toBe(REMOVED_NO_SESSION('terminate'))
  expect(storeJson().lanes).toEqual([])
  expect(killed(argv)).toEqual([])
})

test('stuck lanes: a live session that carries an attached record keeps it: by its name, or by the session id the record names under another name', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { argv, sess: { ...leadSelfReg(), ...cueSession(OTHER, 'renamed-by-hand', SVC, { pid: 4500 }) } })
  putStore([GONE_ATT('ATT', { sid: OTHER })])
  expect(JSON.stringify(await $.tool.call(leadCall('retire', { lane: 'ATT' })))).toContain('lane_retire refused: name-in-use: a live session already has that lane name.')
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toContain('lane_terminate refused: name-in-use')
  expect(storeJson().lanes.length).toBe(1)
  expect(killed(argv)).toEqual([])
})

test('stuck lanes: a session that carries the attached record by the time the person clicks keeps it (checked again inside the store lock)', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { argv })
  putStore([GONE_ATT()])
  h.askScript = async () => {
    h.sessions = { ...leadSelfReg(), ...ATTSESS() }
    return YES
  }
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toContain('lane_terminate refused: name-in-use')
  h.askScript = undefined
  expect(storeJson().lanes.length).toBe(1)
  expect(killed(argv)).toEqual([])
})

test('stuck lanes: the refusal of an attached lane for open names no route that needs the gone session', async ($, on) => {
  await leadAt($, on, [])
  putStore([GONE_ATT()])
  const t = JSON.stringify(await $.tool.call(leadCall('open', { lane: 'ATT' })))
  expect(t).toContain('adopted-record: an attached lane keeps its own session: no rename, start or open. Use lane_resume to prompt it. lane_retire or lane_terminate ends it.')
  expect(t).not.toContain('/callboard lane off')
})

test('stuck lanes: a stop of a live attached lane keeps the record and says how to remove it; the second stop, with the session gone, removes it', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { argv, sess: { ...leadSelfReg(), ...ATTSESS() } })
  putStore([attRec(SID, 'ATT', { sid: OTHER, leadName: 'LEAD' })])
  h.askAnswer = 'Force stop'
  expect(stopText(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toBe('lane ATT terminated: SIGTERM sent to process 4500. The record stays because a session joined it. With that session gone, call lane_terminate again to remove it.')
  expect(storeJson().lanes.map((l: any) => [l.name, l.sid])).toEqual([['ATT', undefined]])
  h.sessions = leadSelfReg()
  h.askAnswer = YES
  expect(stopText(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toBe(REMOVED_NO_SESSION('terminate'))
  expect(storeJson().lanes).toEqual([])
})

test('stuck lanes: the manager removes an attached lane no live session carries (lane_retire and lane_terminate both ask), whatever lead the record names', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await mgrAt($, on, stdins, { argv, sess: MGR_NOAPI() })
  putStore([ckLane({ sid: APISID }), GONE_ATT('ATT', { leadName: 'LEADX' }), GONE_ATT('ATT2', { leadName: 'old-aa' })])
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(mgrCall('retire', 'ATT')))).toContain('the person did not confirm')
  expect(h.lastQuestion).toBe('Remove lane ATT in ~/code/app? It has no live session.')
  expect(storeNames()).toEqual(['API', 'ATT', 'ATT2'])
  h.askAnswer = YES
  expect(JSON.parse(await $.tool.call(mgrCall('retire', 'ATT')).then(JSON.stringify)).result).toBe(REMOVED_NO_SESSION('retire'))
  expect(JSON.parse(await $.tool.call(mgrCall('terminate', 'ATT2')).then(JSON.stringify)).result).toBe(REMOVED_NO_SESSION('terminate', 'ATT2'))
  expect(storeNames()).toEqual(['API'])
  expect(killed(argv)).toEqual([])
  expect(logged(stdins)).toContain('lane-removed:ATT')
})

test('stuck lanes: the manager still refuses an attached record a live session carries', async ($, on) => {
  await mgrAt($, on, [], { sess: { ...MGR_NOAPI(), ...cueSession(APISID, 'whatever', SVC, { pid: 4500 }) } })
  putStore([ckLane({ sid: OTHER }), GONE_ATT('ATT', { sid: APISID })])
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'ATT')))).toContain('name-in-use')
  expect(storeNames()).toEqual(['API', 'ATT'])
})

test('stuck lanes: the conductor force stops (asks, removes) an attached lane no live session carries, and still never retires', async ($, on) => {
  const argv: string[][] = []
  await condOn($, on, [], { argv })
  putStore([ckLane({ sid: APISID }), GONE_ATT('ATT', { leadName: 'old-aa' })])
  expect(JSON.stringify(await $.tool.call(mgrCall('retire', 'ATT')))).toContain('the conductor may only list lanes, compact leads and lanes, and force stop a lane')
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'ATT')))).toContain('the person did not confirm')
  expect(h.lastQuestion).toBe('Remove lane ATT in ~/code/app? It has no live session.')
  expect(storeNames()).toEqual(['API', 'ATT'])
  h.askAnswer = YES
  expect((await $.tool.call(mgrCall('terminate', 'ATT'))).result).toBe(REMOVED_NO_SESSION('terminate'))
  expect(storeNames()).toEqual(['API'])
  expect(killed(argv)).toEqual([])
})
