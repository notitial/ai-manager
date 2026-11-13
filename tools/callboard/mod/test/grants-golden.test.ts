// Golden tests for the three grant levels (lead, conductor, manager): the facets they share, pinned as observable behaviour (store writes, presence file
// text, log lines, toasts, tool declarations, refusal codes) and not as internals. Cells that look odd are pinned as they are and marked.
// No text of an info print (status, config, lanes, help, escalation) is pinned here: those change on their own.
import { expect, test } from 'claude-code/testing'
import { CONDUCTOR_KEPT, CONDUCTOR_ON_TEXT, CONDUCTOR_TOOLS, HINT_MAX_AGE_MS, HINT_REFRESH_MS, LEAD_KEPT, MANAGER_KEPT, MANAGER_REFRESH_MS, MANAGER_ON_TEXT, MANAGER_RESTORED_TOAST, MANAGER_TOOLS, MANAGER_UNANSWERED_TOAST, REASON_TEXT, TIMED_OUT_LEAD_OFF_TOAST, TIMED_OUT_TOAST, conductorBriefingNote, conductorRestoredToast, conductorUnansweredToast, leadBriefingNote, leadRestoredToast, managerBriefingNote } from '../hooks/core'
import { h, NO, ROOT, SID, T0, YES, extraStat, laneSeed, leadFiles, statErr, toasts, toolDefs } from './harness'
import { APP2, COND, FAR, LANE_HINT, LEADKEY, LEADPS, OTHERLEAD, PIN, SELFPATH, STORE_LANE, allEvents, condRun, condSelf, dirStat, lane, leadFileText, leadReg, listCall, logged, mgrFile, mgrRow, noteRows, putCond, putStore, sleepMs, started, ticks, unanswered, waitFor } from './fixtures'

type Level = 'lead' | 'conductor' | 'manager'
const LEVELS: Level[] = ['lead', 'conductor', 'manager']

// A session in the conductor repo COND (a git root, its own registry row, a list file naming ../app and ../app2), started with the mock clock held.
async function world($: any, on: any, stdins: string[], o: { clock?: boolean; interactive?: boolean; sess?: Record<string, string>; seed?: () => void; list?: string[] } = {}) {
  laneSeed.text = undefined
  h.sessions = o.sess ?? condSelf()
  await started($, on, stdins, {
    clock: o.clock ?? true,
    interactive: o.interactive,
    seed: () => {
      h.callerCwd = COND
      for (const r of [COND, PIN, APP2, FAR]) extraStat.set(`${r}/.git`, dirStat)
      putCond(o.list ?? ['../app', '../app2'])
      o.seed?.()
    },
  })
  h.askAnswer = YES
}
const PERSON = { kind: 'composer' }
const askFor = ($: any, level: Level, origin: unknown = PERSON) => (level === 'conductor' ? condRun($, '', origin) : $.command.run(lane(level, origin)))
const grant = ($: any, level: Level) => askFor($, level)
const off = ($: any) => $.command.run(lane('off'))
const toolsDeclared = (from: number) => toolDefs.slice(from).map((d) => JSON.parse(d).name as string)
const ON_TEXT = { lead: 'Lead is on from your next prompt.', conductor: CONDUCTOR_ON_TEXT, manager: MANAGER_ON_TEXT }

// What each level writes and says, taken from the real grant: the saved key, the presence file, the log lines and the replies.
const LV = {
  lead: {
    key: `lead:${SID}`,
    saved: { pin: COND, savedAt: T0 },
    presence: { sid: SID, pid: 4400, procStart: LEADPS, repo: COND },
    atGrant: { sid: SID, pid: 4400, procStart: LEADPS, repo: COND },
    onLog: 'lead-on:',
    unsavedLog: 'lead-unsaved:',
    presenceLog: 'error:presence',
    briefErr: 'error:lead-briefing',
    note: leadBriefingNote(COND),
    offText: 'Lead is now off.',
    kept: LEAD_KEPT,
    refreshMs: HINT_REFRESH_MS,
    restoreRejected: 'lead-restore-rejected',
    hint: (savedAt: number) => ({ pin: COND, savedAt }),
  },
  conductor: {
    key: `conductor:${SID}`,
    saved: { home: COND, repos: [PIN, APP2], savedAt: T0 },
    presence: { sid: SID, pid: 4400, procStart: LEADPS, level: 'conductor', name: 'COND', repos: [PIN, APP2], home: COND },
    // The file written at the grant has no name yet (the grant reads it from the registry afterwards); the next tick rewrites it with the name.
    atGrant: { sid: SID, pid: 4400, procStart: LEADPS, level: 'conductor', repos: [PIN, APP2], home: COND },
    onLog: 'conductor-on:prompt',
    unsavedLog: 'conductor-unsaved:',
    presenceLog: 'error:conductor-presence',
    briefErr: 'error:conductor-briefing',
    note: conductorBriefingNote('', COND, [PIN, APP2]),
    offText: 'Conductor is now off.',
    kept: CONDUCTOR_KEPT,
    refreshMs: HINT_REFRESH_MS,
    restoreRejected: 'conductor-restore-rejected',
    hint: (savedAt: number) => ({ home: COND, repos: [PIN], savedAt }),
  },
  manager: {
    key: `manager:${SID}`,
    saved: { name: 'MANAGER', cwd: COND, savedAt: T0 },
    presence: { sid: SID, pid: 4400, procStart: LEADPS, level: 'manager', name: 'MANAGER' },
    atGrant: { sid: SID, pid: 4400, procStart: LEADPS, level: 'manager', name: 'MANAGER' },
    onLog: 'manager-on:prompt',
    unsavedLog: 'manager-unsaved:',
    presenceLog: 'error:presence',
    briefErr: 'error:manager-briefing',
    note: managerBriefingNote('MANAGER'),
    offText: 'Manager is now off.',
    kept: MANAGER_KEPT,
    refreshMs: MANAGER_REFRESH_MS,
    restoreRejected: 'manager-restore-rejected',
    hint: (savedAt: number) => ({ name: 'MANAGER', savedAt }),
  },
} as const

// ---- 1. the holder and exclusion matrix: what the session already is x what it asks for ----
// Each cell is its own test: the module memory (the declared sets, the pending restores) lives as long as a test, so a cell needs a start of its own.
// An outcome is `granted` (the level's own on-line is logged), `no-change` (answered, no log line) or `refused:<code>` (the code in the log), then `|` and the
// number of dialogs asked.
const withManager = () => ({ sess: { ...condSelf(), ...mgrRow() }, seed: () => mgrFile() })
const STATES: Record<string, ($: any, on: any, stdins: string[]) => Promise<void>> = {
  none: ($, on, s) => world($, on, s),
  lead: async ($, on, s) => (await world($, on, s), void (await grant($, 'lead'))),
  conductor: async ($, on, s) => (await world($, on, s), void (await grant($, 'conductor'))),
  manager: async ($, on, s) => (await world($, on, s), void (await grant($, 'manager'))),
  'was-lead': async ($, on, s) => (await world($, on, s), await grant($, 'lead'), void (await off($))),
  'was-conductor': async ($, on, s) => (await world($, on, s), await grant($, 'conductor'), void (await off($))),
  'was-manager': async ($, on, s) => (await world($, on, s), await grant($, 'manager'), void (await off($))),
  'bound lane': async ($, on, s) => {
    await started($, on, s, { bound: true })
    h.sessions = condSelf()
    h.callerCwd = COND
    for (const r of [COND, PIN]) extraStat.set(`${r}/.git`, dirStat)
    putCond(['../app', '../app2'])
  },
  'lane hint': ($, on, s) => world($, on, s, { seed: () => h.store.set(`sess:${SID}`, LANE_HINT()) }),
  'store record naming it': ($, on, s) => world($, on, s, { seed: () => putStore([STORE_LANE({ sid: SID })]) }),
  'other manager live': ($, on, s) => world($, on, s, withManager()),
  'other lead without a name': ($, on, s) =>
    world($, on, s, {
      sess: { ...condSelf(), '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243, name: 'LEAD A', cwd: COND })['4242.json'] },
      seed: () => leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243, repo: COND }) }),
    }),
  'lead restore pending': ($, on, s) => world($, on, s, { seed: () => (h.store.set(LEADKEY, { pin: COND, savedAt: T0 - 60_000 }), (h.cwdThrows = 1)) }),
  'conductor restore pending': ($, on, s) => world($, on, s, { seed: () => (h.store.set(`conductor:${SID}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 }), (h.cwdThrows = 1)) }),
  'manager restore pending': ($, on, s) => world($, on, s, { seed: () => h.store.set(`manager:${SID}`, { name: 'MANAGER', savedAt: T0 - 60_000 }) }),
  // The order of checks: a level the session had decides before another manager does (manager-after-lead, not manager-exists), and so does one it holds.
  'was-lead, other manager live': async ($, on, s) => (await world($, on, s, withManager()), await grant($, 'lead'), void (await off($))),
  'lead, other manager live': async ($, on, s) => (await world($, on, s, withManager()), void (await grant($, 'lead'))),
}
const G = 'granted|1'
const NC = 'no-change|0'
const R = (code: string) => `refused:${code}|0`
// [lead, conductor, manager]
const MATRIX: Record<string, [string, string, string]> = {
  none: [G, G, G],
  // A lead asked again asks again (a new dialog) and grants again.
  lead: [G, R('lead-holder'), R('lead-holder')],
  // The lead's own log codes carry a `lead-` prefix in front of the table code (lead-conductor-holder, lead-manager-holder, lead-lane-holder, and the doubled
  // lead-lead-after-conductor); the conductor's and the manager's log the table code as it is.
  conductor: [R('lead-conductor-holder'), NC, R('conductor-holder')],
  manager: [R('lead-manager-holder'), R('manager-holder'), NC],
  'was-lead': [G, R('conductor-after-lead'), R('manager-after-lead')],
  'was-conductor': [R('lead-lead-after-conductor'), G, R('manager-after-conductor')],
  'was-manager': [R('lead-after-manager'), R('conductor-after-manager'), G],
  'bound lane': [R('lead-lane-holder'), R('lane-holder'), R('lane-holder')],
  // A lane hint, or a store record naming the session, never refuses a grant by hand: the later rebind or restore yields to the grant.
  'lane hint': [G, G, G],
  'store record naming it': [G, G, G],
  // Another live manager stops only the manager.
  'other manager live': [G, G, R('manager-exists')],
  // A second lead with no usable name stops the lead (other-lead-unnamed) and a conductor on that repo (the lead is in the conductor repo).
  'other lead without a name': [R('other-lead-unnamed'), R('conductor-repo-in-use'), G],
  'lead restore pending': [G, R('lead-holder'), R('lead-holder')],
  // A pending conductor restore stops the manager (conductor-holder), not the lead or a conductor grant by hand; a pending manager restore stops nobody.
  'conductor restore pending': [G, G, R('conductor-holder')],
  'manager restore pending': [G, G, G],
  'was-lead, other manager live': [G, R('conductor-after-lead'), R('manager-after-lead')],
  'lead, other manager live': [G, R('lead-holder'), R('lead-holder')],
}
const outcome = (stdins: string[], from: number, asked: number) => {
  const ev = allEvents(stdins).slice(from)
  const refused = ev.find((e) => e.event === 'refused')
  const granted = ev.some((e) => ['lead-on', 'conductor-on', 'manager-on'].includes(e.event))
  return `${refused ? `refused:${refused.reason}` : granted ? 'granted' : 'no-change'}|${asked}`
}
for (const [ai, ask] of LEVELS.entries()) {
  for (const state of Object.keys(STATES)) {
    test(`matrix: ${ask} asked in a session that is ${state}`, async ($, on) => {
      const stdins: string[] = []
      await STATES[state]($, on, stdins)
      const from = allEvents(stdins).length
      const asks = h.askCount
      await askFor($, ask)
      expect(outcome(stdins, from, h.askCount - asks)).toBe(MATRIX[state][ai])
    })
  }
}

// ---- 2. save: the saved grant, its daily refresh, a failed write, a drop during the write ----
for (const level of LEVELS) {
  const L = LV[level]
  test(`save: the ${level} grant writes ${level}:<sid> with the fields of its level, and nothing before it`, async ($, on) => {
    await world($, on, [])
    expect(h.store.has(L.key)).toBe(false)
    await grant($, level)
    expect(h.store.get(L.key)).toEqual(L.saved)
  })

  // Without the mock clock a command runs the timer's step once, and h.nowMs moves at once: the refresh interval (a day; the manager's is 5 minutes) is one assignment.
  test(`save: the ${level} key is rewritten every ${L.refreshMs / 60_000} minutes from its last save, and not before`, async ($, on) => {
    await world($, on, [], { clock: false })
    await grant($, level)
    expect(h.store.get(L.key)).toEqual(L.saved)
    h.nowMs = T0 + L.refreshMs - 1
    await $.command.run(lane('status'))
    await sleepMs(50)
    expect(h.store.get(L.key)).toEqual(L.saved)
    h.nowMs = T0 + L.refreshMs
    await $.command.run(lane('status'))
    await waitFor(() => (h.store.get(L.key) as { savedAt: number }).savedAt === T0 + L.refreshMs)
    expect({ ...(h.store.get(L.key) as object), savedAt: T0 }).toEqual(L.saved)
  })

  test(`save: a failed write of the ${level} key is logged ${L.unsavedLog} and the grant stands`, async ($, on) => {
    const stdins: string[] = []
    await world($, on, stdins)
    h.storeThrowSync = 'set'
    await grant($, level)
    h.storeThrowSync = undefined
    expect(h.store.has(L.key)).toBe(false)
    expect(logged(stdins)).toContain(L.unsavedLog)
    expect(logged(stdins)).toContain(L.onLog)
  })

  test(`save: off while the ${level} key is being written deletes the key the write left`, async ($, on) => {
    await world($, on, [])
    let release!: () => void
    let held = false
    h.storeSetHook = (k) => (k === L.key && !held ? ((held = true), new Promise<void>((r) => (release = r))) : undefined)
    const p = grant($, level)
    await waitFor(() => held)
    await off($)
    h.storeSetHook = undefined
    release()
    expect((await p).text).toBe(L.offText)
    expect(h.store.has(L.key)).toBe(false)
  })

  // The save checks the grant's epoch: a write begun by a grant that was dropped deletes the key even when the person granted again meanwhile, so the new grant is
  // left with no saved key.
  test(`save: off and a new grant while the ${level} key is being written lose the key: the older write deletes it`, async ($, on) => {
    await world($, on, [])
    let release!: () => void
    let held = false
    h.storeSetHook = (k) => (k === L.key && !held ? ((held = true), new Promise<void>((r) => (release = r))) : undefined)
    const first = grant($, level)
    await waitFor(() => held)
    await off($)
    expect((await grant($, level)).text).toContain(ON_TEXT[level])
    expect(h.store.get(L.key)).toEqual(L.saved)
    release()
    expect((await first).text).toBe(L.offText)
    expect(h.store.has(L.key)).toBe(false)
  })
}

// The stale write's delete takes the new grant's key with it, so the new grant's saved time is cleared and the next tick writes the key again.
for (const level of LEVELS) {
  const L = LV[level]
  test(`save: the ${level} key lost to an older write is written again by the next refresh tick`, async ($, on) => {
    await world($, on, [])
    let release!: () => void
    let held = false
    h.storeSetHook = (k) => (k === L.key && !held ? ((held = true), new Promise<void>((r) => (release = r))) : undefined)
    const first = grant($, level)
    await waitFor(() => held)
    await off($)
    await grant($, level)
    release()
    await first
    h.storeSetHook = undefined
    expect(h.store.has(L.key)).toBe(false)
    await ticks(3)
    await waitFor(() => h.store.has(L.key))
    expect({ ...(h.store.get(L.key) as object), savedAt: T0 }).toEqual({ ...L.saved, savedAt: T0 })
  })
}

// ---- 3. prune of old saved grants, and restore at session start ----
const sidN = (n: number) => `${n}a1b2c3d-0000-4000-8000-123456789abc`
for (const level of LEVELS) {
  const L = LV[level]
  const prefix = level
  test(`prune: at start the ${level} keys of other sessions go when older than 30 days, more than a minute ahead or not a hint; the session's own goes at the restore`, async ($, on) => {
    const stdins: string[] = []
    const keep = [sidN(1), sidN(2), sidN(3)]
    const drop = [sidN(4), sidN(5), 'not-a-sid']
    await world($, on, stdins, {
      seed: () => {
        h.store.set(`${prefix}:${keep[0]}`, L.hint(T0 - 1000))
        h.store.set(`${prefix}:${keep[1]}`, L.hint(T0 - HINT_MAX_AGE_MS))
        h.store.set(`${prefix}:${keep[2]}`, L.hint(T0 + 60_000))
        h.store.set(`${prefix}:${drop[0]}`, L.hint(T0 - HINT_MAX_AGE_MS - 1))
        h.store.set(`${prefix}:${drop[1]}`, L.hint(T0 + 60_001))
        h.store.set(`${prefix}:${drop[2]}`, L.hint(T0))
        h.store.set(L.key, L.hint(T0 - HINT_MAX_AGE_MS - 1))
      },
    })
    for (const s of keep) expect(h.store.has(`${prefix}:${s}`)).toBe(true)
    for (const s of drop) expect(h.store.has(`${prefix}:${s}`)).toBe(false)
    expect(h.store.has(L.key)).toBe(false)
    expect(logged(stdins)).toContain(`${L.restoreRejected}:invalid`)
  })
}

// The restore gate: a lead comes back in any session that has a registry row (the weaker gate); the conductor and the manager only in a person's own row.
test('restore: a session whose registry row is of kind background and that is not interactive at start is made lead again from its saved grant, with no question', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins, { interactive: false, sess: condSelf({ kind: 'background' }), seed: () => h.store.set(LV.lead.key, LV.lead.hint(T0 - 60_000)) })
  expect(logged(stdins)).toContain('lead-restored:')
  expect(h.askCount).toBe(0)
  expect(h.store.has(LV.lead.key)).toBe(true)
  expect(JSON.stringify(await $.tool.call(listCall()))).not.toContain('lead tools are off')
})
for (const level of ['conductor', 'manager'] as const) {
  test(`restore: a session whose registry row is of kind background is not made ${level} again; the key is kept and nothing is asked`, async ($, on) => {
    const stdins: string[] = []
    await world($, on, stdins, { interactive: false, sess: condSelf({ kind: 'background' }), seed: () => h.store.set(LV[level].key, LV[level].hint(T0 - 60_000)) })
    await ticks(4)
    expect(logged(stdins)).toContain(`${LV[level].restoreRejected}:not-person`)
    expect(h.store.has(LV[level].key)).toBe(true)
    expect(h.askCount).toBe(0)
    expect(JSON.stringify(await $.tool.call(listCall()))).toContain('lead tools are off')
  })
}

// A saved manager grant of the older shape (no folder in it) asks wherever the session starts. The lead's and the conductor's are for their own folder (elsewhere the key is deleted).
test('restore: a saved manager grant is offered in any folder', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins, { sess: condSelf({ cwd: '/elsewhere', name: 'MANAGER' }), seed: () => ((h.callerCwd = '/elsewhere'), h.store.set(LV.manager.key, LV.manager.hint(T0 - 60_000))) })
  await ticks(3)
  await waitFor(() => logged(stdins).includes('manager-restored:'))
  expect(h.askCount).toBe(1)
})
for (const level of ['lead', 'conductor'] as const) {
  test(`restore: a saved ${level} grant for another folder is deleted at start, with no question`, async ($, on) => {
    const stdins: string[] = []
    await world($, on, stdins, { seed: () => ((h.callerCwd = PIN), h.store.set(LV[level].key, LV[level].hint(T0 - 60_000))) })
    expect(h.store.has(LV[level].key)).toBe(false)
    expect(logged(stdins)).toContain(`${LV[level].restoreRejected}:wrong-folder`)
    expect(h.askCount).toBe(0)
  })
}

// The two restore dialogs (a conductor whose list widened, the manager) end a dismissal like a timeout: nothing restored, the key kept, one toast, asked once.
test('restore: a conductor restore dialog (list widened) that is dismissed restores nothing, keeps the key and toasts', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins, { seed: () => h.store.set(LV.conductor.key, { home: COND, repos: [PIN], savedAt: T0 - 60_000 }) })
  h.askAnswer = ''
  await ticks(3)
  await waitFor(() => logged(stdins).includes('conductor-restore-unanswered:'))
  expect(toasts).toContain(conductorUnansweredToast(COND))
  expect(h.store.get(LV.conductor.key)).toEqual({ home: COND, repos: [PIN], savedAt: T0 - 60_000 })
  await ticks(3)
  expect(h.askCount).toBe(1)
})
test('restore: a manager restore dialog that is dismissed restores nothing, keeps the key and toasts', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins, { sess: condSelf({ name: 'MANAGER' }), seed: () => h.store.set(LV.manager.key, LV.manager.hint(T0 - 60_000)) })
  h.askAnswer = ''
  await ticks(3)
  await waitFor(() => logged(stdins).includes('manager-restore-unanswered:'))
  expect(toasts).toContain(MANAGER_UNANSWERED_TOAST)
  expect(h.store.get(LV.manager.key)).toEqual(LV.manager.hint(T0 - 60_000))
  await ticks(3)
  expect(h.askCount).toBe(1)
})
test('restore: a conductor restore with a widened list asks only once the session is idle', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins, { sess: condSelf({ status: 'busy' }), seed: () => h.store.set(LV.conductor.key, { home: COND, repos: [PIN], savedAt: T0 - 60_000 }) })
  await ticks(4)
  expect(h.askCount).toBe(0)
  h.sessions = condSelf()
  await ticks(3)
  await waitFor(() => logged(stdins).includes('conductor-restored:widened 1'))
  expect(h.askCount).toBe(1)
  expect(toasts).toContain(conductorRestoredToast(COND, 2))
})
test('restore: the lead comes back with a toast and no question', async ($, on) => {
  await world($, on, [], { seed: () => h.store.set(LV.lead.key, LV.lead.hint(T0 - 60_000)) })
  expect(toasts).toContain(leadRestoredToast(COND))
  expect(h.askCount).toBe(0)
  expect(toasts).not.toContain(MANAGER_RESTORED_TOAST)
})

// ---- 4. presence file ----
for (const level of LEVELS) {
  const L = LV[level]
  test(`presence: the ${level} file has the fields of its level, is rewritten at each tick, and goes at off and at session end`, async ($, on) => {
    await world($, on, [])
    await grant($, level)
    expect(JSON.parse(leadFiles.get(SELFPATH)!.text)).toEqual(L.atGrant)
    const m0 = leadFiles.get(SELFPATH)!.mtimeSec!
    await h.clock!.advance(2000)
    expect(JSON.parse(leadFiles.get(SELFPATH)!.text)).toEqual(L.presence)
    expect(leadFiles.get(SELFPATH)!.mtimeSec!).toBe(m0 + 2)
    await h.clock!.advance(2000)
    expect(leadFiles.get(SELFPATH)!.mtimeSec!).toBe(m0 + 4)
    await off($)
    expect(leadFiles.has(SELFPATH)).toBe(false)
    await h.clock!.advance(4000)
    expect(leadFiles.has(SELFPATH)).toBe(false)
    await grant($, level)
    expect(leadFiles.has(SELFPATH)).toBe(true)
    await $.session.end({} as any)
    expect(leadFiles.has(SELFPATH)).toBe(false)
  })
}
test('presence: a file left from an earlier run of the session is removed when the session starts, whatever its level', async ($, on) => {
  await world($, on, [], { seed: () => leadFiles.set(SELFPATH, { text: JSON.stringify(LV.manager.presence) }) })
  expect(leadFiles.has(SELFPATH)).toBe(false)
})

// The manager's file is what keeps a second manager out, so the manager grant stands only if the file was written; the lead's and the conductor's file is a filter
// whose write can fail with the grant standing. The leads folder is made to fail its check after the grant's last check before the write.
for (const level of LEVELS) {
  test(`presence: when the ${level} file cannot be written ${level === 'manager' ? 'the grant is stepped back (error:manager-presence, no on-line, tools off, no saved key)' : 'the grant stands (the write failure is logged)'}`, async ($, on) => {
    const stdins: string[] = []
    await world($, on, stdins)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    if (level === 'lead') h.laneRegisterHang = gate
    else h.registerGate = gate
    const p = grant($, level)
    await waitFor(() => h.askCount === 1)
    await sleepMs(30)
    statErr.set(`${ROOT}/leads`, `stat: ${ROOT}/leads: Permission denied`)
    release()
    const text = (await p).text as string
    statErr.delete(`${ROOT}/leads`)
    h.laneRegisterHang = undefined
    h.registerGate = undefined
    expect(leadFiles.has(SELFPATH)).toBe(false)
    if (level === 'manager') {
      expect(text).toBe('Manager could not be set up.')
      expect(logged(stdins)).toContain('error:manager-presence')
      expect(logged(stdins)).not.toContain(LV.manager.onLog)
      expect(JSON.stringify(await $.tool.call(listCall()))).toContain('lead tools are off')
      expect(h.store.has(LV.manager.key)).toBe(false)
    } else {
      expect(text).toContain(ON_TEXT[level])
      expect(logged(stdins)).toContain(LV[level].presenceLog)
      expect(logged(stdins)).toContain(LV[level].onLog)
      expect(JSON.stringify(await $.tool.call(listCall()))).not.toContain('lead tools are off')
    }
  })
}
// /callboard off while the lead's tools are being registered: the grant is refused as at the dialog, and nothing is saved.
test('dialog: /callboard off while the lead tools are being registered, then they register: nothing is granted (refused off-meanwhile), no saved key', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins)
  let release!: () => void
  h.laneRegisterHang = new Promise<void>((r) => (release = r))
  const p = grant($, 'lead')
  await waitFor(() => h.askCount === 1)
  await sleepMs(30)
  await off($)
  release()
  const text = (await p).text as string
  h.laneRegisterHang = undefined
  expect(text).toBe('Nothing changed: callboard was turned off meanwhile.')
  expect(logged(stdins)).toContain('refused:off-meanwhile')
  expect(logged(stdins)).not.toContain(LV.lead.onLog)
  expect(await isOn($)).toBe(false)
  expect(h.store.has(LV.lead.key)).toBe(false)
})
test('presence: a manager that appears while the manager file is being written makes this one step back (manager-exists); its own file goes', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins)
  h.mvHook = (target: string) => {
    if (target !== SELFPATH) return
    mgrFile()
    h.sessions = { ...condSelf(), ...mgrRow() }
  }
  const r = await grant($, 'manager')
  h.mvHook = undefined
  expect(logged(stdins)).toContain('refused:manager-exists')
  expect(r.text).toContain('another live session is the manager')
  expect(leadFiles.has(SELFPATH)).toBe(false)
  expect(h.store.has(LV.manager.key)).toBe(false)
  expect(JSON.stringify(await $.tool.call(listCall()))).toContain('lead tools are off')
})

// ---- 5. the briefing note, the off reply and the tools of each level ----
for (const level of LEVELS) {
  const L = LV[level]
  test(`briefing: the ${level} note is appended once per grant: a second grant while on adds none, off and a new grant add one`, async ($, on) => {
    await world($, on, [])
    await grant($, level)
    expect(noteRows()).toEqual([{ type: 'user', blocks: 1, text: L.note }])
    await grant($, level)
    expect(noteRows().length).toBe(1)
    await off($)
    await grant($, level)
    expect(noteRows().map((r) => r.text)).toEqual([L.note, L.note])
  })

  // A refused append is logged and the grant stands; only the lead's next grant tries the note again (the conductor and manager commands in a session that is on
  // only report the level).
  test(`briefing: a refused append of the ${level} note is logged ${L.briefErr}, the grant stands, and ${level === 'lead' ? 'the next grant appends it again' : 'a second command appends nothing'}`, async ($, on) => {
    const stdins: string[] = []
    await world($, on, stdins)
    h.appendDeny = true
    await grant($, level)
    h.appendDeny = false
    expect(logged(stdins)).toContain(L.briefErr)
    expect(logged(stdins)).toContain(L.onLog)
    expect(noteRows().length).toBe(1)
    await grant($, level)
    expect(noteRows().length).toBe(level === 'lead' ? 2 : 1)
  })

  test(`off: the ${level} reply names its level and carries the kept sentence when its saved grant cannot be deleted`, async ($, on) => {
    await world($, on, [])
    await grant($, level)
    h.storeDeleteFails = true
    expect((await off($)).text).toBe(`${L.offText}${L.kept}`)
    h.storeDeleteFails = false
    await grant($, level)
    expect((await off($)).text).toBe(L.offText)
    expect(h.store.has(L.key)).toBe(false)
  })

  test(`off: a plain session whose saved ${level} grant is left behind says it was removed, and removes it`, async ($, on) => {
    await world($, on, [])
    h.store.set(L.key, L.hint(T0))
    expect((await off($)).text).toBe(`Its saved ${level} grant was removed.`)
    expect(h.store.has(L.key)).toBe(false)
  })

  test(`tools: the ${level} grant declares its tools once, and its level filter refuses the lane tools outside its allow list`, async ($, on) => {
    await world($, on, [])
    const d0 = toolDefs.length
    await grant($, level)
    const declared = toolsDeclared(d0)
    expect(declared).toEqual(DECLARED[level])
    if (level !== 'lead') expect(declared.map((n) => `mcp__callboard__${n}`).sort()).toEqual([...(level === 'manager' ? MANAGER_TOOLS : CONDUCTOR_TOOLS)].sort())
    await off($)
    await grant($, level)
    expect(toolsDeclared(d0)).toEqual(DECLARED[level])
    const refused: string[] = []
    for (const verb of LANE_VERBS) {
      const r = JSON.stringify(await $.tool.call({ tool: `mcp__callboard__${verb}`, lane: 'X' }))
      if (level !== 'lead' && r.includes(REASON_TEXT[`${level}-tool`])) refused.push(verb)
    }
    expect(refused).toEqual(REFUSED_BY_LEVEL[level])
  })
}
const PROMPT = ['prompt_list', 'prompt_answer', 'prompt_escalate']
const DECLARED = {
  lead: ['lane_rename', 'lane_start', 'lane_resume', 'lane_compact', 'lane_terminate', 'lane_retire', 'lane_park', 'lane_create', 'lane_open', 'lane_unpark', 'lane_list', ...PROMPT],
  conductor: ['lane_list', 'lane_compact', 'lane_terminate', ...PROMPT],
  manager: ['lane_list', 'lane_resume', 'lane_compact', 'lane_terminate', 'lane_retire', ...PROMPT],
}
const LANE_VERBS = ['lane_list', 'lane_start', 'lane_resume', 'lane_compact', 'lane_park', 'lane_unpark', 'lane_terminate', 'lane_retire', 'lane_create', 'lane_open', 'lane_rename']
const REFUSED_BY_LEVEL = {
  lead: [],
  conductor: ['lane_start', 'lane_resume', 'lane_park', 'lane_unpark', 'lane_retire', 'lane_create', 'lane_open', 'lane_rename'],
  manager: ['lane_start', 'lane_park', 'lane_unpark', 'lane_create', 'lane_open', 'lane_rename'],
}

test('off: a session with a saved lead, conductor and manager grant names only the first (the lead), and all three are removed', async ($, on) => {
  await world($, on, [])
  for (const level of LEVELS) h.store.set(LV[level].key, LV[level].hint(T0))
  expect((await off($)).text).toBe('Its saved lead grant was removed.')
  for (const level of LEVELS) expect(h.store.has(LV[level].key)).toBe(false)
})

// A restore that is still pending is a grant that off ends, and says so; a manager restore pending has no grant, only the saved key.
for (const [state, reply, key] of [['lead restore pending', 'Lead is now off.', LV.lead.key], ['conductor restore pending', 'Conductor is now off.', LV.conductor.key], ['manager restore pending', 'Its saved manager grant was removed.', LV.manager.key]] as const) {
  test(`off: while the ${state} the reply is "${reply}" and the saved grant is removed`, async ($, on) => {
    await STATES[state]($, on, [])
    expect(h.store.has(key)).toBe(true)
    expect((await off($)).text).toBe(reply)
    expect(h.store.has(key)).toBe(false)
  })
}

// ---- 6. the dialog's answers that are not yes, and /callboard off while a dialog is open ----
const PLUGIN = { kind: 'plugin', name: 'x' }
const isOn = async ($: any) => !JSON.stringify(await $.tool.call(listCall())).includes('lead tools are off')
// Runs one request with the answer given: no (the Cancel button), dismissed (an answer that is neither button) or timeout (nobody answers within the limit).
async function answered($: any, level: Level, origin: unknown, answer: 'no' | 'dismissed' | 'timeout') {
  if (answer === 'timeout') {
    h.askHang = new Promise(() => undefined)
    const r = await unanswered(askFor($, level, origin))
    h.askHang = undefined
    return r.text as string
  }
  h.askAnswer = answer === 'no' ? NO : ''
  const r = await askFor($, level, origin)
  h.askAnswer = YES
  return r.text as string
}
type Cell = { origin: 'person' | 'plugin'; answer: 'no' | 'dismissed' | 'timeout'; text: string; on: boolean; log: string; toast?: string }
const ORIGIN = { person: PERSON, plugin: PLUGIN }
async function cells($: any, level: Level, stdins: string[], wasOn: boolean, want: Cell[]) {
  for (const c of want) {
    if (wasOn) {
      await grant($, level)
      // The conductor asks again only when the list names a repo this session has not approved.
      if (level === 'conductor') putCond(['../app', '../app2'])
    }
    const from = allEvents(stdins).length
    const t0 = toasts.length
    const text = await answered($, level, ORIGIN[c.origin], c.answer)
    const ev = allEvents(stdins).slice(from).filter((e) => e.event === 'refused').map((e) => e.reason)
    const what = `${level} wasOn=${wasOn} ${c.origin} ${c.answer}`
    expect([what, text, ev, toasts.slice(t0)]).toEqual([what, c.text, [c.log], c.toast ? [c.toast] : []])
    expect([what, await isOn($), h.store.has(LV[level].key)]).toEqual([what, c.on, c.on])
    if (level === 'conductor') putCond(['../app'])
  }
}
const TO = TIMED_OUT_TOAST
// The lead: a person's no, dismissal or timeout ends an earlier grant (and deletes its saved key); another origin's no ends it, its dismissal or timeout keeps it.
test('dialog: lead, a request that is not answered yes, from a session that is off', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins)
  await cells($, 'lead', stdins, false, [
    { origin: 'person', answer: 'no', text: 'Lead stays off.', on: false, log: 'lead-not-confirmed' },
    { origin: 'person', answer: 'dismissed', text: 'Lead stays off.', on: false, log: 'lead-not-confirmed' },
    { origin: 'person', answer: 'timeout', text: 'Lead stays off. The question timed out.', on: false, log: 'timed-out', toast: TO },
    { origin: 'plugin', answer: 'no', text: 'Lead stays off.', on: false, log: 'lead-not-confirmed' },
    { origin: 'plugin', answer: 'dismissed', text: 'Lead stays off.', on: false, log: 'lead-not-confirmed' },
    { origin: 'plugin', answer: 'timeout', text: 'Lead stays off. The question timed out.', on: false, log: 'timed-out', toast: TO },
  ])
})
test('dialog: lead, a request that is not answered yes, from a session that is on', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins)
  await cells($, 'lead', stdins, true, [
    { origin: 'person', answer: 'no', text: 'Lead is now off.', on: false, log: 'lead-not-confirmed' },
    { origin: 'person', answer: 'dismissed', text: 'Lead is now off.', on: false, log: 'lead-not-confirmed' },
    { origin: 'person', answer: 'timeout', text: 'Lead is now off. The question timed out.', on: false, log: 'timed-out', toast: TIMED_OUT_LEAD_OFF_TOAST },
    { origin: 'plugin', answer: 'no', text: 'Lead is now off.', on: false, log: 'lead-not-confirmed' },
    { origin: 'plugin', answer: 'dismissed', text: 'Lead stays on.', on: true, log: 'lead-not-confirmed' },
    { origin: 'plugin', answer: 'timeout', text: 'Lead stays on. The question timed out.', on: true, log: 'timed-out', toast: TO },
  ])
})
test('dialog: conductor, a request that is not answered yes, from a session that is off', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins)
  await cells($, 'conductor', stdins, false, [
    { origin: 'person', answer: 'no', text: 'Conductor stays off.', on: false, log: 'conductor-not-confirmed' },
    { origin: 'person', answer: 'dismissed', text: 'Conductor stays off.', on: false, log: 'conductor-not-confirmed' },
    { origin: 'person', answer: 'timeout', text: 'Conductor stays off. The question timed out.', on: false, log: 'timed-out', toast: TO },
    { origin: 'plugin', answer: 'no', text: 'Conductor stays off.', on: false, log: 'conductor-not-confirmed' },
    { origin: 'plugin', answer: 'dismissed', text: 'Conductor stays off.', on: false, log: 'conductor-not-confirmed' },
    { origin: 'plugin', answer: 'timeout', text: 'Conductor stays off. The question timed out.', on: false, log: 'timed-out', toast: TO },
  ])
})
// The conductor that is on asks again only from the person's own prompt and only for a list that widened: the person's no ends the grant, a dismissal or a timeout keeps it.
test('dialog: conductor, a request for a widened list that is not answered yes, from a session that is on (the person only: another origin gets the reach, no dialog)', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins, { list: ['../app'] })
  await cells($, 'conductor', stdins, true, [
    { origin: 'person', answer: 'no', text: 'Conductor is now off.', on: false, log: 'conductor-not-confirmed' },
    { origin: 'person', answer: 'dismissed', text: 'Conductor stays on.', on: true, log: 'conductor-not-confirmed' },
    { origin: 'person', answer: 'timeout', text: 'Conductor stays on. The question timed out.', on: true, log: 'timed-out', toast: TO },
  ])
})
test('dialog: manager, a request that is not answered yes, from a session that is off; from one that is on the answer is the already-on text, with no dialog', async ($, on) => {
  const stdins: string[] = []
  await world($, on, stdins)
  await cells($, 'manager', stdins, false, [
    { origin: 'person', answer: 'no', text: 'Manager stays off.', on: false, log: 'manager-not-confirmed' },
    { origin: 'person', answer: 'dismissed', text: 'Manager stays off.', on: false, log: 'manager-not-confirmed' },
    { origin: 'person', answer: 'timeout', text: 'Manager stays off. The question timed out.', on: false, log: 'timed-out', toast: TO },
    { origin: 'plugin', answer: 'no', text: 'Manager stays off.', on: false, log: 'manager-not-confirmed' },
    { origin: 'plugin', answer: 'dismissed', text: 'Manager stays off.', on: false, log: 'manager-not-confirmed' },
    { origin: 'plugin', answer: 'timeout', text: 'Manager stays off. The question timed out.', on: false, log: 'timed-out', toast: TO },
  ])
  await grant($, 'manager')
  const asks = h.askCount
  h.askAnswer = NO
  expect((await askFor($, 'manager')).text).toBe('Manager is already on in this session.')
  expect(h.askCount).toBe(asks)
  expect(await isOn($)).toBe(true)
})

// A person's no on the lead's or the conductor's dialog runs the lead drop, which deletes the saved lead and conductor keys even in a session that holds neither;
// the saved manager grant is left alone, and the manager's own no deletes nothing.
for (const [level, gone] of [['lead', ['lead', 'conductor']], ['conductor', ['lead', 'conductor']], ['manager', []]] as const) {
  test(`dialog: the person's no on the ${level} dialog of a session that holds none deletes ${gone.length === 0 ? 'no saved grant' : 'the saved lead and conductor grants, not the manager\'s'}`, async ($, on) => {
    await world($, on, [])
    for (const l of LEVELS) h.store.set(LV[l].key, LV[l].hint(T0))
    h.askAnswer = NO
    await askFor($, level)
    for (const l of LEVELS) expect([l, h.store.has(LV[l].key)]).toEqual([l, !(gone as readonly string[]).includes(l)])
  })
}

// /callboard off while the grant dialog is open, then the click: nothing is granted at any level (the off is remembered).
for (const level of LEVELS) {
  test(`dialog: /callboard off while the ${level} dialog is open, then Yes: nothing is granted (refused off-meanwhile)`, async ($, on) => {
    const stdins: string[] = []
    await world($, on, stdins)
    let release!: (a: string) => void
    h.askHang = new Promise<string>((r) => (release = r))
    const p = grant($, level)
    await waitFor(() => h.askCount === 1)
    await off($)
    release(YES)
    const text = (await p).text as string
    h.askHang = undefined
    expect(text).toBe('Nothing changed: callboard was turned off meanwhile.')
    expect(logged(stdins)).toContain('refused:off-meanwhile')
    expect(logged(stdins)).not.toContain(LV[level].onLog)
    expect(await isOn($)).toBe(false)
    expect(h.store.has(LV[level].key)).toBe(false)
  })
}
