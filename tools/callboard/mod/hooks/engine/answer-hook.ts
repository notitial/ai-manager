// The prompt-answering hook: request files, the wait for a decision, the apply step, the relay, the ledger glue and the sweeps.
// Trust rules held here: the floor at answer time and again at apply; no decision without a ledger row; the relay reads only the person's own answer.
import * as c from '../core.ts'
import * as pr from '../prompts.ts'
import { grants, checks, openReqs, doneIds, unclosed, askingSids, relayAskedTurn, mem } from '../mem.ts'
import { run, MKDIR, dirOk, INSTALL, TEE, MV, rmF, where, facts, sha, statR, realR, REALPATH, readSmallR, pause, RMDIR } from './base.ts'
import { loadLanes, registryEntries, registryOf, ownReg } from './store.ts'
import { leadsFor, homeOf, presenceCheck } from './grants.ts'
import { reportLaneOf, sessionRoot } from './lanes.ts'
import type { Bound } from './lanes.ts'
import { promptLinkOnce, promptReachTiers, promptStand } from './answer-tiers.ts'

// $.state keys declared again where they are used: `claude plugin validate` reads a key in the file that uses it.
const lane = { plugin: 'callboard', key: 'lane' } as const

// ---- prompt answering (ADR 0004): the hook, the floor, the files and the switch. Off by default; nothing here lets an agent write a decision. ----
// A PermissionRequest hook in the asking session: it refuses what no agent may answer, writes a request file and waits. The decision comes from
// prompt_answer or the person, and the hook applies it under every check of pr.applyCheck.
const UUIDGEN = '/usr/bin/uuidgen'
const GREP = '/usr/bin/grep'
const GIT_BIN = '/usr/bin/git'

export const PROMPT_DIRS_MAX = 512
export const ANSWERING_KEY = 'answering'
const CHECK_TTL_MS = 60_000
const CHECKS_MAX = 256
const SWEEP_EVERY_MS = 60_000
const SWEEP_DIRS_MAX = 64
const PERSON_HOLDS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const UNCLOSED_TRIES = 5
// What a request's hook has done about its closing row: `closed` once one is in the ledger (or the sweep wrote it), `pending` the row it still owes.
type CloseState = { closed: boolean; requested: boolean; pending?: Omit<pr.LedgerRow, 't'> }

async function promptDir($: any, p: { uid: number; root: string }, sid?: string): Promise<string | undefined> {
  const base = `${p.root}/prompts`
  const dirs = sid === undefined ? [p.root, base] : [p.root, base, `${base}/${sid}`]
  await run($, [MKDIR, '-p', '-m', '700', ...dirs])
  for (const d of dirs) if (!(await dirOk($, d, p.uid))) return undefined
  return dirs[dirs.length - 1]
}

// A file of ours, 0600, put in place whole: written beside it, then renamed.
async function promptPut($: any, path: string, text: string): Promise<boolean> {
  const tmp = `${path}.${++mem.seq}.tmp`
  try {
    if ((await run($, [INSTALL, '-m', '600', '/dev/null', tmp])).exitCode !== 0) return false
    if ((await run($, [TEE, '--', tmp], text)).exitCode !== 0 || (await run($, [MV, '-f', tmp, path])).exitCode !== 0) {
      await rmF($, tmp)
      return false
    }
    return true
  } catch {
    return false
  }
}

// One row appended whole (one tee call) to this month's file in the prompts folder, created 0600 and used only if it is a private file of ours.
// fileOf names the month's file from the clock; lineOf builds the line from the time. false: the row could not be written.
async function appendMonthly($: any, fileOf: (now: number) => string, lineOf: (t: string) => string): Promise<boolean> {
  try {
    const p = await where($)
    if (!p) return false
    const dir = await promptDir($, p)
    if (!dir) return false
    const now = await $.clock.now()
    const file = `${dir}/${fileOf(now)}`
    let f = await facts($, file)
    if (!f) {
      await run($, [INSTALL, '-m', '600', '/dev/null', file])
      f = await facts($, file)
    }
    if (!f || c.cueFileOk(f, p.uid)) return false
    return (await run($, [TEE, '-a', '--', file], lineOf(new Date(now).toISOString()))).exitCode === 0
  } catch {
    return false
  }
}

// One ledger row, appended whole (under pr.LEDGER_ROW_MAX bytes). false: the row could not be written.
export function ledgerAdd($: any, row: Omit<pr.LedgerRow, 't'>): Promise<boolean> {
  return appendMonthly($, pr.ledgerFile, (t) => pr.ledgerLine({ t, ...row }))
}

// The questions file: one redacted row per answered question, appended to this month's file as the ledger is. A failed write never stops the answer: the
// `returned` row is the record, and the audit notes the gap.
function questionsAdd($: any, row: Omit<pr.QuestionsRow, 't'>): Promise<boolean> {
  return appendMonthly($, pr.questionsFile, (t) => pr.questionsLine({ t, ...row }))
}
// The salted hash of a chosen label, as the ledger holds it: no text, and a dictionary of short labels is of no use without the request id.
export async function labelHash($: any, id: string, label: string): Promise<string> {
  return (await sha($, `${id}\n${label}`)).slice(0, 16)
}

// The rows of this month's and last month's ledgers that hold the needle, found with a bounded grep -F. A read that fails or is cut is unreadable.
// The needle is a JSON fragment as pr.ledgerLine writes it (`"id":"<uuid>"`, JSON.stringify's spacing): every row is written with ledgerLine.
export async function ledgerRowsFor($: any, p: { uid: number; root: string }, needle: string): Promise<pr.LedgerRow[] | 'unreadable'> {
  try {
    const now = await $.clock.now()
    const rows: pr.LedgerRow[] = []
    for (const name of [pr.ledgerFile(now), pr.ledgerFilePrev(now)]) {
      const path = `${p.root}/prompts/${name}`
      const st = await statR($, path)
      if (st === 'absent') continue
      if (st === 'error' || st.kind !== 'file' || st.uid !== p.uid || (st.mode & 0o022) !== 0) return 'unreadable'
      const r = await $.process.run([GREP, '-F', '-h', '--', needle, path], { timeoutMs: 5000 })
      if (r.exitCode === 1) continue
      if (r.exitCode !== 0 || r.isStdoutTruncated) return 'unreadable'
      rows.push(...pr.parseRows(String(r.stdout)))
    }
    return rows
  } catch {
    return 'unreadable'
  }
}

// Whether this month's or last month's ledger holds an `answered` row for the id and nonce.
async function ledgerHas($: any, p: { uid: number; root: string }, id: string, nonce: string, bind?: { code: string; by: string; via?: 'person'; opt?: string; lh?: string }): Promise<'found' | 'missing' | 'unreadable'> {
  const rows = await ledgerRowsFor($, p, `"id":"${id}"`)
  if (rows === 'unreadable') return 'unreadable'
  // bind: the row must name the same decision and the same author as the file, so a file rewritten after its row (a deny turned allow) is not found. For a question's answer it names
  // the chosen option too (opt, and the label hash lh), so a file rewritten from one option to another is not found either.
  return rows.some((j) => j.kind === 'answered' && j.id === id && j.nonce === nonce && (bind === undefined || (j.code === bind.code && j.by === bind.by && j.via === bind.via && (bind.opt === undefined || (bind.lh !== undefined && j.opt === bind.opt && j.lh === bind.lh))))) ? 'found' : 'missing'
}

// The standing comment cap for a call that carries an `@claude` body: the `returned` allow rows of this month and last for the same repo, PR and kind. A failed
// read is 'unreadable', which the callers treat as over the cap (the prompt stays the person's).
export async function capOf($: any, p: { uid: number; root: string }, cap: { kind: pr.CapKind; target: string }): Promise<'ok' | 'over' | 'unreadable'> {
  const rows = await ledgerRowsFor($, p, `"target":${JSON.stringify(cap.target)}`)
  return rows === 'unreadable' ? 'unreadable' : pr.capState(rows, cap)
}

// The emergency file: while it exists answering is off. A stat that fails counts as present (fail closed).
export async function promptsOff($: any): Promise<boolean> {
  const p = await where($)
  if (!p) return true
  return (await statR($, `${p.root}/prompts/OFF`)) !== 'absent'
}

// Whether the switch is on and this session is a lane or a lead: the cheap first test. The scope (a lane's or a lead's name) is judged once the lead is known.
async function promptCoverage($: any, sid: string): Promise<{ a: pr.Answering; level: 'lane' | 'lead'; lane?: string; self?: string; lead?: string } | undefined> {
  const a = pr.parseAnswering(await $.store.get(ANSWERING_KEY))
  if (!a) return undefined
  const b = (await $.state.get(lane)).value as Bound | null | undefined
  if (b && typeof b.name === 'string') return { a, level: 'lane', lane: b.name, ...(typeof b.lead === 'string' ? { lead: b.lead } : {}) }
  const g = grants.get(sid)
  return g?.level === 'lead' ? { a, level: 'lead', self: g.name } : undefined
}

// tool.check only observes: it stores what it saw for an ask in a covered session, and the caller returns the verdict unchanged, every time (F-C).
async function promptObserve($: any, e: any, r: any): Promise<void> {
  if (r?.decision !== 'ask' || typeof e.tool_use_id !== 'string' || typeof e.agentId === 'string') return
  const sid = await $.session.id()
  if (!c.SID_RE.test(sid) || !(await promptCoverage($, sid))) return
  const key = `${sid}\n${pr.joinKey(String(e.tool), await sha($, pr.canonical(e.input)), undefined)}`
  const now = await $.clock.now()
  const old = checks.get(key)
  const dup = old !== undefined && now - old.at <= CHECK_TTL_MS && old.toolUseId !== e.tool_use_id
  if (dup) old.dup = true
  checks.set(key, { toolUseId: e.tool_use_id, at: now, approver: e.approver, dup, facts: { decision: r.decision, reason: r.reason, rule: r.rule, hook: r.hook, setting: r.setting, plugin: r.plugin, ceiling: r.ceiling } })
  for (const [k, v] of checks) if (now - v.at > CHECK_TTL_MS) checks.delete(k)
  while (checks.size > CHECKS_MAX) checks.delete(checks.keys().next().value as string)
}

// The current branch of a repo, by a read-only git call that reads no hook and no optional lock; undefined (detached, or any failure) leaves the floor holding.
async function branchOf($: any, dir: string): Promise<string | undefined> {
  const r = await run($, [GIT_BIN, '--no-optional-locks', '-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], undefined, { LC_ALL: 'C' }).catch(() => undefined)
  const b = r?.exitCode === 0 ? String(r.stdout).trim() : ''
  return b === '' || /[\u0000-\u001f]/.test(b) ? undefined : b
}

// Where a push of this branch goes when the call names no branch: the keys git reads for it (branch.<b>.remote, pushRemote, merge, remote.pushDefault, push.default,
// a remote's push or mirror). No keys is an answer (the defaults apply); anything else that fails leaves it unresolved, and the floor holds.
const PUSH_KEYS = '^(branch\\..*\\.(remote|pushremote|merge)|remote\\.pushdefault|remote\\..*\\.(push|pushurl|mirror)|url\\..*\\.(insteadof|pushinsteadof)|push\\.default)$'
async function pushTargetOf($: any, dir: string, branch: string, remote?: string): Promise<NonNullable<pr.FloorOpts['pushTarget']>> {
  const r = await run($, [GIT_BIN, '--no-optional-locks', '-C', dir, 'config', '--get-regexp', PUSH_KEYS], undefined, { LC_ALL: 'C' }).catch(() => undefined)
  // A config that cannot be read may rewrite the push: even a named ref is then the floor.
  if (!r) return { unresolved: true, mapped: true }
  if (r.exitCode === 1 && String(r.stdout).trim() === '') return pr.pushTargetFrom('', branch, remote)
  return r.exitCode === 0 && !r.isStdoutTruncated ? pr.pushTargetFrom(String(r.stdout), branch, remote) : { unresolved: true, mapped: true }
}

// cwdKnown: cwd is the folder the engine said the call ran in. When it said none, the floor reads every relative path as having an unknown base.
// A lane's own report (a lane signs by writing it), for the floor: the path and its real path, only when everything about it checks out. In the asking session (`sid`)
// the path is the one its lane record gives, the one lane_retire reads. A prompt_answer in a tier's session has only the request, which carries that path (`path`);
// it must still read as `<repo>/.archive/<lane>/REPORT.md` of the request's own lane and be the path a lane record of that name gives. Anything that does not check out gives undefined, and the floor holds as before.
async function ownReportOf($: any, own: { lane: string; sid?: string; path?: string }, file: { filePath: unknown; cwd: string | undefined }): Promise<pr.FloorOpts['ownReport']> {
  try {
    let path = own.path
    if (own.sid !== undefined) {
      const l = await reportLaneOf($, own.sid)
      if (!l || l.name !== own.lane) return undefined
      path = c.reportPath(l)
    } else {
      // A tier has only the request: the path it names must be the one a lane record of that name gives.
      const lanes = await loadLanes($)
      if (typeof lanes === 'string' || !lanes.some((x) => x.name === own.lane && c.reportPath(x) === path)) return undefined
    }
    const tail = `/.archive/${own.lane}/REPORT.md`
    const repo = path !== undefined && path.endsWith(tail) ? path.slice(0, -tail.length) : undefined
    const p = await where($)
    if (path === undefined || repo === undefined || pr.ownReportPath(repo, own.lane) !== path || !p) return undefined
    // Only a call that names the report pays for the file system checks, and only it gets the exception.
    if (!pr.namesOwnReport(file.filePath, file.cwd, path)) return undefined
    // The repo is its own real path: a folder that was swapped for a link since the lane was made gets no exception.
    const real = await realR($, repo)
    if (typeof real === 'string' || real.path !== repo) return undefined
    // The file is ours and plain (a link or a second hard link would write somewhere else), or not made yet.
    const st = await statR($, path)
    if (st === 'error' || (st !== 'absent' && (st.kind !== 'file' || st.nlink !== 1 || st.uid !== p.uid))) return undefined
    return { path, real: `${real.path === '/' ? '' : real.path}${tail}` }
  } catch {
    return undefined
  }
}

// own: the session's lane, for its own report (see ownReportOf); only a write by a file tool uses it.
export async function promptFloorOpts($: any, tool: string, input: any, cwd: string, home: string, cwdKnown = true, own?: { lane: string; sid?: string; path?: string }): Promise<pr.FloorOpts> {
  const o: pr.FloorOpts = { home, roots: [], cwd, ...(cwdKnown ? {} : { cwdUnknown: true }) }
  const isGit = tool.startsWith('mcp__git-mcp__')
  try {
    const co = c.liveCheckout($.plugin.root)
    if (co) {
      o.roots = [co]
      const real = await realR($, co)
      if (typeof real !== 'string' && real.path !== co) o.roots.push(real.path)
    }
  } catch {}
  // The folders the hooks and rules under ~/.claude are linked into (the toolkit's live checkout): an edit there is an edit of the guards themselves.
  if (PERSON_HOLDS.has(tool) || tool === 'Bash' || isGit) for (const r of await linkedRoots($, home)) if (!o.roots!.includes(r)) o.roots!.push(r)
  if (pr.needsBranch(tool, input)) {
    const dir = pr.gitPathOf(tool, input) ?? (tool === 'Bash' ? cwd : undefined)
    if (dir) o.branch = await branchOf($, dir)
  }
  // Every push is judged by where git sends it: a push naming no branch goes to the configured target of the current one, and a remote may rewrite even a named ref.
  // An unread branch is '' (the rewrite check needs none); no folder to read is unresolved.
  if (pr.needsPushTarget(tool, input)) {
    // The git server acts in the folder the call names; with none it acts in its own, which is not read here.
    const dir = pr.gitPathOf(tool, input)
    o.pushTarget = dir === undefined ? { unresolved: true, mapped: true } : await pushTargetOf($, dir, o.branch ?? '', typeof input?.remote === 'string' ? input.remote : undefined)
  }
  if (PERSON_HOLDS.has(tool) || isGit) {
    const real: string[] = []
    // A git call acts on its `path`, or on the folder the session runs in.
    for (const raw of isGit ? [typeof input?.path === 'string' ? input.path : cwd] : [input?.file_path, input?.notebook_path, input?.path]) {
      if (typeof raw !== 'string') continue
      const abs0 = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw
      const abs = abs0.startsWith('/') ? abs0 : `${cwd}/${abs0}`
      let r = await realR($, abs)
      if (r === 'absent') {
        // A file not made yet: its folder's real path, and the name.
        const slash = abs.lastIndexOf('/')
        const d = await realR($, abs.slice(0, slash) || '/')
        r = typeof d === 'string' ? d : { path: `${d.path === '/' ? '' : d.path}${abs.slice(slash)}` }
      }
      if (typeof r === 'string') o.unresolved = true
      else real.push(r.path)
    }
    o.real = real
  }
  if (own && PERSON_HOLDS.has(tool)) {
    const r = await ownReportOf($, own, { filePath: input?.file_path, cwd: o.cwdUnknown === true ? undefined : cwd })
    if (r) o.ownReport = r
  }
  return o
}

// The folder above `hooks` or `rules` in the real path of each entry of ~/.claude/hooks and ~/.claude/rules that is a link out of ~/.claude. Best effort: a
// failed list or realpath adds nothing. A folder found this way is as wide as the link's own parent, which errs toward the floor.
async function linkedRoots($: any, home: string): Promise<string[]> {
  const out = new Set<string>()
  const own = `${home.toLowerCase()}/.claude`
  for (const sub of ['hooks', 'rules']) {
    try {
      const names = ((await $.fs.list(`${home}/.claude/${sub}`).catch(() => [])) as { name: string }[]).map((f) => f.name).filter((n) => /^[A-Za-z0-9._-]{1,100}$/.test(n)).slice(0, 64)
      if (names.length === 0) continue
      const r = await run($, [REALPATH, '--', ...names.map((n) => `${home}/.claude/${sub}/${n}`)], undefined, { LC_ALL: 'C' })
      for (const line of String(r.stdout).split('\n')) {
        const m = /^(\/.+?)\/(?:hooks|rules)\/[^/]+$/.exec(line.trim())
        const low = m?.[1].toLowerCase()
        if (m && low !== own && !low!.startsWith(`${own}/`)) out.add(m[1])
      }
    } catch {}
  }
  return [...out]
}

// The lane's own lead (a live lead of the repo that is not the lane), by sid and name; undefined for a lead's own prompt or when none is live.
async function promptLeadOf($: any, level: 'lane' | 'lead', sid: string, cwd: string, bound?: string): Promise<{ sid: string; name?: string } | undefined> {
  if (level !== 'lane') return undefined
  const live = await registryEntries($)
  if (!live) return undefined
  const leads = (await leadsFor($, live, cwd).catch(() => [] as c.LeadFile[])).filter((l) => l.sid !== sid)
  // Record first, as the briefing does: a lane record that names its lead is reached by the live lead of that registry name and no other (none live: nobody).
  // Else the lead the lane is bound to, if it is live; with no binding, the one live lead of the repo. Two leads and no binding: nobody can be asked.
  // A bound lane whose record cannot be read, or that has none, reaches no lead: the prompt stays the person's.
  const rec = await reportLaneOf($, sid).catch(() => undefined)
  if (!rec) return undefined
  const rows = live.map((r) => r.j)
  const lead = rec?.leadName !== undefined ? leads.find((l) => c.leadNameOf(rows, l.sid) === rec.leadName) : bound !== undefined ? leads.find((l) => l.sid === bound) : leads.length === 1 ? leads[0] : undefined
  if (!lead) return undefined
  return { sid: lead.sid, name: c.leadNameOf(rows, lead.sid) ?? undefined }
}

// This session's own registry row, by one file read (not the whole table): the row of the pid the request was made under, kept only if it names this session and
// the same process start. undefined: unknown (a changing, missing or odd file).
async function promptOwnRow($: any, w: WaitCtx): Promise<any | undefined> {
  if (w.p.own === undefined || !(await dirOk($, w.p.own, w.p.uid))) return undefined
  const r = await readSmallR($, `${w.p.own}/${w.req.pid}.json`, w.p.uid, c.REGISTRY_FILE_MAX, true)
  if (r.state !== 'ok') return undefined
  try {
    const j = JSON.parse(r.text)
    return j && typeof j === 'object' && String(j.pid) === String(w.req.pid) && j.sessionId === w.sid && j.procStart === w.req.procStart ? j : undefined
  } catch {
    return undefined
  }
}

export async function promptNewId($: any): Promise<string> {
  const r = await run($, [UUIDGEN])
  const id = r.stdout.trim().toLowerCase()
  if (r.exitCode !== 0 || !c.SID_RE.test(id)) throw new Error('uuid-failed')
  return id
}

// A request's in-memory entries, dropped when its hook ends.
function forgetReq(tid: string): void {
  openReqs.delete(tid)
  doneIds.delete(tid)
}

// The request's files, removed when it closes (the ledger row is written before this).
async function promptCleanup($: any, dir: string | undefined, id: string | undefined, tid: string): Promise<void> {
  forgetReq(tid)
  if (!dir || !id) return
  await promptRemoveFiles($, dir, id)
}

// Every file a request can have beside its request file: the decision, the pass-up of each tier (the old `escalate.json` is the lead's), the relay with its asked and
// left marks, and the closed marker.
const PROMPT_SUFFIXES = ['request.json', 'decision.json', 'escalate.json', 'escalate-lead.json', 'escalate-conductor.json', 'escalate-manager.json', 'relay.json', 'asked', 'left', 'done']
async function promptRemoveFiles($: any, dir: string, id: string): Promise<void> {
  await rmF($, PROMPT_SUFFIXES.map((x) => `${dir}/${id}.${x}`))
}

// The marker prompt_list, the lead's notice and prompt_answer read as "closed": no hook waits for this request any more.
async function promptMarkDone($: any, dir: string, id: string): Promise<void> {
  await run($, [INSTALL, '-m', '600', '/dev/null', `${dir}/${id}.done`]).catch(() => undefined)
}

// The tick's retry for a request whose closing row could not be written when its hook ended (a No click cuts the dispatch off; a ledger can fail for a moment).
export async function promptCloseTick($: any): Promise<void> {
  for (const [id, u] of [...unclosed]) {
    // Taken out first, so a tick and a hook start that overlap cannot both write the row (or both count a try).
    if (!unclosed.delete(id)) continue
    const ok = await ledgerAdd($, u.row).catch(() => false)
    if (ok) await promptRemoveFiles($, u.dir, id)
    else if (++u.tries < UNCLOSED_TRIES) unclosed.set(id, u)
    // Given up: the files stay for the sweep, marked closed (again) so that prompt_list and the notice do not show a request whose hook is gone.
    else await promptMarkDone($, u.dir, id)
  }
}

// A tool's end, or a No click's PermissionDenied, closes the dialog: the hook's wait learns of a click by this id (a Yes fires no signal).
export async function promptDone($: any, e: any): Promise<void> {
  const tid = typeof e?.tool_use_id === 'string' ? e.tool_use_id : undefined
  // The call has ended or been refused: an entry kept for it (an ask the dialog never reached) must not make a later identical call look like a second in flight.
  if (tid !== undefined) for (const [k, v] of checks) if (v.toolUseId === tid) checks.delete(k)
  const o = tid === undefined ? undefined : openReqs.get(tid)
  if (!o || tid === undefined) return
  doneIds.add(tid)
  if (o.dir && o.id) await promptMarkDone($, o.dir, o.id)
}

export async function doneHook($: any, e: any, next: any): Promise<any> {
  await promptDone($, e).catch(() => undefined)
  return next(e)
}

// The `Relay <short>` headers of an AskUserQuestion input (at most 8 questions).
const relayShorts = (input: any): string[] => (Array.isArray(input?.questions) ? input.questions.slice(0, 8).flatMap((q: any) => { const m = pr.RELAY_HEADER.exec(typeof q?.header === 'string' ? q.header : ''); return m ? [m[1]] : [] }) : [])

// The open relays this session made: every `<id>.relay.json` in the prompts folders whose `by` is this session. A scan of at most PROMPT_DIRS_MAX folders, run only when a
// `Relay` question is asked or answered.
async function promptOpenRelays($: any, p: { uid: number; root: string }, sid: string): Promise<{ dir: string; relay: pr.Relay }[]> {
  const base = `${p.root}/prompts`
  const out: { dir: string; relay: pr.Relay }[] = []
  if (!(await dirOk($, base, p.uid))) return out
  const dirs = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).map((d) => d.name).sort().slice(0, PROMPT_DIRS_MAX)
  for (const name of dirs) {
    const dir = `${base}/${name}`
    for (const f of ((await $.fs.list(dir).catch(() => [])) as { name: string }[]).filter((x) => /^[0-9a-f-]{36}\.relay\.json$/.test(x.name)).slice(0, 16)) {
      const r = await readSmallR($, `${dir}/${f.name}`, p.uid, pr.DECISION_MAX)
      const x = r.state === 'ok' ? pr.parseRelay(r.text) : undefined
      if (x && x.by.sid === sid && `${x.id}.relay.json` === f.name) out.push({ dir, relay: x })
    }
  }
  return out
}

// Step 0's read: the labels of each of this tier's open relays whose request is a question, against the options of the relay questions in the call. The short of the first one
// that does not offer exactly those labels, or undefined (all trusted, or no relay of a question).
async function promptRelayOptionsBad($: any, sid: string, input: any): Promise<string | undefined> {
  const p = await where($)
  if (!p || !(await dirOk($, `${p.root}/prompts`, p.uid))) return undefined
  const shorts = relayShorts(input)
  const labels: Record<string, string[]> = {}
  for (const r of (await promptOpenRelays($, p, sid)).filter((x) => shorts.includes(x.relay.short))) {
    const rr = await readSmallR($, `${r.dir}/${r.relay.id}.request.json`, p.uid, pr.REQUEST_MAX)
    const q = rr.state === 'ok' ? pr.parseRequest(rr.text) : undefined
    if (q && q.id === r.relay.id && q.nonce === r.relay.nonce && q.tool === pr.QUESTION_TOOL) labels[r.relay.short] = pr.questionLabels(q.input)
  }
  return pr.relayQuestionBad(input, labels)
}

// The relay question raised its PermissionRequest: the relay is marked asked (`<id>.asked` beside the request) and this tier asking (`prompts/asking/<sid>`, removed
// at the question's end), which keeps new requests off it while its question is open.
async function promptRelayAsked($: any, sid: string, shorts: string[]): Promise<void> {
  const p = await where($)
  if (!p || !(await dirOk($, `${p.root}/prompts`, p.uid))) return
  const mine = (await promptOpenRelays($, p, sid)).filter((r) => shorts.includes(r.relay.short))
  if (mine.length === 0) return
  for (const r of mine) await promptLinkOnce($, `${r.dir}/${r.relay.id}.asked`, '{}')
  askingSids.add(sid)
  relayAskedTurn.add(sid)
  await run($, [MKDIR, '-p', '-m', '700', `${p.root}/prompts/asking`]).catch(() => undefined)
  if (!(await dirOk($, `${p.root}/prompts/asking`, p.uid))) return
  await promptPut($, `${p.root}/prompts/asking/${sid}`, '{}')
}
// The asked mark is spent by the question it marked: an answer, a dismissal or a question a hook beneath answered leaves none, so the next question needs its own.
async function promptRelayAskedClear($: any, sid: string, shorts: string[]): Promise<void> {
  const p = await where($)
  if (!p) return
  for (const r of await promptOpenRelays($, p, sid).catch(() => [])) if (shorts.includes(r.relay.short)) await rmF($, `${r.dir}/${r.relay.id}.asked`)
}
// A tier's turn has ended with relay questions it had asked still open: each is left (`.left`, a `relay-left` row), as a dismissal is.
export async function promptRelayTurnEnd($: any, sid: string): Promise<void> {
  const p = await where($)
  if (!p) return
  for (const r of await promptOpenRelays($, p, sid)) {
    if ((await statR($, `${r.dir}/${r.relay.id}.asked`)) === 'absent') continue
    if ((await promptLinkOnce($, `${r.dir}/${r.relay.id}.left`, '{}')) === 'ok') await ledgerAdd($, { kind: 'relay-left', id: r.relay.id, short: r.relay.short, by: sid, tier: r.relay.by.level })
  }
}

// The tier is no longer asking: its question is over (answered, dismissed) or its turn ended.
export async function promptAskingClear($: any, sid: string, always = false): Promise<boolean> {
  const marked = askingSids.delete(sid)
  const p = await where($)
  if (!p) return marked
  const file = `${p.root}/prompts/asking/${sid}`
  // Not marked in memory (a reload since, or never asked): one stat tells whether a file is there, so a turn of an ordinary session costs no process call.
  if (!marked && !always && (await statR($, file)) === 'absent') return false
  await rmF($, file)
  return true
}

// The hook. nextOnce runs the chain beneath at most once, so a failure after it never runs it a second time.
async function promptHook($: any, e: any, nextOnce: (x: any) => Promise<any>, signal: AbortSignal): Promise<any> {
  const sid = await $.session.id()
  if (!c.SID_RE.test(sid)) return nextOnce(e)
  // A request left without its closing row is retried here as well as on the tick (a no-op while none is owed).
  if (unclosed.size > 0) await promptCloseTick($).catch(() => undefined)
  // 0. A tier's relay question: it is the person's already (AskUserQuestion), so it raises no request. It marks the relay asked and the tier asking,
  // before the coverage gate, so a conductor's or the manager's question is marked too. The chain beneath runs as it always did.
  if (String(e.tool_name) === 'AskUserQuestion' && relayShorts(e.tool_input).length > 0) {
    // A relay question for a lane's QUESTION must offer exactly the lane's labels (the tier copies them, and a model does not copy exactly): checked before the person sees it.
    // A mismatch denies the whole call, shows no card and sets no asked mark; the tier asks again.
    const bad = await promptRelayOptionsBad($, sid, e.tool_input).catch(() => undefined)
    if (bad !== undefined) return { decision: { behavior: 'deny', message: pr.relayOptionsLine(bad) } }
    const under = await nextOnce(e)
    // The question is the person's only if nothing beneath answered it (a hook that does is not the person): then it is not marked asked, and an answer to it lands nothing.
    const u = (under && typeof under === 'object' ? under : {}) as { decision?: unknown; hookSpecificOutput?: { decision?: unknown } }
    if (u.decision === undefined && u.hookSpecificOutput?.decision === undefined) await promptRelayAsked($, sid, relayShorts(e.tool_input)).catch(() => undefined)
    else await promptRelayAskedClear($, sid, relayShorts(e.tool_input))
    return under
  }
  // 1. The switch and the session's kind. The emergency file wins over the switch.
  const cov = await promptCoverage($, sid)
  if (!cov || (await promptsOff($))) return nextOnce(e)
  const p = await where($)
  if (!p) return nextOnce(e)
  const tool = String(e.tool_name)
  const input = e.tool_input
  // 2. The tool.check entry, looked up before the chain beneath runs (a slow hook beneath cannot outlast its memory).
  let hash: string
  try {
    hash = await sha($, pr.canonical(input))
  } catch {
    return nextOnce(e)
  }
  const key = `${sid}\n${pr.joinKey(tool, hash, undefined)}`
  const entry = checks.get(key)
  // An entry serves one request: a later identical call gets its own tool.check.
  checks.delete(key)
  const started = await $.clock.now()
  const usable = entry !== undefined && !entry.dup && started - entry.at <= CHECK_TTL_MS
  const tid = usable ? entry.toolUseId : undefined
  // The call is marked open now, so a click (and the tool's end) during the chain beneath is seen.
  if (tid !== undefined) {
    openReqs.set(tid, {})
    doneIds.delete(tid)
  }
  const reqDir: { dir?: string; id?: string } = {}
  const st: CloseState = { closed: false, requested: false }
  try {
    // 3. The chain beneath: any non-empty result stands and is returned whole (a settings hook's deny, another plugin's answer).
    const beneath = await nextOnce(e)
    if (beneath && typeof beneath === 'object' && Object.keys(beneath).length > 0) return beneath
    // A No click aborted the signal; a Yes ended the dialog with no signal, so the done events are looked at again.
    if (signal.aborted || (tid !== undefined && doneIds.has(tid))) return beneath
    const cwd = String(await sessionRoot($).catch(() => ''))
    // A session the switch does not cover leaves no row: a scope of one lane or one lead is judged first, and only a scope that names a lead needs the lead's name.
    let lead: { sid: string; name?: string } | undefined
    let leadRead = false
    // The questions scope may name a lead too: a question reads it as well.
    const plain = (sc: string | undefined): boolean => sc === undefined || sc === 'all' || sc === cov.lane || sc === cov.self
    if (!plain(cov.a.scope) || (tool === pr.QUESTION_TOOL && !plain(cov.a.asksScope))) {
      lead = await promptLeadOf($, cov.level, sid, cwd, cov.lead)
      leadRead = true
      if (!pr.covers(cov.a, { lane: cov.lane, lead: lead?.name, self: cov.self })) return beneath
    }
    const base = { lane: cov.lane ?? cov.self, repo: cwd, tool, pattern: pr.patternOf(tool, input, cwd), hash }
    if (!usable || entry === undefined) {
      await ledgerAdd($, { ...base, kind: 'not-judgeable', code: 'no-check' })
      return beneath
    }
    // 4. Nobody can be asked, or a host answers: not ours.
    if (entry.approver !== 'person') return beneath
    // 5. Which asks agents may judge.
    const judged = pr.classify(tool, entry.facts)
    if (judged.judge === 'person') {
      await ledgerAdd($, { ...base, kind: 'not-judgeable', code: judged.why })
      return beneath
    }
    // 5b. A question: the questions scope covers this lane (a lead's own question is the person's), then the mechanical shape. Each refusal is a row with its
    // code, no request and no notice. Checked first, so with the scope unset nothing else about the question is read.
    if (tool === pr.QUESTION_TOOL) {
      if (cov.level !== 'lane' || !pr.coversAsks(cov.a, { lane: cov.lane, lead: lead?.name, self: cov.self })) {
        await ledgerAdd($, { ...base, kind: 'not-judgeable', code: 'question-scope' })
        return beneath
      }
      const shape = pr.questionShape(input)
      if (!shape.ok) {
        await ledgerAdd($, { ...base, kind: 'not-judgeable', code: shape.code })
        return beneath
      }
    }
    // 6. The floor.
    // The floor reads relative paths against the folder the engine says the call ran in (a shell keeps its cd between calls), not the folder the session started in.
    const ecwd = typeof e.cwd === 'string' && e.cwd.startsWith('/') ? e.cwd : undefined
    const fo = await promptFloorOpts($, tool, input, ecwd ?? cwd, homeOf(p), ecwd !== undefined, cov.level === 'lane' && cov.lane !== undefined ? { lane: cov.lane, sid } : undefined)
    const floor = pr.floorCheck(tool, input, fo)
    // What the floor read besides the input: the audit compares it between a floor row and a later request of the same input.
    const ctx = (await sha($, JSON.stringify(fo)).catch(() => '')).slice(0, 16)
    if (floor !== undefined) {
      await ledgerAdd($, { ...base, ...(ctx ? { ctx } : {}), kind: 'floor', code: floor })
      return beneath
    }
    // 7. A live tier: the lead of a lane, or a conductor or the manager (a lead's own prompt starts at the conductor). Nobody in reach, or an asker that the plain
    // session list does not show (a session under another config folder): no row for a judge, the dialog stays the person's.
    if (!leadRead) lead = await promptLeadOf($, cov.level, sid, cwd, cov.lead)
    const leadName = lead?.name
    const own = await registryOf($, sid, ownReg($))
    const liveNow = await registryEntries($)
    const reach = own && typeof own.pid === 'number' && typeof own.procStart === 'string' && liveNow ? await promptReachTiers($, liveNow, cov.a, { sid, pid: own.pid, procStart: own.procStart, level: cov.level, lane: cov.lane ?? cov.self, ...(leadName ? { leadName } : {}), repo: cwd, tool }, cov.level === 'lane' && lead === undefined).catch(() => [] as pr.Tier[]) : ([] as pr.Tier[])
    if (reach.length === 0 && own && typeof own.pid === 'number' && typeof own.procStart === 'string') {
      await ledgerAdd($, { ...base, kind: 'abandoned', code: 'no-tier' })
      return beneath
    }
    if (!pr.requestCovered(cov.a, { tool }, { lane: cov.lane, lead: leadName, self: cov.self })) return beneath
    // 8. The request, then the wait.
    const dir = await promptDir($, p, sid)
    if (!own || typeof own.pid !== 'number' || typeof own.procStart !== 'string' || !dir) {
      await ledgerAdd($, { ...base, kind: 'abandoned', code: 'hook-failed' })
      return beneath
    }
    const id = await promptNewId($)
    const nonce = await promptNewId($)
    const capped = pr.capInput(input)
    const req: pr.Request = { id, sid, pid: own.pid, procStart: own.procStart, level: cov.level, lane: cov.lane ?? cov.self, ...(leadName ? { leadName } : {}), ...(cov.level === 'lane' && lead === undefined ? { noLead: true } : {}), repo: cwd, tool, ...(ecwd !== undefined ? { cwd: ecwd } : {}), inputHash: hash, ...(fo.ownReport !== undefined ? { ownReport: fo.ownReport.path } : {}), raisedBy: judged.raisedBy, at: started, expiresAt: started + pr.EXPIRES_MS, nonce, input: capped.input, truncated: capped.truncated }
    const text = pr.requestText(req)
    if (new TextEncoder().encode(text).length > pr.REQUEST_MAX || !(await promptPut($, `${dir}/${id}.request.json`, text))) {
      await ledgerAdd($, { ...base, kind: 'abandoned', code: 'hook-failed' })
      return beneath
    }
    reqDir.dir = dir
    reqDir.id = id
    openReqs.set(tid as string, { id, dir })
    if (doneIds.has(tid as string)) await promptDone($, { tool_use_id: tid })
    const row = { ...base, ...(ctx ? { ctx } : {}), id, tier: [...reach].sort((x, y) => pr.TIER_RANK[x.level] - pr.TIER_RANK[y.level])[0].level }
    // Without a `requested` row no decision could ever pass the ledger check: the dialog is left to the person.
    if (!(await ledgerAdd($, { ...row, kind: 'requested', nonce }))) throw new Error('ledger-unwritable')
    st.requested = true
    return await promptWait($, beneath, signal, { sid, tid: tid as string, id, nonce, dir, input, tool, cwd, ecwd, home: homeOf(p), p, started, row, req, leadName, cap: pr.claudeCap(tool, input), st })
  } catch (err) {
    // A failing hook answers nothing: the dialog stays (the caller returns what the chain beneath gives).
    if (!st.closed) {
      const row = { kind: 'abandoned' as const, code: 'hook-failed', id: reqDir.id }
      st.pending = row
      if (await ledgerAdd($, row).catch(() => false)) st.closed = true
    }
    throw err
  } finally {
    // The files go only with a closing row in the ledger. Without one (the write failed, or the person's No cut this dispatch off) they stay, and the tick writes it.
    // A request that never got its `requested` row has nothing to close: its files go as before.
    if (reqDir.id && reqDir.dir && st.requested && !st.closed) {
      unclosed.set(reqDir.id, { dir: reqDir.dir, row: st.pending ?? { kind: 'abandoned', code: 'hook-failed', id: reqDir.id }, tries: 0 })
      forgetReq(tid ?? '')
      // No hook waits for it any more: marked closed at once, so a lead cannot list or answer it while the row is owed (promptRemoveFiles takes the marker away again).
      await promptMarkDone($, reqDir.dir, reqDir.id)
    } else await promptCleanup($, reqDir.dir, reqDir.id, tid ?? '')
  }
}

type WaitCtx = { sid: string; tid: string; id: string; nonce: string; dir: string; input: unknown; tool: string; cwd: string; home: string; p: { uid: number; root: string; own?: string }; started: number; row: Omit<pr.LedgerRow, 't' | 'kind'>; req: pr.Request; leadName?: string; cap?: { kind: pr.CapKind; target: string }; ecwd?: string; st: CloseState }

// The wait. Each poll: a click, the switch, the dialog's own row, the relay, expiry, then a decision file. The awake clock adds each gap,
// capped. A relay (a tier put the prompt to the person) makes the wait `withPerson`: expiry at 2 hours, a 10 s poll, and no 20-minute deny.
async function promptWait($: any, beneath: any, signal: AbortSignal, w: WaitCtx): Promise<any> {
  const end = async (kind: pr.RowKind, code?: string) => {
    const row = { ...w.row, kind, ...(code ? { code } : {}) }
    w.st.pending = row
    if (await ledgerAdd($, row)) w.st.closed = true
    return beneath
  }
  // The dialog counts as closed only once the own row has been seen waiting for this request and is then empty; a row that is missing or ambiguous is unknown.
  const clickSeen = async (): Promise<boolean> => {
    const rowNow = await promptOwnRow($, w).catch(() => undefined)
    if (!rowNow) return false
    const waiting = rowNow.status === 'waiting' && (rowNow.waitingFor ?? null) !== null
    if (waiting && typeof rowNow.statusUpdatedAt === 'number' && rowNow.statusUpdatedAt >= w.started) seenWaiting = true
    else if (seenWaiting && !waiting) return true
    return false
  }
  // The switch is read again at each poll and before an answer is returned: off, an OFF file, or a scope that no longer covers this lane ends the wait.
  const stillOn = async (): Promise<boolean> => {
    if (await promptsOff($)) return false
    const cv = await promptCoverage($, w.sid)
    // A question also needs the questions scope: off asks, or a questions scope that no longer covers the lane, ends a waiting question and leaves permission prompts alone.
    return cv !== undefined && pr.requestCovered(cv.a, { tool: w.tool }, { lane: cv.lane, lead: w.leadName, self: cv.self })
  }
  // What must hold right before an answer goes back: no click, the switch still on.
  const guards = async (): Promise<any | undefined> => {
    if (signal.aborted || doneIds.has(w.tid)) return end('superseded')
    if (!(await stillOn())) return end('off')
    // Live test A, 4c: the person's Yes can land in the moments the decision was being checked, and the engine sends the hook no signal for it. The dialog's own
    // row is read once more right before the answer goes back, so a click already on it wins; one that has not reached the row yet is a lost race (README).
    if (await clickSeen()) return end('superseded')
    return undefined
  }
  const relayPath = `${w.dir}/${w.id}.relay.json`
  const askedPath = `${w.dir}/${w.id}.asked`
  const leftPath = `${w.dir}/${w.id}.left`
  // The relay file as it is now: none, a good one for this request, or a file that is there and is not (taken as lost).
  const readRelay = async (): Promise<pr.Relay | 'bad' | undefined> => {
    if ((await statR($, relayPath)) === 'absent') return undefined
    const r = await readSmallR($, relayPath, w.p.uid, pr.DECISION_MAX)
    // A read that failed or met a swap says nothing about the file: this poll keeps the relay it had (as a decision file read that fails is skipped).
    if (r.state === 'failed' || r.state === 'changed') return relay ?? undefined
    if (r.state !== 'ok') return 'bad'
    const x = pr.parseRelay(r.text)
    return x && x.id === w.id && x.nonce === w.nonce ? x : 'bad'
  }
  let last = await $.clock.now()
  let awake = pr.awakeAdd(0, last - w.started)
  let seenWaiting = false
  let lagSince: number | undefined
  let lastDrop = ''
  let relay: pr.Relay | undefined
  let relayFrom = 0
  let askedSeen = false
  let noCount = 0
  let presenceAt = 0
  // A relay whose question the person had on screen (asked) never ends in the 20-minute deny, even if it is lost later: the prompt stays in the dialog (expired at 21 minutes).
  let personSaw = false
  const relayLost = async (code: string): Promise<void> => {
    const r = relay
    if (askedSeen) personSaw = true
    if (!(await ledgerAdd($, { ...w.row, kind: 'relay-lost', code, ...(r ? { short: r.short, by: r.by.sid, tier: r.by.level } : {}) }))) return
    await rmF($, [relayPath, askedPath, leftPath])
    relay = undefined
    askedSeen = false
  }
  for (;;) {
    if (signal.aborted || doneIds.has(w.tid)) return end('superseded')
    // The request file is gone (the sweep closed it): the sweep's row is the closing one, and the dialog is left to the person.
    if ((await statR($, `${w.dir}/${w.id}.request.json`)) === 'absent') {
      w.st.closed = true
      return beneath
    }
    // Off stops the wait whichever way it was turned off: the emergency file or /callboard escalation off.
    if (!(await stillOn())) return end('off')
    if (await clickSeen()) return end('superseded')
    // The relay: a tier has put the prompt to the person. It is lost when its question is never asked, or its tier is not live for two checks in a row;
    // it ends with `relay-left` when the person dismissed the question.
    const rf = await readRelay()
    if (rf === 'bad') {
      relay = undefined
      await relayLost('bad-file')
    } else {
      if (rf && !relay) {
        relayFrom = awake
        presenceAt = awake
        noCount = 0
        askedSeen = false
      }
      relay = rf
    }
    if (relay) {
      if ((await statR($, leftPath)) !== 'absent') return end('abandoned', 'relay-left')
      if (!askedSeen) askedSeen = (await statR($, askedPath)) !== 'absent'
      // A decision already in (the person answered between two polls, which spent the mark) is applied below, not lost.
      if (!askedSeen && awake - relayFrom >= pr.ASKED_WAIT_MS && (await statR($, `${w.dir}/${w.id}.decision.json`)) === 'absent') await relayLost('not-asked')
      else if (awake - presenceAt >= 60_000) {
        presenceAt = awake
        const step = pr.relayLostStep(noCount, await promptRelayTierSeen($, w.p, relay.by))
        noCount = step.noCount
        if (step.lost) await relayLost('tier-gone')
      }
    }
    const withPerson = relay !== undefined
    if (awake >= pr.expiresAfter(withPerson)) return end('abandoned', 'expired')
    const df = await readSmallR($, `${w.dir}/${w.id}.decision.json`, w.p.uid, pr.DECISION_MAX)
    // A decision that is dropped (its row is written) is taken away: a file left in place would make every tier's answer and pass-up 'decided', and hide the request
    // from prompt_list and the notice, so no tier could act on it again and the wait would end in the 20-minute deny.
    const takeAway = async () => void (await rmF($, `${w.dir}/${w.id}.decision.json`))
    if (df.state === 'bad' && (await statR($, `${w.dir}/${w.id}.decision.json`)) !== 'absent') {
      if (lastDrop !== 'file') {
        lastDrop = 'file'
        await ledgerAdd($, { ...w.row, kind: 'dropped', code: 'file' })
      }
      await takeAway()
    }
    if (df.state === 'ok') {
      const d = pr.parseDecision(df.text)
      if (!d) {
        if (lastDrop !== 'shape') {
          lastDrop = 'shape'
          await ledgerAdd($, { ...w.row, kind: 'dropped', code: 'shape' })
        }
        await takeAway()
      } else {
        const applied = await promptApply($, w, d, awake, lagSince === undefined ? 0 : awake - lagSince)
        const out = applied.out
        if ('hold' in out) {
          if (out.hold === 'ledger') lagSince ??= awake
        } else if ('drop' in out) {
          if (lastDrop !== out.drop) {
            lastDrop = out.drop
            await ledgerAdd($, { ...w.row, kind: 'dropped', code: out.drop })
          }
          await takeAway()
        } else {
          // The decision stands, unless a click or the switch got there first meanwhile.
          const stop = await guards()
          if (stop !== undefined) return stop
          // A relay that landed while the decision was being checked still wins: an agent's decision is not returned over the person's open question. The person's own
          // answer (via person) is the one decision a relay lets through.
          if (d.via !== 'person' && (await statR($, relayPath)) !== 'absent') {
            // The relay is read at the next poll.
          } else if (d.decision === 'answer' && d.answer !== undefined) {
            // A question's answer: built here from the LIVE input, never from the decision file, and returned as an allow with `answers` filled in. A click, the
            // switch and the done events were looked at by guards() just above (a click fires no abort, so clickSeen and doneIds must stay).
            const answered = await promptReturnAnswer($, w, d, d.answer.index, applied.tier, relay?.short)
            if (answered === undefined) return beneath
            return { ...(beneath && typeof beneath === 'object' ? beneath : {}), decision: answered }
          } else {
            const back = { ...w.row, kind: 'returned' as const, code: d.decision, why: d.why, tier: d.by.level, by: d.by.sid, ...(d.via ? { via: d.via, ...(relay ? { short: relay.short } : {}) } : {}), tuid: w.tid, ...(w.cap ? { cap: w.cap.kind, target: w.cap.target } : {}) }
            w.st.pending = { ...w.row, kind: 'abandoned', code: 'hook-failed' }
            if (!(await ledgerAdd($, back))) return beneath
            w.st.closed = true
            const unclear = d.decision === 'deny' && d.via !== 'person' && pr.isUnclear(d.why)
            const text = d.via === 'person' ? `Denied by the person via the ${d.by.level} ${d.by.name}.` : `Denied by the ${d.by.level} ${d.by.name}: ${d.why}`
            // The cleaner-command text is appended after the cap, so a long reason or name never cuts it off.
            const message = pr.capBytes(pr.redact(text), 300).text + (unclear ? pr.UNCLEAR_SUFFIX : '')
            const decision = d.decision === 'allow' ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message }
            return { ...(beneath && typeof beneath === 'object' ? beneath : {}), decision }
          }
        }
      }
    }
    // The 20-minute deny: nobody answered and nobody put it to the person. Some tier was in reach when the request began (the hook did not start the wait otherwise).
    // A question is never denied for lateness (a denied question loops the lane or pushes it to guess): the wait ends at 21 minutes and the card stays with the person.
    if (!relay && !personSaw && w.tool !== pr.QUESTION_TOOL && awake >= pr.DENY_AFTER_MS && (await statR($, relayPath)) === 'absent') {
      const stop = await guards()
      if (stop !== undefined) return stop
      w.st.pending = { ...w.row, kind: 'abandoned', code: 'hook-failed' }
      if (!(await ledgerAdd($, { ...w.row, kind: 'expired-denied', code: 'timeout' }))) return beneath
      w.st.closed = true
      return { ...(beneath && typeof beneath === 'object' ? beneath : {}), decision: { behavior: 'deny' as const, message: pr.DENY_TIMEOUT_MESSAGE } }
    }
    if (!(await pause($, pr.pollFor(withPerson)))) return signal.aborted ? end('superseded') : end('abandoned', 'hook-failed')
    const now = await $.clock.now()
    awake = pr.awakeAdd(awake, now - last)
    last = now
  }
}

// One check of the relaying tier's presence, for relayLostStep: its presence file of the same level passes every check ('yes'), fails one ('no'), or a check could not be
// made ('error').
async function promptRelayTierSeen($: any, p: { uid: number; root: string }, by: pr.Relay['by']): Promise<'yes' | 'no' | 'error'> {
  try {
    const live = await registryEntries($)
    if (!live) return 'error'
    const r = await presenceCheck($, p, live, by.sid, (f) => f.level === by.level)
    return typeof r === 'string' ? r : 'yes'
  } catch {
    return 'error'
  }
}

// Every check a decision must pass, each failure a `dropped <code>` row and the wait going on (pr.applyCheck holds the order and the codes).
async function promptApply($: any, w: WaitCtx, d: pr.Decision, awake: number, graceMs: number): Promise<{ out: pr.ApplyOut; tier?: pr.Tier }> {
  let liveHash = ''
  try {
    liveHash = await sha($, pr.canonical(w.input))
  } catch {}
  const fo = await promptFloorOpts($, w.tool, w.input, w.ecwd ?? w.cwd, w.home, w.ecwd !== undefined, w.req.level === 'lane' && w.req.lane !== undefined ? { lane: w.req.lane, sid: w.sid } : undefined)
  let byOk = false
  // The tier of the presence-checked stand that matches the decision's author: the name an answer prints comes from here, never from the decision file.
  let tier: pr.Tier | undefined
  let relay: { sid: string; nonce: string } | undefined
  // A lookup that could not be made (the registry, a presence file, ps) is no verdict on the author or the relay.
  let unsure = false
  const errsBefore = mem.presenceErrors
  if (c.SID_RE.test(d.by.sid) && d.by.sid !== w.sid) {
    const live = await registryEntries($)
    const cv = await promptCoverage($, w.sid)
    if (live && cv) {
      const names = new Set(((await $.fs.list(w.dir).catch(() => [])) as { name: string }[]).map((f) => f.name))
      const stand = await promptStand($, w.p, live, cv.a, w.dir, names, w.req).catch(() => undefined)
      if (stand) {
        // The author is a live tier in reach of this asker that has not passed the request up, and its level is the one its presence gives (never the decision's own).
        tier = stand.tiers.find((t) => t.sid === d.by.sid && t.level === d.by.level)
        byOk = tier !== undefined && stand.passed[d.by.level as pr.TierLevel] === undefined
        if (stand.relay) relay = { sid: stand.relay.by.sid, nonce: stand.relay.nonce }
      } else unsure = true
    } else unsure = true
    if (mem.presenceErrors !== errsBefore) unsure = true
  }
  // A question's answer binds to its row by option and label hash; a hash that cannot be made is an unreadable ledger (held for the next poll), not a drop.
  const lh = d.decision === 'answer' && d.answer ? await labelHash($, w.id, d.answer.label).catch(() => undefined) : undefined
  const ledger = d.decision === 'answer' && d.answer && lh === undefined ? 'unreadable' : await ledgerHas($, w.p, w.id, w.nonce, { code: d.decision, by: d.by.sid, ...(d.via ? { via: d.via } : {}), ...(d.answer && lh !== undefined ? { opt: String(d.answer.index), lh } : {}) })
  // Only a call that carries an `@claude` body, and only once the other checks would let the decision through, reads the cap.
  const cap = w.cap && ledger === 'found' && d.decision === 'allow' && d.via !== 'person' ? await capOf($, w.p, w.cap) : undefined
  const out = pr.applyCheck({ req: w.req, decision: d, liveHash, awakeMs: awake, expiresAt: pr.expiresAfter(relay !== undefined), floor: pr.floorCheck(w.tool, w.input, fo), byOk, ...(relay ? { relay } : {}), ...(w.tool === pr.QUESTION_TOOL ? { question: { labels: pr.questionLabels(w.input) } } : {}), ledger, graceMs, cap })
  // The two drops that rest on those lookups are held for the next poll when one failed; the final codes (id, hash, nonce, expired, floor, cap) never are.
  return unsure && 'drop' in out && (out.drop === 'by-sid' || out.drop === 'relay') ? { out: { hold: 'lookup' } } : { out, ...(tier ? { tier } : {}) }
}

// The answer of a question, once every check has passed: the `returned` row first (it is the record), then the questions row, then the allow with the live label. The text is
// the trimmed LIVE label of the chosen option, plus `(answered by <level NAME>)` for a tier; the person's own pick through the relay is the bare label. Keyed by the live
// question text. undefined: the row could not be written, so nothing is returned and the card stays.
async function promptReturnAnswer($: any, w: WaitCtx, d: pr.Decision, index: number, tier: pr.Tier | undefined, short?: string): Promise<{ behavior: 'allow'; updatedInput: unknown } | undefined> {
  const live = (w.input as { questions?: { question?: unknown; header?: unknown; options?: { label?: unknown }[] }[] } | undefined)?.questions?.[0]
  const liveRaw = typeof live?.options?.[index]?.label === 'string' ? (live.options[index].label as string).trim() : undefined
  const labels = pr.questionLabels(w.input)
  if (liveRaw === undefined || typeof live?.question !== 'string' || labels[index] === undefined) return undefined
  const lh = await labelHash($, w.id, labels[index]).catch(() => undefined)
  if (lh === undefined) return undefined
  const back = { ...w.row, kind: 'returned' as const, code: 'answer', why: d.why, tier: d.by.level, by: d.by.sid, opt: String(index), lh, ...(d.via ? { via: d.via, ...(short ? { short } : {}) } : {}), tuid: w.tid }
  w.st.pending = { ...w.row, kind: 'abandoned', code: 'hook-failed' }
  if (!(await ledgerAdd($, back))) return undefined
  w.st.closed = true
  const viaPerson = d.via === 'person'
  await questionsAdd($, { id: w.id, ...(w.req.lane !== undefined ? { lane: w.req.lane } : {}), repo: w.cwd, tier: d.by.level, by: d.by.sid, header: typeof live.header === 'string' ? live.header : '', question: live.question, options: labels, label: labels[index], ...(viaPerson ? { via: 'person' as const } : {}) })
  const text = pr.answerText(liveRaw, tier, viaPerson)
  return { behavior: 'allow', updatedInput: { ...(w.input as object), answers: { [live.question]: text } } }
}

// The light link: an AskUserQuestion of this tier's own session has ended. For each question headed `Relay <short>` that names a relay of this session,
// the person's answer exactly `Yes` or `No` becomes the decision (written here, by the mod, with `via: person`); a dismissal or any other answer is `relay-left`; one for
// a prompt that has closed, or whose decision is already in, is `relay-late` and the tier is told in one fixed line. The question's wording is never read.
export async function promptRelayPost($: any, e: any): Promise<string | undefined> {
  if (String(e?.tool_name) !== 'AskUserQuestion' || (typeof e?.agent_id === 'string' && e.agent_id !== '')) return undefined
  // The questions as asked: the call's input, or (probed on the engine) the response, which repeats them with their headers.
  const qin = Array.isArray(e.tool_input?.questions) ? e.tool_input : e.tool_response && typeof e.tool_response === 'object' ? e.tool_response : e.tool_input
  const shorts = relayShorts(qin)
  if (shorts.length === 0) return undefined
  const sid = await $.session.id()
  const p = await where($)
  if (!c.SID_RE.test(sid) || !p) return undefined
  // The question is over, whatever the answer: this tier is free for new requests.
  // Whatever the memory holds: a reload while the question was open leaves the file with nothing marking it.
  await promptAskingClear($, sid, true)
  const open = await promptOpenRelays($, p, sid)
  let late = false
  const leftLines: string[] = []
  // Each open relay's request is read BEFORE its answer is judged, so the answer is read by the kind of the request (a permission prompt: Yes or No; a question: one of the lane's
  // labels). A relay whose request cannot be read, or is not the one the relay names, is left out: it reads as unknown, which is `relay-late` (closed), whatever the answer was.
  const kinds: pr.RelayOpen[] = []
  for (const r of open.filter((x) => shorts.includes(x.relay.short))) {
    const rr0 = await readSmallR($, `${r.dir}/${r.relay.id}.request.json`, p.uid, pr.REQUEST_MAX)
    const q0 = rr0.state === 'ok' ? pr.parseRequest(rr0.text) : undefined
    if (!q0 || q0.id !== r.relay.id || q0.nonce !== r.relay.nonce) continue
    kinds.push(q0.tool === pr.QUESTION_TOOL ? { id: r.relay.id, short: r.relay.short, kind: 'question', labels: pr.questionLabels(q0.input) } : { id: r.relay.id, short: r.relay.short, kind: 'permission' })
  }
  for (const a of pr.relayAnswers(qin, e.tool_response, kinds)) {
    const r = open.find((x) => x.relay.id === a.id)
    if (a.outcome === 'unknown' || !r) {
      late = true
      const rows = await ledgerRowsFor($, p, `"short":"${a.short}"`)
      const was = rows === 'unreadable' ? undefined : rows.find((x) => x.kind === 'relayed' && x.short === a.short && x.by === sid)
      await ledgerAdd($, { kind: 'relay-late', short: a.short, by: sid, code: 'closed', ...(was?.id ? { id: was.id } : {}) })
      continue
    }
    const { dir, relay } = r
    const id = relay.id
    if (a.outcome === 'left') {
      if ((await promptLinkOnce($, `${dir}/${id}.left`, '{}')) === 'ok') await ledgerAdd($, { kind: 'relay-left', id, short: relay.short, by: sid, tier: relay.by.level })
      // A question relay that landed nothing (typed Other, or a label that is not the lane's): the tier would read "User answered: ..." and think it is done.
      if (a.kind === 'question') leftLines.push(pr.relayLeftLine(relay.short))
      continue
    }
    // The answer counts only for a question the mod saw raise its permission request with nothing beneath answering it (the asked mark): else nothing lands and the tier is told.
    if ((await statR($, `${dir}/${id}.asked`)) === 'absent') {
      late = true
      await ledgerAdd($, { kind: 'relay-late', id, short: relay.short, by: sid, tier: relay.by.level, code: 'not-asked' })
      continue
    }
    const rr = await readSmallR($, `${dir}/${id}.request.json`, p.uid, pr.REQUEST_MAX)
    const q = rr.state === 'ok' ? pr.parseRequest(rr.text) : undefined
    const lateRow = async () => {
      late = true
      await ledgerAdd($, { kind: 'relay-late', id, short: relay.short, by: sid, tier: relay.by.level, code: q ? 'decided' : 'closed' })
    }
    if (!q || q.id !== id || q.nonce !== relay.nonce) {
      await lateRow()
      continue
    }
    const now = await $.clock.now()
    const who = relay.by.name === '' ? relay.by.level : relay.by.name
    // A question's pick is an answer by the request's own index (never the relay question's order); its label is the request's, as the tier read it.
    const label = a.outcome === 'answer' && a.index !== undefined ? pr.questionLabels(q.input)[a.index] : undefined
    if (a.outcome === 'answer' && (q.tool !== pr.QUESTION_TOOL || a.index === undefined || label === undefined)) {
      await lateRow()
      continue
    }
    const why = (a.outcome === 'answer' ? `the person picked option ${(a.index as number) + 1} via the ${relay.by.level} ${who}` : `the person answered ${a.outcome === 'allow' ? pr.RELAY_YES : pr.RELAY_NO} via the ${relay.by.level} ${who}`).slice(0, pr.WHY_MAX)
    // The label hash first: a hash that cannot be made leaves no decision file without its row.
    const lh = label !== undefined ? await labelHash($, id, label).catch(() => undefined) : undefined
    if (label !== undefined && lh === undefined) {
      await lateRow()
      continue
    }
    const path = `${dir}/${id}.decision.json`
    const body = JSON.stringify({ id, inputHash: q.inputHash, decision: a.outcome, ...(label !== undefined ? { answer: { index: a.index, label } } : {}), why, by: { level: relay.by.level, sid, name: who }, via: 'person', at: now, nonce: q.nonce })
    let put = await promptLinkOnce($, path, body)
    if (put === 'exists') {
      // An agent's decision that was written before the relay (and is not applied under it) gives way to the person's; the person's own earlier answer does not.
      const old = await readSmallR($, path, p.uid, pr.DECISION_MAX)
      const od = old.state === 'ok' ? pr.parseDecision(old.text) : undefined
      if (od && od.via !== 'person') {
        await rmF($, path)
        put = await promptLinkOnce($, path, body)
      }
    }
    if (put !== 'ok') {
      await lateRow()
      continue
    }
    if ((await statR($, `${dir}/${id}.request.json`)) === 'absent') {
      await rmF($, path)
      await lateRow()
      continue
    }
    const ok = await ledgerAdd($, { id, nonce: q.nonce, lane: q.lane, repo: q.repo, tool: q.tool, pattern: pr.patternOf(q.tool, q.input, q.repo), hash: q.inputHash, tier: relay.by.level, why, kind: 'answered', code: a.outcome, by: sid, via: 'person', short: relay.short, ...(label !== undefined ? { opt: String(a.index), lh } : {}) })
    if (!ok) {
      await rmF($, path)
      late = true
    } else if (label !== undefined) {
      // The pick is the lane's own label text, which the tier reads as the person's answer: say what it is, so it is not taken for an instruction.
      leftLines.push(pr.relayPickLine(relay.short, q.lane ?? ''))
    }
  }
  // The mark is spent: a later question for the same relay needs a fresh one.
  await promptRelayAskedClear($, sid, shorts)
  const lines = [...(late ? [pr.RELAY_LATE_LINE] : []), ...leftLines]
  return lines.length > 0 ? lines.join('\n') : undefined
}

// The tick's sweep: a request whose session is gone, or older than a day, is closed with a row and its files removed. No process call unless a prompts folder is there.
export async function promptSweep($: any): Promise<void> {
  const now = await $.clock.now()
  if (now - mem.lastSweepAt < SWEEP_EVERY_MS) return
  mem.lastSweepAt = now
  const p = await where($)
  if (!p) return
  const base = `${p.root}/prompts`
  await questionsPrune($, p).catch(() => undefined)
  await promptSweepAsking($, base)
  const all = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).sort((a, b) => (a.name < b.name ? -1 : 1))
  if (all.length === 0) return
  // At most SWEEP_DIRS_MAX folders a tick, taking up where the last tick stopped, so every folder is reached however many there are.
  if (mem.sweepFrom >= all.length) mem.sweepFrom = 0
  const dirs = all.slice(mem.sweepFrom, mem.sweepFrom + SWEEP_DIRS_MAX)
  mem.sweepFrom = mem.sweepFrom + SWEEP_DIRS_MAX >= all.length ? 0 : mem.sweepFrom + SWEEP_DIRS_MAX
  const live = await registryEntries($)
  const busy = new Set([...openReqs.values()].flatMap((o) => (o.id ? [o.id] : [])).concat([...unclosed.keys()]))
  for (const d of dirs) {
    const files = (await $.fs.list(`${base}/${d.name}`).catch(() => [])) as { name: string; mtimeMs?: number }[]
    const gone = live !== undefined && !live.some((r) => r.j.sessionId === d.name)
    // A request older than a day is abandoned only if no live process of that session still holds it: the wait runs on awake time, so a long sleep ages the file, not the prompt.
    const heldByLive = async (name: string): Promise<boolean> => {
      const r = await readSmallR($, `${base}/${d.name}/${name}`, p.uid, pr.REQUEST_MAX)
      if (r.state !== 'ok') return false
      try {
        const q = JSON.parse(r.text)
        return (live ?? []).some((x) => x.j.sessionId === d.name && String(x.j.pid) === String(q?.pid) && x.j.procStart === q?.procStart)
      } catch {
        return false
      }
    }
    const requests = new Set(files.flatMap((f) => (/^[0-9a-f-]{36}\.request\.json$/.test(f.name) ? [f.name.slice(0, 36)] : [])))
    for (const f of files) {
      const old = typeof f.mtimeMs === 'number' && now - f.mtimeMs > pr.SWEEP_MS
      const m = /^([0-9a-f-]{36})\.request\.json$/.exec(f.name)
      if (m) {
        if (!c.SID_RE.test(m[1]) || busy.has(m[1])) continue
        if (!gone && (!old || live === undefined || (await heldByLive(f.name)))) continue
        // No row, no removal: the next sweep tries again.
        if (!(await ledgerAdd($, { kind: 'abandoned', code: gone ? 'session-gone' : 'swept', id: m[1] }))) continue
        await promptRemoveFiles($, `${base}/${d.name}`, m[1])
        continue
      }
      // A file whose request is gone (a crash between the two removals, or a half-written copy), a day old: removed with no row, it names no open request.
      const o = /^([0-9a-f-]{36})\.(decision\.json|done|escalate(?:-lead|-conductor|-manager)?\.json|relay\.json|asked|left)$/.exec(f.name)
      const orphan = (o !== null && c.SID_RE.test(o[1]) && !requests.has(o[1]) && !busy.has(o[1])) || /^[0-9a-f-]{36}\.[A-Za-z.-]+\.\d+\.tmp$/.test(f.name)
      if (orphan && old) await rmF($, `${base}/${d.name}/${f.name}`)
    }
    // A folder of a session that has ended, with nothing left in it, goes too (rmdir refuses a folder that holds anything).
    if (gone && files.length === 0) await run($, [RMDIR, '--', `${base}/${d.name}`]).catch(() => undefined)
  }
}

// The questions file's 90-day prune, at most once a day per process, from the sweep. By file name: a file whose month ended before the cut is removed; the one file
// the cut falls inside is rewritten without its old rows (filter, temp file, mv); appends go only to the current month's file, so a prune never touches a file being appended to.
// Two processes pruning at once are kept apart by a lock folder (one more than a day old is taken over).
const QUESTIONS_PRUNE_EVERY_MS = 24 * 3_600_000

const QUESTIONS_FILE_MAX = 4 * 1024 * 1024
async function questionsPrune($: any, p: { uid: number; root: string }): Promise<void> {
  const now = await $.clock.now()
  if (mem.lastQuestionsPruneAt !== 0 && now - mem.lastQuestionsPruneAt < QUESTIONS_PRUNE_EVERY_MS) return
  mem.lastQuestionsPruneAt = now
  const base = `${p.root}/prompts`
  const entries = ((await $.fs.list(base).catch(() => [])) as { name: string; mtimeMs?: number }[])
  const todo = entries.map((f) => ({ name: f.name, kind: pr.questionsPruneKind(f.name, now) })).filter((f) => f.kind !== 'keep')
  if (todo.length === 0) return
  const lock = `${base}/questions.prune.lock`
  let got = (await run($, [MKDIR, '-m', '700', lock])).exitCode === 0
  if (!got) {
    const held = entries.find((f) => f.name === 'questions.prune.lock')
    if (held && typeof held.mtimeMs === 'number' && now - held.mtimeMs > QUESTIONS_PRUNE_EVERY_MS) {
      await run($, [RMDIR, '--', lock]).catch(() => undefined)
      got = (await run($, [MKDIR, '-m', '700', lock])).exitCode === 0
    }
  }
  if (!got) return
  try {
    for (const f of todo) {
      const path = `${base}/${f.name}`
      if (f.kind === 'remove') {
        await rmF($, path)
        continue
      }
      const r = await readSmallR($, path, p.uid, QUESTIONS_FILE_MAX)
      if (r.state !== 'ok') continue
      const kept = pr.questionsRewrite(r.text, now)
      if (kept === '') await rmF($, path)
      else await promptPut($, path, kept)
    }
  } finally {
    await run($, [RMDIR, '--', lock]).catch(() => undefined)
  }
}

// The `asking` files (a tier with a relay question open) of sessions that have ended go with them. A live session's file stays: it lives as long as its question.
async function promptSweepAsking($: any, base: string): Promise<void> {
  const files = ((await $.fs.list(`${base}/asking`).catch(() => [])) as { name: string }[]).filter((f) => c.SID_RE.test(f.name)).slice(0, 64)
  if (files.length === 0) return
  const live = await registryEntries($)
  if (!live) return
  for (const f of files) if (!live.some((r) => r.j.sessionId === f.name)) await rmF($, `${base}/asking/${f.name}`)
}

// ---- prompt answering (ADR 0004): see promptHook ----
// tool.check returns the engine's verdict unchanged, every time (F-C: a mod's tool.check can pierce a deny rule, so callboard's never changes one).
export async function toolCheck($: any, e: any, next: any) {
  const r = await next(e)
  await promptObserve($, e, r).catch(() => undefined)
  return r
}

export async function permissionRequest($: any, e: any, next: any) {
  // The dialog of a subagent's ask is shown only after the hooks return, so a wait would hide it from the person. Its ask stays his:
  // the chain beneath at once, with no request file, no wait and no notice.
  const agent = (e as { agent_id?: unknown }).agent_id
  if (typeof agent === 'string' && agent !== '') return next(e)
  let once: Promise<any> | undefined
  const nextOnce = (x: any) => (once ??= Promise.resolve(next(x)))
  try {
    return await promptHook($, e, nextOnce, next.signal)
  } catch {
    // A failing hook answers nothing: the dialog stays.
    return nextOnce(e)
  }
}
