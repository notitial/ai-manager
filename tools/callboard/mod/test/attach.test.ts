import { expect, test } from 'claude-code/testing'
import { folderName, refusalText, attachQuestion, NO_LANE_RECORD, LANE_RECORD_UNKNOWN, STOPPABLE_BY_NAME, DETACH_INCOMPLETE, ATTACH_YES, ATTACH_NO, SID_KEPT, OFF_NOTHING } from '../hooks/core'
import { h, GOOD, LANESDIR, NO, ROOT, SID, T0, YES, extraStat, hangForever, laneSeed, leadFiles, lockLog, longTest, psDead, psStartsGone, realMap, renames, seen, storeFiles, submitted, toasts } from './harness'
import type { Trace } from './harness'
import { ATTACHED, ATTLANE, ATTLEAD, ATTSESS, ATT_REC, LANE_COMPOSE, LEADPATH, LEADPS, LEADSID, LEAD_LANES, LOCK_CYCLE, OTHER, OTHERLEAD, OWNER_LIVE, PIN, STATUS_NONE, STOREFILE, SVC, TURN, attRec, attacher, callCreate, cue, cueSession, dirStat, doLane, lane, laneSections, lateLane, leadAt, leadCall, leadFileText, leadReg, leadSelfReg, logged, newTrace, noLaneWritten, ownReg, pause, putStore, renameThroughTick, sleepMs, storeJson, ticks, unanswered, waitFor } from './fixtures'

const RENAMING = ' Rename pending.'

longTest('lane NAME: Join writes an attached record under the lock, binds the session with startDone first, and tells the lead', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  const r = await doLane($, 'lane svc-api')
  expect(r.text).toBe(ATTACHED())
  expect(h.lastQuestion).toBe(attachQuestion('svc-api', folderName(SVC), folderName(PIN), false))
  const rec = storeJson()
  expect(rec).toEqual({ repo: PIN, lanes: [{ name: 'svc-api', folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: T0, adopted: true, lead: LEADSID, sid: SID, leadName: 'LEAD' }], creates: [] })
  expect((await $.command.run(lane('status'))).text).toContain('Lane: svc-api')
  const hint = h.store.get(`sess:${SID}`) as any
  expect(hint.lane).toMatchObject({ name: 'svc-api', turns: -1, adopted: true, lead: LEADSID })
  expect(hint.counters.startDone).toBe(true)
  expect(logged(stdins)).toContain('attached:svc-api')
  expect(toasts).toContain('Lane svc-api joined')
  expect(h.lockState.held).toBe(false)
  expect(lockLog).toEqual(LOCK_CYCLE)
  expect(renames).toEqual([])
})

longTest('lane with no NAME takes the name the person gave the session; with a NAME that differs, the dialog says it will be renamed, and the rename waits for the tick', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  expect((await doLane($, 'lane')).text).toBe(ATTACHED('svc-api'))
  await h.clock!.advance(4000)
  expect(renames).toEqual([])
  await doLane($, 'lane off')
  storeFiles.clear()
  const r = await doLane($, 'lane API')
  expect(h.lastQuestion).toBe(attachQuestion('API', folderName(SVC), folderName(PIN), true))
  expect(h.lastQuestion).toContain('\nRenames it to API.')
  expect(r.text).toBe(`${ATTACHED('API')}${RENAMING}`)
  expect(renames).toEqual([])
  await h.clock!.advance(2000)
  expect(renames).toEqual(['API'])
  expect(logged(stdins)).toContain('renamed:attach')
  await h.clock!.advance(6000)
  expect(renames).toEqual(['API'])
})

test('a rename that fails or never finishes leaves the binding and tells the person to run /rename', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  h.renameMode = 'throw'
  await doLane($, 'lane API')
  await h.clock!.advance(2000)
  expect(renames).toEqual(['API'])
  expect(toasts).toContain('Rename failed. Run /rename API.')
  expect(logged(stdins)).toContain('rename-failed:refused')
  expect((await $.command.run(lane('status'))).text).toContain('Lane: API')
  await h.clock!.advance(10_000)
  expect(renames).toEqual(['API'])
  await doLane($, 'lane off')
  storeFiles.clear()
  h.renameMode = 'hang'
  toasts.length = 0
  await doLane($, 'lane API')
  await h.clock!.advance(2000)
  await h.clock!.advance(60_000)
  expect(toasts).toContain('Rename failed. Run /rename API.')
  expect(logged(stdins)).toContain('rename-failed:timeout')
})

test('a pending rename dies with the binding: lane off and off clear it', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane API')
  await doLane($, 'lane off')
  await h.clock!.advance(4000)
  expect(renames).toEqual([])
  storeFiles.clear()
  await doLane($, 'lane API')
  await $.command.run(lane('off'))
  await h.clock!.advance(4000)
  expect(renames).toEqual([])
})

test('lane is refused at once from a plugin, a session or a script, with a fixed text and no dialog', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  for (const [origin, code] of [[{ kind: 'plugin', name: 'evil <b>' }, 'plugin'], [{ kind: 'peer' }, 'session'], [{ kind: 'peer-send-message' }, 'session'], [{ kind: 'sdk' }, 'other'], [null, 'other']] as const) {
    for (const args of ['lane svc-api', 'lane', 'lane off']) {
      const r = await doLane($, args, origin)
      expect(r.text).toBe('Only you can change a lane: type /callboard lane yourself.')
      expect(logged(stdins)).toContain(`refused:lane-origin:${code}`)
    }
  }
  expect(h.askCount).toBe(0)
  await noLaneWritten($)
  expect((await doLane($, 'lane svc-api', { kind: 'bridge' })).text).toBe(ATTACHED())
})

test('lane refuses a session that is already a lane, one that holds a lead grant, and a session with no name', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { own: { nameSource: undefined, name: undefined } })
  expect((await doLane($, 'lane')).text).toBe(refusalText('pass-name'))
  expect(h.askCount).toBe(0)
  expect((await doLane($, 'lane svc-api')).text).toBe(`${ATTACHED()}${RENAMING}`)
  expect((await doLane($, 'lane other')).text).toBe(refusalText('already-bound'))
  await doLane($, 'lane off')
  storeFiles.clear()
  h.askAnswer = YES
  await $.command.run(lane('lead'))
  h.askAnswer = 'Join'
  const asks = h.askCount
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('lead-holder'))
  expect(h.askCount).toBe(asks)
  expect(logged(stdins)).toEqual(expect.arrayContaining(['refused:pass-name', 'refused:already-bound', 'refused:lead-holder']))
  await $.command.run(lane('off'))
  expect((await doLane($, 'lane svc-api')).text).toBe(`${ATTACHED()}${RENAMING}`)
})

test('lane takes a name only if it is a plain, unreserved name nobody else has', async ($, on) => {
  await attacher($, on, [], { own: { name: 'has space' } })
  const none = async (args: string, code: string) => {
    const before = storeFiles.get(STOREFILE)
    expect((await doLane($, args)).text).toBe(refusalText(code))
    expect(h.askCount).toBe(0)
    expect(storeFiles.get(STOREFILE)).toBe(before)
  }
  await none('lane', 'own-name-bad')
  for (const n of ['MANAGER', 'manager', 'MANAG3R', 'rnANAGER', 'MANAGER_']) await none(`lane ${n}`, 'name-reserved')
  laneSeed.text = JSON.stringify({ lanes: [{ name: 'LABLANE', folder: `${PIN}/lab`, brief: `${PIN}/lab/BRIEF.md`, repo: PIN }] })
  await none('lane LABLANE', 'name-taken')
  laneSeed.text = undefined
  storeFiles.set(`${LANESDIR}/${'b'.repeat(64)}.json`, JSON.stringify({ repo: '/Users/x/code/app2', lanes: [{ name: 'API', folder: '/Users/x/code/app2/api', brief: '/Users/x/code/app2/api/B.md', createdAt: 1 }], creates: [] }))
  extraStat.set('/Users/x/code/app2/.git', dirStat)
  await none('lane API', 'name-taken')
  storeFiles.clear()
  h.sessions = { ...leadReg(), ...ownReg({ name: 'has space' }), ...cueSession(OTHER, 'TAKEN', '/elsewhere', { pid: 4500 }) }
  await none('lane TAKEN', 'name-taken')
  h.sessions = { ...leadReg(), ...ownReg({ name: 'has space' }) }
  expect((await doLane($, 'lane svc-api')).text).toBe(`${ATTACHED()}${RENAMING}`)
})

test('lane may keep the name this very session already carries, and refuses the name of a lane in the same repo store', async ($, on) => {
  await attacher($, on, [], { own: { name: 'LABLANE' } })
  expect((await doLane($, 'lane')).text).toBe(ATTACHED('LABLANE'))
  await doLane($, 'lane off')
  putStore([{ name: 'LABLANE', folder: `${PIN}/api`, brief: `${PIN}/api/B.md`, createdAt: 1 }])
  extraStat.set(`${PIN}/api`, dirStat)
  expect((await doLane($, 'lane')).text).toBe(refusalText('name-taken'))
})

test('lane needs exactly one live lead for the session folder: none, two, a stale file, a dead pid, a wrong start time, a registry that disagrees, another repo', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { lead: false })
  let asks = 0
  const refused = async (code: string) => {
    expect((await doLane($, 'lane svc-api')).text).toBe(refusalText(code))
    expect(h.askCount).toBe(asks)
    expect(storeFiles.has(STOREFILE)).toBe(false)
  }
  await refused('no-lead')
  leadFiles.set(LEADPATH, { text: leadFileText(), mtimeSec: T0 / 1000 - 31 })
  await refused('no-lead')
  leadFiles.set(LEADPATH, { text: leadFileText(), mtimeSec: T0 / 1000 - 30 })
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  asks = 1
  await doLane($, 'lane off')
  storeFiles.clear()
  leadFiles.set(LEADPATH, { text: leadFileText(), mtimeSec: T0 / 1000 + 5 })
  await refused('no-lead')
  leadFiles.set(LEADPATH, { text: leadFileText() })
  psDead.add('4242')
  await refused('no-lead')
  psDead.clear()
  leadFiles.set(LEADPATH, { text: leadFileText({ procStart: 'Wed Oct 28 01:00:00 2026' }) })
  await refused('no-lead')
  leadFiles.set(LEADPATH, { text: leadFileText() })
  h.psOut = 'Wed Oct 28 01:00:00 2026\n'
  await refused('no-lead')
  h.psOut = `${LEADPS}\n`
  for (const reg of [{}, leadReg({ sessionId: OTHER }), leadReg({ procStart: 'Wed Oct 28 01:00:00 2026' }), { '4243.json': leadReg()['4242.json'] }]) {
    h.sessions = { ...reg, ...ownReg() }
    await refused('no-lead')
  }
  h.sessions = { ...leadReg(), ...ownReg() }
  extraStat.set('/Users/x/code/other/.git', dirStat)
  extraStat.set('/Users/x/.git', dirStat)
  leadFiles.set(LEADPATH, { text: leadFileText({ repo: '/Users/x/code/other' }) })
  await refused('no-lead')
  leadFiles.set(LEADPATH, { text: leadFileText({ repo: '/Users/x', pid: 4242 }) })
  h.sessions = { ...leadReg({ cwd: '/Users/x' }), ...ownReg({ cwd: '/Users/x/code/app/svc' }) }
  h.callerCwd = '/Users/x/code/app/svc'
  await refused('no-lead')
  h.sessions = { ...leadReg(), ...ownReg() }
  extraStat.delete(`${PIN}/.git`)
  leadFiles.set(LEADPATH, { text: leadFileText() })
  await refused('no-lead')
  extraStat.set(`${PIN}/.git`, dirStat)
  realMap.set(PIN, '/Users/x/code/app-real')
  await refused('no-lead')
  realMap.clear()
  const OTHERLEAD = '6a1b2c3d-0000-4000-8000-123456789abc'
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  h.sessions = { ...leadReg(), ...ownReg(), '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243 })['4242.json'] }
  await refused('ambiguous-lead')
  leadFiles.delete(`${ROOT}/leads/${OTHERLEAD}.json`)
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect(logged(stdins)).toEqual(expect.arrayContaining(['refused:no-lead', 'refused:ambiguous-lead']))
})

test('a conductor or manager presence file is not a lead: attach finds no lead with one alone, and still exactly one next to a lead file', async ($, on) => {
  await attacher($, on, [], { lead: false })
  const none = async () => expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('no-lead'))
  // v15 (36): a valid conductor file (with home) is not a lead either.
  for (const over of [{ level: 'conductor', repo: undefined, repos: [PIN], home: '/Users/x/code/cond' }, { level: 'conductor', repo: undefined, repos: [PIN] }, { level: 'manager', repo: undefined }, { level: 'boss' }, { level: 'lead', repos: [PIN] }]) {
    leadFiles.set(LEADPATH, { text: leadFileText(over) })
    await none()
  }
  const OTHERLEAD = '6a1b2c3d-0000-4000-8000-123456789abc'
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243, level: 'manager', repo: undefined }) })
  h.sessions = { ...leadReg(), ...ownReg(), '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243 })['4242.json'] }
  leadFiles.set(LEADPATH, { text: leadFileText({ level: 'lead', name: 'LEAD' }) })
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
})

test('lane refuses a folder that is not its own real path, a path with odd characters, a dot folder below the repo, and a repo with 16 lanes', async ($, on) => {
  await attacher($, on)
  realMap.set(SVC, '/Users/x/code/elsewhere/svc')
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('folder-bad'))
  realMap.clear()
  h.callerCwd = `${PIN}/my svc`
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('folder-chars'))
  h.callerCwd = `${PIN}/${'d'.repeat(190)}`
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('folder-chars'))
  h.callerCwd = `${PIN}/.claude/worktrees/svc`
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('folder-dot'))
  expect(storeFiles.has(STOREFILE)).toBe(false)
  h.callerCwd = SVC
  const lanes = Array.from({ length: 16 }, (_, i) => ({ name: `L${i}`, folder: PIN, brief: `${PIN}/B${i}.md`, createdAt: 1 }))
  storeFiles.set(STOREFILE, JSON.stringify({ repo: PIN, lanes, creates: [] }))
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('lane-cap'))
  expect(h.askCount).toBe(0)
})

test('the Join dialog offers exactly Join and Cancel', async ($, on) => {
  await attacher($, on)
  h.askedOptions = []
  await doLane($, 'lane svc-api')
  expect(h.askedOptions).toEqual([[ATTACH_YES, ATTACH_NO]])
})

longTest('the Join dialog: Cancel, free text and a dismissal change nothing; a timeout says so', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  for (const a of ['Cancel', 'join', 'Join please', '', 'Allow']) {
    h.askAnswer = a
    expect((await doLane($, 'lane svc-api')).text).toBe('Cancelled. Nothing changed.')
    await noLaneWritten($)
  }
  expect(logged(stdins)).toContain('refused:attach-not-confirmed')
  h.askHang = new Promise<string>(() => undefined)
  expect((await unanswered(doLane($, 'lane svc-api'))).text).toBe('Nothing changed: the question timed out.')
  await noLaneWritten($)
  expect(logged(stdins)).toContain('refused:timed-out')
  expect(toasts).toContain('Question timed out. Nothing changed.')
  h.askHang = undefined
  h.askAnswer = 'Join'
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
})

test('an off while the Join dialog is open wins: nothing is written; a second lane meanwhile is refused busy', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const first = doLane($, 'lane svc-api')
  await new Promise((r) => setTimeout(r, 20))
  expect((await doLane($, 'lane svc-api')).text).toContain('question is already open')
  expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
  release('Join')
  expect((await first).text).toBe('Nothing changed: callboard was turned off meanwhile.')
  await noLaneWritten($)
  expect(logged(stdins)).toContain('refused:off-meanwhile')
})

test('lane with no NAME takes the session\'s current name whatever set it (an automatic one too); the dialog shows it', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { own: { nameSource: 'auto', name: 'quiet-fox' } })
  h.askAnswer = 'Join'
  const asks = h.askCount
  expect((await doLane($, 'lane')).text).toBe(ATTACHED('quiet-fox'))
  expect(h.askCount).toBe(asks + 1)
  expect(storeJson().lanes.some((l: any) => l.name === 'quiet-fox' && l.adopted === true)).toBe(true)
})

test('lane with no NAME refuses a session name that cannot be a lane name with own-name-bad, asks nothing, and lane NAME still works', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { own: { nameSource: 'user', name: 'WORK BOX' } })
  h.askAnswer = 'Join'
  const asks = h.askCount
  expect((await doLane($, 'lane')).text).toBe(refusalText('own-name-bad'))
  expect(h.askCount).toBe(asks)
  await noLaneWritten($)
  expect(logged(stdins)).toContain('refused:own-name-bad')
  expect((await doLane($, 'lane  WORK-BOX')).text).toBe(`${ATTACHED('WORK-BOX')}${RENAMING}`)
})

test('lane with no NAME treats an empty session name as no name: pass-name, no dialog', async ($, on) => {
  await attacher($, on, [], { own: { nameSource: 'auto', name: '' } })
  const asks = h.askCount
  expect((await doLane($, 'lane')).text).toBe(refusalText('pass-name'))
  expect(h.askCount).toBe(asks)
  await noLaneWritten($)
})

test('attach needs exactly one live registry entry of the session: two give session-duplicate; a copy under a dead pid, or a forged 0.json, is ignored', async ($, on) => {
  await attacher($, on)
  h.askAnswer = 'Join'
  h.sessions = { ...leadReg(), ...ownReg(), '4301.json': ownReg({ pid: 4301 })['4300.json'] }
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('session-duplicate'))
  await noLaneWritten($)
  h.sessions = { ...leadReg(), ...ownReg({ name: undefined, nameSource: undefined }), '0.json': ownReg({ pid: 4300 })['4300.json'] }
  expect((await doLane($, 'lane')).text).toBe(refusalText('pass-name'))
  h.sessions = { ...leadReg(), ...ownReg(), '4301.json': ownReg({ pid: 4301 })['4300.json'] }
  psStartsGone.add('4301')
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
})

test('a rename that the session needs or no longer needs, changed while the Join dialog was open, refuses changed', async ($, on) => {
  await attacher($, on)
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const p = doLane($, 'lane svc-api')
  await new Promise((r) => setTimeout(r, 20))
  h.sessions = { ...leadReg(), ...ownReg({ name: 'svc-old' }) }
  release('Join')
  expect((await p).text).toBe(refusalText('changed'))
  h.askHang = undefined
  await noLaneWritten($)
})

test('what held when the question was shown must still hold after the answer: a lead that left, a name taken meanwhile, a session bound meanwhile', async ($, on) => {
  await attacher($, on)
  let release: (a: string) => void = () => undefined
  const open = async () => {
    h.askHang = new Promise<string>((r) => (release = r))
    const p = doLane($, 'lane svc-api')
    await new Promise((r) => setTimeout(r, 20))
    return { p }
  }
  let { p } = await open()
  leadFiles.delete(LEADPATH)
  release('Join')
  expect((await p).text).toBe(refusalText('no-lead'))
  leadFiles.set(LEADPATH, { text: leadFileText() })
  ;({ p } = await open())
  h.sessions = { ...leadReg(), ...ownReg(), ...cueSession(OTHER, 'svc-api', '/elsewhere', { pid: 4500 }) }
  release('Join')
  expect((await p).text).toBe(refusalText('name-taken'))
  h.sessions = { ...leadReg(), ...ownReg() }
  ;({ p } = await open())
  const OTHERLEAD = '6a1b2c3d-0000-4000-8000-123456789abc'
  leadFiles.delete(LEADPATH)
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  h.sessions = { ...leadReg(), ...ownReg(), '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243 })['4242.json'] }
  release('Join')
  expect((await p).text).toBe(refusalText('changed'))
  h.askHang = undefined
  await noLaneWritten($)
})

test('lane writes no record when the store cannot be read, is busy, is over the cap or does not land; a record that does not land is reported', async ($, on) => {
  await attacher($, on, [], { clock: true })
  h.storeStatOverride = '501 644 1 Regular File 77 50 1700000000\n'
  storeFiles.set(STOREFILE, '{}')
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('store-unreadable'))
  h.storeStatOverride = undefined
  storeFiles.clear()
  h.storeWrites = 'fail'
  expect((await doLane($, 'lane svc-api')).text).toContain('write-failed')
  h.storeWrites = 'ignore'
  expect((await doLane($, 'lane svc-api')).text).toBe('Lane not changed: the record was not saved. It was removed.')
  h.storeWrites = 'ok'
  expect(h.lockState.held).toBe(false)
  await noLaneWritten($)
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
})

test('attaching does not count as a create, counts against the 16 lanes, and keeps every other record as it was', async ($, on) => {
  await attacher($, on)
  const plain = { name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 5 }
  const other = { name: 'OLD', folder: `${PIN}/old`, brief: `${PIN}/old/.callboard-attached`, createdAt: 6, adopted: true, lead: OTHER }
  for (const f of ['api', 'old']) extraStat.set(`${PIN}/${f}`, dirStat)
  putStore([plain, other], [T0 - 1000, T0 - 2000])
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect(storeJson()).toEqual({ repo: PIN, lanes: [plain, other, { name: 'svc-api', folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: T0, adopted: true, lead: LEADSID, sid: SID, leadName: 'LEAD' }], creates: [T0 - 1000, T0 - 2000] })
})

test('an attached lane is a lane: resume and compact work with no re-arm, start is refused adopted-record, a birth rename is refused', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  await doLane($, 'lane svc-api')
  expect(await cue(81, 'start\n')).toBe('start refused adopted-record 81\n')
  expect(await cue(82, 'rename OTHERNAME\n')).toBe('rename refused already-bound 82\n')
  expect(await cue(83, 'resume\n')).toBe('resume ok - 83\n')
  expect(submitted.some((t) => t.startsWith('[callboard] Resume lane svc-api'))).toBe(true)
  await $.tool.call(GOOD as any)
  await $.turn.complete(TURN as any)
  expect(await cue(84, 'compact\n')).toBe('compact ok - 84\n')
  expect(seen.compacted).toBe(true)
  expect(logged(stdins)).not.toContain('started:')
})

test('an attached lane follows the lead: it answers whichever lead holds a valid presence file for its repo, and refuses no-lead while none does', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane svc-api')
  const OTHERLEAD = '6a1b2c3d-0000-4000-8000-123456789abc'
  const swap = (path: string, file: Record<string, unknown>, reg: Record<string, string> = leadReg()) => {
    leadFiles.clear()
    leadFiles.set(path, file as any)
    h.sessions = { ...reg, ...ownReg() }
  }
  swap(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) }, { '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243 })['4242.json'] })
  expect(await cue(91, 'resume\n')).toBe('resume ok - 91\n')
  expect(await cue(92, 'compact\n')).toBe('compact held nudged 92\n')
  expect(await cue(93, 'start\n')).toBe('start refused adopted-record 93\n')
  leadFiles.clear()
  expect(await cue(94, 'resume\n')).toBe('resume refused no-lead 94\n')
  expect(await cue(95, 'compact\n')).toBe('compact refused no-lead 95\n')
  swap(LEADPATH, { text: leadFileText(), mtimeSec: T0 / 1000 - 31 })
  expect(await cue(96, 'resume\n')).toBe('resume refused no-lead 96\n')
  swap(LEADPATH, { text: leadFileText(), mode: '644' })
  expect(await cue(97, 'resume\n')).toBe('resume refused no-lead 97\n')
  psDead.add('4242')
  swap(LEADPATH, { text: leadFileText() })
  expect(await cue(98, 'resume\n')).toBe('resume refused no-lead 98\n')
  psDead.clear()
  extraStat.set('/Users/x/code/other/.git', dirStat)
  swap(LEADPATH, { text: leadFileText({ repo: '/Users/x/code/other' }) })
  expect(await cue(99, 'resume\n')).toBe('resume refused no-lead 99\n')
  swap(LEADPATH, { text: leadFileText() })
  expect(await cue(100, 'resume\n')).toBe('resume ok - 100\n')
})

test('an attached lane whose record is changed after the join refuses record-changed; a lead-made lane has no lead-gone check', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane svc-api')
  const rec = storeJson()
  storeFiles.set(STOREFILE, JSON.stringify({ ...rec, lanes: [{ ...rec.lanes[0], lead: OTHER }] }))
  expect(await cue(71, 'resume\n')).toBe('resume refused record-changed 71\n')
  storeFiles.set(STOREFILE, JSON.stringify({ ...rec, lanes: [{ name: 'svc-api', folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: T0 }] }))
  expect(await cue(72, 'resume\n')).toBe('resume refused record-changed 72\n')
})

test('lane off detaches: the record is removed under the lock, the binding and the hint go, and no lead tool or cue reaches the session by name', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  await doLane($, 'lane svc-api')
  expect(h.store.has(`sess:${SID}`)).toBe(true)
  const r = await doLane($, 'lane off')
  expect(r.text).toBe('This session is no longer lane svc-api.')
  expect(storeJson().lanes).toEqual([])
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
  expect(h.store.has(`sess:${SID}`)).toBe(false)
  expect(h.lockState.held).toBe(false)
  expect(await cue(61, 'resume\n')).toBe('resume refused not-eligible 61\n')
  expect((await doLane($, 'lane off')).text).toBe(`This session is not a lane. ${NO_LANE_RECORD}`)
  expect(logged(stdins)).not.toContain('detach-incomplete:')
})

test('/callboard lanes in a lane says it is a lane and that its lead lists the lanes, with no lead hint', async ($, on) => {
  await attacher($, on)
  await doLane($, 'lane svc-api')
  expect((await $.command.run(lane('lanes'))).text).toBe('This session is a lane: its lead lists the lanes.')
})

test('lane off needs the person; off from anything else asks first and then detaches too', async ($, on) => {
  await attacher($, on)
  await doLane($, 'lane svc-api')
  expect((await doLane($, 'lane off', { kind: 'plugin', name: 'x' })).text).toBe('Only you can change a lane: type /callboard lane yourself.')
  expect((await $.command.run(lane('status'))).text).toContain('Lane: svc-api')
  h.askAnswer = NO
  expect((await $.command.run(lane('off', { kind: 'peer' }))).text).toContain('Cancelled. Nothing changed.')
  expect(storeJson().lanes.length).toBe(1)
  h.askAnswer = YES
  const r = await $.command.run(lane('off', { kind: 'peer' }))
  expect(r.text).toBe('This session is no longer lane svc-api.')
  expect(storeJson().lanes).toEqual([])
})

test('off from the prompt on an attached lane removes the record, drops the binding and the hint', async ($, on) => {
  await attacher($, on)
  await doLane($, 'lane svc-api')
  const r = await $.command.run(lane('off'))
  expect(r.text).toBe('This session is no longer lane svc-api.')
  expect(storeJson().lanes).toEqual([])
  expect(h.store.has(`sess:${SID}`)).toBe(false)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

test('detach only removes the record that is attached and carries the binding name; a lead-made record stays', async ($, on) => {
  await attacher($, on)
  await doLane($, 'lane svc-api')
  const rec = storeJson()
  const made = { name: 'svc-api2', folder: `${PIN}/api`, brief: `${PIN}/api/B.md`, createdAt: 3 }
  extraStat.set(`${PIN}/api`, dirStat)
  storeFiles.set(STOREFILE, JSON.stringify({ ...rec, lanes: [made, ...rec.lanes] }))
  await doLane($, 'lane off')
  expect(storeJson().lanes).toEqual([made])
})

test('a session bound by a birth rename is unbound by off too, and its record stays', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  expect((await $.command.run(lane('status'))).text).toContain('Lane: LABLANE')
  expect((await $.command.run(lane('off'))).text).toBe(`This session is no longer lane LABLANE.${STOPPABLE_BY_NAME('LABLANE')}`)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(h.store.has(`sess:${SID}`)).toBe(false)
  expect(laneSeed.text).toBe(LEAD_LANES('/data/x/work'))
  expect(await cue(43, 'resume\n')).toBe('resume refused not-eligible 43\n')
})

test('detach that cannot remove the record says so, logs detach-incomplete, and still clears the binding', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  const incomplete = async (why: string) => {
    storeFiles.clear()
    expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
    return why
  }
  const INCOMPLETE = `${DETACH_INCOMPLETE}${SID_KEPT('svc-api')}`
  // An unreadable store is not loaded, so no record there names the session (nothing to clear, nothing a restart could rebind); in the other cases the
  // write that would clear its session id fails as well.
  const cases: [string, () => void | Promise<void>, () => void, string][] = [
    ['store unreadable', () => (h.storeStatOverride = '501 644 1 Regular File 77 50 1700000000\n'), () => (h.storeStatOverride = undefined), DETACH_INCOMPLETE],
    ['write fails', () => (h.storeWrites = 'fail'), () => (h.storeWrites = 'ok'), INCOMPLETE],
    ['re-read shows it still there', () => (h.storeWrites = 'ignore'), () => (h.storeWrites = 'ok'), INCOMPLETE],
    ['lock busy', () => (h.lockState = { held: true, owner: OWNER_LIVE, mtimeSec: T0 / 1000 }), () => (h.lockState = { held: false }), INCOMPLETE],
  ]
  for (const [why, break_, fix, text] of cases) {
    await incomplete(why)
    await h.clock!.advance(0)
    break_()
    const p = doLane($, 'lane off')
    for (let i = 0; i < 40; i++) await h.clock!.advance(150)
    expect((await p).text, why).toBe(text)
    fix()
    expect((await $.command.run(lane('status'))).text, why).toContain('Lane: NONE')
    expect(h.store.has(`sess:${SID}`), why).toBe(false)
  }
  expect(logged(stdins).filter((e) => e === 'detach-incomplete:').length).toBe(cases.length)
  const w = await $.command.run(lane('status'))
  expect(w.text).toContain('Lane: NONE')
})

test('a hint that cannot be deleted at detach is logged, not swallowed', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  await doLane($, 'lane svc-api')
  h.storeDeleteFails = true
  expect((await doLane($, 'lane off')).text).toBe('This session is no longer lane svc-api.')
  expect(logged(stdins)).toContain('error:hint-delete')
})

test('a restored attached lane works like any lane: the store record is the authority, and a record that changed refuses', async ($, on) => {
  const stdins: string[] = []
  const att = { name: 'svc-api', folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: 1, adopted: true, lead: LEADSID }
  const hint = { lane: { name: 'svc-api', at: 1, turns: -1, adopted: true, lead: LEADSID }, counters: { startDone: true }, savedAt: T0 }
  await attacher($, on, stdins, { clock: true })
  putStore([att])
  h.store.set(`sess:${SID}`, hint)
  h.restoreAnswer = YES
  h.askAnswer = YES
  await $.command.run(lane('lane'))
  expect((await $.command.run(lane('status'))).text).toContain('Lane: svc-api')
  expect((h.store.get(`sess:${SID}`) as any).lane).toMatchObject({ name: 'svc-api', turns: -1, adopted: true, lead: LEADSID })
  expect(await cue(55, 'resume\n')).toBe('resume ok - 55\n')
  await $.command.run(lane('off'))
  expect(storeJson().lanes).toEqual([])
})

const restoreRefused = (rec: Record<string, unknown>) => async ($: any, on: any) => {
  const hint = { lane: { name: 'svc-api', at: 1, turns: -1, adopted: true, lead: LEADSID }, counters: { startDone: true }, savedAt: T0 }
  const stdins: string[] = []
  await attacher($, on, stdins)
  putStore([rec])
  h.store.set(`sess:${SID}`, hint)
  h.askAnswer = NO
  await $.command.run(lane('lane'))
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
  expect(logged(stdins)).toContain('hint-rejected:record-changed')
}
test('a restore of an attached lane is refused when the record names another lead', restoreRefused({ ...ATT_REC, lead: OTHER }))
test('a restore of an attached lane is refused when the record is no longer attached', restoreRefused({ name: ATT_REC.name, folder: ATT_REC.folder, brief: ATT_REC.brief, createdAt: 1 }))

test('a lead tool serves an attached lane whichever lead it joined: the lead field is information; lane_open still refuses it', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...ATTSESS() }, argv })
  putStore([attRec(OTHERLEAD)])
  h.askAnswer = 'Force stop'
  for (const verb of ['start', 'resume', 'compact']) expect(JSON.stringify(await $.tool.call(leadCall(verb, { lane: 'ATT' }))), verb).toContain(`cue ${verb} acted for lane ATT`)
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toContain('SIGTERM sent')
  expect(JSON.stringify(await $.tool.call(leadCall('open', { lane: 'ATT' })))).toContain('adopted-record')
  // A stop of a live attached lane keeps its record (the session is the only other way to detach it); with no session carrying it, a second stop removes it.
  expect(JSON.parse(storeFiles.get(STOREFILE)!).lanes.map((l: any) => l.name)).toEqual(['ATT'])
  h.sessions = leadSelfReg()
  h.askAnswer = YES
  expect(JSON.stringify(await $.tool.call(leadCall('terminate', { lane: 'ATT' })))).toContain('terminated and removed: it had no live session')
  expect(JSON.parse(storeFiles.get(STOREFILE)!).lanes).toEqual([])
  expect(JSON.stringify(argv)).not.toContain('lead-gone')
})

test('the lead an attached lane joined can cue, compact, resume and retire it; lane_open and lane_start refuse it', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await leadAt($, on, stdins, { sess: { ...leadSelfReg(), ...ATTSESS() }, argv })
  putStore([attRec(SID)])
  for (const verb of ['resume', 'compact', 'start']) expect(JSON.stringify(await $.tool.call(ATTLEAD(verb)))).toContain(`cue ${verb} acted`)
  expect(JSON.stringify(await $.tool.call(ATTLEAD('open')))).toContain('adopted-record')
  expect(argv.some((a) => a[0] === '/bin/mv' && a.some((x) => x.endsWith('.open')))).toBe(false)
  h.reportFile = { text: `status: done ${OTHER}\n`, mtimeSec: (T0 - 1000) / 1000 }
  extraStat.set(`${PIN}/.archive/ATT/REPORT.md`, '501 600 1 Regular File 55 40 1700000000\n')
  h.askAnswer = 'Cancel'
  expect(JSON.stringify(await $.tool.call(ATTLEAD('terminate')))).toContain('did not confirm')
})

test('lane_create keeps adopted and lead on the records it keeps, and an attach is not a create', async ($, on) => {
  await leadAt($, on, [])
  const other = attRec(OTHERLEAD, 'OLD')
  const mine = attRec(SID, 'MINE')
  putStore([other, mine], [])
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  const saved = storeJson()
  expect(saved.lanes.map((l: any) => l.name)).toEqual(['OLD', 'MINE', 'API'])
  expect(saved.lanes[0]).toEqual(other)
  expect(saved.lanes[1]).toEqual(mine)
  expect(saved.lanes[2].adopted).toBeUndefined()
  expect(saved.creates).toEqual([T0])
})

test('the join sets startDone before it sets the binding, then saves the hint', async ($, on) => {
  const trace = { log: [] as string[], failCounters: false }
  await attacher($, on, [], { trace })
  trace.log.length = 0
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  expect(trace.log.filter((k) => k !== 'seen')).toEqual(['counters', 'lane'])
  expect((h.store.get(`sess:${SID}`) as any).lane.adopted).toBe(true)
})

test('a join whose startDone cannot be set binds nothing, and the record it wrote is taken back', async ($, on) => {
  const stdins: string[] = []
  const trace = { log: [] as string[], failCounters: false }
  await attacher($, on, stdins, { trace })
  trace.failCounters = true
  expect((await doLane($, 'lane svc-api')).text).toBe('Lane not changed: the session could not be bound.')
  expect(trace.log).not.toContain('lane')
  expect(storeJson().lanes).toEqual([])
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
  expect(logged(stdins)).toContain('error:attach-bind')
})

test('a birth rename into an attached record is refused adopted-record, whoever sends it', async ($, on) => {
  await attacher($, on, [], { clock: true, own: { nameSource: 'auto', name: 'quiet-fox' } })
  putStore([{ name: 'ATT', folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: 1, adopted: true, lead: LEADSID }])
  expect(await cue(33, 'rename ATT\n')).toBe('rename refused adopted-record 33\n')
  expect(renames).toEqual([])
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
})

test('detach removes only a record that is attached; a plain record of the same name stays, and so does the record of a lane the session was only restored into', async ($, on) => {
  await attacher($, on)
  await doLane($, 'lane svc-api')
  const plain = { name: 'svc-api', folder: SVC, brief: `${SVC}/B.md`, createdAt: 3 }
  putStore([plain])
  await doLane($, 'lane off')
  expect(storeJson().lanes).toEqual([plain])
})

test('a session renamed while the Join question was open is not joined under the old name', async ($, on) => {
  await attacher($, on)
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const p = doLane($, 'lane')
  await new Promise((r) => setTimeout(r, 20))
  h.sessions = { ...leadReg(), ...ownReg({ name: 'renamed-x' }) }
  release('Join')
  expect((await p).text).toBe(refusalText('changed'))
  h.askHang = undefined
  await noLaneWritten($)
})

longTest('a pending rename that did not get a tick within 60 seconds expires with a toast and runs nothing', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  h.askAnswer = 'Join'
  h.compactHangs = true
  await $.tool.call({ ...GOOD, mode: 'now' } as any)
  await $.turn.complete(TURN as any)
  await h.clock!.advance(2000)
  expect(seen.compacted).toBe(true)
  expect((await doLane($, 'lane API')).text).toBe(`${ATTACHED('API')}${RENAMING}`)
  h.cueFile = { ino: 5, text: 'resume\n', present: true }
  h.submitHangs = true
  await ticks(70)
  expect(renames).toEqual([])
  expect(toasts).toContain('Rename failed. Run /rename API.')
  expect(logged(stdins)).toContain('rename-failed:expired')
})

test('off with a record that cannot be removed still unbinds, and says so', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  await doLane($, 'lane svc-api')
  h.storeWrites = 'fail'
  const r = await $.command.run(lane('off'))
  // The record stays and the write that would clear its session id fails as well: the restart sentence follows.
  expect(r.text).toBe(`This session is no longer lane svc-api. ${DETACH_INCOMPLETE}${SID_KEPT('svc-api')}`)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(logged(stdins)).toContain('detach-incomplete:')
})

test('detach keeps every other record as it was, attached or not', async ($, on) => {
  await attacher($, on)
  await doLane($, 'lane svc-api')
  const rec = storeJson()
  const other = attRec(OTHERLEAD, 'OLD')
  extraStat.set(`${PIN}/old`, dirStat)
  storeFiles.set(STOREFILE, JSON.stringify({ ...rec, lanes: [other, ...rec.lanes] }))
  await doLane($, 'lane off')
  expect(storeJson().lanes).toEqual([other])
})

test('off and lane off clear the binding and the hint first, then remove the record', async ($, on) => {
  const trace = newTrace()
  await attacher($, on, [], { trace })
  await doLane($, 'lane svc-api')
  let atWrite: { unbound: boolean; hint: boolean } | undefined
  trace.log.length = 0
  h.storeWriteHook = () => (atWrite = { unbound: trace.log.includes('lane:null'), hint: h.store.has(`sess:${SID}`) })
  await doLane($, 'lane off')
  expect(atWrite).toEqual({ unbound: true, hint: false })
  expect(storeJson().lanes).toEqual([])
  await doLane($, 'lane svc-api')
  atWrite = undefined
  trace.log.length = 0
  await $.command.run(lane('off'))
  expect(atWrite).toEqual({ unbound: true, hint: false })
})

test('a stale binding never removes a record somebody else made: another lead, another folder, or a plain record of the same name; an attached one is reported, not called done', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  await doLane($, 'lane svc-api')
  const cases: [string, unknown, string][] = [
    ['another lead', ATTLANE({ lead: OTHERLEAD }), DETACH_INCOMPLETE],
    ['another folder', ATTLANE({ folder: `${PIN}/other`, brief: `${PIN}/other/.callboard-attached` }), DETACH_INCOMPLETE],
    ['a plain record', { name: 'svc-api', folder: SVC, brief: `${SVC}/BRIEF.md`, createdAt: 3 }, 'This session is no longer lane svc-api.'],
  ]
  for (const [why, other, text] of cases) {
    putStore([other])
    const before = storeFiles.get(STOREFILE)
    expect((await doLane($, 'lane off')).text, why).toBe(text)
    expect(storeFiles.get(STOREFILE), why).toBe(before)
    storeFiles.clear()
    expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  }
  expect(logged(stdins).filter((e) => e === 'detach-incomplete:').length).toBe(2)
})

test('a session that changed folder after the attach still removes its own record: the record is found by its text, not by the folder', async ($, on) => {
  await attacher($, on)
  await doLane($, 'lane svc-api')
  h.callerCwd = `${SVC}/sub`
  expect((await doLane($, 'lane off')).text).toBe('This session is no longer lane svc-api.')
  expect(storeJson().lanes).toEqual([])
  h.callerCwd = SVC
  expect((await doLane($, 'lane svc-api')).text).toBe(ATTACHED())
  h.callerCwd = `${SVC}/sub`
  expect((await $.command.run(lane('off'))).text).toBe('This session is no longer lane svc-api.')
  expect(storeJson().lanes).toEqual([])
})

test('a stray record is not taken when another live session carries the name', async ($, on) => {
  await attacher($, on)
  putStore([ATTLANE()])
  h.sessions = { ...leadReg(), ...ownReg(), ...cueSession(OTHER, 'svc-api', '/elsewhere', { pid: 4500 }) }
  expect((await doLane($, 'lane off')).text).toBe(`This session is not a lane. ${NO_LANE_RECORD}`)
  expect(storeJson().lanes.length).toBe(1)
})

test('lane off on a session with no binding finds its own record by name and folder, and says so when there is none', async ($, on) => {
  await attacher($, on)
  putStore([ATTLANE(), ATTLANE({ name: 'other-name' }), ATTLANE({ name: 'svc-api2', folder: `${PIN}/other`, brief: `${PIN}/other/.callboard-attached` })])
  expect((await doLane($, 'lane off')).text).toBe('Removed its leftover lane record.')
  expect(storeJson().lanes.map((l: any) => l.name)).toEqual(['other-name', 'svc-api2'])
  expect((await doLane($, 'lane off')).text).toBe(`This session is not a lane. ${NO_LANE_RECORD}`)
  for (const other of [ATTLANE({ folder: `${PIN}/other`, brief: `${PIN}/other/.callboard-attached` }), { name: 'svc-api', folder: SVC, brief: `${SVC}/BRIEF.md`, createdAt: 3 }]) {
    putStore([other])
    expect((await doLane($, 'lane off')).text).toBe(`This session is not a lane. ${NO_LANE_RECORD}`)
    expect(storeJson().lanes.length).toBe(1)
  }
  h.sessions = { ...leadReg(), ...ownReg({ name: undefined }) }
  expect((await doLane($, 'lane off')).text).toBe(`This session is not a lane. ${NO_LANE_RECORD}`)
})

test('a lane off while the stray record cannot be removed says so', async ($, on) => {
  await attacher($, on, [], { clock: true })
  putStore([ATTLANE()])
  h.lockMkdirErr = 'mkdir: Permission denied'
  expect((await doLane($, 'lane off')).text).toBe(DETACH_INCOMPLETE)
  h.lockMkdirErr = undefined
  expect(storeJson().lanes.length).toBe(1)
})

test('an off that lands between the store write of a Join and the binding wins: the record goes again and nothing is bound', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  h.storeMvDelayMs = 60
  const p = doLane($, 'lane svc-api')
  await sleepMs(25)
  await $.command.run(lane('off'))
  expect((await p).text).toBe('Nothing changed: callboard was turned off meanwhile.')
  expect(storeJson().lanes).toEqual([])
  expect(h.store.has(`sess:${SID}`)).toBe(false)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(logged(stdins)).toContain('refused:off-meanwhile')
  expect(logged(stdins)).not.toContain('attached:svc-api')
})

test('a Join whose write went through but is not in the file after it says so, and takes the record back; when it cannot, it says that', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  h.storeWrites = 'ignore'
  expect((await doLane($, 'lane svc-api')).text).toBe('Lane not changed: the record was not saved. It was removed.')
  expect(logged(stdins)).toContain('refused:store-changed')
  expect(lockLog.filter((e) => e === 'mkdir').length).toBe(2)
  h.storeWrites = 'ignore'
  h.storeWriteHook = () => (h.lockMkdirErr = 'mkdir: Permission denied')
  expect((await doLane($, 'lane svc-api')).text).toBe(`Lane not changed: the record was not saved. ${DETACH_INCOMPLETE}`)
  await noLaneWritten($)
})

test('an attached lane follows a new lead: the lead it joined is gone, another one holds the repo, and the cue is answered; with none it refuses no-lead', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane svc-api')
  leadFiles.clear()
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  h.sessions = { '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243 })['4242.json'], ...ownReg() }
  expect(await cue(81, 'resume\n')).toBe('resume ok - 81\n')
  expect(storeJson().lanes[0].lead).toBe(LEADSID)
  leadFiles.clear()
  expect(await cue(82, 'resume\n')).toBe('resume refused no-lead 82\n')
})

test('the pending rename is not run when another live session now carries the name; it is logged and toasted', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  await doLane($, 'lane API')
  h.sessions = { ...leadReg(), ...ownReg(), ...cueSession(OTHER, 'API', '/elsewhere', { pid: 4500 }) }
  await h.clock!.advance(2000)
  expect(renames).toEqual([])
  expect(toasts).toContain('Rename failed. Run /rename API.')
  expect(logged(stdins)).toContain('rename-failed:name-taken')
  expect((await $.command.run(lane('status'))).text).toContain('Lane: API')
})

test('off of a lane the lead made says the lead can still stop the session by its name; off of an attached lane does not', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  const r = await $.command.run(lane('lane off'))
  expect(r.text).toBe(`This session is no longer lane LABLANE.${STOPPABLE_BY_NAME('LABLANE')}`)
  expect(STOPPABLE_BY_NAME('LABLANE')).toContain('stop it by the name LABLANE until you rename it')
})

test('an attached lane answers when two leads hold the repo: any valid presence file is enough', async ($, on) => {
  await attacher($, on, [], { clock: true })
  // A lead with no valid name: the record names no lead (legacy), so any lead of the repo counts.
  h.sessions = { ...leadReg({ name: 'my lead' }), ...ownReg() }
  await doLane($, 'lane svc-api')
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  h.sessions = { ...leadReg(), '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243 })['4242.json'], ...ownReg() }
  expect(await cue(83, 'resume\n')).toBe('resume ok - 83\n')
})

test('lane off with no binding says so when the registry cannot be read, and does not claim there is no record', async ($, on) => {
  await attacher($, on)
  putStore([ATTLANE()])
  h.sessionsUnsafe = true
  expect((await doLane($, 'lane off')).text).toBe(LANE_RECORD_UNKNOWN)
  h.sessionsUnsafe = false
  expect(storeJson().lanes.length).toBe(1)
  expect((await doLane($, 'lane off')).text).toBe('Removed its leftover lane record.')
})

test('a pending rename whose registry cannot be read is not run: it fails with a toast', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins, { clock: true })
  await doLane($, 'lane API')
  h.sessionsUnsafe = true
  await h.clock!.advance(2000)
  expect(renames).toEqual([])
  expect(toasts).toContain('Rename failed. Run /rename API.')
  expect(logged(stdins)).toContain('rename-failed:registry-unreadable')
})

test('an off that lands while the binding is being set unbinds it again, takes the record back and says so', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await attacher($, on, stdins, { trace })
  let entered = false
  trace.setHook = async (key) => {
    if (key === 'lane') {
      entered = true
      await sleepMs(60)
    }
  }
  const p = doLane($, 'lane svc-api')
  while (!entered) await sleepMs(5)
  await $.command.run(lane('off'))
  expect((await p).text).toBe('Nothing changed: callboard was turned off meanwhile.')
  trace.setHook = undefined
  expect(storeJson().lanes).toEqual([])
  expect(h.store.has(`sess:${SID}`)).toBe(false)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(logged(stdins)).toContain('refused:off-meanwhile')
  expect(h.appendRows.length).toBe(0)
  expect(laneSections(await $.prompt.compose(LANE_COMPOSE)).length).toBe(0)
})

test('an attach whose binding write never returns gives up after the limit, unbinds, and frees the mark', async ($, on) => {
  const stdins: string[] = []
  let hung = false
  const trace: Trace = { log: [], failCounters: false, setHook: (key) => { if (key === 'lane' && !hung) { hung = true; return hangForever() } } }
  await attacher($, on, stdins, { clock: true, trace })
  const p = doLane($, 'lane API')
  await pause()
  await h.clock!.advance(31_000)
  expect((await p).text).toBe('Lane not changed: the session could not be bound.')
  expect(logged(stdins)).toContain('error:attach-bind-timeout')
  expect(storeJson().lanes).toEqual([])
  h.askAnswer = YES
  expect((await $.command.run(lane('lead'))).text).not.toContain('this session is a lane')
})

test('an attach binding write that lands after its timeout is undone once it lands', async ($, on) => {
  const stdins: string[] = []
  const late = lateLane()
  await attacher($, on, stdins, { clock: true, trace: late.trace })
  const p = doLane($, 'lane API')
  await pause()
  await h.clock!.advance(31_000)
  expect((await p).text).toBe('Lane not changed: the session could not be bound.')
  late.release()
  await waitFor(() => logged(stdins).includes('error:late-bind-undone'))
  expect(late.trace.st!.get('lane')?.value ?? null).toBeNull()
  expect(storeJson().lanes).toEqual([])
})

test('a late binding write the engine refused is left alone: nothing to undo', async ($, on) => {
  const stdins: string[] = []
  const late = lateLane()
  late.trace.failKeys = new Set(['lane'])
  await attacher($, on, stdins, { clock: true, trace: late.trace })
  const p = doLane($, 'lane API')
  await pause()
  await h.clock!.advance(31_000)
  expect((await p).text).toBe('Lane not changed: the session could not be bound.')
  late.release()
  await pause()
  await pause()
  expect(logged(stdins)).not.toContain('error:late-bind-undone')
})

test('a failed removal of an attached record gives DETACH_INCOMPLETE; its session id is then cleared instead, and the restart sentence comes only when that fails too', async ($, on) => {
  const stdins: string[] = []
  await attacher($, on, stdins)
  await doLane($, 'lane svc-api')
  h.storeWrites = 'fail'
  const r = await doLane($, 'lane off')
  expect(r.text).toBe(`${DETACH_INCOMPLETE}${SID_KEPT('svc-api')}`)
  expect(logged(stdins)).toContain('sid-uncleared:')
})

test('attach records the start folder, and the attached lane still answers a cue after its shell moved', async ($, on) => {
  await attacher($, on, [], { clock: true })
  h.callerRoot = SVC
  h.callerCwd = `${SVC}/pkg`
  await doLane($, 'lane svc-api')
  expect((storeJson().lanes as any[])[0].folder).toBe(SVC)
  // The shell may even leave the repo: the lead check reads the start folder too.
  h.callerCwd = '/tmp/elsewhere'
  expect(await cue(72, 'resume\n')).toBe('resume ok - 72\n')
})
