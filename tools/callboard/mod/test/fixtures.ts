import { expect } from 'claude-code/testing'
import { conductorFileText, folderName, LANES_CHANGED_TEXT, LANES_CHANGED_NOTE, reboundToast, KEEPALIVE_TEXT } from '../hooks/core'
import { h, AUTO_OWN, GOOD, LANESDIR, NO, PS_TABLE, ROOT, SID, T0, TOOL, YES, condFiles, engine, extraStat, laneSeed, leadFiles, quiet, resultFiles, storeFiles, submitted } from './harness'
import type { Trace } from './harness'

export const TURN = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
export const allEvents = (stdins: string[]) => stdins.filter((x) => x.startsWith('{"t"')).map((x) => JSON.parse(x))
export const events = (stdins: string[]) => allEvents(stdins).filter((e) => e.event !== 'restored' && e.event !== 'command')

export const PERSON = { kind: 'composer' } as const
// The usage line, which /callboard on gets too.
export const USAGE = 'Use /callboard help, lanes, status, lead, lane [NAME], escalation [off], prompts, manager or off. Run /callboard help for the full list.'
export const lane = (args: string, origin: unknown = PERSON) => ({ command: 'callboard', args, origin }) as any
export const statusText = async ($: any) => (await $.command.run(lane('status'))).text as string

// Helpers the tests share, declared before their first use.
// The status of a session with no lane and no lead. The text is built inline in register.ts, so it cannot be imported: this is the typed copy the tests check against.
export const STATUS_NONE = 'Lane: NONE. Lead: OFF.'
export const newTrace = (): Trace => ({ log: [], failCounters: false })
export const putStore = (lanes: unknown[], creates: number[] = []) => storeFiles.set(STOREFILE, JSON.stringify({ repo: PIN, lanes, creates }))
export const OWN_ROW = (over: Record<string, unknown> = {}): Record<string, string> => ({ '4999.json': JSON.stringify({ ...JSON.parse(AUTO_OWN), kind: 'interactive', ...over }) })
export const logged = (stdins: string[]) => allEvents(stdins).map((e) => `${e.event}:${e.reason}`)
export const MIN = 60_000
export const PARK_API = (extra: Record<string, unknown> = {}) => ({ name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 1, ...extra })
export const RESULT = `${ROOT}/result/${SID}.result`
export const tickTwice = async () => {
  await h.clock!.advance(2000)
  await h.clock!.advance(2000)
}
// Steps the mock clock n timer periods (2 s each).
export const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await h.clock!.advance(2000)
}
// Writes the cue file as a lead's send would, runs two ticks, and returns what the mod answered on the result file. The inode is part of the answer, so each call types it.
export const cue = async (ino: number, text: string, opts: { mode?: string; mtimeSec?: number } = {}) => {
  h.cueFile = { ino, text, present: true, ...opts }
  await tickTwice()
  return resultFiles.get(RESULT)
}
export const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Waits up to 2 s of real time for cond; fails the test when it never holds (a wait that times out silently once let a mutant pass).
export const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await sleepMs(5)
  expect(cond()).toBe(true)
}

// The mocked engine answers each dialog with `askAnswer` (`restoreAnswer` for the Restore question). A session starts
// as a plain one; `bound` makes it lane LABLANE the way the person does it: a lane hint (merged into one the seed wrote), Restore at /callboard lane.
export async function started($: any, on: any, stdins: string[], opts: { bound?: boolean; seed?: () => void; argv?: string[][]; clock?: boolean; trace?: Trace; interactive?: boolean } = {}) {
  engine(on, opts.argv ?? [], stdins, opts.clock, opts.trace)
  h.askAnswer = YES
  h.askHang = undefined
  h.askScript = undefined
  h.restoreHang = undefined
  h.askCount = 0
  h.lastQuestion = undefined
  h.askedOptions = []
  h.restoreAnswer = YES
  opts.seed?.()
  on('tool.call', async (_: any, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    h.lastQuestion = e.questions[0].question
    h.lastHeader = e.questions[0].header
    h.askCount++
    const isRestore = e.questions[0].question.startsWith('Restore this session as lane')
    const opts = e.questions[0].options.map((o: any) => (typeof o === 'string' ? o : o.label))
    const answer = h.askScript && !isRestore ? await h.askScript(e.questions[0].question, opts) : isRestore && h.restoreHang ? await h.restoreHang : h.askHang && !isRestore ? await h.askHang : isRestore ? h.restoreAnswer : h.askAnswer
    h.askedOptions.push(opts)
    const shown = answer === YES ? opts[0] : answer === NO ? opts[1] : answer
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: shown } } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: opts.interactive ?? true })
  if (opts.bound) {
    const had = laneSeed.text
    laneSeed.text ??= LANES
    const saved = (h.store.get(`sess:${SID}`) ?? { counters: {}, savedAt: h.nowMs }) as Record<string, unknown>
    h.store.set(`sess:${SID}`, { ...saved, lane: { name: 'LABLANE', at: 1 } })
    expect((await $.command.run(lane('lane'))).text).toBe(reboundToast('LABLANE'))
    laneSeed.text = had
    h.askCount = 0
    h.lastQuestion = undefined
    h.askedOptions = []
  }
}

export const LANES = JSON.stringify({ lanes: [{ name: 'LABLANE', folder: '/data/x/work/lab', brief: '/data/x/work/lab/BRIEF.md' }] })

// ---- lead tools (/callboard lead) ----
export const OTHER = '1a1b2c3d-0000-4000-8000-123456789abc'
export const LEAD_LANES = (repo: string) => JSON.stringify({ lanes: [{ name: 'LABLANE', folder: '/data/x/work/lab', brief: '/data/x/work/lab/BRIEF.md', repo }] })
export const leadCall = (verb: string, input: Record<string, unknown> = { lane: 'LABLANE' }) => ({ tool: `mcp__callboard__lane_${verb}`, ...input }) as any
export const cueSession = (id: string, name: string | undefined, cwd = '/data/x/work/lab', extra: Record<string, unknown> = {}) => ({
  [`${extra.pid ?? 4242}.json`]: JSON.stringify({ sessionId: id, ...(name ? { name } : {}), cwd, status: 'idle', pid: 4242, procStart: 'Tue Oct 27 20:37:50 2026', startedAt: T0 - 3_600_000, statusUpdatedAt: T0 - 60_000, ...extra }),
})

export async function lead($: any, on: any, stdins: string[], opts: { repo?: string; sess?: Record<string, string>; argv?: string[][]; clock?: boolean } = {}) {
  laneSeed.text = LEAD_LANES(opts.repo ?? '/data/x/work')
  h.sessions = opts.sess ?? cueSession(OTHER, 'LABLANE')
  await started($, on, stdins, { argv: opts.argv, clock: opts.clock })
  h.askAnswer = YES
  // A lane in a store is reached only by a lead pinned at its repo, so the grant is made there; the session goes back to the lane folder after.
  const was = h.callerCwd
  h.callerCwd = opts.repo ?? '/data/x/work'
  await $.command.run(lane('lead'))
  h.callerCwd = was
}

// A lane in a store is reached only by a lead pinned at its repo: a grant asked from the lane folder is made at the repo, and the session stays where it was.
export async function grantAt($: any, cwd: string) {
  h.callerCwd = cwd === '/data/x/work/lab' ? '/data/x/work' : cwd
  h.askAnswer = YES
  await $.command.run(lane('lead'))
  h.callerCwd = cwd
}

// ---- the cue path through the real tick: rename ----
// The session's own registry file, named by its pid as the engine names it.
export const REGFILE = '4310.json'
export const REG = (extra: Record<string, unknown> = {}) => JSON.stringify({ sessionId: SID, cwd: '/data/x/work/lab', status: 'idle', nameSource: 'auto', pid: 4310, procStart: 'Tue Oct 27 20:37:50 2026', kind: 'interactive', ...extra })

export async function renameThroughTick($: any, on: any, stdins: string[], added: number, trace?: Trace, before?: () => Promise<void>, argv: string[][] = []) {
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = { [REGFILE]: REG() }
  h.turnsAddedByRename = added
  engine(on, argv, stdins, true, trace)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/data/x/work/lab', surface: 'vscode', isInteractive: true })
  await $.command.run(lane('status'))
  await before?.()
  await cue(42, 'rename LABLANE\n')
}

// ---- lane_terminate and lane_retire ----
export const killed = (argv: string[][]) => argv.filter((a) => a[0] === '/bin/kill')
export const REPORT_OK = (sid = OTHER) => ({ text: `# old\nstatus: done 9a1b2c3d-0000-4000-8000-123456789abc\n# now\nwork done\nstatus: done ${sid}\n`, mtimeSec: (T0 - 1000) / 1000 })

export const closeWrites = (argv: string[][]) => argv.filter((a) => a[0] === '/bin/mv' && a[a.length - 1].startsWith(`${ROOT}/open/`) && a[a.length - 1].endsWith('.close'))

// The target's own registry file: the pid and start time the shell check looks up, matching the `ps` mock.
export const SELFREG = (over: Record<string, unknown> = {}) => ({ '4300.json': REG({ pid: 4300, procStart: 'Tue Oct 27 20:37:50 2026', ...over }) })
export async function retireTarget($: any, on: any, stdins: string[] = [], trace?: Trace, argv: string[][] = []) {
  await renameThroughTick($, on, stdins, 1, trace, undefined, argv)
  h.sessions = SELFREG()
  await $.prompt.submit({ text: 'work on it' } as any)
  await h.clock!.advance(1000)
  h.reportFile = { text: `# r\nstatus: done ${SID}\n`, mtimeSec: h.nowMs / 1000 }
  await h.clock!.advance(1000)
}
export const retireCue = (ino: number) => cue(ino, 'retire\n')

// An armed `now` request whose compaction step throws on every tick (agent.list fails).
export const armNow = (trace: Trace) => trace.st!.set('request', { value: { phase: 'armed', mode: 'now', requestedMs: h.nowMs, id: 'r1', focus: 'f', continuation: 'c' }, version: 9 })

// ---- lane_open ----
export const NEWSID = '4a1b2c3d-0000-4000-8000-123456789abc'

// ---- lanes a lead makes (lane_create; lane_retire and lane_terminate remove them) ----
export const PIN = '/Users/x/code/app'
export const KEY = 'a'.repeat(64)
export const STOREFILE = `${LANESDIR}/${KEY}.json`
export const dirStat = '501 755 8 Directory 6 256 1700000000\n'
export const fileStat = '501 644 1 Regular File 7 20 1700000000\n'
export const created = (extra: Record<string, unknown> = {}) => ({ name: 'API', folder: `${PIN}/api`, task: 'Build the API.', ...extra })
export async function creator($: any, on: any, stdins: string[] = [], opts: { pin?: string; argv?: string[][] } = {}) {
  await lead($, on, stdins, { argv: opts.argv })
  extraStat.set(`${PIN}/.git`, dirStat)
  extraStat.set(`${PIN}/api`, dirStat)
  await grantAt($, opts.pin ?? PIN)
}
export const callCreate = ($: any, input: Record<string, unknown> = created()) => $.tool.call(leadCall('create', input))
export const storeLaneNames = () => (storeFiles.has(STOREFILE) ? (JSON.parse(storeFiles.get(STOREFILE)!).lanes as { name: string }[]).map((l) => l.name) : [])

export const settle = async (p: Promise<any>) => {
  for (let i = 0; i < 20; i++) await h.clock!.advance(500)
  return JSON.stringify(await p)
}

// Waits (real time) until the question is up, then lets the 90 s pass on the mock clock.
export const unanswered = async (p: Promise<any>) => {
  const n = h.askCount
  await waitFor(() => h.askCount !== n)
  await new Promise((r) => setTimeout(r, 10))
  await h.clock!.advance(90_000)
  return p
}

// ---- /callboard lane (an existing session becomes a lane of the lead in its repo) ----
export const LEADSID = '5a1b2c3d-0000-4000-8000-123456789abc'
export const LEADPS = 'Tue Oct 27 20:37:50 2026'
export const SVC = `${PIN}/svc`
export const LEADPATH = `${ROOT}/leads/${LEADSID}.json`
export const leadFileText = (over: Record<string, unknown> = {}) => JSON.stringify({ sid: LEADSID, pid: 4242, procStart: LEADPS, repo: PIN, ...over })
export const leadReg = (over: Record<string, unknown> = {}) => ({ '4242.json': JSON.stringify({ sessionId: LEADSID, name: 'LEAD', cwd: PIN, status: 'idle', pid: 4242, procStart: LEADPS, startedAt: T0 - 3_600_000, statusUpdatedAt: T0 - 60_000, ...over }) })
export const ownReg = (over: Record<string, unknown> = {}) => ({ '4300.json': JSON.stringify({ sessionId: SID, name: 'svc-api', nameSource: 'user', cwd: SVC, status: 'idle', pid: 4300, procStart: LEADPS, startedAt: T0 - 3_600_000, statusUpdatedAt: T0 - 60_000, kind: 'interactive', ...over }) })
export const doLane = ($: any, args = 'lane', origin: unknown = PERSON) => $.command.run(lane(args, origin))
export const storeJson = () => JSON.parse(storeFiles.get(STOREFILE)!)

// A session in SVC with a user-given name by default, a live lead for PIN with a fresh presence file, no lanes.
export async function attacher($: any, on: any, stdins: string[] = [], opts: { clock?: boolean; own?: Record<string, unknown>; lead?: boolean; argv?: string[][]; trace?: Trace } = {}) {
  laneSeed.text = undefined
  h.sessions = { ...leadReg(), ...ownReg(opts.own) }
  await started($, on, stdins, { clock: opts.clock, argv: opts.argv, trace: opts.trace })
  h.callerCwd = SVC
  extraStat.set(`${PIN}/.git`, dirStat)
  if (opts.lead !== false) leadFiles.set(LEADPATH, { text: leadFileText() })
  h.askAnswer = 'Join'
}
export const noLaneWritten = async ($: any) => {
  expect(storeFiles.has(STOREFILE)).toBe(false)
  expect((await $.command.run(lane('status'))).text).toContain('Lane: NONE')
}
export const LOCK_CYCLE = ['mkdir', 'owner-file', 'owner-write', 'rm-owner', 'rmdir']
export const ATTACHED = (name = 'svc-api', folder = SVC) => `This session is now lane ${name} in ${folderName(folder)} (repo ${folderName(PIN)}).`
export const ATT_REC = { name: 'svc-api', folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: 1, adopted: true, lead: LEADSID }

// ---- the lead side: presence file, lane_list, the lane-list notice, the attached-lane rules ----
export const SELFPATH = `${ROOT}/leads/${SID}.json`
export const leadSelfReg = (over: Record<string, unknown> = {}) => ({ '4400.json': JSON.stringify({ sessionId: SID, name: 'LEAD', cwd: PIN, status: 'idle', pid: 4400, procStart: LEADPS, startedAt: T0 - 3_600_000, statusUpdatedAt: T0 - 60_000, kind: 'interactive', ...over }) })
export async function leadAt($: any, on: any, stdins: string[] = [], opts: { clock?: boolean; sess?: Record<string, string>; argv?: string[][]; seed?: () => void; trace?: Trace } = {}) {
  laneSeed.text = undefined
  h.sessions = opts.sess ?? leadSelfReg()
  await started($, on, stdins, { clock: opts.clock, argv: opts.argv, seed: opts.seed, trace: opts.trace })
  extraStat.set(`${PIN}/.git`, dirStat)
  for (const f of ['api', 'svc']) extraStat.set(`${PIN}/${f}`, dirStat)
  extraStat.set(`${PIN}/api/BRIEF.md`, fileStat)
  await grantAt($, PIN)
}
export const attRec = (lead: string, name = 'ATT', extra: Record<string, unknown> = {}) => ({ name, folder: SVC, brief: `${SVC}/.callboard-attached`, createdAt: 9, adopted: true, lead, ...extra })
// The store without the lane of that name (a test that needs a lane gone, whatever way a lane can go).
export const dropRec = (name: string) => putStore((storeJson().lanes as { name: string }[]).filter((l) => l.name !== name), storeJson().creates)
export const listCall = () => ({ tool: 'mcp__callboard__lane_list' }) as any

export const listed = async ($: any) => (await $.tool.call(listCall())).result as string
// The list is one table under a plain header line (the fix pass, 2026-11-11): the lead and the repo sit on the first row of their group. A row is [lane, folder, session,
// waiting]; four columns means the table has a Folder column. noNote drops the lanes-changed note, which follows the table after a blank line.
export const ANY: [string, string] = ['Any lead', 'app']
const LEADHEAD = '**Lead LEAD** · live'
export const mdTable = (groups: Array<[string, string, string[][]]>, head = LEADHEAD) => {
  const withFolder = groups.some(([, , rows]) => rows.some((r) => r.length === 4))
  const cols = ['Lead', 'Repo', 'Lane', ...(withFolder ? ['Folder'] : []), 'Session', 'Waiting']
  return [
    head,
    '',
    `| ${cols.join(' | ')} |`,
    `|${cols.map(() => '---').join('|')}|`,
    ...groups.flatMap(([lead, repo, rows]) => rows.map((r, k) => `| ${[k === 0 ? lead : '', k === 0 ? repo : '', ...r].join(' | ')} |`)),
  ].join('\n')
}
export const mdBox = (who: [string, string], rows: string[][], head = LEADHEAD) => mdTable([[who[0], who[1], rows]], head)
export const noNote = (t: string) => t.replace(`\n\n${LANES_CHANGED_NOTE}`, '').replace(` ${LANES_CHANGED_NOTE}`, '')

// ---- the lead's briefing in the system prompt ----
export const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: ['Bash', 'mcp__callboard__lane_list', 'mcp__callboard__lane_retire'], outputStyle: null, traits: [] } as any
export const briefings = (r: any) => (r.sections as { id: string; text: string; scope: string }[]).filter((x) => x.id === 'callboard:lead')

export const noteRows = () => h.appendRows.map((m) => ({ type: m.type, blocks: m.content.length, text: m.content[0].text as string }))
export const storeText = (n: number) => JSON.stringify({ repo: PIN, lanes: [], creates: Array.from({ length: n }, (_, i) => i) })
export const notices = () => submitted.filter((t) => t === LANES_CHANGED_TEXT).length

export const OTHERLEAD = '6a1b2c3d-0000-4000-8000-123456789abc'
export const ATTSESS = () => cueSession(OTHER, 'ATT', SVC, { pid: 4500 })
export const ATTLEAD = (verb: string, extra: Record<string, unknown> = {}) => leadCall(verb, { lane: 'ATT', ...extra })

// ---- the cross-process store lock ----
export const ownerText = (pid: number, nonce: string, procStart = LEADPS) => JSON.stringify({ pid, procStart, nonce })
export const OWNER_LIVE = ownerText(4242, 'live-nonce-0001')

// ---- the attached lane svc-api of the lead LEADSID ----
export const ATTLANE = (over: Record<string, unknown> = {}) => attRec(LEADSID, 'svc-api', over)

// ---- registry files left by a process that died ----
export const TWIN = '3a1b2c3d-0000-4000-8000-123456789abc'

export const laneTarget = async ($: any, on: any, stdins: string[], trace?: Trace) => {
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = { [REGFILE]: REG() }
  h.turnsAddedByRename = 1
  await started($, on, stdins, { clock: true, trace })
}

// ---- F7 races: a lead grant and a lane binding under way at the same time ----
export const pause = () => new Promise((r) => setTimeout(r, 20))

// ---- the lane's briefing: a session-scope section while bound, and a note at attach and restore ----
export const LANE_COMPOSE = { ...COMPOSE, tools: ['Bash', TOOL] } as any
export const laneSections = (r: any) => (r.sections as { id: string; text: string; scope: string }[]).filter((x) => x.id === 'callboard:lane')

// Two leads hold the repo: the rename cue names the lead that sent it, and only a live lead of the repo is taken from it.
// storeLane: the lane is a store record with these extra fields instead of the plain seeded one.
export async function bornWithTwoLeads($: any, on: any, cueText: string, storeLane?: Record<string, unknown>) {
  const FOLDER = `${PIN}/lab`
  laneSeed.text = storeLane ? undefined : JSON.stringify({ lanes: [{ name: 'LABLANE', folder: FOLDER, brief: `${FOLDER}/BRIEF.md`, repo: PIN }] })
  h.sessions = { [REGFILE]: REG({ cwd: FOLDER }), ...leadReg({ nameSource: 'user' }), '4243.json': leadReg({ sessionId: OTHERLEAD, pid: 4243, name: 'LEAD2', nameSource: 'user' })['4242.json'] }
  h.turnsAddedByRename = 1
  engine(on, [], [], true)
  if (storeLane) putStore([{ name: 'LABLANE', folder: FOLDER, brief: `${FOLDER}/BRIEF.md`, createdAt: 1, ...storeLane }])
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: FOLDER, surface: 'vscode', isInteractive: true })
  h.callerCwd = FOLDER
  extraStat.set(`${PIN}/.git`, dirStat)
  leadFiles.set(LEADPATH, { text: leadFileText() })
  leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: leadFileText({ sid: OTHERLEAD, pid: 4243 }) })
  await $.command.run(lane('status'))
  expect(await cue(42, cueText)).toBe('rename ok - 42\n')
  return { first: laneSections(await $.prompt.compose(LANE_COMPOSE))[0].text.split('\n')[0], status: (await $.command.run(lane('status'))).text }
}

// A trace whose first binding write waits until the test releases it (later writes go through at once).
export const lateLane = () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  let first = true
  const trace: Trace = { log: [], failCounters: false, setHook: (key) => { if (key === 'lane' && first) { first = false; return gate } } }
  return { trace, release: () => release() }
}

// ---- the compaction nudge: the lead's lane_compact with no request, and a person's session past its context level ----
export const nudges = () => submitted.filter((t) => t.startsWith('[callboard] Your '))
// The person's own claude process, so the shell check finds the session in the process table (the auto registry entry has pid 4999).
export const SELF_PS = `${PS_TABLE} 4999     1 /x/native-binary/claude\n`
export async function person($: any, on: any, stdins: string[] = [], trace?: Trace, bound = false) {
  h.sessions = {}
  laneSeed.text = undefined
  await started($, on, stdins, { clock: true, trace, bound })
  h.psTable = SELF_PS
}

// ---- the nudge in the middle of a turn: a PostToolUse (or failure) hook returns the text as additionalContext ----
const MID_TOOL = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu-mid', tool_response: {} }
// The kit answers nothing beneath the plugins: the engine's own result of a tool call is an empty one.
export const postBeneath = (on: any) => { for (const ev of ['classic.PostToolUse', 'classic.PostToolUseFailure'] as const) on(ev, () => ({})) }
export const midCtx = async ($: any, ev: 'PostToolUse' | 'PostToolUseFailure' = 'PostToolUse', extra: object = {}): Promise<string[]> =>
  ((await $.classic[ev]({ ...MID_TOOL, ...extra } as any)) as { additionalContext?: string[] } | undefined)?.additionalContext ?? []

// ---- the nudge grant: a nudged session that is not bound or on may make one `now` request of its own within 15 minutes ----
export const NOW = { ...GOOD, mode: 'now' }
export const NOT_ENABLED = "request_compact is not enabled for this session: mode on-cue needs a lane, mode now a person's session."

// ---- the lane model: a lead-made record with a model is switched with /model at its start ----
export const MFOLDER = `${PIN}/lab`

// ---- a store record names its session (sid sync, the clears, the lead's watch) ----
export const STORE_LANE = (extra: Record<string, unknown> = {}) => ({ name: 'LABLANE', folder: MFOLDER, brief: `${MFOLDER}/BRIEF.md`, createdAt: 1, ...extra })
export const recOf = (name = 'LABLANE') => (storeJson().lanes as any[]).find((l) => l.name === name)
// A lane the lead made (a store record), born through a rename cue on the first tick; the second tick runs the sid sync.
export async function bornStore($: any, on: any, stdins: string[], opts: { trace?: Trace; argv?: string[][]; added?: number; rec?: Record<string, unknown> } = {}) {
  laneSeed.text = undefined
  h.sessions = { [REGFILE]: REG({ cwd: MFOLDER }) }
  h.turnsAddedByRename = opts.added ?? 1
  engine(on, opts.argv ?? [], stdins, true, opts.trace)
  on('tool.call', () => ({ result: {} }))
  putStore([STORE_LANE(opts.rec)])
  extraStat.set(`${PIN}/.git`, dirStat)
  extraStat.set(MFOLDER, dirStat)
  await $.session.start({ cwd: MFOLDER, surface: 'vscode', isInteractive: true })
  h.callerCwd = MFOLDER
  await $.command.run(lane('status'))
  await cue(42, 'rename LABLANE\n')
}

// ---- lane_park ----
export const parkSess = (extra: Record<string, unknown> = {}) => ({ ...leadSelfReg(), ...cueSession(OTHER, 'API', `${PIN}/api`, { pid: 4500, ...extra }) })
export async function parker($: any, on: any, stdins: string[] = [], argv: string[][] = [], rec: Record<string, unknown> = { sid: OTHER }) {
  await leadAt($, on, stdins, { sess: parkSess(), argv })
  putStore([PARK_API(rec)])
}
export const park = async ($: any, laneName = 'API') => $.tool.call(leadCall('park', { lane: laneName }))
export const drive = async (p: Promise<any>, n = 40) => {
  let done = false
  p.then(() => (done = true), () => (done = true))
  for (let i = 0; i < n && !done; i++) await h.clock!.advance(500)
  return p
}

// ---- a store lane rebinds itself when its session starts again ----
// A session whose store record names its id, at start. Its dialogs answer yes, the Restore question waits on restoreHang when a test sets it.
export const rebindAsks: string[] = []
export async function rebinder($: any, on: any, stdins: string[], opts: { rec?: Record<string, unknown>; sess?: Record<string, string>; hint?: unknown; argv?: string[][]; trace?: Trace; cwd?: string; interactive?: boolean } = {}) {
  laneSeed.text = undefined
  h.sessions = opts.sess ?? { [REGFILE]: REG({ cwd: MFOLDER }) }
  engine(on, opts.argv ?? [], stdins, true, opts.trace)
  rebindAsks.length = 0
  h.restoreHang = undefined
  on('tool.call', async (_: any, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const q = e.questions[0]
    rebindAsks.push(q.question)
    const answer = q.question.startsWith('Restore this session') && h.restoreHang ? await h.restoreHang : YES
    const labels = q.options.map((o: any) => (typeof o === 'string' ? o : o.label))
    return { result: { questions: e.questions, answers: { [q.question]: answer === YES ? labels[0] : answer === NO ? labels[1] : answer } } }
  })
  putStore([STORE_LANE({ sid: SID, ...opts.rec })])
  extraStat.set(`${PIN}/.git`, dirStat)
  extraStat.set(MFOLDER, dirStat)
  if (opts.hint !== undefined) h.store.set(`sess:${SID}`, opts.hint)
  h.callerCwd = opts.cwd ?? MFOLDER
  await $.session.start({ cwd: MFOLDER, surface: 'vscode', isInteractive: opts.interactive ?? true })
}
export const rebinds = (stdins: string[]) => logged(stdins).filter((x) => x.startsWith('rebound:') || x.startsWith('rebind-rejected:'))
export const LANE_HINT = (lane: Record<string, unknown> = {}, counters: Record<string, unknown> = {}) => ({ lane: { name: 'LABLANE', at: 1, turns: -1, ...lane }, counters, savedAt: T0 })

// ---- the lead grant survives a restart ----
export const LEADKEY = `lead:${SID}`

// ---- the keepalive ping and /callboard config ----
export const pings = () => submitted.filter((t) => t === KEEPALIVE_TEXT)
// The text turn.start carries for a turn the mod's own submit started (probe, engine 2.1.316).
export const framed = (text: string) => `The callboard plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`
// The engine runs turn.start (with the framed text) and turn.complete for the mod's own submit, but not the mod's own prompt.submit hook; the kit
// runs neither, so the turn is played here.
export async function ownTurn($: any, text: string) {
  await $.turn.start({ turnId: 'own', text: framed(text) } as any)
  await $.turn.complete(TURN as any)
}

// The Mac sleeps for ms: the timer's next period is held (no tick runs) while the clock moves on, then let go.
export async function sleepFor(ms: number) {
  let wake!: () => void
  h.timerHeld = new Promise<void>((r) => (wake = r))
  // The period already asked runs once more; the one it asks next is held.
  await h.clock!.advance(2000)
  await h.clock!.set(h.nowMs + ms)
  h.timerHeld = undefined
  wake()
  // The tick the wake lets through runs on its own: wait for it, as advance waits for the ticks it makes.
  await quiet()
}

// ---- lanes name their lead (the key is the lead's registry name, never a file) ----
export const selfAs = (name: string, over: Record<string, unknown> = {}) => leadSelfReg({ name, nameSource: 'user', ...over })
export const regAs = (sid: string, pid: number, name: string) => ({ [`${pid}.json`]: leadReg({ sessionId: sid, pid, name, nameSource: 'user' })['4242.json'] })
export const bareList = async ($: any) => noNote(await listed($))

// ---- two leads in one repo, a second /callboard lead, and the Join dialog's lead picker ----
export const OTHERPATH = `${ROOT}/leads/${OTHERLEAD}.json`
export const madeLane = (name: string, leadName?: string) => ({ name, folder: SVC, brief: `${SVC}/B.md`, createdAt: 1, ...(leadName ? { leadName } : {}) })

// ---- lead check-ins, /callboard checkin, the waiting column ----
const CK_TAIL = 'Call lane_list and look at each. Submitted by the callboard mod, not by the user; it carries no approval, go or answer; never record it as one.'
export const ckText = (parts: string) => `[callboard] Check-in: some lanes may need you. ${parts}. ${CK_TAIL}`
export const QUIET = '`API` (quiet for 30 min, report not signed done)'
export const checkins = () => submitted.filter((t) => t.startsWith('[callboard] Check-in:'))
export const ckLane = (extra: Record<string, unknown> = {}) => ({ name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 1, sid: OTHER, ...extra })
export const ckRow = (over: Record<string, unknown> = {}) => cueSession(OTHER, 'API', `${PIN}/api`, { pid: 4500, ...over })
// A lead with store lane API (its record names session OTHER), live as `row` says (none: not live), after a turn of the lead's own ended at T0.
export async function ckLead($: any, on: any, stdins: string[] = [], row: Record<string, unknown> | undefined = {}, lanes: unknown[] = [ckLane()]) {
  await leadAt($, on, stdins, { clock: true, sess: { ...leadSelfReg(), ...(row ? ckRow(row) : {}) }, seed: () => putStore(lanes) })
  h.reportAt = `${PIN}/.archive/API/REPORT.md`
  // The lead's own process (pid 4400) in the ps table, with no shell under it: no background work.
  h.psTable = `${PS_TABLE} 4400     1 /x/native-binary/claude\n`
  await $.turn.complete(TURN as any)
}
// Moves the clock in steps under the sleep gap (as sleepFor, with the timer held between two ticks): a long awake stretch, run fast.
export async function idleFor(ms: number) {
  for (let left = ms; left > 0; left -= 4 * MIN) {
    let wake!: () => void
    h.timerHeld = new Promise<void>((r) => (wake = r))
    await h.clock!.advance(2000)
    await h.clock!.set(h.nowMs + Math.min(4 * MIN, left) - 2000)
    h.timerHeld = undefined
    wake()
    await quiet()
  }
  await h.clock!.advance(2000)
}

// advance(ms) for a long quiet stretch: all but its last minute is jumped in steps under the sleep gap (as idleFor does), and the last minute ticks every 2 s.
export async function advanceQuiet(ms: number) {
  const tail = Math.min(ms, MIN)
  for (let left = ms - tail; left > 0; left -= 4 * MIN) {
    let wake!: () => void
    h.timerHeld = new Promise<void>((r) => (wake = r))
    await h.clock!.advance(2000)
    await h.clock!.set(h.nowMs + Math.min(4 * MIN, left) - 2000)
    h.timerHeld = undefined
    wake()
    await quiet()
  }
  await h.clock!.advance(tail)
}

// ---- the manager level, its five tools, the compact cue to leads, manager check-ins, soft/hard nudges ----
export const APISID = '00000000-0000-4000-8000-000000000001'
export const OTHERMGR = `${ROOT}/leads/${OTHERLEAD}.json`
// The manager (SID, pid 4400) and two lanes in two repos: LABLANE from the store of /data/x/work (session OTHER, pid 4600), API from the store of PIN (APISID).
export const MGR_SESS = (over: Record<string, unknown> = {}) => ({ ...leadSelfReg(over), ...cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { pid: 4600 }), ...cueSession(APISID, 'API', `${PIN}/api`, { pid: 4500 }) })
export async function mgrAt($: any, on: any, stdins: string[] = [], opts: { clock?: boolean; sess?: Record<string, string>; argv?: string[][]; args?: string; seed?: () => void } = {}) {
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.sessions = opts.sess ?? MGR_SESS()
  await started($, on, stdins, { clock: opts.clock, argv: opts.argv, seed: () => { putStore([ckLane({ sid: APISID })]); opts.seed?.() } })
  extraStat.set(`${PIN}/.git`, dirStat)
  for (const f of ['api', 'svc']) extraStat.set(`${PIN}/${f}`, dirStat)
  extraStat.set(`${PIN}/api/BRIEF.md`, fileStat)
  h.askAnswer = YES
  return $.command.run(lane(opts.args ?? 'manager'))
}
// Another live session with a manager file (mgrFile) and its registry row, carrying `name` (mgrRow).
export const mgrFile = (name = 'MANAGER') => leadFiles.set(OTHERMGR, { text: JSON.stringify({ sid: OTHERLEAD, pid: 4243, procStart: LEADPS, level: 'manager', name }) })
export const mgrRow = (name = 'MANAGER') => regAs(OTHERLEAD, 4243, name)
export const mgrCall = (verb: string, laneName: string) => ({ tool: `mcp__callboard__lane_${verb}`, lane: laneName }) as any

// ---- lane_retire and lane_terminate of a lane no live session carries remove its record ----
// The manager (cwd /) and LABLANE (store of /data/x/work, live); API, the store lane of PIN (another repo), has no live session.
// The home folder the mod finds from its paths (ROOT less /.claude/callboard).
export const HOME = ROOT.slice(0, -'/.claude/callboard'.length)
export const MGR_NOAPI = (over: Record<string, unknown> = {}) => ({ ...leadSelfReg(over), ...cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { pid: 4600 }) })
export const storeNames = () => (JSON.parse(storeFiles.get(STOREFILE)!).lanes as { name: string }[]).map((l) => l.name)
export const noArchiveRm = (argv: string[][]) => !argv.some((a) => a[0] === '/bin/rm' && a.some((x) => x.includes('/.archive/')))

// ---- the conductor level ----
// The conductor repo COND sits beside PIN (../app) and APP2 (../app2); FAR is a repo elsewhere (an absolute entry). The session's own row is in COND.
export const COND = '/Users/x/code/cond'
export const CONDFILE = `${COND}/.claude/callboard-conductor.json`
export const APP2 = '/Users/x/code/app2'
export const FAR = '/Users/x/data/x/work/elsewhere/far-repo'
export const condSelf = (over: Record<string, unknown> = {}) => leadSelfReg({ cwd: COND, name: 'COND', ...over })
export async function condAt($: any, on: any, stdins: string[] = [], opts: { clock?: boolean; sess?: Record<string, string>; seed?: () => void; argv?: string[][]; trace?: Trace } = {}) {
  laneSeed.text = undefined
  h.sessions = opts.sess ?? condSelf()
  await started($, on, stdins, {
    clock: opts.clock,
    argv: opts.argv,
    trace: opts.trace,
    seed: () => {
      h.callerCwd = COND
      for (const r of [COND, PIN, APP2, FAR]) extraStat.set(`${r}/.git`, dirStat)
      opts.seed?.()
    },
  })
  h.askAnswer = YES
}
export const condRun = ($: any, args: string, origin: unknown = PERSON) => $.command.run(lane(args === '' ? 'conductor' : `conductor ${args}`, origin))
export const putCond = (repos: string[]) => {
  if (!extraStat.has(`${COND}/.claude`)) extraStat.set(`${COND}/.claude`, '501 755 2 Directory 8 64 1700000000\n')
  condFiles.set(CONDFILE, conductorFileText(repos))
}
// The conductor (SID in COND) with lane API in PIN's store (session APISID) and LABLANE of /data/x/work (session OTHER), granted over ../app and ../app2.
export const CSESS = (over: Record<string, unknown> = {}) => ({ ...condSelf(over), ...cueSession(APISID, 'API', `${PIN}/api`, { pid: 4500 }), ...cueSession(OTHER, 'LABLANE', '/data/x/work/lab', { pid: 4600 }) })
export async function condOn($: any, on: any, stdins: string[] = [], opts: { clock?: boolean; sess?: Record<string, string>; seed?: () => void; argv?: string[][]; trace?: Trace; repos?: string[] } = {}) {
  await condAt($, on, stdins, {
    clock: opts.clock,
    argv: opts.argv,
    trace: opts.trace,
    sess: opts.sess ?? CSESS(),
    seed: () => {
      putStore([ckLane({ sid: APISID })])
      extraStat.set(`${PIN}/api`, dirStat)
      extraStat.set(`${PIN}/api/BRIEF.md`, fileStat)
      opts.seed?.()
    },
  })
  laneSeed.text = LEAD_LANES('/data/x/work')
  putCond(opts.repos ?? ['../app', '../app2'])
  return condRun($, '')
}
export const condPresenceOf = (sid: string, pid: number, name: string, repos: string[], over: Record<string, unknown> = {}) =>
  leadFiles.set(`${ROOT}/leads/${sid}.json`, { text: JSON.stringify({ sid, pid, procStart: LEADPS, level: 'conductor', name, repos, home: COND, ...over }) })

// lane_retire and lane_park wait for a lane that is not yet idle for 30 s. A hook has 10 s of its own time per dispatch;
// $.clock.sleep counts against it and a $ call (process.run) does not. The idle wait (up to 40 s) and the stop poll (10 s) therefore wait through /bin/sleep, not
// $.clock.sleep, since the engine cuts a hook off at the budget. The test engine does not enforce the budget, so these tests hold the cause itself: a wait
// inside a tool call costs no $.clock.sleep time worth the budget, and goes through /bin/sleep.
export const HOOK_BUDGET_MS = 10_000
export const sleeps = (argv: string[][]) => argv.filter((a) => a[0] === '/bin/sleep')

// ---- stuck lanes: an attached lane no live session carries can be removed; a lead's rename carries the lanes its session owns ----
// A lane a session joined whose session is gone (a lead's records of lanes it was joined to) could not be retired or terminated: only /callboard lane off in the gone session
// detached it. A lead that was renamed lost the lanes naming its old name.
export const GONE_ATT = (name = 'ATT', extra: Record<string, unknown> = {}) => attRec(SID, name, { leadName: 'LEAD', ...extra })
