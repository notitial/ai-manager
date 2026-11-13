// The answering tiers: which tier may answer a request, the tier tools (prompt_list, prompt_answer, prompt_escalate), the notices and the mid-turn notice.
// Trust rules held here: a tier answers only a request in its reach, and not one it passed up; a notice is not an approval.
import * as c from '../core.ts'
import * as pr from '../prompts.ts'
import {
  windowsSeen,
  promptTold,
  promptRelaySeen,
  promptNotices,
  promptCapLogged,
  dialogOpen,
  turnKind,
  promptMidSent,
  promptMidRetold,
  mem,
} from '../mem.ts'
import { sha, dirOk, readSmallR, statR, where, run, INSTALL, TEE, rmF, log, submitOwn, logq } from './base.ts'
import { registryEntries, idleCheck } from './store.ts'
import type { RegRow } from './store.ts'
import { leadsFor, conductorsReaching, managersLive, homeOf, grantOf } from './grants.ts'
import { leadBase, leadRun } from './lanes.ts'
import { ensureTimer } from './tick.ts'
import {
  ledgerAdd,
  PROMPT_DIRS_MAX,
  ANSWERING_KEY,
  promptsOff,
  promptNewId,
  ledgerRowsFor,
  promptFloorOpts,
  capOf,
  labelHash,
} from './answer-hook.ts'

// $.state keys declared again where they are used: `claude plugin validate` reads a key in the file that uses it.
const request = { plugin: 'callboard', key: 'request' } as const
const nudgeDueRef = { plugin: 'callboard', key: 'nudgeDue' } as const

const LN = '/bin/ln'

// Rows that make the ledger end on the stored value again, after the value was put back: no valid value is off; a valid one is its plain row, and the asks row when it carried
// a questions scope (the audit reads a question as covered only by that row).
export async function ledgerRestore($: any, before: unknown): Promise<boolean> {
  const a = pr.parseAnswering(before)
  if (!a) return ledgerAdd($, { kind: 'answering-off', code: 'off' })
  const hash = await sha($, pr.canonical(before)).catch(() => undefined)
  if (!(await ledgerAdd($, { kind: 'answering-on', hash }))) return false
  return a.asksScope === undefined || (await ledgerAdd($, { kind: 'answering-on', code: 'asks', hash }))
}

// ---- the prompt tools of every tier (prompt_list, prompt_answer, prompt_escalate) and the lead's notice ----
const PROMPT_REQUESTS_MAX = 64
const promptReason = (tool: string, why: string) => `${tool} refused: ${why}`
const promptRefuse = (code: string): string => pr.PROMPT_REFUSE[code] ?? code

type PromptFile = { dir: string; req: pr.Request; names: Set<string> }

// The request files in the prompts folders, parsed: a folder or file that is not ours (owner, mode, one link, size, shape, a name that does not match the
// request inside it) is skipped. At most PROMPT_REQUESTS_MAX, in folder order.
const PROMPT_SCAN_MAX = 256
async function promptRequests($: any, p: { uid: number; root: string }, accept?: (q: pr.Request, names: Set<string>, dir: string) => Promise<boolean>): Promise<PromptFile[]> {
  let scanned = 0
  const base = `${p.root}/prompts`
  const out: PromptFile[] = []
  if (!(await dirOk($, base, p.uid))) return out
  const dirs = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).map((d) => d.name).sort().slice(0, PROMPT_DIRS_MAX)
  for (const name of dirs) {
    if (out.length >= PROMPT_REQUESTS_MAX) break
    const dir = `${base}/${name}`
    const names = new Set(((await $.fs.list(dir).catch(() => [])) as { name: string }[]).map((f) => f.name))
    const ids = [...names].flatMap((n) => (/^[0-9a-f-]{36}\.request\.json$/.test(n) ? [n.slice(0, 36)] : []))
    if (ids.length === 0 || !(await dirOk($, dir, p.uid))) continue
    for (const id of ids) {
      if (out.length >= PROMPT_REQUESTS_MAX || scanned >= PROMPT_SCAN_MAX) break
      scanned++
      const r = await readSmallR($, `${dir}/${id}.request.json`, p.uid, pr.REQUEST_MAX)
      if (r.state !== 'ok') continue
      const q = pr.parseRequest(r.text)
      if (q && q.id === id && q.sid === name && (accept === undefined || (await accept(q, names, dir)))) out.push({ dir, req: q, names })
    }
  }
  return out
}

// The tiers a request reaches, lead first, then the conductors, then the manager: the asker must be a live row under the pid and start the request
// names; a lead is a live lead of the repo (narrowed to the lead the request names), a conductor one whose approved pins hold the request's folder, the manager a
// trusted one. The switch's scope applies to each. Nobody is the asker. noLead: the lane's own lead could not be resolved (its record names another, or none is
// found), so no lead is asked, whichever leads are live. Empty: nobody can be asked, and the prompt stays the person's.
type ReachQ = Pick<pr.Request, 'sid' | 'pid' | 'procStart' | 'level' | 'lane' | 'leadName' | 'repo' | 'tool'>
export async function promptReachTiers($: any, live: RegRow[], a: pr.Answering, q: ReachQ, noLead = false): Promise<pr.Tier[]> {
  if (!live.some((r) => r.j.sessionId === q.sid && String(r.j.pid) === r.pid && r.pid === String(q.pid) && r.j.procStart === q.procStart)) return []
  const rows = live.map((r) => r.j)
  const tiers: pr.Tier[] = []
  // A lead's own prompt starts at the conductor: no lead tier for it.
  if (q.level === 'lane' && !noLead) {
    for (const l of await leadsFor($, live, q.repo).catch(() => [] as c.LeadFile[])) {
      const name = c.leadNameOf(rows, l.sid) ?? ''
      if (l.sid === q.sid || (q.leadName !== undefined && (name === '' || q.leadName !== name))) continue
      if (pr.requestCovered(a, q, { lane: q.lane, lead: name === '' ? undefined : name })) tiers.push({ level: 'lead', sid: l.sid, name })
    }
  }
  if (pr.requestCovered(a, q, { lane: q.level === 'lane' ? q.lane : undefined, lead: q.leadName, self: q.level === 'lead' ? q.lane : undefined })) {
    for (const x of await conductorsReaching($, live, q.sid, (r) => r === q.repo || c.within(r, q.repo)).catch(() => [])) tiers.push({ level: 'conductor', sid: x.sid, name: x.name ?? '' })
    for (const m of await managersLive($, live, q.sid).catch(() => [])) if (m.unverified !== true && m.name !== undefined) tiers.push({ level: 'manager', sid: m.sid, name: m.name })
  }
  return tiers
}

// Where a request stands: who it reaches, who has passed it up (the files `<id>.escalate-<level>.json`, with the time of each), the relay if a tier put it to the
// person, which of the reached tiers can act now (not passed, and not asking: a tier whose own relay question is open is blocked in that turn, unless it is this
// request's relay), the top one of those, and when each one's window opens.
type Stand = { tiers: pr.Tier[]; active: pr.Tier[]; top?: pr.Tier; passed: Partial<Record<pr.TierLevel, number>>; relay?: pr.Relay; windows: Record<string, number> }
export async function promptStand($: any, p: { uid: number; root: string }, live: RegRow[], a: pr.Answering, dir: string, names: Set<string>, q: pr.Request): Promise<Stand> {
  const tiers = await promptReachTiers($, live, a, q, q.noLead === true)
  const passed: Partial<Record<pr.TierLevel, number>> = {}
  for (const l of pr.TIER_LEVELS) {
    const n = `escalate-${l}.json`
    if (!names.has(`${q.id}.${n}`)) continue
    const r = await readSmallR($, `${dir}/${q.id}.${n}`, p.uid, pr.DECISION_MAX)
    const at = r.state === 'ok' ? pr.parseEscalate(r.text)?.at : undefined
    passed[l] = typeof at === 'number' ? at : q.at
  }
  let relay: pr.Relay | undefined
  if (names.has(`${q.id}.relay.json`)) {
    const r = await readSmallR($, `${dir}/${q.id}.relay.json`, p.uid, pr.DECISION_MAX)
    const x = r.state === 'ok' ? pr.parseRelay(r.text) : undefined
    if (x && x.id === q.id && x.nonce === q.nonce) relay = x
  }
  const asking = new Set<string>()
  for (const t of tiers) if (t.sid !== relay?.by.sid && (await statR($, `${p.root}/prompts/asking/${t.sid}`)) !== 'absent') asking.add(t.sid)
  const active = tiers.filter((t) => passed[t.level] === undefined && !asking.has(t.sid))
  // The slots follow every live tier in reach, one that has passed the request up included: it is still there, so a tier above keeps its own slot (the manager's 10 minutes).
  const reps = pr.TIER_LEVELS.flatMap((l) => tiers.filter((t) => t.level === l).slice(0, 1))
  const opens = pr.tierWindows(q.at, reps, passed)
  // A tier's window never moves later for a request: a lower tier that goes live after the request would push the slots above it back, and a higher tier already
  // told to act would be refused with `window`. The earliest time computed for the tier stays (memory only; a reload starts over, the same as a fresh request).
  const seen = windowsSeen.get(q.id) ?? {}
  if (!windowsSeen.has(q.id) && windowsSeen.size >= WINDOWS_SEEN_MAX) windowsSeen.delete(windowsSeen.keys().next().value as string)
  windowsSeen.set(q.id, seen)
  const windows: Record<string, number> = {}
  for (const t of active) windows[t.sid] = seen[t.sid] = Math.min(seen[t.sid] ?? Infinity, opens[reps.find((r) => r.level === t.level)!.sid])
  return { tiers, active, top: pr.topOf(active), passed, relay, windows }
}
const WINDOWS_SEEN_MAX = 512

// Whether a tier's window for a request has not opened. The first tier's window is the 30-second minimum itself, which the hook holds a decision for; refusing an
// answer in it would only change what a lead sees, so only a later window refuses.
const promptWindowShut = (q: pr.Request, s: Stand, sid: string, now: number): boolean => s.windows[sid] !== undefined && s.windows[sid] > q.at + pr.MIN_AGE_MS && now < s.windows[sid]

// The tier's own context for the three tools: the lead steps every lead tool shares, the switch, the OFF file.
async function promptTierCtx($: any, e: unknown, sid: string) {
  const base = await leadBase($, e, sid)
  if ('err' in base) return base
  const p = await where($)
  if (!p) return { err: ['write-failed', pr.PROMPT_REFUSE['write-failed']] as const }
  const answering = pr.parseAnswering(await $.store.get(ANSWERING_KEY).catch(() => undefined))
  return { ...base, p, answering, off: await promptsOff($) }
}

// A request by id, with every refusal the answering tools share. Each refusal is a code of pr.PROMPT_REFUSE.
async function promptFind($: any, t: { p: { uid: number; root: string }; live: RegRow[]; answering: pr.Answering }, sid: string, id: string, allowDecided = false): Promise<{ file: PromptFile; stand: Stand; self: pr.Tier } | { no: string }> {
  const base = `${t.p.root}/prompts`
  if (!(await dirOk($, base, t.p.uid))) return { no: 'unknown-request' }
  const dirs = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).map((d) => d.name).sort().slice(0, PROMPT_DIRS_MAX)
  let found: { dir: string; names: Set<string>; q: pr.Request } | undefined
  for (const name of dirs) {
    const dir = `${base}/${name}`
    const names = new Set(((await $.fs.list(dir).catch(() => [])) as { name: string }[]).map((f) => f.name))
    if (!names.has(`${id}.request.json`) || !(await dirOk($, dir, t.p.uid))) continue
    const r = await readSmallR($, `${dir}/${id}.request.json`, t.p.uid, pr.REQUEST_MAX)
    const q = r.state === 'ok' ? pr.parseRequest(r.text) : undefined
    if (!q || q.id !== id || q.sid !== name) continue
    // Two folders holding a request with one id: the tier could judge one and answer the other, so neither is answered.
    if (found !== undefined) return { no: 'unknown-request' }
    found = { dir, names, q }
  }
  if (found === undefined) return { no: 'unknown-request' }
  const { dir, names, q } = found
  if (q.sid === sid) return { no: 'own-request' }
  const stand = await promptStand($, t.p, t.live, t.answering, dir, names, q)
  const self = stand.tiers.find((x) => x.sid === sid)
  if (!self) return { no: 'unknown-request' }
  if (names.has(`${id}.done`)) return { no: 'closed' }
  if (stand.passed[self.level] !== undefined) return { no: 'escalated' }
  if (stand.relay) return { no: 'with-person' }
  // A tier whose own question is open (and not this request's) cannot act; it could not call a tool at all, so this is only a stale view.
  if (!stand.active.some((x) => x.sid === sid)) return { no: 'unknown-request' }
  // A decision the hook has not yet dropped (it takes a dropped one away after its row) refuses a second answer; passing the request up is still open to the tier.
  if (!allowDecided && names.has(`${id}.decision.json`)) return { no: 'decided' }
  return { file: { dir, req: q, names }, stand, self }
}

// A file of ours, written whole beside its name and linked into place: `ln` fails when the target exists, so the first writer wins (mv -n gives no failure to
// rely on). 'exists': the target was there; 'failed': nothing was written.
export async function promptLinkOnce($: any, path: string, text: string): Promise<'ok' | 'exists' | 'failed'> {
  // Two leads of one repo are two processes writing in the asker's folder: the name carries digits drawn from a fresh uuid (the sweep's orphan pattern is
  // `<id>.<word>.<digits>.tmp`), so a counter that two processes share cannot make them write one file.
  let tmp = ''
  try {
    tmp = `${path}.${BigInt(`0x${(await promptNewId($)).replace(/-/g, '').slice(0, 16)}`).toString()}.tmp`
    if ((await run($, [INSTALL, '-m', '600', '/dev/null', tmp])).exitCode !== 0) return 'failed'
    if ((await run($, [TEE, '--', tmp], text)).exitCode !== 0) return 'failed'
    const l = await run($, [LN, '--', tmp, path])
    if (l.exitCode === 0) {
      // A target that was a folder, or a link to one, takes the link inside it and says nothing: only a plain file in place counts.
      const f = await statR($, path)
      return f !== 'absent' && f !== 'error' && f.kind === 'file' ? 'ok' : 'failed'
    }
    return (await statR($, path)) === 'absent' ? 'failed' : 'exists'
  } catch {
    return 'failed'
  } finally {
    if (tmp !== '') await rmF($, tmp)
  }
}

// Dropped decisions this month and last that look forged or stale (the codes the audit counts as anomalies): a cheap, ledger-only number for prompt_list.
async function promptAnomalyHint($: any, p: { uid: number; root: string }): Promise<string | undefined> {
  const rows = await ledgerRowsFor($, p, '"kind":"dropped"')
  if (rows === 'unreadable') return undefined
  const n = rows.filter((r) => r.kind === 'dropped' && ['no-answered-row', 'id', 'hash', 'nonce', 'by-sid', 'kind', 'answer'].includes(String(r.code))).length
  return n > 0 ? `${n} decision${n === 1 ? ' was' : 's were'} dropped in the last two months for a reason that can mean a forged or stale file; tell the person (tools/callboard/prompt-audit.mjs lists them).` : undefined
}

async function promptListTool($: any, e: unknown): Promise<{ result: string } | { deny: string }> {
  const sid = await $.session.id()
  const t = await promptTierCtx($, e, sid)
  if ('err' in t) {
    await log($, sid, 'refused', `prompt-${t.err[0]}`)
    return { deny: promptReason('prompt_list', t.err[1]) }
  }
  if (!t.answering || t.off) return { result: pr.promptListText([], { on: false }) }
  const now = await $.clock.now()
  const items: pr.ListItem[] = []
  const stands = new Map<string, { stand: Stand; self: pr.Tier }>()
  const open = (
    await promptRequests($, t.p, async (q, names, dir) => {
      if (names.has(`${q.id}.done`) || names.has(`${q.id}.decision.json`) || q.sid === sid) return false
      const stand = await promptStand($, t.p, t.live, t.answering!, dir, names, q)
      const self = stand.tiers.find((x) => x.sid === sid)
      // Not in reach, passed up, or blocked in its own question: not this tier's to see.
      if (!self || stand.passed[self.level] !== undefined || !stand.active.some((x) => x.sid === sid)) return false
      stands.set(q.id, { stand, self })
      return true
    })
  ).sort((a, b) => a.req.at - b.req.at)
  for (const f of open) {
    const q = f.req
    const s = stands.get(q.id)!
    const top = s.stand.top
    const turn = pr.turnLine({ relay: s.stand.relay?.by, top: top?.sid === s.self.sid || top?.level === s.self.level, above: top, opensInSec: promptWindowShut(q, s.stand, sid, now) ? (s.stand.windows[sid] - now) / 1000 : undefined, question: q.tool === pr.QUESTION_TOOL })
    items.push({ id: q.id, lane: q.lane, tool: q.tool, repo: q.repo, raisedBy: q.raisedBy, ageSec: (now - q.at) / 1000, truncated: q.truncated, agentType: q.agentType, input: q.input, turn })
  }
  return { result: pr.promptListText(items, { on: true, hint: await promptAnomalyHint($, t.p).catch(() => undefined) }) }
}

// prompt_answer and prompt_escalate share their checks; `answer` false is the escalation: a tier that is not the top one passes the request up, the top one puts it
// to the person (the relay).
async function promptAnswerTool($: any, e: any, answer: boolean): Promise<{ result: string } | { deny: string }> {
  const sid = await $.session.id()
  const tool = answer ? 'prompt_answer' : 'prompt_escalate'
  const refuse = async (code: string, why?: string) => {
    await log($, sid, 'refused', `prompt-${code}`)
    return { deny: promptReason(tool, why ?? promptRefuse(code)) }
  }
  const t = await promptTierCtx($, e, sid)
  if ('err' in t) return refuse(t.err[0], t.err[1])
  const id = typeof e.id === 'string' ? e.id : ''
  const decision = e.decision
  const why = pr.cleanWhy(e.why)
  if (!c.SID_RE.test(id) || why === undefined || (answer && decision !== 'allow' && decision !== 'deny' && decision !== 'answer')) return refuse('bad-input')
  if (!t.answering || t.off) return refuse('off')
  const found = await promptFind($, { p: t.p, live: t.live, answering: t.answering }, sid, id, !answer)
  if ('no' in found) return refuse(found.no)
  const { dir, req: q, names } = found.file
  const { stand, self } = found
  const name = self.name === '' ? self.level : self.name
  const now = await $.clock.now()
  // A question takes only decision `answer`, by the number prompt_list showed (`option`), with the label as an optional echo; nothing else takes `answer`.
  const isQ = q.tool === pr.QUESTION_TOOL
  let pick: { index: number; label: string } | undefined
  if (answer && isQ) {
    if (decision !== 'answer') return refuse('question-answer-only')
    if (q.truncated) return refuse('truncated-question')
    const labels = pr.questionLabels(q.input)
    const opt = e.option
    if (typeof opt !== 'number' || !Number.isInteger(opt) || opt < 1 || opt > Math.min(4, labels.length)) return refuse('bad-answer')
    if (e.answer !== undefined && (typeof e.answer !== 'string' || pr.matchLabel(labels, e.answer) !== opt - 1)) return refuse('bad-answer')
    pick = { index: opt - 1, label: labels[opt - 1] }
  } else if (answer && decision === 'answer') return refuse('bad-input')
  // The decision is judged on the copy the tier read. A truncated copy cannot be allowed (the rubric: seen whole), and cannot be put to the person either: it is
  // denied, asking the lane for a cleaner call. A floor call is never answered, whichever way.
  if (answer) {
    if (q.truncated && decision === 'allow') return refuse('truncated')
    if (!q.truncated) {
      const fo = await promptFloorOpts($, q.tool, q.input, q.cwd ?? q.repo, homeOf(t.p), q.cwd !== undefined, q.level === 'lane' && q.lane !== undefined && q.ownReport !== undefined ? { lane: q.lane, path: q.ownReport } : undefined)
      if (pr.floorCheck(q.tool, q.input, fo) !== undefined) return refuse('floor')
    }
    if (promptWindowShut(q, stand, sid, now)) return refuse('window')
  }
  const cap = answer && decision === 'allow' ? pr.claudeCap(q.tool, q.input) : undefined
  if (cap && (await capOf($, t.p, cap)) !== 'ok') return refuse('cap')
  const row = { id, nonce: q.nonce, lane: q.lane, repo: q.repo, tool: q.tool, pattern: pr.patternOf(q.tool, q.input, q.repo), hash: q.inputHash, tier: self.level, why }
  // The request closing while a file is written leaves nothing behind: the file goes, nothing is logged.
  const gone = async (path: string) => {
    if ((await statR($, `${dir}/${id}.request.json`)) !== 'absent') return false
    await rmF($, path)
    return true
  }
  if (answer) {
    // The label hash first: a hash that cannot be made leaves no decision file without its row.
    const lh = pick ? await labelHash($, id, pick.label).catch(() => undefined) : undefined
    if (pick && lh === undefined) return refuse('write-failed')
    const path = `${dir}/${id}.decision.json`
    const body = JSON.stringify({ id, inputHash: q.inputHash, decision, ...(pick ? { answer: pick } : {}), why, by: { level: self.level, sid, name }, at: now, nonce: q.nonce })
    const put = await promptLinkOnce($, path, body)
    if (put === 'exists') return refuse('decided')
    if (put === 'failed') return refuse('write-failed')
    if (await gone(path)) return refuse('closed')
    // A tier that put the request to the person while this decision was being written wins: the decision is taken back (B1c).
    if ((await statR($, `${dir}/${id}.relay.json`)) !== 'absent') {
      await rmF($, path)
      return refuse('with-person')
    }
    // The row is written only after the file is in place; the hook holds a decision it sees a moment before its row for a few seconds. A row that cannot be written
    // takes the file back, so a decision never stands without its row.
    if (!(await ledgerAdd($, { ...row, kind: 'answered', code: decision, by: sid, ...(cap ? { cap: cap.kind, target: cap.target } : {}), ...(pick ? { opt: String(pick.index), lh } : {}) }))) {
      await rmF($, path)
      return refuse('write-failed')
    }
    if (decision === 'deny' && pr.isUnclear(why)) await ledgerAdd($, { ...row, kind: 'deny-unclear', code: 'deny', by: sid })
    if (pick) return { result: `Recorded: answer ${pick.index + 1} for ${id}. The card stays open in front of the person and their click wins; your answer lands once the question has been open 30 seconds, as the offered label with "(answered by …)" after it. It is yours, not the person's, and carries no approval for anything else.` }
    return { result: `Recorded: ${decision} for ${id}. The dialog stays open in front of the person and their click wins; your answer lands once the prompt has been open 30 seconds. It is yours, not the person's, and carries no approval for anything else.` }
  }
  // Escalation. Not the top tier: pass it up, and the next tier's window opens at once (the 30 seconds still bind).
  if (self.level !== stand.top?.level) {
    const path = `${dir}/${id}.escalate-${self.level}.json`
    const put = await promptLinkOnce($, path, pr.escalateText({ id, tier: 'up', why, at: now, level: self.level, sid }))
    if (put === 'exists') return refuse('escalated')
    if (put === 'failed') return refuse('write-failed')
    if (await gone(path)) return refuse('closed')
    if (!(await ledgerAdd($, { ...row, kind: 'escalated', code: self.level }))) {
      await rmF($, path)
      return refuse('write-failed')
    }
    promptForget(sid, id)
    return { result: `Passed up: ${id} goes to the next tier, and your right to answer it has ended.` }
  }
  // The top tier: the person decides. A decision already there blocks it; a truncated copy cannot be put to them.
  if (q.truncated) return refuse(isQ ? 'truncated-question' : 'truncated')
  if (names.has(`${id}.decision.json`) || (await statR($, `${dir}/${id}.decision.json`)) !== 'absent') return refuse('decided')
  if (promptWindowShut(q, stand, sid, now)) return refuse('window')
  const short = pr.shortOf(id)
  const path = `${dir}/${id}.relay.json`
  const put = await promptLinkOnce($, path, pr.relayText({ id, short, by: { level: self.level, sid, name }, at: now, nonce: q.nonce }))
  if (put === 'exists') return refuse('with-person')
  if (put === 'failed') return refuse('write-failed')
  if (await gone(path)) return refuse('closed')
  // The relay wins a race with a decision (prompt_answer takes its own decision back when it finds the relay, and only that side removes anything): a decision that
  // landed while the relay was written is removed here, so it cannot outlast the relay it lost to.
  await rmF($, `${dir}/${id}.decision.json`)
  if (!(await ledgerAdd($, { ...row, kind: 'relayed', code: self.level, short, by: sid }))) {
    await rmF($, path)
    return refuse('write-failed')
  }
  promptForget(sid, id)
  return { result: isQ ? pr.relayQuestionSteps(short, q.lane ?? '') : pr.relaySteps(short, q.lane ?? '') }
}

// The tick's notice: one fixed turn to an idle lead (a busy one gets the text mid-turn, promptMidTurnNotice), covering every open request in reach. A request is told once; a notice over the hourly cap stays owed
// (the next tick tries again). Nothing is read while answering is off, but one store read.
// Per lead: request id to 0 (told) or to the time it was found not to be in reach (looked at again after PROMPT_RECHECK_MS: a check that failed once must not
// hide a request for good).
const PROMPT_RECHECK_MS = 60_000
const PROMPT_WINDOW_RECHECK_MS = 15_000

export async function promptNoticeTick($: any, sid: string, submitsAtStart: number): Promise<void> {
  const g = grantOf(sid)
  if (g?.level !== 'lead' && g?.level !== 'conductor' && g?.level !== 'manager') return
  const answering = pr.parseAnswering(await $.store.get(ANSWERING_KEY).catch(() => undefined))
  if (!answering || (await promptsOff($))) {
    promptTold.delete(sid)
    return
  }
  const p = await where($)
  if (!p) return
  const base = `${p.root}/prompts`
  // Open requests: not closed, no decision yet. One with a relay is with the person (no tier is told of it); if its relay goes (lost), it is owed again.
  const open = new Map<string, { dir: string; names: Set<string> }>()
  const relayed = new Set<string>()
  const dirs = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).map((d) => d.name).sort().slice(0, PROMPT_DIRS_MAX)
  for (const name of dirs) {
    const names = new Set(((await $.fs.list(`${base}/${name}`).catch(() => [])) as { name: string }[]).map((f) => f.name))
    for (const n of names) {
      const m = /^([0-9a-f-]{36})\.request\.json$/.exec(n)
      if (!m || !c.SID_RE.test(m[1]) || names.has(`${m[1]}.done`) || names.has(`${m[1]}.decision.json`)) continue
      if (names.has(`${m[1]}.relay.json`)) relayed.add(m[1])
      else open.set(m[1], { dir: `${base}/${name}`, names })
    }
  }
  const told = promptTold.get(sid) ?? new Map<string, number>()
  const seenRelay = promptRelaySeen.get(sid) ?? new Set<string>()
  promptRelaySeen.set(sid, seenRelay)
  for (const id of [...told.keys()]) if (!open.has(id) && !relayed.has(id)) told.delete(id)
  for (const id of [...seenRelay]) if (!open.has(id) && !relayed.has(id)) seenRelay.delete(id)
  for (const id of relayed) seenRelay.add(id)
  // A relay that went away with the request still open (relay-lost): the top tier is told again.
  for (const id of [...seenRelay]) {
    if (open.has(id)) {
      told.delete(id)
      seenRelay.delete(id)
    }
  }
  promptTold.set(sid, told)
  const at = await $.clock.now()
  // 0: told. -1: this tier's, owed a notice (not read again). Above 0: not this tier's yet (not in reach, or its window not open): looked at again at that time.
  const fresh = [...open.keys()].filter((id) => !told.has(id) || (told.get(id)! > 0 && at >= told.get(id)!))
  if (fresh.length > 0) {
    // Each new request is read once: whose it is decides whether it is owed a notice.
    const live = await registryEntries($)
    if (!live || !(await dirOk($, base, p.uid))) return
    for (const id of fresh.slice(0, PROMPT_REQUESTS_MAX)) {
      const o = open.get(id)!
      const r = await readSmallR($, `${o.dir}/${id}.request.json`, p.uid, pr.REQUEST_MAX)
      if (r.state !== 'ok') continue
      const q = pr.parseRequest(r.text)
      if (!q || q.id !== id) {
        told.set(id, at + PROMPT_RECHECK_MS)
        continue
      }
      const stand = await promptStand($, p, live, answering, o.dir, o.names, q)
      const self = stand.tiers.find((x) => x.sid === sid)
      if (!self || stand.passed[self.level] !== undefined || !stand.active.some((x) => x.sid === sid)) told.set(id, at + PROMPT_RECHECK_MS)
      // A lead is told at once (its window is the 30-second minimum itself); a higher tier when its window opens (looked at again sooner, a pass-up opens it at once).
      else told.set(id, self.level !== 'lead' && promptWindowShut(q, stand, sid, at) ? Math.min(stand.windows[sid], at + PROMPT_WINDOW_RECHECK_MS) : -1)
    }
  }
  const mine = [...told].filter(([, v]) => v === -1).map(([id]) => id)
  if (mine.length === 0) return
  const now = await $.clock.now()
  const times = promptNotices.get(sid) ?? []
  if (!c.noticeAllowed(times, now, pr.PROMPT_NOTICES_PER_HOUR)) {
    if (promptCapLogged.has(sid)) return
    promptCapLogged.add(sid)
    return log($, sid, 'notice-capped', 'prompts')
  }
  if (dialogOpen.has(sid) || mem.submits !== submitsAtStart) return
  // A pending request (a compaction that is armed or waiting to resume) or a due nudge has the idle moment first.
  if ((await $.state.get(request)).value != null || (await $.state.get(nudgeDueRef)).value != null) return
  if ((await idleCheck($, sid)) !== undefined) return
  // Every read is behind us: nothing is awaited between this guard and the submit. A request the mid-turn path told meanwhile is not told again.
  if (dialogOpen.has(sid) || mem.submits !== submitsAtStart) return
  const owed = mine.filter((id) => told.get(id) === -1)
  if (owed.length === 0) return
  for (const id of owed) told.set(id, 0)
  promptCapLogged.delete(sid)
  promptNotices.set(sid, c.pushRecent(promptNotices.get(sid) ?? times, now))
  await submitOwn($, pr.PROMPT_NOTICE_TEXT, false).catch(async () => {
    for (const id of owed) told.set(id, -1)
    turnKind.delete(sid)
    await log($, sid, 'notice-failed', 'prompts')
  })
}

// A tier that passed a request up or relayed it is owed no notice of it: its marks for the id go, so the turn-end fallback cannot owe it again and the tick runs its
// own check of the request afresh.
function promptForget(sid: string, id: string) {
  promptTold.get(sid)?.delete(id)
  promptMidSent.get(sid)?.delete(id)
  promptMidRetold.get(sid)?.delete(id)
}
export function promptMidFallback(sid: string) {
  const told = promptTold.get(sid)
  const sent = promptMidSent.get(sid)
  promptMidSent.delete(sid)
  const retold = promptMidRetold.get(sid)
  if (retold) {
    for (const id of [...retold]) if (!told?.has(id)) retold.delete(id)
    if (retold.size === 0) promptMidRetold.delete(sid)
  }
  if (!told || !sent) return
  for (const id of sent) {
    if (told.get(id) === 0) {
      told.set(id, -1)
      const r = promptMidRetold.get(sid) ?? new Set<string>()
      r.add(id)
      promptMidRetold.set(sid, r)
    }
  }
}
// The notice in the middle of a turn (like midTurnNudge): a busy lead would learn of a waiting prompt only when its turn ends, and the lane behind it waits meanwhile.
// After a main-agent tool call of a lead, the hook returns PROMPT_NOTICE_TEXT as additionalContext, which the model reads with the tool's result. It reads no file:
// the tick's scan (promptNoticeTick) has already marked the requests owed a notice (-1), busy lead or not, so this only claims them. Same hourly cap, same told
// marks: a request is told once, by whichever path comes first, and the idle submit stays the fallback for a lead whose turn ends without a tool call.
export async function promptMidTurnNotice($: any, e: any): Promise<string | undefined> {
  if (typeof e?.agent_id === 'string' && e.agent_id !== '') return undefined
  const sid = await $.session.id()
  if (typeof sid !== 'string' || !c.SID_RE.test(sid) || grantOf(sid) === undefined) return undefined
  const told = promptTold.get(sid)
  const retold = promptMidRetold.get(sid)
  if (!told || ![...told].some(([id, v]) => v === -1 && !retold?.has(id))) return undefined
  try {
    // A compaction that is armed or waiting to resume would take the text with it: the notice stays owed, as for the tick's submit.
    if ((await $.state.get(request)).value != null) return undefined
    const now = await $.clock.now()
    const times = promptNotices.get(sid) ?? []
    if (!c.noticeAllowed(times, now, pr.PROMPT_NOTICES_PER_HOUR)) {
      if (!promptCapLogged.has(sid)) {
        promptCapLogged.add(sid)
        await log($, sid, 'notice-capped', 'prompts')
      }
      return undefined
    }
    // Answering turned off since the tick looked: nothing is told.
    if (!pr.parseAnswering(await $.store.get(ANSWERING_KEY).catch(() => undefined)) || (await promptsOff($))) return undefined
    // Nothing is awaited between this read of the marks and their change.
    const owed = [...told].filter(([id, v]) => v === -1 && !promptMidRetold.get(sid)?.has(id)).map(([id]) => id)
    if (owed.length === 0) return undefined
    for (const id of owed) told.set(id, 0)
    const sent = promptMidSent.get(sid) ?? new Set<string>()
    for (const id of owed) sent.add(id)
    promptMidSent.set(sid, sent)
    promptCapLogged.delete(sid)
    promptNotices.set(sid, c.pushRecent(promptNotices.get(sid) ?? [], now))
    await logq($, sid, 'notice', 'prompts mid-turn')
    return pr.PROMPT_NOTICE_TEXT
  } catch {
    await logq($, sid, 'error', 'mid-turn-prompt-notice')
    return undefined
  }
}

// ADR 0004: the lead tier's three tools. leadRun keeps the lead's presence file fresh and tells it once of a changed lane list, as for every lead tool.
export async function promptListCall($: any, e: any, next: any) {
  return leadRun($, e, async () => {
    ensureTimer($)
    return (await promptListTool($, e)) as never
  })
}

export async function promptAnswerCall($: any, e: any, next: any) {
  return leadRun($, e, async () => {
    ensureTimer($)
    return (await promptAnswerTool($, e, true)) as never
  })
}

export async function promptEscalateCall($: any, e: any, next: any) {
  return leadRun($, e, async () => {
    ensureTimer($)
    return (await promptAnswerTool($, e, false)) as never
  })
}
