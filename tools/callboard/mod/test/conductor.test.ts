import { expect, test } from 'claude-code/testing'
import { HINT_PREFIX, conductorFileText, conductorAddQuestion, conductorRefusalText, conductorAddedText, CONDUCTOR_NOT_PERSON, CONDUCTOR_USAGE, conductorQuestion, conductorRestoreQuestion, conductorBriefing, conductorBriefingNote, conductorRestoredToast, conductorUnansweredToast, conductorFileBadToast, conductorNoReposToast, CONDUCTOR_ON_TEXT, CONDUCTOR_OFF_QUESTION, conductorStatus, leadBriefing, LANES_CHANGED_TEXT, reboundToast, REASON_TEXT, managerRefusalText, terminateQuestion, leadConductorText } from '../hooks/core'
import { h, GOOD, LANESDIR, NO, PS_TABLE, ROOT, SID, T0, YES, condFiles, condStat, extraStat, laneSeed, leadFiles, longTest, realFails, realMap, seen, storeFiles, submitted, toasts, toolDefs } from './harness'
import type { Trace } from './harness'
import { APISID, APP2, COMPOSE, COND, CONDFILE, CSESS, FAR, LANE_HINT, LEADKEY, LEADPATH, LEADPS, LEADSID, MGR_SESS, MIN, NO_LANES, NO_LANES_COND, OTHER, OTHERLEAD, OTHERPATH, PIN, SELFPATH, STATUS_NONE, TURN, allEvents, attacher, briefings, ckLane, condAt, condOn, condPresenceOf, condRun, condSelf, cue, dirStat, doLane, grantAt, idleFor, killed, lane, leadAt, leadFileText, leadReg, leadSelfReg, listCall, listed, logged, madeLane, mgrAt, mgrCall, mgrFile, mgrRow, newTrace, noteRows, nudges, ownReg, putCond, putStore, regAs, renameThroughTick, selfAs, started, statusTable, statusText, ticks, unanswered, waitFor } from './fixtures'

const CONDSTORE = `${LANESDIR}/${'c'.repeat(64)}.json`
const condEntries = () => JSON.parse(condFiles.get(CONDFILE) ?? '{"repos":[]}').repos as string[]
const condNo = (code: string) => conductorRefusalText(code, COND)
const CHOME = '/Users/x'

test('conductor add by folder name resolves the sibling at the same depth, not a nested folder of that name', async ($, on) => {
  const stdins: string[] = []
  await condAt($, on, stdins, { seed: () => extraStat.set(`${COND}/app/.git`, dirStat) })
  const r = await condRun($, 'add app')
  expect(h.lastQuestion).toBe(conductorAddQuestion(COND, PIN, [PIN], CHOME, false))
  expect(h.lastQuestion).toBe('Let conductors in cond reach the lanes of ../app? The list would then be: ../app (1 repo).')
  expect(h.lastHeader).toBe('Conductor')
  expect(h.askedOptions).toEqual([['Add', 'Cancel']])
  expect(condFiles.get(CONDFILE)).toBe(conductorFileText(['../app']))
  expect(r.text).toBe('../app added. Run /callboard conductor to make this session a conductor.')
  expect(logged(stdins)).toContain('conductor-add:prompt')
  expect(logged(stdins)).toContain('command:conductor:prompt')
  // No path enters a log line.
  expect(allEvents(stdins).every((e) => !String(e.reason).includes('/'))).toBe(true)
})

longTest('conductor add and remove from a plugin, another session or a script are refused with no dialog; the phone is the person', async ($, on) => {
  const stdins: string[] = []
  await condAt($, on, stdins)
  putCond(['../app'])
  for (const [origin, code] of [[{ kind: 'plugin', name: 'x' }, 'plugin'], [{ kind: 'peer' }, 'session'], [{ kind: 'sdk' }, 'other']] as const) {
    for (const args of ['add app2', 'remove app']) expect((await condRun($, args, origin)).text).toBe(CONDUCTOR_NOT_PERSON)
    expect(logged(stdins)).toContain(`refused:conductor-not-person:${code}`)
  }
  expect(h.askCount).toBe(0)
  expect(condEntries()).toEqual(['../app'])
  expect((await condRun($, 'add app2', { kind: 'bridge' })).text).toBe('../app2 added. Run /callboard conductor to make this session a conductor.')
  expect((await condRun($, 'remove app', { kind: 'bridge' })).text).toBe('../app removed.')
  expect(condEntries()).toEqual(['../app2'])
})

test('the add dialog names the resolved repo, never the typed text: ../NAME for a sibling, a long path elsewhere whole and marked, and the whole list', async ($, on) => {
  const far = `/Users/x/${'d'.repeat(50)}/${'e'.repeat(60)}/repo`
  await condAt($, on, [], { seed: () => extraStat.set(`${far}/.git`, dirStat) })
  putCond(['../app'])
  h.askAnswer = NO
  await condRun($, `add ${APP2}`)
  expect(h.lastQuestion).toBe('Let conductors in cond reach the lanes of ../app2? The list would then be: ../app, ../app2 (2 repos).')
  await condRun($, `add ${FAR}`)
  expect(h.lastQuestion).toBe('Let conductors in cond reach the lanes of ~/data/x/work/elsewhere/far-repo (not next to cond)? The list would then be: ../app, ~/data/x/work/elsewhere/far-repo (not next to cond) (2 repos).')
  await condRun($, `add ${far}`)
  expect(far.length).toBeGreaterThanOrEqual(120)
  expect(h.lastQuestion).toContain(`reach the lanes of ~${far.slice(CHOME.length)} (not next to cond)?`)
  expect(h.lastQuestion).not.toContain('…')
  expect(condEntries()).toEqual(['../app'])
})

test('add refuses the conductor repo itself, a nested repo, a duplicate, a 17th repo and a list whose presence file would pass 4096 bytes, before any dialog', async ($, on) => {
  const stdins: string[] = []
  await condAt($, on, stdins, { seed: () => { extraStat.set(`${COND}/sub/.git`, dirStat); extraStat.set('/Users/x/code/.git', dirStat) } })
  expect((await condRun($, `add ${COND}`)).text).toBe(condNo('conductor-self'))
  expect((await condRun($, 'add cond')).text).toBe(condNo('conductor-self'))
  expect((await condRun($, `add ${COND}/sub`)).text).toBe(condNo('conductor-nested'))
  expect((await condRun($, 'add /Users/x/code')).text).toBe(condNo('conductor-nested'))
  putCond(['../app'])
  expect((await condRun($, 'add app')).text).toBe(condNo('conductor-dup'))
  expect((await condRun($, `add ${PIN}`)).text).toBe(condNo('conductor-dup'))
  putCond(Array.from({ length: 16 }, (_, i) => `../r${i}`))
  expect((await condRun($, 'add app')).text).toBe(condNo('conductor-cap'))
  putCond(Array.from({ length: 8 }, (_, i) => `/Users/x/${'y'.repeat(470)}/r${i}`))
  expect((await condRun($, 'add app')).text).toBe(condNo('conductor-too-long'))
  expect(h.askCount).toBe(0)
  expect(logged(stdins)).toEqual(expect.arrayContaining(['refused:conductor-self', 'refused:conductor-nested', 'refused:conductor-dup', 'refused:conductor-cap', 'refused:conductor-too-long']))
})

test('add refuses conductor-list-long, before any dialog, when the grant question for the resulting list would pass the question limit', async ($, on) => {
  await condAt($, on)
  putCond(Array.from({ length: 4 }, (_, i) => `/Users/x/${'z'.repeat(200)}/r${i}`))
  expect((await condRun($, 'add app')).text).toBe(condNo('conductor-list-long'))
  expect(h.askCount).toBe(0)
  putCond(Array.from({ length: 2 }, (_, i) => `/Users/x/${'z'.repeat(200)}/r${i}`))
  h.askAnswer = NO
  await condRun($, 'add app')
  expect(h.askCount).toBe(1)
})

test('add refuses a target that is not a git root, is too broad, does not exist or is not its own real path', async ($, on) => {
  await condAt($, on)
  extraStat.delete(`${APP2}/.git`)
  expect((await condRun($, 'add app2')).text).toBe(condNo('conductor-not-git'))
  expect((await condRun($, 'add /Users/x/Documents')).text).toBe(condNo('conductor-broad'))
  realFails.set('/Users/x/code/nosuch', { n: 9, err: 'realpath: /Users/x/code/nosuch: No such file or directory' })
  expect((await condRun($, 'add nosuch')).text).toBe(condNo('conductor-not-found'))
  expect(condNo('conductor-not-found')).toBe('Nothing changed: no repo by that name next to cond, or at that path. Give its full path.')
  realMap.set(FAR, '/Users/x/real/far-repo')
  expect((await condRun($, `add ${FAR}`)).text).toBe(condNo('conductor-not-real'))
  expect(h.askCount).toBe(0)
  expect(condFiles.has(CONDFILE)).toBe(false)
})

test('Cancel and a timeout write nothing; a yes writes the file sorted, as ../NAME for a sibling and the absolute path otherwise', async ($, on) => {
  await condAt($, on, [], { clock: true })
  h.askAnswer = NO
  expect((await condRun($, 'add app')).text).toBe('Cancelled. Nothing changed.')
  expect(condFiles.has(CONDFILE)).toBe(false)
  expect(extraStat.has(`${COND}/.claude`)).toBe(false)
  h.askHang = new Promise<string>(() => undefined)
  expect((await unanswered(condRun($, 'add app'))).text).toBe('Nothing changed: the question timed out.')
  expect(condFiles.has(CONDFILE)).toBe(false)
  h.askHang = undefined
  h.askAnswer = YES
  for (const t of [FAR, 'app2', '../app']) await condRun($, `add ${t}`)
  expect(condEntries()).toEqual(['../app', '../app2', FAR])
  expect(condFiles.get(CONDFILE)).toBe(conductorFileText(['../app', '../app2', FAR]))
})

test('a target that stopped being a git root during the dialog is refused after the click and nothing is written', async ($, on) => {
  await condAt($, on)
  h.askScript = async () => {
    extraStat.delete(`${APP2}/.git`)
    return YES
  }
  expect((await condRun($, 'add app2')).text).toBe(condNo('conductor-not-git'))
  expect(h.askCount).toBe(1)
  expect(condFiles.has(CONDFILE)).toBe(false)
})

test('a list file that is a link or has two links, or a .claude that is a link, is not written (conductor-file-unsafe)', async ($, on) => {
  const stdins: string[] = []
  await condAt($, on, stdins)
  for (const st of ['501 644 1 Symbolic Link 19 20 1700000000\n', '501 644 2 Regular File 19 20 1700000000\n', '502 644 1 Regular File 19 20 1700000000\n']) {
    putCond(['../app'])
    condStat.set(CONDFILE, st)
    expect((await condRun($, 'add app2')).text).toBe(condNo('conductor-file-unsafe'))
    expect((await condRun($, 'remove app')).text).toBe(condNo('conductor-file-unsafe'))
    expect(condEntries()).toEqual(['../app'])
  }
  condFiles.clear()
  condStat.clear()
  extraStat.set(`${COND}/.claude`, '501 755 1 Symbolic Link 9 12 1700000000\n')
  expect((await condRun($, 'add app2')).text).toBe(condNo('conductor-file-unsafe'))
  expect(condFiles.size).toBe(0)
  expect(h.askCount).toBe(0)
})

test('remove asks nothing, drops the entry (a deleted repo too, by name or path), and the last remove leaves repos: []', async ($, on) => {
  const stdins: string[] = []
  await condAt($, on, stdins)
  putCond(['../app', '../app2', FAR])
  realFails.set(PIN, { n: 99, err: 'realpath: x: No such file or directory' })
  realFails.set(FAR, { n: 99, err: 'realpath: x: No such file or directory' })
  extraStat.delete(`${PIN}/.git`)
  expect((await condRun($, 'remove app')).text).toBe('../app removed.')
  expect((await condRun($, `remove ${FAR}`)).text).toBe(`${FAR} removed.`)
  expect((await condRun($, 'remove app')).text).toBe(condNo('conductor-not-listed'))
  expect(condEntries()).toEqual(['../app2'])
  expect((await condRun($, `remove ${APP2}`)).text).toBe('../app2 removed.')
  expect(condFiles.get(CONDFILE)).toBe('{\n  "repos": []\n}\n')
  expect(h.askCount).toBe(0)
  expect(logged(stdins)).toContain('conductor-remove:prompt')
})

test('add in a lane, a lead or the manager, or in a session that was a lead or the manager, is refused before the dialog and again after a yes', async ($, on) => {
  const trace = newTrace()
  await condAt($, on, [], { trace })
  trace.st!.set('lane', { value: { name: 'X', at: 1 }, version: 1 })
  expect((await condRun($, 'add app')).text).toBe(condNo('lane-holder'))
  trace.st!.set('lane', { value: null, version: 2 })
  h.askScript = async () => {
    trace.st!.set('lane', { value: { name: 'X', at: 1 }, version: 3 })
    return YES
  }
  expect((await condRun($, 'add app')).text).toBe(condNo('lane-holder'))
  expect(h.askCount).toBe(1)
  expect(condFiles.has(CONDFILE)).toBe(false)
  trace.st!.set('lane', { value: null, version: 4 })
  h.askScript = undefined
  await grantAt($, COND)
  expect((await condRun($, 'add app')).text).toBe(condNo('lead-holder'))
  await $.command.run(lane('off'))
  expect((await condRun($, 'add app')).text).toBe(condNo('conductor-after-lead'))
  expect(h.askCount).toBe(2)
  expect(condFiles.has(CONDFILE)).toBe(false)
})

test('add in the manager, or in a session that was the manager, is refused before the dialog', async ($, on) => {
  await condAt($, on)
  h.askAnswer = YES
  await $.command.run(lane('manager'))
  const n = h.askCount
  expect((await condRun($, 'add app')).text).toBe(condNo('manager-holder'))
  await $.command.run(lane('off'))
  expect((await condRun($, 'add app')).text).toBe(condNo('conductor-after-manager'))
  expect(h.askCount).toBe(n)
})

test('a file changed between the read and the write is not overwritten (conductor-file-changed)', async ($, on) => {
  const stdins: string[] = []
  await condAt($, on, stdins)
  putCond(['../app'])
  h.condWriteHook = () => putCond(['../app', FAR])
  expect((await condRun($, 'add app2')).text).toBe(condNo('conductor-file-changed'))
  expect(condEntries()).toEqual(['../app', FAR])
  expect(logged(stdins)).toContain('error:conductor-file-changed')
})

test('add in a session that is not a conductor writes the file and grants nothing', async ($, on) => {
  await condAt($, on)
  const defs0 = toolDefs.length
  expect((await condRun($, 'add app')).text).toBe(conductorAddedText(COND, PIN, CHOME, false))
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(toolDefs.slice(defs0).some((d) => JSON.parse(d).name.startsWith('lane_'))).toBe(false)
  expect([...h.store.keys()].some((k) => k.startsWith('conductor:'))).toBe(false)
  expect(leadFiles.size).toBe(0)
})

test('add refuses conductor-repo-in-use when the folder has a lane store with a lane, or a live lead file for it, a lead on a parent repo included', async ($, on) => {
  const stdins: string[] = []
  await condAt($, on, stdins, { sess: { ...condSelf(), ...regAs(OTHERLEAD, 4243, 'LEADB') } })
  storeFiles.set(CONDSTORE, JSON.stringify({ repo: COND, lanes: [{ name: 'CL', folder: COND, brief: `${COND}/BRIEF.md`, createdAt: 1 }], creates: [] }))
  expect((await condRun($, 'add app')).text).toBe(conductorRefusalText('conductor-repo-in-use', COND))
  expect(conductorRefusalText('conductor-repo-in-use', COND)).toBe('Nothing changed: cond has lanes or a lead, so it cannot be a conductor repo: use a repo of its own.')
  storeFiles.set(CONDSTORE, JSON.stringify({ repo: COND, lanes: [], creates: [] }))
  h.askAnswer = NO
  await condRun($, 'add app')
  expect(h.askCount).toBe(1)
  for (const repo of [COND, '/Users/x/code']) {
    extraStat.set(`${repo}/.git`, dirStat)
    leadFiles.set(OTHERPATH, { text: JSON.stringify({ sid: OTHERLEAD, pid: 4243, procStart: LEADPS, repo }) })
    expect((await condRun($, 'add app')).text).toBe(conductorRefusalText('conductor-repo-in-use', COND))
  }
  expect(h.askCount).toBe(1)
  expect(logged(stdins)).toContain('refused:conductor-repo-in-use')
})

test('a bad list file, a bad conductor folder and an unknown form get their own refusals', async ($, on) => {
  await condAt($, on)
  putCond([])
  condFiles.set(CONDFILE, '{"repos":["a/b"]}')
  expect((await condRun($, 'add app')).text).toBe(condNo('conductor-file-bad'))
  expect((await condRun($, 'add a/b')).text).toBe(CONDUCTOR_USAGE)
  extraStat.delete(`${COND}/.git`)
  expect((await condRun($, 'add app')).text).toBe(condNo('conductor-here'))
  expect(h.askCount).toBe(0)
})

// ---- the conductor grant, its restore, its tools ----
const CONDKEY = `conductor:${SID}`
const condSections = (r: any) => (r.sections as { id: string; text: string }[]).filter((x) => x.id === 'callboard:conductor')
// A session that starts with a saved conductor grant (approved: repos) and the list file `file`.
async function condRestarter($: any, on: any, stdins: string[], opts: { repos?: string[]; file?: string[]; cwd?: string; sess?: Record<string, string>; seed?: () => void; noStart?: boolean; argv?: string[][]; raw?: unknown } = {}) {
  laneSeed.text = undefined
  h.sessions = opts.sess ?? condSelf()
  const start = started($, on, stdins, {
    clock: true,
    argv: opts.argv,
    seed: () => {
      h.callerCwd = opts.cwd ?? COND
      for (const r of [COND, PIN, APP2, FAR]) extraStat.set(`${r}/.git`, dirStat)
      putCond(opts.file ?? ['../app', '../app2'])
      h.store.set(CONDKEY, opts.raw ?? { home: COND, repos: opts.repos ?? [PIN, APP2], savedAt: T0 - 60_000 })
      opts.seed?.()
    },
  })
  if (!opts.noStart) await start
  return { start }
}
const condLogs = (stdins: string[]) => logged(stdins).filter((x) => x.startsWith('conductor-'))

test('/callboard conductor asks once with every repo and the restart sentence; Conductor declares three tools, writes the presence file, saves the shown list and appends the note', async ($, on) => {
  const stdins: string[] = []
  const defs0 = toolDefs.length
  await condAt($, on, stdins)
  putCond(['../app', '../app2', '../gone', FAR])
  realFails.set('/Users/x/code/gone', { n: 99, err: 'realpath: x: No such file or directory' })
  const r = await condRun($, '')
  expect(r.text).toBe(`${CONDUCTOR_ON_TEXT} Out of reach: ../gone (not found).`)
  expect(h.lastQuestion).toBe(conductorQuestion(COND, [PIN, APP2, FAR], CHOME))
  expect(h.lastQuestion).toBe('Make this session a conductor for these repos? ../app, ../app2, ~/data/x/work/elsewhere/far-repo (not next to cond). It can list their lanes, compact their leads, and force stop a lane: every stop asks you. It stays a conductor after a restart until you run /callboard off.')
  expect(h.lastHeader).toBe('Conductor')
  expect(h.askedOptions).toEqual([['Conductor', 'Cancel']])
  const names = toolDefs.slice(defs0).map((d) => JSON.parse(d).name).filter((n: string) => n.startsWith('lane_'))
  expect([...new Set(names)].sort()).toEqual(['lane_compact', 'lane_list', 'lane_terminate'])
  expect(toolDefs.slice(defs0).find((d) => d.includes('"lane_terminate"'))).toContain('Every stop asks the person')
  const pres = JSON.parse(leadFiles.get(SELFPATH)!.text)
  expect(pres).toMatchObject({ sid: SID, pid: 4400, procStart: LEADPS, level: 'conductor', repos: [PIN, APP2, FAR], home: COND })
  expect('repo' in pres).toBe(false)
  expect(h.store.get(CONDKEY)).toEqual({ home: COND, repos: [PIN, APP2, FAR], savedAt: T0 })
  expect(noteRows().length).toBe(1)
  expect(noteRows()[0].text).toBe(conductorBriefingNote('', COND, [PIN, APP2, FAR]))
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (3 repos)']))
  expect(logged(stdins)).toContain('conductor-on:prompt')
  // Again with nothing new: no dialog, the reach.
  expect((await condRun($, '')).text).toBe(['**Conductor** · on', '', '| Repo | State |', '|---|---|', '| ../app | in reach |', '| ../app2 | in reach |', '| ~/data/x/work/elsewhere/far-repo (not next to cond) | in reach |', '| ../gone | out of reach: not found |'].join('\n'))
  expect(h.askCount).toBe(1)
})

test('the grant dialog names seven repos and a long absolute one whole; a list past the question limit is refused with no dialog', async ($, on) => {
  const far = `/Users/x/${'d'.repeat(50)}/${'e'.repeat(60)}/repo`
  const seven = Array.from({ length: 7 }, (_, i) => `/Users/x/code/r${i}`)
  await condAt($, on, [], { seed: () => [...seven, far].forEach((r) => extraStat.set(`${r}/.git`, dirStat)) })
  putCond([...seven.map((r) => `../${r.slice(r.lastIndexOf('/') + 1)}`), far])
  h.askAnswer = NO
  await condRun($, '')
  for (let i = 0; i < 7; i++) expect(h.lastQuestion).toContain(`../r${i}`)
  expect(h.lastQuestion).toContain(`~${far.slice(CHOME.length)} (not next to cond).`)
  expect(h.lastQuestion).not.toContain('…')
  const long = Array.from({ length: 6 }, (_, i) => `/Users/x/${'z'.repeat(200)}/r${i}`)
  for (const r of long) extraStat.set(`${r}/.git`, dirStat)
  putCond(long)
  expect((await condRun($, '')).text).toBe(conductorRefusalText('conductor-list-too-long', COND, 'Conductor stays off'))
  expect(h.askCount).toBe(1)
})

test('starting a session in the conductor repo, with a list file and no saved grant, makes nothing a conductor', async ($, on) => {
  const stdins: string[] = []
  await condAt($, on, stdins, { clock: true })
  putCond(['../app'])
  await h.clock!.advance(4000)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(condLogs(stdins)).toEqual([])
  expect(leadFiles.size).toBe(0)
})

test('a saved grant is restored with no question in a person\'s session; a --bg worker (row kind background) is not and keeps the key; a missing row is retried', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins)
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (2 repos)']))
  expect(h.askCount).toBe(0)
  expect(h.appendRows.length).toBe(0)
  expect(condLogs(stdins)).toContain('conductor-restored:')
  expect(toasts).toContain(conductorRestoredToast(COND, 2))
  expect(toasts).toContain('Conductor is on again for cond (2 repos).')
  expect(h.store.get(CONDKEY)).toEqual({ home: COND, repos: [PIN, APP2], savedAt: T0 })
})
test('a --bg worker resumed under the id (row kind background) is not made a conductor and keeps the key', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { sess: condSelf({ kind: 'background' }) })
  await h.clock!.advance(4000)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:not-person')
  expect(h.store.has(CONDKEY)).toBe(true)
})
test('a person\'s row that arrives late is retried, and the restore lands although a rebind was pending (no lane record)', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { seed: () => ((h.sessions = {}), (h.ownEntryAuto = false)) })
  expect(await statusText($)).toBe(STATUS_NONE)
  h.sessions = condSelf()
  for (let i = 0; i < 3 && !condLogs(stdins).includes('conductor-restored:'); i++) await h.clock!.advance(2000)
  expect(condLogs(stdins)).toContain('conductor-restored:')
  expect(condLogs(stdins).some((x) => x.startsWith('conductor-restore-rejected'))).toBe(false)
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (2 repos)']))
})

test('a restore whose file names a repo outside the approved list asks first, naming every repo and the new one; Conductor restores with all of them and saves them', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN], file: ['../app', '../app2'] })
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain('lead tools are off')
  expect(h.askCount).toBe(0)
  await h.clock!.advance(2000)
  await waitFor(() => condLogs(stdins).includes('conductor-restored:widened 1'))
  expect(h.lastQuestion).toBe(conductorRestoreQuestion(COND, [PIN, APP2], [APP2], CHOME))
  // The new repos first, a fixed closing sentence.
  expect(h.lastQuestion).toBe("cond's conductor list changed since you approved it. New: ../app2. Restore this session as a conductor for these repos? ../app, ../app2. Cancel removes the saved conductor grant.")
  expect(h.lastHeader).toBe('Conductor')
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (2 repos)']))
  expect(h.store.get(CONDKEY)).toMatchObject({ home: COND, repos: [PIN, APP2] })
  expect(noteRows().length).toBe(1)
  expect(h.askCount).toBe(1)
})

test('Cancel on the restore dialog deletes the saved grant and leaves the session off', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN], file: ['../app', '../app2'], seed: () => (h.askAnswer = NO) })
  h.askAnswer = NO
  await h.clock!.advance(2000)
  await waitFor(() => condLogs(stdins).includes('conductor-restore-cancelled:'))
  expect(h.store.has(CONDKEY)).toBe(false)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('a grant made while a restore question waits ends that restore; a later Cancel cannot delete the new saved grant', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN], file: ['../app', '../app2'] })
  // The widened restore waits for the tick; the person grants by hand first.
  expect((await condRun($, '')).text).toContain(CONDUCTOR_ON_TEXT)
  const asked = h.askCount
  h.askAnswer = NO
  await ticks(5)
  expect(h.askCount).toBe(asked)
  expect(condLogs(stdins).some((x) => x.startsWith('conductor-restore-cancelled'))).toBe(false)
  expect(h.store.get(CONDKEY)).toMatchObject({ home: COND, repos: [PIN, APP2] })
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (2 repos)']))
})

longTest('a restore dialog nobody answers restores nothing and keeps the key; its 90 s use up no retry ticks', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN], file: ['../app', '../app2'] })
  h.askHang = new Promise<string>(() => undefined)
  await h.clock!.advance(2000)
  await waitFor(() => h.askCount === 1)
  await ticks(50)
  await waitFor(() => condLogs(stdins).includes('conductor-restore-unanswered:'))
  expect(toasts).toContain(conductorUnansweredToast(COND))
  expect(h.store.has(CONDKEY)).toBe(true)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(h.askCount).toBe(1)
  expect(condLogs(stdins).some((x) => x.startsWith('conductor-restore-rejected'))).toBe(false)
})

test('a restore where the file dropped a repo restores without it and asks nothing; with no approved repo left nothing is restored and the key is kept', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN, APP2], file: ['../app'] })
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (1 repo)']))
  expect(h.askCount).toBe(0)
  expect(h.store.get(CONDKEY)).toMatchObject({ repos: [PIN] })
  expect(condLogs(stdins)).toContain('conductor-ratchet:1')
})
test('a restore whose list file holds none of the approved repos restores nothing and keeps the key', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN], file: [] })
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:no-repos')
  expect(toasts).toContain(conductorNoReposToast(COND))
  expect(h.store.has(CONDKEY)).toBe(true)
  expect(h.askCount).toBe(0)
})

test('in a running conductor an entry written into the file by hand is not reached; /callboard conductor then asks with the whole list, and a yes reaches it', async ($, on) => {
  const stdins: string[] = []
  await condOn($, on, stdins, { repos: ['../app'] })
  putCond(['../app', '../app2'])
  await $.tool.call(listCall())
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (1 repo)']))
  // Another origin never widens: no dialog, the reach and what is out.
  expect((await condRun($, '', { kind: 'plugin', name: 'x' })).text).toBe(['**Conductor** · on', '', '| Repo | State |', '|---|---|', '| ../app | in reach |', '| ../app2 | out of reach: not approved in this session |'].join('\n'))
  expect(h.askCount).toBe(1)
  expect((await condRun($, '')).text).toBe(CONDUCTOR_ON_TEXT)
  expect(h.askCount).toBe(2)
  // The repo not yet approved is named first.
  expect(h.lastQuestion).toBe(conductorQuestion(COND, [PIN, APP2], CHOME, [APP2]))
  expect(h.lastQuestion.startsWith('New since you approved: ../app2. Make this session a conductor')).toBe(true)
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (2 repos)']))
  expect(h.store.get(CONDKEY)).toMatchObject({ repos: [PIN, APP2] })
})

test('a restore whose list file does not parse or is a link restores nothing, keeps the key and is retried; when the tries run out it logs file-bad', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { seed: () => condFiles.set(CONDFILE, '{bad') })
  expect(condLogs(stdins)).toContain('conductor-restore-retry:file-bad')
  expect(await statusText($)).toBe(STATUS_NONE)
  condFiles.set(CONDFILE, conductorFileText(['../app']))
  condStat.set(CONDFILE, '501 644 1 Symbolic Link 19 20 1700000000\n')
  await ticks(16)
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:file-bad')
  expect(toasts).toContain(conductorFileBadToast(COND))
  expect(h.store.has(CONDKEY)).toBe(true)
  expect(await statusText($)).toBe(STATUS_NONE)
})

test('/callboard off while the restore dialog is open, then Conductor clicked: nothing is granted, the saved grant is gone; a lead asked meanwhile is busy', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN], file: ['../app', '../app2'] })
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  await h.clock!.advance(2000)
  await waitFor(() => h.askCount === 1)
  expect((await $.command.run(lane('lead'))).text).toBe('A callboard question is already open. Answer it first.')
  expect((await $.command.run(lane('off'))).text).toBe('Conductor is now off.')
  release(YES)
  await waitFor(() => condLogs(stdins).includes('conductor-restore-rejected:changed'))
  await h.clock!.advance(2000)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(h.store.has(CONDKEY)).toBe(false)
  expect(condLogs(stdins)).not.toContain('conductor-restored:widened 1')
})
test('/callboard off while the restore dialog is open, then Cancel clicked: logged as changed, not as the person\'s cancel', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN], file: ['../app', '../app2'] })
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  await h.clock!.advance(2000)
  await waitFor(() => h.askCount === 1)
  expect((await $.command.run(lane('off'))).text).toBe('Conductor is now off.')
  release(NO)
  await waitFor(() => condLogs(stdins).includes('conductor-restore-rejected:changed'))
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:changed')
  expect(condLogs(stdins)).not.toContain('conductor-restore-cancelled:')
})

test('the file widened again while the grant dialog is open: Conductor grants nothing (changed)', async ($, on) => {
  await condAt($, on)
  putCond(['../app'])
  h.askScript = async () => {
    putCond(['../app', '../app2'])
    return YES
  }
  expect((await condRun($, '')).text).toBe(conductorRefusalText('conductor-changed', COND, 'Conductor stays off'))
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(h.store.has(CONDKEY)).toBe(false)
})
test('the file widened again while the restore dialog is open: Conductor restores nothing (changed) and keeps the key', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN], file: ['../app', '../app2'] })
  h.askScript = async () => {
    putCond(['../app', '../app2', FAR])
    return YES
  }
  await h.clock!.advance(2000)
  await waitFor(() => condLogs(stdins).includes('conductor-restore-rejected:changed'))
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(h.store.has(CONDKEY)).toBe(true)
})

test('a restore in another folder deletes the key; a lane hint or a lead restore at start blocks it with its code and keeps the key', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { cwd: PIN })
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:wrong-folder')
  expect(h.store.has(CONDKEY)).toBe(false)
})
test('a lane on its way back (a restore hint) is not restored as a conductor; the key is kept', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { seed: () => h.store.set(`sess:${SID}`, LANE_HINT()) })
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:lane-holder')
  expect(h.store.has(CONDKEY)).toBe(true)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('a lead restore at start stands; the conductor restore ends lead-holder and keeps the key', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { seed: () => h.store.set(LEADKEY, { pin: COND, savedAt: T0 - 60_000 }) })
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:lead-holder')
  expect(await statusText($)).toContain('| Lead | ON |')
  expect(h.store.has(CONDKEY)).toBe(true)
})
test('a lane restarted in the conductor repo (a store record naming the session) is not restored as a conductor, and its rebind still runs', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { seed: () => storeFiles.set(CONDSTORE, JSON.stringify({ repo: COND, lanes: [{ name: 'CL', folder: COND, brief: `${COND}/BRIEF.md`, createdAt: 1, sid: SID }], creates: [] })) })
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:lane-holder')
  for (let i = 0; i < 3 && !toasts.includes(reboundToast('CL')); i++) await h.clock!.advance(2000)
  expect(toasts).toContain(reboundToast('CL'))
  expect(await statusText($)).toContain('| Lane | CL |')
})

test('/callboard off while the restore retries: no grant lands and the key is gone; /callboard lead (yes) while it retries: the lead stands', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { seed: () => ((h.sessions = {}), (h.ownEntryAuto = false)) })
  expect((await $.command.run(lane('off'))).text).toBe('Conductor is now off.')
  expect(h.store.has(CONDKEY)).toBe(false)
  h.sessions = condSelf()
  await ticks(4)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('/callboard lead while a conductor restore retries: the lead grant stands and the restore ends', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { seed: () => ((h.sessions = {}), (h.ownEntryAuto = false)) })
  h.sessions = condSelf()
  h.ownEntryAuto = true
  await grantAt($, COND)
  await ticks(3)
  expect(await statusText($)).toContain('| Lead | ON |')
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:lead-holder')
})
test('/callboard off while a conductor restore waits on its tool registration: no conductor, and no saved grant', async ($, on) => {
  const stdins: string[] = []
  let release!: () => void
  const { start } = await condRestarter($, on, stdins, { noStart: true, seed: () => (h.laneRegisterHang = new Promise<void>((r) => (release = r))) })
  for (let i = 0; i < 3; i++) await h.clock!.advance(1000)
  await $.command.run(lane('off'))
  release()
  let done = false
  void start.then(() => (done = true))
  for (let i = 0; i < 40 && !done; i++) await h.clock!.advance(1000)
  await ticks(3)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(h.store.has(CONDKEY)).toBe(false)
  expect(condLogs(stdins)).not.toContain('conductor-restored:')
})

test('a listed repo that is no longer a git root is left out at the grant and the restore, and named in the reply', async ($, on) => {
  await condAt($, on)
  putCond(['../app', '../app2'])
  extraStat.delete(`${APP2}/.git`)
  expect((await condRun($, '')).text).toBe(`${CONDUCTOR_ON_TEXT} Out of reach: ../app2 (not a git repo root).`)
  expect(h.lastQuestion).toBe(conductorQuestion(COND, [PIN], CHOME))
})
test('a restore leaves out a repo that is no longer a git root', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { seed: () => extraStat.delete(`${APP2}/.git`) })
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (1 repo)']))
  expect(h.store.get(CONDKEY)).toMatchObject({ repos: [PIN] })
})

test('the grant and the restore refuse conductor-repo-in-use', async ($, on) => {
  await condAt($, on)
  putCond(['../app'])
  storeFiles.set(CONDSTORE, JSON.stringify({ repo: COND, lanes: [{ name: 'CL', folder: COND, brief: `${COND}/BRIEF.md`, createdAt: 1 }], creates: [] }))
  expect((await condRun($, '')).text).toBe(conductorRefusalText('conductor-repo-in-use', COND, 'Conductor stays off'))
  expect(h.askCount).toBe(0)
})
test('a restore in a repo that has lanes is refused and keeps the key', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { seed: () => storeFiles.set(CONDSTORE, JSON.stringify({ repo: COND, lanes: [{ name: 'CL', folder: COND, brief: `${COND}/BRIEF.md`, createdAt: 1 }], creates: [] })) })
  expect(condLogs(stdins)).toContain('conductor-restore-rejected:conductor-repo-in-use')
  expect(h.store.has(CONDKEY)).toBe(true)
})
test('the restore dialog shows a long absolute entry whole', async ($, on) => {
  const stdins: string[] = []
  const far = `/Users/x/${'d'.repeat(50)}/${'e'.repeat(60)}/repo`
  await condRestarter($, on, stdins, { repos: [PIN], file: ['../app', far], seed: () => extraStat.set(`${far}/.git`, dirStat) })
  h.askAnswer = NO
  await h.clock!.advance(2000)
  await waitFor(() => h.askCount === 1)
  expect(h.lastQuestion).toContain(`New: ~${far.slice(CHOME.length)} (not next to cond).`)
})

test('the conductor\'s lane_list shows its repos\' lanes inside one Conductor box, none of another repo and none of the conductor repo', async ($, on) => {
  await condOn($, on)
  const t = (await $.tool.call(listCall())).result as string
  expect(t.split('\n')[0]).toBe('**Conductor COND** · live')
  expect(t).toContain('| Any lead | app | ')
  expect(t).toContain('| API |')
  expect(t).not.toContain('LABLANE')
  expect((await $.command.run(lane('lanes'))).text).toBe(t)
})

test('a remove elsewhere narrows the next lane_list at once; a repo re-added there is not reached here, and the saved grant drops it', async ($, on) => {
  const stdins: string[] = []
  await condOn($, on, stdins)
  putCond(['../app2'])
  expect((await $.tool.call(listCall())).result).toBe(NO_LANES_COND)
  expect(h.store.get(CONDKEY)).toMatchObject({ repos: [APP2] })
  putCond(['../app', '../app2'])
  expect((await $.tool.call(listCall())).result).toBe(NO_LANES_COND)
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (1 repo)']))
  expect(h.store.get(CONDKEY)).toMatchObject({ repos: [APP2] })
  expect(condLogs(stdins)).toContain('conductor-ratchet:1')
})

test('after the last remove a live conductor\'s presence file is deleted at the next refresh and its tools refuse conductor-list', async ($, on) => {
  await condOn($, on, [], { clock: true })
  expect(leadFiles.has(SELFPATH)).toBe(true)
  putCond([])
  await ticks(6)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain(`lane_list refused: ${REASON_TEXT['conductor-list']}`)
})

test('the conductor\'s lane_terminate names the repo, refuses a second stop while open (busy), signals after Force stop, and reaches no lane outside its repos', async ($, on) => {
  const argv: string[][] = []
  await condOn($, on, [], { argv })
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const n = h.askCount
  const first = $.tool.call(mgrCall('terminate', 'API'))
  await waitFor(() => h.askCount > n)
  expect(h.lastQuestion).toBe(terminateQuestion('API', APISID, 4500, PIN, true))
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain('lane_terminate refused: busy')
  release(YES)
  expect((await first).result).toBe('lane API terminated and removed: SIGTERM sent to process 4500. Its .archive/API/ folder and report stay.')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4500']])
  h.askHang = undefined
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'LABLANE')))).toContain('other-repo')
  expect(killed(argv).length).toBe(1)
})
test('a repo removed while the stop dialog is open sends nothing', async ($, on) => {
  const argv: string[][] = []
  await condOn($, on, [], { argv })
  h.askScript = async () => {
    putCond(['../app2'])
    return YES
  }
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain('other-repo')
  expect(killed(argv)).toEqual([])
})
// The off half on its own grant, so its dialog opens (the remove above ratchets ../app out of the approved list).
test('an off while the conductor\'s stop dialog is open sends nothing', async ($, on) => {
  const argv: string[][] = []
  await condOn($, on, [], { argv })
  h.askScript = async () => {
    await $.command.run(lane('off'))
    return YES
  }
  const n = h.askCount
  const r = JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))
  expect(h.askCount).toBe(n + 1)
  expect(r).toContain('lane_terminate refused: the lead tools are off.')
  expect(killed(argv)).toEqual([])
})
test('the conductor\'s stop refuses target-is-lead and sid-mismatch before any dialog', async ($, on) => {
  const argv: string[][] = []
  await condOn($, on, [], { argv, seed: () => putStore([ckLane({ sid: OTHER })]) })
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain('sid-mismatch')
  putStore([ckLane({ sid: APISID })])
  leadFiles.set(`${ROOT}/leads/${APISID}.json`, { text: JSON.stringify({ sid: APISID, pid: 4500, procStart: LEADPS, repo: PIN }) })
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain('target-is-lead')
  expect(h.askCount).toBe(1)
  expect(killed(argv)).toEqual([])
})

test('every lane tool but list, compact and terminate refuses a conductor (conductor-tool), lane_create too', async ($, on) => {
  await condOn($, on)
  for (const verb of ['resume', 'retire', 'park', 'unpark', 'rename', 'start', 'create', 'open']) {
    const r = JSON.stringify(await $.tool.call({ tool: `mcp__callboard__lane_${verb}`, lane: 'API', name: 'NEWL', task: 'x', sid: APISID } as any))
    expect(r, verb).toContain(REASON_TEXT['conductor-tool'])
  }
})

test('the conductor\'s lane_compact compacts a lead of its repos, cues a lane in reach, and refuses a lead outside its repos (other-repo)', async ($, on) => {
  const argv: string[][] = []
  await condOn($, on, [], { argv, sess: { ...CSESS(), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  expect((await $.tool.call(mgrCall('compact', 'LEAD'))).result).toBe('cue compact acted for lead LEAD.')
  expect(argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === `${ROOT}/cue/${LEADSID}.cue`).length).toBe(1)
  expect((await $.tool.call(mgrCall('compact', 'API'))).result).toBe('cue compact acted for lane API.')
  leadFiles.set(LEADPATH, { text: leadFileText({ repo: FAR }) })
  expect(JSON.stringify(await $.tool.call(mgrCall('compact', 'LEAD')))).toContain('lane_compact refused: other-repo')
  expect(argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === `${ROOT}/cue/${LEADSID}.cue`).length).toBe(1)
})

test('/callboard lead, lane and manager in a conductor refuse conductor-holder; after off, lead-after-conductor, lane-after-conductor and manager-after-conductor', async ($, on) => {
  await condOn($, on)
  const n = h.askCount
  expect((await $.command.run(lane('lead'))).text).toBe(`Lead stays off: ${REASON_TEXT['conductor-holder']}`)
  expect((await $.command.run(lane('manager'))).text).toBe(managerRefusalText('conductor-holder'))
  expect((await $.command.run(lane('lane'))).text).toContain(REASON_TEXT['conductor-holder'])
  await $.command.run(lane('off'))
  expect((await $.command.run(lane('lead'))).text).toBe(`Lead stays off: ${REASON_TEXT['lead-after-conductor']}`)
  expect((await $.command.run(lane('manager'))).text).toBe(managerRefusalText('manager-after-conductor'))
  expect((await $.command.run(lane('lane'))).text).toContain(REASON_TEXT['lane-after-conductor'])
  expect(h.askCount).toBe(n)
})

test('a session that was a conductor is not offered the Restore question for a lane hint; /callboard lane refuses lane-after-conductor', async ($, on) => {
  const stdins: string[] = []
  await condOn($, on, stdins)
  h.store.set(`${HINT_PREFIX}${SID}`, LANE_HINT())
  await $.command.run(lane('off'))
  const n = h.askCount
  expect((await $.command.run(lane('lane'))).text).toContain(REASON_TEXT['lane-after-conductor'])
  expect(h.askCount).toBe(n)
  // The Restore path is not entered at all: it would read the hint and log its verdict.
  expect(logged(stdins).filter((x) => x.startsWith('hint-'))).toEqual([])
})

test('a conductor gets no check-ins and no lanes-changed notice', async ($, on) => {
  await condOn($, on, [], { clock: true, sess: condSelf() })
  // Every other condition of a check-in holds (as ckLead): a lane in reach whose session is gone, its report not signed, an idle session with no background work.
  h.reportAt = `${PIN}/.archive/API/REPORT.md`
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  putStore([ckLane({ sid: APISID }), madeLane('NEWL')])
  await idleFor(40 * MIN)
  expect(submitted.filter((t) => t.includes('Check-in') || t === LANES_CHANGED_TEXT)).toEqual([])
})

test('the conductor section is in the system prompt while the grant holds and gone after off; a silent restore appends no note', async ($, on) => {
  await condOn($, on)
  const r = await $.prompt.compose(COMPOSE)
  expect(condSections(r).length).toBe(1)
  expect(condSections(r)[0].text).toBe(conductorBriefing('COND', COND, [PIN, APP2]))
  expect(condSections(r)[0].text).toContain('A live lead with no lanes is one row with – in the lane cells')
  expect(briefings(r).length).toBe(0)
  await $.command.run(lane('off'))
  expect(condSections(await $.prompt.compose(COMPOSE)).length).toBe(0)
})
test('a silent restore appends no note and serves the section', async ($, on) => {
  await condRestarter($, on, [])
  expect(h.appendRows.length).toBe(0)
  expect(condSections(await $.prompt.compose(COMPOSE)).length).toBe(1)
})

test('/callboard off deletes the saved grant; Cancel from the person\'s prompt does the same', async ($, on) => {
  await condOn($, on)
  expect(h.store.has(CONDKEY)).toBe(true)
  expect((await $.command.run(lane('off'))).text).toBe('Conductor is now off.')
  expect(h.store.has(CONDKEY)).toBe(false)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  await condRun($, '')
  expect(h.store.has(CONDKEY)).toBe(true)
  putCond(['../app', '../app2', FAR])
  h.askAnswer = NO
  expect((await condRun($, '')).text).toBe('Conductor is now off.')
  expect(h.store.has(CONDKEY)).toBe(false)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('the next start after off is not a conductor', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins)
  await $.command.run(lane('off'))
  expect(h.store.has(CONDKEY)).toBe(false)
})
test('the off question asked from another origin in a conductor session names the conductor and its saved grant', async ($, on) => {
  await condOn($, on)
  h.askAnswer = NO
  await $.command.run(lane('off', { kind: 'plugin', name: 'x' }))
  expect(h.lastQuestion).toBe(`Asked from another plugin. ${CONDUCTOR_OFF_QUESTION}`)
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Conductor', 'ON (2 repos)']))
})

// ---- the Conductor box in the manager's list ----
const COND2 = '7a1b2c3d-0000-4000-8000-123456789abc'

test('the manager\'s list nests a live conductor\'s repos in a Conductor box inside the Manager box and keeps other repos at the Manager level', async ($, on) => {
  await mgrAt($, on, [], { sess: { ...MGR_SESS(), ...regAs(OTHERLEAD, 4243, 'CONDX') }, seed: () => condPresenceOf(OTHERLEAD, 4243, 'CONDX', [PIN]) })
  const t = (await $.tool.call(listCall())).result as string
  const lines = t.split('\n')
  expect(lines[0]).toBe('**Manager MANAGER** · live')
  expect(lines[2].startsWith('| Conductor | Lead | Repo | Lane |')).toBe(true)
  const condRow = lines.findIndex((l) => l.startsWith('| CONDX | Any lead | app | '))
  const workRow = lines.findIndex((l) => l.startsWith('| – | Any lead | work | '))
  expect(condRow).toBeGreaterThan(3)
  expect(lines.some((l) => l.includes('| API | '))).toBe(true)
  expect(workRow).toBeGreaterThan(condRow)
})

test('a repo listed by two conductors appears once, under the first, with an also note; the other conductor shows no lanes in its repos', async ($, on) => {
  await mgrAt($, on, [], {
    sess: { ...MGR_SESS(), ...regAs(OTHERLEAD, 4243, 'CONDX'), ...regAs(COND2, 4244, 'CONDY') },
    seed: () => {
      condPresenceOf(OTHERLEAD, 4243, 'CONDX', [PIN])
      condPresenceOf(COND2, 4244, 'CONDY', [PIN, APP2])
    },
  })
  const t = (await $.tool.call(listCall())).result as string
  expect(t.split('| Any lead | app (also CONDY) | ').length).toBe(2)
  expect(t).toContain('| CONDX | Any lead | app (also CONDY) | ')
  expect(t).toMatch(/^\| CONDY \| – \| – \| /m)
  expect(t.indexOf('| CONDX | ')).toBeLessThan(t.indexOf('| CONDY | '))
})

test('a conductor file that fails the check gives no box; a leads folder that cannot be read draws the list flat with a note', async ($, on) => {
  await mgrAt($, on, [], { seed: () => condPresenceOf(OTHERLEAD, 4243, 'CONDX', [PIN]) })
  const t = (await $.tool.call(listCall())).result as string
  expect(t).not.toContain('Conductor')
  expect(t).toContain('| Any lead | app | ')
  h.leadsStatRejects = true
  const flat = (await $.tool.call(listCall())).result as string
  expect(flat).toContain('| Any lead | app | ')
  expect(flat).not.toContain('Conductor')
  expect(flat.endsWith('|\n\n(conductors could not be read)')).toBe(true)
})

// ---- laneless leads: a live lead with no lanes is in the manager's and a conductor's list ----
const leadPresenceOf = (sid: string, pid: number, repo: string, over: Record<string, unknown> = {}, file: Record<string, unknown> = {}) =>
  leadFiles.set(`${ROOT}/leads/${sid}.json`, { text: JSON.stringify({ sid, pid, procStart: LEADPS, repo, ...over }), ...file })

test('laneless leads (manager): a live lead with no lanes gets a box under its repo, a lead in a repo with no lanes too; no lanes is said once', async ($, on) => {
  await mgrAt($, on, [], {
    sess: { ...MGR_SESS(), ...regAs(OTHERLEAD, 4243, 'LEAD-A'), ...regAs(COND2, 4244, 'LEAD-B') },
    seed: () => {
      extraStat.set(`${APP2}/.git`, dirStat)
      leadPresenceOf(OTHERLEAD, 4243, PIN)
      leadPresenceOf(COND2, 4244, APP2)
    },
  })
  const t = (await $.tool.call(listCall())).result as string
  expect(t.split('\n')[0]).toBe('**Manager MANAGER** · live')
  expect(t).toMatch(/^\| LEAD-A \| app \| – \|( – \|)+ – \|$/m)
  expect(t).toMatch(/^\| LEAD-B \| app2 \| – \|( – \|)+ – \|$/m)
  expect(t).toContain('| Any lead | app | ')
  expect(t.match(/^\| LEAD-[AB] \|/gm)?.length).toBe(2)
  expect((await $.command.run(lane('lanes'))).text).toBe(t)
})

test('laneless leads (manager): inside a live conductor\'s Conductor box when the conductor lists the lead\'s repo', async ($, on) => {
  await mgrAt($, on, [], {
    sess: { ...MGR_SESS(), ...regAs(OTHERLEAD, 4243, 'LEAD-A'), ...regAs(COND2, 4244, 'CONDX') },
    seed: () => {
      leadPresenceOf(OTHERLEAD, 4243, PIN)
      condPresenceOf(COND2, 4244, 'CONDX', [PIN])
    },
  })
  const t = (await $.tool.call(listCall())).result as string
  // The conductor's name is on its first row only; the laneless lead's row sits under it.
  expect(t).toMatch(/^\| CONDX \| Any lead \| app \| /m)
  expect(t).toMatch(/^\|  \| LEAD-A \| app \| – \|( – \|)+ – \|$/m)
})

test('laneless leads (conductor): a live lead of a listed repo is in the Conductor box, one of a repo it does not list is not; lane_list and /callboard lanes agree', async ($, on) => {
  await condOn($, on, [], {
    sess: { ...CSESS(), ...regAs(OTHERLEAD, 4243, 'LEAD-A'), ...regAs(COND2, 4244, 'LEAD-B') },
    repos: ['../app'],
    seed: () => {
      extraStat.set(`${APP2}/.git`, dirStat)
      leadPresenceOf(OTHERLEAD, 4243, PIN)
      leadPresenceOf(COND2, 4244, APP2)
    },
  })
  const t = (await $.tool.call(listCall())).result as string
  expect(t.split('\n')[0]).toBe('**Conductor COND** · live')
  expect(t).toMatch(/^\| LEAD-A \| app \| – \|( – \|)+ – \|$/m)
  expect(t).not.toContain('LEAD-B')
  expect((await $.command.run(lane('lanes'))).text).toBe(t)
})

test('laneless leads: a stale file, a lead without a registry row or without a name, and a lead the checks refuse are not shown', async ($, on) => {
  await mgrAt($, on, [], {
    sess: { ...MGR_SESS(), ...regAs(OTHERLEAD, 4243, 'LEAD-A'), ...regAs(COND2, 4244, 'LEAD-B'), '4245.json': leadReg({ sessionId: '9a1b2c3d-0000-4000-8000-123456789abc', pid: 4245, name: undefined })['4242.json'], ...regAs('ba1b2c3d-0000-4000-8000-123456789abc', 4247, 'LEAD-C') },
    seed: () => {
      leadPresenceOf(OTHERLEAD, 4243, PIN, {}, { mtimeSec: T0 / 1000 - 31 })
      leadPresenceOf(COND2, 4244, PIN, { procStart: 'Wed Oct 28 01:00:00 2026' })
      leadPresenceOf('9a1b2c3d-0000-4000-8000-123456789abc', 4245, PIN)
      leadPresenceOf('aa1b2c3d-0000-4000-8000-123456789abc', 4246, PIN)
      leadPresenceOf('ba1b2c3d-0000-4000-8000-123456789abc', 4247, '/Users/x')
    },
  })
  const t = (await $.tool.call(listCall())).result as string
  expect(t).not.toContain('**Lead ')
  expect(t).not.toContain('no lanes')
})

test('laneless leads: a lead\'s own list does not show the other leads of its repo', async ($, on) => {
  await leadAt($, on, [], { sess: { ...selfAs('LEAD-A'), ...regAs(OTHERLEAD, 4243, 'LEAD-B') }, seed: () => leadPresenceOf(OTHERLEAD, 4243, PIN) })
  expect(await listed($)).toBe(NO_LANES)
})

// ---- a lead takes a compact cue from its conductor ----
// A lead in PIN; another session (OTHERLEAD, pid 4243, CONDX) is a conductor in COND listing ../app, with its saved grant and its list file.
const trustSeed = (over: Record<string, unknown> = {}) => () => {
  extraStat.set(`${COND}/.git`, dirStat)
  putCond(['../app'])
  h.store.set(`conductor:${OTHERLEAD}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 })
  condPresenceOf(OTHERLEAD, 4243, 'CONDX', [PIN], over)
}
const CTSESS = () => ({ ...leadSelfReg(), ...regAs(OTHERLEAD, 4243, 'CONDX') })
async function condLead($: any, on: any, stdins: string[] = [], trace?: Trace) {
  await leadAt($, on, stdins, { clock: true, sess: CTSESS(), seed: trustSeed(), trace })
  const arm = async () => {
    expect((await $.tool.call(GOOD as any)).result).toBe('queued')
    await $.turn.complete(TURN as any)
  }
  return { cue, arm }
}

test('a lead with an armed on-cue request compacts on its conductor\'s cue while the presence file, the saved grant and the list file all hold its repo; no request gives no-request; other verbs are refused', async ($, on) => {
  const stdins: string[] = []
  const { cue, arm } = await condLead($, on, stdins)
  expect(await cue(90, 'compact\n')).toBe('compact refused no-request 90\n')
  expect(nudges()).toEqual([])
  await arm()
  for (const [ino, verb] of [[91, 'resume'], [92, 'retire'], [93, 'park']] as const) expect(await cue(ino, `${verb}\n`)).toBe(`${verb} refused not-eligible ${ino}\n`)
  expect(seen.compacted).toBe(false)
  expect(await cue(94, 'compact\n')).toBe('compact ok - 94\n')
  expect(seen.compacted).toBe(true)
})

const refusedWith = async (stdins: string[], $: any, on: any, change: () => void) => {
  const { cue, arm } = await condLead($, on, stdins)
  await arm()
  change()
  expect(await cue(95, 'compact\n')).toBe('compact refused not-eligible 95\n')
  expect(seen.compacted).toBe(false)
}
test('refused when the conductor\'s saved grant does not list the repo, though the presence file and the list file do', async ($, on) => {
  await refusedWith([], $, on, () => h.store.set(`conductor:${OTHERLEAD}`, { home: COND, repos: [APP2], savedAt: T0 - 60_000 }))
})
test('refused when the conductor\'s saved grant is gone or names another home', async ($, on) => {
  await refusedWith([], $, on, () => h.store.set(`conductor:${OTHERLEAD}`, { home: '/Users/x/code/other', repos: [PIN], savedAt: T0 - 60_000 }))
})
test('refused when the list file no longer lists the repo', async ($, on) => {
  await refusedWith([], $, on, () => putCond(['../app2']))
})
test('refused when the presence check fails (no registry row of the conductor)', async ($, on) => {
  await refusedWith([], $, on, () => (h.sessions = leadSelfReg()))
})
test('refused when the list file cannot be read', async ($, on) => {
  await refusedWith([], $, on, () => condFiles.set(CONDFILE, '{bad'))
})
test('refused when the presence file\'s home is not its own real path', async ($, on) => {
  await refusedWith([], $, on, () => realMap.set(COND, '/Users/x/real/cond'))
})
test('refused when the presence file\'s home is not a git root', async ($, on) => {
  await refusedWith([], $, on, () => extraStat.delete(`${COND}/.git`))
})

test('an adopted lane with no live lead refuses a conductor\'s resume (no-lead), takes its compact, and still takes the manager\'s', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane svc-api')
  leadFiles.clear()
  h.cueLead = false
  trustSeed()()
  h.sessions = { ...ownReg(), ...regAs(OTHERLEAD, 4243, 'CONDX') }
  expect(await cue(81, 'resume\n')).toBe('resume refused no-lead 81\n')
  expect(await cue(82, 'compact\n')).toBe('compact held nudged 82\n')
  mgrFile()
  h.sessions = { ...ownReg(), ...mgrRow() }
  expect(await cue(83, 'resume\n')).toBe('resume ok - 83\n')
})

// ---- a lane made by a lead takes a cue by the same rule as a joined one ----
// A session bound to LABLANE by a birth rename (store of /data/x/work), with no live lead unless the test makes one (cue adds one while h.cueLead holds).
const bornLane = async ($: any, on: any, setup?: () => void) => {
  await renameThroughTick($, on, [], 1, undefined, async () => {
    h.cueLead = false
    setup?.()
  })
  expect((await $.command.run(lane('status'))).text).toContain('| Lane | LABLANE |')
}
// The cue each verb sends, one inode each; the answers are 'VERB refused CODE INO\n' or 'VERB ok - INO\n'.
const bornCues = async (verbs: string[]) => {
  const out: Record<string, string> = {}
  let ino = 100
  for (const v of verbs) out[v] = (await cue(ino++, `${v}\n`))!
  return out
}
const REFUSED = (v: string, ino: number) => `${v} refused no-lead ${ino}\n`
// A conductor (OTHERLEAD, CONDX) over /data/x/work: its presence file, saved grant, list file and registry row, as a lead sees them.
const bornConductor = () => {
  extraStat.set(`${COND}/.git`, dirStat)
  putCond(['/data/x/work'])
  h.store.set(`conductor:${OTHERLEAD}`, { home: COND, repos: ['/data/x/work'], savedAt: T0 - 60_000 })
  condPresenceOf(OTHERLEAD, 4243, 'CONDX', ['/data/x/work'])
  h.sessions = { ...h.sessions, ...regAs(OTHERLEAD, 4243, 'CONDX') }
}

test('a made lane with no live lead, no manager and no conductor takes no resume, compact, retire, park or start cue (no-lead)', async ($, on) => {
  await bornLane($, on)
  const r = await bornCues(['resume', 'compact', 'retire', 'park', 'start'])
  expect(r).toEqual({ resume: REFUSED('resume', 100), compact: REFUSED('compact', 101), retire: REFUSED('retire', 102), park: REFUSED('park', 103), start: REFUSED('start', 104) })
})

test('a made lane takes its cues while a live lead of its repo is there', async ($, on) => {
  await bornLane($, on)
  h.cueLead = true
  expect(await cue(110, 'resume\n')).toBe('resume ok - 110\n')
  for (const v of ['compact', 'retire', 'park']) expect(await cue(111, `${v}\n`)).not.toContain('no-lead')
})

test('a made lane with no live lead takes resume, compact and retire from a trusted manager, and no other cue', async ($, on) => {
  await bornLane($, on, () => {
    mgrFile()
    h.sessions = { ...h.sessions, ...mgrRow() }
  })
  expect(await cue(120, 'resume\n')).toBe('resume ok - 120\n')
  for (const v of ['compact', 'retire']) expect(await cue(121, `${v}\n`)).not.toContain('no-lead')
  expect(await cue(122, 'park\n')).toBe(REFUSED('park', 122))
  expect(await cue(123, 'start\n')).toBe(REFUSED('start', 123))
})

test('a made lane with no live lead takes compact from a trusted conductor of its repo, and no other cue', async ($, on) => {
  await bornLane($, on, bornConductor)
  expect(await cue(130, 'compact\n')).not.toContain('no-lead')
  for (const v of ['resume', 'retire', 'park', 'start']) expect(await cue(131, `${v}\n`)).toBe(REFUSED(v, 131))
})

test('a conductor\'s compact reaches a made lane whose lead is gone, and an untrusted conductor\'s does not', async ($, on) => {
  await bornLane($, on, bornConductor)
  leadFiles.delete(`${ROOT}/leads/${OTHERLEAD}.json`)
  expect(await cue(140, 'compact\n')).toBe(REFUSED('compact', 140))
})

// ---- a lead's briefing names its conductor ----
const leadCondSect = async ($: any) => ((await $.prompt.compose(COMPOSE)).sections as { id: string; text: string; scope: string }[]).filter((x) => x.id === 'callboard:lead-conductor')
const condSettle = async ($: any, n: number, tries = 400) => {
  for (let i = 0; i < tries && (await leadCondSect($)).length !== n; i++) await new Promise((r) => setTimeout(r, 5))
  return leadCondSect($)
}
test('the lead section names its conductor while one is trusted, and is gone at the first look after its off', async ($, on) => {
  await condLead($, on)
  await h.clock!.advance(2000)
  expect(await condSettle($, 1)).toEqual([{ id: 'callboard:lead-conductor', text: leadConductorText(['CONDX']), scope: 'session' }])
  expect(leadConductorText(['CONDX'])).toContain('Conductor `CONDX` coordinates leads')
  h.store.delete(`conductor:${OTHERLEAD}`)
  await idleFor(62_000)
  expect(await condSettle($, 0)).toEqual([])
  await $.command.run(lane('off'))
  expect(await leadCondSect($)).toEqual([])
})
longTest('no section while the conductor is not trusted (no saved grant)', async ($, on) => {
  await leadAt($, on, [], { clock: true, sess: CTSESS(), seed: () => { trustSeed()(); h.store.delete(`conductor:${OTHERLEAD}`) } })
  await h.clock!.advance(2000)
  expect(await condSettle($, 1, 60)).toEqual([])
})
test('two trusted conductors: both named, follow the one that gave the task; an unnamed one is a conductor session', async ($, on) => {
  await leadAt($, on, [], {
    clock: true,
    sess: { ...CTSESS(), ...regAs(COND2, 4244, 'CONDY') },
    seed: () => {
      trustSeed()()
      h.store.set(`conductor:${COND2}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 })
      condPresenceOf(COND2, 4244, 'CONDY', [PIN])
    },
  })
  await h.clock!.advance(2000)
  const s = await condSettle($, 1)
  expect(s.length).toBe(1)
  expect(s[0].text).toContain('Conductors `CONDX`, `CONDY` (follow the one that gave you your task) coordinate')
  expect(leadConductorText([''])).toContain('A conductor session coordinates')
  expect(leadConductorText(['ok', 'bad name'])).toContain('Conductors `ok`, a conductor session (follow')
})
test('every lead briefing says other leads of its repo may message it to align work', async ($, on) => {
  expect(leadBriefing(PIN)).toContain('Other leads of this repo (one lead per ticket) may message you to align work')
})

// ---- the conductor's grant and list: an off during a restore, an add during a read, a repo named twice, the same repos in another order ----
// The list file as a hand edit leaves it: entries in the order given (putCond writes through the sorting writer).
const putCondRaw = (repos: string[]) => {
  putCond([])
  condFiles.set(CONDFILE, JSON.stringify({ repos }))
}
test('an off while the restore saves its narrowed list leaves no saved grant', async ($, on) => {
  const stdins: string[] = []
  let offText = ''
  const seed = () => {
    h.condSetHook = async () => {
      offText = (await $.command.run(lane('off'))).text
    }
  }
  await condRestarter($, on, stdins, { repos: [PIN, APP2], file: ['../app'], seed })
  expect(offText).toBe('Its saved conductor grant was removed.')
  await h.clock!.advance(2000)
  expect(condLogs(stdins)).toContain('conductor-ratchet:1')
  expect(h.store.has(CONDKEY)).toBe(false)
  expect(await statusText($)).toBe(STATUS_NONE)
})
const APP3 = '/Users/x/code/app3'
test('an add click that lands while a tool call reads the list is kept, not ratcheted away by that read', async ($, on) => {
  const stdins: string[] = []
  await condOn($, on, stdins)
  extraStat.set(`${APP3}/.git`, dirStat)
  let release!: () => void
  let paused = false
  // Pause the tool call's resolve of the list it has just read (a realpath of PIN after a read of the file), not an earlier realpath of the pin.
  const base = h.condHeads
  h.realHook = (path) => {
    if (path !== PIN || paused || h.condHeads === base) return undefined
    paused = true
    h.realHook = undefined
    return new Promise<void>((r) => (release = r))
  }
  const listing = $.tool.call(listCall())
  await waitFor(() => paused)
  expect((await condRun($, 'add app3')).text).toContain('../app3')
  release()
  await listing
  expect(condLogs(stdins).filter((x) => x.startsWith('conductor-ratchet'))).toEqual([])
  // The stale read served its own call from the file it read; the next read reaches the added repo.
  await $.tool.call(listCall())
  expect(await statusText($)).toContain(`| Conductor | ${conductorStatus(3)} |`)
  expect((h.store.get(CONDKEY) as { repos: string[] }).repos).toContain(APP3)
})
test('a hand-written list naming one repo twice (../app and its path) reaches it once; the presence file and the saved grant stay valid', async ($, on) => {
  await condAt($, on)
  putCond(['../app', PIN])
  expect((await condRun($, '')).text).toBe(CONDUCTOR_ON_TEXT)
  expect(await statusText($)).toContain(`| Conductor | ${conductorStatus(1)} |`)
  expect((h.store.get(CONDKEY) as { repos: string[] }).repos).toEqual([PIN])
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text).repos).toEqual([PIN])
})
test('the same repos in another order after the grant dialog are no change', async ($, on) => {
  await condAt($, on)
  putCondRaw(['../app2', '../app'])
  h.askScript = async () => {
    putCondRaw(['../app', '../app2'])
    return YES
  }
  expect((await condRun($, '')).text).toBe(CONDUCTOR_ON_TEXT)
  expect(await statusText($)).toContain(`| Conductor | ${conductorStatus(2)} |`)
})
test('the same repos in another order after the restore dialog are no change', async ($, on) => {
  const stdins: string[] = []
  await condRestarter($, on, stdins, { repos: [PIN], file: ['../app2', '../app'], seed: () => putCondRaw(['../app2', '../app']) })
  h.askScript = async () => {
    putCondRaw(['../app', '../app2'])
    return YES
  }
  await h.clock!.advance(2000)
  await waitFor(() => condLogs(stdins).includes('conductor-restored:widened 1'))
  expect(await statusText($)).toContain(`| Conductor | ${conductorStatus(2)} |`)
})

// ---- the conductor's list file and its writer: an unsafe folder, a swapped temp file, an add outside a conductor, an unreadable list ----
test('a .claude folder group or other may write is unsafe: add is refused and the list is not read', async ($, on) => {
  await condAt($, on)
  putCond(['../app'])
  extraStat.set(`${COND}/.claude`, '501 775 2 Directory 8 64 1700000000\n')
  expect((await condRun($, 'add app2')).text).toBe(condNo('conductor-file-unsafe'))
  expect(condEntries()).toEqual(['../app'])
  expect((await condRun($, '')).text).not.toBe(CONDUCTOR_ON_TEXT)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('a temp file swapped for a link after it was written is not renamed into place', async ($, on) => {
  const stdins: string[] = []
  await condAt($, on, stdins)
  putCond(['../app'])
  h.condWriteHook = (tmp) => extraStat.set(tmp, '501 644 1 Symbolic Link 77 12 1700000000\n')
  expect((await condRun($, 'add app2')).text).toBe(conductorRefusalText('conductor-file-write', COND))
  expect(condEntries()).toEqual(['../app'])
  expect(logged(stdins)).toContain('error:conductor-file-write')
})
const APP4 = '/Users/x/code/app4'
test('an add asked outside a conductor does not approve the repo for this session when a restore lands while its dialog is open', async ($, on) => {
  const stdins: string[] = []
  // No own registry row at start: the restore waits and retries on the tick.
  await condRestarter($, on, stdins, { seed: () => ((h.sessions = {}), (h.ownEntryAuto = false)) })
  extraStat.set(`${APP4}/.git`, dirStat)
  expect(await statusText($)).toBe(STATUS_NONE)
  h.askScript = async () => {
    h.sessions = condSelf()
    for (let i = 0; i < 3 && !condLogs(stdins).includes('conductor-restored:'); i++) await h.clock!.advance(2000)
    expect(condLogs(stdins)).toContain('conductor-restored:')
    return YES
  }
  const r = (await condRun($, 'add app4')).text
  expect(r).toContain('../app4')
  expect(condEntries()).toContain('../app4')
  expect(await statusText($)).toContain(`| Conductor | ${conductorStatus(2)} |`)
  expect((h.store.get(CONDKEY) as { repos: string[] }).repos).not.toContain(APP4)
})
test('a list file that becomes unreadable empties the reach: the presence file goes and status says 0 repos', async ($, on) => {
  await condOn($, on, [], { clock: true, sess: condSelf() })
  expect(leadFiles.has(SELFPATH)).toBe(true)
  condFiles.set(CONDFILE, '{bad')
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain('refused')
  await h.clock!.advance(2000)
  await waitFor(() => !leadFiles.has(SELFPATH))
  expect(await statusText($)).toContain(`| Conductor | ${conductorStatus(0)} |`)
})
