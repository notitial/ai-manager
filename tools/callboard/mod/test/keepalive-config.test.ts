import { expect, test } from 'claude-code/testing'
import { REST_TEXT, helpText, LOG_KEEP_MS, LOG_PRUNE_MAX, LOG_MAX_BYTES, LANES_CHANGED_TEXT, OFF_YES, OFF_NO, RESTORE_YES, RESTORE_NO, nudgeText, compactResumeText, CONFIG_UNSAVED, CONFIG_UNREADABLE, KEEPALIVE_TEXT, noticeText, configText, configSetText, CONFIG_DEFAULTS, CONFIG_USAGE, CONFIG_NOT_PERSON, CONFIG_RESET_TEXT, OFF_NOTHING } from '../hooks/core'
import { h, GOOD, ROOT, SID, T0, YES, engine, extraStat, laneSeed, longTest, storeFiles, submitted } from './harness'
import type { Trace } from './harness'
import { advanceQuiet } from './fixtures'
import { LANES, LEAD_LANES, MIN, NOW, OWN_ROW, PERSON, REG, REGFILE, SELFREG, STATUS_NONE, STOREFILE, TURN, USAGE, allEvents, cue, events, fileStat, framed, killed, lane, lead, leadAt, leadCall, logged, newTrace, notices, nudges, ownTurn, person, pings, renameThroughTick, retireTarget, sleepFor, started, storeText, tickTwice, ticks, waitFor } from './fixtures'

test('/callboard on from any origin gets the usage line: no dialog, no state, no store write, no log line', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await started($, on, stdins, { trace })
  const writes = trace.log.length
  const keys = [...h.store.keys()].sort()
  const origins = [PERSON, { kind: 'bridge' }, { kind: 'plugin', name: 'x' }, { kind: 'peer' }, { kind: 'peer-send-message' }, { kind: 'sdk' }, null]
  for (const origin of origins) expect((await $.command.run(lane('on', origin))).text).toBe(USAGE)
  expect(h.askCount).toBe(0)
  expect(trace.log.slice(writes)).toEqual([])
  expect([...h.store.keys()].sort()).toEqual(keys)
  expect(allEvents(stdins)).toEqual([])
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('not enabled')
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

test('each dialog offers its own exact button pair', async ($, on) => {
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 }
  try {
    await started($, on, [], { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    h.askAnswer = YES
    h.restoreAnswer = YES
    await $.command.run(lane('lane'))
    expect(h.askedOptions).toEqual([[RESTORE_YES, RESTORE_NO]])
    h.askedOptions = []
    // The session is now a lane (restored): the lead question is not asked at all; its buttons are checked in the tests of that section.
    await $.command.run(lane('lead'))
    expect(h.askedOptions).toEqual([])
    h.askedOptions = []
    await $.command.run(lane('off', { kind: 'plugin', name: 'x' }))
    expect(h.askedOptions).toEqual([[OFF_YES, OFF_NO]])
  } finally {
    laneSeed.text = undefined
  }
})

test('status shows the lane and the lead only; off of a plain session says there was nothing to turn off', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect((await $.command.run(lane('on'))).text).toBe(USAGE)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('not enabled')
  expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
  expect((await $.command.run(lane('maybe'))).text).toBe(USAGE)
})

test('session start deletes other sessions\' logs no one wrote to in 90 days, never its own, a young one, a link, a folder or a stray name', async ($, on) => {
  const argv: string[][] = []
  const sid = (d: string) => `${d.repeat(8)}-0000-4000-8000-123456789abc`
  const old = T0 - LOG_KEEP_MS - 1000
  engine(on, argv, [])
  h.logList = [
    { name: `${sid('5')}.jsonl`, kind: 'file', size: 9, mtimeMs: old, isLink: false },
    { name: `${SID}.jsonl`, kind: 'file', size: 9, mtimeMs: old, isLink: false },
    { name: `${sid('6')}.jsonl`, kind: 'file', size: 9, mtimeMs: T0 - LOG_KEEP_MS + 60_000, isLink: false },
    { name: `${sid('7')}.jsonl`, kind: 'file', size: 9, mtimeMs: old, isLink: true },
    { name: `${sid('8')}.jsonl`, kind: 'dir', size: 9, mtimeMs: old, isLink: false },
    { name: 'notes.jsonl', kind: 'file', size: 9, mtimeMs: old, isLink: false },
    { name: '../x.jsonl', kind: 'file', size: 9, mtimeMs: old, isLink: false },
  ]
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const removed = argv.filter((a) => a[0] === '/bin/rm').map((a) => a[a.length - 1]).filter((x) => x.startsWith(`${ROOT}/log/`))
  expect(removed).toEqual([`${ROOT}/log/${sid('5')}.jsonl`])
})

test('session start looks at the oldest logs first, so a folder of more than 500 still loses its old ones', async ($, on) => {
  const argv: string[][] = []
  engine(on, argv, [])
  const young = Array.from({ length: 500 }, (_, i) => ({ name: `${String(i).padStart(8, '7')}-0000-4000-8000-123456789abc.jsonl`, kind: 'file', size: 9, mtimeMs: T0 - 1000, isLink: false }))
  const old = { name: `${'4'.repeat(8)}-0000-4000-8000-123456789abc.jsonl`, kind: 'file', size: 9, mtimeMs: T0 - LOG_KEEP_MS - 1000, isLink: false }
  h.logList = [...young, old]
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(argv.filter((a) => a[0] === '/bin/rm' && a[a.length - 1].startsWith(`${ROOT}/log/`)).map((a) => a[a.length - 1])).toEqual([`${ROOT}/log/${old.name}`])
})

test('session start deletes at most LOG_PRUNE_MAX old logs', async ($, on) => {
  const argv: string[][] = []
  engine(on, argv, [])
  h.logList = Array.from({ length: LOG_PRUNE_MAX + 3 }, (_, i) => ({ name: `${String(i).padStart(8, '9')}-0000-4000-8000-123456789abc.jsonl`, kind: 'file', size: 9, mtimeMs: T0 - LOG_KEEP_MS - 1000, isLink: false }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(argv.filter((a) => a[0] === '/bin/rm' && a[a.length - 1].startsWith(`${ROOT}/log/`)).length).toBe(LOG_PRUNE_MAX)
})

test('a log past 1 MB stops taking refusals and errors, but the stop line before the signal is still written', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { argv })
  extraStat.set(`${ROOT}/log/${SID}.jsonl`, `501 600 1 Regular File 77 ${LOG_MAX_BYTES + 1} 1700000000\n`)
  h.askAnswer = 'Cancel'
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('did not confirm')
  h.askAnswer = 'Force stop'
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  expect(JSON.stringify(await $.tool.call(leadCall('terminate')))).toContain('pid-changed')
  expect(events(stdins).some((e) => e.event === 'refused')).toBe(false)
  h.psOut = 'Tue Oct 27 20:37:50 2026\n'
  expect((await $.tool.call(leadCall('terminate'))).result).toContain('SIGTERM sent to process 4242')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4242']])
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('terminating:LABLANE')
  extraStat.delete(`${ROOT}/log/${SID}.jsonl`)
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  await $.tool.call(leadCall('terminate'))
  expect(events(stdins).some((e) => e.event === 'refused')).toBe(true)
})
// A person's own registry row as the engine writes it for a panel or a terminal (kind interactive), as the auto row now is.
// A person's session (a plain one, no lane, no lead), whose real turn has just ended (at T0).
async function warm($: any, on: any, stdins: string[] = [], trace?: Trace) {
  await person($, on, stdins, trace)
  h.sessions = OWN_ROW()
  await realTurn($, 'work')
}
// A person's turn as the engine runs it: the prompt, its turn's start and end.
async function realTurn($: any, text: string) {
  await $.prompt.submit({ text } as any)
  await $.turn.start({ turnId: 'real', text } as any)
  await $.turn.complete(TURN as any)
}
const kaLog = (stdins: string[]) => logged(stdins).filter((x) => x.startsWith('keepalive'))
const sent = (stdins: string[]) => logged(stdins).filter((x) => x === 'keepalive:').length
const stv = (trace: Trace, key: string) => trace.st!.get(key)?.value

longTest('keepalive: an idle session is pinged 50 minutes after its last turn ended, not at 49, and once per gap', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await h.clock!.advance(49 * MIN)
  expect(pings()).toEqual([])
  await h.clock!.advance(MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  expect(kaLog(stdins)).toEqual(['keepalive:'])
  // The ping's own turn never ran here (no hooks in the kit): no second attempt in this gap.
  await h.clock!.advance(7 * MIN)
  expect(pings().length).toBe(1)
  expect(kaLog(stdins)).toEqual(['keepalive:'])
})

test('keepalive: a prompt that ran no turn also starts a new gap', async ($, on) => {
  await warm($, on)
  await advanceQuiet(30 * MIN)
  await $.prompt.submit({ text: 'queued' } as any)
  await advanceQuiet(25 * MIN)
  expect(pings()).toEqual([])
  await advanceQuiet(25 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

longTest('keepalive: past 58 minutes the cache is cold: no ping, logged once; the next turn starts a new gap', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.draftNow = 'typing'
  await advanceQuiet(58 * MIN)
  h.draftNow = ''
  await h.clock!.advance(3 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:cold'])
  await advanceQuiet(10 * MIN)
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:cold'])
  await realTurn($, 'more')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

test('/callboard rest: no ping and no cache nudge in this gap, logged once; a reload keeps it; the next real turn restores the pings; any origin may type it', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(10 * MIN)
  expect((await $.command.run(lane('rest', { kind: 'plugin', name: 'x' }))).text).toBe(REST_TEXT)
  await advanceQuiet(45 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:rest'])
  // A reload of the mod keeps the state, so the gap stays quiet.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await h.clock!.advance(2 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:rest'])
  // A real turn in this session ends it.
  await realTurn($, 'back')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await ownTurn($, KEEPALIVE_TEXT)
  await h.clock!.advance(10_000)
  // Typed again, it holds for the new gap only.
  await $.command.run(lane('rest'))
  await h.clock!.advance(10_000)
  await realTurn($, 'once more')
  await advanceQuiet(50 * MIN)
  expect(pings().length).toBe(2)
  await ownTurn($, KEEPALIVE_TEXT)
  await h.clock!.advance(10_000)
  // Typed while a real turn is running, it holds past that turn's end.
  await $.prompt.submit({ text: 'long job' } as any)
  await $.turn.start({ turnId: 'real', text: 'long job' } as any)
  await $.command.run(lane('rest'))
  await h.clock!.advance(10_000)
  await $.turn.complete(TURN as any)
  await advanceQuiet(60 * MIN)
  expect(pings().length).toBe(2)
})

test('keepalive: after a restart (the session state is gone) nothing is pinged until a turn has been seen to end', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  for (const k of ['turnEndAt', 'realEndAt', 'pingAt']) trace.st!.delete(k)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await advanceQuiet(56 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual([])
  await $.turn.complete(TURN as any)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

test('keepalive: a reload of the mod keeps the gap (the state survives): the ping still comes 50 minutes after the turn', async ($, on) => {
  await warm($, on)
  await advanceQuiet(20 * MIN)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await advanceQuiet(29 * MIN)
  expect(pings()).toEqual([])
  await h.clock!.advance(MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

for (const [what, setup] of [
  ['the session has no registry row (a headless run)', async () => { h.sessions = {}; h.ownEntryAuto = false }],
  ['its row is a claude --bg background worker', async () => { h.sessions = OWN_ROW({ kind: 'background' }) }],
  ['its row carries no kind', async () => { h.sessions = OWN_ROW({ kind: undefined }) }],
  ['a draft sits in the box', async () => { h.draftNow = 'typing' }],
  ['it is busy', async () => { h.sessions = OWN_ROW({ status: 'busy' }) }],
  ['it waits for a permission', async () => { h.sessions = OWN_ROW({ waitingFor: 'permission' }) }],
  ['keepalive is off', async ($: any) => { expect((await $.command.run(lane('config keepalive off'))).text).toBe(configSetText('keepalive', { ...CONFIG_DEFAULTS, keepalive: false })) }],
] as const) {
  test(`keepalive: no ping when ${what}`, async ($, on) => {
    const stdins: string[] = []
    await warm($, on, stdins)
    await setup($)
    await advanceQuiet(52 * MIN)
    expect(pings()).toEqual([])
    expect(kaLog(stdins)).toEqual([])
  })
}

longTest('keepalive: no ping while a callboard dialog is open', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(50 * MIN - 30_000)
  h.askHang = new Promise<string>(() => undefined)
  const n = h.askCount
  const p = $.command.run(lane('lead', { kind: 'plugin' }))
  await waitFor(() => h.askCount !== n)
  await h.clock!.advance(60_000)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual([])
  await h.clock!.advance(60_000)
  expect((await p).text).toBe('Lead stays off. The question timed out.')
  h.askHang = undefined
})

test('keepalive: no ping while the session has a request of its own', async ($, on) => {
  await person($, on, [], undefined, true)
  h.sessions = OWN_ROW()
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await advanceQuiet(52 * MIN)
  expect(pings()).toEqual([])
})

longTest('keepalive: no ping while a nudge is recorded', async ($, on) => {
  const trace = newTrace()
  await warm($, on, [], trace)
  await advanceQuiet(45 * MIN)
  // The recorded nudge cannot be cleared, so nudgeTick never sends it and it stays recorded through the ping time.
  trace.failKeys = new Set(['nudgeDue'])
  trace.st!.set('nudgeDue', { value: { kind: 'lead', at: h.nowMs }, version: 70 })
  await h.clock!.advance(7 * MIN)
  expect(pings()).toEqual([])
  expect(nudges()).toEqual([])
})

test('keepalive: a plain interactive session that never ran a callboard command is pinged, and /callboard off does not stop it', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await h.clock!.advance(2000)
  await ownTurn($, KEEPALIVE_TEXT)
  await realTurn($, 'more')
  expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT, KEEPALIVE_TEXT])
  expect(kaLog(stdins)).toEqual(['keepalive:', 'keepalive:'])
})

test('keepalive: a lead is pinged (D4)', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('off'))
  laneSeed.text = LEAD_LANES('/data/x/work')
  await $.command.run(lane('lead'))
  expect((await $.command.run(lane('status'))).text).toContain('| Lane | NONE |\n| Lead | ON |')
  h.sessions = OWN_ROW()
  await $.turn.complete(TURN as any)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

for (const [what, set, line] of [
  ['fails', () => { h.submitFails = true }, 'keepalive-failed:'],
  ['hangs past the timeout', () => { h.submitHangs = true }, 'keepalive-unconfirmed:'],
] as const) {
  test(`keepalive: a ping whose submit ${what} is logged and not tried again in that gap`, async ($, on) => {
    const stdins: string[] = []
    await warm($, on, stdins)
    set()
    await advanceQuiet(56 * MIN)
    expect(pings().length).toBe(1)
    expect(kaLog(stdins)).toEqual([line])
  })
}

test('keepalive: a ping turn moves neither the turn mark nor the stop clock and records no nudge; a lane that signed done stays retire-able (F1)', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await renameThroughTick($, on, stdins, 1, trace)
  h.sessions = SELFREG({ kind: 'interactive' })
  await realTurn($, 'work on it')
  const realEnd = stv(trace, 'realEndAt')
  expect(typeof realEnd).toBe('number')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  // The lane signs done after the ping went out; the ping's turn runs after that.
  h.reportFile = { text: `# r\nstatus: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(1000)
  const mark = stv(trace, 'lastTurnAt')
  h.tokensNow = 400_000
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'lastTurnAt')).toEqual(mark)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
  expect(stv(trace, 'turnEndAt')).toBe(h.nowMs)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  expect(await cue(140, 'retire\n', { mtimeSec: h.nowMs / 1000 })).toBe('retire ok - 140\n')
})

for (const [what, make] of [
  ['a nudge', async ($: any) => {
    h.tokensNow = 310_000
    await $.turn.complete(TURN as any)
    await ticks(1)
    h.tokensNow = 150_000
    return nudges()[0]
  }],
  ['a notice', async (_: any, trace: Trace) => {
    trace.st!.set('request', { value: { id: 'r1', phase: 'compacting', mode: 'now', focus: 'f', continuation: 'c', sha256: 'a'.repeat(64), requestedMs: h.nowMs - 20 * MIN, compactingMs: h.nowMs - 16 * MIN }, version: 80 })
    await ticks(1)
    return noticeText('compact-unconfirmed')
  }],
] as const) {
  test(`keepalive: ${what} turn is not real work: it moves the gap but not the stop clock (A)`, async ($, on) => {
    const trace = newTrace()
    await warm($, on, [], trace)
    await advanceQuiet(10 * MIN)
    const text = await make($, trace)
    expect(submitted).toContain(text)
    const realEnd = stv(trace, 'realEndAt')
    await h.clock!.advance(MIN)
    await ownTurn($, text)
    expect(stv(trace, 'realEndAt')).toBe(realEnd)
    expect(stv(trace, 'turnEndAt')).toBe(h.nowMs)
  })
}

test('keepalive: the lanes-changed turn is not real work either (A)', async ($, on) => {
  const trace = newTrace()
  await leadAt($, on, [], { clock: true, trace })
  await $.turn.complete(TURN as any)
  const realEnd = stv(trace, 'realEndAt')
  expect(typeof realEnd).toBe('number')
  await h.clock!.advance(MIN)
  storeFiles.set(STOREFILE, storeText(1))
  await tickTwice()
  expect(notices()).toBe(1)
  await ownTurn($, LANES_CHANGED_TEXT)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
  expect(stv(trace, 'turnEndAt')).toBe(h.nowMs)
})

test('keepalive: a lane a lead started (its start text is real work) and then left idle is pinged', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  extraStat.set('/data/x/work/lab/BRIEF.md', fileStat)
  expect(await cue(43, 'start\n')).toBe('start ok - 43\n')
  h.sessions = { [REGFILE]: REG({ kind: 'interactive' }) }
  await ownTurn($, submitted[0])
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

longTest('keepalive: pings stop 3 hours after the last real turn, logged once; a real turn starts them again', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  const realEnd = stv(trace, 'realEndAt')
  // Below the cache nudge's level, so the third slot is a ping too.
  h.tokensNow = 120_000
  for (let i = 1; i <= 3; i++) {
    await h.clock!.advance(50 * MIN)
    expect(sent(stdins)).toBe(i)
    await h.clock!.advance(2000)
    // The ping's turn as the engine runs it (no prompt hook of the mod's own): it moves no stop clock.
    await ownTurn($, KEEPALIVE_TEXT)
    expect(stv(trace, 'realEndAt')).toBe(realEnd)
  }
  // 150 minutes after the real turn: the next gap ends past 3 hours.
  await h.clock!.advance(50 * MIN)
  expect(sent(stdins)).toBe(3)
  expect(kaLog(stdins).filter((x) => x === 'keepalive-stopped:')).toEqual(['keepalive-stopped:'])
  await h.clock!.advance(30 * MIN)
  expect(kaLog(stdins).filter((x) => x === 'keepalive-stopped:').length).toBe(1)
  await realTurn($, 'back')
  await h.clock!.advance(50 * MIN)
  expect(sent(stdins)).toBe(4)
})

for (const [what, arrange] of [
  ['a recorded nudge', (trace: Trace) => trace.st!.set('nudgeDue', { value: { kind: 'lead', at: h.nowMs }, version: 90 })],
  // The session is not a lane, so its own request carries viaNudge (self), as one it made itself would.
  ['a compaction resume', (trace: Trace) => trace.st!.set('request', { value: { id: 'r2', phase: 'compacted', mode: 'now', focus: 'f', continuation: 'next', sha256: 'a'.repeat(64), requestedMs: h.nowMs, compactingMs: h.nowMs, compactedMs: h.nowMs, viaNudge: true }, version: 90 })],
] as const) {
  test(`keepalive: ${what} due in the same tick as a ping goes out alone: one submit per tick (F2a)`, async ($, on) => {
    const trace = newTrace()
    await warm($, on, [], trace)
    await advanceQuiet(50 * MIN - 2000)
    const before = submitted.length
    arrange(trace)
    await h.clock!.advance(2000)
    expect(submitted.length).toBe(before + 1)
    expect(pings()).toEqual([])
  })
}

test('keepalive: an idle session past the idle level gets the nudge in place of the ping, and nothing more in that gap (D2)', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.tokensNow = 310_000
  await advanceQuiet(50 * MIN)
  expect(logged(stdins)).toContain('nudge-due:idle')
  await h.clock!.advance(7 * MIN)
  expect(nudges()).toEqual([nudgeText('idle')])
  expect(pings()).toEqual([])
})

test('keepalive: a session with background work between the two levels gets the soft nudge in place of the ping', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.tokensNow = 350_000
  h.agentsNow = [{ status: 'running' }]
  await advanceQuiet(50 * MIN)
  expect(logged(stdins)).toContain('nudge-due:idle')
  await h.clock!.advance(7 * MIN)
  expect(nudges()).toEqual([nudgeText('idle')])
  expect(pings()).toEqual([])
})

for (const [what, arrange] of [
  ['past the idle level, inside the 30-minute nudge gap', (trace: Trace) => { h.tokensNow = 310_000; trace.st!.set('counters', { value: { lastNudgeMs: h.nowMs - 10 * MIN, nudgeTimes: [h.nowMs - 10 * MIN] }, version: 91 }) }],
  ['past the idle level, inside the compaction gap', (trace: Trace) => { h.tokensNow = 310_000; trace.st!.set('counters', { value: { lastCompactMs: h.nowMs - 20 * MIN }, version: 91 }) }],
] as const) {
  test(`keepalive: ${what}: the plain ping (D2)`, async ($, on) => {
    const stdins: string[] = []
    const trace = newTrace()
    await warm($, on, stdins, trace)
    await advanceQuiet(49 * MIN)
    arrange(trace)
    await h.clock!.advance(3 * MIN)
    expect(pings()).toEqual([KEEPALIVE_TEXT])
    expect(nudges()).toEqual([])
    expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  })
}

longTest('keepalive: a nudge recorded in place of a ping that is then dropped is logged once as a missed ping, and not recorded again', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.tokensNow = 310_000
  await advanceQuiet(50 * MIN)
  expect(logged(stdins)).toContain('nudge-due:idle')
  h.draftNow = 'typing'
  await advanceQuiet(11 * MIN)
  expect(logged(stdins)).toContain('nudge-dropped:expired')
  h.draftNow = ''
  await h.clock!.advance(5 * MIN)
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:nudge-dropped'])
  expect(logged(stdins).filter((x) => x.startsWith('nudge-due')).length).toBe(1)
  expect(nudges()).toEqual([])
  expect(pings()).toEqual([])
})

// At 200k, past the cache nudge's level and below the idle one, too.
for (const tokens of [400_000, 200_000]) {
  test(`keepalive: a lane signed done gets neither the ping nor a nudge at ping time (D5), at ${tokens / 1000}k`, async ($, on) => {
    const stdins: string[] = []
    await retireTarget($, on, stdins)
    h.sessions = SELFREG({ kind: 'interactive' })
    await $.turn.complete(TURN as any)
    h.tokensNow = tokens
    await advanceQuiet(56 * MIN)
    expect(pings()).toEqual([])
    expect(nudges()).toEqual([])
    expect(submitted.includes(nudgeText('cache'))).toBe(false)
    expect(kaLog(stdins)).toEqual(['keepalive-skipped:lane-done'])
  })
}

test('config: /callboard config prints the settings from any origin and logs nothing', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  for (const origin of [PERSON, { kind: 'bridge' }, { kind: 'plugin' }, { kind: 'peer' }, { kind: 'script' }])
    expect((await $.command.run(lane('config', origin))).text).toBe(['**Callboard settings**', '', '| Setting | Value |', '|---|---|', '| Keepalive | ON |', '| Ping after | 50 min |', '| Stop after | 3 h |', '| Idle level | 300k |', '| Working level | 400k |', '| Check-ins | ON |', '| Conductor leads | ON |', '| Escalation | OFF |'].join('\n'))
  expect(logged(stdins)).toEqual([])
  expect(h.store.has('config')).toBe(false)
  expect((await $.command.run(lane('bogus'))).text).toBe(USAGE)
})

test('/callboard help and a bare /callboard print the same command table; a word it does not know prints the short usage', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins)
  const help = (await $.command.run(lane('help'))).text
  expect(help).toBe(helpText())
  expect(help.startsWith('**Callboard commands**\n\n| Command | What it does |\n|---|---|\n| lanes |')).toBe(true)
  expect((await $.command.run(lane(''))).text).toBe(help)
  expect((await $.command.run(lane('  help '))).text).toBe(help)
  for (const origin of [{ kind: 'plugin' }, { kind: 'peer' }, { kind: 'script' }, null]) expect((await $.command.run(lane('help', origin))).text).toBe(help)
  for (const word of ['help me', 'helps', 'bogus']) expect((await $.command.run(lane(word))).text).toBe(USAGE)
  expect(logged(stdins)).toEqual([])
})

test('config: the person sets each setting from the prompt or the phone; it is stored, logged and printed; it is never a lane command', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  let want = { ...CONFIG_DEFAULTS }
  for (const [args, field, value, origin] of [
    ['keepalive off', 'keepalive', false, PERSON],
    ['ping 30', 'pingAfterMin', 30, { kind: 'bridge' }],
    ['stop 8', 'stopAfterH', 8, PERSON],
    ['working 900', 'workingK', 900, PERSON],
    ['idle 800k', 'idleK', 800, PERSON],
    ['checkin off', 'checkin', false, PERSON],
    ['conductor-leads off', 'conductorLeads', false, PERSON],
  ] as const) {
    want = { ...want, [field]: value }
    expect((await $.command.run(lane(`config ${args}`, origin))).text).toBe(configSetText(field, want))
    expect(h.store.get('config')).toEqual({ ...want, savedAt: h.nowMs })
    expect(logged(stdins).at(-1)).toBe(`config-set:${field}:${origin === PERSON ? 'prompt' : 'phone'}`)
  }
  expect((await $.command.run(lane('config'))).text).toBe(configText(want, false))
  expect(logged(stdins).some((x) => x.startsWith('command:lane') || x.startsWith('command:config'))).toBe(false)
  expect((await $.command.run(lane('status'))).text).toContain('| Lane | NONE |')
  expect((await $.command.run(lane('config reset'))).text).toBe(CONFIG_RESET_TEXT)
  expect(h.store.get('config')).toEqual({ ...CONFIG_DEFAULTS, savedAt: h.nowMs })
  expect(logged(stdins).at(-1)).toBe('config-set:reset:prompt')
})

test('config: a change from a plugin, another session or a script is refused with a fixed text and no dialog; nothing is written (D3)', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  const asked = h.askCount
  for (const [origin, code] of [[{ kind: 'plugin' }, 'plugin'], [{ kind: 'peer' }, 'session'], [{ kind: 'script' }, 'other']] as const) {
    for (const args of ['config keepalive off', 'config ping 30', 'config conductor-leads off', 'config reset']) expect((await $.command.run(lane(args, origin))).text).toBe(CONFIG_NOT_PERSON)
    expect(logged(stdins)).toContain(`refused:config-not-person:${code}`)
  }
  expect(h.askCount).toBe(asked)
  expect(h.store.has('config')).toBe(false)
})

test('config: out of range or unknown is refused with the usage; the two levels are checked against each other as stored', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  for (const args of ['config ping 29', 'config ping 56', 'config stop 9', 'config idle 149', 'config working 901', 'config ping 50 now', 'config loud on', 'config conductor-leads'])
    expect((await $.command.run(lane(args))).text).toBe(CONFIG_USAGE)
  expect(h.store.has('config')).toBe(false)
  expect((await $.command.run(lane('config idle 450'))).text).toBe('Raise working first (now 400k).')
  expect((await $.command.run(lane('config working 250'))).text).toBe('Lower idle first (now 300k).')
  expect(h.store.has('config')).toBe(false)
  // The check reads the stored levels, not this session's cache: another session raised working meanwhile.
  h.store.set('config', { workingK: 500, savedAt: h.nowMs })
  expect((await $.command.run(lane('config idle 450'))).text).toBe(configSetText('idleK', { ...CONFIG_DEFAULTS, idleK: 450, workingK: 500 }))
  expect(h.store.get('config')).toEqual({ ...CONFIG_DEFAULTS, idleK: 450, workingK: 500, savedAt: h.nowMs })
  expect(logged(stdins).filter((x) => x.startsWith('config-set'))).toEqual(['config-set:idleK:prompt'])
})

test('config: invalid stored fields fall back to their defaults, logged once per load', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  h.store.set('config', { keepalive: 'no', pingAfterMin: 99, stopAfterH: 2, idleK: 350, workingK: 450, path: '/etc/x', savedAt: 1 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run(lane('config'))).text).toBe(['**Callboard settings**', '', '| Setting | Value | Default |', '|---|---|---|', '| Keepalive | ON | ✓ |', '| Ping after | 50 min | ✓ |', '| Stop after | 2 h | 3 h |', '| Idle level | 350k | 300k |', '| Working level | 450k | 400k |', '| Check-ins | ON | ✓ |', '| Conductor leads | ON | ✓ |', '| Escalation | OFF | ✓ |'].join('\n'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(logged(stdins).filter((x) => x.startsWith('config-invalid'))).toEqual(['config-invalid:keepalive', 'config-invalid:pingAfterMin'])
})

longTest('config: a change another session stored reaches this session within a minute', async ($, on) => {
  await warm($, on)
  await h.clock!.advance(MIN)
  h.store.set('config', { pingAfterMin: 30, savedAt: h.nowMs })
  await advanceQuiet(28 * MIN)
  expect(pings()).toEqual([])
  await h.clock!.advance(MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

test('config: the nudge uses the configured idle level, in the hook and in the tick, and prints it', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('config idle 200'))
  h.tokensNow = 199_999
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  h.tokensNow = 210_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 200, workingK: 400 })])
  expect(nudges()[0]).toContain('Your context is past 200k tokens.')
})

test('config: a raised idle level records no nudge below it', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('config idle 350'))
  h.tokensNow = 349_999
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(logged(stdins).some((x) => x.startsWith('nudge-'))).toBe(false)
  h.tokensNow = 350_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 350, workingK: 400 })])
})

test('config: a working session gets the soft text at the idle level and the hard text at the configured working level', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('config working 450'))
  h.agentsNow = [{ status: 'running' }]
  h.tokensNow = 410_000
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 300, workingK: 450 })])
  expect(logged(stdins)).not.toContain('nudge-dropped:below-level')
  h.tokensNow = 450_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 300, workingK: 450 }), nudgeText('working', { idleK: 300, workingK: 450 })])
  expect(nudges()[1]).toContain('Your context is past 450k tokens.')
})

test('config: a lead is nudged from the idle level with the soft text and at the configured working level with the hard one', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('config working 450'))
  laneSeed.text = LEAD_LANES('/data/x/work')
  await $.command.run(lane('lead'))
  h.tokensNow = 299_999
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(logged(stdins).some((x) => x.startsWith('nudge-'))).toBe(false)
  h.tokensNow = 449_999
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 300, workingK: 450 })])
  h.tokensNow = 450_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle', { idleK: 300, workingK: 450 }), nudgeText('working', { idleK: 300, workingK: 450 })])
})

// ---- a ping whose submit fails or hangs, and a store call that throws ----
for (const [what, tokens] of [['the ping', 150_000], ['the nudge in its place', 310_000]] as const) {
  test(`a draft typed while the ping step reads stops ${what}: the gap is missed, logged once`, async ($, on) => {
    const stdins: string[] = []
    await warm($, on, stdins)
    h.tokensNow = tokens
    await advanceQuiet(50 * MIN - 2000)
    // The session.usage read comes after the idle check; the person starts typing meanwhile.
    h.usageHook = () => { h.draftNow = 'typing' }
    await h.clock!.advance(2000)
    expect(kaLog(stdins)).toEqual(['keepalive-skipped:late'])
    h.draftNow = ''
    await h.clock!.advance(5 * MIN)
    expect(pings()).toEqual([])
    expect(nudges()).toEqual([])
    expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
    expect(kaLog(stdins)).toEqual(['keepalive-skipped:late'])
  })
}

test('a ping whose submit fails after its prompt hook ran leaves no ping mark: the next turn moves the turn mark', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  await advanceQuiet(50 * MIN - 2000)
  h.submitFails = true
  // The engine runs the prompt hooks inside the submit, and the submit fails after them.
  h.submitHook = async (text) => { await $.prompt.submit({ text } as any).catch(() => undefined) }
  await h.clock!.advance(2000)
  expect(kaLog(stdins)).toEqual(['keepalive-failed:'])
  h.submitFails = false
  const mark = stv(trace, 'lastTurnAt')
  await h.clock!.advance(1000)
  await $.turn.start({ turnId: 'wake' } as any)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
})

// The handlers below throw at once, but the kit hands that to the mod as a rejected call, so this pins the answers and cannot tell a synchronous throw apart.
test('a store call that throws is answered: not read, or not saved', async ($, on) => {
  await person($, on)
  h.storeThrowSync = 'get'
  expect((await $.command.run(lane('config ping 40'))).text).toBe(CONFIG_UNREADABLE)
  h.storeThrowSync = 'set'
  expect((await $.command.run(lane('config ping 40'))).text).toBe(CONFIG_UNSAVED)
  h.storeThrowSync = undefined
  expect(h.store.has('config')).toBe(false)
})

// ---- a ping that hangs after its prompt hook, a prompt sent while the ping step reads, and the stop clock ----
test('a ping whose submit hangs past the timeout after its prompt hook ran keeps its mark: its turn is still a ping turn', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  const realEnd = stv(trace, 'realEndAt')
  await advanceQuiet(50 * MIN - 2000)
  h.submitHangs = true
  // The engine runs the prompt hooks inside the submit; the submit itself then does not confirm in 60 seconds (the ping is queued and may still run).
  h.submitHook = async (text) => {
    h.submitHangs = false
    await $.prompt.submit({ text } as any)
    h.submitHangs = true
  }
  await h.clock!.advance(2000)
  await h.clock!.advance(62_000)
  expect(kaLog(stdins)).toEqual(['keepalive-unconfirmed:'])
  h.submitHangs = false
  const mark = stv(trace, 'lastTurnAt')
  h.tokensNow = 400_000
  await h.clock!.advance(1000)
  await $.turn.start({ turnId: 'late-ping', text: framed(KEEPALIVE_TEXT) } as any)
  await $.turn.complete(TURN as any)
  expect(stv(trace, 'lastTurnAt')).toEqual(mark)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
})

test('a prompt the person sends while the ping step reads (the box already empty again) stops the ping: logged late', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await advanceQuiet(50 * MIN - 2000)
  // The session.usage read comes after the idle check; the person's prompt goes through its hooks meanwhile and the box is empty again.
  h.usageHook = async () => { await $.prompt.submit({ text: 'one more thing' } as any) }
  await h.clock!.advance(2000)
  expect(h.draftNow).toBe('')
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:late'])
})

// ---- keepalive: own submits the mod's prompt hook never sees, no ping while the Mac sleeps, the cache nudge ----
test('keepalive: a person\'s turn and a wake turn (no own text) restart the stop clock', async ($, on) => {
  const trace = newTrace()
  await warm($, on, [], trace)
  const first = stv(trace, 'realEndAt')
  await h.clock!.advance(MIN)
  await realTurn($, 'more')
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'realEndAt')).not.toBe(first)
  await h.clock!.advance(MIN)
  const mark = stv(trace, 'lastTurnAt')
  await $.turn.start({ turnId: 'wake', text: '' } as any)
  await $.turn.complete(TURN as any)
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
})

// A person's prompt while a ping is out and its turn has not run: typed while idle or mid-turn (turnId set, its turn comes later), its turn before or after
// the ping's. The person's turn is real; the ping's is a ping.
for (const [what, turnId, personFirst] of [
  ['typed while idle, its turn first', undefined, true],
  ['typed while idle, the ping\'s turn first', undefined, false],
  ['typed mid-turn (turnId set), its turn first', 'earlier', true],
  ['typed mid-turn (turnId set), the ping\'s turn first', 'earlier', false],
] as const) {
  test(`keepalive: a person's prompt ${what}: the person's turn is real, the ping's turn a ping`, async ($, on) => {
    const trace = newTrace()
    await warm($, on, [], trace)
    await advanceQuiet(50 * MIN)
    expect(pings()).toEqual([KEEPALIVE_TEXT])
    await h.clock!.advance(1000)
    await $.prompt.submit({ text: 'one more thing', ...(turnId ? { turnId } : {}) } as any)
    const person = async () => {
      await h.clock!.advance(1000)
      await $.turn.start({ turnId: 'p', text: 'one more thing' } as any)
      await $.turn.complete(TURN as any)
      expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
    }
    const ping = async () => {
      await h.clock!.advance(1000)
      const mark = stv(trace, 'lastTurnAt')
      const realEnd = stv(trace, 'realEndAt')
      await ownTurn($, KEEPALIVE_TEXT)
      expect(stv(trace, 'lastTurnAt')).toEqual(mark)
      expect(stv(trace, 'realEndAt')).toBe(realEnd)
    }
    if (personFirst) {
      await person()
      await ping()
    } else {
      await ping()
      await person()
    }
  })
}

test('keepalive: a ping that timed out and never ran leaves no wrong tag: the next person turn and the compaction resume turn are real', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  on('classic.PostCompact', () => ({}))
  await warm($, on, stdins, trace)
  h.submitHangs = true
  await advanceQuiet(50 * MIN)
  await h.clock!.advance(62_000)
  expect(kaLog(stdins)).toEqual(['keepalive-unconfirmed:'])
  h.submitHangs = false
  await h.clock!.advance(MIN)
  let mark = stv(trace, 'lastTurnAt')
  await realTurn($, 'hello')
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await ticks(1)
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' })
  await ticks(1)
  expect(submitted).toContain(compactResumeText(NOW.continuation))
  await h.clock!.advance(MIN)
  mark = stv(trace, 'lastTurnAt')
  await ownTurn($, compactResumeText(NOW.continuation))
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
})

test('keepalive: an own real submit (the compaction resume) starts a real turn, not one tagged by a ping out at the same time', async ($, on) => {
  const trace = newTrace()
  on('classic.PostCompact', () => ({}))
  await warm($, on, [], trace)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await ticks(1)
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' })
  await ticks(1)
  expect(submitted).toContain(compactResumeText(NOW.continuation))
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  // The resume's turn runs only now, with the ping still out.
  await h.clock!.advance(MIN)
  await ownTurn($, compactResumeText(NOW.continuation))
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  await h.clock!.advance(MIN)
  const realEnd = stv(trace, 'realEndAt')
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
})

test('keepalive: a turn that carries the ping text unframed (an engine that stops framing) is still the ping\'s', async ($, on) => {
  const trace = newTrace()
  await warm($, on, [], trace)
  const realEnd = stv(trace, 'realEndAt')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await h.clock!.advance(1000)
  const mark = stv(trace, 'lastTurnAt')
  await $.turn.start({ turnId: 'own', text: KEEPALIVE_TEXT } as any)
  await $.turn.complete(TURN as any)
  expect(stv(trace, 'lastTurnAt')).toEqual(mark)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
})

test('keepalive: a person\'s prompt that only contains the ping text is real, and leaves the ping\'s count to the ping\'s turn', async ($, on) => {
  const trace = newTrace()
  await warm($, on, [], trace)
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await h.clock!.advance(1000)
  const mark = stv(trace, 'lastTurnAt')
  await realTurn($, `What is this? ${KEEPALIVE_TEXT}\nIt came in overnight.`)
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
  await h.clock!.advance(1000)
  const realEnd = stv(trace, 'realEndAt')
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
})

test('keepalive: an engine that does show the mod its own ping (the old hook dispatch) counts it once: the ping turn stays a ping, a second turn with its text is real', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await warm($, on, stdins, trace)
  const realEnd = stv(trace, 'realEndAt')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
  await h.clock!.advance(1000)
  const mark = stv(trace, 'lastTurnAt')
  // The ping's prompt through the mod's own prompt.submit hook, then its turn.
  await $.prompt.submit({ text: KEEPALIVE_TEXT } as any)
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'lastTurnAt')).toEqual(mark)
  expect(stv(trace, 'realEndAt')).toBe(realEnd)
  // One ping went out, so it was counted down once: a stray second turn with its text is real.
  await h.clock!.advance(MIN)
  await ownTurn($, KEEPALIVE_TEXT)
  expect(stv(trace, 'realEndAt')).toBe(h.nowMs)
  expect(stv(trace, 'lastTurnAt')).not.toEqual(mark)
})

longTest('keepalive: a gap the Mac slept in (the clock jumped past 5 minutes between two timer calls) gets no ping, logged once; the next turn\'s gap pings again', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  await h.clock!.advance(20 * MIN)
  // The lid is closed for 10 minutes: no timer call in between.
  await sleepFor(10 * MIN)
  await h.clock!.advance(25 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:asleep'])
  await h.clock!.advance(5 * MIN)
  expect(pings()).toEqual([])
  expect(kaLog(stdins)).toEqual(['keepalive-skipped:asleep'])
  await realTurn($, 'morning')
  await h.clock!.advance(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

test('keepalive: a sleep before the last turn ended does not stop that gap\'s ping', async ($, on) => {
  await warm($, on)
  await sleepFor(10 * MIN)
  await h.clock!.advance(MIN)
  await realTurn($, 'after the wake')
  await advanceQuiet(50 * MIN)
  expect(pings()).toEqual([KEEPALIVE_TEXT])
})

for (const [what, arrange, cache] of [
  ['an idle session at 150k', () => { h.tokensNow = 150_000 }, true],
  ['an idle session below 150k', () => { h.tokensNow = 149_999 }, false],
  ['a working session (a background agent) at 200k', () => { h.tokensNow = 200_000; h.agentsNow = [{ status: 'running' }] }, false],
] as const) {
  test(`keepalive: after 2 pings since the real turn, the third slot of ${what} ${cache ? 'gets the cache nudge in place of the ping' : 'is a ping'}`, async ($, on) => {
    const stdins: string[] = []
    await warm($, on, stdins)
    arrange()
    for (let i = 1; i <= 2; i++) {
      await advanceQuiet(50 * MIN)
      expect(sent(stdins)).toBe(i)
      expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
      await h.clock!.advance(2000)
      await ownTurn($, KEEPALIVE_TEXT)
    }
    await advanceQuiet(50 * MIN)
    if (cache) {
      expect(logged(stdins)).toContain('nudge-due:cache')
      await h.clock!.advance(2000)
      expect(logged(stdins)).toContain('nudged:cache')
      expect(submitted.filter((t) => t === nudgeText('cache'))).toEqual([nudgeText('cache')])
      expect(sent(stdins)).toBe(2)
    } else {
      expect(sent(stdins)).toBe(3)
      expect(submitted.includes(nudgeText('cache'))).toBe(false)
      expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
    }
  })
}

test('keepalive: the ping count starts again at a real turn: its first slot is a ping, not the cache nudge', async ($, on) => {
  const stdins: string[] = []
  await warm($, on, stdins)
  h.tokensNow = 200_000
  for (let i = 1; i <= 2; i++) {
    await advanceQuiet(50 * MIN)
    await h.clock!.advance(2000)
    await ownTurn($, KEEPALIVE_TEXT)
  }
  expect(sent(stdins)).toBe(2)
  await realTurn($, 'back')
  await advanceQuiet(50 * MIN)
  expect(sent(stdins)).toBe(3)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
})
