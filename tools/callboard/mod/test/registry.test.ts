import { expect, test } from 'claude-code/testing'
import { refusalText, LANE_RECORD_UNKNOWN } from '../hooks/core'
import { h, SESSIONS, SID, fsReads, killedPids, laneSeed, leadFiles, longTest, psConfirmCalls, psStartsAt, psStartsCalls, psStartsGone, regFacts, regFiles } from './harness'
import { ATTLANE, ATTSESS, LEADSID, LEAD_LANES, OTHER, PIN, REPORT_OK, SELFPATH, TWIN, attRec, attacher, callCreate, creator, cue, cueSession, doLane, grantAt, killed, lead, leadAt, leadCall, leadReg, leadSelfReg, listCall, logged, noLaneWritten, ownReg, putStore, storeJson, storeLaneNames } from './fixtures'

test('a registry directory that is not private to the user is not read', async ($, on) => {
  await lead($, on, [])
  expect((await $.tool.call(leadCall('start'))).result).toContain('cue start acted')
  h.sessionsUnsafe = true
  expect(JSON.stringify(await $.tool.call(leadCall('start')))).toContain('could not read the session list safely')
  expect(JSON.stringify(await $.tool.call(leadCall('open')))).toContain('could not read the session list safely')
})

test('the registry is read with a bound and a stat, never with fs.read; a file that is a FIFO, writable by group or others, with a special bit, over 16 KB or linked twice is not read', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { sess: { ...leadReg(), ...leadSelfReg(), ...ATTSESS() }, argv })
  putStore([attRec(LEADSID)])
  const live = async () => JSON.stringify(await $.tool.call(listCall()))
  expect(await live()).toContain(' | live | ')
  expect(fsReads).toEqual([])
  for (const bad of [{ kind: 'Fifo' }, { mode: '666' }, { mode: '664' }, { mode: '646' }, { mode: '4644' }, { mode: '2644' }, { mode: '1644' }, { size: 16_385 }, { nlink: 2 }, { uid: 0 }]) {
    regFacts.clear()
    regFacts.set('4500.json', bad)
    argv.length = 0
    expect(await live(), JSON.stringify(bad)).toContain(' | none | ')
    expect(argv.some((a) => a[0] === '/usr/bin/head' && a[a.length - 1] === `${SESSIONS}/4500.json`)).toBe(false)
  }
  regFacts.clear()
  regFacts.set('4500.json', { mode: '600' })
  expect(await live()).toContain(' | live | ')
  regFacts.set('4500.json', { mode: '644' })
  expect(await live()).toContain(' | live | ')
})

longTest('a registry of more than 512 files is refused, not cut: a name could hide past the cap; 512 are read', async ($, on) => {
  const junk = (n: number) => {
    const out: Record<string, string> = {}
    for (let i = 0; i < n; i++) out[`${10_000 + i}.json`] = JSON.stringify({ sessionId: `9a1b2c3d-0000-4000-8000-${String(i).padStart(12, '0')}`, cwd: '/x', status: 'idle', pid: 10_000 + i })
    return out
  }
  const stdins: string[] = []
  await leadAt($, on, stdins, { sess: { ...leadSelfReg(), ...junk(510), ...ATTSESS() } })
  putStore([attRec(LEADSID)])
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain(' | live | ')
  expect(logged(stdins)).not.toContain('error:registry-too-many')
  h.sessions = { ...leadSelfReg(), ...junk(511), ...ATTSESS() }
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain('could not read the session list')
  expect(logged(stdins)).toContain('error:registry-too-many')
})

test('a registry file that is there but cannot be read is tried once more and then makes the scan refuse; a file that is gone is just skipped', async ($, on) => {
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...ATTSESS() } })
  putStore([attRec(LEADSID)])
  const live = async () => JSON.stringify(await $.tool.call(listCall()))
  regFacts.set('4500.json', { failHead: 1 })
  expect(await live()).toContain(' | live | ')
  regFacts.set('4500.json', { failHead: 2 })
  expect(await live()).toContain('could not read the session list')
  regFacts.clear()
  delete h.sessions['4500.json']
  expect(await live()).toContain(' | none | ')
})

test('a registry file that grows between the stat and the read is not read', async ($, on) => {
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...ATTSESS() } })
  putStore([attRec(LEADSID)])
  h.sessions['4500.json'] = `${h.sessions['4500.json']}${' '.repeat(16_400)}`
  regFacts.set('4500.json', { size: 100 })
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain(' | none | ')
})

test('a registry file that changed under the read is read once more and found; one that keeps changing makes the whole scan untrusted and the callers refuse', async ($, on) => {
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...ATTSESS() } })
  putStore([attRec(LEADSID)])
  const live = async () => JSON.stringify(await $.tool.call(listCall()))
  regFacts.set('4500.json', { flaky: 1 })
  expect(await live()).toContain(' | live | ')
  regFacts.set('4500.json', { flaky: 2 })
  expect(await live()).toContain('could not read the session list')
  regFacts.clear()
  expect(await live()).toContain(' | live | ')
})

test('with a registry file that keeps changing, a Join is refused and nobody is named free', async ($, on) => {
  await attacher($, on)
  h.sessions = { ...leadReg(), ...ownReg(), ...cueSession(OTHER, 'svc-api', '/elsewhere', { pid: 4500 }) }
  regFacts.set('4500.json', { flaky: 2 })
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('registry-unreadable'))
  await noLaneWritten($)
  regFacts.set('4500.json', { flaky: 1 })
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('name-taken'))
})

test('one cue reads each registry file once, however many steps ask for it', async ($, on) => {
  const argv: string[][] = []
  await attacher($, on, [], { clock: true, argv })
  await doLane($, 'lane svc-api')
  argv.length = 0
  expect(await cue(84, 'resume\n')).toBe('resume ok - 84\n')
  expect(argv.filter((a) => a[0] === '/usr/bin/head' && a[a.length - 1] === `${SESSIONS}/4300.json`).length).toBe(1)
})
const terminateNow = async ($: any) => {
  h.askAnswer = 'Force stop'
  return JSON.stringify(await $.tool.call(leadCall('terminate')))
}

test('a lone registry file whose process is gone does not hold its name; a ps that cannot be trusted keeps every file', async ($, on) => {
  await creator($, on)
  h.sessions = cueSession(OTHER, 'API', '/somewhere')
  psStartsGone.add('4242')
  for (const untrusted of [
    () => { h.psStartsFails = 'exit' },
    () => { h.psStartsFails = 'throw' },
    () => { h.psStartsOut = '    1 Thu Jan  1 00:00:00 1970\nnot a row\n' },
    () => { h.psStartsOut = ' 7777 Thu Jan  1 00:00:00 1970\n' },
    () => { h.psStartsOut = '' },
    () => { h.psStartsOut = ' 4999 Tue Oct 27 20:37:50 2026\n' + '    1 Thu Jan  1 00:00:00 1970\n'.repeat(70_000) },
  ]) {
    h.psStartsFails = undefined
    h.psStartsOut = undefined
    untrusted()
    expect(JSON.stringify(await callCreate($))).toContain('name-in-use')
  }
  h.psStartsFails = undefined
  h.psStartsOut = undefined
  psStartsCalls.length = 0
  expect(JSON.stringify(await callCreate($))).not.toContain('name-in-use')
  expect(storeLaneNames()).toEqual(['API'])
  expect(psStartsCalls.length).toBeGreaterThan(0)
  expect(psStartsCalls.every((c) => c.startsWith('UTC|C|'))).toBe(true)
})

test('a stale twin carrying the lane name is dropped: terminate reaches the live session; with both alive it stays ambiguous', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(TWIN, 'LABLANE', '/data/x/work/lab', { pid: 4243 }) }
  expect(await terminateNow($)).toContain('ambiguous')
  psStartsGone.add('4243')
  expect(await terminateNow($)).toContain('SIGTERM sent to process 4242')
  expect(killed(argv).map((a) => a[a.length - 1])).toEqual(['4242'])
})

test('a twin whose pid was reused by a process started later is stale too', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(TWIN, 'LABLANE', '/data/x/work/lab', { pid: 4243 }) }
  psStartsAt.set('4243', 'Sun Nov  1 00:48:56 2026')
  expect(await terminateNow($)).toContain('SIGTERM sent to process 4242')
})

test('a session that crashed and was resumed: its old file is dropped, so no session-duplicate; both alive still is one', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.reportFile = REPORT_OK()
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(OTHER, 'ELSEWHERE', '/data/x/work/lab', { pid: 4244 }) }
  expect(await terminateNow($)).toContain('session-duplicate')
  expect(JSON.stringify(await $.tool.call(leadCall('retire')))).toContain('session-duplicate')
  psStartsGone.add('4244')
  expect(await terminateNow($)).toContain('SIGTERM sent to process 4242')
})

test('when dropping would take the caller own entry, ps is not trusted and nothing is dropped', async ($, on) => {
  await lead($, on, [])
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(TWIN, 'LABLANE', '/data/x/work/lab', { pid: 4243 }) }
  psStartsGone.add('4243')
  psStartsAt.set('4999', 'Wed Oct 28 01:00:00 2026')
  expect(await terminateNow($)).toContain('ambiguous')
})

test('a file that is not an object, or names another pid than its own file name, is skipped, with or without ps', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  const forged = { '0.json': cueSession(OTHER, 'LABLANE')['4242.json'], '5000.json': 'null', '5001.json': '[1,2]', '5002.json': '"x"' }
  for (const fails of [undefined, 'exit', 'throw'] as const) {
    h.psStartsFails = fails
    // Each stop removes the lane's record: seed it again.
    laneSeed.text = LEAD_LANES('/data/x/work')
    killedPids.clear()
    h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...forged }
    expect(await terminateNow($)).toContain('SIGTERM sent to process 4242')
  }
  expect(killed(argv).length).toBe(3)
})

test('ps runs after the registry is listed and read: a file listed then is in the table it is judged by', async ($, on) => {
  await creator($, on)
  h.sessions = cueSession(OTHER, 'API', '/somewhere')
  await callCreate($)
  expect(psStartsCalls.at(-1)).toContain('4242.json')
})

// ---- cycle-1 review: fallbacks are logged, retries count once per tick, a failed check says so ----
test('a ps table that cannot be trusted turns the dead-process filter off for that read, and says so in the log', async ($, on) => {
  const stdins: string[] = []
  await creator($, on, stdins)
  h.sessions = cueSession(OTHER, 'API', '/somewhere')
  psStartsGone.add('4242')
  h.psStartsFails = 'exit'
  expect(JSON.stringify(await callCreate($))).toContain('name-in-use')
  expect(logged(stdins)).toContain('error:registry-ps-untrusted')
  h.psStartsFails = undefined
})

test('a row whose pid the table lacks is dropped only once ps -p agrees: alive with its own start keeps every row, another start or none listed drops it', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await lead($, on, stdins, { argv })
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(TWIN, 'LABLANE', '/data/x/work/lab', { pid: 4243 }) }
  psStartsGone.add('4243')
  h.psConfirmOut = ' 4243 Tue Oct 27 20:37:50 2026\n'
  expect(await terminateNow($)).toContain('ambiguous')
  expect(logged(stdins)).toContain('error:registry-ps-cut')
  expect(psConfirmCalls.at(-1)).toBe('4243')
  h.psConfirmOut = ' 4243 Sun Nov  1 00:48:56 2026\n'
  expect(await terminateNow($)).toContain('SIGTERM sent to process 4242')
  expect(killed(argv).map((a) => a[a.length - 1])).toEqual(['4242'])
})

test('a ps -p that throws, fails or prints a half line keeps every row and says so; the next read asks again', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins)
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(TWIN, 'LABLANE', '/data/x/work/lab', { pid: 4243 }) }
  psStartsGone.add('4243')
  for (const doubt of [() => { h.psConfirmFails = 'throw' }, () => { h.psConfirmFails = 'exit' }, () => { h.psConfirmOut = ' 4243 Tue Oct' }]) {
    h.psConfirmFails = undefined
    h.psConfirmOut = undefined
    doubt()
    const n = psConfirmCalls.length
    expect(await terminateNow($)).toContain('ambiguous')
    expect(psConfirmCalls.length).toBeGreaterThan(n)
  }
  expect(logged(stdins)).toContain('error:registry-ps-confirm')
})

test('a row confirmed gone is not asked about again; a row with no start time is asked every time', async ($, on) => {
  await lead($, on, [])
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(TWIN, 'OLD', '/data/x/work/lab', { pid: 4243 }) }
  psStartsGone.add('4243')
  await $.tool.call(leadCall('list'))
  expect(psConfirmCalls).toEqual(['4243'])
  await $.tool.call(leadCall('list'))
  await $.tool.call(leadCall('list'))
  expect(psConfirmCalls).toEqual(['4243'])
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(TWIN, 'OLD', '/data/x/work/lab', { pid: 4244, procStart: undefined }) }
  psStartsGone.add('4244')
  await $.tool.call(leadCall('list'))
  await $.tool.call(leadCall('list'))
  expect(psConfirmCalls.filter((p) => p === '4244').length).toBe(2)
})

test('two registry rows of this session: lane_create takes no lock and says so in its own words', async ($, on) => {
  const stdins: string[] = []
  await creator($, on, stdins)
  const own = Object.entries(regFiles()).find(([, t]) => t.includes(SID))!
  const twin = JSON.parse(own[1])
  h.sessions = { ...h.sessions, [own[0]]: own[1], '4888.json': JSON.stringify({ ...twin, pid: 4888 }) }
  const created = JSON.stringify(await callCreate($))
  expect(created).toContain('self-duplicate: two files in ~/.claude/sessions carry this session')
})

test('two registry rows of this session: lane off removes no leftover record on a name that may be the twin\'s', async ($, on) => {
  await attacher($, on)
  putStore([ATTLANE()])
  const own = Object.entries(regFiles()).find(([, t]) => t.includes(SID))!
  h.sessions = { ...h.sessions, [own[0]]: own[1], '4888.json': JSON.stringify({ ...JSON.parse(own[1]), pid: 4888 }) }
  expect((await doLane($, 'lane off')).text).toBe(LANE_RECORD_UNKNOWN)
  expect(storeJson().lanes.length).toBe(1)
})

test('two registry rows of this session: no presence file is written for its lead grant', async ($, on) => {
  const twin = JSON.stringify({ ...JSON.parse(leadSelfReg()['4400.json']), pid: 4401 })
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), '4401.json': twin } })
  leadFiles.clear()
  await grantAt($, PIN)
  await h.clock!.advance(4000)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  h.sessions = leadSelfReg()
  await h.clock!.advance(4000)
  expect(leadFiles.has(SELFPATH)).toBe(true)
})

test('a session-list row with no usable pid, kept while the dead-process filter is off, is refused with the full no-pid text', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  h.sessions = cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { pid: 'abc' })
  h.psStartsFails = 'exit'
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('lane_terminate refused: no-pid: the session list has no usable pid and start time for that session. No signal was sent.')
  h.psStartsFails = undefined
  expect(killed(argv).length).toBe(0)
})

test('a ps -p refused for a pid it cannot take keeps every row; a file name that is no possible pid is dropped without asking', async ($, on) => {
  const stdins: string[] = []
  await lead($, on, stdins)
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(TWIN, 'LABLANE', '/data/x/work/lab', { pid: 4243 }) }
  psStartsGone.add('4243')
  h.psConfirmFails = 'stderr'
  expect(await terminateNow($)).toContain('ambiguous')
  expect(logged(stdins)).toContain('error:registry-ps-confirm')
  h.psConfirmFails = undefined
  psConfirmCalls.length = 0
  h.sessions = { ...cueSession(OTHER, 'LABLANE'), ...cueSession(TWIN, 'LABLANE', '/data/x/work/lab', { pid: 100000 }) }
  psStartsGone.add('100000')
  expect(await terminateNow($)).toContain('SIGTERM sent to process 4242')
  expect(psConfirmCalls).toEqual([])
})
