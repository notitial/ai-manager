import { expect, test } from 'claude-code/testing'
import { refusalText, LANES_CHANGED_NOTE, OFF_QUESTION, offLeavesLane, LEAD_YES, LEAD_NO, RESTORE_YES, RESTORE_NO, REASON_TEXT, OFF_NOTHING } from '../hooks/core'
import { h, GOOD, NO, ROOT, SID, T0, YES, extraStat, gitFiles, gitNoHead, laneSeed, leadFiles, longTest, realFails, realMap, resultFiles, statErr, storeFiles, toasts, toolDefs } from './harness'
import type { Trace } from './harness'
import { ATTACHED, LANES, LEADKEY, LEADPATH, LEADPS, LEADSID, LEAD_LANES, MFOLDER, NOT_ENABLED, OTHER, OTHERLEAD, PIN, REG, REGFILE, RESULT, SELFPATH, SELF_PS, STATUS_NONE, STORE_LANE, USAGE, allEvents, attRec, attacher, callCreate, created, creator, cue, cueSession, dirStat, doLane, drive, dropRec, grantAt, lane, laneTarget, lead, leadAt, leadCall, leadFileText, leadReg, leadSelfReg, listCall, logged, newTrace, notices, ownReg, pause, putStore, rebinder, rebinds, recOf, renameThroughTick, started, statusText, storeLaneNames, tickTwice, ticks } from './fixtures'

test('the lead scope is the cwd at the grant, not the live cwd', async ($, on) => {
  await lead($, on, [])
  h.callerCwd = '/elsewhere'
  expect((await $.tool.call(leadCall('start'))).result).toContain('cue start acted')
  await grantAt($, '/elsewhere')
  expect(JSON.stringify(await $.tool.call(leadCall('start')))).toContain('other-repo')
  h.callerCwd = '/data/x/work/lab'
  expect(JSON.stringify(await $.tool.call(leadCall('start')))).toContain('other-repo')
})

test('the lead question names the folder; a re-grant from a plugin keeps the first folder, one from the prompt or phone moves it', async ($, on) => {
  await lead($, on, [])
  expect(h.lastQuestion).toContain('lanes in work?')
  expect(h.lastQuestion).not.toContain('/data/x/work')
  h.callerCwd = '/elsewhere'
  const plugin = { kind: 'plugin', name: 'x' }
  h.askAnswer = YES
  await $.command.run(lane('lead', plugin))
  expect(h.lastQuestion).toBe('Asked from another plugin. Let this session lead the lanes in work?\nIt can create, start, resume, compact, park, stop and retire them.\nOnly a force stop asks you.\nLead stays on after a restart until you run /callboard off.')
  expect((await $.tool.call(leadCall('start'))).result).toContain('cue start acted')
  await $.command.run(lane('lead', { kind: 'bridge' }))
  expect(h.lastQuestion).toContain('lanes in elsewhere?')
  expect(JSON.stringify(await $.tool.call(leadCall('start')))).toContain('other-repo')
})

test('lead tools refuse before the grant and after lead off', async ($, on) => {
  const stdins: string[] = []
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = cueSession(OTHER, 'LABLANE')
  await started($, on, stdins)
  expect(JSON.stringify(await $.tool.call(leadCall('start')))).toContain('lead tools are off')
  await grantAt($, '/data/x/work/lab')
  expect((await $.tool.call(leadCall('start'))).result).toContain('cue start acted')
  expect((await $.command.run(lane('off'))).text).toContain('off')
  expect(JSON.stringify(await $.tool.call(leadCall('start')))).toContain('lead tools are off')
})

test('the dialog names a non-person origin, stays plain for the prompt and the phone, and the log keeps a fixed origin code', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins)
  h.askAnswer = NO
  const asked = () => (h.lastQuestion as string)
  await $.command.run(lane('lead'))
  expect(asked()).not.toContain('Asked from')
  await $.command.run(lane('lead', { kind: 'bridge' }))
  expect(asked()).not.toContain('Asked from')
  for (const [origin, words] of [[{ kind: 'plugin', name: 'evil <b>' }, 'another plugin'], [{ kind: 'peer' }, 'another session'], [{ kind: 'peer-send-message' }, 'another session'], [{ kind: 'sdk' }, 'a script'], [null, 'a script']] as const) {
    await $.command.run(lane('lead', origin))
    expect(asked()).toContain(`Asked from ${words}.`)
    expect(asked()).not.toContain('evil')
  }
  const codes = allEvents(stdins).filter((e) => e.event === 'command').map((e) => e.reason)
  expect(codes).toEqual(['lead:prompt', 'lead:phone', 'lead:plugin', 'lead:session', 'lead:session', 'lead:other', 'lead:other'])
})

test('off from the prompt or phone needs no dialog; off from anything else asks and changes nothing unless allowed', async ($, on) => {
  const stdins: string[] = []
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = cueSession(OTHER, 'LABLANE')
  await started($, on, stdins)
  await $.command.run(lane('lead'))
  expect((await $.command.run(lane('status'))).text).toContain('Lead: ON')
  for (const a of ['Deny', 'Cancel', '']) {
    h.askAnswer = a
    expect((await $.command.run(lane('off', { kind: 'plugin', name: 'x' }))).text).toContain('Cancelled. Nothing changed.')
    expect((await $.command.run(lane('status'))).text).toBe('Lane: NONE. Lead: ON. Check-ins: ON.')
  }
  h.askAnswer = YES
  expect((await $.command.run(lane('off', { kind: 'peer' }))).text).toBe('Lead is now off.')
  expect(h.lastQuestion).toBe('Asked from another session. Turn lead and lane off for this session?')
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  h.askAnswer = YES
  await $.command.run(lane('lead'))
  const asksBefore = h.askCount
  expect((await $.command.run(lane('off', { kind: 'bridge' }))).text).toBe('Lead is now off.')
  expect(h.askCount).toBe(asksBefore)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

test('a lead request from a non-person origin that times out or is dismissed keeps the grant; an explicit Deny clears it', async ($, on) => {
  const stdins: string[] = []
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = cueSession(OTHER, 'LABLANE')
  await started($, on, stdins)
  await $.command.run(lane('lead'))
  h.askAnswer = ''
  expect((await $.command.run(lane('lead', { kind: 'plugin', name: 'x' }))).text).toContain('Lead stays on.')
  expect((await $.command.run(lane('status'))).text).toContain('Lead: ON')
  h.askAnswer = NO
  expect((await $.command.run(lane('lead', { kind: 'plugin', name: 'x' }))).text).toContain('Lead is now off')
  expect((await $.command.run(lane('status'))).text).toContain('Lead: OFF')
})

test('a second lead or off while a question is open is refused busy, not queued; on answers its fixed text', async ($, on) => {
  const stdins: string[] = []
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = cueSession(OTHER, 'LABLANE')
  await started($, on, stdins)
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const first = $.command.run(lane('lead', { kind: 'plugin', name: 'x' }))
  await new Promise((r) => setTimeout(r, 20))
  const plugin = { kind: 'plugin', name: 'x' }
  const before = h.askCount
  for (const a of ['lead', 'off']) expect((await $.command.run(lane(a, plugin))).text).toContain('question is already open')
  expect((await $.command.run(lane('on', plugin))).text).toBe(USAGE)
  expect(h.askCount).toBe(before)
  expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
  release(NO)
  expect((await first).text).toContain('Lead stays off')
  const cmds = allEvents(stdins).filter((e) => e.event === 'command').map((e) => e.reason)
  expect(cmds).toContain('off:prompt')
  h.askHang = undefined
  h.askAnswer = YES
  expect((await $.command.run(lane('lead', plugin))).text).toContain('Lead is on')
  expect(allEvents(stdins).filter((e) => e.event === 'refused' && String(e.reason).startsWith('busy:')).map((e) => e.reason)).toEqual(['busy:lead:plugin', 'busy:off:plugin'])
})

test('the lead grant runs from any origin and needs the named answer', async ($, on) => {
  const stdins: string[] = []
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = cueSession(OTHER, 'LABLANE')
  await started($, on, stdins)
  for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'peer' }, { kind: 'bridge' }, null]) {
    h.askAnswer = NO
    expect((await $.command.run(lane('lead', origin))).text).toContain('Lead stays off')
  }
  for (const a of ['Cancel', 'give lead tools', '']) {
    h.askAnswer = a
    expect((await $.command.run(lane('lead'))).text).toContain('Lead stays off')
  }
  expect(JSON.stringify(await $.tool.call(leadCall('start')))).toContain('lead tools are off')
})

test('Deny on the lead dialog turns an earlier grant off, and off clears it even before any state call', async ($, on) => {
  await lead($, on, [])
  expect((await $.tool.call(leadCall('start'))).result).toContain('cue start acted')
  h.askAnswer = NO
  expect((await $.command.run(lane('lead'))).text).toContain('Lead is now off')
  expect(JSON.stringify(await $.tool.call(leadCall('start')))).toContain('lead tools are off')
  await grantAt($, '/data/x/work/lab')
  expect((await $.tool.call(leadCall('start'))).result).toContain('cue start acted')
  await $.command.run(lane('off'))
  expect(JSON.stringify(await $.tool.call(leadCall('start')))).toContain('lead tools are off')
})

test('the lead tools are for the main agent only', async ($, on) => {
  await lead($, on, [])
  expect(JSON.stringify(await $.tool.call({ ...leadCall('start'), agentId: 'a1' }))).toContain('main agent only')
})

test('the grant dialog says the lead can create lanes', async ($, on) => {
  await creator($, on)
  expect(h.lastQuestion).toContain('lead the lanes in')
  expect(h.lastQuestion).toContain('create, start, resume, compact, park, stop and retire them')
})

test('the level filter of a presence check runs before any process is asked: a file of another level or another repo costs no ps call, a lead file does', async ($, on) => {
  const argv: string[][] = []
  await attacher($, on, [], { argv, lead: false })
  const psCalls = () => argv.filter((a) => a[0] === '/bin/ps' && a.includes('-p') && a.includes('4242')).length
  for (const over of [{ level: 'manager', repo: undefined }, { level: 'conductor', repo: undefined, repos: [PIN], home: '/Users/x/code/cond' }, { level: 'lead', repo: '/Users/x/code/elsewhere' }]) {
    leadFiles.set(LEADPATH, { text: leadFileText(over) })
    expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('no-lead'))
    expect(psCalls()).toBe(0)
  }
  leadFiles.set(LEADPATH, { text: leadFileText() })
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect(psCalls()).toBeGreaterThan(0)
})

test('a presence file that is not a plain 0600 file of the user, one link, at most 4096 bytes, named by its own sid, is not a lead', async ($, on) => {
  await attacher($, on)
  const none = async () => expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('no-lead'))
  for (const f of [{ mode: '644' }, { mode: '660' }, { nlink: 2 }, { size: 4097 }, { uid: 502 }, { kind: 'Symbolic Link' }, { kind: 'Fifo File' }, { swap: true }]) {
    leadFiles.set(LEADPATH, { text: leadFileText(), ...f })
    await none()
  }
  for (const text of ['', '{', '[]', leadFileText({ sid: OTHER }), leadFileText({ pid: '4242' }), leadFileText({ repo: 'rel' }), leadFileText({ repo: `${PIN}/../app` }), `${leadFileText().slice(0, -1)},"x":"${'y'.repeat(4100)}"}`]) {
    leadFiles.set(LEADPATH, { text })
    await none()
  }
  leadFiles.delete(LEADPATH)
  leadFiles.set(`${ROOT}/leads/not-a-sid.json`, { text: leadFileText() })
  await none()
  leadFiles.set(LEADPATH, { text: leadFileText() })
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect(h.askCount).toBe(1)
})

test('the lead grant writes a presence file with four fields for a repo lane_create would accept; each tick and each lead tool call rewrites it', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true })
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text)).toEqual({ sid: SID, pid: 4400, procStart: LEADPS, repo: PIN })
  expect(leadFiles.get(SELFPATH)!.text.length).toBeLessThanOrEqual(256)
  const m0 = leadFiles.get(SELFPATH)!.mtimeSec!
  await h.clock!.advance(2000)
  expect(leadFiles.get(SELFPATH)!.mtimeSec!).toBe(m0 + 2)
  h.nowMs += 20_000
  await $.tool.call(listCall())
  expect(leadFiles.get(SELFPATH)!.mtimeSec!).toBe(m0 + 22)
})

const noPresence: [string, string, () => void][] = [
  ['too broad (the home folder)', '/Users/x', () => undefined],
  ['too broad (Documents)', '/Users/x/Documents', () => undefined],
  ['not a git root', PIN, () => extraStat.delete(`${PIN}/.git`)],
  ['not its own real path', PIN, () => realMap.set(PIN, '/Users/x/code/real-app')],
  ['the lead has no registry entry', PIN, () => ((h.sessions = {}), (h.ownEntryAuto = false))],
]
for (const [why, pin, setup] of noPresence) {
  test(`no presence file when the lead folder is ${why}; the grant itself still works`, async ($, on) => {
    await leadAt($, on, [], { clock: true })
    leadFiles.clear()
    extraStat.set(`${pin}/.git`, dirStat)
    setup()
    await grantAt($, pin)
    await tickTwice()
    expect(leadFiles.size).toBe(0)
    expect((await $.command.run(lane('status'))).text).toContain('Lead: ON')
  })
}

test('the presence file goes on off, on a Deny, at session start and at session end', async ($, on) => {
  await leadAt($, on, [], { clock: true, seed: () => leadFiles.set(SELFPATH, { text: leadFileText({ sid: SID }) }) })
  expect(leadFiles.has(SELFPATH)).toBe(true)
  h.askAnswer = NO
  await $.command.run(lane('lead'))
  expect(leadFiles.has(SELFPATH)).toBe(false)
  await h.clock!.advance(4000)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  await grantAt($, PIN)
  expect(leadFiles.has(SELFPATH)).toBe(true)
  await $.command.run(lane('off'))
  expect(leadFiles.has(SELFPATH)).toBe(false)
  await h.clock!.advance(4000)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  await grantAt($, PIN)
  expect(leadFiles.has(SELFPATH)).toBe(true)
  await $.session.end({} as any)
  expect(leadFiles.has(SELFPATH)).toBe(false)
})

test('a presence file left from an earlier run of this session is removed when the module loads', async ($, on) => {
  await started($, on, [], { seed: () => leadFiles.set(SELFPATH, { text: leadFileText({ sid: SID }) }) })
  expect(leadFiles.has(SELFPATH)).toBe(false)
})

test('a lead that is not allowed or not in the lane repo gets no presence file from a plugin re-grant that keeps the old folder', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.callerCwd = '/elsewhere'
  h.askAnswer = YES
  await $.command.run(lane('lead', { kind: 'plugin', name: 'x' }))
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text).repo).toBe(PIN)
})

test('a leads folder that is not a private folder of the user is not read', async ($, on) => {
  await attacher($, on)
  extraStat.set(`${ROOT}/leads`, '501 755 2 Directory 11 64 1700000000\n')
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('no-lead'))
  extraStat.delete(`${ROOT}/leads`)
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
})

test('a presence write that is still running when the lead is turned off does not bring the file back', async ($, on) => {
  await leadAt($, on, [])
  h.leadMvDelayMs = 30
  const call = $.tool.call(listCall())
  await new Promise((r) => setTimeout(r, 10))
  await $.command.run(lane('off'))
  await call
  await new Promise((r) => setTimeout(r, 60))
  expect(leadFiles.has(SELFPATH)).toBe(false)
})

test('a presence file is read with a bounded head', async ($, on) => {
  const argv: string[][] = []
  await attacher($, on, [], { argv })
  await doLane($, 'lane svc-api')
  expect(argv.some((a) => a[0] === '/usr/bin/head' && a[a.length - 1] === LEADPATH && a[2] === '4097')).toBe(true)
})

test('after off the lead tools refuse and carry no news of the lane list', async ($, on) => {
  await leadAt($, on, [])
  await $.command.run(lane('off'))
  putStore([attRec(SID)])
  const r = JSON.stringify(await $.tool.call(listCall()))
  expect(r).toContain('lead tools are off')
  expect(r).not.toContain(LANES_CHANGED_NOTE)
})

test('the presence reader looks at fresh files first: a live lead sorted after more than 64 stale files is still found', async ($, on) => {
  await attacher($, on, [], { lead: false })
  for (let i = 0; i < 70; i++) {
    const sid = `0000${String(i).padStart(4, '0')}-0000-4000-8000-123456789abc`
    leadFiles.set(`${ROOT}/leads/${sid}.json`, { text: leadFileText({ sid }), mtimeSec: T0 / 1000 - 200 })
  }
  leadFiles.set(LEADPATH, { text: leadFileText() })
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
})

test('a lead tick removes presence files older than ten minutes, of any session, and leaves younger ones', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  const old = `${ROOT}/leads/${OTHERLEAD}.json`
  const young = `${ROOT}/leads/7a1b2c3d-0000-4000-8000-123456789abc.json`
  leadFiles.set(old, { text: '{}', mtimeSec: T0 / 1000 - 601 })
  leadFiles.set(young, { text: '{}', mtimeSec: T0 / 1000 - 590 })
  await tickTwice()
  expect(leadFiles.has(old)).toBe(false)
  expect(leadFiles.has(young)).toBe(true)
  expect(leadFiles.has(SELFPATH)).toBe(true)
})

test('a presence file replaced while it was read gets one more read; one that changes every time is not a lead', async ($, on) => {
  await attacher($, on, [], { lead: false })
  leadFiles.set(LEADPATH, { text: leadFileText(), swap: 'once' })
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  await doLane($, 'lane off')
  storeFiles.clear()
  leadFiles.set(LEADPATH, { text: leadFileText(), swap: true })
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('no-lead'))
})

test('the off question from a plugin, a session or a script says it also leaves the lane; from the person it is asked as before', async ($, on) => {
  await attacher($, on)
  await doLane($, 'lane svc-api')
  h.askAnswer = NO
  await $.command.run(lane('off', { kind: 'peer' }))
  expect(h.lastQuestion).toBe(`Asked from another session. ${OFF_QUESTION}${offLeavesLane('svc-api')}`)
  await doLane($, 'lane off')
  storeFiles.clear()
  await $.command.run(lane('off', { kind: 'peer' }))
  expect(h.lastQuestion).toBe(`Asked from another session. ${OFF_QUESTION}`)
})

test('a lead presence file is accepted when its start time and the registry differ only in the blanks ps pads a one-digit day with', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane svc-api')
  leadFiles.set(`${ROOT}/leads/${LEADSID}.json`, { text: leadFileText({ procStart: 'Sun Nov  1 00:48:56 2026' }) })
  h.sessions = { ...leadReg({ procStart: 'Sun Nov 1 00:48:56 2026' }), ...ownReg() }
  h.psOut = 'Sun Nov  1 00:48:56 2026\n'
  expect(await cue(84, 'resume\n')).toBe('resume ok - 84\n')
})

test('a lead pinned at a parent repo does not answer for a lane of a nested repo: the lead repo must be the lane repo', async ($, on) => {
  await attacher($, on, [], { clock: true })
  h.sessions = { ...leadReg({ name: 'my lead' }), ...ownReg() }
  await doLane($, 'lane svc-api')
  const PARENT = '/Users/x/code'
  extraStat.set(`${PARENT}/.git`, dirStat)
  leadFiles.clear()
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243, repo: PARENT }) })
  h.sessions = { '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243 })['4242.json'], ...ownReg() }
  expect(await cue(85, 'resume\n')).toBe('resume refused no-lead 85\n')
  leadFiles.set(LEADPATH, { text: leadFileText() })
  h.sessions = { ...leadReg(), '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243 })['4242.json'], ...ownReg() }
  expect(await cue(86, 'resume\n')).toBe('resume ok - 86\n')
})

// ---- the presence pid, one git-root rule, a failed check is not a no ----
const GITFILE = '501 644 1 Regular File 9 40 1700000000\n'
const GITLINK = '501 755 1 Symbolic Link 9 12 1700000000\n'
const notGit: [string, () => void][] = [
  ['no .git', () => extraStat.delete(`${PIN}/.git`)],
  ['an empty .git folder', () => gitNoHead.add(`${PIN}/.git`)],
  ['a .git folder whose HEAD is a folder', () => extraStat.set(`${PIN}/.git/HEAD`, dirStat)],
  ['a symlinked .git', () => extraStat.set(`${PIN}/.git`, GITLINK)],
  ['a .git file that is not a gitdir line', () => { extraStat.set(`${PIN}/.git`, GITFILE); gitFiles.set(`${PIN}/.git`, 'hello\n') }],
]

const resetGit = () => {
  extraStat.set(`${PIN}/.git`, dirStat)
  extraStat.delete(`${PIN}/.git/HEAD`)
  gitNoHead.clear()
  gitFiles.clear()
}

test('lane_create: the pin is a git root only with a .git folder holding HEAD, or a gitdir: file', async ($, on) => {
  await creator($, on)
  for (const [why, make] of notGit) {
    resetGit()
    make()
    expect(JSON.stringify(await callCreate($)), why).toContain('pin-no-git')
  }
  resetGit()
  extraStat.set(`${PIN}/.git`, GITFILE)
  gitFiles.set(`${PIN}/.git`, 'gitdir: /Users/x/code/main/.git/worktrees/app\n')
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
})

test('a store is loaded, and a presence file written, only for a repo that passes the same git-root rule', async ($, on) => {
  await creator($, on)
  await callCreate($)
  h.sessions = cueSession(OTHER, 'API', `${PIN}/api`)
  for (const [why, make] of notGit) {
    resetGit()
    make()
    expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' }))), why).toContain('unknown-lane')
  }
  resetGit()
  expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' })))).not.toContain('unknown-lane')
})

for (const [why, make] of notGit) {
  test(`no presence file for a pin with ${why}`, async ($, on) => {
    laneSeed.text = undefined
    h.sessions = leadSelfReg()
    await started($, on, [], {})
    resetGit()
    make()
    await grantAt($, PIN)
    expect(leadFiles.has(SELFPATH)).toBe(false)
  })
}

test('an attached lane does not take a presence file whose pid is not a claude process, or whose repo is not a git root', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane svc-api')
  h.cueFile = { ino: 91, text: 'resume\n', present: true }
  h.psArgsOut = '/bin/sleep 1000\n'
  await tickTwice()
  expect(resultFiles.get(RESULT)).toBe('resume refused no-lead 91\n')
  h.psArgsOut = '/x/native-binary/claude --output-format stream-json\n'
  let ino = 100
  for (const [why, make] of notGit) {
    resetGit()
    make()
    resultFiles.delete(RESULT)
    h.cueFile = { ino: ++ino, text: 'resume\n', present: true }
    await tickTwice()
    // The lane's own store is skipped first (the same rule), so the cue never reaches the lead check: refused either way.
    expect(resultFiles.get(RESULT), why).toMatch(new RegExp(`^resume refused (no-lead|unknown-lane) ${ino}\\n$`))
  }
  resetGit()
  resultFiles.delete(RESULT)
  expect(await cue(93, 'resume\n')).toBe('resume ok - 93\n')
})

test('a presence check that failed is tried again at the next touch, at most five times, then the pin is cached as no and logged', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true, seed: () => realFails.set(PIN, { n: 1, err: 'realpath: Operation timed out' }) })
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(logged(stdins)).toContain('error:presence-check')
  await h.clock!.advance(2000)
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text)).toMatchObject({ sid: SID, repo: PIN })
})

test('five failed presence checks in a row cache the pin as no: no presence file even once the check works', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true, seed: () => realFails.set(PIN, { n: 5, err: 'realpath: Operation timed out' }) })
  await ticks(6)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(logged(stdins)).toContain('error:presence-git-error')
  expect(realFails.get(PIN)!.n).toBe(0)
})

test('a pin that is gone is a no at once, not retried', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true, seed: () => realFails.set(PIN, { n: 1, err: `realpath: ${PIN}: No such file or directory` }) })
  await h.clock!.advance(2000)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(logged(stdins)).not.toContain('error:presence-check')
})

// ---- one session is a lane or a lead, never both ----
const LANE_HOLDER = 'Lead stays off: this session is a lane, so it cannot be a lead. Run /callboard lane off first.'

test('a bound lane that runs /callboard lead is refused before any dialog, and gets no presence file', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  expect((await $.command.run(lane('status'))).text).toContain('LABLANE')
  const before = h.askCount
  h.askAnswer = YES
  expect((await $.command.run(lane('lead'))).text).toBe(LANE_HOLDER)
  expect(h.askCount).toBe(before)
  expect(leadFiles.has(`${ROOT}/leads/${SID}.json`)).toBe(false)
  expect(logged(stdins)).toContain('refused:lead-lane-holder')
})
const renameCue = (ino: number) => cue(ino, 'rename LABLANE\n')

test('a binding that lands while the lead question is open refuses the lead after the yes', async ($, on) => {
  const stdins: string[] = []
  // The test kit's own state did not show this hook a write that another hook made while the dialog was open (a read view per hook call?); the trace
  // store does. Whether the engine's state does is a live check (PR body).
  await laneTarget($, on, stdins, { log: [], failCounters: false })
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const p = $.command.run(lane('lead'))
  await new Promise((r) => setTimeout(r, 20))
  await renameCue(42)
  expect(resultFiles.get(RESULT)).toBe('rename ok - 42\n')
  release(YES)
  expect((await p).text).toBe(LANE_HOLDER)
  h.askHang = undefined
  expect(leadFiles.has(`${ROOT}/leads/${SID}.json`)).toBe(false)
  expect(logged(stdins)).toContain('refused:lead-lane-holder')
})

test('a lead that receives a rename cue refuses lead-holder and is not bound', async ($, on) => {
  const stdins: string[] = []
  await laneTarget($, on, stdins)
  h.askAnswer = YES
  h.askedOptions = []
  expect((await $.command.run(lane('lead'))).text).toContain('Lead is on')
  expect(h.askedOptions).toEqual([[LEAD_YES, LEAD_NO]])
  await renameCue(43)
  expect(resultFiles.get(RESULT)).toBe('rename refused lead-holder 43\n')
  expect((await $.command.run(lane('status'))).text).not.toContain('LABLANE')
})

test('a lead yes that lands while a rename cue is binding the session is refused, and the binding completes', async ($, on) => {
  const stdins: string[] = []
  await laneTarget($, on, stdins)
  let open: () => void = () => undefined
  h.renameGate = new Promise<void>((r) => (open = r))
  h.cueFile = { ino: 96, text: 'rename LABLANE\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  h.askAnswer = YES
  expect((await $.command.run(lane('lead'))).text).toBe(LANE_HOLDER)
  open()
  await pause()
  expect(resultFiles.get(RESULT)).toBe('rename ok - 96\n')
  expect((await $.command.run(lane('status'))).text).toContain('Lane: LABLANE. Lead: OFF.')
  expect(logged(stdins)).toContain('refused:lead-lane-holder')
})

test('a rename cue that lands while a lead grant is being set up is refused lead-holder, and the lead comes on', async ($, on) => {
  const stdins: string[] = []
  await laneTarget($, on, stdins)
  let open: () => void = () => undefined
  h.registerGate = new Promise<void>((r) => (open = r))
  h.askAnswer = YES
  const p = $.command.run(lane('lead'))
  await pause()
  h.cueFile = { ino: 97, text: 'rename LABLANE\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  expect(resultFiles.get(RESULT)).toBe('rename refused lead-holder 97\n')
  open()
  expect((await p).text).toContain('Lead is on')
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE. Lead: ON.')
})

test('a lead yes that lands while an attach is writing its record is refused, and the attach completes', async ($, on) => {
  await attacher($, on)
  h.storeMvDelayMs = 60
  const p = doLane($, 'lane svc-api')
  await pause()
  h.askAnswer = YES
  expect((await $.command.run(lane('lead'))).text).toBe(LANE_HOLDER)
  expect((await p).text).toBe(ATTACHED())
  expect((await $.command.run(lane('status'))).text).toContain('Lead: OFF.')
})

test('a pending restore is not taken while the session is a lead: refused, still pending, and taken after lead off', async ($, on) => {
  const stdins: string[] = []
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 }
  try {
    await started($, on, stdins, { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    h.askAnswer = YES
    h.restoreAnswer = 'Something else'
    await $.command.run(lane('lane'))
    expect((await $.command.run(lane('lead'))).text).toContain('Lead is on')
    h.restoreAnswer = YES
    h.askedOptions = []
    await $.command.run(lane('lane'))
    expect(h.askedOptions).not.toContainEqual([RESTORE_YES, RESTORE_NO])
    expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE. Lead: ON.')
    expect(logged(stdins)).toContain('refused:restore-lead-holder')
    await $.command.run(lane('off'))
    await $.command.run(lane('lane'))
    expect((await $.command.run(lane('status'))).text).toContain('Lane: LABLANE. Lead: OFF.')
  } finally {
    laneSeed.text = undefined
  }
})

test('a burst of lead tool calls against a failing presence check counts once: the pin is cached as no only after five ticks', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true, seed: () => realFails.set(PIN, { n: 99, err: 'realpath: Operation timed out' }) })
  for (let i = 0; i < 8; i++) await $.tool.call(leadCall('list', {}))
  expect(logged(stdins)).not.toContain('error:presence-git-error')
  await ticks(5)
  expect(logged(stdins)).toContain('error:presence-git-error')
})

test('lane_create says the pin could not be checked when the git check fails, not that it is no git root', async ($, on) => {
  await creator($, on)
  extraStat.set(`${PIN}/.git`, 'not a stat line\n')
  const r = JSON.stringify(await callCreate($))
  expect(r).toContain('pin-check-error')
  expect(r).not.toContain('pin-no-git')
})

test('"Not a directory" counts as absent: a pin whose .git check says so is no git root, and a store rewrite drops a lane whose folder says so', async ($, on) => {
  await creator($, on)
  extraStat.set(`${PIN}/svc`, dirStat)
  expect(JSON.stringify(await callCreate($, created({ name: 'SVC', folder: `${PIN}/svc` })))).toContain('lane SVC created')
  realFails.set(`${PIN}/svc`, { n: 99, err: `realpath: ${PIN}/svc: Not a directory` })
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  expect(storeLaneNames()).toEqual(['API'])
  realFails.delete(`${PIN}/svc`)
  dropRec('API')
  statErr.set(`${PIN}/.git`, `stat: ${PIN}/.git: Not a directory`)
  const r = JSON.stringify(await callCreate($))
  expect(r).toContain('pin-no-git')
  statErr.set(`${PIN}/.git`, `stat: ${PIN}/.git: Operation timed out`)
  expect(JSON.stringify(await callCreate($))).toContain('pin-check-error')
})

test('a lead grant whose tool registration never returns gives up after the limit; a second try waits on the same one; the mark is released', async ($, on) => {
  const stdins: string[] = []
  await laneTarget($, on, stdins)
  let open: () => void = () => undefined
  h.registerGate = new Promise<void>((r) => (open = r))
  h.askAnswer = YES
  const p = $.command.run(lane('lead'))
  await pause()
  await h.clock!.advance(31_000)
  expect((await p).text).toBe('Lead could not be set up.')
  expect(logged(stdins)).toContain('error:lead-register-timeout')
  const before = toolDefs.length
  const p2 = $.command.run(lane('lead'))
  await pause()
  open()
  expect((await p2).text).toContain('Lead is on')
  const added = toolDefs.slice(before)
  expect(added.length).toBeGreaterThan(0)
  expect(new Set(added).size).toBe(added.length)
  h.cueFile = { ino: 98, text: 'rename LABLANE\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  expect(resultFiles.get(RESULT)).toBe('rename refused lead-holder 98\n')
})

test('a lead grant whose tool registration throws releases the lead mark: a rename cue is then not refused lead-holder', async ($, on) => {
  await laneTarget($, on, [])
  h.registerGate = Promise.reject(new Error('refused'))
  h.registerGate.catch(() => undefined)
  h.askAnswer = YES
  expect((await $.command.run(lane('lead'))).text).toBe('Lead could not be set up.')
  h.registerGate = undefined
  h.cueFile = { ino: 94, text: 'rename LABLANE\n', present: true }
  await h.clock!.advance(2000)
  await pause()
  expect(resultFiles.get(RESULT)).not.toContain('lead-holder')
})
// A session that starts with a saved lead grant for PIN (or opts.pin), its own registry row in PIN.
async function leadRestarter($: any, on: any, stdins: string[], opts: { pin?: string; cwd?: string; savedAt?: number; raw?: unknown; trace?: Trace; argv?: string[][]; seed?: () => void; noStart?: boolean; interactive?: boolean } = {}) {
  laneSeed.text = undefined
  h.sessions = leadSelfReg()
  const start = started($, on, stdins, {
    clock: true,
    trace: opts.trace,
    argv: opts.argv,
    interactive: opts.interactive,
    seed: () => {
      extraStat.set(`${PIN}/.git`, dirStat)
      h.callerCwd = opts.cwd ?? opts.pin ?? PIN
      h.store.set(LEADKEY, opts.raw ?? { pin: opts.pin ?? PIN, savedAt: opts.savedAt ?? T0 - 60_000 })
      opts.seed?.()
    },
  })
  if (!opts.noStart) await start
  return { start }
}
const leadLogs = (stdins: string[]) => logged(stdins).filter((x) => x.startsWith('lead-restore') || x === 'lead-unsaved:')

test('the lead grant is saved in the store at the grant, and removed by off and by Cancel', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  expect(h.store.get(LEADKEY)).toEqual({ pin: PIN, savedAt: T0 })
  await $.command.run(lane('off'))
  expect(h.store.has(LEADKEY)).toBe(false)
  await grantAt($, PIN)
  expect(h.store.has(LEADKEY)).toBe(true)
  h.askAnswer = NO
  await $.command.run(lane('lead'))
  expect(await statusText($)).toContain('Lead: OFF')
  expect(h.store.has(LEADKEY)).toBe(false)
})

test('a session whose saved grant names its own folder is lead again at start: no question, no second note, tools serve, presence on the first tick', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins)
  expect(await statusText($)).toContain('Lead: ON')
  expect(h.askCount).toBe(0)
  expect(h.appendRows.length).toBe(0)
  expect(logged(stdins)).toContain('lead-restored:')
  expect(toasts).toContain('Lead is on again for app.')
  expect(h.store.get(LEADKEY)).toEqual({ pin: PIN, savedAt: T0 })
  expect(JSON.stringify(await $.tool.call(listCall()))).not.toContain('lead tools are off')
  leadFiles.delete(SELFPATH)
  await h.clock!.advance(2000)
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text)).toMatchObject({ sid: SID, repo: PIN })
  await grantAt($, PIN)
  expect(h.appendRows.length).toBe(0)
})

test('a restored lead watches the lane list from its first tick: a record added later is news, what was there before is not', async ($, on) => {
  await leadRestarter($, on, [], { seed: () => putStore([{ name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 1 }]) })
  await tickTwice()
  expect(notices()).toBe(0)
  putStore([{ name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 1 }, attRec(SID)])
  await tickTwice()
  expect(notices()).toBe(1)
})

test('a saved grant for another folder: no lead, and the key is deleted', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, { cwd: `${PIN}/svc` })
  expect(await statusText($)).toContain('Lead: OFF')
  expect(h.store.has(LEADKEY)).toBe(false)
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:wrong-folder'])
})

test('a saved grant that does not parse is deleted at start', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, { raw: { pin: '/', savedAt: T0 } })
  expect(await statusText($)).toContain('Lead: OFF')
  expect(h.store.has(LEADKEY)).toBe(false)
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:invalid'])
})

test('a cwd read that throws in session.start: the tick finishes the restore once cwd answers', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, { seed: () => (h.cwdThrows = 1) })
  expect(await statusText($)).toContain('Lead: OFF')
  await h.clock!.advance(2000)
  expect(await statusText($)).toContain('Lead: ON')
  expect(logged(stdins)).toContain('lead-restored:')
})

test('a cwd that never answers in 15 ticks: no lead, the key kept, logged once', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, { seed: () => (h.cwdThrows = 1000) })
  await ticks(14)
  expect(leadLogs(stdins)).toEqual([])
  await ticks(3)
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:cwd-unreadable'])
  h.cwdThrows = 0
  expect(await statusText($)).toContain('Lead: OFF')
  expect(h.store.has(LEADKEY)).toBe(true)
})

test('a saved grant beside another live lead with no usable name is not restored: the key is kept and the person is told', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, {
    seed: () => {
      h.sessions = { ...leadSelfReg(), '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243, name: 'LEAD A' })['4242.json'] }
      leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
    },
  })
  expect(await statusText($)).toContain('Lead: OFF')
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:other-lead-unnamed'])
  expect(toasts).toContain('Lead not restored: another lead in this repo has no usable name; it must /rename first, or be turned off. Run /callboard lead.')
  expect(h.store.has(LEADKEY)).toBe(true)
})

test('a lead restore whose session list cannot be read yet is tried again from the tick, and restores once it can', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, { seed: () => (h.sessionsUnsafe = true) })
  await ticks(3)
  expect(leadLogs(stdins)).toEqual([])
  expect(toasts.some((t: string) => t.startsWith('Lead not restored'))).toBe(false)
  expect(await statusText($)).toContain('Lead: OFF')
  h.sessionsUnsafe = false
  await ticks(2)
  expect(await statusText($)).toContain('Lead: ON')
  expect(logged(stdins)).toContain('lead-restored:')
})

test('a lead restore whose session list stays unreadable for 15 ticks: no lead, the key kept, logged and told once', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, { seed: () => (h.sessionsUnsafe = true) })
  await ticks(17)
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:registry-unreadable'])
  expect(toasts.filter((t: string) => t.startsWith('Lead not restored'))).toEqual(['Lead not restored: ' + REASON_TEXT['registry-unreadable'].replace(/\.$/, '') + '. Run /callboard lead.'])
  h.sessionsUnsafe = false
  expect(h.store.has(LEADKEY)).toBe(true)
})

longTest('a lead restore whose check for other leads never answers is refused lead-check-slow; the key is kept', async ($, on) => {
  const stdins: string[] = []
  const { start } = await leadRestarter($, on, stdins, { noStart: true, seed: () => (h.leadsListHook = () => new Promise<void>(() => undefined)) })
  let up = false
  void start.then(() => (up = true))
  for (let i = 0; i < 300 && (!up || leadLogs(stdins).length === 0); i++) await h.clock!.advance(2000)
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:lead-check-slow'])
  expect(toasts).toContain('Lead not restored: the check for other leads took too long. Try again. Run /callboard lead.')
  expect(h.store.has(LEADKEY)).toBe(true)
  h.leadsListHook = undefined
  expect(await statusText($)).toContain('Lead: OFF')
})

test('a store record naming the session while the lead restore is pending: the rebind waits, then refuses lead-holder', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, {
    pin: MFOLDER,
    seed: () => {
      h.sessions = { [REGFILE]: REG({ cwd: MFOLDER }) }
      putStore([STORE_LANE({ sid: SID })])
      extraStat.set(MFOLDER, dirStat)
      h.cwdThrows = 2
    },
  })
  await ticks(3)
  expect(rebinds(stdins)).toEqual(['rebind-rejected:lead-holder'])
  expect(await statusText($)).toContain('Lane: NONE. Lead: ON.')
})

longTest('a lane tool registration that never answers: no lead, the key kept', async ($, on) => {
  const stdins: string[] = []
  const { start } = await leadRestarter($, on, stdins, { noStart: true, seed: () => (h.laneRegisterHang = new Promise(() => undefined)) })
  let started = false
  void start.then(() => (started = true))
  for (let i = 0; i < 30 && !started; i++) await h.clock!.advance(2000)
  expect(started).toBe(true)
  expect(await statusText($)).toContain('Lead: OFF')
  for (let i = 0; i < 300 && leadLogs(stdins).length === 0; i++) await h.clock!.advance(2000)
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:tools-timeout'])
  expect(await statusText($)).toContain('Lead: OFF')
  expect(h.store.has(LEADKEY)).toBe(true)
})

test('a bound session is not made lead, and its key is kept', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await leadRestarter($, on, stdins, { trace, seed: () => trace.st!.set('lane', { value: { name: 'LABLANE', at: 1, turns: -1 }, version: 1 }) })
  expect(await statusText($)).toContain('Lead: OFF')
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:lane-holder'])
  expect(h.store.has(LEADKEY)).toBe(true)
})

test('the prune at start drops a bad lead key and keeps a good one, and leaves the starting session its own', async ($, on) => {
  const stdins: string[] = []
  const good = `lead:${OTHER}`
  const bad = `lead:${LEADSID}`
  await leadRestarter($, on, stdins, {
    raw: { pin: PIN, savedAt: T0 + 3_600_000 },
    seed: () => {
      h.store.set(good, { pin: PIN, savedAt: T0 - 1000 })
      h.store.set(bad, { pin: '/Users/x', savedAt: T0 - 1000 })
      h.store.set('lead:not-a-sid', { pin: PIN, savedAt: T0 - 1000 })
    },
  })
  expect(h.store.has(good)).toBe(true)
  expect(h.store.has(bad)).toBe(false)
  expect(h.store.has('lead:not-a-sid')).toBe(false)
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:invalid'])
})

// The once-a-day rule itself is c.leadRefreshDue (core.spec): a mock day runs every 2-second tick, far past a test's time limit.
test('a lead tick reads no store key for the saved grant and does not rewrite it within the day', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  const reads: string[] = []
  h.store = new (class extends Map<string, unknown> {
    get(k: string) {
      reads.push(k)
      return super.get(k)
    }
  })(h.store)
  await ticks(3)
  expect(reads.filter((k) => k === LEADKEY)).toEqual([])
  expect(h.store.get(LEADKEY)).toEqual({ pin: PIN, savedAt: T0 })
})

test('the lead grant pins the start folder, not the folder the shell moved to', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  await $.command.run(lane('off'))
  h.callerRoot = PIN
  await grantAt($, `${PIN}/api`)
  expect((h.store.get(`lead:${SID}`) as any).pin).toBe(PIN)
})

test('the lead restore reads the start folder', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, { seed: () => ((h.callerRoot = PIN), (h.callerCwd = `${PIN}/api`)) })
  expect(await statusText($)).toContain('Lead: ON')
})

// ---- /callboard off while a lead restore waits on its tool registration, and the saved grant ----
test('/callboard off while a lead restore waits on its tool registration: no lead, and no saved grant', async ($, on) => {
  const stdins: string[] = []
  let release!: () => void
  const { start } = await leadRestarter($, on, stdins, { noStart: true, seed: () => (h.laneRegisterHang = new Promise<void>((r) => (release = r))) })
  for (let i = 0; i < 3; i++) await h.clock!.advance(1000)
  await $.command.run(lane('off'))
  release()
  let done = false
  void start.then(() => (done = true))
  for (let i = 0; i < 40 && !done; i++) await h.clock!.advance(1000)
  await ticks(3)
  expect(await statusText($)).toContain('Lead: OFF')
  expect(h.store.has(LEADKEY)).toBe(false)
  expect(logged(stdins)).not.toContain('lead-restored:')
})

longTest('/callboard off while a lead restore times out on its tool registration: it is not tried again', async ($, on) => {
  const stdins: string[] = []
  const { start } = await leadRestarter($, on, stdins, { noStart: true, seed: () => (h.laneRegisterHang = new Promise<void>(() => undefined)) })
  for (let i = 0; i < 3; i++) await h.clock!.advance(1000)
  await $.command.run(lane('off'))
  let done = false
  void start.then(() => (done = true))
  for (let i = 0; i < 40 && !done; i++) await h.clock!.advance(1000)
  for (let i = 0; i < 20; i++) await h.clock!.advance(30_000)
  expect(await statusText($)).toContain('Lead: OFF')
  expect(h.store.has(LEADKEY)).toBe(false)
  expect(leadLogs(stdins)).toEqual([])
})

test('a saved grant that could not be deleted: the off and Cancel replies say lead may come back after a restart', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.storeDeleteFails = true
  const off = (await $.command.run(lane('off'))).text as string
  expect(off).toBe('Lead is now off. Lead may come back after a restart. If it does, run /callboard off again.')
  h.storeDeleteFails = false
  await grantAt($, PIN)
  h.storeDeleteFails = true
  h.askAnswer = NO
  expect((await $.command.run(lane('lead'))).text).toBe('Lead is now off. Lead may come back after a restart. If it does, run /callboard off again.')
  h.storeDeleteFails = false
  await grantAt($, PIN)
  expect((await $.command.run(lane('off'))).text).not.toContain('Lead may come back')
})

test('a run with no person (not interactive, no registry row of its own) is neither rebound nor made lead; the sid and the key stay', async ($, on) => {
  const stdins: string[] = []
  h.ownEntryAuto = false
  await rebinder($, on, stdins, { sess: {}, interactive: false })
  h.ownEntryAuto = false
  await ticks(16)
  expect(rebinds(stdins)).toEqual(['rebind-rejected:not-interactive'])
  expect(toasts.some((t) => t.includes('did not rebind'))).toBe(false)
  expect(recOf().sid).toBe(SID)
})

test('a lead restore in a run with no person keeps the key and is not made lead; a VS Code panel (not interactive at start, own registry row) is', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, { interactive: false, seed: () => ((h.ownEntryAuto = false), (h.sessions = {})) })
  h.ownEntryAuto = false
  h.sessions = {}
  await ticks(16)
  expect(await statusText($)).toContain('Lead: OFF')
  expect(leadLogs(stdins)).toEqual(['lead-restore-rejected:not-interactive'])
  expect(h.store.has(LEADKEY)).toBe(true)
})

test('a VS Code panel that is not interactive at start but has its own registry row is made lead again', async ($, on) => {
  const stdins: string[] = []
  await leadRestarter($, on, stdins, { interactive: false })
  expect(await statusText($)).toContain('Lead: ON')
})

test('/callboard off while a restored grant is being saved: the key the save wrote goes again', async ($, on) => {
  const stdins: string[] = []
  let release!: () => void
  const { start } = await leadRestarter($, on, stdins, { noStart: true, seed: () => (h.leadSetHang = new Promise<void>((r) => (release = r))) })
  for (let i = 0; i < 3; i++) await h.clock!.advance(1000)
  await $.command.run(lane('off'))
  expect(h.store.has(LEADKEY)).toBe(false)
  release()
  let done = false
  void start.then(() => (done = true))
  for (let i = 0; i < 40 && !done; i++) await h.clock!.advance(1000)
  await ticks(3)
  expect(await statusText($)).toContain('Lead: OFF')
  expect(h.store.has(LEADKEY)).toBe(false)
})

test('off in a session that is not a lead removes a saved lead grant left behind, and says so', async ($, on) => {
  await started($, on, [])
  h.store.set(`lead:${SID}`, { pin: '/data/x/work', savedAt: T0 })
  expect((await $.command.run(lane('off'))).text).toBe('Its saved lead grant was removed.')
  expect(h.store.has(`lead:${SID}`)).toBe(false)
  expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
})

test('off in a plain session whose saved-grant read times out does not claim a grant was removed', async ($, on) => {
  await started($, on, [], { clock: true })
  h.leadGetHang = new Promise<void>(() => undefined)
  const r = await drive($.command.run(lane('off')), 80)
  expect(r.text).toBe(OFF_NOTHING)
})

test('/callboard off while a restored grant is being saved: no lead-restored log, toast or note', async ($, on) => {
  const stdins: string[] = []
  let release!: () => void
  const { start } = await leadRestarter($, on, stdins, { noStart: true, seed: () => (h.leadSetHang = new Promise<void>((r) => (release = r))) })
  for (let i = 0; i < 3; i++) await h.clock!.advance(1000)
  await $.command.run(lane('off'))
  release()
  let done = false
  void start.then(() => (done = true))
  for (let i = 0; i < 40 && !done; i++) await h.clock!.advance(1000)
  await ticks(3)
  expect(logged(stdins)).not.toContain('lead-restored:')
  expect(toasts.some((t) => t.startsWith('Lead is on again'))).toBe(false)
})

test('an engine without session.root() reads the live folder instead: the lane rebinds in its folder', async ($, on) => {
  const stdins: string[] = []
  h.rootMissing = true
  try {
    await rebinder($, on, stdins)
    await tickTwice()
  } finally {
    h.rootMissing = false
  }
  expect(await statusText($)).toContain('Lane: LABLANE')
  expect(rebinds(stdins)[0]).toStartWith('rebound:')
})

test('the prune at start deletes a stale cut mark of another session and keeps a fresh one', async ($, on) => {
  await started($, on, [], {
    seed: () => {
      h.store.set(`cmp:${OTHER}`, { at: T0 - 60_000 })
      h.store.set(`cmp:${LEADSID}`, { at: T0 - 16 * 60_000 })
    },
  })
  expect(h.store.has(`cmp:${OTHER}`)).toBe(true)
  expect(h.store.has(`cmp:${LEADSID}`)).toBe(false)
})
