import { mock, test } from 'claude-code/testing'

// A test that simulates an hour or more of the mod's 2 s timer runs thousands of ticks, and each one costs the kit host round trips: half a millisecond to
// two on a fast machine, by how much the mod does in a tick (280 simulated minutes: 8,400 ticks, 3.5 s; an hour of a lead's ticks: 1,800, 2 to 3.5 s). The kit's 5 s wall-time limit then measures the runner's speed, not whether the test hangs, and a runner
// 1.5 to 2 times slower, or a busy one, fails a different one of them each run. A test that takes a second or more on a fast machine (about 600 ticks, 20
// simulated minutes or more, or a long wait stepped through many short timers) is declared with longTest: the same test and assertions, with this limit. A test that
// hangs still fails, one minute later. A new test that simulates that much time takes longTest too.
const LONG_TEST_MS = 60_000
export const longTest = (name: string, body: (...args: any[]) => any) => test(name, { timeoutMs: LONG_TEST_MS } as any, body)

// A stand-in hash: any change in the text changes it, which is all the record check needs.
export function fakeSha(text: string): string {
  let h = 2166136261
  let out = ''
  for (let r = 0; r < 8; r++) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0
    h = Math.imul(h ^ r, 16777619) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out
}

// The mocked dialog answers with the button the dialog itself has: YES is its first option, NO its second. Any other string is taken as typed.
export const YES = '<yes button>'
export const NO = '<no button>'
export const SID = '0a1b2c3d-0000-4000-8000-123456789abc'
export const TOOL = 'mcp__callboard__request_compact'
export const GOOD = { tool: TOOL, focus: 'keep the plan', continuation: 'next: run tests', mode: 'on-cue' }

export const seen = { compacted: false }
// With the mock clock, the /bin/sleep processes in flight: each ends once the test has advanced the clock past its time.
const sleepWaits: { due: number; go: () => void }[] = []
const releaseSleeps = () => {
  for (const w of sleepWaits.splice(0)) if (w.due <= h.nowMs) w.go()
    else sleepWaits.push(w)
}
// kind interactive: the engine writes it for a panel or a terminal; the nudge needs it on the session's own row.
export const AUTO_OWN = JSON.stringify({ sessionId: '0a1b2c3d-0000-4000-8000-123456789abc', cwd: '/data/x/work/lab', status: 'idle', pid: 4999, procStart: 'Tue Oct 27 20:37:50 2026', kind: 'interactive' })
const regBase = (): Record<string, string> => (!h.ownEntryAuto || Object.values(h.sessions).some((t) => t.includes('"sessionId":"0a1b2c3d-0000-4000-8000-123456789abc"')) ? h.sessions : { ...h.sessions, '4999.json': AUTO_OWN })
// h.extraSessions: rows added to whatever h.sessions holds (the live lead a cue test sends from), so a test that rewrites h.sessions keeps them.
export const regFiles = (): Record<string, string> => (Object.keys(h.extraSessions).length === 0 ? regBase() : { ...regBase(), ...h.extraSessions })
// What the live checkout's .git/HEAD holds when the mod reads it at session start (undefined: the read fails). Default: on main, which warns nothing.
const MAIN_HEAD = 'ref: refs/heads/main\n'
export const LANESDIR = '/Users/x/.claude/callboard/lanes'
export const storeFiles = new Map<string, string>()
// Lanes a test seeds are store lanes, as a lead's lane_create leaves them. `laneSeed.text` takes a list of (name, folder, brief, repo?) and writes one store
// file per repo (a lane with no repo goes in /data/x/work), with that repo's .git; undefined takes the files it wrote away again.
const SEED_KEY = (repo: string) => (repo === '/Users/x/code/app2' ? 'b' : repo === '/Users/x/code/cond' ? 'c' : repo === '/data/x/work' ? 'd' : 'a').repeat(64)
export const laneSeed = {
  get text(): string | undefined {
    return h.laneSeedText
  },
  set text(v: string | undefined) {
    for (const f of h.laneSeedWrote.keys()) storeFiles.delete(f)
    h.laneSeedWrote = new Map()
    h.laneSeedText = v
    if (v === undefined) return
    const byRepo = new Map<string, unknown[]>()
    for (const l of JSON.parse(v).lanes as { name: string; folder: string; brief: string; repo?: string }[]) {
      const repo = l.repo ?? '/data/x/work'
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), { name: l.name, folder: l.folder, brief: l.brief, createdAt: 1 }])
    }
    for (const [repo, lanes] of byRepo) {
      const f = `${LANESDIR}/${SEED_KEY(repo)}.json`
      if (storeFiles.has(f) && !h.laneSeedWrote.has(f)) throw new Error(`laneSeed: ${f} is taken`)
      const t = JSON.stringify({ repo, lanes, creates: [] })
      storeFiles.set(f, t)
      h.laneSeedWrote.set(f, t)
      extraStat.set(`${repo}/.git`, '501 755 8 Directory 6 256 1700000000\n')
    }
  },
}
export const teeTexts = new Map<string, string>()
export const extraStat = new Map<string, string>()
// Lane briefs lane_create wrote (<folder>/.archive/<NAME>/BRIEF.md), by path: the text renamed into place. mkdir -p of a .archive/<NAME> folder makes both
// folders in extraStat (as archiveMade) unless one is already there; briefMvFails fails the rename.
export const briefFiles = new Map<string, string>()
// Conductor list files (<repo>/.claude/callboard-conductor.json) by path, the stat a test puts in place of the plain file's, and a hook run when the writer
// fills its temp file (between its first read and its second).
export const condFiles = new Map<string, string>()
export const condStat = new Map<string, string>()
export const realMap = new Map<string, string>()
export const headArgs: string[] = []
export const SESSIONS = '/Users/x/.claude/sessions'
// The registry folder a path sits in, with the file name.
const regDirOf = (path: string): { name: string; files: Record<string, string> } | undefined =>
  path.startsWith(`${SESSIONS}/`) ? { name: path.slice(SESSIONS.length + 1), files: regFiles() } : undefined
export const T0 = 1_700_000_000_000
// ADR 0004 (prompt answering): a fake of ~/.claude/callboard/prompts, files by path, answering the argv shapes the hook and the ledger use.
export const PROMPTS_DIR = '/Users/x/.claude/callboard/prompts'
export const pfs = new Map<string, { text: string; mtimeSec: number; mode?: string; nlink?: number; uid?: number }>()
export const pdirs = new Set<string>()
// The usage folder (usage.ts) is kept in the same file fake.
export const USAGE_DIR = '/Users/x/.claude/callboard/usage'
export const OFFERS_DIR = '/Users/x/.claude/callboard/offers'
const isPromptPath = (p: unknown) => typeof p === 'string' && (p === PROMPTS_DIR || p.startsWith(`${PROMPTS_DIR}/`) || p === USAGE_DIR || p.startsWith(`${USAGE_DIR}/`) || p === OFFERS_DIR || p.startsWith(`${OFFERS_DIR}/`))
function promptList(path: string) {
  const pre = path.endsWith('/') ? path : `${path}/`
  const names = new Map<string, { kind: string; size: number; mtimeMs: number }>()
  for (const [k, v] of pfs) if (k.startsWith(pre) && !k.slice(pre.length).includes('/')) names.set(k.slice(pre.length), { kind: 'file', size: v.text.length, mtimeMs: v.mtimeSec * 1000 })
  for (const d of pdirs) if (d.startsWith(pre) && !d.slice(pre.length).includes('/')) names.set(d.slice(pre.length), { kind: 'dir', size: 0, mtimeMs: 0 })
  return [...names].map(([name, f]) => ({ name, kind: f.kind, size: f.size, mtimeMs: f.mtimeMs, isLink: false }))
}
function promptFs(a: string[], stdin: string | undefined, now: number): any | undefined {
  const ok = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  const last = a[a.length - 1]
  if (a[0] === '/usr/bin/uuidgen' && h.pfsFails?.(a)) return ok('', 1, 'failed')
  if (a[0] === '/usr/bin/uuidgen') return ok(`${(++h.uuidN).toString(16).padStart(8, '0').toUpperCase()}-0000-4000-8000-123456789ABC\n`)
  if (!a.some(isPromptPath)) return undefined
  if (h.pfsFails?.(a)) return ok('', a[0] === '/usr/bin/grep' ? 2 : 1, 'failed')
  if (a[0] === '/bin/mkdir') {
    for (const d of a.slice(1).filter((x) => x.startsWith('/'))) pdirs.add(d)
    return ok('')
  }
  if (a[0] === '/usr/bin/stat') {
    if (pdirs.has(last)) return ok(`501 700 2 Directory 21 64 ${Math.floor(now / 1000)}\n`)
    const f = pfs.get(last)
    return f ? ok(`${f.uid ?? 501} ${f.mode ?? '600'} ${f.nlink ?? 1} Regular File 31 ${f.text.length} ${f.mtimeSec}\n`) : ok('', 1, `stat: ${last}: No such file or directory`)
  }
  if (a[0] === '/usr/bin/install') {
    if (!pfs.has(last)) pfs.set(last, { text: '', mtimeSec: Math.floor(now / 1000) })
    return ok('')
  }
  if (a[0] === '/usr/bin/tee') {
    const path = a[1] === '-a' ? a[3] : a[2]
    const cur = pfs.get(path) ?? { text: '', mtimeSec: Math.floor(now / 1000) }
    pfs.set(path, { ...cur, text: (a[1] === '-a' ? cur.text : '') + (stdin ?? '') })
    return ok('')
  }
  if (a[0] === '/bin/mv') {
    const f = pfs.get(a[a.length - 2])
    if (!f) return ok('', 1, 'mv: no such file')
    pfs.delete(a[a.length - 2])
    pfs.set(last, f)
    return ok('')
  }
  if (a[0] === '/bin/ln') {
    // A hard link that fails when the target is there (the first writer wins); the removal of the temporary name leaves the target one link.
    const src = pfs.get(a[a.length - 2])
    if (!src) return ok('', 1, 'ln: no such file')
    // A target that is a folder takes the link inside it, says nothing, and leaves no file of that name.
    if (pdirs.has(last)) return ok('')
    if (pfs.has(last)) return ok('', 1, 'ln: File exists')
    pfs.set(last, { ...src, nlink: 1 })
    return ok('')
  }
  if (a[0] === '/bin/rm') {
    for (const p of a.filter((x) => x.startsWith('/'))) pfs.delete(p)
    return ok('')
  }
  if (a[0] === '/bin/rmdir') {
    // Like rmdir: a folder that holds anything stays.
    if ([...pfs.keys()].some((k) => k.startsWith(`${last}/`))) return ok('', 1, 'rmdir: Directory not empty')
    pdirs.delete(last)
    return ok('')
  }
  if (a[0] === '/usr/bin/head') return pfs.has(last) ? ok(pfs.get(last)!.text.slice(0, Number(a[2]))) : ok('', 1, 'head: no such file')
  if (a[0] === '/usr/bin/grep') {
    const needle = a[a.length - 2]
    const hits = (pfs.get(last)?.text ?? '').split('\n').filter((l) => l.includes(needle))
    return hits.length > 0 ? ok(hits.join('\n') + '\n') : ok('', 1)
  }
  return undefined
}
// One turn of the event loop, then more of them for as long as the mod keeps calling the mocks. A hung call makes none, so it does not hold this up.
const QUIET_ROUNDS_MAX = 1000
export async function quiet() {
  for (let i = 0, seen = -1; i < QUIET_ROUNDS_MAX && seen !== h.hostCalls; i++) {
    seen = h.hostCalls
    await new Promise((r) => setTimeout(r, 0))
  }
}
export const submitted: string[] = []
export const toasts: string[] = []
// Answer files under <root>/result. A lead cue gets `autoAnswer` from its "target" at once (inode 12, the temp file's); undefined: no answer.
export const ROOT = '/Users/x/.claude/callboard'
export const resultFiles = new Map<string, string>()
export const OPEN_RESULT = '/Users/x/.claude/callboard/open/LABLANE.result'
export const PS_TABLE = '    1     0 /sbin/launchd\n 4300     1 /x/native-binary/claude --resume LABLANE\n 4310  4300 node /x/mcp-server.js\n 4311  4300 /usr/bin/caffeinate -i -t 300\n'
// A pid that got a SIGTERM that exited 0 is gone from `ps -p` unless a test sets survivesKill (the record is removed only once the process ended).
export const killedPids = new Set<string>()
export const psCalls: string[] = []
export const psStartsGone = new Set<string>()
export const psStartsAt = new Map<string, string>()
export const psStartsCalls: string[] = []
export const gitNoHead = new Set<string>()
// realpath failing for a path: the next n calls exit 1 with this message. gitFiles: the text of a `.git` file (a worktree's `gitdir:` line).
export const realFails = new Map<string, { n: number; err: string }>()
export const gitFiles = new Map<string, string>()
export const REPORT = '/data/x/work/.archive/LABLANE/REPORT.md'
// The store lock folder (mkdir is atomic), the lead presence files and the processes `ps` calls dead.
const LOCKRE = /\/\.[0-9a-f]{64}\.lock$/
export const regFacts = new Map<string, { mode?: string; kind?: string; size?: number; nlink?: number; uid?: number; flaky?: number; bump?: boolean; failHead?: number }>()
export const fsReads: string[] = []
export const lockOwnerReads: (string | undefined)[] = []
export const lockLog: string[] = []
const movedLocks = new Map<string, { owner: string | undefined; ino: number }>()
export const leadFiles = new Map<string, { text: string; mtimeSec?: number; mode?: string; nlink?: number; size?: number; uid?: number; kind?: string; swap?: boolean | 'once'; failHead?: number }>()
export const psDead = new Set<string>()
export const psConfirmCalls: string[] = []
export const statErr = new Map<string, string>()
export const psFail = new Set<string>()
export const renames: string[] = []
// /model runs, each as "<alias>@<prompts submitted before it>"; the model name the session reports, which a /model sets unless modelMode says otherwise.
export const modelRuns: string[] = []
export const colorRuns: string[] = []
export const toolDefs: string[] = []
export const storeReads: string[] = []
// trace: the plugin's own state calls, in order, with an in-memory state of the test's own; failCounters makes a write of the counters fail every time.
export type Trace = { log: string[]; failCounters: boolean; setHook?: (key: string) => Promise<void> | void; failKeys?: Set<string>; st?: Map<string, { value: unknown; version: number }> }
// Every reassignable piece of mock state lives on this one object: an imported `let` is read-only, so a test writes `h.sessions = ...` instead. engine() puts back
// the state a test of the previous one left (resetClock to resetPrompts below); what a test sets before its first engine() call (the dialog answers, `sessions`,
// `rootMissing`, `turnsAddedByRename`, `laneSeed`) is not touched by it, and started() sets the dialog answers again.
export const h = {
  store: new Map<string, unknown>(),
  askAnswer: YES,
  lastQuestion: undefined,
  askedOptions: [] as string[][],
  // The header of the last question shown.
  lastHeader: undefined,
  askCount: 0,
  askHang: undefined,
  // Answers each non-restore question by its text and options (the lead picker, then the Join question); unset: askAnswer.
  askScript: undefined,
  restoreHang: undefined,
  restoreAnswer: YES,
  sessions: {} as Record<string, string>,
  // A process always has a registry entry of its own (the lock owner is named from it); a test that has none gets this one, unless it turns it off.
  ownEntryAuto: true,
  extraSessions: {} as Record<string, string>,
  cueLead: true,
  cueLeadAdded: false,
  // When set, the test engine's clock.sleep (without the mock clock) returns at once and moves nowMs by the time asked, then runs this hook (what a retire or park waits on).
  fastSleep: undefined,
  // What a hook has used of its 10 s of own time on $.clock.sleep (a $ call, such as /bin/sleep through process.run, costs it nothing), and a switch that makes /bin/sleep fail.
  clockSlept: 0,
  sleepFails: false,
  // One read of the clock throws, as a failing engine call would.
  nowThrowsOnce: false,
  callerCwd: '/data/x/work/lab',
  // The session's project root ($.session.root()): where it started; a shell cd moves only callerCwd. Unset: the same as callerCwd.
  callerRoot: undefined,
  reportGrown: undefined,
  headFails: false,
  liveHead: MAIN_HEAD as string | undefined,
  liveHeadReads: 0,
  // The path and the byte count of the last HEAD read; under the test engine $.plugin.root is the mod folder itself, so the checkout is the clone the suite runs in.
  liveHeadAsked: undefined,
  sessionsUnsafe: false,
  composeStale: false,
  appendRows: [] as any[],
  appendDeny: false,
  // The lead presence folder: a hook awaited when it is listed, and a stat of it that rejects.
  leadsListHook: undefined,
  // Awaited when the lane store folder is listed (a slow lane read).
  lanesListHook: undefined,
  leadsStatRejects: false,
  composeCalls: 0,
  laneSeedText: undefined,
  laneSeedWrote: new Map<string, string>(),
  briefMvFails: false,
  // The exit code of a head -c read of an existing BRIEF.md.
  briefHeadExit: 0,
  archiveMade: '501 755 2 Directory 8 64 1700000000\n',
  // The stat of a brief temp file, in place of the 0600 file install made.
  briefTmpStat: undefined,
  condWriteHook: undefined,
  storeStatOverride: undefined,
  uuidN: 0,
  // The entries of ~/.claude/hooks (links into the toolkit's checkout, by realMap).
  hooksList: [] as string[],
  pfsFails: undefined,
  // A shasum whose input (the request id, a newline and a label) the test makes fail: the label hash of a question's answer.
  shaFailsFor: undefined,
  nowMs: T0,
  // set: the mock clock jumps to a time without running every tick on the way.
  clock: undefined,
  // While set, the mock clock's timer asks for no next period (no tick runs): the Mac asleep. See sleepFor.
  timerHeld: undefined,
  turnsNow: 0,
  turnsAddedByRename: 1,
  // Entries the rename writes after the command returns: they show in the count once afterMs of test time has passed since the rename.
  renameLate: undefined as undefined | { afterMs: number; added: number },
  renameAt: 0,
  tokensNow: 150_000,
  // Runs once inside the next session.usage call, to change state while a hook awaits it.
  usageHook: undefined,
  // Fields of the next session.usage answers beyond the context tokens: cost, rateLimits.
  usageExtra: undefined as Record<string, unknown> | undefined,
  agentsNow: [] as { status: string }[],
  resultStat: undefined,
  autoAnswer: 'ok -' as string | undefined,
  autoIno: 12,
  cueWriteHook: undefined,
  resultIno: 88,
  resultSwap: undefined,
  compactedAtAnswer: undefined,
  resultList: [] as { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }[],
  logList: [] as { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }[],
  cueFile: undefined,
  takenAs: undefined,
  takenFile: undefined,
  cueSwapAtMv: undefined,
  cueNext: undefined,
  openResult: undefined,
  openResultPath: undefined,
  reportFile: undefined,
  reportStatErr: undefined,
  psOut: 'Tue Oct 27 20:37:50 2026\n',
  psTable: PS_TABLE,
  psTableFails: false,
  psRowsFail: false,
  psOversize: false,
  killFails: false,
  survivesKill: false,
  psFailsAfterKill: false,
  // `ps -A -o pid=,lstart=`, the registry filter's table: built from the registry files (each file's pid, at its own procStart) plus launchd, unless a test says otherwise.
  psStartsOut: undefined,
  psStartsFails: undefined,
  psEnv: undefined,
  psArgsOut: '/x/native-binary/claude --output-format stream-json\n',
  // The report path the mock serves (a store lane's report sits in its repo), a one-shot hook on a lane-record hash, and a store write that hangs.
  reportAt: REPORT,
  // Called at the first record hash of LABLANE; a promise it returns holds that hash until it settles.
  shaHook: undefined,
  storeHang: undefined,
  // A hook on the mod's store.set of a conductor: key (before it lands), and one on a realpath call (its promise holds the answer).
  condSetHook: undefined,
  realHook: undefined,
  // The reads (head) of a conductor list file so far.
  condHeads: 0,
  // Called with the target of every mv (a rename into place), before the mock acts on it.
  mvHook: undefined,
  lockState: { held: false } as { held: boolean; owner?: string; mtimeSec?: number; ino?: number },
  gateHeld: undefined,
  lockMkdirErr: undefined,
  lockOwnerAfterMoveIno: undefined,
  lockHook: undefined,
  lockRehold: undefined,
  lockRmThrows: false,
  storeMvDelayMs: 0,
  storeAfterMs: 0,
  storeWriteHook: undefined,
  submitFails: false,
  gateStatFails: false,
  lockMkdirEnv: undefined,
  openList: [] as { name: string; kind: string; isLink: boolean; mtimeMs: number; size: number }[],
  cueList: [] as { name: string; kind: string; isLink: boolean; mtimeMs: number; size: number }[],
  claimMvFails: false,
  psConfirmFails: undefined,
  psConfirmOut: undefined,
  renameMode: 'ok' as 'ok' | 'throw' | 'hang',
  // Runs when a rename command is taken, with the new name: a test uses it to make the registry carry that name.
  onRename: undefined as undefined | ((name: string) => void),
  // Run once, before the answer, at the next `ps -o args=` (a process check), then cleared.
  psArgsHook: undefined,
  modelMode: 'ok' as 'ok' | 'stay' | 'throw' | 'hang',
  modelNow: 'claude-sonnet-5-5',
  recShaFails: false,
  agentListThrows: false,
  renameGate: undefined,
  registerGate: undefined,
  // The next n session.root() calls throw; registering a lane_* tool waits on this.
  cwdThrows: 0,
  // A failed root() read makes the cwd() read that follows it fail too, so cwdThrows stays one failed folder read. rootMissing: an engine without root().
  cwdFailNext: false,
  rootMissing: false,
  // session.root() does not answer while this is set (a folder read that times out).
  rootHang: undefined as Promise<{ value: unknown }> | undefined,
  laneRegisterHang: undefined,
  // A write of a lead:<sid> key waits on this while it is set (the save of a grant in flight).
  leadSetHang: undefined,
  // Runs before any $.store write lands (the key as its argument); a returned promise holds the write (a save in flight).
  storeSetHook: undefined as ((key: string) => Promise<void> | void) | undefined,
  takenPlanted: false,
  storeWrites: 'ok' as 'ok' | 'fail' | 'ignore',
  storeDeleteFails: false,
  // Hangs the nth delete of a saved lead grant (the second is /callboard off's, after it has read the binding).
  leadDeleteHang: undefined,
  // Hangs the next read of a saved lead grant, once.
  leadGetHang: undefined,
  draftNow: '',
  lockOwnerWritten: undefined,
  lockOwnerFails: false,
  leadMvDelayMs: 0,
  compactHangs: false,
  compactThrows: false,
  submitHangs: false,
  // Run once inside the next prompt submit, before it succeeds or fails (the engine runs the prompt hooks there); a store call that throws at once.
  submitHook: undefined,
  storeThrowSync: undefined,
  lockOwnerAfterMove: undefined,
  // Each test's engine gets a generation. A tick of an earlier test's module that is still running when the next test starts would otherwise act on
  // this test's mocks (its cue file, its result and store files): its processes all fail instead.
  engineGen: 0,
  // Host calls the mod has made into the mocks so far: the clock helpers wait until none arrives for a whole turn of the event loop, so a tick that is still
  // working through its chain of reads and processes has finished when an advance returns. The kit's own wait for the mod to settle gives up after 500 ms of
  // wall time, which a slow runner can reach in the middle of a tick.
  hostCalls: 0,
  // Registry rows of the tiers a test adds (addCondT, addMgrT).
  extraRows: {} as Record<string, string>,
  // The hooks beneath the plugins are registered before the first $ call; a test changes what they answer through these.
  prVerdict: undefined,
  prBeneath: undefined,
  prBeneathCalls: 0,
  // While a test sets up its lane (dialogs ask through the same checks), the hook beneath asks for nothing.
  prSetup: false,
  // With no mock clock a wait through /bin/sleep returns at once and moves the test clock by the time asked (fastSleep): a poll loop then runs on its own, and a
  // hook here acts when the clock reaches a time (a person's click, a hand-made decision).
  clockHooks: [] as ((rel: number) => void | Promise<void>)[],
}

// The mock clock and the waits on it. A test that asks for no clock gets none; the previous test's clock is not left behind for it to advance.
function resetClock() {
  h.timerHeld = undefined
  h.nowMs = T0
  // A test that asks for no clock gets none; the previous test's clock is not left behind for it to advance.
  h.clock = undefined
  h.fastSleep = undefined
  h.clockSlept = 0
  h.sleepFails = false
  h.nowThrowsOnce = false
  sleepWaits.length = 0
}
// What the engine's session, prompt, command and environment hooks answer, and what they recorded.
function resetSession() {
  seen.compacted = false
  h.turnsNow = 0
  h.renameLate = undefined
  h.composeStale = false
  h.appendRows = []
  h.appendDeny = false
  h.composeCalls = 0
  h.submitFails = false
  renames.length = 0
  h.renameMode = 'ok'
  h.onRename = undefined
  modelRuns.length = 0
  colorRuns.length = 0
  h.modelMode = 'ok'
  h.modelNow = 'claude-sonnet-5-5'
  h.agentListThrows = false
  h.renameGate = undefined
  h.registerGate = undefined
  h.cwdThrows = 0
  h.rootHang = undefined
  h.cwdFailNext = false
  h.laneRegisterHang = undefined
  h.draftNow = ''
  h.compactHangs = false
  h.compactThrows = false
  h.submitHangs = false
  h.submitHook = undefined
  h.tokensNow = 150_000
  h.usageHook = undefined
  h.usageExtra = undefined
  h.agentsNow = []
  submitted.length = 0
  toasts.length = 0
  h.callerCwd = '/data/x/work/lab'
  h.callerRoot = undefined
  h.ownEntryAuto = true
  h.extraSessions = {}
  h.cueLead = true
  h.cueLeadAdded = false
}
// The session registry, the process table and its calls.
function resetRegistry() {
  h.sessionsUnsafe = false
  h.psOut = 'Tue Oct 27 20:37:50 2026\n'
  h.psTable = PS_TABLE
  h.psTableFails = false
  h.psRowsFail = false
  h.psOversize = false
  h.killFails = false
  killedPids.clear()
  h.survivesKill = false
  h.psFailsAfterKill = false
  psCalls.length = 0
  h.psStartsOut = undefined
  h.psStartsFails = undefined
  psStartsGone.clear()
  psStartsAt.clear()
  psStartsCalls.length = 0
  h.psArgsOut = '/x/native-binary/claude --output-format stream-json\n'
  regFacts.clear()
  fsReads.length = 0
  psDead.clear()
  psFail.clear()
  psConfirmCalls.length = 0
  statErr.clear()
  h.psConfirmFails = undefined
  h.psConfirmOut = undefined
  h.psArgsHook = undefined
}
// The lane store files, the plugin's store lock and the hooks on them.
function resetStoreFiles() {
  h.shaHook = undefined
  h.storeHang = undefined
  h.lanesListHook = undefined
  storeFiles.clear()
  h.storeStatOverride = undefined
  h.lockState = { held: false }
  h.gateHeld = undefined
  h.lockMkdirErr = undefined
  h.lockOwnerAfterMoveIno = undefined
  h.lockHook = undefined
  h.lockRehold = undefined
  h.lockRmThrows = false
  h.storeMvDelayMs = 0
  h.storeAfterMs = 0
  h.storeWriteHook = undefined
  h.lockMkdirEnv = undefined
  h.gateStatFails = false
  lockOwnerReads.length = 0
  lockLog.length = 0
  movedLocks.clear()
  h.recShaFails = false
  h.storeWrites = 'ok'
  h.lockOwnerWritten = undefined
  h.lockOwnerFails = false
  h.storeThrowSync = undefined
  h.lockOwnerAfterMove = undefined
  storeReads.length = 0
}
// The plugin's own store (store.get, set, delete) and the hangs on a saved lead grant.
function resetPluginState() {
  h.condSetHook = undefined
  h.leadSetHang = undefined
  h.storeSetHook = undefined
  h.storeDeleteFails = false
  h.leadDeleteHang = undefined
  h.leadGetHang = undefined
  h.leadMvDelayMs = 0
  h.store = new Map()
}
// The cue, result and report files of the lane the mod answers.
function resetCueFiles() {
  h.reportFile = undefined
  h.reportStatErr = undefined
  h.reportAt = REPORT
  h.reportGrown = undefined
  h.headFails = false
  headArgs.length = 0
  h.openResult = undefined
  h.openResultPath = undefined
  h.cueList = []
  h.openList = []
  h.claimMvFails = false
  h.takenPlanted = false
  h.cueFile = undefined
  h.takenAs = undefined
  h.takenFile = undefined
  h.cueSwapAtMv = undefined
  h.cueNext = undefined
  resultFiles.clear()
  h.resultStat = undefined
  h.autoAnswer = 'ok -'
  h.autoIno = 12
  h.cueWriteHook = undefined
  h.resultList = []
  h.logList = []
  h.compactedAtAnswer = undefined
  h.resultIno = 88
  h.resultSwap = undefined
}
// Files in the lane folders, the conductor lists, the leads folder and the live checkout.
function resetFolders() {
  h.realHook = undefined
  h.mvHook = undefined
  h.liveHead = MAIN_HEAD
  h.liveHeadReads = 0
  h.liveHeadAsked = undefined
  h.leadsListHook = undefined
  h.leadsStatRejects = false
  teeTexts.clear()
  extraStat.clear()
  briefFiles.clear()
  h.briefMvFails = false
  h.briefHeadExit = 0
  h.archiveMade = '501 755 2 Directory 8 64 1700000000\n'
  h.briefTmpStat = undefined
  condFiles.clear()
  condStat.clear()
  h.condWriteHook = undefined
  realMap.clear()
  gitNoHead.clear()
  realFails.clear()
  gitFiles.clear()
  leadFiles.clear()
}
// The prompts folder, the git answers and the processes the prompt answering runs.
function resetPrompts() {
  pfs.clear()
  pdirs.clear()
  h.hooksList = []
  h.uuidN = 0
  h.pfsFails = undefined
  h.shaFailsFor = undefined
}
// A list a test seeded before the engine started is written again, once the files above are clear.
function reseedLanes() {
  const seededBefore = laneSeed.text
  h.laneSeedWrote = new Map()
  laneSeed.text = seededBefore
}

// A host call a test never answers (a hook that returns a promise that never settles) is dropped by the kit when its test ends, and a dropped state write
// then lands in the kit's own state, at whatever moment a later test is running, and binds that test's session to the lane the earlier test attached. So a
// call that hangs for good waits on this list instead, and the next engine releases it: the write then finds its engine over and is refused.
const hangs: (() => void)[] = []
export const hangForever = () => new Promise<void>((r) => hangs.push(r))
export function engine(on0: any, argvSeen: string[][], stdins: string[] = [], clk = false, trace?: Trace) {
  const on = (name: string, handler: any) => on0(name, (...args: any[]) => (h.hostCalls++, handler(...args)))
  for (const release of hangs.splice(0)) release()
  const gen = ++h.engineGen
  resetClock()
  resetSession()
  resetRegistry()
  resetStoreFiles()
  resetPluginState()
  resetCueFiles()
  resetFolders()
  resetPrompts()
  reseedLanes()
  const installed = new Set<string>()
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  if (clk) {
    // nowMs follows the mock clock, so a file stamped "now" by the mock fs is as old as the clock says.
    // The timer's period is asked through timerHeld, so a test can hold it (sleepFor).
    const real = mock.clock((name: string, handler: any) => on(name, name !== 'clock.every' ? handler : (x: any, e: any, next: any) => (h.timerHeld ? h.timerHeld.then(() => handler(x, e, next)) : handler(x, e, next))), { now: T0 })
    h.clock = {
      // The clock moves to each /bin/sleep's time in turn, so a chain of short sleeps (a poll loop) runs as far as the advance reaches, as chained clock.sleep waits do.
      advance: async (ms: number) => {
        const target = h.nowMs + ms
        for (let guard = 0; guard < 100_000; guard++) {
          const due = Math.min(target, ...sleepWaits.map((w) => w.due).filter((d) => d > h.nowMs))
          const step = due - h.nowMs
          h.nowMs = due
          if (step > 0) await real.advance(step)
          releaseSleeps()
          await quiet()
          if (h.nowMs >= target && !sleepWaits.some((w) => w.due <= h.nowMs)) break
        }
      },
      set: async (ms: number) => { h.nowMs = ms; releaseSleeps(); await real.set(ms); await quiet() },
    }
  } else {
    on('clock.now', () => {
      if (h.nowThrowsOnce) {
        h.nowThrowsOnce = false
        throw new Error('boom /Users/x/secret')
      }
      return { value: h.nowMs }
    })
    on('clock.every', () => ({ value: undefined }))
    on('clock.sleep', async (_: any, e: any) => {
      const ms = Number(typeof e === 'number' ? e : e?.ms ?? e?.duration ?? 0)
      if (ms <= 2000) h.clockSlept += ms
      // Only the short polls return (a dialog's or a call's time limit is a long sleep, and must not fire).
      if (!h.fastSleep || !(ms <= 2000)) return new Promise(() => undefined)
      h.nowMs += ms
      await h.fastSleep(ms)
      return { value: undefined }
    })
  }
  on('session.turns', () => ({ value: h.turnsNow + (h.renameLate && h.nowMs - h.renameAt >= h.renameLate.afterMs ? h.renameLate.added : 0) }))
  on('session.id', () => ({ value: SID }))
  // An appended row counts as a turn here, so a note before lane_start would make it refuse not-empty in the tests too.
  // An earlier test's module is cut off from this test's shared mocks: its processes fail, its store, prompt, toast and append calls do nothing.
  const over = () => gen !== h.engineGen
  on('session.append', (_: any, e: any, next: any) => {
    if (over()) return { deny: 'test over' }
    h.appendRows.push(e.message)
    h.turnsNow++
    if (h.appendDeny) return { deny: 'test' }
    return next(e)
  })
  on('session.usage', async () => {
    const hook = h.usageHook
    h.usageHook = undefined
    await hook?.()
    return { value: { startedAt: 0, context: { tokens: h.tokensNow }, rateLimits: [], ...h.usageExtra } }
  })
  on('agent.list', () => {
    if (h.agentListThrows) throw new Error('agents')
    return { value: h.agentsNow }
  })
  on('prompt.read', () => ({ value: { text: h.draftNow, cursor: 0 } }))
  on('session.end', () => ({ sessionId: SID }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('prompt.submit', async (_: any, e: any) => {
    if (over()) return Promise.reject(new Error('test over'))
    const hook = h.submitHook
    h.submitHook = undefined
    if (hook) await hook(e.text)
    submitted.push(e.text)
    if (h.submitHangs) return new Promise(() => undefined)
    if (h.submitFails) return Promise.reject(new Error('refused'))
    return { text: e.text }
  })
  on('ui.toast', (_: any, e: any) => {
    if (over()) return { value: undefined }
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('prompt.compose', () => {
    h.composeCalls++
    return { sections: [{ id: 'intro', text: 'base prompt', scope: 'shared' }, { id: 'memory', text: 'memory', scope: 'session' }, ...(h.composeStale ? [{ id: 'callboard:lead', text: 'stale briefing', scope: 'session' }] : [])], extra: 'kept' }
  })
  on('command.run', async (_: any, e: any) => {
    if (e.command === 'rename') {
      if (h.renameGate) await h.renameGate
      renames.push(e.args)
      if (h.renameMode === 'throw') throw new Error('refused')
      if (h.renameMode === 'hang') return new Promise(() => undefined)
      h.turnsNow += h.turnsAddedByRename
      h.renameAt = h.nowMs
      h.onRename?.(e.args)
    } else if (e.command === 'model') {
      modelRuns.push(`${e.args}@${submitted.length}`)
      h.turnsNow++
      if (h.modelMode === 'throw') throw new Error('refused')
      if (h.modelMode === 'hang') return new Promise(() => undefined)
      if (h.modelMode === 'ok') h.modelNow = `claude-${e.args}-5-5`
    } else if (e.command === 'color') {
      // The manager's /color, run from a timer.
      colorRuns.push(e.args)
    } else {
      if (h.compactThrows) throw new Error('refused')
      seen.compacted = true
      if (h.compactHangs) return new Promise(() => undefined)
    }
    return { value: { text: '' } }
  })
  if (trace) {
    const st = new Map<string, { value: unknown; version: number }>()
    trace.st = st
    on('state.get', (_: any, e: any) => ({ value: st.get(e.key) ?? { value: undefined, version: 0 } }))
    on('state.set', async (_: any, e: any) => {
      await trace.setHook?.(e.key)
      if (over()) return { value: { isSet: false } }
      trace.log.push(`${e.key}${e.value === null ? ':null' : ''}`)
      if (e.key === 'counters' && trace.failCounters) return { value: { isSet: false } }
      if (trace.failKeys?.has(e.key)) return { value: { isSet: false } }
      const cur = st.get(e.key)
      if (e.ifVersion !== undefined && (cur?.version ?? 0) !== e.ifVersion) return { value: { isSet: false } }
      st.set(e.key, { value: e.value, version: (cur?.version ?? 0) + 1 })
      return { value: { isSet: true, version: (cur?.version ?? 0) + 1 } }
    })
  }
  on('tool.register', async (_: any, e: any) => {
    if (h.registerGate) await h.registerGate
    if (h.laneRegisterHang && String(e.name).startsWith('lane_')) await h.laneRegisterHang
    toolDefs.push(JSON.stringify(e))
    return { value: { tool: TOOL } }
  })
  on('command.register', () => ({ value: { command: 'callboard' } }))
  on('store.get', (_: any, e: any) => {
    if (h.storeThrowSync === 'get') throw new Error('sync')
    if (h.leadGetHang && String(e.key).startsWith('lead:')) {
      const gate = h.leadGetHang
      h.leadGetHang = undefined
      return gate.then(() => ({ value: over() ? undefined : h.store.get(e.key) }))
    }
    return { value: over() ? undefined : h.store.get(e.key) }
  })
  on('store.set', (_: any, e: any) => {
    if (h.storeThrowSync === 'set') throw new Error('sync')
    return storeSet(e)
  })
  const storeSet = async (e: any) => {
    if (over()) return { value: undefined }
    if (h.leadSetHang && String(e.key).startsWith('lead:')) await h.leadSetHang
    if (h.storeSetHook) await h.storeSetHook(String(e.key))
    if (h.condSetHook && String(e.key).startsWith('conductor:')) {
      const hook = h.condSetHook
      h.condSetHook = undefined
      await hook()
    }
    if (over()) return { value: undefined }
    h.store.set(e.key, e.value)
    return { value: undefined }
  }
  on('store.delete', async (_: any, e: any) => {
    if (over()) return { value: undefined }
    if (h.leadDeleteHang && String(e.key).startsWith('lead:') && ++h.leadDeleteHang.seen === h.leadDeleteHang.nth) await h.leadDeleteHang.gate
    if (over()) return { value: undefined }
    if (h.storeDeleteFails) throw new Error('disk')
    h.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: over() ? [] : [...h.store.keys()] }))
  on('session.cwd', () => {
    if (h.cwdFailNext) {
      h.cwdFailNext = false
      throw new Error('cwd')
    }
    return { value: h.callerCwd }
  })
  if (!h.rootMissing)
    on('session.root', () => {
      if (h.rootHang) return h.rootHang
      if (h.cwdThrows > 0) {
        h.cwdThrows--
        h.cwdFailNext = true
        throw new Error('root')
      }
      return { value: h.callerRoot ?? h.callerCwd }
    })
  on('session.model', () => ({ value: h.modelNow }))
  on('fs.read', (_: any, e: any) => {
    if (e.path === h.reportAt && h.reportFile) return { value: h.reportFile.text }
    if (e.path === (h.openResultPath ?? OPEN_RESULT) && h.openResult !== undefined) return { value: h.openResult }
    if (e.path.startsWith(`${SESSIONS}/`)) fsReads.push(e.path)
    const own = e.path.startsWith(`${SESSIONS}/`) ? regFiles()[e.path.slice(SESSIONS.length + 1)] : undefined
    return { value: own ?? '' }
  })
  on('fs.list', async (_: any, e: any) => {
    if (e.path === `${ROOT}/leads` && h.leadsListHook) await h.leadsListHook()
    if (e.path === LANESDIR && h.lanesListHook) await h.lanesListHook()
    return listed_(e)
  })
  const listed_ = (e: any) => ({ value: e.path === '/Users/x/.claude/hooks' ? h.hooksList.map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: true })) : isPromptPath(e.path) ? promptList(e.path) : e.path === `${ROOT}/leads` ? [...leadFiles.entries()].map(([k, f]) => ({ name: k.slice(ROOT.length + 7), kind: 'file', size: 1, mtimeMs: (f.mtimeSec ?? Math.floor(h.nowMs / 1000)) * 1000, isLink: false })) : e.path === `${ROOT}/result` ? h.resultList : e.path === `${ROOT}/cue` ? h.cueList : e.path === `${ROOT}/open` ? h.openList : e.path === OFFERS_DIR ? [...pfs.entries()].filter(([k]) => k.startsWith(`${OFFERS_DIR}/`)).map(([k, f]) => ({ name: k.slice(OFFERS_DIR.length + 1), kind: 'file', size: f.text.length, mtimeMs: (f.mtimeSec ?? Math.floor(h.nowMs / 1000)) * 1000, isLink: false })) : e.path === `${ROOT}/log` ? h.logList : e.path === LANESDIR ? [...storeFiles.keys()].map((k) => ({ name: k.slice(LANESDIR.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) : e.path === SESSIONS ? Object.keys(regFiles()).map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) : [] })
  on('process.run', function procRun(_: any, e: any): any {
    if (over()) return { value: { exitCode: 1, stdout: '', stderr: 'test over', isStdoutTruncated: false, isStderrTruncated: false } }
    argvSeen.push([...e.argv])
    if (typeof e.init?.stdin === 'string') stdins.push(e.init.stdin)
    const a = [...e.argv]
    if (a[0] === '/bin/mv' && h.mvHook) h.mvHook(a[a.length - 1])
    const ok = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr: exitCode !== 0 && a[0] === '/usr/bin/stat' && stderr === '' ? `stat: ${a[a.length - 1]}: No such file or directory` : stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === '/usr/bin/id') return ok(a[1] === '-u' ? '501\n' : 'x\n')
    // A wait through a process: the test clock moves by the time asked, then the test's hook runs, as with the short polls of clock.sleep.
    if (a[0] === '/bin/sleep') {
      if (h.sleepFails) return ok('', 1, 'sleep: failed')
      // With the mock clock a sleep process takes the clock's time: it ends when the test advances past it, as a held clock.sleep does.
      if (clk) return new Promise((res) => sleepWaits.push({ due: h.nowMs + Math.round(Number(a[1]) * 1000), go: () => res(ok('')) }))
      if (!h.fastSleep) return new Promise(() => undefined)
      const ms = Math.round(Number(a[1]) * 1000)
      h.nowMs += ms
      return Promise.resolve(h.fastSleep(ms)).then(() => ok(''))
    }
    { const pf = promptFs(a, typeof e.init?.stdin === 'string' ? e.init.stdin : undefined, h.nowMs); if (pf !== undefined) return pf }
    if (h.leadsStatRejects && a[0] === '/usr/bin/stat' && a[a.length - 1] === `${ROOT}/leads`) return Promise.reject(new Error('stat'))
    if (a[0] === '/usr/bin/shasum' && h.shaHook && typeof e.init?.stdin === 'string' && e.init.stdin.startsWith('LABLANE\n')) {
      const hook = h.shaHook
      h.shaHook = undefined
      const held = hook()
      if (held instanceof Promise) return held.then(() => procRun(_, e))
    }
    if (a[0] === '/usr/bin/shasum' && h.shaFailsFor?.(typeof e.init?.stdin === 'string' ? e.init.stdin : '')) return ok('', 1)
    if (a[0] === '/usr/bin/shasum' && h.recShaFails && typeof e.init?.stdin === 'string' && e.init.stdin.startsWith('LABLANE\n')) return ok('', 1)
    if (a[0] === '/usr/bin/shasum') return ok(`${typeof e.init?.stdin === 'string' && (e.init.stdin.startsWith('LABLANE\n') || /^(ok|bad|absent)\n/.test(e.init.stdin) || e.init.stdin.includes('\nadopted\n')) ? fakeSha(e.init.stdin) : e.init?.stdin === '/Users/x/code/app2' ? 'b'.repeat(64) : e.init?.stdin === '/Users/x/code/cond' ? 'c'.repeat(64) : e.init?.stdin === '/data/x/work' ? 'd'.repeat(64) : 'a'.repeat(64)}  -\n`)
    if (a[0] === '/usr/bin/install') installed.add(a[a.length - 1])
    if (a[0] === '/usr/bin/tee' && a[1] === '--' && typeof e.init?.stdin === 'string') teeTexts.set(a[2], e.init.stdin)
    const last = a[a.length - 1]
    if (a[0] === '/bin/mkdir' && a[1] === '-p' && a[2] === '--' && /\/\.archive\/[^/]+$/.test(last)) {
      for (const d of [last.slice(0, last.lastIndexOf('/')), last]) if (!extraStat.has(d)) extraStat.set(d, h.archiveMade)
      return ok('')
    }
    if (a[0] === '/usr/bin/stat' && h.briefTmpStat !== undefined && /\/\.BRIEF\.md\.\d+\.\d+\.tmp$/.test(last)) return ok(h.briefTmpStat)
    // The conductor list file and its .claude folder.
    if (a[0] === '/bin/mkdir' && a[1] === '-m' && last.endsWith('/.claude')) {
      if (!extraStat.has(last)) extraStat.set(last, '501 755 2 Directory 8 64 1700000000\n')
      return ok('')
    }
    if (a[0] === '/usr/bin/tee' && /\/\.claude\/\.callboard-conductor\.json\.\d+\.\d+\.tmp$/.test(last)) {
      const hook = h.condWriteHook
      h.condWriteHook = undefined
      hook?.(last)
      return ok('')
    }
    if (a[0] === '/bin/mv' && a[1] === '-f' && a[4]?.endsWith('/.claude/callboard-conductor.json') && teeTexts.has(a[3])) {
      condFiles.set(a[4], teeTexts.get(a[3])!)
      condStat.delete(a[4])
      return ok('')
    }
    if (a[0] === '/usr/bin/stat' && condFiles.has(last)) return ok(condStat.get(last) ?? `501 644 1 Regular File 19 ${condFiles.get(last)!.length} 1700000000\n`)
    // The live checkout's HEAD, read with a bound at session start.
    if (a[0] === '/usr/bin/head' && a[1] === '-c' && a[2] === '257' && a[3] === '--' && /\/\.git\/HEAD$/.test(last)) {
      h.liveHeadReads++
      h.liveHeadAsked = { path: last, bytes: a[2] }
      return h.liveHead === undefined ? ok('', 1, `head: ${last}: No such file or directory`) : ok(h.liveHead.slice(0, Number(a[2])))
    }
    if (a[0] === '/usr/bin/head' && condFiles.has(last)) {
      h.condHeads++
      return ok(condFiles.get(last)!)
    }
    // An existing BRIEF.md is read only up to the byte count asked for (head -c N).
    if (a[0] === '/usr/bin/head' && a[1] === '-c' && last.endsWith('/BRIEF.md') && briefFiles.has(last)) return ok(briefFiles.get(last)!.slice(0, Number(a[2])), h.briefHeadExit)
    if (a[0] === '/bin/mv' && a[1] === '-f' && a[4]?.endsWith('/BRIEF.md') && teeTexts.has(a[3])) {
      if (h.briefMvFails) return ok('', 1, 'mv: rename failed')
      briefFiles.set(a[4], teeTexts.get(a[3])!)
      extraStat.set(a[4], `501 600 1 Regular File 9 ${new TextEncoder().encode(teeTexts.get(a[3])!).length} 1700000000\n`)
      return ok('')
    }
    const GATERE = /\/\.[0-9a-f]{64}\.lock\.break$/
    const STALEDIR = /\.lock\.stale\.[0-9.]+$/
    const STALEOWN = /\.lock\.stale\.[0-9.]+\/owner$/
    if (a[0] === '/bin/mkdir' && !a.includes('-p') && LOCKRE.test(last)) {
      lockLog.push('mkdir')
      h.lockMkdirEnv = e.init?.env
      h.lockHook?.('mkdir')
      if (h.lockMkdirErr !== undefined) return ok('', 1, h.lockMkdirErr)
      if (h.lockState.held) return ok('', 1, `mkdir: ${last}: File exists`)
      h.lockState = { held: true, mtimeSec: Math.floor(h.nowMs / 1000), ino: 14 }
      return ok('')
    }
    if (a[0] === '/bin/mkdir' && !a.includes('-p') && GATERE.test(last)) {
      lockLog.push('gate')
      if (h.gateHeld) return ok('', 1, `mkdir: ${last}: File exists`)
      h.gateHeld = { mtimeSec: Math.floor(h.nowMs / 1000) }
      return ok('')
    }
    if (a[0] === '/bin/rmdir' && GATERE.test(last)) {
      lockLog.push('gate-release')
      h.gateHeld = undefined
      return ok('')
    }
    if (a[0] === '/usr/bin/stat' && GATERE.test(last) && h.gateStatFails) {
      h.gateStatFails = false
      return ok('', 1)
    }
    if (a[0] === '/usr/bin/stat' && GATERE.test(last)) return h.gateHeld ? ok(`501 700 2 Directory ${h.gateHeld.ino ?? 18} 64 ${h.gateHeld.mtimeSec}\n`) : ok('', 1)
    if (a[0] === '/usr/bin/stat' && LOCKRE.test(last)) return h.lockState.held ? ok(`501 700 2 Directory ${h.lockState.ino ?? 14} 64 ${h.lockState.mtimeSec ?? T0 / 1000}\n`) : ok('', 1)
    if (a[0] === '/usr/bin/stat' && last.endsWith('.lock/owner')) h.lockHook?.('owner-stat')
    if (a[0] === '/usr/bin/stat' && last.endsWith('.lock/owner')) return h.lockState.owner !== undefined ? ok(`501 600 1 Regular File 15 ${h.lockState.owner.length} ${h.lockState.mtimeSec ?? T0 / 1000}\n`) : ok('', 1)
    if (a[0] === '/usr/bin/stat' && STALEDIR.test(last)) return movedLocks.has(last) ? ok(`501 700 2 Directory ${movedLocks.get(last)!.ino} 64 ${T0 / 1000}\n`) : ok('', 1)
    if (a[0] === '/usr/bin/stat' && STALEOWN.test(last)) return movedLocks.get(last.slice(0, -6))?.owner !== undefined ? ok(`501 600 1 Regular File 15 ${movedLocks.get(last.slice(0, -6))!.owner!.length} ${T0 / 1000}\n`) : ok('', 1)
    if (a[0] === '/usr/bin/head' && last.endsWith('.lock/owner')) return ok(lockOwnerReads.length > 0 ? (lockOwnerReads.shift() ?? '') : (h.lockState.owner ?? ''))
    if (a[0] === '/usr/bin/head' && STALEOWN.test(last)) return ok(movedLocks.get(last.slice(0, -6))?.owner ?? '')
    if (a[0] === '/usr/bin/install' && last.endsWith('.lock/owner')) {
      lockLog.push('owner-file')
      if (h.lockState.held) h.lockState.owner = ''
      return ok('')
    }
    if (a[0] === '/usr/bin/tee' && last.endsWith('.lock/owner')) {
      lockLog.push('owner-write')
      if (h.lockOwnerFails) return ok('', 1)
      h.lockState.owner = h.lockOwnerWritten ?? e.init?.stdin
      return ok('')
    }
    if (a[0] === '/bin/rm' && a[1] === '-f' && last.endsWith('.lock/owner')) {
      if (h.lockRmThrows) return Promise.reject(new Error('boom'))
      lockLog.push('rm-owner')
      h.lockState.owner = undefined
      return ok('')
    }
    if (a[0] === '/bin/rmdir' && LOCKRE.test(last)) {
      lockLog.push('rmdir')
      if (h.lockState.owner !== undefined) return ok('', 1, `rmdir: ${last}: Directory not empty`)
      h.lockState = { held: false }
      return ok('')
    }
    if (a[0] === '/bin/mv' && a[1] === '-n' && LOCKRE.test(a[3] ?? '')) {
      lockLog.push('break')
      movedLocks.set(a[4], { owner: h.lockOwnerAfterMove ?? h.lockState.owner, ino: h.lockOwnerAfterMoveIno ?? h.lockState.ino ?? 14 })
      h.lockState = h.lockRehold !== undefined ? { held: true, owner: h.lockRehold, mtimeSec: Math.floor(h.nowMs / 1000), ino: 15 } : { held: false }
      h.lockHook?.('break')
      return ok('')
    }
    if (a[0] === '/bin/mv' && a[1] === '-n' && LOCKRE.test(a[4] ?? '')) {
      lockLog.push('put-back')
      h.lockState = { held: true, owner: movedLocks.get(a[3])?.owner, mtimeSec: Math.floor(h.nowMs / 1000), ino: movedLocks.get(a[3])?.ino }
      movedLocks.delete(a[3])
      return ok('')
    }
    if (a[0] === '/bin/rm' && a[1] === '-f' && STALEOWN.test(last)) {
      lockLog.push('rm-stale-owner')
      const m = movedLocks.get(last.slice(0, -6))
      if (m) m.owner = undefined
      return ok('')
    }
    if (a[0] === '/bin/rmdir' && STALEDIR.test(last)) {
      lockLog.push('rm-stale')
      if (movedLocks.get(last)?.owner !== undefined) return ok('', 1)
      movedLocks.delete(last)
      return ok('')
    }
    const rd = regDirOf(last)
    if (a[0] === '/usr/bin/stat' && rd && rd.files[rd.name] !== undefined) {
      const rf = regFacts.get(rd.name)
      return ok(`${rf?.uid ?? 501} ${rf?.mode ?? '644'} ${rf?.nlink ?? 1} ${rf?.kind ?? 'Regular File'} 40 ${(rf?.size ?? rd.files[rd.name].length) + (rf?.bump ? ((rf.bump = false), 1) : 0)} ${T0 / 1000}\n`)
    }
    if (a[0] === '/usr/bin/head' && rd) {
      const rf = regFacts.get(rd.name)
      if (rf?.flaky) {
        rf.flaky--
        rf.bump = true
      }
      if (rf?.failHead) {
        rf.failHead--
        return ok('', 1)
      }
    }
    if (a[0] === '/usr/bin/head' && rd && rd.files[rd.name] !== undefined) return ok(rd.files[rd.name])
    if (a[0] === '/bin/mv' && a[1] === '-f' && a[4]?.startsWith(`${ROOT}/leads/`) && teeTexts.has(a[3])) {
      const put = () => {
        leadFiles.set(a[4], { text: teeTexts.get(a[3])!, mtimeSec: Math.floor(h.nowMs / 1000) })
        return ok('')
      }
      return h.leadMvDelayMs > 0 ? new Promise((r) => setTimeout(() => r(put()), h.leadMvDelayMs)) : put()
    }
    if (a[0] === '/bin/rm' && a[1] === '-f' && last.startsWith(`${ROOT}/leads/`)) {
      leadFiles.delete(last)
      return ok('')
    }
    if (leadFiles.has(last)) {
      const f = leadFiles.get(last)!
      if (a[0] === '/usr/bin/stat') return ok(`${f.uid ?? 501} ${f.mode ?? '600'} ${f.nlink ?? 1} ${f.kind ?? 'Regular File'} 31 ${f.size ?? f.text.length} ${f.mtimeSec ?? Math.floor(h.nowMs / 1000)}\n`)
      if (a[0] === '/usr/bin/head') {
        // A read that fails, failHead times.
        if ((f.failHead ?? 0) > 0) {
          f.failHead!--
          return ok('', 1)
        }
        const out = ok(f.text)
        if (f.swap) {
          f.size = (f.size ?? f.text.length) + 1
          if (f.swap === 'once') f.swap = false
        }
        return out
      }
    }
    // The registry filter's confirm of absent pids: `ps -o pid=,lstart= -p a,b`. It lists each asked pid that is still in the table (psStartsGone leaves it out),
    // or psConfirmOut; like BSD ps, a query that matches nothing exits 1 with no output.
    if (a[0] === '/bin/ps' && a.includes('pid=,lstart=') && a.includes('-p')) {
      psConfirmCalls.push(last)
      // As macOS ps: one pid it cannot take refuses the whole query, with a message and no rows.
      const tooBig = last.split(',').find((x) => Number(x) > 99999)
      if (tooBig) return ok('', 1, `ps: process id too large: ${tooBig}`)
      if (h.psConfirmFails === 'throw') throw new Error('spawn failed')
      if (h.psConfirmFails === 'exit') return ok('', 2)
      if (h.psConfirmFails === 'stderr') return ok('', 1, 'ps: process id too large: 100000')
      if (h.psConfirmOut !== undefined) return ok(h.psConfirmOut, h.psConfirmOut === '' ? 1 : 0)
      const rows: string[] = []
      for (const pid of last.split(',')) {
        if (psStartsGone.has(pid) || !regFiles()[`${pid}.json`]) continue
        let at: unknown
        try {
          at = JSON.parse(regFiles()[`${pid}.json`])?.procStart
        } catch {}
        rows.push(`${pid.padStart(5)} ${psStartsAt.get(pid) ?? (typeof at === 'string' && at.trim() !== '' ? at : 'Tue Oct 27 20:37:50 2026')}`)
      }
      return rows.length === 0 ? ok('', 1) : ok(rows.join('\n') + '\n')
    }
    if (a[0] === '/bin/ps' && psDead.has(last)) return ok('', 1)
    if (a[0] === '/bin/ps' && psFail.has(last)) return ok('', 2)
    if (a[0] === '/bin/mv' && a[1] === '-f' && a[4]?.startsWith(`${LANESDIR}/`) && teeTexts.has(a[3])) {
      if (h.storeHang) return h.storeHang.then(() => ok(''))
      const put = () => {
        h.storeWriteHook?.()
        if (h.storeWrites === 'fail') return ok('', 1)
        if (h.storeWrites === 'ok') storeFiles.set(a[4], teeTexts.get(a[3])!)
        return ok('')
      }
      if (h.storeMvDelayMs > 0 || h.storeAfterMs > 0)
        return new Promise((r) =>
          setTimeout(() => {
            const v = put()
            if (h.storeAfterMs > 0) setTimeout(() => r(v), h.storeAfterMs)
            else r(v)
          }, h.storeMvDelayMs),
        )
      return put()
    }
    if (a[0] === '/bin/mv' && a[1] === '-f' && a[4]?.startsWith(`${ROOT}/result/`) && teeTexts.has(a[3])) {
      resultFiles.set(a[4], teeTexts.get(a[3])!)
      h.compactedAtAnswer = seen.compacted
      return ok('')
    }
    if (a[0] === '/bin/mv' && a[1] === '-f' && a[4]?.startsWith(`${ROOT}/cue/`) && h.autoAnswer !== undefined && teeTexts.has(a[3])) {
      const verb = teeTexts.get(a[3])!.split(/[ \n]/)[0]
      resultFiles.set(`${ROOT}/result/${a[4].slice(ROOT.length + 5, -4)}.result`, `${verb} ${h.autoAnswer} ${h.autoIno}\n`)
      h.cueWriteHook?.()
      return ok('')
    }
    if (resultFiles.has(a[a.length - 1])) {
      const path = a[a.length - 1]
      if (a[0] === '/usr/bin/stat') return ok(h.resultStat ?? `501 600 1 Regular File ${h.resultIno} ${resultFiles.get(path)!.length} ${T0 / 1000}\n`)
      if (a[0] === '/usr/bin/head') {
        const text = resultFiles.get(path)!
        // The file is replaced while it is being read: the next stat sees another inode and the new text.
        if (h.resultSwap !== undefined) {
          resultFiles.set(path, h.resultSwap)
          h.resultIno++
          h.resultSwap = undefined
        }
        return ok(text)
      }
      if (a[0] === '/bin/rm') {
        resultFiles.delete(path)
        return ok('')
      }
    }
    if (a[0] === '/usr/bin/head' && storeFiles.has(a[a.length - 1])) return ok(h.lockState.held && storeReads.length > 0 ? storeReads.shift()! : storeFiles.get(a[a.length - 1])!)
    if (a[0] === '/usr/bin/stat' && statErr.has(last)) return ok('', 1, statErr.get(last)!)
    if (a[0] === '/usr/bin/stat' && storeFiles.has(a[a.length - 1])) return ok(h.storeStatOverride ?? `501 600 1 Regular File 77 ${storeFiles.get(a[a.length - 1])!.length} 1700000000\n`)
    if (a[0] === '/usr/bin/stat' && extraStat.has(a[a.length - 1])) return ok(extraStat.get(a[a.length - 1])!)
    if (a[0] === '/usr/bin/head' && gitFiles.has(last)) return ok(gitFiles.get(last)!)
    // A `.git` folder (or a link to one: stat follows it below the link) set in extraStat holds a plain HEAD, unless the test says otherwise (gitNoHead) or sets the HEAD itself.
    if (a[0] === '/usr/bin/stat' && last.endsWith('/.git/HEAD') && / (Directory|Symbolic Link) /.test(extraStat.get(last.slice(0, -5)) ?? '') && !gitNoHead.has(last.slice(0, -5))) return ok('501 644 1 Regular File 7 23 1700000000\n')
    if (h.openResult !== undefined && a[0] === '/usr/bin/stat' && a[a.length - 1] === (h.openResultPath ?? OPEN_RESULT)) return ok(`501 600 1 Regular File 66 ${h.openResult.length} ${T0 / 1000}\n`)
    if (h.openResult !== undefined && a[0] === '/usr/bin/head' && a[a.length - 1] === (h.openResultPath ?? OPEN_RESULT)) return ok(h.openResult)
    if (h.openResult !== undefined && a[0] === '/bin/rm' && a[a.length - 1] === (h.openResultPath ?? OPEN_RESULT)) {
      h.openResult = undefined
      return ok('')
    }
    if (a[0] === '/bin/realpath' && (realFails.get(last)?.n ?? 0) > 0) {
      const f = realFails.get(last)!
      f.n--
      return ok('', 1, f.err)
    }
    if (a[0] === '/bin/realpath' && h.realHook) {
      const held = h.realHook(a[a.length - 1])
      if (held) return held.then(() => ok(`${realMap.get(a[a.length - 1]) ?? a[a.length - 1]}\n`))
    }
    if (a[0] === '/bin/realpath') return ok(`${realMap.get(a[a.length - 1]) ?? a[a.length - 1]}\n`)
    if (a[0] === '/bin/kill' && h.killFails) return ok('', 1, 'kill: no such process')
    if (a[0] === '/bin/kill') killedPids.add(a[a.length - 1])
    if (a[0] === '/bin/ps' && a.includes('lstart=') && a.includes('-p') && h.psFailsAfterKill && killedPids.has(a[a.length - 1])) return ok('', 2, 'ps: failed')
    if (a[0] === '/bin/ps' && a.includes('lstart=') && a.includes('-p') && !h.survivesKill && killedPids.has(a[a.length - 1])) return ok('', 1, '')
    if (a[0] === '/bin/ps' && a.includes('pid=,lstart=')) {
      psStartsCalls.push(`${e.init?.env?.TZ}|${e.init?.env?.LC_ALL}|${Object.keys(regFiles()).sort().join(',')}`)
      if (h.psStartsFails === 'throw') throw new Error('spawn failed')
      if (h.psStartsFails === 'exit') return ok('', 1)
      if (h.psStartsOut !== undefined) return ok(h.psStartsOut)
      const rows = ['    1 Thu Jan  1 00:00:00 1970']
      for (const [n, t] of Object.entries(regFiles())) {
        const pid = n.slice(0, -5)
        if (!/^\d+$/.test(pid) || psStartsGone.has(pid)) continue
        let at: unknown
        try {
          at = JSON.parse(t)?.procStart
        } catch {}
        rows.push(`${pid.padStart(5)} ${psStartsAt.get(pid) ?? (typeof at === 'string' && at.trim() !== '' ? at : 'Tue Oct 27 20:37:50 2026')}`)
      }
      return ok(rows.join('\n') + '\n')
    }
    if (a[0] === '/bin/ps' && a.includes('-A')) {
      psCalls.push(a.slice(1).join(' '))
      if (h.psOversize) return ok('x'.repeat(2_000_001))
      // pid ppid comm, as `-o pid=,ppid=,comm=` prints them (comm: the executable, without arguments).
      const rows3 = h.psTable.split('\n').flatMap((l) => (/^\s*(\d+)\s+(\d+)(\s|$)/.exec(l) ? [l.trim().split(/\s+/).slice(0, 3).join(' ')] : []))
      return ok(rows3.join('\n') + '\n', h.psTableFails ? 1 : 0)
    }
    if (a[0] === '/bin/ps' && a.includes('pid=,ppid=,command=')) {
      psCalls.push(a.slice(1).join(' '))
      const want = new Set(a[a.length - 1].split(','))
      // A `ps` row has ended by now, as the real one has; like BSD ps, a query that matches nothing exits 1.
      const rows = h.psTable.split('\n').filter((l) => want.has(l.trim().split(/\s+/)[0]) && !/^\S*\/?ps$/.test(l.trim().split(/\s+/)[2] ?? ''))
      return ok(rows.join('\n') + '\n', h.psRowsFail || rows.length === 0 ? 1 : 0)
    }
    if (a[0] === '/bin/ps' && a.includes('lstart=')) h.psEnv = e.init?.env
    if (a[0] === '/bin/ps' && a.includes('args=') && h.psArgsHook) {
      const hook = h.psArgsHook
      h.psArgsHook = undefined
      return Promise.resolve(hook()).then(() => ok(h.psArgsOut))
    }
    if (a[0] === '/bin/ps') return ok(a.includes('args=') ? h.psArgsOut : h.psOut)
    if (h.reportStatErr && a[0] === '/usr/bin/stat' && a[a.length - 1] === h.reportAt) return ok('', 1, h.reportStatErr)
    if (h.reportFile && a[0] === '/usr/bin/stat' && a[a.length - 1] === h.reportAt) return ok(`501 600 1 Regular File 55 ${h.reportFile.text.length} ${h.reportFile.mtimeSec}\n`)
    const CUEDIR = '/Users/x/.claude/callboard/cue'
    if (h.takenPlanted && a[0] === '/usr/bin/stat' && a[a.length - 1].startsWith(`${CUEDIR}/${SID}.`) && a[a.length - 1].endsWith('.taken')) return ok(`501 600 1 Regular File 77 7 ${T0 / 1000}\n`)
    if (h.cueFile && a[0] === '/bin/mv' && a[1] === '-n') {
      // A cue (but the birth rename) comes from a lead that is live in the repo every seeded lane sits in: with no presence file in the test, one is added when
      // the cue is claimed (h.cueLead = false: a test of a cue with no live lead).
      if (h.cueLead && !h.cueFile.text.startsWith('rename') && (leadFiles.size === 0 || h.cueLeadAdded)) {
        const LEAD = { sessionId: '5a1b2c3d-0000-4000-8000-123456789abc', pid: 4242, procStart: 'Tue Oct 27 20:37:50 2026' }
        // The repo of the first lane store the test seeded.
        const repo = (JSON.parse([...storeFiles.values()][0] ?? '{}').repo as string | undefined) ?? '/data/x/work'
        h.extraSessions = { '4242.json': JSON.stringify({ ...LEAD, name: 'LEAD', cwd: repo, status: 'idle', startedAt: T0 - 3_600_000, statusUpdatedAt: T0 - 60_000 }) }
        leadFiles.set(`${ROOT}/leads/${LEAD.sessionId}.json`, { text: JSON.stringify({ sid: LEAD.sessionId, pid: LEAD.pid, procStart: LEAD.procStart, repo }), mtimeSec: Math.floor(h.nowMs / 1000) - 5 })
        h.cueLeadAdded = true
      }
      if (h.claimMvFails) return ok('', 1, 'mv: rename failed')
      if (h.takenPlanted) return ok('')
      if (h.cueFile.present && a[3] === `${CUEDIR}/${SID}.cue`) {
        if (h.cueSwapAtMv) h.cueFile = { ...h.cueFile, ...h.cueSwapAtMv }
        h.cueSwapAtMv = undefined
        h.takenFile = { ...h.cueFile }
        h.takenAs = a[4]
        if (h.cueNext) h.cueFile = { ...h.cueNext, present: true }
        else h.cueFile.present = false
        h.cueNext = undefined
      }
      return ok('')
    }
    if (h.reportFile && a[0] === '/usr/bin/head' && a[a.length - 1] === h.reportAt) {
      headArgs.push(a[2])
      return h.headFails ? ok('', 1) : ok(h.reportGrown ?? h.reportFile.text)
    }
    if (h.takenFile && a[0] === '/usr/bin/head' && a[a.length - 1] === h.takenAs) return ok(h.takenFile.text)
    if (h.cueFile && a[0] === '/bin/rm' && a[a.length - 1] === h.takenAs) {
      h.takenAs = undefined
      return ok('')
    }
    if (a[0] === '/usr/bin/stat' && h.cueFile) {
      const path = a[a.length - 1]
      const facts = (f: { ino: number; text: string; mode?: string; mtimeSec?: number }) => `501 ${f.mode ?? '600'} 1 Regular File ${f.ino} ${f.text.length} ${f.mtimeSec ?? T0 / 1000}\n`
      if (path === `${CUEDIR}/${SID}.cue`) return h.cueFile.present ? ok(facts(h.cueFile)) : ok('', 1)
      if (h.takenAs && h.takenFile && path === h.takenAs) return ok(facts(h.takenFile))
    }
    if (a[0] === '/usr/bin/stat') {
      const path = a[a.length - 1]
      if (path === SESSIONS && !h.sessionsUnsafe) return ok('501 700 2 Directory 13 64 1700000000\n')
      if (path.endsWith('/callboard') || path.endsWith('/lanes') || path.endsWith('/log') || path.endsWith('/cue') || path.endsWith('/open') || path.endsWith('/result') || path.endsWith('/leads')) return ok('501 700 2 Directory 11 64 1700000000\n')
      if (installed.has(path)) return ok('501 600 1 Regular File 12 0 1700000000\n')
      return ok('', 1)
    }
    return ok('')
  })
}
