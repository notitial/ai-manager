import { expect, test } from 'claude-code/testing'
import { h, GOOD, LANESDIR, ROOT, SID, T0, YES, engine, extraStat, laneSeed, longTest, modelRuns, renames, resultFiles, seen, storeFiles, submitted } from './harness'
import type { Trace } from './harness'
import { LEAD_LANES, MFOLDER, OTHER, PIN, REG, REGFILE, RESULT, STOREFILE, TURN, allEvents, bornStore, callCreate, creator, cue, cueSession, dirStat, events, fileStat, grantAt, lane, laneTarget, lateLane, lead, leadCall, logged, newTrace, nudges, pause, putStore, renameThroughTick, retireCue, retireTarget, settle, started, tickTwice, ticks, waitFor } from './fixtures'

test('a lead cue is written as a 0600 temp file and renamed into the target cue path', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await lead($, on, stdins, { argv })
  const r = await $.tool.call(leadCall('resume'))
  expect(r.result).toContain('cue resume acted for lane LABLANE')
  const cue = '/Users/x/.claude/callboard/cue'
  const mv = argv.find((a) => a[0] === '/bin/mv' && a.includes(`${cue}/${OTHER}.cue`))!
  expect(mv.slice(0, 3)).toEqual(['/bin/mv', '-f', '--'])
  expect(mv[3].startsWith(`${cue}/.${OTHER}.`)).toBe(true)
  expect(argv.some((a) => a[0] === '/usr/bin/install' && a[1] === '-m' && a[2] === '600' && a[4] === mv[3])).toBe(true)
  expect(stdins).toContain('resume\n')
})

const mvCue = (argv: string[][]) => argv.some((a) => a[0] === '/bin/mv' && a.some((x) => x.endsWith('.cue')))

longTest('a lead cue refuses a lead outside the lane repo, an unknown lane and a bad name', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  const cases: [string, string, string, string][] = [
    [LEAD_LANES('/data/x/work'), '/elsewhere', 'LABLANE', 'other-repo'],
    [LEAD_LANES('/data/x/work/lab'), '/data/x/work/other', 'LABLANE', 'other-repo'],
    [LEAD_LANES('/data/x/work'), '/data/x/work/lab', 'NOLANE', 'unknown-lane'],
    [LEAD_LANES('/data/x/work'), '/data/x/work/lab', '../x', 'bad-lane'],
  ]
  for (const [text, cwd, name, why] of cases) {
    laneSeed.text = text
    await grantAt($, cwd)
    expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: name })))).toContain(why)
  }
  expect(mvCue(argv)).toBe(false)
  laneSeed.text = LEAD_LANES('/data/x/work')
  await grantAt($, '/data/x/work/lab')
  expect((await $.tool.call(leadCall('start'))).result).toContain('cue start acted')
})

test('a lead cue refuses itself, an ambiguous name, a missing session and a session in another folder', async ($, on) => {
  const SELF = '0a1b2c3d-0000-4000-8000-123456789abc'
  const OTHER2 = '2a1b2c3d-0000-4000-8000-123456789abc'
  const argv: string[][] = []
  await lead($, on, [], { argv, clock: true })
  const cases: [Record<string, string>, string][] = [
    [cueSession(SELF, 'LABLANE'), 'self'],
    [{ ...cueSession(OTHER, 'LABLANE'), ...cueSession(OTHER2, 'LABLANE', '/data/x/work/lab', { pid: 4243 }) }, 'ambiguous'],
    [cueSession(OTHER, 'ELSE'), 'no-live-session'],
    [cueSession(OTHER, 'LABLANE', '/data/x/work/elsewhere'), 'wrong-folder'],
  ]
  for (const [sess, why] of cases) {
    h.sessions = sess
    const p = $.tool.call(leadCall('start'))
    for (let i = 0; i < 10; i++) await h.clock!.advance(500)
    expect(JSON.stringify(await p)).toContain(why)
  }
  expect(mvCue(argv)).toBe(false)
})

test('lane_start waits for a rename to be applied, then cues; it gives up after a few seconds', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { sess: cueSession(OTHER, undefined), argv, clock: true })
  const p = $.tool.call(leadCall('start'))
  await h.clock!.advance(500)
  h.sessions = cueSession(OTHER, 'LABLANE')
  for (let i = 0; i < 4; i++) await h.clock!.advance(500)
  expect(JSON.stringify(await p)).toContain('cue start acted')
  expect(mvCue(argv)).toBe(true)
})

test('lane_rename names the session by id, which must sit in the lane folder and be unnamed', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await lead($, on, stdins, { sess: cueSession(OTHER, undefined), argv })
  expect(JSON.stringify(await $.tool.call(leadCall('rename', { lane: 'LABLANE' })))).toContain('bad-sid')
  expect((await $.tool.call(leadCall('rename', { lane: 'LABLANE', sid: OTHER }))).result).toContain('cue rename acted')
  expect(stdins).toContain(`rename LABLANE ${SID}\n`)
  h.sessions = cueSession(OTHER, undefined, '/data/x/work/other')
  expect(JSON.stringify(await $.tool.call(leadCall('rename', { lane: 'LABLANE', sid: OTHER })))).toContain('wrong-folder')
  h.sessions = { ...cueSession(OTHER, undefined), ...cueSession('3a1b2c3d-0000-4000-8000-123456789abc', 'LABLANE', '/data/x/work/lab', { pid: 4243 }) }
  expect(JSON.stringify(await $.tool.call(leadCall('rename', { lane: 'LABLANE', sid: OTHER })))).toContain('name-in-use')
})

for (const [added, surface, expectOk] of [[1, 'a panel', true], [0, 'the terminal', true], [2, 'a rename that ran extra turns', false]] as const) {
  test(`a rename cue binds the lane through the tick (${surface}: ${added} turn${added === 1 ? '' : 's'} added)`, async ($, on) => {
    const stdins: string[] = []
    await renameThroughTick($, on, stdins, added)
    const names = allEvents(stdins).map((e) => `${e.event}:${e.reason}`)
    expect(names.some((n) => n.startsWith('error'))).toBe(false)
    expect(names).toContain('renamed:')
    expect(names.includes('refused:bind-turns-mismatch')).toBe(!expectOk)
    expect(h.cueFile!.present).toBe(false)
  })
}

test('a session renamed under one lane record refuses start and resume when the record changed, or when it left the lane folder', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  expect(allEvents(stdins).map((e) => e.event)).toContain('renamed')
  laneSeed.text = JSON.stringify({ lanes: [{ name: 'LABLANE', folder: '/data/x/work/lab', brief: '/data/x/work/lab/OTHER.md', repo: '/data/x/work' }] })
  await cue(43, 'start\n')
  expect(allEvents(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('refused:record-changed')
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.callerCwd = '/data/x/work/elsewhere'
  await cue(44, 'resume\n')
  expect(allEvents(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('refused:wrong-folder')
})

test('start refuses a brief that is bigger than 64 KB', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  extraStat.set('/data/x/work/lab/BRIEF.md', '501 644 1 Regular File 7 70000 1700000000\n')
  await cue(50, 'start\n')
  expect(allEvents(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('refused:brief-file')
  expect(allEvents(stdins).map((e) => e.event)).not.toContain('started')
})

test('creating a lane under a name that sits hidden in two stores does not write a duplicate', async ($, on) => {
  await creator($, on)
  await callCreate($)
  const app2 = '/Users/x/code/app2'
  extraStat.set(`${app2}/.git`, dirStat)
  storeFiles.set(`${LANESDIR}/${'b'.repeat(64)}.json`, JSON.stringify({ repo: app2, lanes: [{ name: 'API', folder: `${app2}/api`, brief: `${app2}/api/BRIEF.md`, createdAt: 1 }], creates: [] }))
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  const names = (JSON.parse(storeFiles.get(STOREFILE)!).lanes as { name: string }[]).map((l) => l.name)
  expect(names).toEqual(['API'])
})

// ---- v11: the target answers every cue, the lead reads the answer to its own cue ----

test('the target answers a cue with its outcome and the inode of the cue file it claimed', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  expect(resultFiles.get(RESULT)).toBe('rename ok - 42\n')
  laneSeed.text = JSON.stringify({ lanes: [{ name: 'LABLANE', folder: '/data/x/work/lab', brief: '/data/x/work/lab/OTHER.md', repo: '/data/x/work' }] })
  expect(await cue(43, 'start\n')).toBe('start refused record-changed 43\n')
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  expect(await cue(44, 'resume\n')).toBe('resume held not-idle 44\n')
})

test('a rename that ran extra turns is answered refused, not ok', async ($, on) => {
  await renameThroughTick($, on, [], 2)
  expect(resultFiles.get(RESULT)).toBe('rename refused bind-turns-mismatch 42\n')
})

test('a birth rename hashes the lane record first: a failed hash renames nothing and binds nothing', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace, async () => { h.recShaFails = true })
  expect(resultFiles.get(RESULT)).toBe('rename refused sha-failed 42\n')
  expect(renames).toEqual([])
  expect(trace.log).not.toContain('lane')
  h.recShaFails = false
  expect(await cue(43, 'rename LABLANE\n')).toBe('rename ok - 43\n')
  expect(renames).toEqual(['LABLANE'])
})

test('a birth rename that throws is answered rename-failed and binds nothing', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace, async () => { h.renameMode = 'throw' })
  expect(resultFiles.get(RESULT)).toBe('rename refused rename-failed 42\n')
  expect(renames).toEqual(['LABLANE'])
  expect(trace.log).not.toContain('lane')
})

// A state.set that throws cannot be built in the test kit: the engine skips a throwing hook and the write lands. The catch is defence only.
test('a binding write refused after the rename is answered bind-failed, not ok', async ($, on) => {
  const stdins: string[] = []
  const trace: Trace = { log: [], failCounters: false, failKeys: new Set(['lane']) }
  await renameThroughTick($, on, stdins, 1, trace)
  expect(resultFiles.get(RESULT)).toBe('rename refused bind-failed 42\n')
  expect(renames).toEqual(['LABLANE'])
  expect(trace.st!.get('lane')).toBeUndefined()
  expect(allEvents(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('refused:bind-failed')
})

test('the reader takes a cue up to 96 bytes and parses it; 97 bytes is refused before parsing (answered other, logged too-long)', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  const at = (n: number) => 'x'.repeat(n - 1) + '\n'
  for (const [ino, n, want] of [[60, 65, 'grammar'], [61, 96, 'grammar'], [62, 97, 'other']] as const) {
    h.cueFile = { ino, text: at(n), present: true }
    await tickTwice()
    expect(resultFiles.get(RESULT)).toBe(`- refused ${want} ${ino}\n`)
  }
  expect(logged(stdins).filter((e) => e === 'refused:too-long').length).toBe(1)
})

test('a cue refused before it is read is answered with verb - and its inode, once per cue file', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  expect(await cue(45, 'bogus\n')).toBe('- refused grammar 45\n')
  expect(await cue(46, 'start\n', { mode: '644' })).toBe('- refused other 46\n')
  resultFiles.delete(RESULT)
  await tickTwice()
  expect(h.cueFile.present).toBe(true)
  expect(resultFiles.has(RESULT)).toBe(false)
})

test('a cue replaced between the first look and the move is answered with the inode of the file moved and read, not claim-failed', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  h.cueFile = { ino: 90, text: 'bogus\n', present: true }
  h.cueSwapAtMv = { ino: 91 }
  await tickTwice()
  expect(resultFiles.get(RESULT)).toBe('- refused grammar 91\n')
  expect(h.cueFile.present).toBe(false)
  h.cueFile = { ino: 94, text: 'start\n', present: true }
  h.cueSwapAtMv = { ino: 95, mode: '644' }
  await tickTwice()
  expect(resultFiles.get(RESULT)).toBe('- refused other 95\n')
  expect(h.takenAs).toBeUndefined()
})

test('a cue that appears right after the move does not cost the moved cue its answer: each is answered in its own tick', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  h.cueFile = { ino: 92, text: 'bogus\n', present: true }
  h.cueNext = { ino: 93, text: 'bogus\n' }
  await h.clock!.advance(2000)
  expect(resultFiles.get(RESULT)).toBe('- refused grammar 92\n')
  expect(h.cueFile.present).toBe(true)
  await h.clock!.advance(2000)
  expect(resultFiles.get(RESULT)).toBe('- refused grammar 93\n')
  expect(h.cueFile.present).toBe(false)
})

test('a file already at the claim name is never taken for the cue: refused (other) with the cue inode, and the cue stays', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  h.cueFile = { ino: 98, text: 'bogus\n', present: true }
  h.takenPlanted = true
  await h.clock!.advance(2000)
  expect(resultFiles.get(RESULT)).toBe('- refused other 98\n')
  expect(h.cueFile.present).toBe(true)
  h.takenPlanted = false
  await h.clock!.advance(2000)
  expect(resultFiles.get(RESULT)).toBe('- refused grammar 98\n')
})

test('the start brief check is answered too', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  extraStat.set('/data/x/work/lab/BRIEF.md', '501 644 1 Regular File 7 70000 1700000000\n')
  expect(await cue(50, 'start\n')).toBe('start refused brief-file 50\n')
})

test('the lead reads the answer to its own cue: ok, a refusal with its fixed text, held with when to retry', async ($, on) => {
  await lead($, on, [])
  h.autoAnswer = 'refused start-done'
  let r = JSON.stringify(await $.tool.call(leadCall('start')))
  expect(r).toContain('lane_start refused: start-done: the lane already started once. Use lane_resume.')
  expect(r).toContain('Do not repeat this call unless the text says to retry.')
  h.autoAnswer = 'held not-idle'
  r = JSON.stringify(await $.tool.call(leadCall('resume')))
  expect(r).toContain('held, not-idle: the session is busy or waiting for the person. Retry once idle.')
  h.autoAnswer = 'refused obey-me-now'
  r = JSON.stringify(await $.tool.call(leadCall('resume')))
  expect(r).toContain('other: the session refused for a reason not shown here.')
  expect(r).not.toContain('obey')
  h.autoAnswer = 'ok -'
  expect((await $.tool.call(leadCall('resume'))).result).toBe('cue resume acted for lane LABLANE.')
  expect(resultFiles.size).toBe(0)
})

test('the lead removes an answer left from an earlier cue before it writes the next one', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv })
  await $.tool.call(leadCall('resume'))
  const rmAt = argv.findIndex((a) => a[0] === '/bin/rm' && a[a.length - 1] === `${ROOT}/result/${OTHER}.result`)
  const mvAt = argv.findIndex((a) => a[0] === '/bin/mv' && a[a.length - 1] === `${ROOT}/cue/${OTHER}.cue`)
  expect(rmAt).toBeGreaterThan(-1)
  expect(rmAt).toBeLessThan(mvAt)
})

longTest('an answer to an older cue, no answer, and an unsafe answer file all end in no-answer by the deadline', async ($, on) => {
  await lead($, on, [], { clock: true })
  h.autoIno = 11
  expect(await settle($.tool.call(leadCall('resume')))).toContain('no-answer: the session did not answer in time')
  h.autoIno = 12
  h.autoAnswer = undefined
  expect(await settle($.tool.call(leadCall('resume')))).toContain('no-answer')
  h.autoAnswer = 'ok -'
  for (const bad of ['502 600 1 Regular File 88 14 1700000000\n', '501 644 1 Regular File 88 14 1700000000\n', '501 600 2 Regular File 88 14 1700000000\n', '501 600 1 Regular File 88 65 1700000000\n', '501 600 1 Symbolic Link 88 14 1700000000\n', '501 600 1 Fifo File 88 0 1700000000\n']) {
    h.resultStat = bad
    expect(await settle($.tool.call(leadCall('resume')))).toContain('no-answer')
    expect(resultFiles.size).toBe(0)
  }
})

test('lane_start counts its wait for the rename against the one deadline', async ($, on) => {
  await lead($, on, [], { sess: cueSession(OTHER, undefined), clock: true })
  h.autoAnswer = undefined
  let done = false
  const p = $.tool.call(leadCall('start')).then((r: any) => {
    done = true
    return r
  })
  let ms = 0
  for (; ms < 3500; ms += 500) await h.clock!.advance(500)
  h.sessions = cueSession(OTHER, 'LABLANE')
  for (; !done && ms < 20_000; ms += 500) await h.clock!.advance(500)
  expect(JSON.stringify(await p)).toContain('no-answer')
  expect(ms).toBeLessThanOrEqual(7000)
})

test('session start drops answers older than 10 minutes and keeps newer ones', async ($, on) => {
  const argv: string[][] = []
  const old = `${'5'.repeat(8)}-0000-4000-8000-123456789abc.result`
  const fresh = `${'6'.repeat(8)}-0000-4000-8000-123456789abc.result`
  engine(on, argv, [])
  h.resultList = [{ name: old, kind: 'file', size: 14, mtimeMs: T0 - 11 * 60_000, isLink: false }, { name: fresh, kind: 'file', size: 14, mtimeMs: T0 - 60_000, isLink: false }, { name: '../x.result', kind: 'file', size: 1, mtimeMs: 0, isLink: false }]
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const removed = argv.filter((a) => a[0] === '/bin/rm').map((a) => a[a.length - 1])
  expect(removed).toContain(`${ROOT}/result/${old}`)
  expect(removed).not.toContain(`${ROOT}/result/${fresh}`)
  expect(removed.some((x) => x.includes('..'))).toBe(false)
})

test('a compact cue is answered ok when the compaction begins, before it has run', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  await $.tool.call(GOOD as any)
  await $.turn.complete(TURN as any)
  expect(await cue(60, 'compact\n')).toBe('compact ok - 60\n')
  expect(h.compactedAtAnswer).toBe(false)
  expect(seen.compacted).toBe(true)
  await tickTwice()
  expect(nudges()).toEqual([])
})

test('an answer file replaced while it is read is read again, not taken as it was', async ($, on) => {
  await lead($, on, [], { clock: true })
  h.autoAnswer = 'ok -'
  h.resultSwap = 'resume held not-idle 12\n'
  expect(await settle($.tool.call(leadCall('resume')))).toContain('held, not-idle')
})

test('a refused compact cue tells the lead the request is gone, not to retry', async ($, on) => {
  await lead($, on, [])
  h.autoAnswer = 'refused background-work'
  const r = JSON.stringify(await $.tool.call(leadCall('compact')))
  expect(r).toContain('background-work: any compaction request the session had is dropped; call lane_compact again only after that condition clears.')
  h.autoAnswer = 'refused stale'
  expect(JSON.stringify(await $.tool.call(leadCall('compact')))).toContain('stale: the cue was more than 2 minutes old when the session read it. Do not repeat')
})

test('compact cue refusals from the target: background work is refused, a busy session is held', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  await $.tool.call(GOOD as any)
  await $.turn.complete(TURN as any)
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  expect(await cue(62, 'compact\n')).toBe('compact held not-idle 62\n')
  h.sessions = { [REGFILE]: REG() }
  h.agentsNow = [{ status: 'running' }]
  expect(await cue(63, 'compact\n')).toBe('compact refused background-work 63\n')
})

test('two lead calls to one session take turns; one left with too little time does not send its cue', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv, clock: true })
  const cues = () => argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === `${ROOT}/cue/${OTHER}.cue`).length
  const [a, b] = await Promise.all([$.tool.call(leadCall('resume')), $.tool.call(leadCall('resume'))])
  expect(a.result).toBe('cue resume acted for lane LABLANE.')
  expect(b.result).toBe('cue resume acted for lane LABLANE.')
  expect(cues()).toBe(2)
  h.autoAnswer = undefined
  let secondAt = -1
  let ms = 0
  const first = $.tool.call(leadCall('resume'))
  const second = $.tool.call(leadCall('resume')).then((r: any) => {
    secondAt = ms
    return r
  })
  for (; ms < 10_000; ms += 500) await h.clock!.advance(500)
  expect(JSON.stringify(await first)).toContain('no-answer')
  expect(JSON.stringify(await second)).toContain('cue-busy')
  expect(secondAt).toBeLessThanOrEqual(3500)
  expect(cues()).toBe(3)
})

test('the lead leaves an answer that belongs to another cue in place', async ($, on) => {
  const argv: string[][] = []
  await lead($, on, [], { argv, clock: true })
  h.autoIno = 11
  expect(await settle($.tool.call(leadCall('resume')))).toContain('no-answer')
  expect(resultFiles.get(`${ROOT}/result/${OTHER}.result`)).toBe('resume ok - 11\n')
})

test('the lead refuses a result folder that is not a private folder of the user', async ($, on) => {
  await lead($, on, [])
  extraStat.set(`${ROOT}/result`, '501 755 2 Directory 11 64 1700000000\n')
  expect(JSON.stringify(await $.tool.call(leadCall('resume')))).toContain('unsafe-result-dir')
})

test('a cue left in place whose answer cannot be written logs a bounded number of lines', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  const before = allEvents(stdins).length
  extraStat.set(`${ROOT}/result`, '501 755 2 Directory 11 64 1700000000\n')
  h.cueFile = { ino: 70, text: 'start\n', present: true, mode: '644' }
  await ticks(10)
  const added = allEvents(stdins).slice(before).map((e) => `${e.event}:${e.reason}`)
  expect(added.filter((x) => x === 'error:result-write').length).toBe(1)
  expect(added.length).toBeLessThanOrEqual(3)
})

test('a compact cue that comes while the request is still in its turn is refused no-request with a retry hint, and the request stays', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  await $.tool.call(GOOD as any)
  expect(await cue(64, 'compact\n')).toBe('compact refused no-request 64\n')
  await $.turn.complete(TURN as any)
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('armed:on-cue')
})

// ---- #215 follow-ups: time limits inside the marks, restore after its dialog, the .taken sweep, a failed claim move ----
test('a birth rename that never returns gives up after the limit: answered rename-failed, the mark released, a lead grant then works', async ($, on) => {
  const stdins: string[] = []
  await laneTarget($, on, stdins)
  h.renameMode = 'hang'
  h.cueFile = { ino: 97, text: 'rename LABLANE\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  await h.clock!.advance(31_000)
  await pause()
  expect(resultFiles.get(RESULT)).toBe('rename refused rename-failed 97\n')
  expect(logged(stdins)).toContain('error:rename-timeout')
  h.askAnswer = YES
  expect((await $.command.run(lane('lead'))).text).toContain('Lead is on')
})

test('the .taken sweep removes only this session\'s old claim files, by the claim time in the name, at most once per 10 minutes', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await started($, on, stdins, { clock: true, argv })
  const old = T0 - 11 * 60_000
  const f = (name: string, kind = 'file', isLink = false) => ({ name, kind, isLink, mtimeMs: 0, size: 1 })
  h.cueList = [
    f(`${SID}.${old}.3.abc123.taken`),
    f(`${SID}.${T0 - 60_000}.4.def456.taken`),
    f(`${OTHER}.${old}.5.ghi789.taken`),
    f(`${SID}.${old}.6.jkl012.taken`, 'directory'),
    f(`${SID}.${old}.7.mno345.taken`, 'file', true),
    f(`${SID}.cue`),
  ]
  await h.clock!.advance(2000)
  await pause()
  const rms = () => argv.filter((a) => a[0] === '/bin/rm' && a[a.length - 1].includes('/cue/') && a[a.length - 1].endsWith('.taken')).map((a) => a[a.length - 1].split('/').pop())
  expect(rms()).toEqual([`${SID}.${old}.3.abc123.taken`, `${SID}.${old}.7.mno345.taken`])
  expect(argv.some((a) => a[0] === '/bin/rm' && a.includes('-r'))).toBe(false)
  expect(logged(stdins)).toContain('taken-swept:2')
  expect(logged(stdins)).toContain('error:taken-dir')
  await h.clock!.advance(2000)
  await pause()
  expect(rms().length).toBe(2)
  await h.clock!.advance(10 * 60_000)
  await pause()
  // The second sweep, ten minutes on: the leftovers the mock still lists go again, and the one that was young is now old too.
  expect(rms().length).toBe(5)
})

test('a claim whose move fails is answered claim-failed and leaves the cue in place', async ($, on) => {
  const stdins: string[] = []
  await laneTarget($, on, stdins)
  h.claimMvFails = true
  h.cueFile = { ino: 99, text: 'rename LABLANE\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  // claim-failed has no lead text, so the answer carries the code other; the log keeps the code.
  expect(resultFiles.get(RESULT)).toBe('- refused other 99\n')
  expect(logged(stdins)).toContain('refused:claim-failed')
  expect(h.cueFile?.present).toBe(true)
})

test('a birth rename that throws releases the lane mark: a second rename cue is not refused already-bound', async ($, on) => {
  await laneTarget($, on, [])
  h.renameMode = 'throw'
  h.cueFile = { ino: 95, text: 'rename LABLANE\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  expect(resultFiles.get(RESULT)).toBe('rename refused rename-failed 95\n')
  h.renameMode = 'ok'
  h.cueFile = { ino: 96, text: 'rename LABLANE\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  expect(resultFiles.get(RESULT)).not.toContain('already-bound')
})

test('a birth binding write that times out is answered bind-failed, frees the mark, and is undone when it lands', async ($, on) => {
  const stdins: string[] = []
  const late = lateLane()
  await laneTarget($, on, stdins, late.trace)
  h.cueFile = { ino: 93, text: 'rename LABLANE\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  await h.clock!.advance(31_000)
  await pause()
  expect(resultFiles.get(RESULT)).toBe('rename refused bind-failed 93\n')
  expect(logged(stdins)).toContain('error:bind-timeout')
  late.release()
  await waitFor(() => logged(stdins).includes('error:late-bind-undone'))
  h.askAnswer = YES
  expect((await $.command.run(lane('lead'))).text).toContain('Lead is on')
})
async function modelLane($: any, on: any, stdins: string[], model: string | undefined, opts: { trace?: Trace; brief?: boolean; mode?: 'ok' | 'stay' | 'throw' | 'hang'; now?: string } = {}) {
  laneSeed.text = undefined
  h.sessions = { [REGFILE]: REG({ cwd: MFOLDER }) }
  h.turnsAddedByRename = 1
  engine(on, [], stdins, true, opts.trace)
  on('tool.call', () => ({ result: {} }))
  putStore([{ name: 'LABLANE', folder: MFOLDER, brief: `${MFOLDER}/BRIEF.md`, createdAt: 1, ...(model ? { model } : {}) }])
  extraStat.set(`${PIN}/.git`, dirStat)
  extraStat.set(MFOLDER, dirStat)
  await $.session.start({ cwd: MFOLDER, surface: 'vscode', isInteractive: true })
  h.callerCwd = MFOLDER
  await $.command.run(lane('status'))
  expect(await cue(42, 'rename LABLANE\n')).toBe('rename ok - 42\n')
  if (opts.brief !== false) extraStat.set(`${MFOLDER}/BRIEF.md`, fileStat)
  h.modelMode = opts.mode ?? 'ok'
  if (opts.now) h.modelNow = opts.now
  await cue(43, 'start\n')
}

test('start runs /model for a record with a model, after the brief checks and before the start text', async ($, on) => {
  const stdins: string[] = []
  await modelLane($, on, stdins, 'opus')
  expect(resultFiles.get(RESULT)).toBe('start ok - 43\n')
  expect(modelRuns).toEqual(['opus@0'])
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain(`${MFOLDER}/BRIEF.md`)
  expect(logged(stdins)).toContain('started:')
})

test('start runs no /model when a brief check refuses', async ($, on) => {
  const stdins: string[] = []
  await modelLane($, on, stdins, 'opus', { brief: false })
  expect(logged(stdins)).toContain('refused:brief-file')
  expect(modelRuns).toEqual([])
})

test('start runs no /model for a lead-made record without a model', async ($, on) => {
  const stdins: string[] = []
  await modelLane($, on, stdins, undefined)
  expect(resultFiles.get(RESULT)).toBe('start ok - 43\n')
  expect(modelRuns).toEqual([])
  expect(submitted.length).toBe(1)
})

for (const [why, mode] of [['the session reports another model', 'stay'], ['/model throws', 'throw']] as const) {
  test(`start refuses model-failed when ${why}: no start text, startDone not set`, async ($, on) => {
    const stdins: string[] = []
    const trace = newTrace()
    await modelLane($, on, stdins, 'opus', { trace, mode })
    expect(modelRuns).toEqual(['opus@0'])
    expect(resultFiles.get(RESULT)).toBe('start refused model-failed 43\n')
    expect(logged(stdins)).toContain('refused:model-failed')
    expect(logged(stdins)).not.toContain('started:')
    expect(submitted).toEqual([])
    expect((trace.st!.get('counters')?.value as any)?.startDone).not.toBe(true)
  })
}

test('start refuses model-failed when /model never returns: no start text after the limit', async ($, on) => {
  const stdins: string[] = []
  await modelLane($, on, stdins, 'opus', { mode: 'hang' })
  await h.clock!.advance(5000)
  await pause()
  expect(modelRuns).toEqual(['opus@0'])
  expect(resultFiles.get(RESULT)).toBe('start refused model-failed 43\n')
  expect(submitted).toEqual([])
})

test('a session model name that holds the alias in any case is a match ("Haiku 5.5")', async ($, on) => {
  const stdins: string[] = []
  await modelLane($, on, stdins, 'haiku', { mode: 'stay', now: 'Haiku 5.5' })
  expect(modelRuns).toEqual(['haiku@0'])
  expect(resultFiles.get(RESULT)).toBe('start ok - 43\n')
})

// ---- the folder checks read the session's start folder ($.session.root()), not its shell directory ----
test('a lane whose shell has moved into a subfolder still answers retire and resume: the folder check reads the start folder', async ($, on) => {
  const stdins: string[] = []
  await retireTarget($, on, stdins)
  h.callerRoot = h.callerCwd
  h.callerCwd = `${h.callerCwd}/src`
  expect(await retireCue(70)).toBe('retire ok - 70\n')
})

test('a store lane whose shell moved into a subfolder still answers resume', async ($, on) => {
  await bornStore($, on, [])
  h.callerRoot = MFOLDER
  h.callerCwd = `${MFOLDER}/deep/dir`
  expect(await cue(71, 'resume\n')).toBe('resume ok - 71\n')
})
