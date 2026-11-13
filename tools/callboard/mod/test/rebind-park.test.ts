import { expect, test } from 'claude-code/testing'
import { refusalText, STOPPABLE_BY_NAME, RESTORE_YES, RESTORE_NO, ATTACH_YES, ATTACH_NO, SID_KEPT, reboundToast, restoreChangedToast, KEEPALIVE_TEXT, OFF_NOTHING } from '../hooks/core'
import { h, GOOD, LANESDIR, NO, OPEN_RESULT, PS_TABLE, ROOT, SESSIONS, SID, T0, YES, extraStat, laneSeed, longTest, psStartsGone, renames, resultFiles, storeFiles, teeTexts, toasts, toolDefs } from './harness'
import type { Trace } from './harness'
import { ATTACHED, ATTSESS, ATT_REC, KEY, LANES, LANE_COMPOSE, LANE_HINT, LEADSID, LEAD_LANES, MFOLDER, MIN, NEWSID, OTHER, OTHERLEAD, OWN_ROW, PARK_API, PIN, REG, REGFILE, RESULT, SELFREG, STATUS_NONE, STOREFILE, STORE_LANE, SVC, TWIN, allEvents, attRec, attacher, bornStore, callCreate, closeWrites, configRoot, cue, cueSession, doLane, drive, events, fileStat, grantAt, killed, lane, laneSections, lateLane, lead, leadAt, leadCall, leadReg, leadSelfReg, logged, newTrace, notices, ownReg, park, parkSess, parker, pause, pings, putStore, rebindAsks, rebinder, rebinds, recOf, renameThroughTick, sleepMs, started, statusText, storeJson, tickTwice, ticks, touched, turnEnds, unanswered, waitFor } from './fixtures'

test('a session that is not a lane writes no hint and no saved on; a lane writes a hint for its own session id only', async ($, on) => {
  await started($, on, [])
  await $.command.run(lane('on'))
  await $.command.run(lane('off'))
  expect([...h.store.keys()]).toEqual([])
  laneSeed.text = LANES
  try {
    h.store.set(`sess:${SID}`, { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 })
    await $.command.run(lane('lane'))
    expect([...h.store.keys()]).toEqual([`sess:${SID}`])
    expect(Object.keys(h.store.get(`sess:${SID}`) as any).sort()).toEqual(['counters', 'lane', 'savedAt'])
  } finally {
    laneSeed.text = undefined
  }
})

test('a forged hint cannot bind on its own, and with no lane in a store nothing is restored', async ($, on) => {
  const stdins: string[] = []
  const forged = { lane: { name: 'EVIL', at: 1, turns: 0 }, counters: { startDone: false }, savedAt: 1_700_000_000_000 }
  await started($, on, stdins, { seed: () => h.store.set(`sess:${SID}`, forged) })
  expect(allEvents(stdins).map((e) => e.event)).toContain('hint-found')
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('not enabled')
  await $.command.run(lane('lane'))
  expect(h.askCount).toBe(0)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(allEvents(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('hint-rejected:unknown-lane')
})

test('session start drops malformed, expired and foreign-looking hints and leaves other keys alone', async ($, on) => {
  const stdins: string[] = []
  const good = { counters: {}, savedAt: 1_700_000_000_000 }
  await started($, on, stdins, {
    seed: () => {
      h.store.set('sess:not-a-sid', good)
      h.store.set('sess:11111111-1111-4111-8111-111111111111', { savedAt: 1 })
      h.store.set('sess:22222222-2222-4222-8222-222222222222', 'text')
      h.store.set('sess:33333333-3333-4333-8333-333333333333', good)
      h.store.set('other', 1)
    },
  })
  expect([...h.store.keys()].sort()).toEqual(['other', 'sess:33333333-3333-4333-8333-333333333333'])
})

test('a restored binding can never start: turns -1, startDone, its own named question, and off unbinds it', async ($, on) => {
  const stdins: string[] = []
  const hint = { lane: { name: 'LABLANE', at: 1, turns: 0 }, counters: { startDone: false, lastCompactMs: 5 }, savedAt: 1_700_000_000_000 }
  await started($, on, stdins, { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
  expect((await $.command.run(lane('lane'))).text).toBe(reboundToast('LABLANE'))
  expect(h.lastQuestion).toBe("Restore this session as lane LABLANE?\nOnly if it was that lane's session.")
  expect((await $.command.run(lane('status'))).text).toContain('Lane: LABLANE. Lead: OFF.')
  const saved = h.store.get(`sess:${SID}`) as any
  expect(saved.lane).toMatchObject({ name: 'LABLANE', turns: -1, restored: true })
  expect(saved.counters.startDone).toBe(true)
  expect((await $.command.run(lane('off'))).text).toBe(`This session is no longer lane LABLANE.${STOPPABLE_BY_NAME('LABLANE')}`)
  expect(h.store.has(`sess:${SID}`)).toBe(false)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  laneSeed.text = undefined
})

test('declining the restore question binds no lane and goes on to the Join path', async ($, on) => {
  const stdins: string[] = []
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: 1_700_000_000_000 }
  try {
    await started($, on, stdins, { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    h.restoreAnswer = NO
    const r = await $.command.run(lane('lane'))
    expect(r.text).not.toBe(reboundToast('LABLANE'))
    expect(logged(stdins)).toContain('refused:restore-not-confirmed')
    expect(logged(stdins).filter((x) => x.startsWith('refused:') && x !== 'refused:restore-not-confirmed').length).toBe(1)
    expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  } finally {
    laneSeed.text = undefined
  }
})

test('an off that arrives while the restore dialog is open wins: /callboard lane stops and no second question opens', async ($, on) => {
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: 1_700_000_000_000 }
  try {
    await started($, on, [], { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    let release: (a: string) => void = () => undefined
    h.restoreHang = new Promise<string>((r) => (release = r))
    const first = $.command.run(lane('lane'))
    await new Promise((r) => setTimeout(r, 20))
    expect((await $.command.run(lane('lead', { kind: 'plugin', name: 'x' }))).text).toContain('question is already open')
    expect((await $.command.run(lane('lane'))).text).toContain('question is already open')
    expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
    const asked = h.askCount
    release(YES)
    expect((await first).text).toContain('turned off meanwhile')
    expect(h.askCount).toBe(asked)
    expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  } finally {
    laneSeed.text = undefined
  }
})

test('a restore merges the hint counters with the live ones and keeps the later compaction and every resume', async ($, on) => {
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: { lastCompactMs: T0 - 5000, resumeTimes: [T0 - 3000, T0 - 2000] }, savedAt: T0 }
  try {
    await started($, on, [], { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    await $.command.run(lane('lane'))
    const saved = (h.store.get(`sess:${SID}`) as any).counters
    expect(saved).toEqual({ lastCompactMs: T0 - 5000, startDone: true, resumeTimes: [T0 - 3000, T0 - 2000] })
  } finally {
    laneSeed.text = undefined
  }
})

test('a restore dialog that is dismissed is not a decision: the next /callboard lane asks again; a decline is final', async ($, on) => {
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 }
  try {
    await started($, on, [], { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    h.restoreAnswer = 'Something else'
    await $.command.run(lane('lane'))
    expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
    h.restoreAnswer = YES
    expect((await $.command.run(lane('lane'))).text).toBe(reboundToast('LABLANE'))
    expect((await $.command.run(lane('status'))).text).toContain('Lane: LABLANE. Lead: OFF.')
    await $.command.run(lane('off'))
    expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  } finally {
    laneSeed.text = undefined
  }
})

test('a declined restore is not asked again in the same session', async ($, on) => {
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 }
  try {
    await started($, on, [], { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    h.restoreAnswer = NO
    await $.command.run(lane('lane'))
    h.restoreAnswer = YES
    h.askedOptions = []
    await $.command.run(lane('lane'))
    expect(h.askedOptions.some((o) => o[0] === RESTORE_YES)).toBe(false)
    expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  } finally {
    laneSeed.text = undefined
  }
})

test('lane_open writes a request, waits for the window answer and returns the new session id', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { sess: {}, argv, clock: true })
  const p = $.tool.call(leadCall('open'))
  await h.clock!.advance(500)
  expect(h.openResult).toBeUndefined()
  h.openResult = `ok ${NEWSID}\n`
  await h.clock!.advance(500)
  const r = await p
  expect(r.result).toContain(`session ${NEWSID}`)
  const mv = argv.find((a) => a[0] === '/bin/mv' && a.includes('/Users/x/.claude/callboard/open/LABLANE.open'))!
  expect(mv.slice(0, 3)).toEqual(['/bin/mv', '-f', '--'])
  expect(stdins).toContain('open\n')
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toEqual(expect.arrayContaining(['open-requested:LABLANE', 'opened:LABLANE']))
})

test('lane_open refuses a lane that already has a live session and another repo', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv, clock: true })
  expect(JSON.stringify(await $.tool.call(leadCall('open')))).toContain('already carries')
  h.sessions = {}
  await grantAt($, '/elsewhere')
  expect(JSON.stringify(await $.tool.call(leadCall('open')))).toContain('other-repo')
  expect(argv.some((a) => a[0] === '/bin/mv' && a.some((x) => x.endsWith('.open')))).toBe(false)
})

test('lane_open reports a window error by its fixed code', async ($, on) => {
  await lead($, on, [], { sess: {}, clock: true })
  const p = $.tool.call(leadCall('open'))
  await h.clock!.advance(500)
  h.openResult = 'error timeout\n'
  await h.clock!.advance(500)
  expect(JSON.stringify(await p)).toContain('did not register in time')
})

test('lane_open points at the unnamed panel instead of opening another', async ($, on) => {
  await lead($, on, [], { sess: {}, clock: true })
  const p = $.tool.call(leadCall('open'))
  await h.clock!.advance(500)
  h.openResult = 'error unnamed-panel\n'
  await h.clock!.advance(500)
  const out = JSON.stringify(await p)
  expect(out).toContain('lane_rename')
  expect(out).toContain('wait 30 seconds and retry once')
})

test('lane_open refuses an answer that is not exactly ok or error', async ($, on) => {
  await lead($, on, [], { sess: {}, clock: true })
  const p = $.tool.call(leadCall('open'))
  await h.clock!.advance(500)
  h.openResult = 'ok not-a-session\n'
  await h.clock!.advance(500)
  expect(JSON.stringify(await p)).toContain('bad-result')
})

test('lane_open gives up after 8 seconds and withdraws its request', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { sess: {}, argv, clock: true })
  const p = $.tool.call(leadCall('open'))
  for (let i = 0; i < 17; i++) await h.clock!.advance(500)
  expect(JSON.stringify(await p)).toContain('no window answered in time')
  expect(argv.some((a) => a[0] === '/bin/rm' && a[a.length - 1] === '/Users/x/.claude/callboard/open/LABLANE.open')).toBe(true)
})

longTest('a question nobody answers in 90 seconds is not a decision: it says so, logs timed-out and toasts', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = cueSession(OTHER, 'LABLANE')
  await started($, on, stdins, { clock: true, argv })
  const plugin = { kind: 'plugin', name: 'x' }
  h.askHang = new Promise<string>(() => undefined)
  expect((await unanswered($.command.run(lane('lead', plugin)))).text).toBe('Lead stays off. The question timed out.')
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  h.askHang = undefined
  await grantAt($, '/data/x/work/lab')
  h.askHang = new Promise<string>(() => undefined)
  expect((await unanswered($.command.run(lane('lead', plugin)))).text).toBe('Lead stays on. The question timed out.')
  expect((await unanswered($.command.run(lane('off', plugin)))).text).toBe('Nothing changed: the question timed out.')
  expect((await $.command.run(lane('status'))).text).toBe('Lane: NONE. Lead: ON. Check-ins: ON.')
  expect(JSON.stringify(await unanswered($.tool.call(leadCall('terminate'))))).toContain('lane_terminate refused: the question timed out.')
  expect(argv.some((a) => a[0] === '/bin/kill')).toBe(false)
  expect((await unanswered($.command.run(lane('lead')))).text).toBe('Lead is now off. The question timed out.')
  expect(allEvents(stdins).filter((e) => e.event === 'refused' && e.reason === 'timed-out').length).toBeGreaterThan(0)
  expect(toasts.filter((t) => t === 'Question timed out. Nothing changed.').length).toBe(4)
  expect(toasts).toContain('Question timed out. Lead is off.')
})

test('a restore question that times out stays pending: the next /callboard lane asks it again', async ($, on) => {
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 }
  try {
    h.sessions = {}
    await started($, on, [], { clock: true, seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    h.restoreHang = new Promise<string>(() => undefined)
    const before = h.askCount
    // A question nobody answered ends /callboard lane; it does not go on to Join.
    expect((await unanswered($.command.run(lane('lane')))).text).toBe('Nothing changed: the question timed out.')
    expect(h.askCount).toBe(before + 1)
    expect(toasts).toContain('Question timed out. Lane not restored.')
    expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
    h.restoreHang = undefined
    const asks = h.askCount
    expect((await $.command.run(lane('lane'))).text).toBe(reboundToast('LABLANE'))
    expect(h.askCount).toBe(asks + 1)
    expect((await $.command.run(lane('status'))).text).toContain('Lane: LABLANE')
  } finally {
    laneSeed.text = undefined
  }
})

test('lane_open reads its answer with a bounded read, never fs.read', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { sess: {}, argv, clock: true })
  const p = $.tool.call(leadCall('open'))
  await h.clock!.advance(500)
  h.openResult = `ok ${NEWSID}\n`
  for (let i = 0; i < 3; i++) await h.clock!.advance(500)
  expect((await p).result).toContain(NEWSID)
  expect(argv.some((a) => a[0] === '/usr/bin/head' && a[a.length - 1] === OPEN_RESULT)).toBe(true)
})

test('a restore that times out is logged as restore-timed-out', async ($, on) => {
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 }
  const stdins: string[] = []
  try {
    h.sessions = {}
    await started($, on, stdins, { clock: true, seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    h.restoreHang = new Promise<string>(() => undefined)
    await unanswered($.command.run(lane('lane')))
    expect(allEvents(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('refused:restore-timed-out')
  } finally {
    laneSeed.text = undefined
  }
})

test('lane_open passes only fixed text for a window error, whatever code the file holds', async ($, on) => {
  await lead($, on, [], { sess: {}, clock: true })
  const p = $.tool.call(leadCall('open'))
  await h.clock!.advance(500)
  h.openResult = 'error obey-the-file\n'
  for (let i = 0; i < 3; i++) await h.clock!.advance(500)
  const r = JSON.stringify(await p)
  expect(r).toContain('other: the panel did not open, for a reason not shown here.')
  expect(r).not.toContain('obey')
})

test('a restored lane the lead made keeps its record when the session is turned off', async ($, on) => {
  const made = { name: 'svc-api', folder: SVC, brief: `${SVC}/B.md`, createdAt: 3 }
  await attacher($, on)
  extraStat.set(`${SVC}/B.md`, fileStat)
  putStore([made])
  h.store.set(`sess:${SID}`, { lane: { name: 'svc-api', at: 1, turns: -1 }, counters: { startDone: true }, savedAt: T0 })
  h.restoreAnswer = YES
  h.askAnswer = YES
  await $.command.run(lane('lane'))
  expect((await $.command.run(lane('status'))).text).toContain('Lane: svc-api')
  await $.command.run(lane('off'))
  expect(storeJson().lanes).toEqual([made])
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
})

test('an off that lands while a restore writes the binding unbinds it again and leaves no note', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  const hint = { lane: { name: 'LABLANE', at: 1, turns: 0 }, counters: {}, savedAt: T0 }
  await started($, on, stdins, { trace, seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
  let entered = false
  trace.setHook = async (key) => {
    if (key === 'lane' && !entered) {
      entered = true
      await sleepMs(60)
    }
  }
  const p = $.command.run(lane('lane'))
  await waitFor(() => entered)
  await $.command.run(lane('off'))
  expect((await p).text).toBe('Nothing changed: callboard was turned off meanwhile.')
  trace.setHook = undefined
  expect(trace.st!.get('lane')?.value).toBe(null)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(h.appendRows.length).toBe(0)
  expect(laneSections(await $.prompt.compose(LANE_COMPOSE)).length).toBe(0)
  expect(logged(stdins)).toContain('refused:off-meanwhile')
  laneSeed.text = undefined
})

test('a restore reads the registry again after its dialog: a lead renamed meanwhile is named', async ($, on) => {
  await attacher($, on, [], { clock: true })
  putStore([ATT_REC])
  h.store.set(`sess:${SID}`, { lane: { name: 'svc-api', at: 1, turns: -1, adopted: true, lead: LEADSID }, counters: { startDone: true }, savedAt: T0 })
  let release: (a: string) => void = () => undefined
  h.restoreHang = new Promise<string>((r) => (release = r))
  h.askAnswer = YES
  const p = $.command.run(lane('lane'))
  await waitFor(() => h.lastQuestion?.startsWith('Restore this session') === true)
  h.sessions = { ...leadReg({ nameSource: 'user' }), ...ownReg() }
  release(YES)
  await p
  expect((await $.command.run(lane('status'))).text).toContain('Lane: svc-api')
  expect(h.appendRows.length).toBe(1)
  expect(h.appendRows[0].content[0].text).toContain(`Your lead is \`LEAD\` (session \`${LEADSID}\`)`)
})

const restoreDuring = async ($: any, change: () => void | Promise<void>) => {
  putStore([ATT_REC])
  h.store.set(`sess:${SID}`, { lane: { name: 'svc-api', at: 1, turns: -1, adopted: true, lead: LEADSID }, counters: { startDone: true }, savedAt: T0 })
  let release: (a: string) => void = () => undefined
  h.restoreHang = new Promise<string>((r) => (release = r))
  // A restore refused here goes on to the Join question: Cancel keeps it to the restore.
  h.askAnswer = NO
  const p = $.command.run(lane('lane'))
  await waitFor(() => h.lastQuestion?.startsWith('Restore this session') === true)
  await change()
  release(YES)
  await p
}
const NOT_RESTORED = 'Lane svc-api not restored: things changed while the question was open.'

test('a restore whose lane is removed while its question is open binds nothing and says so', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  await restoreDuring($, () => { putStore([]) })
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
  expect(toasts).toContain(NOT_RESTORED)
  expect(logged(stdins)).toContain('hint-rejected:unknown-lane')
  expect(h.appendRows.length).toBe(0)
})

test('a restore whose name another session takes while its question is open stays pending and says so', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  await restoreDuring($, () => { h.sessions = { ...h.sessions, ...cueSession(TWIN, 'svc-api', SVC, { pid: 4777 }) } })
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
  expect(toasts).toContain(NOT_RESTORED)
  expect(logged(stdins)).toContain('hint-rejected:name-in-use')
})

test('a restore finds a binding written while its question was open: refused restore-already-bound, no second write', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await attacher($, on, stdins, { clock: true, trace })
  await restoreDuring($, () => { trace.st!.set('lane', { value: { name: 'OTHER', at: 5, turns: 0 }, version: 1 }) })
  expect(logged(stdins)).toContain('refused:restore-already-bound')
  expect(toasts).toContain(NOT_RESTORED)
  expect((trace.st!.get('lane')!.value as any).name).toBe('OTHER')
})

test('a restore binds the record as it is after its question: a record rewritten meanwhile is not refused record-changed later', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await restoreDuring($, () => { putStore([{ ...ATT_REC, brief: `${SVC}/NEW-BRIEF.md` }]) })
  expect((await $.command.run(lane('status'))).text).toContain('Lane: svc-api')
  expect(await cue(56, 'resume\n')).toBe('resume ok - 56\n')
})

test('a restore binding write that times out binds nothing, is not left pending, and is undone when it lands', async ($, on) => {
  const stdins: string[] = []
  const late = lateLane()
  await attacher($, on, stdins, { clock: true, trace: late.trace })
  putStore([ATT_REC])
  h.store.set(`sess:${SID}`, { lane: { name: 'svc-api', at: 1, turns: -1, adopted: true, lead: LEADSID }, counters: { startDone: true }, savedAt: T0 })
  h.askAnswer = NO
  h.restoreAnswer = YES
  const p = $.command.run(lane('lane'))
  await pause()
  await h.clock!.advance(31_000)
  await p
  expect(logged(stdins)).toContain('error:restore-bind-timeout')
  expect(toasts).not.toContain(NOT_RESTORED)
  late.release()
  await waitFor(() => logged(stdins).includes('error:late-bind-undone'))
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
})
const storeMvs = (argv: string[][]) => argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1].startsWith(`${LANESDIR}/`)).length
// A binding the test writes itself (another time), as a new binding of the same session.
const rebindAt = (trace: Trace, value: unknown) => trace.st!.set('lane', { value, version: (trace.st!.get('lane')?.version ?? 0) + 1 })

test('a session bound by a rename cue writes its id into its store record on the next tick', async ($, on) => {
  const stdins: string[] = []
  await bornStore($, on, stdins)
  expect(resultFiles.get(RESULT)).toBe('rename ok - 42\n')
  expect(recOf()).toEqual(STORE_LANE({ sid: SID }))
  expect(logged(stdins)).toContain('sid-healed:')
})

test('a rename that ended bind-turns-mismatch still gets its id written', async ($, on) => {
  const stdins: string[] = []
  await bornStore($, on, stdins, { added: 2 })
  expect(resultFiles.get(RESULT)).toBe('rename refused bind-turns-mismatch 42\n')
  expect(recOf().sid).toBe(SID)
})

test('a restore through the dialog writes the id; a record that names another sid is overwritten and parked is dropped', async ($, on) => {
  const stdins: string[] = []
  // A trace state: the tick then reads the binding the command wrote.
  await attacher($, on, stdins, { clock: true, trace: { log: [], failCounters: false } })
  putStore([{ ...ATT_REC, sid: OTHER, parked: T0 - 5 }])
  h.store.set(`sess:${SID}`, { lane: { name: 'svc-api', at: 1, turns: -1, adopted: true, lead: LEADSID }, counters: { startDone: true }, savedAt: T0 })
  h.askAnswer = YES
  await $.command.run(lane('lane'))
  expect((await $.command.run(lane('status'))).text).toContain('Lane: svc-api')
  await tickTwice()
  expect(storeJson().lanes).toEqual([{ ...ATT_REC, sid: SID }])
  expect(logged(stdins)).toContain('sid-healed:')
})

test('the sync runs once per binding: one store write over several ticks; a new binding of the same session runs it again', async ($, on) => {
  const argv: string[][] = []
  const trace = newTrace()
  await bornStore($, on, [], { trace, argv })
  expect(storeMvs(argv)).toBe(1)
  await tickTwice()
  putStore([STORE_LANE()])
  await tickTwice()
  expect(storeMvs(argv)).toBe(1)
  const b = trace.st!.get('lane')!.value as any
  rebindAt(trace, { ...b, at: b.at + 1 })
  await tickTwice()
  expect(storeMvs(argv)).toBe(2)
  expect(recOf().sid).toBe(SID)
})

test('a sync whose binding was cleared before its store write writes nothing', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await bornStore($, on, stdins, { trace })
  putStore([STORE_LANE()])
  const b = trace.st!.get('lane')!.value as any
  rebindAt(trace, { ...b, at: b.at + 1 })
  // The binding goes (as a /callboard off clears it) while the sync looks up the record.
  h.shaHook = () => rebindAt(trace, null)
  await tickTwice()
  expect(recOf().sid).toBeUndefined()
  expect(logged(stdins)).toContain('sid-heal-failed:changed')
})

test('a sync whose store write hangs times out, and the cue on the same tick is still claimed', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await bornStore($, on, stdins, { trace })
  putStore([STORE_LANE()])
  const b = trace.st!.get('lane')!.value as any
  rebindAt(trace, { ...b, at: b.at + 1 })
  h.storeHang = new Promise(() => undefined)
  h.cueFile = { ino: 60, text: 'resume\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  expect(resultFiles.get(RESULT)).toBe('rename ok - 42\n')
  await h.clock!.advance(60_000)
  await pause()
  expect(logged(stdins)).toContain('sid-heal-failed:timeout')
  expect(resultFiles.get(RESULT)).toBe('resume ok - 60\n')
})

test('after the sync wrote the session id, a resume cue still acts: sid is not part of the record hash', async ($, on) => {
  await bornStore($, on, [])
  expect(recOf().sid).toBe(SID)
  expect(await cue(50, 'resume\n')).toBe('resume ok - 50\n')
})

test('a sid-only or parked-only change of the store raises no lanes-changed turn in an idle lead; an added record still does', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  const api = { name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 1 }
  putStore([api])
  await tickTwice()
  expect(notices()).toBe(1)
  putStore([{ ...api, sid: OTHER }])
  await tickTwice()
  putStore([{ ...api, sid: OTHER, parked: T0 }])
  await tickTwice()
  expect(notices()).toBe(1)
  putStore([{ ...api, sid: OTHER }, attRec(SID)])
  await tickTwice()
  expect(notices()).toBe(2)
})

for (const cmd of ['off', 'lane off']) {
  test(`/callboard ${cmd} in a born store lane removes its session id from the record and says nothing more`, async ($, on) => {
    const stdins: string[] = []
    await bornStore($, on, stdins)
    expect(recOf().sid).toBe(SID)
    const r = await $.command.run(lane(cmd))
    expect(r.text).toContain('no longer lane LABLANE')
    expect(r.text).not.toContain('after a restart')
    expect(recOf()).toEqual(STORE_LANE())
    expect(logged(stdins)).toContain('sid-cleared:')
  })

  test(`/callboard ${cmd}: a session id that could not be cleared adds the restart sentence`, async ($, on) => {
    const stdins: string[] = []
    await bornStore($, on, stdins)
    h.storeWrites = 'fail'
    const r = await $.command.run(lane(cmd))
    expect(r.text.endsWith(SID_KEPT('LABLANE'))).toBe(true)
    expect(r.text).toContain(' It may become lane LABLANE again after a restart. If it does, run /callboard off again.')
    expect(logged(stdins)).toContain('sid-uncleared:')
  })
}

test('lane_create keeps another lane\'s sid and parked, and so does the removal of a lane by lane_terminate', async ($, on) => {
  await leadAt($, on, [])
  const old = { name: 'OLD', folder: SVC, brief: `${SVC}/B.md`, createdAt: 2, sid: OTHER, parked: 5 }
  putStore([old])
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  expect(recOf('OLD')).toEqual(old)
  h.askAnswer = YES
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'API' })))).toContain('lane API terminated and removed')
  expect(storeJson().lanes).toEqual([old])
})

test('lane_park keeps the record, and a park of a lane no live session carries is still refused no-live-session', async ($, on) => {
  const argv: string[][] = []
  await parker($, on, [], argv)
  expect((await park($)).result).toContain('lane API parked')
  expect(recOf('API')).toEqual(PARK_API({ sid: OTHER, parked: T0 }))
  h.sessions = leadSelfReg()
  putStore([PARK_API({ sid: OTHER })])
  expect(JSON.stringify(await park($))).toContain('lane_park refused: no-live-session')
  expect(recOf('API')).toEqual(PARK_API({ sid: OTHER }))
  expect(killed(argv).length).toBe(1)
})

test('lane_park sends a park cue and signals once on the target\'s ok; no report is read; the record is marked parked while the dying session still carries the name', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await parker($, on, stdins, argv)
  expect(toolDefs.filter((d) => d.includes('"lane_park"')).at(-1)).toContain("Park the lane's session: stop it and close its tab, but keep the conversation. lane_unpark reopens it later. The session must confirm first: idle for 30 seconds, an empty prompt box, no background agents or shells. No report is needed; the lane's record stays, the only stop that keeps it. The call itself waits up to 40 seconds for the idle time, so call it right after the lane's last turn; if it still refuses not-idle, wait the seconds it names and try once, never in a loop. Works for lanes you made and lanes a session joined. lane: the lane name.")
  const r = await park($)
  expect(r.result.startsWith('lane API parked: SIGTERM sent to process 4500. The tab closes and the conversation is kept. lane_unpark API reopens it.')).toBe(true)
  expect(stdins).toContain('park\n')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4500']])
  const names = logged(stdins)
  expect(names.indexOf('cued:park API')).toBeLessThan(names.indexOf('acted:park API'))
  expect(names.indexOf('acted:park API')).toBeLessThan(names.indexOf('parking:API'))
  expect(names).toContain('parked:API')
  expect(names).toContain('close-requested:API')
  expect(recOf('API')).toEqual(PARK_API({ sid: OTHER, parked: T0 }))
  expect(toasts).toContain('Park sent to lane API')
  expect(toasts).toContain('Lane API parked')
})

test('lane_park: the lead-side idle filter and process checks come first and send no cue', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await parker($, on, stdins, argv)
  h.fastSleep = () => undefined
  h.sessions = parkSess({ status: 'busy' })
  expect(JSON.stringify(await park($))).toContain('not-idle')
  h.sessions = parkSess()
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  expect(JSON.stringify(await park($))).toContain('pid-changed')
  expect(stdins).not.toContain('park\n')
  expect(killed(argv).length).toBe(0)
})

test('lane_park marks the record only after a kill that exited 0', async ($, on) => {
  const argv: string[][] = []
  await parker($, on, [], argv)
  h.killFails = true
  expect(JSON.stringify(await park($))).toContain('the signal failed')
  expect(recOf('API')).toEqual(PARK_API({ sid: OTHER }))
  expect(closeWrites(argv).length).toBe(0)
  h.killFails = false
  expect((await park($)).result).toContain('lane API parked')
  expect(recOf('API').parked).toBe(T0)
})

test('lane_park: the mark re-checks the lane after the signal; refused, the session is stopped and the result says so', async ($, on) => {
  const stdins: string[] = []
  await parker($, on, stdins)
  // The lane is removed once the signal went out (the close request is written between the signal and the mark).
  h.mvHook = (to) => { if (to.endsWith('/API.close')) storeFiles.set(STOREFILE, JSON.stringify({ ...JSON.parse(storeFiles.get(STOREFILE)!), lanes: [] })) }
  const r = await park($)
  expect(r.result.startsWith('lane API stopped: SIGTERM sent to process 4500. The conversation is kept, but the lane could not be marked parked, so lane_list shows no session for it. lane_unpark API still reopens it.')).toBe(true)
  expect(JSON.parse(storeFiles.get(STOREFILE)!).lanes).toEqual([])
  expect(logged(stdins)).toContain('park-unmarked:unknown-lane')
})

test('lane_park: a record without sid gets it before the signal; a failed write refuses the park and sends no signal', async ($, on) => {
  const argv: string[][] = []
  await parker($, on, [], argv, {})
  h.storeWrites = 'fail'
  const out = JSON.stringify(await park($))
  expect(out).toContain('lane_park refused: write-failed')
  expect(killed(argv).length).toBe(0)
  expect(recOf('API')).toEqual(PARK_API())
  h.storeWrites = 'ok'
  expect((await park($)).result).toContain('lane API parked')
  expect(recOf('API')).toEqual(PARK_API({ sid: OTHER, parked: T0 }))
})

test('lane_park: a mark that fails after the signal still leaves the session id in the record', async ($, on) => {
  const stdins: string[] = []
  await parker($, on, stdins, [], {})
  let n = 0
  h.storeWriteHook = () => { if (++n === 2) h.storeWrites = 'fail' }
  expect((await park($)).result).toContain('lane API stopped: SIGTERM sent to process 4500.')
  expect(recOf('API')).toEqual(PARK_API({ sid: OTHER }))
  expect(logged(stdins)).toContain('park-unmarked:write-failed')
})

test('lane_park parks an attached lane: the record gets sid and parked and keeps adopted and lead', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...ATTSESS() }, argv })
  putStore([attRec(OTHERLEAD)])
  expect((await park($, 'ATT')).result).toContain('lane ATT parked: SIGTERM sent to process 4500.')
  expect(recOf('ATT')).toEqual(attRec(OTHERLEAD, 'ATT', { sid: OTHER, parked: T0 }))
})

// The target side: a born lane, its own registry row (pid 4300) and no report at all.
async function parkTarget($: any, on: any, stdins: string[] = []) {
  await renameThroughTick($, on, stdins, 1)
  h.sessions = SELFREG()
}
const parkCue = (ino: number) => cue(ino, 'park\n')

test('a park cue is confirmed when idle with no draft, agents or shells, with no report at all', async ($, on) => {
  const stdins: string[] = []
  await parkTarget($, on, stdins)
  expect(h.reportFile).toBeUndefined()
  expect(await parkCue(90)).toBe('park ok - 90\n')
  expect(logged(stdins)).toContain('park-confirmed:LABLANE')
})

test('a park cue is held on a draft or a busy session, and refused while background work runs', async ($, on) => {
  await parkTarget($, on, [])
  h.draftNow = 'half'
  expect(await parkCue(91)).toBe('park held draft-in-box 91\n')
  h.draftNow = ''
  h.sessions = SELFREG({ status: 'busy' })
  expect(await parkCue(92)).toBe('park held not-idle 92\n')
  h.sessions = SELFREG()
  h.agentsNow = [{ status: 'running' }]
  expect(await parkCue(93)).toBe('park refused background-work 93\n')
  h.agentsNow = []
  h.psTable = `${PS_TABLE} 4320  4300 /bin/zsh -c sleep 150\n`
  expect(await parkCue(94)).toBe('park refused background-work 94\n')
})

test('lane_open and lane_rename refuse a parked lane; lane_open takes a record with sid and no parked', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  putStore([PARK_API({ name: 'LABLANE', sid: OTHER, parked: T0 })])
  expect(JSON.stringify(await $.tool.call(leadCall('open')))).toContain('lane_open refused: parked: that lane is parked. lane_unpark reopens its conversation. lane_retire or lane_terminate removes the lane.')
  expect(JSON.stringify(await $.tool.call(leadCall('rename', { lane: 'LABLANE', sid: NEWSID })))).toContain('lane_rename refused: parked:')
  expect(toolDefs.filter((d) => d.includes('"lane_open"')).at(-1)).toContain('Refused when a live session already carries the lane name. Refused for a parked lane: use lane_unpark.')
  expect(toolDefs.filter((d) => d.includes('"lane_list"')).at(-1)).toContain('whether a live session carries its name or it is parked, and how many minutes it has waited')
  putStore([PARK_API({ name: 'LABLANE', sid: OTHER })])
  const p = $.tool.call(leadCall('open'))
  await h.clock!.advance(500)
  h.openResult = `ok ${NEWSID}\n`
  await h.clock!.advance(500)
  expect((await p).result).toContain(`session ${NEWSID}`)
})

test('a rename cue for a parked lane is refused parked-lane by the session and binds nothing', async ($, on) => {
  await bornStore($, on, [], { rec: { sid: OTHER, parked: 5 } })
  expect(resultFiles.get(RESULT)).toBe('rename refused parked-lane 42\n')
  expect(renames).toEqual([])
})

// ---- lane_unpark ----
const UNPARK = (extra: Record<string, unknown> = {}) => PARK_API({ name: 'LABLANE', sid: OTHER, parked: T0 - 60_000, ...extra })
const REOPENPATH = `${ROOT}/open/LABLANE.reopen`
async function unparker($: any, on: any, stdins: string[] = [], argv: string[][] = [], rec: Record<string, unknown> = {}, sess: Record<string, string> = leadSelfReg()) {
  await leadAt($, on, stdins, { clock: true, argv, sess })
  putStore([UNPARK(rec)])
}
// The window answers as soon as the reopen request lands.
const windowAnswers = (text: string) => { h.mvHook = (to) => { if (to === REOPENPATH) h.openResult = text } }
const unparkCall = ($: any) => drive($.tool.call(leadCall('unpark')))
const reopenWrites = (argv: string[][]) => argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === REOPENPATH)

longTest('lane_unpark writes <LANE>.reopen with the record\'s sid, waits for ok, and clears parked', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await unparker($, on, stdins, argv)
  expect(toolDefs.filter((d) => d.includes('"lane_unpark"')).at(-1)).toContain("Reopen a lane's saved conversation in its VS Code window, with its full history. Use it for a parked lane, or one whose session was closed. Not for a retired lane: retire is final, so lane_open starts a new conversation for it. The session becomes the lane again by itself within a few seconds; then call lane_resume. lane: the lane name.")
  expect(toolDefs.filter((d) => d.includes('"lane_retire"')).at(-1)).toContain('Retire is final: the conversation cannot be reopened with lane_unpark. Use lane_park for a lane you may need again, the only stop that keeps the lane.')
  expect(toolDefs.filter((d) => d.includes('"lane_retire"')).at(-1)).toContain("Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and signed report stay; a lane a session joined keeps its record while a session carries it; a second stop removes it once the session is gone). A lane with no live session is removed directly, with no signed report.")
  expect(toolDefs.filter((d) => d.includes('"lane_retire"')).at(-1)).toContain("The call itself waits up to 40 seconds for the idle time, so call it right after the lane's last turn; if it still refuses not-idle, wait the seconds it names and try once, never in a loop.")
  windowAnswers(`ok ${OTHER}\n`)
  const r = await unparkCall($)
  expect(r.result.startsWith(`lane LABLANE reopened as session ${OTHER}. It becomes the lane again within a few seconds. Then call lane_resume. If lane_resume answers not-bound, wait 5 seconds and retry once.`)).toBe(true)
  const w = reopenWrites(argv)
  expect(w.length).toBe(1)
  expect(teeTexts.get(w[0][3])).toBe(`${OTHER}\n`)
  expect(recOf('LABLANE')).toEqual(PARK_API({ name: 'LABLANE', sid: OTHER }))
  expect(logged(stdins)).toEqual(expect.arrayContaining(['reopen-requested:LABLANE', 'reopened:LABLANE']))
  expect(toasts).toContain('Lane LABLANE reopened')
})

test('lane_unpark refuses a record with no saved session and an answer for another session', async ($, on) => {
  await unparker($, on, [], [], { sid: undefined, parked: undefined })
  expect(JSON.stringify(await $.tool.call(leadCall('unpark')))).toContain('lane_unpark refused: no-saved-session: that lane has no saved conversation. Use lane_open for a new session.')
  putStore([UNPARK()])
  windowAnswers(`ok ${NEWSID}\n`)
  expect(JSON.stringify(await unparkCall($))).toContain('lane_unpark refused: reopen-bad-result: the window opened another session than the saved one. Nothing was changed. Tell the person.')
  expect(recOf('LABLANE')).toEqual(UNPARK())
})

test('lane_unpark: one live row of that sid with the lane name that started after the park only clears the mark', async ($, on) => {
  const argv: string[][] = []
  await unparker($, on, [], argv, {}, { ...leadSelfReg(), ...cueSession(OTHER, 'LABLANE', `${PIN}/api`, { pid: 4500, startedAt: T0 }) })
  const r = await unparkCall($)
  expect(r.result.startsWith(`lane LABLANE is already live as session ${OTHER}. Its parked mark is cleared. Next: lane_resume.`)).toBe(true)
  expect(recOf('LABLANE')).toEqual(PARK_API({ name: 'LABLANE', sid: OTHER }))
  expect(reopenWrites(argv).length).toBe(0)
})

test('lane_unpark: a live row of that sid under another name refuses session-live; another session carrying the name refuses name-in-use', async ($, on) => {
  const argv: string[][] = []
  await unparker($, on, [], argv, {}, { ...leadSelfReg(), ...cueSession(OTHER, 'ELSE', `${PIN}/api`, { pid: 4500, startedAt: T0 }) })
  expect(JSON.stringify(await unparkCall($))).toContain("lane_unpark refused: session-live: that lane's conversation is already open in another session, maybe in a terminal.")
  h.sessions = { ...leadSelfReg(), ...cueSession(NEWSID, 'LABLANE', `${PIN}/api`, { pid: 4500, startedAt: T0 }) }
  expect(JSON.stringify(await unparkCall($))).toContain('lane_unpark refused: name-in-use: a live session already has that lane name.')
  expect(reopenWrites(argv).length).toBe(0)
  expect(recOf('LABLANE')).toEqual(UNPARK())
})

test('lane_unpark: a row of that sid whose pid start no longer matches counts as dead, and the reopen goes out', async ($, on) => {
  const argv: string[][] = []
  await unparker($, on, [], argv, {}, { ...leadSelfReg(), ...cueSession(OTHER, 'LABLANE', `${PIN}/api`, { pid: 4500, startedAt: T0 }) })
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  windowAnswers(`ok ${OTHER}\n`)
  expect((await unparkCall($)).result).toContain(`lane LABLANE reopened as session ${OTHER}.`)
  expect(reopenWrites(argv).length).toBe(1)
})

test('lane_unpark gives up after 8 seconds and withdraws its request; a window error gets the reopen text, not lane_open\'s', async ($, on) => {
  const argv: string[][] = []
  await unparker($, on, [], argv)
  expect(JSON.stringify(await unparkCall($))).toContain('lane_unpark refused: reopen-timeout: no window answered in time. A VS Code window with the lane folder as its first folder must run the callboard panels extension.')
  expect(argv.some((a) => a[0] === '/bin/rm' && a[a.length - 1] === REOPENPATH)).toBe(true)
  windowAnswers('error timeout\n')
  const out = JSON.stringify(await unparkCall($))
  expect(out).toContain('timeout: the conversation did not open in time. It may still open; call lane_list before you try again.')
  expect(out).not.toContain('lane_rename')
  windowAnswers('error live-elsewhere\n')
  expect(JSON.stringify(await unparkCall($))).toContain('live-elsewhere: that conversation is open outside VS Code, maybe in a terminal.')
  expect(recOf('LABLANE')).toEqual(UNPARK())
})

test('lane_unpark right after a park: a live row of that sid that started before the mark is waited for, and the reopen goes out once it is dead', async ($, on) => {
  const argv: string[][] = []
  await unparker($, on, [], argv, {}, { ...leadSelfReg(), ...cueSession(OTHER, 'LABLANE', `${PIN}/api`, { pid: 4500 }) })
  windowAnswers(`ok ${OTHER}\n`)
  const p = $.tool.call(leadCall('unpark'))
  for (let i = 0; i < 4; i++) await h.clock!.advance(500)
  expect(reopenWrites(argv).length).toBe(0)
  // The stopped process has exited: its pid no longer has that start time.
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  expect((await drive(p)).result).toContain(`lane LABLANE reopened as session ${OTHER}.`)
  expect(reopenWrites(argv).length).toBe(1)
})

test('lane_unpark: the parked process still live after 5 seconds refuses session-live; a record with sid and no mark reopens with no wait', async ($, on) => {
  const argv: string[][] = []
  await unparker($, on, [], argv, {}, { ...leadSelfReg(), ...cueSession(OTHER, 'LABLANE', `${PIN}/api`, { pid: 4500 }) })
  expect(JSON.stringify(await unparkCall($))).toContain('lane_unpark refused: session-live:')
  expect(reopenWrites(argv).length).toBe(0)
  h.sessions = leadSelfReg()
  putStore([UNPARK({ parked: undefined })])
  windowAnswers(`ok ${OTHER}\n`)
  const p = $.tool.call(leadCall('unpark'))
  await h.clock!.advance(500)
  expect(reopenWrites(argv).length).toBe(1)
  expect((await drive(p)).result).toContain(`lane LABLANE reopened as session ${OTHER}.`)
  expect(recOf('LABLANE')).toEqual(UNPARK({ parked: undefined }))
})

test('a park whose mark failed after the signal still leaves the session id, and lane_unpark then reopens the conversation', async ($, on) => {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...cueSession(OTHER, 'LABLANE', `${PIN}/api`, { pid: 4500 }) } })
  putStore([PARK_API({ name: 'LABLANE' })])
  let n = 0
  h.storeWriteHook = () => { if (++n === 2) h.storeWrites = 'fail' }
  expect((await drive($.tool.call(leadCall('park')))).result).toContain('lane LABLANE stopped: SIGTERM sent to process 4500.')
  expect(recOf('LABLANE')).toEqual(PARK_API({ name: 'LABLANE', sid: OTHER }))
  h.storeWrites = 'ok'
  h.storeWriteHook = undefined
  h.sessions = leadSelfReg()
  windowAnswers(`ok ${OTHER}\n`)
  expect((await unparkCall($)).result).toContain(`lane LABLANE reopened as session ${OTHER}.`)
})

test('after a park mark and an unpark clear, /callboard lane off in the attached lane still removes its record (found by its hash)', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane svc-api')
  const rec = storeJson().lanes[0]
  putStore([{ ...rec, parked: T0 }])
  putStore([{ ...rec }])
  expect((await doLane($, 'lane off')).text).toBe('This session is no longer lane svc-api.')
  expect(storeJson().lanes).toEqual([])
})

test('a session whose store record names its id rebinds from the tick as a restore binds: one note, a toast, and no Restore question later', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await rebinder($, on, stdins, { trace, hint: LANE_HINT() })
  expect(await statusText($)).toContain('Lane: NONE')
  await tickTwice()
  const b = trace.st!.get('lane')!.value as any
  expect(b).toMatchObject({ name: 'LABLANE', turns: -1, restored: true })
  expect(typeof b.rec).toBe('string')
  expect(b.adopted).toBeUndefined()
  expect((trace.st!.get('counters')!.value as any).startDone).toBe(true)
  expect(rebinds(stdins)).toEqual(['rebound:LABLANE'])
  expect(toasts).toContain(reboundToast('LABLANE'))
  expect(toasts).toContain('This session is lane LABLANE again.')
  expect(h.appendRows.length).toBe(1)
  expect(h.appendRows[0].content[0].text).toContain('You are lane `LABLANE`')
  expect((h.store.get(`sess:${SID}`) as any).lane).toMatchObject({ name: 'LABLANE', turns: -1, restored: true })
  await $.command.run(lane('lane'))
  expect(rebindAsks.some((q) => q.startsWith('Restore'))).toBe(false)
  expect(await statusText($)).toContain('Lane: LABLANE')
  expect(recOf()).toEqual(STORE_LANE({ sid: SID }))
})

test('a rebind merges the counters of its hint: a compaction 5 minutes before the restart still holds the 30-minute gap', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins, { hint: LANE_HINT({}, { lastCompactMs: T0 - 5 * 60_000, resumeTimes: [T0 - 60_000] }) })
  await tickTwice()
  expect(await statusText($)).toContain('Lane: LABLANE')
  expect((h.store.get(`sess:${SID}`) as any).counters).toMatchObject({ lastCompactMs: T0 - 5 * 60_000, startDone: true, resumeTimes: [T0 - 60_000] })
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('Compaction not allowed: rate-limit')
})

const NOT_REBOUND: [string, Parameters<typeof rebinder>[3], string][] = [
  ['a session in another folder', { cwd: '/elsewhere' }, 'rebind-rejected:wrong-folder'],
  ['a hint that names another lane', { hint: LANE_HINT({ name: 'OTHERLANE' }) }, 'rebind-rejected:hint-mismatch'],
  ['a hint that says attached for a lane the lead made', { hint: LANE_HINT({ adopted: true, lead: LEADSID }) }, 'rebind-rejected:hint-mismatch'],
]
for (const [what, opts, code] of NOT_REBOUND) {
  test(`no rebind for ${what}: logged once, and no retry`, async ($, on) => {
    const stdins: string[] = []
    await rebinder($, on, stdins, opts)
    await ticks(4)
    expect(await statusText($)).toContain('Lane: NONE')
    expect(rebinds(stdins)).toEqual([code])
    expect(toasts).not.toContain(reboundToast('LABLANE'))
    expect(toasts.filter((t) => t === 'Lane LABLANE did not rebind automatically. Run /callboard lane to restore it.')).toEqual(['Lane LABLANE did not rebind automatically. Run /callboard lane to restore it.'])
  })
}

test('a lead is never rebound into a lane: refused lead-holder, and the lead stays', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins)
  h.callerCwd = PIN
  await $.command.run(lane('lead'))
  h.callerCwd = MFOLDER
  await ticks(3)
  expect(rebinds(stdins)).toEqual(['rebind-rejected:lead-holder'])
  expect(await statusText($)).toContain('Lane: NONE. Lead: ON.')
  expect(toasts.some((t) => t.includes('did not rebind'))).toBe(false)
})

test('a parked record still rebinds, and the sync then drops the mark', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins, { rec: { parked: T0 - 60_000 } })
  await tickTwice()
  expect(rebinds(stdins)).toEqual(['rebound:LABLANE'])
  expect(recOf()).toEqual(STORE_LANE({ sid: SID }))
  expect(logged(stdins)).toContain('sid-healed:')
})

test('an attached record rebinds with the attached facts in the binding, and its record still goes at lane off', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await rebinder($, on, stdins, { trace, rec: { adopted: true, lead: LEADSID } })
  await tickTwice()
  expect(trace.st!.get('lane')!.value).toMatchObject({ name: 'LABLANE', turns: -1, restored: true, adopted: true, lead: LEADSID, key: KEY })
  expect(rebinds(stdins)).toEqual(['rebound:LABLANE'])
  await $.command.run(lane('lane off'))
  expect(storeJson().lanes).toEqual([])
})

test('a live row of this same session id carrying the lane name (the old process) does not block the rebind', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins, { sess: { [REGFILE]: REG({ cwd: MFOLDER }), '4311.json': REG({ cwd: MFOLDER, pid: 4311, name: 'LABLANE' }) } })
  await tickTwice()
  expect(rebinds(stdins)).toEqual(['rebound:LABLANE'])
})

test('another live session carrying the name holds the rebind back; once it is gone the rebind lands within the tries', async ($, on) => {
  const stdins: string[] = []
  const busy = { [REGFILE]: REG({ cwd: MFOLDER }), ...cueSession(OTHER, 'LABLANE', MFOLDER, { pid: 4500 }) }
  await rebinder($, on, stdins, { sess: busy })
  await ticks(3)
  expect(await statusText($)).toContain('Lane: NONE')
  expect(rebinds(stdins)).toEqual([])
  h.sessions = { [REGFILE]: REG({ cwd: MFOLDER }) }
  await ticks(2)
  expect(rebinds(stdins)).toEqual(['rebound:LABLANE'])
})

test('a name in use for all 15 tries is logged once as rebind-rejected name-in-use', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins, { sess: { [REGFILE]: REG({ cwd: MFOLDER }), ...cueSession(OTHER, 'LABLANE', MFOLDER, { pid: 4500 }) } })
  await ticks(20)
  expect(rebinds(stdins)).toEqual(['rebind-rejected:name-in-use'])
  expect(await statusText($)).toContain('Lane: NONE')
})

test('a registry read whose ps -p confirmation failed is not trusted: no rebind on it, and after 15 tries rebind-rejected registry-ps-confirm', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins, { sess: { [REGFILE]: REG({ cwd: MFOLDER }), ...cueSession(OTHER, 'GONE', MFOLDER, { pid: 4500 }) } })
  psStartsGone.add('4500')
  h.psConfirmFails = 'throw'
  await ticks(16)
  expect(await statusText($)).toContain('Lane: NONE')
  expect(rebinds(stdins)).toEqual(['rebind-rejected:registry-ps-confirm'])
})

test('a session that no store record names makes no registry read and is not looked at again', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await rebinder($, on, stdins, { argv, rec: { sid: OTHER } })
  await ticks(3)
  expect(argv.filter((a) => a[0] === '/usr/bin/head' && a[a.length - 1].startsWith(`${SESSIONS}/`)).length).toBe(0)
  const lanesReads = () => argv.filter((a) => a[0] === '/usr/bin/stat' && a[a.length - 1] === STOREFILE).length
  expect(lanesReads()).toBe(1)
  await ticks(2)
  expect(lanesReads()).toBe(1)
  expect(rebinds(stdins)).toEqual([])
})

test('no trusted own row until try 15: the rebind lands at try 15', async ($, on) => {
  const stdins: string[] = []
  h.ownEntryAuto = false
  await rebinder($, on, stdins, { sess: {} })
  h.ownEntryAuto = false
  await ticks(14)
  expect(rebinds(stdins)).toEqual([])
  h.sessions = { [REGFILE]: REG({ cwd: MFOLDER }) }
  await ticks(1)
  expect(rebinds(stdins)).toEqual(['rebound:LABLANE'])
})

test('no trusted own row by try 15: rebind-rejected registry-no-own-row, and no try 16', async ($, on) => {
  const stdins: string[] = []
  h.ownEntryAuto = false
  await rebinder($, on, stdins, { sess: {} })
  h.ownEntryAuto = false
  await ticks(15)
  expect(rebinds(stdins)).toEqual(['rebind-rejected:registry-no-own-row'])
  h.sessions = { [REGFILE]: REG({ cwd: MFOLDER }) }
  await ticks(2)
  expect(rebinds(stdins)).toEqual(['rebind-rejected:registry-no-own-row'])
  expect(await statusText($)).toContain('Lane: NONE')
})

test('a rebound lane answers a resume cue', async ($, on) => {
  await rebinder($, on, [])
  await tickTwice()
  expect(await cue(61, 'resume\n')).toBe('resume ok - 61\n')
})

test('a Restore question answered yes after the rebind landed shows no "things changed" toast', async ($, on) => {
  const stdins: string[] = []
  // A trace state: the question's handler then reads the binding the tick wrote meanwhile.
  await rebinder($, on, stdins, { hint: LANE_HINT(), trace: { log: [], failCounters: false } })
  let answer!: (v: string) => void
  h.restoreHang = new Promise((r) => (answer = r))
  const p = $.command.run(lane('lane'))
  await tickTwice()
  expect(rebindAsks.some((q) => q.startsWith('Restore'))).toBe(true)
  expect(rebinds(stdins)).toEqual(['rebound:LABLANE'])
  answer(YES)
  await p
  expect(await statusText($)).toContain('Lane: LABLANE')
  expect(logged(stdins)).toContain('refused:restore-already-bound')
  expect(toasts).toContain(reboundToast('LABLANE'))
  expect(toasts).not.toContain(restoreChangedToast('LABLANE'))
})

test('/callboard off in a born lane, then the session starts again: no rebind', async ($, on) => {
  const stdins: string[] = []
  await bornStore($, on, stdins)
  expect(recOf().sid).toBe(SID)
  await $.command.run(lane('off'))
  await $.session.start({ cwd: MFOLDER, surface: 'vscode', isInteractive: true })
  await ticks(3)
  expect(await statusText($)).toContain('Lane: NONE')
  expect(rebinds(stdins)).toEqual([])
})

test('the sid sync reads the start folder: a shell moved into a subfolder still writes the id', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await bornStore($, on, stdins, { trace })
  putStore([STORE_LANE()])
  const b = trace.st!.get('lane')!.value as any
  rebindAt(trace, { ...b, at: b.at + 1 })
  h.callerRoot = MFOLDER
  h.callerCwd = `${MFOLDER}/sub`
  await tickTwice()
  expect(recOf().sid).toBe(SID)
})

test('the rebind reads the start folder', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins)
  h.callerRoot = MFOLDER
  h.callerCwd = `${MFOLDER}/sub`
  await tickTwice()
  expect(rebinds(stdins)).toEqual(['rebound:LABLANE'])
})

test('/callboard off before a pending rebind lands cancels it and clears the record\'s session id', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins)
  expect((await $.command.run(lane('off'))).text).toBe('Lane LABLANE will not rebind automatically. Lane LABLANE no longer names this session.')
  expect(recOf()).toEqual(STORE_LANE())
  await ticks(3)
  expect(await statusText($)).toContain('Lane: NONE')
  expect(rebinds(stdins)).toEqual([])
  expect(logged(stdins)).toContain('sid-cleared:')
})

test('a rebind write that lands late is taken back without a detach: the record keeps its session id and the hint stays', async ($, on) => {
  const stdins: string[] = []
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const trace: Trace = { log: [], failCounters: false, setHook: (key) => (key === 'lane' ? gate : undefined) }
  await rebinder($, on, stdins, { trace, hint: LANE_HINT() })
  await ticks(20)
  expect(logged(stdins)).toContain('error:rebind-bind-timeout')
  open()
  await ticks(2)
  expect(logged(stdins)).toContain('error:late-rebind-undone')
  expect(trace.st!.get('lane')?.value ?? null).toBe(null)
  expect(recOf().sid).toBe(SID)
  expect(h.store.has(`sess:${SID}`)).toBe(true)
})

test('a rebind that ends refused tells the person; a lead is not told', async ($, on) => {
  await rebinder($, on, [], { cwd: '/elsewhere' })
  await ticks(2)
  expect(toasts).toContain('Lane LABLANE did not rebind automatically. Run /callboard lane to restore it.')
})

test('lane_unpark on a live lane with no parked mark answers already live after one poll, not after 5 seconds', async ($, on) => {
  await unparker($, on, [], [], { parked: undefined }, { ...leadSelfReg(), ...cueSession(OTHER, 'LABLANE', `${PIN}/api`, { pid: 4500, startedAt: T0 }) })
  const r = await drive($.tool.call(leadCall('unpark')), 2)
  expect(r.result.startsWith(`lane LABLANE is already live as session ${OTHER}.`)).toBe(true)
})

test('/callboard off whose session id clear fails still cancels a pending rebind, and says the lane may come back', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins)
  h.storeWrites = 'fail'
  const r = await $.command.run(lane('off'))
  expect(r.text).toBe(`Lane LABLANE will not rebind automatically.${SID_KEPT('LABLANE')}`)
  h.storeWrites = 'ok'
  await ticks(3)
  expect(await statusText($)).toContain('Lane: NONE')
  expect(rebinds(stdins)).toEqual([])
  expect(logged(stdins)).toContain('sid-uncleared:')
})

// ---- /callboard off during a rebind, and /callboard lane with a hint ----

test('/callboard off while a rebind is past its lanes read: no binding is written, and the sid stays cleared', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins)
  let offDone = false
  h.shaHook = () => $.command.run(lane('off')).then(() => (offDone = true))
  for (let i = 0; i < 20 && !offDone; i++) await h.clock!.advance(1000)
  expect(offDone).toBe(true)
  await ticks(3)
  expect(await statusText($)).toContain('Lane: NONE')
  expect(recOf()).toEqual(STORE_LANE())
  expect(logged(stdins).filter((x) => x.startsWith('rebound:'))).toEqual([])
})

test('/callboard off that has read no binding yet: a rebind tick while off is still running binds nothing', async ($, on) => {
  const stdins: string[] = []
  await rebinder($, on, stdins)
  let release!: () => void
  h.leadDeleteHang = { nth: 2, seen: 0, gate: new Promise<void>((r) => (release = r)) }
  let offDone = false
  const off = $.command.run(lane('off')).then(() => (offDone = true))
  for (let i = 0; i < 20 && h.leadDeleteHang.seen < 2; i++) await h.clock!.advance(1000)
  expect(h.leadDeleteHang.seen).toBe(2)
  await ticks(3)
  release()
  for (let i = 0; i < 20 && !offDone; i++) await h.clock!.advance(1000)
  await off
  await ticks(3)
  expect(await statusText($)).toContain('Lane: NONE')
  expect(logged(stdins).filter((x) => x.startsWith('rebound:'))).toEqual([])
})

test('/callboard lane from anything but the person restores nothing and asks nothing; a forged hint binds nothing without the person\'s Restore', async ($, on) => {
  const stdins: string[] = []
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 }
  try {
    await started($, on, stdins, { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'peer' }, null]) expect((await $.command.run(lane('lane', origin))).text).toBe(refusalText('lane-origin'))
    expect(h.askCount).toBe(0)
    expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
    h.restoreAnswer = 'Something else'
    await $.command.run(lane('lane'))
    expect(h.askedOptions[0]).toEqual([RESTORE_YES, RESTORE_NO])
    expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
    expect(logged(stdins)).not.toContain('restored:')
  } finally {
    laneSeed.text = undefined
  }
})

test('/callboard lane with a hint whose restore is refused goes on to the Join question, as with no hint', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  h.store.set(`sess:${SID}`, { lane: { name: 'GONE', at: 1 }, counters: {}, savedAt: T0 })
  expect((await doLane($)).text).toBe(ATTACHED())
  expect(logged(stdins)).toContain('hint-rejected:unknown-lane')
  expect(h.askedOptions).toEqual([[ATTACH_YES, ATTACH_NO]])
  expect((await $.command.run(lane('status'))).text).toBe("Lane: svc-api. Lead: OFF. This lane's lead: LEAD.")
})

test('/callboard lane with a hint whose Restore is declined goes on to the Join question', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  laneSeed.text = JSON.stringify({ lanes: [{ name: 'OLD', folder: SVC, brief: `${SVC}/B.md`, repo: PIN }] })
  try {
    h.store.set(`sess:${SID}`, { lane: { name: 'OLD', at: 1 }, counters: {}, savedAt: T0 })
    h.restoreAnswer = NO
    const r = await doLane($)
    expect(h.askedOptions[0]).toEqual([RESTORE_YES, RESTORE_NO])
    expect(logged(stdins)).toContain('refused:restore-not-confirmed')
    expect(h.askedOptions[1]).toEqual([ATTACH_YES, ATTACH_NO])
    expect(r.text).toBe(ATTACHED())
  } finally {
    laneSeed.text = undefined
  }
})

for (const env of [undefined, ''] as const) {
  longTest(`CLAUDE_CONFIG_DIR ${env === undefined ? 'unset' : 'empty'}: the own row is read from the default registry, as before, and the config folder is never touched`, async ($, on) => {
    const stdins: string[] = []
    const argv: string[][] = []
    await configRoot($, on, stdins, env, OWN_ROW(), argv)
    h.sessions = OWN_ROW()
    h.ownSessions = {}
    await turnEnds($)
    await h.clock!.advance(50 * MIN)
    expect(pings()).toEqual([KEEPALIVE_TEXT])
    expect(logged(stdins).some((x) => x.startsWith('error:config-dir-rejected'))).toBe(false)
    expect(touched(argv, '.claude-conductor')).toBe(false)
  })
}
