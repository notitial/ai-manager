import { expect, test } from 'claude-code/testing'
import { LEAD_MANAGER_TEXT, MANAGER_RESTORE_QUESTION, MANAGER_RESTORED_TOAST, MANAGER_UNANSWERED_TOAST, MANAGER_REFRESH_MS, MANAGER_SILENT_GRACE_MS, REASON_TEXT, MANAGER_QUESTION, MANAGER_ON_TEXT, MANAGER_ALREADY, MANAGER_H2, managerRefusalText, managerBriefingNote, terminateQuestion, retireQuestion, removeQuestion } from '../hooks/core'
import { h, GOOD, LANESDIR, NO, PS_TABLE, ROOT, SID, T0, YES, colorRuns, extraStat, laneSeed, leadFiles, lockLog, longTest, psCalls, psDead, psFail, renames, seen, statErr, storeFiles, toasts, toolDefs } from './harness'
import { APISID, COMPOSE, HOME, LEADPATH, LEADPS, LEADSID, MGR_NOAPI, MGR_SESS, MIN, NEWSID, OTHER, OTHERLEAD, OTHERMGR, PIN, QUIET, REPORT_OK, SELFPATH, STATUS_NONE, TURN, attacher, checkins, ckLane, ckLead, ckText, cue, cueSession, dirStat, doLane, grantAt, idleFor, killed, lane, leadAt, leadFileText, leadReg, leadSelfReg, listCall, logged, madeLane, mgrAt, mgrCall, mgrFile, mgrRow, newTrace, noArchiveRm, noteRows, nudges, ownReg, putStore, regAs, started, statusTable, statusText, storeNames, ticks, unanswered, waitFor } from './fixtures'

// lane_remove does not exist (retire and terminate remove the record): five.
const MGR_TOOLS = ['lane_list', 'lane_resume', 'lane_compact', 'lane_terminate', 'lane_retire']

test('manager: one dialog (header Manager, buttons Manager and Cancel); a yes writes the manager file with no repo, appends the briefing, declares five tools, and sets the name and colour from the timer', async ($, on) => {
  const stdins: string[] = []
  // toolDefs is kept across tests: only the definitions this test's grant registered.
  const defs0 = toolDefs.length
  const r = await mgrAt($, on, stdins, { clock: true, seed: () => h.store.set('reserved', { names: ['HARBOR'] }) })
  expect(r.text).toBe(MANAGER_ON_TEXT)
  expect(h.lastQuestion).toBe(MANAGER_QUESTION)
  expect(h.lastHeader).toBe('Manager')
  expect(h.askedOptions).toEqual([['Manager', 'Cancel']])
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text)).toEqual({ sid: SID, pid: 4400, procStart: LEADPS, level: 'manager', name: 'MANAGER' })
  const rows = noteRows()
  expect(rows.length).toBe(1)
  expect(rows[0].text).toBe(managerBriefingNote('MANAGER'))
  expect(rows[0].text).toContain(MANAGER_H2)
  expect(rows[0].text).toContain('every time; never unattended')
  // The role is docs/manager/README.md.
  expect(rows[0].text).toContain('`docs/manager/README.md` in the ai-manager checkout')
  const names = toolDefs.slice(defs0).map((d) => JSON.parse(d).name).filter((n: string) => n.startsWith('lane_'))
  expect([...new Set(names)].sort()).toEqual([...MGR_TOOLS].sort())
  for (const t of ['lane_terminate', 'lane_retire']) expect(toolDefs.slice(defs0).find((d) => d.includes(`"${t}"`))).toContain('Every stop asks the person')
  expect(toolDefs.slice(defs0).some((d) => d.includes('"lane_remove"'))).toBe(false)
  expect((await $.command.run(lane('status'))).text).toBe(statusTable(['Lane', 'NONE'], ['Manager', 'ON'], ['Check-ins', 'ON']))
  expect(logged(stdins)).toContain('manager-on:prompt')
  expect(renames).toEqual([])
  expect(colorRuns).toEqual([])
  await h.clock!.advance(2000)
  expect(renames).toEqual(['MANAGER'])
  expect(colorRuns).toEqual(['cyan'])
  expect(logged(stdins)).toContain('renamed:manager')
  expect(logged(stdins).some((x) => x.startsWith('manager-color'))).toBe(true)
  expect((await $.command.run(lane('manager'))).text).toBe(MANAGER_ALREADY)
  // Another NAME changes nothing, and the answer names the one that stays.
  expect((await $.command.run(lane('manager HARBOR'))).text).toBe('Manager is already on in this session; the name stays MANAGER.')
  expect((await $.command.run(lane('manager MANAGER'))).text).toBe(MANAGER_ALREADY)
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text).name).toBe('MANAGER')
  expect(h.askCount).toBe(1)
})

test('manager: NAME must be MANAGER or a name reserved on this machine (a fixed refusal, no dialog); a session that already carries the name is not renamed', async ($, on) => {
  const stdins: string[] = []
  const r = await mgrAt($, on, stdins, { clock: true, args: 'manager LEAD', sess: MGR_SESS({ name: 'HARBOR', nameSource: 'user' }), seed: () => h.store.set('reserved', { names: ['HARBOR'] }) })
  expect(r.text).toBe(managerRefusalText('manager-name'))
  for (const bad of ['manager harbor', 'manager MANAGER!', 'manager LANE-1', 'manager WARDEN']) expect((await $.command.run(lane(bad))).text).toBe(managerRefusalText('manager-name'))
  expect(h.askCount).toBe(0)
  expect(logged(stdins)).toContain('refused:manager-name')
  expect((await $.command.run(lane('manager HARBOR'))).text).toBe(MANAGER_ON_TEXT)
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text).name).toBe('HARBOR')
  expect(logged(stdins)).toContain('rename-skipped:manager')
  await h.clock!.advance(4000)
  expect(renames).toEqual([])
  expect(colorRuns).toEqual(['cyan'])
})

test('manager: with no NAME a session already carrying a reserved name keeps it; any other name (or a near miss) becomes MANAGER', async ($, on) => {
  const stdins: string[] = []
  expect((await mgrAt($, on, stdins, { clock: true, sess: MGR_SESS({ name: 'HARBOR', nameSource: 'user' }), seed: () => h.store.set('reserved', { names: ['HARBOR'] }) })).text).toBe(MANAGER_ON_TEXT)
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text).name).toBe('HARBOR')
  // The test's own copy of core has no machine names, so the expected text is the MANAGER one with the name swapped.
  expect(noteRows()[0].text).toBe(managerBriefingNote('MANAGER').replace('(`MANAGER`)', '(`HARBOR`)'))
  expect(logged(stdins)).toContain('rename-skipped:manager')
  await h.clock!.advance(4000)
  expect(renames).toEqual([])
  expect((await $.command.run(lane('off'))).text).toBe('Manager is now off.')
})

test('manager: with no NAME a near miss of a reserved name (another case) is not kept; the session becomes MANAGER', async ($, on) => {
  expect((await mgrAt($, on, [], { clock: true, sess: MGR_SESS({ name: 'Harbor', nameSource: 'user' }), seed: () => h.store.set('reserved', { names: ['HARBOR'] }) })).text).toBe(MANAGER_ON_TEXT)
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text).name).toBe('MANAGER')
  await h.clock!.advance(2000)
  expect(renames).toEqual(['MANAGER'])
})

test('manager: Cancel, a dialog that times out, and a dialog already open grant nothing', async ($, on) => {
  await mgrAt($, on, [], { clock: true })
  await $.command.run(lane('off'))
  h.askAnswer = NO
  expect((await $.command.run(lane('manager'))).text).toBe('Manager stays off.')
  h.askHang = new Promise<string>(() => undefined)
  expect((await unanswered($.command.run(lane('manager', { kind: 'plugin', name: 'x' })))).text).toBe('Manager stays off. The question timed out.')
  expect(h.lastQuestion).toBe(`Asked from another plugin. ${MANAGER_QUESTION}`)
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const open = $.command.run(lane('manager'))
  await waitFor(() => h.lastQuestion !== `Asked from another plugin. ${MANAGER_QUESTION}`)
  expect((await $.command.run(lane('manager'))).text).toBe('A callboard question is already open. Answer it first.')
  release(NO)
  expect((await open).text).toBe('Manager stays off.')
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(leadFiles.has(SELFPATH)).toBe(false)
})

test('manager: /callboard off drops the grant and the presence file; status names the level; the manager cannot become a lead or a lane in place', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins)
  expect((await $.command.run(lane('lead'))).text).toBe('Lead stays off: this session is the manager, so it cannot be a lane or a lead. Run /callboard off first.')
  expect(logged(stdins)).toContain('refused:lead-manager-holder')
  expect((await $.command.run(lane('status'))).text).toBe(statusTable(['Lane', 'NONE'], ['Manager', 'ON'], ['Check-ins', 'ON']))
  expect((await $.command.run(lane('off'))).text).toBe('Manager is now off.')
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain('lane_list refused: the lead tools are off')
})

test('manager: refused before the dialog in a lead, and in a session that was a lead (manager-after-lead)', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins)
  const asked = h.askCount
  expect((await $.command.run(lane('manager'))).text).toBe(managerRefusalText('lead-holder'))
  await $.command.run(lane('off'))
  expect((await $.command.run(lane('manager'))).text).toBe(managerRefusalText('manager-after-lead'))
  expect(h.askCount).toBe(asked)
  expect(logged(stdins)).toEqual(expect.arrayContaining(['refused:lead-holder', 'refused:manager-after-lead']))
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

test('manager: refused in a bound lane, with no dialog', async ($, on) => {
  await started($, on, [], { bound: true })
  expect((await $.command.run(lane('manager'))).text).toBe(managerRefusalText('lane-holder'))
  expect(h.askCount).toBe(0)
})

test('manager: refused while another live session holds a manager file, whatever its name, before the dialog and after a yes; a stale or invalid one does not count', async ($, on) => {
  const stdins: string[] = []
  const r = await mgrAt($, on, stdins, { sess: { ...MGR_SESS(), ...mgrRow() }, seed: () => mgrFile() })
  expect(r.text).toBe(managerRefusalText('manager-exists'))
  h.sessions = { ...MGR_SESS(), ...mgrRow('SOMEONE') }
  expect((await $.command.run(lane('manager'))).text).toBe(managerRefusalText('manager-exists'))
  expect(h.askCount).toBe(0)
  // A file whose process is gone is no manager.
  h.sessions = MGR_SESS()
  expect((await $.command.run(lane('manager'))).text).toBe(MANAGER_ON_TEXT)
  await $.command.run(lane('off'))
  // One that appears while the question is open: refused after the yes, nothing set up.
  leadFiles.delete(OTHERMGR)
  h.askScript = () => {
    mgrFile()
    h.sessions = { ...MGR_SESS(), ...mgrRow() }
    return YES
  }
  expect((await $.command.run(lane('manager'))).text).toBe(managerRefusalText('manager-exists'))
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

test('manager tools: lane_list and lane_resume reach lanes in every repo; every other lane tool is refused manager-tool', async ($, on) => {
  const argv: string[][] = []
  await mgrAt($, on, [], { argv })
  const list = (await $.tool.call(listCall())).result as string
  expect(list.startsWith('**Manager MANAGER** · live\n\n| Lead | Repo | Lane | Folder | Session | Waiting |\n')).toBe(true)
  expect(list).not.toMatch(/^>/m)
  expect(list).toContain('| Any lead | work | ')
  expect(list).toContain('| Any lead | app | ')
  expect(list).not.toContain('~/code')
  expect(list).not.toContain('/data/x')
  expect(list).toContain('| LABLANE | ')
  expect(list).toContain('| API | ')
  expect((await $.tool.call(mgrCall('resume', 'LABLANE'))).result).toBe('cue resume acted for lane LABLANE.')
  expect((await $.tool.call(mgrCall('resume', 'API'))).result).toBe('cue resume acted for lane API.')
  for (const verb of ['create', 'open', 'rename', 'start', 'park', 'unpark'])
    expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'API'))), verb).toContain('the manager may only list, resume, compact, force stop and retire lanes.')
  expect(argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1].startsWith(`${ROOT}/cue/`)).length).toBe(2)
})

test('manager lane_terminate: the dialog names the repo; a second stop while it is open is refused busy; the signal goes after Force stop', async ($, on) => {
  const argv: string[][] = []
  await mgrAt($, on, [], { argv })
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  const n = h.askCount
  const first = $.tool.call(mgrCall('terminate', 'LABLANE'))
  await waitFor(() => h.askCount !== n)
  expect(h.lastQuestion).toBe(terminateQuestion('LABLANE', OTHER, 4600, '/data/x/work'))
  expect(h.lastQuestion).toContain("Force stop lane LABLANE's session in work (")
  expect(h.lastQuestion).toContain(" It ends at once, even mid-task. The lane's record is then removed.")
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain('lane_terminate refused: busy')
  // A retire that passes its early checks (signed report) reaches its own dialog and is refused busy there.
  h.reportFile = REPORT_OK()
  expect(JSON.stringify(await $.tool.call(mgrCall('retire', 'LABLANE')))).toContain('lane_retire refused: busy')
  release(YES)
  expect((await first).result).toBe('lane LABLANE terminated and removed: SIGTERM sent to process 4600. Its .archive/LABLANE/ folder and report stay.')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4600']])
  h.askHang = undefined
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain('did not confirm')
  expect(killed(argv).length).toBe(1)
})

test('manager lane_terminate: nothing is sent when the grant ends while the dialog is open (the re-check refuses off)', async ($, on) => {
  const argv: string[][] = []
  await mgrAt($, on, [], { argv })
  // This guards "the grant still held": with no grant the re-check's leadPrep (leadCore) refuses off before the level is compared.
  // The level clause of the re-check (grant-changed) is a backstop no command path reaches: a session that was the manager is refused
  // /callboard lead (lead-after-manager) and one that was a lead is refused /callboard manager (manager-after-lead). The test of the check before the kill covers that one.
  h.askScript = async () => {
    await $.command.run(lane('off'))
    return YES
  }
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'LABLANE')))).toContain('lane_terminate refused: the lead tools are off')
  expect(killed(argv)).toEqual([])
})

test('manager lane_retire: asks once naming the repo; Cancel sends no cue; Retire sends the cue and signals on the lane\'s ok', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await mgrAt($, on, stdins, { argv })
  h.reportFile = REPORT_OK()
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(mgrCall('retire', 'LABLANE')))).toContain('did not confirm')
  expect(h.lastQuestion).toBe(retireQuestion('LABLANE', '/data/x/work'))
  expect(h.lastQuestion).toBe("Retire lane LABLANE in work? The lane's record is then removed.")
  expect(stdins).not.toContain('retire\n')
  expect(argv.some((a) => a[0] === '/bin/mv' && a[a.length - 1].startsWith(`${ROOT}/cue/`))).toBe(false)
  h.askAnswer = YES
  expect((await $.tool.call(mgrCall('retire', 'LABLANE'))).result).toBe('lane LABLANE retired and removed: SIGTERM sent to process 4600. Its .archive/LABLANE/ folder and report stay.')
  expect(stdins).toContain('retire\n')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4600']])
})
const WORKSTORE = `${LANESDIR}/${'d'.repeat(64)}.json`
const workNames = () => (JSON.parse(storeFiles.get(WORKSTORE)!).lanes as { name: string }[]).map((l) => l.name)
// APISID live under another name, holding a lead presence file.
const apiAsLead = () => {
  leadFiles.set(`${ROOT}/leads/${APISID}.json`, { text: JSON.stringify({ sid: APISID, pid: 4500, procStart: LEADPS, repo: PIN }) })
  h.sessions = { ...MGR_NOAPI(), ...cueSession(APISID, 'APILEAD', PIN, { pid: 4500 }) }
}
// APISID (API's recorded session) live under another name, or under none, with no presence file.
const apiRenamed = (name: string | undefined = 'RENAMED') => ({ ...MGR_NOAPI(), ...cueSession(APISID, name, `${PIN}/api`, { pid: 4500 }) })

test('manager lane_terminate of a lane no live session carries: the Remove question names the repo; Cancel removes nothing; Remove removes the record from that store', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await mgrAt($, on, stdins, { argv, sess: MGR_NOAPI() })
  const asked = h.askCount
  h.askAnswer = NO
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain('lane_terminate refused: the person did not confirm. Nothing was removed.')
  expect(h.lastQuestion).toBe(removeQuestion('API', PIN, false, HOME))
  // The repo by its home-relative path.
  expect(h.lastQuestion).toBe('Remove lane API in ~/code/app? It has no live session.')
  expect(h.lastHeader).toBe('Stop Lane')
  expect(h.askedOptions[h.askedOptions.length - 1]).toEqual(['Remove', 'Cancel'])
  expect(storeNames()).toEqual(['API'])
  expect(logged(stdins)).toContain('refused:lead-not-confirmed')
  h.askAnswer = YES
  expect((await $.tool.call(mgrCall('terminate', 'API'))).result).toBe('lane API terminated and removed: it had no live session. Its .archive/API/ folder and report stay.')
  expect(storeNames()).toEqual([])
  expect(h.askCount).toBe(asked + 2)
  expect(logged(stdins)).toContain('lane-removed:API')
  expect(killed(argv)).toEqual([])
  expect(noArchiveRm(argv)).toBe(true)
})

test('manager lane_terminate of a parked lane no live session carries: the question carries the parked sentence', async ($, on) => {
  await mgrAt($, on, [], { sess: MGR_NOAPI(), seed: () => putStore([ckLane({ sid: APISID, parked: T0 - 60_000 })]) })
  h.askAnswer = NO
  await $.tool.call(mgrCall('terminate', 'API'))
  expect(h.lastQuestion).toBe(removeQuestion('API', PIN, true, HOME))
  expect(h.lastQuestion).toContain('It is parked: its saved conversation is no longer reachable from callboard.')
  expect(storeNames()).toEqual(['API'])
  h.askAnswer = YES
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain('terminated and removed')
  expect(storeNames()).toEqual([])
})

test('manager lane_retire of a lane no live session carries: needs no report; Cancel removes nothing; Retire removes the record', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await mgrAt($, on, stdins, { argv, sess: MGR_NOAPI() })
  const asked = h.askCount
  const retire = async () => JSON.stringify(await $.tool.call(mgrCall('retire', 'API')))
  // No REPORT.md anywhere: nothing runs, so there is no session to sign one.
  h.reportFile = undefined
  h.askAnswer = NO
  expect(await retire()).toContain('lane_retire refused: the person did not confirm.')
  expect(h.lastQuestion).toBe(removeQuestion('API', PIN, false, HOME))
  expect(h.lastQuestion).toBe('Remove lane API in ~/code/app? It has no live session.')
  expect(h.lastHeader).toBe('Stop Lane')
  expect(h.askedOptions[h.askedOptions.length - 1]).toEqual(['Remove', 'Cancel'])
  expect(storeNames()).toEqual(['API'])
  expect(logged(stdins)).not.toContain('lane-removed:API')
  h.askAnswer = YES
  expect(JSON.parse(await retire()).result).toBe('lane API retired and removed: it had no live session. Its .archive/API/ folder and report stay.')
  expect(storeNames()).toEqual([])
  expect(h.askCount).toBe(asked + 2)
  expect(logged(stdins)).toContain('lane-removed:API')
  expect(killed(argv)).toEqual([])
  expect(noArchiveRm(argv)).toBe(true)
})

test('manager lane_retire and lane_terminate: a lane whose recorded session is live under another name, or holds a presence file, is refused before any dialog', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins, { sess: MGR_NOAPI() })
  const asked = h.askCount
  for (const verb of ['terminate', 'retire']) {
    h.sessions = apiRenamed()
    expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'API'))), verb).toContain(`lane_${verb} refused: name-in-use: ${REASON_TEXT['name-in-use']}`)
    h.sessions = apiRenamed(undefined)
    expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'API'))), verb).toContain(`lane_${verb} refused: name-in-use: ${REASON_TEXT['name-in-use']}`)
    apiAsLead()
    expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'API'))), verb).toContain(`lane_${verb} refused: target-is-lead: `)
    leadFiles.delete(`${ROOT}/leads/${APISID}.json`)
  }
  expect(h.askCount).toBe(asked)
  expect(storeNames()).toEqual(['API'])
  expect(logged(stdins)).toContain('refused:lead-name-in-use')
  expect(logged(stdins)).toContain('refused:lead-target-is-lead')
  expect(logged(stdins)).not.toContain('lane-removed:API')
})

test('manager lane_terminate and lane_retire of a sessionless lane: a session or a presence file that comes while the dialog is open, or inside the store lock, removes nothing', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins, { sess: MGR_NOAPI() })
  const arrivals: [string, () => void, string][] = [
    ['a session carrying the name', () => void (h.sessions = MGR_SESS()), 'name-in-use'],
    ['the recorded session under another name', () => void (h.sessions = apiRenamed()), 'name-in-use'],
    ['the recorded session as a lead', apiAsLead, 'target-is-lead'],
  ]
  for (const verb of ['terminate', 'retire']) {
    for (const [what, arrive, code] of arrivals) {
      // The dialog is open: the change lands before the click is judged, and the check inside the lock catches it.
      h.askScript = () => {
        arrive()
        return YES
      }
      const asked = h.askCount
      expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'API'))), `${verb} ${what}`).toContain(`lane_${verb} refused: ${code}: `)
      expect(h.askCount).toBe(asked + 1)
      expect(storeNames()).toEqual(['API'])
      leadFiles.delete(`${ROOT}/leads/${APISID}.json`)
      h.sessions = MGR_NOAPI()
      // The change lands after the click, while the store lock is being taken.
      h.askScript = () => {
        h.lockHook = (ev) => {
          if (ev === 'mkdir') arrive()
        }
        return YES
      }
      const locks = lockLog.length
      expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'API'))), `${verb} ${what} in the lock`).toContain(`lane_${verb} refused: ${code}: `)
      expect(lockLog.slice(locks)).toContain('mkdir')
      expect(storeNames()).toEqual(['API'])
      h.lockHook = undefined
      leadFiles.delete(`${ROOT}/leads/${APISID}.json`)
      h.sessions = MGR_NOAPI()
    }
  }
  expect(logged(stdins)).not.toContain('lane-removed:API')
})

test('manager lane_terminate and lane_retire of a sessionless lane: a record parked or changed while the dialog is open removes nothing', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins, { sess: MGR_NOAPI() })
  for (const verb of ['terminate', 'retire']) {
    for (const edit of [ckLane({ sid: APISID, parked: T0 - 60_000 }), ckLane({ sid: NEWSID })]) {
      h.askScript = () => {
        putStore([edit])
        return YES
      }
      expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'API'))), verb).toContain(`lane_${verb} refused: changed: ${REASON_TEXT['changed']}`)
      expect(storeNames()).toEqual(['API'])
      putStore([ckLane({ sid: APISID })])
    }
  }
  expect(logged(stdins)).not.toContain('lane-removed:API')
})

test('manager lane_terminate and lane_retire of a sessionless lane: /callboard off while the dialog is open removes nothing', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins, { sess: MGR_NOAPI() })
  h.askScript = async () => {
    await $.command.run(lane('off'))
    return YES
  }
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'API')))).toContain(`lane_terminate refused: grant-changed: ${REASON_TEXT['grant-changed']}`)
  expect(storeNames()).toEqual(['API'])
  expect(logged(stdins)).not.toContain('lane-removed:API')
  // The grant is gone: the lead tools refuse a retire before any dialog.
  expect(JSON.stringify(await $.tool.call(mgrCall('retire', 'API')))).toContain('lane_retire refused: the lead tools are off')
  expect(storeNames()).toEqual(['API'])
})

test('manager lane_retire: /callboard off while its Retire dialog (a sessionless lane) is open removes nothing', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins, { sess: MGR_NOAPI() })
  h.askScript = async () => {
    await $.command.run(lane('off'))
    return YES
  }
  expect(JSON.stringify(await $.tool.call(mgrCall('retire', 'API')))).toContain(`lane_retire refused: grant-changed: ${REASON_TEXT['grant-changed']}`)
  expect(storeNames()).toEqual(['API'])
  expect(logged(stdins)).not.toContain('lane-removed:API')
})

test('manager lane_terminate and lane_retire of a live lane remove its record too, from its own repo\'s store only', async ($, on) => {
  const stdins: string[] = []
  const argv: string[][] = []
  await mgrAt($, on, stdins, { argv })
  h.askAnswer = YES
  expect((await $.tool.call(mgrCall('terminate', 'API'))).result).toBe('lane API terminated and removed: SIGTERM sent to process 4500. Its .archive/API/ folder and report stay.')
  expect(storeNames()).toEqual([])
  expect(workNames()).toEqual(['LABLANE'])
  expect(logged(stdins)).toContain('lane-removed:API')
  h.reportFile = REPORT_OK()
  expect((await $.tool.call(mgrCall('retire', 'LABLANE'))).result).toBe('lane LABLANE retired and removed: SIGTERM sent to process 4600. Its .archive/LABLANE/ folder and report stay.')
  expect(workNames()).toEqual([])
  expect(logged(stdins)).toContain('lane-removed:LABLANE')
  expect(killed(argv)).toEqual([['/bin/kill', '-TERM', '4500'], ['/bin/kill', '-TERM', '4600']])
  expect(noArchiveRm(argv)).toBe(true)
})

test('the manager\'s lane_compact names a live lead by its session name, in any repo; a lane of the same name refuses lane-or-lead; other verbs never reach a lead', async ($, on) => {
  const argv: string[][] = []
  await mgrAt($, on, [], { argv, sess: { ...MGR_SESS({ name: 'MANAGER' }), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  expect((await $.tool.call(mgrCall('compact', 'LEAD'))).result).toBe('cue compact acted for lead LEAD.')
  expect(argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === `${ROOT}/cue/${LEADSID}.cue`).length).toBe(1)
  for (const verb of ['resume', 'terminate', 'retire']) expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'LEAD'))), verb).toContain('unknown-lane')
  putStore([ckLane({ sid: APISID }), madeLane('LEAD')])
  expect(JSON.stringify(await $.tool.call(mgrCall('compact', 'LEAD')))).toContain('lane_compact refused: lane-or-lead: a lane and a live lead both carry that name')
  expect(argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1] === `${ROOT}/cue/${LEADSID}.cue`).length).toBe(1)
})

test('a lead with no manager grant cannot compact another lead by name', async ($, on) => {
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...regAs(LEADSID, 4242, 'OTHERLEAD') }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  expect(JSON.stringify(await $.tool.call(mgrCall('compact', 'OTHERLEAD')))).toContain('unknown-lane')
})

test('a lead takes a compact cue only while a live manager with a reserved name runs, only for its own on-cue request; any other verb is refused', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true, sess: { ...leadSelfReg(), ...mgrRow() }, seed: () => mgrFile() })
  expect(await cue(90, 'compact\n')).toBe('compact refused no-request 90\n')
  expect(nudges()).toEqual([])
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  expect(logged(stdins)).toContain('requested:on-cue-lead')
  await $.turn.complete(TURN as any)
  expect(logged(stdins)).toContain('armed:on-cue')
  for (const [ino, verb] of [[91, 'resume'], [92, 'retire'], [93, 'park'], [94, 'start']] as const) expect(await cue(ino, `${verb}\n`)).toBe(`${verb} refused not-eligible ${ino}\n`)
  expect(seen.compacted).toBe(false)
  // No manager, or one whose registry name is not reserved: refused.
  h.sessions = { ...leadSelfReg(), ...mgrRow('LEAD2') }
  expect(await cue(95, 'compact\n')).toBe('compact refused not-eligible 95\n')
  leadFiles.delete(OTHERMGR)
  h.sessions = leadSelfReg()
  expect(await cue(96, 'compact\n')).toBe('compact refused not-eligible 96\n')
  expect(seen.compacted).toBe(false)
  mgrFile()
  h.sessions = { ...leadSelfReg(), ...mgrRow() }
  expect(await cue(97, 'compact\n')).toBe('compact ok - 97\n')
  expect(seen.compacted).toBe(true)
})

test('an armed on-cue request the lead did not make through request_compact is not acted on; a plain session still cannot ask on-cue', async ($, on) => {
  const trace = newTrace()
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...mgrRow() }, seed: () => mgrFile(), trace })
  trace.st!.set('request', { value: { phase: 'armed', mode: 'on-cue', requestedMs: h.nowMs, id: 'r1', focus: 'f', continuation: 'c' }, version: 9 })
  expect(await cue(98, 'compact\n')).toBe('compact refused no-request 98\n')
  // A lead's request in mode now is never the manager's to act on, whatever it carries.
  trace.st!.set('request', { value: { phase: 'armed', mode: 'now', requestedMs: h.nowMs, id: 'r2', focus: 'f', continuation: 'c', viaLead: true }, version: 10 })
  expect(await cue(99, 'compact\n')).toBe('compact refused no-request 99\n')
  expect(seen.compacted).toBe(false)
  await $.command.run(lane('off'))
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('request_compact is not enabled for this session')
})

// ---- the manager's resume of an attached lane, the re-check before a kill, and the stop gates ----
test('an attached lane whose lead is gone takes the manager\'s resume while a trusted manager is live; start, and every cue with no such manager, stay refused no-lead', async ($, on) => {
  await attacher($, on, [], { clock: true })
  await doLane($, 'lane svc-api')
  leadFiles.clear()
  h.cueLead = false
  expect(await cue(71, 'resume\n')).toBe('resume refused no-lead 71\n')
  mgrFile()
  h.sessions = { ...ownReg(), ...mgrRow() }
  expect(await cue(72, 'resume\n')).toBe('resume ok - 72\n')
  // Retire and compact are taken too (past no-lead, to the verb's own checks).
  expect(await cue(76, 'retire\n')).toBe('retire refused report-missing 76\n')
  expect(await cue(77, 'compact\n')).toBe('compact held nudged 77\n')
  // start is no manager verb.
  expect(await cue(73, 'start\n')).toBe('start refused no-lead 73\n')
  // A manager file whose registry name is not a reserved one, or whose process is gone, is no manager here.
  h.sessions = { ...ownReg(), ...mgrRow('LEAD2') }
  expect(await cue(74, 'resume\n')).toBe('resume refused no-lead 74\n')
  h.sessions = { ...ownReg(), ...mgrRow() }
  psDead.add('4243')
  expect(await cue(75, 'resume\n')).toBe('resume refused no-lead 75\n')
})

test('a manager whose only quiet lane has a live lead stops after the timing gates: no notice gate reads, no notice', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins, { clock: true, sess: { ...leadSelfReg({ name: 'MANAGER' }), ...cueSession(APISID, 'API', `${PIN}/api`, { pid: 4500 }), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
  const shells = () => psCalls.filter((x) => x.includes('pid=,ppid=,comm=')).length
  const before = shells()
  await idleFor(40 * MIN)
  expect(checkins()).toEqual([])
  // backgroundShells is the notice's last gate read before its filter: never reached.
  expect(shells()).toBe(before)
})

test('a session that was the manager is refused /callboard lead before the dialog (lead-after-manager)', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins)
  expect((await $.command.run(lane('off'))).text).toBe('Manager is now off.')
  const asked = h.askCount
  expect((await $.command.run(lane('lead'))).text).toBe(`Lead stays off: ${REASON_TEXT['lead-after-manager']}`)
  expect(h.askCount).toBe(asked)
  expect(logged(stdins)).toContain('refused:lead-after-manager')
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

test('a grant dropped during the last process check before the signal sends nothing (grant-changed)', async ($, on) => {
  const argv: string[][] = []
  const stdins: string[] = []
  await mgrAt($, on, stdins, { argv })
  h.askScript = (q: string) => {
    // The click: the next process check is the re-check's, the last await before the signal.
    if (q.startsWith('Force stop')) h.psArgsHook = () => $.command.run(lane('off'))
    return YES
  }
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'LABLANE')))).toContain("lane_terminate refused: grant-changed: this session's grant changed while the question was open. No signal was sent.")
  expect(killed(argv)).toEqual([])
  // The re-check passed (it logs terminating only after it), and the refusal came after that line: the check right before kill refused.
  const lines = logged(stdins)
  expect(lines.indexOf('terminating:LABLANE')).toBeGreaterThan(-1)
  expect(lines.indexOf('refused:lead-grant-changed')).toBeGreaterThan(lines.indexOf('terminating:LABLANE'))
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

test('a manager\'s stop refuses, before any dialog, a target that holds a live presence file (target-is-lead) or that the lane record does not name (sid-mismatch)', async ($, on) => {
  const argv: string[][] = []
  await mgrAt($, on, [], { argv })
  h.reportFile = REPORT_OK()
  const asked = h.askCount
  // LABLANE's session (OTHER, pid 4600) is a live lead.
  const otherLead = `${ROOT}/leads/${OTHER}.json`
  leadFiles.set(otherLead, { text: JSON.stringify({ sid: OTHER, pid: 4600, procStart: LEADPS, repo: PIN }) })
  for (const verb of ['terminate', 'retire']) expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'LABLANE'))), verb).toContain(`lane_${verb} refused: target-is-lead: `)
  // One whose check cannot be made counts too (fail closed).
  psFail.add('4600')
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'LABLANE')))).toContain('lane_terminate refused: target-is-lead: ')
  psFail.clear()
  leadFiles.delete(otherLead)
  // API's record names OTHER, but APISID carries the name.
  putStore([ckLane({ sid: OTHER })])
  for (const verb of ['terminate', 'retire']) expect(JSON.stringify(await $.tool.call(mgrCall(verb, 'API'))), verb).toContain(`lane_${verb} refused: sid-mismatch: `)
  expect(h.askCount).toBe(asked)
  expect(killed(argv)).toEqual([])
  // With neither, the stop goes through its dialog.
  putStore([ckLane({ sid: APISID })])
  expect((await $.tool.call(mgrCall('terminate', 'API'))).result).toBe('lane API terminated and removed: SIGTERM sent to process 4500. Its .archive/API/ folder and report stay.')
  expect(h.askCount).toBe(asked + 1)
})

test('a target that becomes a lead while the stop dialog is open is refused after the click', async ($, on) => {
  const argv: string[][] = []
  await mgrAt($, on, [], { argv })
  h.askScript = (q: string) => {
    if (q.startsWith('Force stop')) leadFiles.set(`${ROOT}/leads/${OTHER}.json`, { text: JSON.stringify({ sid: OTHER, pid: 4600, procStart: LEADPS, repo: PIN }) })
    return YES
  }
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'LABLANE')))).toContain('lane_terminate refused: target-is-lead: ')
  expect(killed(argv)).toEqual([])
})

test('a lead\'s lane_compact never cues a session that holds a live lead presence file (lane-or-lead)', async ($, on) => {
  await ckLead($, on, [], {})
  // The session carrying lane API (OTHER, pid 4500) is a live lead of the same repo.
  const otherLead = `${ROOT}/leads/${OTHER}.json`
  leadFiles.set(otherLead, { text: JSON.stringify({ sid: OTHER, pid: 4500, procStart: LEADPS, repo: PIN }) })
  expect(JSON.stringify(await $.tool.call(mgrCall('compact', 'API')))).toContain('lane_compact refused: lane-or-lead: ')
  leadFiles.delete(otherLead)
  expect((await $.tool.call(mgrCall('compact', 'API'))).result).toBe('cue compact acted for lane API.')
})

test('a fresh manager file whose ps check fails counts as a manager (manager-exists); one whose process is gone does not', async ($, on) => {
  const stdins: string[] = []
  // psFail is reset by the engine set-up: set it in the seed.
  const r = await mgrAt($, on, stdins, {
    sess: { ...MGR_SESS(), ...mgrRow() },
    seed: () => {
      mgrFile()
      psFail.add('4243')
    },
  })
  expect(r.text).toBe(managerRefusalText('manager-exists'))
  expect(h.askCount).toBe(0)
  psFail.clear()
  psDead.add('4243')
  expect((await $.command.run(lane('manager'))).text).toBe(MANAGER_ON_TEXT)
})

test('a lead gets the on-cue section only while its tick last saw a trusted manager; it goes when the manager goes', async ($, on) => {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...mgrRow() }, seed: () => mgrFile() })
  const sect = async () => ((await $.prompt.compose(COMPOSE)).sections as { id: string; text: string; scope: string }[]).filter((x) => x.id === 'callboard:lead-manager')
  // The tick reads in the background: wait (bounded) for the section to show or go. idleFor keeps the presence files fresh across the minute.
  const settle = async (n: number) => {
    for (let i = 0; i < 400 && (await sect()).length !== n; i++) await new Promise((r) => setTimeout(r, 5))
    return sect()
  }
  await h.clock!.advance(2000)
  expect(await settle(1)).toEqual([{ id: 'callboard:lead-manager', text: LEAD_MANAGER_TEXT, scope: 'session' }])
  leadFiles.delete(OTHERMGR)
  h.sessions = leadSelfReg()
  await idleFor(62_000)
  expect(await settle(0)).toEqual([])
  h.sessions = { ...leadSelfReg(), ...mgrRow() }
  mgrFile()
  await idleFor(62_000)
  expect((await settle(1)).length).toBe(1)
  // Off: a plain session gets nothing, a manager on the Mac or not.
  await $.command.run(lane('off'))
  expect(await sect()).toEqual([])
})

// ---- a lead's manager look that hangs, a leads folder that fails, and the lead verdict the manager keeps ----
longTest('a lead\'s manager look that hangs times out: no section meanwhile, read again the next minute; after off and a new grant the old answer is not served', async ($, on) => {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...mgrRow() }, seed: () => mgrFile() })
  const sect = async () => ((await $.prompt.compose(COMPOSE)).sections as { id: string }[]).filter((x) => x.id === 'callboard:lead-manager').length
  // Waits (bounded) for the background look to show the section; a short wait where it must stay away.
  const settle = async (n: number, tries = 400) => {
    for (let i = 0; i < tries && (await sect()) !== n; i++) await new Promise((r) => setTimeout(r, 5))
    return sect()
  }
  // The first look's ps check of the manager's process never answers.
  h.psArgsHook = () => new Promise(() => undefined)
  await h.clock!.advance(2000)
  expect(await settle(1, 40)).toBe(0)
  // Past the timeout and the minute: the look runs again (the hook was used once) and sees the manager.
  await idleFor(62_000)
  expect(await settle(1)).toBe(1)
  // Every look hangs from now on: the one that times out takes the section away (live false), and so do the ones after it.
  const hang = () => {
    h.psArgsHook = hang
    return new Promise(() => undefined)
  }
  h.psArgsHook = hang
  await idleFor(62_000)
  await idleFor(62_000)
  expect(await settle(0)).toBe(0)
  h.psArgsHook = undefined
  await idleFor(62_000)
  expect(await settle(1)).toBe(1)
  // The manager goes; off and lead again before the minute is out: the old answer is not served, and the new grant's first look reads afresh.
  leadFiles.delete(OTHERMGR)
  h.sessions = leadSelfReg()
  await $.command.run(lane('off'))
  await grantAt($, PIN)
  expect(await sect()).toBe(0)
  await h.clock!.advance(2000)
  expect(await settle(1, 40)).toBe(0)
})

test('a leads folder whose list throws, or that fails its checks, holds a manager\'s stop and counts for manager-exists; a missing one does not', async ($, on) => {
  const argv: string[][] = []
  const listThrows = async () => {
    throw new Error('list')
  }
  // manager-exists: a list that throws is an unverified manager.
  expect((await mgrAt($, on, [], { argv, seed: () => (h.leadsListHook = listThrows) })).text).toBe(managerRefusalText('manager-exists'))
  h.leadsListHook = undefined
  expect((await $.command.run(lane('manager'))).text).toBe(MANAGER_ON_TEXT)
  const asked = h.askCount
  h.leadsListHook = listThrows
  expect(JSON.stringify(await $.tool.call(mgrCall('terminate', 'LABLANE')))).toContain('lane_terminate refused: target-is-lead: ')
  h.leadsListHook = undefined
  // A folder that is there but not 0700.
  extraStat.set(`${ROOT}/leads`, '501 755 2 Directory 11 64 1700000000\n')
  expect(JSON.stringify(await $.tool.call(mgrCall('retire', 'LABLANE')))).toContain('lane_retire refused: target-is-lead: ')
  expect(h.askCount).toBe(asked)
  // A missing folder: no presence file anywhere, so the stop goes through its dialog.
  extraStat.delete(`${ROOT}/leads`)
  statErr.set(`${ROOT}/leads`, `stat: ${ROOT}/leads: No such file or directory`)
  expect((await $.tool.call(mgrCall('terminate', 'LABLANE'))).result).toBe('lane LABLANE terminated and removed: SIGTERM sent to process 4600. Its .archive/LABLANE/ folder and report stay.')
  expect(h.askCount).toBe(asked + 1)
})

test('a manager file whose read fails once is read again and judged on that read; failing twice it still counts (manager-exists)', async ($, on) => {
  // The other manager's process is gone, so a good read says no manager.
  const r = await mgrAt($, on, [], {
    sess: { ...MGR_SESS(), ...mgrRow() },
    seed: () => {
      leadFiles.set(OTHERMGR, { text: JSON.stringify({ sid: OTHERLEAD, pid: 4243, procStart: LEADPS, level: 'manager', name: 'MANAGER' }), failHead: 2 })
      psDead.add('4243')
    },
  })
  expect(r.text).toBe(managerRefusalText('manager-exists'))
  leadFiles.get(OTHERMGR)!.failHead = 1
  expect((await $.command.run(lane('manager'))).text).toBe(MANAGER_ON_TEXT)
})

longTest('the manager keeps a repo\'s lead verdict for the next check-in evaluation, re-read every second one; a lead whose check errors counts as live (no notice)', async ($, on) => {
  const argv: string[][] = []
  // The only lane seen live is API, whose lead is live.
  await mgrAt($, on, [], { argv, clock: true, sess: { ...leadSelfReg({ name: 'MANAGER' }), ...cueSession(APISID, 'API', `${PIN}/api`, { pid: 4500 }), ...leadReg() }, seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) })
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  // No keepalive ping: its submit would restart the 20-minute idle gate, and the filter would not run.
  await $.command.run(lane('config keepalive off'))
  await $.turn.complete(TURN as any)
  await idleFor(32 * MIN)
  expect(checkins()).toEqual([])
  // API stays owed and its lead stays live: each minute's evaluation runs the filter and sends nothing. The verdict is
  // reused at the next evaluation (60-62 s apart) and read again at the one after, so six evaluations read the lead's file three times (60 s: six; 130 s: two).
  const reads = () => argv.filter((a) => a[0] === '/usr/bin/head' && a[a.length - 1] === LEADPATH).length
  const before = reads()
  await ticks(180)
  expect(reads() - before).toBe(3)
  // The lead's check cannot be made (its ps fails): not clearly gone, so API is still not told.
  psFail.add('4242')
  await idleFor(10 * MIN)
  expect(checkins()).toEqual([])
  // Clearly gone: told.
  psFail.clear()
  leadFiles.delete(LEADPATH)
  h.sessions = { ...leadSelfReg({ name: 'MANAGER' }), ...cueSession(APISID, 'API', `${PIN}/api`, { pid: 4500 }) }
  await idleFor(4 * MIN)
  expect(checkins()).toEqual([ckText(QUIET)])
})

test('a session that was the manager is refused /callboard lane before the dialog (lane-after-manager)', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins)
  expect((await $.command.run(lane('off'))).text).toBe('Manager is now off.')
  const asked = h.askCount
  expect((await $.command.run(lane('lane'))).text).toBe(`Lane not changed: ${REASON_TEXT['lane-after-manager']}`)
  expect(h.askCount).toBe(asked)
  expect(logged(stdins)).toContain('refused:lane-after-manager')
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
})

// ---- the manager restore dialog ----
const MGRKEY = `manager:${SID}`
// The folder the harness session starts in ($.session.root()), saved with the grant.
const MGRCWD = '/data/x/work/lab'
const mgrLogs = (stdins: string[]) => logged(stdins).filter((x) => x.startsWith('manager-'))
// A session that starts with a saved manager grant. Its row carries the name MANAGER, so the grant needs no rename.
const MSELF = (over: Record<string, unknown> = {}) => leadSelfReg({ name: 'MANAGER', ...over })
async function mgrRestarter($: any, on: any, stdins: string[], opts: { raw?: unknown; sess?: Record<string, string>; seed?: () => void; bound?: boolean } = {}) {
  laneSeed.text = undefined
  h.sessions = opts.sess ?? MSELF()
  await started($, on, stdins, {
    clock: true,
    bound: opts.bound,
    seed: () => {
      h.store.set(MGRKEY, opts.raw ?? { name: 'MANAGER', savedAt: T0 - 60_000 })
      opts.seed?.()
    },
  })
}

test('manager restore: the same conversation asks once when it starts, with the Manager dialog; Manager makes it the manager again, and saves the grant afresh', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins)
  expect(h.askCount).toBe(0)
  expect(await statusText($)).toBe(STATUS_NONE)
  await ticks(3)
  await waitFor(() => mgrLogs(stdins).includes('manager-restored:'))
  expect(h.lastQuestion).toBe(MANAGER_RESTORE_QUESTION)
  expect(h.lastQuestion).toBe('Restore this session as the manager of every lane on this machine? You made it the manager here earlier and callboard saved that; click Cancel if you did not. It can resume, compact, stop, retire and remove lanes in any repo. Every stop and remove asks you. Cancel removes the saved manager grant.')
  expect(h.lastHeader).toBe('Manager')
  expect(h.askedOptions).toEqual([['Manager', 'Cancel']])
  expect(h.askCount).toBe(1)
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Manager', 'ON'], ['Check-ins', 'ON']))
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text)).toEqual({ sid: SID, pid: 4400, procStart: LEADPS, level: 'manager', name: 'MANAGER' })
  expect(h.store.get(MGRKEY)).toEqual({ name: 'MANAGER', cwd: MGRCWD, savedAt: expect.any(Number) })
  expect((h.store.get(MGRKEY) as any).savedAt).toBeGreaterThan(T0)
  expect(toasts).toContain(MANAGER_RESTORED_TOAST)
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restore-rejected') || x.startsWith('manager-on'))).toBe(false)
  // Once: no further question on later ticks.
  await ticks(5)
  expect(h.askCount).toBe(1)
})

test('manager restore: Cancel deletes the saved grant, leaves the session off, and the next ticks ask nothing', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { seed: () => (h.askAnswer = NO) })
  h.askAnswer = NO
  await ticks(3)
  await waitFor(() => mgrLogs(stdins).includes('manager-restore-cancelled:'))
  expect(h.store.has(MGRKEY)).toBe(false)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  await ticks(5)
  expect(h.askCount).toBe(1)
})

longTest('manager restore: a dialog nobody answers restores nothing and keeps the saved grant; a dismissal is no answer too', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins)
  h.askHang = new Promise<string>(() => undefined)
  await ticks(3)
  await waitFor(() => h.askCount === 1)
  await ticks(50)
  await waitFor(() => mgrLogs(stdins).includes('manager-restore-unanswered:'))
  expect(toasts).toContain(MANAGER_UNANSWERED_TOAST)
  expect(h.store.get(MGRKEY)).toEqual({ name: 'MANAGER', savedAt: T0 - 60_000 })
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(h.askCount).toBe(1)
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restore-rejected') || x === 'manager-restore-cancelled:')).toBe(false)
})

test('manager restore: no question while the prompt box has a draft or the session is busy; it comes once the box is empty and the session idle', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { sess: MSELF({ status: 'busy' }) })
  h.draftNow = 'half a sentence'
  await ticks(4)
  expect(h.askCount).toBe(0)
  h.sessions = MSELF()
  await ticks(4)
  expect(h.askCount).toBe(0)
  h.draftNow = ''
  await h.clock!.advance(2000)
  await waitFor(() => mgrLogs(stdins).includes('manager-restored:'))
  expect(h.askCount).toBe(1)
})

test('manager restore: a --bg worker (row kind background) is never asked and keeps the saved grant; a missing row is retried', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { sess: MSELF({ kind: 'background' }) })
  await ticks(4)
  expect(h.askCount).toBe(0)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:not-person')
  expect(h.store.has(MGRKEY)).toBe(true)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('manager restore: a person\'s row that arrives late is retried and then asked', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { seed: () => ((h.sessions = {}), (h.ownEntryAuto = false)) })
  await ticks(3)
  expect(h.askCount).toBe(0)
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restore-rejected'))).toBe(false)
  h.sessions = MSELF()
  await h.clock!.advance(2000)
  await waitFor(() => mgrLogs(stdins).includes('manager-restored:'))
})

test('manager restore: another live manager on the Mac, a lead, a lane and a name no longer reserved each restore nothing, ask nothing and keep the saved grant', async ($, on) => {
  // Another live session holds a manager file.
  let stdins: string[] = []
  await mgrRestarter($, on, stdins, { sess: { ...MSELF(), ...mgrRow() }, seed: () => mgrFile() })
  await ticks(3)
  expect(h.askCount).toBe(0)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:manager-exists')
  expect(h.store.has(MGRKEY)).toBe(true)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('manager restore: a name that is no longer reserved on this machine restores nothing', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { raw: { name: 'HARBOR', savedAt: T0 - 60_000 } })
  await ticks(3)
  expect(h.askCount).toBe(0)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:manager-name')
  expect(h.store.has(MGRKEY)).toBe(true)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('manager restore: a reserved name other than MANAGER restores under that name', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { raw: { name: 'HARBOR', savedAt: T0 - 60_000 }, sess: MSELF({ name: 'HARBOR' }), seed: () => h.store.set('reserved', { names: ['HARBOR'] }) })
  await ticks(3)
  await waitFor(() => mgrLogs(stdins).includes('manager-restored:'))
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text).name).toBe('HARBOR')
  expect(h.store.get(MGRKEY)).toEqual({ name: 'HARBOR', cwd: MGRCWD, savedAt: expect.any(Number) })
  expect((h.store.get(MGRKEY) as any).savedAt).toBeGreaterThan(T0)
})
test('manager restore: a session that is a lane is not asked (lane-holder) and keeps the saved grant', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { bound: true })
  const asked = h.askCount
  await ticks(3)
  expect(h.askCount).toBe(asked)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:lane-holder')
  expect(h.store.has(MGRKEY)).toBe(true)
  expect(leadFiles.has(SELFPATH)).toBe(false)
})
test('manager restore: a session that is a lead is not asked (lead-holder) and keeps the saved grant', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { sess: MSELF({ name: 'LEAD', cwd: PIN }), seed: () => { extraStat.set(`${PIN}/.git`, dirStat); h.callerCwd = PIN; h.store.set(`lead:${SID}`, { pin: PIN, savedAt: T0 - 60_000 }) } })
  const asked = h.askCount
  await ticks(3)
  expect(h.askCount).toBe(asked)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:lead-holder')
  expect(h.store.has(MGRKEY)).toBe(true)
  expect(JSON.stringify(await statusText($))).toContain('| Lead | ON |')
})

test('manager restore: every check runs again after the yes: a manager that came up while the question was open means nothing is restored', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { sess: { ...MSELF(), ...mgrRow() } })
  h.askScript = async () => {
    mgrFile()
    return YES
  }
  await ticks(3)
  await waitFor(() => mgrLogs(stdins).includes('manager-restore-rejected:manager-exists'))
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(h.store.has(MGRKEY)).toBe(true)
})
test('manager restore: /callboard off while the question is open grants nothing and removes the saved grant', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins)
  let release: (a: string) => void = () => undefined
  h.askHang = new Promise<string>((r) => (release = r))
  await ticks(3)
  await waitFor(() => h.askCount === 1)
  expect((await $.command.run(lane('off'))).text).toContain('Its saved manager grant was removed.')
  release(YES)
  await ticks(4)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(h.store.has(MGRKEY)).toBe(false)
})

test('manager restore: the person\'s own /callboard manager while a restore waits ends the restore: no second question, the grant stands', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { sess: MSELF({ status: 'busy' }) })
  expect((await $.command.run(lane('manager'))).text).toBe(MANAGER_ON_TEXT)
  const asked = h.askCount
  h.sessions = MSELF()
  h.askAnswer = NO
  await ticks(5)
  expect(h.askCount).toBe(asked)
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restore'))).toBe(false)
  expect(h.store.get(MGRKEY)).toEqual({ name: 'MANAGER', cwd: MGRCWD, savedAt: T0 })
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Manager', 'ON'], ['Check-ins', 'ON']))
})

test('manager restore: a manager that still holds the grant in memory (a compaction) is not asked again', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins, { clock: true })
  expect(h.askCount).toBe(1)
  expect(h.store.get(MGRKEY)).toEqual({ name: 'MANAGER', cwd: MGRCWD, savedAt: h.nowMs })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ticks(5)
  expect(h.askCount).toBe(1)
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Manager', 'ON'], ['Check-ins', 'ON']))
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restore'))).toBe(false)
})

test('manager restore: an unanswered question is not asked again by a second session.start of the same process', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins)
  h.askHang = new Promise<string>(() => undefined)
  await ticks(3)
  await waitFor(() => h.askCount === 1)
  await ticks(50)
  await waitFor(() => mgrLogs(stdins).includes('manager-restore-unanswered:'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await ticks(5)
  expect(h.askCount).toBe(1)
  expect(h.store.has(MGRKEY)).toBe(true)
})

test('manager restore: a lead grant that the person cancels in a session with a saved manager grant leaves that grant alone', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { sess: MSELF({ status: 'busy' }) })
  h.askAnswer = NO
  await $.command.run(lane('lead'))
  expect(h.store.has(MGRKEY)).toBe(true)
})

test('manager restore: the saved grant is written at the person\'s yes and removed by /callboard off; Cancel on the grant dialog saves nothing', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins, { clock: true })
  expect(h.store.get(MGRKEY)).toEqual({ name: 'MANAGER', cwd: MGRCWD, savedAt: T0 })
  // The refresh cadence is c.leadRefreshDue with the level's refreshMs (core.spec, and the golden save tests).
  expect(MANAGER_REFRESH_MS).toBe(5 * MIN)
  expect((await $.command.run(lane('off'))).text).toContain('Manager is now off.')
  expect(h.store.has(MGRKEY)).toBe(false)
  h.askAnswer = NO
  expect((await $.command.run(lane('manager'))).text).toBe('Manager stays off.')
  expect(h.store.has(MGRKEY)).toBe(false)
})

test('manager restore: /callboard off in a session whose saved grant is not being restored (an unanswered one) says it was removed', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins)
  h.askHang = new Promise<string>(() => undefined)
  await ticks(3)
  await waitFor(() => h.askCount === 1)
  await ticks(50)
  await waitFor(() => mgrLogs(stdins).includes('manager-restore-unanswered:'))
  expect(h.store.has(MGRKEY)).toBe(true)
  expect((await $.command.run(lane('off'))).text).toContain('Its saved manager grant was removed.')
  expect(h.store.has(MGRKEY)).toBe(false)
})

test('manager restore: a saved grant that fails the parse is deleted with no question; another session\'s bad one is pruned at start', async ($, on) => {
  const stdins: string[] = []
  await mgrRestarter($, on, stdins, { raw: { name: 'bad name', savedAt: T0 }, seed: () => h.store.set('manager:11111111-0000-4000-8000-123456789abc', 'junk') })
  await ticks(3)
  expect(h.askCount).toBe(0)
  expect(h.store.has(MGRKEY)).toBe(false)
  expect(h.store.has('manager:11111111-0000-4000-8000-123456789abc')).toBe(false)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:invalid')
})

// ---- the silent restore: a saved grant that names this folder and is younger than the grace period comes back with no question ----
// The restore is decided at the second tick (4 s after the start, the mock clock's time), so a hint saved `age` before that is `age` old when it is judged.
const DECIDED = T0 + 4000
const silentHint = (age: number, over: Record<string, unknown> = {}) => ({ name: 'MANAGER', cwd: MGRCWD, savedAt: DECIDED - age, ...over })
const silentRestarter = ($: any, on: any, stdins: string[], raw: unknown, opts: { sess?: Record<string, string>; seed?: () => void; bound?: boolean } = {}) => mgrRestarter($, on, stdins, { ...opts, raw })
const restoredSilently = async (stdins: string[]) => {
  await ticks(2)
  await waitFor(() => mgrLogs(stdins).includes('manager-restored:silent'))
  expect(h.askCount).toBe(0)
}
const asksInstead = async (stdins: string[]) => {
  await ticks(3)
  await waitFor(() => mgrLogs(stdins).includes('manager-restored:'))
  expect(h.askCount).toBe(1)
  expect(h.lastQuestion).toBe(MANAGER_RESTORE_QUESTION)
}

test('manager silent restore: the same session id and folder back within the grace period is the manager again with no dialog, a toast, the presence file and a refreshed saved grant', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(10 * MIN))
  await restoredSilently(stdins)
  expect(toasts).toContain(MANAGER_RESTORED_TOAST)
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Manager', 'ON'], ['Check-ins', 'ON']))
  expect(JSON.parse(leadFiles.get(SELFPATH)!.text)).toEqual({ sid: SID, pid: 4400, procStart: LEADPS, level: 'manager', name: 'MANAGER' })
  expect(h.store.get(MGRKEY)).toEqual({ name: 'MANAGER', cwd: MGRCWD, savedAt: DECIDED })
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restore-rejected') || x.startsWith('manager-on'))).toBe(false)
  await ticks(5)
  expect(h.askCount).toBe(0)
})

test('manager silent restore: at the window edge, 59 min 59 s since the saved grant restores with no dialog (60 min 00 s asks, next test)', async ($, on) => {
  expect(MANAGER_SILENT_GRACE_MS).toBe(60 * MIN)
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MANAGER_SILENT_GRACE_MS - 1000))
  await restoredSilently(stdins)
})
test('manager silent restore: a saved grant exactly 60 minutes old asks', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MANAGER_SILENT_GRACE_MS))
  await asksInstead(stdins)
  expect(mgrLogs(stdins)).not.toContain('manager-restored:silent')
})
test('manager silent restore: a saved grant older than the grace period asks (the dialog, as before)', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(3 * 60 * MIN))
  await asksInstead(stdins)
  expect(toasts).toContain(MANAGER_RESTORED_TOAST)
  expect(mgrLogs(stdins)).not.toContain('manager-restored:silent')
})
test('manager silent restore: a saved grant for another folder asks', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN, { cwd: '/data/x/work/other' }))
  await asksInstead(stdins)
})
test('manager silent restore: a saved grant with no folder (the older shape) asks', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, { name: 'MANAGER', savedAt: DECIDED - MIN })
  await asksInstead(stdins)
})
test('manager silent restore: a saved grant whose folder is not a clean path asks', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN, { cwd: `${MGRCWD}/../lab` }))
  await asksInstead(stdins)
})
test('manager silent restore: a saved grant dated in the future, inside the clock skew, is no time known live: it asks', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(-30_000))
  await asksInstead(stdins)
})
test('manager silent restore: a saved grant dated more than a minute ahead is invalid: no grant, no dialog, the key goes', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(-2 * MIN))
  await ticks(3)
  expect(h.askCount).toBe(0)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:invalid')
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restored'))).toBe(false)
  expect(h.store.has(MGRKEY)).toBe(false)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('manager silent restore: a session folder that cannot be read asks', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN))
  h.cwdThrows = 1
  await asksInstead(stdins)
})

test('manager silent restore: a session folder read that does not answer in time asks, and the grant it saves names no folder', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN))
  h.rootHang = new Promise(() => undefined)
  await ticks(3)
  await h.clock!.advance(31_000)
  await asksInstead(stdins)
  expect(h.store.get(MGRKEY)).toEqual({ name: 'MANAGER', savedAt: expect.any(Number) })
})
test('manager silent restore: an off typed while the folder is being read, before any grant, leaves nothing granted and the saved grant removed', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN))
  let release!: () => void
  h.rootHang = new Promise((r) => (release = () => r({ value: MGRCWD })))
  await ticks(2)
  expect((await $.command.run(lane('off'))).text).toContain('Its saved manager grant was removed.')
  release()
  await ticks(4)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(h.askCount).toBe(0)
  expect(h.store.has(MGRKEY)).toBe(false)
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restored'))).toBe(false)
})

// Every other check still runs, and a refusal stays a refusal: no silent grant.
test('manager silent restore: another live manager on the Mac refuses (manager-exists): no grant, no dialog, the key stays', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN), { sess: { ...MSELF(), ...mgrRow() }, seed: () => mgrFile() })
  await ticks(3)
  expect(h.askCount).toBe(0)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:manager-exists')
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restored'))).toBe(false)
  expect(h.store.get(MGRKEY)).toEqual(silentHint(MIN))
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('manager silent restore: a name no longer reserved refuses (manager-name)', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN, { name: 'HARBOR' }))
  await ticks(3)
  expect(h.askCount).toBe(0)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:manager-name')
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('manager silent restore: a lane (bound) refuses (lane-holder)', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN), { bound: true })
  await ticks(3)
  expect(h.askCount).toBe(0)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:lane-holder')
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restored'))).toBe(false)
  expect(leadFiles.has(SELFPATH)).toBe(false)
})
test('manager silent restore: a lead refuses (lead-holder)', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN, { cwd: PIN }), { sess: MSELF({ name: 'LEAD', cwd: PIN }), seed: () => { extraStat.set(`${PIN}/.git`, dirStat); h.callerCwd = PIN; h.store.set(`lead:${SID}`, { pin: PIN, savedAt: T0 - 60_000 }) } })
  await ticks(3)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:lead-holder')
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restored'))).toBe(false)
})
test('manager silent restore: a --bg worker row (not the person\'s) refuses (not-person)', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN), { sess: MSELF({ kind: 'background' }) })
  await ticks(4)
  expect(h.askCount).toBe(0)
  expect(mgrLogs(stdins)).toContain('manager-restore-rejected:not-person')
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restored'))).toBe(false)
  expect(await statusText($)).toBe(STATUS_NONE)
})
test('manager silent restore: a busy session or a draft waits for the idle conditions, then restores with no dialog', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN), { sess: MSELF({ status: 'busy' }) })
  h.draftNow = 'half a sentence'
  await ticks(4)
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restored'))).toBe(false)
  h.sessions = MSELF()
  await ticks(4)
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restored'))).toBe(false)
  h.draftNow = ''
  await h.clock!.advance(2000)
  await waitFor(() => mgrLogs(stdins).includes('manager-restored:silent'))
  expect(h.askCount).toBe(0)
})
test('manager silent restore: the re-check after the grant still runs: a manager that came up in the same moment makes the restore step back', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN), { sess: { ...MSELF(), ...mgrRow() } })
  // The other manager's file appears while this one's own file is being written.
  h.mvHook = (target: string) => {
    if (target !== SELFPATH) return
    mgrFile()
  }
  await ticks(3)
  await waitFor(() => mgrLogs(stdins).includes('manager-restore-rejected:manager-exists'))
  h.mvHook = undefined
  expect(mgrLogs(stdins).some((x) => x.startsWith('manager-restored'))).toBe(false)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(h.askCount).toBe(0)
})
test('manager silent restore: the person\'s /callboard off while the restore waits for the idle conditions ends it: nothing restored', async ($, on) => {
  const stdins: string[] = []
  await silentRestarter($, on, stdins, silentHint(MIN), { sess: MSELF({ status: 'busy' }) })
  expect((await $.command.run(lane('off'))).text).toContain('Its saved manager grant was removed.')
  h.sessions = MSELF()
  await ticks(5)
  expect(await statusText($)).toBe(STATUS_NONE)
  expect(h.store.has(MGRKEY)).toBe(false)
  expect(h.askCount).toBe(0)
})

test('manager silent restore: a fresh-looking hint written by a same-user process for this session and folder DOES restore silently (the accepted residual, ADR 0002)', async ($, on) => {
  const stdins: string[] = []
  // Nothing in the key tells a hint the mod wrote from one another process wrote: only its shape, its age, the session id and the folder.
  await silentRestarter($, on, stdins, { name: 'MANAGER', cwd: MGRCWD, savedAt: DECIDED - 1000, extra: 'forged' })
  await restoredSilently(stdins)
  expect(await statusText($)).toBe(statusTable(['Lane', 'NONE'], ['Manager', 'ON'], ['Check-ins', 'ON']))
})

test('manager silent restore: the saved grant is rewritten every 5 minutes while the manager is on, and not before', async ($, on) => {
  const stdins: string[] = []
  await mgrAt($, on, stdins, { clock: true })
  expect(h.store.get(MGRKEY)).toEqual({ name: 'MANAGER', cwd: MGRCWD, savedAt: T0 })
  await h.clock!.advance(MANAGER_REFRESH_MS - 4000)
  expect((h.store.get(MGRKEY) as { savedAt: number }).savedAt).toBe(T0)
  await h.clock!.advance(2000)
  await h.clock!.advance(2000)
  await waitFor(() => (h.store.get(MGRKEY) as { savedAt: number }).savedAt === T0 + MANAGER_REFRESH_MS)
  await h.clock!.advance(MANAGER_REFRESH_MS - 2000)
  expect((h.store.get(MGRKEY) as { savedAt: number }).savedAt).toBe(T0 + MANAGER_REFRESH_MS)
  await h.clock!.advance(2000)
  await waitFor(() => (h.store.get(MGRKEY) as { savedAt: number }).savedAt === T0 + 2 * MANAGER_REFRESH_MS)
})
