import * as prm from '../hooks/prompts'
import { h, PROMPTS_DIR, ROOT, SID, T0, extraStat, leadFiles, pdirs, pfs } from './harness'
import { APISID, APP2, COND, LEADPATH, LEADPS, LEADSID, PIN, SVC, attacher, condOn, condPresenceOf, dirStat, doLane, lead, leadAt, leadFileText, leadReg, leadSelfReg, ownReg, putCond, regAs } from './fixtures'

// ---- ADR 0004 prompt answering: the hook, the files and the switch ----
// A lane under a live lead (the attach helpers), the switch on for all, an ask rule beneath, and the engine's PermissionRequest chain beneath returning {}.
export const PRQ = { command: 'ssh host uptime' }
export const PDIR = `${PROMPTS_DIR}/${SID}`
export const reqFiles = () => [...pfs.keys()].filter((k) => k.endsWith('.request.json'))
export const readReq = () => JSON.parse(pfs.get(reqFiles()[0])!.text)
export const ledgerRows = (): any[] => [...pfs.entries()].filter(([k]) => /\/ledger-\d{4}-\d{2}\.jsonl$/.test(k)).flatMap(([, v]) => v.text.split('\n').filter(Boolean).map((l) => JSON.parse(l)))
export const rowKinds = () => ledgerRows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)
export const LEDGER_FILE = `${PROMPTS_DIR}/ledger-2023-11.jsonl`
export const waitingRow = (at = T0) => ({ ...leadReg(), ...h.extraRows, ...ownReg({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: at }) })
export type Ans = { switchOn?: boolean; verdict?: any; beneath?: ($: any) => any; argv?: string[][]; clock?: boolean; asLead?: boolean; scope?: string; asksScope?: string; asksOld?: boolean }
export async function answerer($: any, on: any, stdins: string[], opts: Ans = {}) {
  h.extraRows = {}
  h.prVerdict = opts.verdict ?? { decision: 'ask', rule: 'Bash(ssh:*)' }
  h.prBeneath = opts.beneath
  h.prBeneathCalls = 0
  h.prSetup = true
  for (const ev of ['classic.PostToolUse', 'classic.PostToolUseFailure', 'classic.PermissionDenied'] as const) on(ev, () => ({}))
  on('tool.check', (_: any, e: any) => (h.prSetup ? { decision: 'allow' } : h.prVerdict))
  on('classic.PermissionRequest', ($2: any) => {
    h.prBeneathCalls++
    return h.prBeneath ? h.prBeneath($2) : {}
  })
  if (opts.asLead) await lead($, on, stdins, { argv: opts.argv, clock: opts.clock })
  else {
    await attacher($, on, stdins, { clock: opts.clock, argv: opts.argv })
    await doLane($, 'lane svc-api')
  }
  h.prSetup = false
  if (opts.switchOn !== false) h.store.set('answering', { scope: opts.scope ?? 'all', asks: opts.asksOld === true, ...(opts.asksScope !== undefined ? { asksScope: opts.asksScope } : {}), savedAt: T0 })
}
// A question's own ask is judged like any other once the lane is set up; the setup dialogs above must still pass.
export const askCheck = ($: any, over: Record<string, unknown> = {}) => $.tool.check({ tool: 'Bash', input: PRQ, tool_use_id: 'tu1', approver: 'person', ...over } as any)
export const startReq = ($: any, over: Record<string, unknown> = {}) => $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: PRQ, ...over } as any)
// A decision made by hand, the only kind the lane's own hook has: its answered row (appended to the ledger) and its file.
export function handDecision(req: any, over: Record<string, unknown> = {}, row: boolean | Record<string, unknown> = true) {
  const d = { id: req.id, inputHash: req.inputHash, decision: 'allow', why: 'ok', by: { level: 'lead', sid: LEADSID, name: 'LEAD' }, at: h.nowMs, nonce: req.nonce, ...over }
  if (row) {
    const l = pfs.get(LEDGER_FILE) ?? { text: '', mtimeSec: T0 / 1000 }
    pfs.set(LEDGER_FILE, { ...l, text: `${l.text}${JSON.stringify({ t: 'x', kind: 'answered', id: req.id, nonce: req.nonce, code: d.decision, by: d.by.sid, ...((d as any).answer ? { opt: String((d as any).answer.index), lh: 'a'.repeat(16) } : {}), ...(row === true ? {} : row) })}\n` })
  }
  pfs.set(`${PDIR}/${req.id}.decision.json`, { text: JSON.stringify(d), mtimeSec: h.nowMs / 1000 })
}
export const driveClock = () => {
  h.clockHooks = []
  h.fastSleep = async () => {
    for (const hook of h.clockHooks) await hook(h.nowMs - T0)
  }
}
// An act that runs once, at the first poll at or after `t` ms into the test.
export const at = (t: number, f: () => void | Promise<void>) => {
  let done = false
  return async (rel: number) => {
    if (rel >= t && !done) {
      done = true
      await f()
    }
  }
}
export const OFF_FILE = `${PROMPTS_DIR}/OFF`
export const stop = (t = 40_000) => at(t, () => { pfs.set(OFF_FILE, { text: '', mtimeSec: h.nowMs / 1000 }) })
// One request to its end: the ask, the dialog's registry row, then the polls with the acts.
export async function runRequest($: any, acts: ((rel: number) => void | Promise<void>)[], over: Record<string, unknown> = {}, check: Record<string, unknown> = {}) {
  await askCheck($, check)
  h.sessions = waitingRow(T0 + 500)
  driveClock()
  h.clockHooks.push(...acts)
  return startReq($, over)
}
export const noFiles = () => [...pfs.keys()].filter((k) => k.startsWith(PDIR)).length === 0
export const callOf = (tool: string, input: unknown) => ({ check: { tool, input }, over: { tool_name: tool, tool_input: input } })

// ---- the sweep ----
export const GONE = '7a1b2c3d-0000-4000-8000-123456789abc'

// ---- ADR 0004 prompt answering: the lead tier (prompt_list, prompt_answer, prompt_escalate), the notice and the cap ----
// The current session is a lead pinned at PIN (leadAt); the lane is another session in SVC, whose request files are made by hand (the hook is the lane's own).
export const LANESID = '6a1b2c3d-0000-4000-8000-123456789abc'
export const TID = '7a1b2c3d-0000-4000-8000-123456789abc'
export const TID2 = '8a1b2c3d-0000-4000-8000-123456789abc'
export const THASH = 'c'.repeat(64)
export const LDIR = (sid = LANESID) => `${PROMPTS_DIR}/${sid}`
const laneRow = (over: Record<string, unknown> = {}) => ({ '4300.json': JSON.stringify({ sessionId: LANESID, name: 'svc-api', nameSource: 'user', cwd: SVC, status: 'waiting', waitingFor: 'permission prompt', pid: 4300, procStart: LEADPS, startedAt: T0 - 3_600_000, statusUpdatedAt: T0, kind: 'interactive', ...over }) })
export const tierSessions = (lead: Record<string, unknown> = {}, laneOver: Record<string, unknown> | null = {}) => (h.sessions = { ...leadSelfReg(lead), ...(laneOver === null ? {} : laneRow(laneOver)) })
const reqQ = (over: Record<string, unknown> = {}) => ({ id: TID, sid: LANESID, pid: 4300, procStart: LEADPS, level: 'lane', lane: 'svc-api', leadName: 'LEAD', repo: SVC, tool: 'Bash', inputHash: THASH, raisedBy: 'rule', at: T0, expiresAt: T0 + 21 * 60_000, nonce: 'n-1', input: { command: 'ssh host uptime' }, truncated: false, ...over }) as any
export function putQ(over: Record<string, unknown> = {}) {
  const q = reqQ(over)
  pdirs.add(PROMPTS_DIR)
  pdirs.add(LDIR(q.sid))
  pfs.set(`${LDIR(q.sid)}/${q.id}.request.json`, { text: JSON.stringify(q), mtimeSec: T0 / 1000 })
  return q
}
export const putFile = (name: string, text = '', sid = LANESID) => pfs.set(`${LDIR(sid)}/${name}`, { text, mtimeSec: T0 / 1000 })
export async function tier($: any, on: any, stdins: string[] = [], opts: { clock?: boolean; off?: boolean; scope?: string; argv?: string[][]; asksScope?: string } = {}) {
  await leadAt($, on, stdins, { clock: opts.clock, sess: tierSessions(), argv: opts.argv })
  tierSessions()
  if (opts.off !== true) h.store.set('answering', { scope: opts.scope ?? 'all', asks: false, ...(opts.asksScope !== undefined ? { asksScope: opts.asksScope } : {}), savedAt: T0 })
}
export const pcall = (tool: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ tool: `mcp__callboard__${tool}`, ...input, ...extra }) as any
export const answerCall = (over: Record<string, unknown> = {}) => pcall('prompt_answer', { id: TID, decision: 'allow', why: 'read only, seen whole', ...over })
export const said = (r: any): string => String(r?.result ?? r?.deny ?? JSON.stringify(r))
export const refusal = (code: string): string => prm.PROMPT_REFUSE[code]
export const decFile = (id = TID) => pfs.get(`${LDIR()}/${id}.decision.json`)
export const answered = () => ledgerRows().filter((r) => r.kind === 'answered')
export const PCOMMENT = { owner: 'acme', repo: 'app', issue_number: 7, body: '@claude review --comments' }
export const retRow = (o: Record<string, unknown> = {}) => ({ t: 'x', kind: 'returned', code: 'allow', cap: 'comments', target: 'acme/app#7', tier: 'lead', ...o })
export const putLedger = (rows: unknown[], file = LEDGER_FILE) => {
  const l = pfs.get(file) ?? { text: '', mtimeSec: T0 / 1000 }
  pfs.set(file, { ...l, text: l.text + rows.map((r) => `${JSON.stringify(r)}\n`).join('') })
}
// The rows the hook wrote, not the ones a test seeded.
export const hookRows = () => ledgerRows().filter((x) => x.t !== 'x')
export const hookKinds = () => hookRows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)

const RELAYBODY = (req: any, over: Record<string, unknown> = {}) => JSON.stringify({ id: req.id, short: req.id.slice(0, 8), by: { level: 'lead', sid: LEADSID, name: 'LEAD' }, at: h.nowMs, nonce: req.nonce, ...over })
export const putRelay = (req: any, over: Record<string, unknown> = {}) => pfs.set(`${PDIR}/${req.id}.relay.json`, { text: RELAYBODY(req, over), mtimeSec: h.nowMs / 1000 })

export const LEAD2 = '4b1b2c3d-0000-4000-8000-123456789abc'

// ---- ADR 0004 prompt answering: the conductor and manager tiers, the pass-up chain, the person relay ----
export const MGRT = '9b1b2c3d-0000-4000-8000-123456789abc'
export const CNDT = '9c1b2c3d-0000-4000-8000-123456789abc'
const MGRTPATH = `${ROOT}/leads/${MGRT}.json`
// A live manager (MGRT) and a live conductor (CNDT, listing PIN) as fixtures: presence file, registry row, and for the conductor its saved grant and list file.
export const addMgrT = (name = 'MANAGER') => {
  leadFiles.set(MGRTPATH, { text: JSON.stringify({ sid: MGRT, pid: 4243, procStart: LEADPS, level: 'manager', name }) })
  h.extraRows = { ...h.extraRows, ...regAs(MGRT, 4243, name) }
}
export const addCondT = (name = 'CONDX', repos: string[] = [PIN]) => {
  for (const r of [COND, PIN, APP2]) extraStat.set(`${r}/.git`, dirStat)
  putCond(['../app'])
  h.store.set(`conductor:${CNDT}`, { home: COND, repos, savedAt: T0 - 60_000 })
  condPresenceOf(CNDT, 4244, name, repos)
  h.extraRows = { ...h.extraRows, ...regAs(CNDT, 4244, name) }
}
export const byCond = { level: 'conductor', sid: CNDT, name: 'CONDX' }
export const byMgr = { level: 'manager', sid: MGRT, name: 'MANAGER' }
export const putFileAt = (name: string, text = '{}') => pfs.set(`${PDIR}/${name}`, { text, mtimeSec: h.nowMs / 1000 })
export const decideBy = (by: Record<string, unknown>, over: Record<string, unknown> = {}) => handDecision(readReq(), { by, ...over }, { by: by.sid, ...(over.via ? { via: over.via } : {}) })

// ---- the tools of each tier (a lead with tiers above it; a conductor and the manager as callers) ----
export const SHORT = TID.slice(0, 8)
export const putRelayT = (by: Record<string, unknown> = { level: 'lead', sid: SID, name: 'LEAD' }, id = TID) => putFile(`${id}.relay.json`, JSON.stringify({ id, short: id.slice(0, 8), by, at: T0, nonce: 'n-1' }))

// A conductor as the caller: the lane API in PIN, the lead LEAD live or not.
export const APIQ = { sid: APISID, pid: 4500, lane: 'API', repo: `${PIN}/api` }
export const leadLive = () => {
  leadFiles.set(LEADPATH, { text: leadFileText() })
  h.sessions = { ...h.sessions, ...leadReg() }
}
export const asConductor = async ($: any, on: any, opts: { lead?: boolean; mgr?: boolean; clock?: boolean } = {}) => {
  await condOn($, on, [], { clock: opts.clock })
  h.store.set('answering', { scope: 'all', asks: false, savedAt: T0 })
  if (opts.lead) leadLive()
  if (opts.mgr) {
    addMgrT()
    h.sessions = { ...h.sessions, ...h.extraRows }
  }
}
export const relayQ = (id: string, text = `Lane svc-api wants to run ssh. Risk: none. Allow?`, header = `Relay ${id.slice(0, 8)}`) => ({ header, question: `${text} (${id.slice(0, 4)})`, options: [{ label: 'Yes', description: 'a' }, { label: 'No', description: 'b' }], multiSelect: false })
export const askPost = (qs: ReturnType<typeof relayQ>[], answers: Record<string, string>, over: Record<string, unknown> = {}) => ({ tool_name: 'AskUserQuestion', tool_input: { questions: qs }, tool_response: { questions: qs, answers, annotations: {} }, tool_use_id: 'tuQ', ...over }) as any
export const beneathHooks = (on: any) => {
  for (const ev of ['classic.PostToolUse', 'classic.PostToolUseFailure', 'classic.PermissionDenied', 'classic.PermissionRequest'] as const) on(ev, () => ({}))
}
export const decOf = (id = TID) => JSON.parse(decFile(id)!.text)

// ---- ADR 0004 prompt answering: a lane's single-choice question, answered by a tier, and the question relay ----
export const QTEXT = 'Which port do I use?'
export const QIN = { questions: [{ question: QTEXT, header: 'Port', options: [{ label: '3000', description: 'dev' }, { label: ' 8080 ', description: 'alt' }], multiSelect: false }] }
export const QASK = { decision: 'ask' }
