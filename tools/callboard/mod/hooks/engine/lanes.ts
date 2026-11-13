// Lane binding, birth, rebind, cue handling, the stops (retire, terminate, park) and the lane tools.
// Trust rules held here: a session is a lane or a lead, never both; a stop is re-checked after the click and right before the signal (idle, signed report, pid and start time).
import type { Request } from '../../types'
import * as c from '../core.ts'
import {
  laneBrief,
  laneBriefed,
  watch,
  grants,
  laneObs,
  leadToolsInFlight,
  leadDeclared,
  lastTurnUnknown,
  boundLane,
  laneBinding,
  takenSwept,
  pendingRename,
  sidSynced,
  rebindPending,
  offSeq,
  leadRestorePending,
  conductorRestorePending,
  restoredOnce,
  rebound,
  conductorDeclared,
  managerDeclared,
  lastSaved,
  signalledCalls,
  mem,
} from '../mem.ts'
import {
  logq,
  sha,
  where,
  askOnce,
  timedOut,
  log,
  facts,
  run,
  STAT,
  STAT_FMT,
  real,
  REALPATH,
  HEAD,
  withTimeout,
  submitOwn,
  logFail,
  dirOk,
  MV,
  RM,
  toast,
  ACTION_TIMEOUT_MS,
  pause,
  gitRoot,
  psStart,
  psArgs,
  ask,
  KILL,
} from './base.ts'
import {
  registryEntries,
  editStore,
  loadLanes,
  registryOf,
  liveNames,
  idleCheck,
  regOnce,
  registryEntriesWhy,
  loadStores,
  cueExchange,
  keptLanes,
  writeBrief,
  resultDirOk,
  writeIn,
  readAnswer,
} from './store.ts'
import type { Reg, RegRow, Answer } from './store.ts'
import {
  leadsFor,
  briefOnce,
  presenceTouch,
  watchPoll,
  regEntry,
  presenceHeld,
  ownWrite,
  epochOf,
  grantOf,
  homeOf,
  leadReason,
  leadBusy,
  leadHere,
  managerTrusted,
  conductorsTrusted,
  pinOf,
  conductorReach,
  conductorsLive,
  leadsInReach,
  claimLanes,
  reservedGet,
  findLead,
  psOne,
} from './grants.ts'
import { dropRequest, doCompact, isEligible, leadNudge, busyAgents, backgroundShells, counts, bump, interactive, saveHint } from './compaction.ts'
import { ensureTimer } from './tick.ts'

const lane = { plugin: 'callboard', key: 'lane' } as const
const lastTurn = { plugin: 'callboard', key: 'lastTurnAt' } as const
// $.state keys declared again where they are used: `claude plugin validate` reads a key in the file that uses it.
const seen = { plugin: 'callboard', key: 'seen' } as const
const request = { plugin: 'callboard', key: 'request' } as const

const stopCallKey = (sid: string, verb: string, lane: unknown) => `${sid}\n${verb}\n${String(lane)}`

// ---- the lane's briefing (c.laneBriefing) ----
// The facts of a binding just written, kept at once without a lead; then the lead. Only a lead with a valid presence file for the lane's own repo counts (never
// one of a parent repo, nor any lead of a lane with no repo): for a record naming its lead, the live lead with that registry name and no other; else the
// lead session id the record holds (`leadSid` of a made one, then the one the caller passes: an attached record's `lead` or the rename cue's), else the one
// lead of that repo. It is named only as c.laneLeadOf allows. The lead is added only to the entry
// this call kept, so a detach meanwhile leaves nothing behind. A failure keeps the generic lead wording and is logged as lane-lead; c.laneBriefing checks
// every field again.
export async function keepLaneFacts($: any, sid: string, l: c.Lane, attached: boolean, leadSid: string | undefined, reg: Reg = () => registryEntries($)) {
  const base: c.LaneFacts = { name: l.name, sid, folder: l.folder, report: c.reportPath(l), attached }
  laneBrief.set(sid, base)
  try {
    if (!l.repo) return
    const live = await reg()
    if (!live) return
    const leads = await leadsFor($, live, l.folder, l.repo)
    const rows = live.map((r) => r.j)
    const ownSid = l.leadSid ?? leadSid
    const lead = l.leadName !== undefined ? leads.find((x) => c.leadNameOf(rows, x.sid) === l.leadName) : ownSid !== undefined ? leads.find((x) => x.sid === ownSid) : leads.length === 1 ? leads[0] : undefined
    const known = lead ? c.laneLeadOf(rows, lead.sid) : undefined
    if (known && laneBrief.get(sid) === base) laneBrief.set(sid, { ...base, lead: known })
  } catch {
    await logq($, sid, 'error', 'lane-lead')
  }
}

// The briefing as one user-role note, at attach and restore only: a born lane has had no request yet, so its first one (the start prompt) carries the section, and
// a note there could count as a turn and make lane_start refuse not-empty. As briefLead: the mark is set before the await, and a refused or failed append is logged
// as lane-briefing and changes nothing else.
export async function briefLane($: any, sid: string) {
  const kept = laneBrief.get(sid)
  const note = kept && c.laneBriefingNote(kept)
  if (!kept || !note) return
  await briefOnce($, sid, laneBriefed, kept.name, () => note, 'lane-briefing')
}

// Every lead tool call (it runs the tool's body through this) refreshes the presence file first and, once, tells the lead the lane list changed since its last lane tool call.
export async function leadRun($: any, e: unknown, body: () => Promise<any>) {
  const sid = await $.session.id()
  await presenceTouch($, sid).catch(() => undefined)
  await watchPoll($, sid).catch(() => undefined)
  const w = watch.get(sid)
  // Only a call that is served to the main agent of a lead that is on tells it anything: a refused one (a subagent, tools off) leaves the news for later.
  const served = grants.has(sid) && (e as { agentId?: string }).agentId === undefined
  const moved = served && !!w && w.cur !== w.seen
  // What the lead is told by this call (or looks at in it) needs no notice of its own; a change that lands while the body runs is news again.
  if (served && w) w.seen = w.told = w.cur
  const out = await body()
  // The lead acted on that lane itself (a served call that succeeded), so what the check-in saw of it starts over.
  if (served && typeof out?.result === 'string' && OBS_CLEAR_TOOLS.includes(String((e as { tool?: unknown }).tool))) laneObs.get(sid)?.delete(String((e as { lane?: unknown }).lane))
  if (!moved || !out) return out
  // A lane_list text ends in a table, so the note goes after a blank line, never on a table row.
  return typeof out.result === 'string' ? { ...out, result: `${out.result}${out.result.includes('\n| ') ? '\n\n' : ' '}${c.LANES_CHANGED_NOTE}` } : typeof out.deny === 'string' ? { ...out, deny: `${out.deny} ${c.LANES_CHANGED_NOTE}` } : out
}

export function leadToolsOnce($: any, sid: string): Promise<void> {
  let p = leadToolsInFlight.get(sid)
  if (!p) {
    p = leadTools($, sid).finally(() => leadToolsInFlight.delete(sid))
    leadToolsInFlight.set(sid, p)
  }
  return p
}
async function leadTools($: any, sid: string) {
  if (leadDeclared.has(sid)) return
  const text = { type: 'string' }
  for (const verb of c.LEAD_VERBS) {
    await $.tool.register({
      name: `lane_${verb}`,
      description:
        verb === 'rename'
          ? 'Bind a brand-new session to a lane: writes a rename cue for the session with this id. sid: its session id. lane: the lane name. The session must be in the lane folder, empty and unnamed, and less than 2 minutes old.'
          : verb === 'compact'
            ? "Ask the lane's session to compact. If it asked for that with request_compact on-cue, it compacts now; otherwise it orders the lane to compact: the plugin tells it to save its notes and call request_compact on-cue, whatever its context size, and it compacts at the end of that turn. lane: the lane name."
            : `Cue the lane's session to ${verb}. lane: the lane name. The session applies its own limits. A start only works within 2 minutes of the session opening.`,
      inputSchema: {
        type: 'object',
        properties: verb === 'rename' ? { sid: text, lane: text } : { lane: text },
        required: verb === 'rename' ? ['sid', 'lane'] : ['lane'],
      },
    })
  }
  for (const verb of c.STOP_VERBS) {
    await $.tool.register({
      name: `lane_${verb}`,
      description:
        verb === 'terminate'
          ? "Stop the lane's session with SIGTERM, whatever it is doing. The person is asked to confirm every time. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and report stay; a lane a session joined keeps its record while a session carries it; a second stop removes it once the session is gone). A lane with no live session is removed directly. lane: the lane name."
          : verb === 'park'
            ? "Park the lane's session: stop it and close its tab, but keep the conversation. lane_unpark reopens it later. The session must confirm first: idle for 30 seconds, an empty prompt box, no background agents or shells. No report is needed; the lane's record stays, the only stop that keeps it. The call itself waits up to 40 seconds for the idle time, so call it right after the lane's last turn; if it still refuses not-idle, wait the seconds it names and try once, never in a loop. Works for lanes you made and lanes a session joined. lane: the lane name."
            : "Stop the lane's session once it confirms it can end: idle, empty prompt box, no background agents or shells, and the last line of <repo>/.archive/<LANE>/REPORT.md reads `status: done <its session id>` in a file newer than its last prompt. Does nothing otherwise. The call itself waits up to 40 seconds for the idle time, so call it right after the lane's last turn; if it still refuses not-idle, wait the seconds it names and try once, never in a loop. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and signed report stay; a lane a session joined keeps its record while a session carries it; a second stop removes it once the session is gone). A lane with no live session is removed directly, with no signed report. Retire is final: the conversation cannot be reopened with lane_unpark. Use lane_park for a lane you may need again, the only stop that keeps the lane. lane: the lane name.",
      inputSchema: { type: 'object', properties: { lane: text }, required: ['lane'] },
    })
  }
  await $.tool.register({
    name: 'lane_create',
    description:
      "Create a lane in the repo this lead was allowed in: name and task (what the lane should do: plain text, 1 to 8000 characters, newlines allowed). The mod writes the task to <folder>/.archive/<name>/BRIEF.md, which the lane reads as its first instructions. folder is optional: an absolute path to an existing folder inside the repo; the repo root by default. model is optional: opus, sonnet, haiku or fable, sonnet by default; the lane switches to it when it starts. No sudo needed. At most 16 lanes per repo and 12 creates an hour. Then lane_open, lane_rename with the session id it returns, and lane_start.",
    inputSchema: { type: 'object', properties: { name: text, task: text, folder: text, model: { type: 'string', enum: [...c.LANE_MODELS] } }, required: ['name', 'task'] },
  })
  await $.tool.register({
    name: 'lane_open',
    description:
      'Open a new panel in the lane folder (VS Code only) and return its session id. Then call lane_rename with that id and the lane, and lane_start. lane: the lane name. Refused when a live session already carries the lane name. Refused for a parked lane: use lane_unpark.',
    inputSchema: { type: 'object', properties: { lane: text }, required: ['lane'] },
  })
  await $.tool.register({
    name: 'lane_unpark',
    description:
      "Reopen a lane's saved conversation in its VS Code window, with its full history. Use it for a parked lane, or one whose session was closed. Not for a retired lane: retire is final, so lane_open starts a new conversation for it. The session becomes the lane again by itself within a few seconds; then call lane_resume. lane: the lane name.",
    inputSchema: { type: 'object', properties: { lane: text }, required: ['lane'] },
  })
  await $.tool.register({
    name: 'lane_list',
    description: 'List the lanes of the repo this lead was allowed in, as one table (a plain header line, then one row per lane with its lead, repo folder name, session and waiting columns; a lead no live session carries is marked not live): each lane, its folder when it is outside the repo root, whether a live session carries its name or it is parked, and how many minutes it has waited on a prompt. Call it when told the lanes changed.',
    inputSchema: { type: 'object', properties: {} },
  })
  // ADR 0004 (prompt answering): the three tools of every tier.
  await promptToolsRegister($)
  leadDeclared.add(sid)
}

// The three prompt tools, declared for a lead, a conductor and the manager alike (the handlers are shared; what a tier may do with a request depends on its place in
// the chain). They answer only while the person has turned escalation on.
export async function promptToolsRegister($: any) {
  const text = { type: 'string' }
  await $.tool.register({
    name: 'prompt_list',
    description: "List the permission prompts and the lane questions in your reach that are waiting for an answer: each one's id, lane, tool, how long it has been open, where it stands for you (whether you are the top tier, whether your window has opened) and its input (data from the lane, in an untrusted frame), then the rubric to judge it by. Call it when told a lane has a prompt waiting. Shows nothing while escalation is off.",
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'prompt_answer',
    description: "Answer one waiting prompt or question in your reach: id (from prompt_list), decision (allow or deny; for a question only `answer`, with option, the number shown in prompt_list, and optionally answer, that option's label) and why (one line, at most 200 characters, no data values). Your answer is yours, never the person's, and carries no approval for anything else. It lands once the prompt has been open 30 seconds; the person's click always wins. Allow only by the rubric; deny only if you are certain; a call you cannot follow whole (truncated, encoded, built at run time) is denied with the cleaner-command message, never allowed; a question is never denied or answered Other; otherwise prompt_escalate.",
    inputSchema: { type: 'object', properties: { id: text, decision: { type: 'string', enum: ['allow', 'deny', 'answer'] }, why: text, option: { type: 'integer', minimum: 1, maximum: 4 }, answer: text }, required: ['id', 'decision', 'why'] },
  })
  await $.tool.register({
    name: 'prompt_escalate',
    description: "Pass one waiting prompt up: id (from prompt_list) and why (one line, at most 200 characters). A tier that is not the top one passes it to the next tier. The top tier (the highest one live) puts it to the person instead: the result lists the steps (for a permission prompt a Haiku summary, then one AskUserQuestion headed `Relay <short>` with the options Yes and No; for a lane's question one AskUserQuestion headed `Relay <short>` whose options are exactly the lane's own labels, as prompt_list numbers them). Use it for anything you cannot judge from the rubric, at once.",
    inputSchema: { type: 'object', properties: { id: text, why: text }, required: ['id', 'why'] },
  })
}

// Whether a binding's stored record hash (rec) is this record's.
async function recMatch($: any, rec: string | undefined, l: c.Lane): Promise<boolean> {
  if (rec === undefined) return false
  return c.recOk(rec, await sha($, c.recordText(l)))
}

// lane_retire and lane_terminate delete the lane's record themselves. A lane is live when a registry row carries its
// name, or when its record names a session that has a live row under any name (renamed by hand, or opened and not yet renamed): name-in-use; a
// session holding a live presence file is target-is-lead. Used for a lane with no live session before anything is asked and again inside the store lock.
export async function laneLive($: any, live: RegRow[], l: { name: string; sid?: string }): Promise<string | undefined> {
  const entries = live.flatMap((r) => (typeof r.j.sessionId === 'string' ? [regEntry(r)] : []))
  if (entries.some((x) => x.name === l.name)) return 'name-in-use'
  if (l.sid !== undefined && (await presenceHeld($, live, l.sid))) return 'target-is-lead'
  if (l.sid !== undefined && entries.some((x) => x.sessionId === l.sid)) return 'name-in-use'
  return undefined
}

// One lane's record out of its store, in one editStore write wrapped in ownWrite (so the repo's lead still gets its lanes-changed notice). A lane a session
// joined (adopted) is removed only with no live session carrying it (mode idle), never right after a stop signalled one. mode idle: the lane has no live session; the record must still be the one the question or the report check saw (same
// session id, same parked state), no live session may carry it now (checked again on the records as they are, inside the lock), and the grant must still hold.
// mode stopped: the session got its signal; the record must name that session or none (the dying session may still carry the lane name for a moment).
// No stored field is added. { ok } when the record is gone, otherwise the refusal code.
type RemoveMode = { kind: 'idle'; sid: string | undefined; parked: boolean; seen: c.Lane; held: () => boolean } | { kind: 'stopped'; victim: string }
async function removeRecord($: any, e: unknown, me: string, key: string, name: string, mode: RemoveMode): Promise<{ ok: true } | { no: string; why?: string }> {
  const w = await ownWrite($, me, () => editStore(
    $,
    key,
    async (cur) => {
      const parsed = cur.state === 'ok' ? c.parseStore(cur.text) : undefined
      if (!parsed) return { no: 'store-unreadable' }
      if (!parsed.ok) return { no: parsed.reason }
      const rec = parsed.store.lanes.find((l) => l.name === name)
      if (!rec) return { no: 'unknown-lane' }
      // A stop that just signalled a session keeps a joined record (the caller never asks for it); with no session carrying it, laneLive below is the guard.
      if (rec.adopted && mode.kind === 'stopped') return { no: 'adopted-record' }
      if (mode.kind === 'stopped') {
        if (rec.sid !== undefined && rec.sid !== mode.victim) return { no: 'changed' }
      } else {
        if (rec.sid !== mode.sid || (rec.parked !== undefined) !== mode.parked) return { no: 'changed' }
        // The record the question or the check saw: not one remade under the name, nor one a claim re-pointed at another lead meanwhile.
        if (rec.leadName !== mode.seen.leadName || (rec.adopted === true) !== (mode.seen.adopted === true) || rec.lead !== mode.seen.lead || rec.leadSid !== mode.seen.leadSid) return { no: 'changed' }
        const rows = await registryEntries($)
        if (!rows) return { no: 'registry-unreadable', why: c.reasonWhy('registry-unreadable') }
        const live = await laneLive($, rows, rec)
        if (live) return { no: live, why: c.reasonWhy(live) }
        // The last check before the write.
        if (!mode.held()) return { no: 'grant-changed', why: c.reasonWhy('grant-changed') }
      }
      const left = parsed.store.lanes.filter((l) => l.name !== name).map(c.storeLaneJson)
      return { text: JSON.stringify({ repo: parsed.store.repo, lanes: left, creates: parsed.store.creates.slice(-12) }), landed: (st) => !!st && !st.lanes.some((l) => l.name === name) }
    },
    async () => {
      if (mode.kind === 'stopped') return undefined
      const again = await leadPrep($, e, me)
      if ('err' in again) return { no: again.err[0], why: again.err[1] }
      return again.lane.src === key ? undefined : { no: 'changed', why: c.reasonWhy('changed') }
    },
  )).catch(() => ({ no: 'store-busy' }))
  return 'no' in w ? w : { ok: true }
}

// A retire or a force stop of a lane no live session carries (never opened, crashed, stale, parked, or a lane a session joined whose session has gone): nothing
// runs, so the record is removed directly, an attached one too (the person's Join made it; its session is the only other way to detach it). lane_retire needs no signed report here (nothing runs, so there is no session to sign) and, at
// manager reach, asks as for a live lane; lane_terminate always asks the person (the remove question). Checked before the question and again after the click.
async function stopNoSession($: any, e: unknown, sid: string, verb: 'retire' | 'terminate', level: string | undefined, prep: { lane: c.Lane }, no: (reason: string, why: string) => Promise<{ deny: string }>, abandoned: () => boolean) {
  const l = prep.lane
  if (l.src === undefined || l.repo === undefined) return no('no-live-session', c.reasonWhy('no-live-session'))
  const epoch = epochOf(sid)
  const held = () => grantOf(sid)?.level === level && epochOf(sid) === epoch
  const live = await registryEntries($)
  if (!live) return no('registry-unreadable', c.reasonWhy('registry-unreadable'))
  const refused = await laneLive($, live, l)
  if (refused) return no(refused, c.reasonWhy(refused))
  // The same question for both verbs: the repo by its path, that the lane has no live session, and the parked sentence. A retire at lead level asks only
  // for a parked lane, whose record holds the only callboard pointer to its saved conversation.
  if (verb === 'terminate' || level === 'manager' || l.parked !== undefined) {
    const p = await where($)
    const r = await askOnce($, sid, c.removeQuestion(l.name, l.repo, l.parked !== undefined, p ? homeOf(p) : undefined), c.REMOVE_YES, c.REMOVE_NO, c.HEADER.stop)
    if (r === 'busy') return no('busy', c.reasonWhy('busy'))
    if (r === 'timed-out') return { deny: leadReason(verb, `${await timedOut($, sid)}.`) }
    if (r !== 'yes') return no('not-confirmed', 'the person did not confirm. Nothing was removed.')
  }
  if (!held()) return no('grant-changed', c.reasonWhy('grant-changed'))
  // A call the engine abandoned (its answer went out already) removes nothing.
  if (abandoned()) return { deny: leadReason(verb, c.reasonWhy('abandoned')) }
  const w = await removeRecord($, e, sid, l.src, l.name, { kind: 'idle', sid: l.sid, parked: l.parked !== undefined, seen: l, held })
  if ('no' in w) return no(w.no, w.why ?? c.reasonWhy(w.no))
  await log($, sid, 'lane-removed', l.name)
  return { result: c.removedNoSessionText(verb, l.name) } as never
}

// lane_park's two store writes (the record names the session before the signal; the mark after it): the record of that name, changed only when `ok` holds for it.
// The pre re-runs leadPrep and checks only that the lane still comes from this store, as the removal of a record does; never its name-in-use check, since the stopped
// session may still carry the name for a moment after the signal. undefined: written (or already so); otherwise the refusal code.
async function parkWrite($: any, e: unknown, me: string, key: string, name: string, change: (l: c.Store['lanes'][number]) => c.Store['lanes'][number], ok: (l: c.Store['lanes'][number]) => boolean): Promise<string | undefined> {
  const r = await ownWrite($, me, () => editStore($, key, async (cur) => {
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    const rec = parsed.store.lanes.find((l) => l.name === name)
    if (!rec) return { no: 'unknown-lane' }
    if (!ok(rec)) return { no: 'changed' }
    const next = change(rec)
    const t = c.storeText({ ...parsed.store, lanes: parsed.store.lanes.map((l) => (l === rec ? next : l)) })
    if ('no' in t) return t
    return { text: t.text, landed: (s) => !!s?.lanes.some((l) => l.name === name && l.sid === next.sid && l.parked === next.parked) }
  }, async () => {
    const again = await leadPrep($, e, me)
    if ('err' in again) return { no: again.err[0] }
    return again.lane.src === key ? undefined : { no: 'changed' }
  })).catch(() => ({ no: 'store-busy' }))
  return 'no' in r ? r.no : undefined
}

// After a retire or a force stop whose signal went out: the record of that name stops naming the stopped session (and is no longer parked). A failure is logged only.
async function sidClearAfterStop($: any, me: string, key: string, name: string, victim: string) {
  const r = await ownWrite($, me, () => editStore($, key, async (cur) => {
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    if (!parsed.store.lanes.some((l) => l.name === name && l.sid === victim)) return { skip: true }
    const t = c.storeText({ ...parsed.store, lanes: parsed.store.lanes.map((l) => (l.name === name && l.sid === victim ? { ...l, sid: undefined, parked: undefined } : l)) })
    if ('no' in t) return t
    return { text: t.text, landed: (s) => !!s && !s.lanes.some((l) => l.name === name && l.sid === victim) }
  })).catch(() => ({ no: 'throw' }))
  if ('no' in r) await log($, me, 'sid-uncleared', r.no)
  else if (r.text !== '') await log($, me, 'sid-cleared', name)
}

// The lane's report: a plain file of the user's, one link, at most REPORT_MAX. One stat, bounded; gone: stat said there is no file at that
// path. Any other stat failure is not gone, so a turn mark records the size as unknown (null) rather than no file (-1).
export async function reportStat($: any, l: c.Lane): Promise<{ no: string; gone?: true } | { path: string; f: NonNullable<Awaited<ReturnType<typeof facts>>> }> {
  const path = c.reportPath(l)
  const p = await where($)
  if (!path || !p) return { no: 'report-missing' }
  const r = await run($, [STAT, '-f', STAT_FMT, '--', path], undefined, { LC_ALL: 'C' })
  if (r.exitCode !== 0) return /No such file or directory/.test(r.stderr) ? { no: 'report-missing', gone: true } : { no: 'report-missing' }
  const f = c.parseStat(r.stdout)
  if (!f) return { no: 'report-missing' }
  if (f.kind !== 'file' || f.nlink !== 1 || f.uid !== p.uid || f.size > c.REPORT_MAX) return { no: 'report-file' }
  return { path, f }
}

// Inside the lane repo, and read with a bound.
export async function readReport($: any, l: c.Lane): Promise<{ no: string } | { text: string; mtimeMs: number; size: number }> {
  const st = await reportStat($, l)
  if ('no' in st) return { no: st.no }
  const real = (await run($, [REALPATH, '--', st.path])).stdout.trim()
  const realRepo = (await run($, [REALPATH, '--', l.repo!])).stdout.trim()
  if (!real || !realRepo || !c.within(realRepo, real)) return { no: 'report-path' }
  // The file may grow after the stat above: read at most one byte past the limit and refuse anything longer.
  const r = await run($, [HEAD, '-c', String(c.REPORT_MAX + 1), '--', st.path])
  if (r.exitCode !== 0 || r.stdout.length > c.REPORT_MAX) return { no: 'report-file' }
  return { text: r.stdout, mtimeMs: st.f.mtimeMs, size: st.f.size }
}

async function reportCheck($: any, l: c.Lane, target: c.RegEntry): Promise<string | undefined> {
  const r = await readReport($, l)
  return 'no' in r ? r.no : c.reportRefusal(r.text, target.sessionId, r.mtimeMs, target.startedAt)
}

// The target's side of a retire: the same report, signed with its own id, newer than the last turn and grown since then.
export async function retireReportCheck($: any, sid: string, l: c.Lane): Promise<string | undefined> {
  // A failed write of the turn mark leaves the old one, which would pass: until a write succeeds the signature cannot be shown to be last.
  if (lastTurnUnknown.has(sid)) return 'report-unknown'
  const r = await readReport($, l)
  return 'no' in r ? r.no : c.retireRefusal(r.text, sid, r.mtimeMs, r.size, (await $.state.get(lastTurn)).value)
}

export async function reportLaneOf($: any, sid: string): Promise<c.Lane | undefined> {
  const b = (await $.state.get(lane)).value as { name: string; rec?: string } | null | undefined
  if (!b) return undefined
  const hit = boundLane.get(sid)
  if (hit && hit.name === b.name && hit.rec === (b.rec ?? '')) return hit.l
  const lanes = await loadLanes($)
  const l = typeof lanes === 'string' ? undefined : lanes.find((x) => x.name === b.name)
  if (l) boundLane.set(sid, { name: b.name, rec: b.rec ?? '', l })
  return l
}

// A cue `rename <name>` from a session that is no lane yet: the session is renamed to the record's name and bound to it, with every check before the rename.
async function birthRename(
  $: any,
  sid: string,
  cue: c.Cue,
  x: { bound: unknown; now: number; first: number; reg: Reg; lanesOnce: () => Promise<c.Lane[] | string>; refuse: (reason: string) => Promise<void>; hold: (reason: string) => Promise<void>; answer: Answer },
) {
  const { bound, now, first, reg, lanesOnce, refuse, hold, answer } = x
  if (bound) return refuse('already-bound')
  // A lead is never renamed into a lane: the two grants would hold one session.
  if (leadBusy(sid)) return refuse('lead-holder')
  if (laneBinding.has(sid)) return refuse('already-bound')
  // A record name that is reserved on this machine (one written in the moment of a reserve) is never
  // taken by a rename.
  if (c.reservedHit(cue.name!)) return refuse('name-reserved')
  laneBinding.add(sid)
  try {
    // The engine calls held inside the mark have a time limit: one that never returns would hold the mark, and refuse every lead grant and bind, until a reload.
    // A session read that does not answer fails its check (no folder, no turn count, not idle).
    const bounded = async <T,>(p: Promise<T>): Promise<T | undefined> => {
      const r = await withTimeout($, p, c.ENGINE_CALL_TIMEOUT_MS)
      return r === 'timeout' ? undefined : r
    }
    const lanes = await lanesOnce()
    if (typeof lanes === 'string') return refuse(lanes)
    const me = await registryOf($, sid, reg)
    const no = c.birthRenameOk(
      lanes,
      cue.name!,
      { cwd: (await bounded(sessionRoot($))) ?? '', turns: (await bounded($.session.turns())) ?? NaN, nameSource: me?.nameSource, firstSeenMs: first, liveNames: await liveNames($, reg) },
      now,
    )
    if (no) return refuse(no)
    const blocked = await withTimeout($, idleCheck($, sid, reg), c.ENGINE_CALL_TIMEOUT_MS)
    if (blocked === 'timeout') return hold('not-idle')
    if (blocked) return hold(blocked)
    // Everything that can fail without a trace runs before the rename: a session renamed but left unbound is refused by every later rename and attach.
    const rec = await sha($, c.recordText(lanes.find((x) => x.name === cue.name)!)).catch(() => undefined)
    if (!rec) return refuse('sha-failed')
    const t0 = await bounded($.session.turns())
    if (t0 === undefined) return hold('not-idle')
    let renamed: unknown
    try {
      renamed = await withTimeout($, $.command.run({ command: 'rename', args: cue.name! }), c.ENGINE_CALL_TIMEOUT_MS)
    } catch {
      return refuse('rename-failed')
    }
    if (renamed === 'timeout') {
      await log($, sid, 'error', 'rename-timeout')
      return refuse('rename-failed')
    }
    // A failed read counts as other turns: the binding stores -1, and lane_start is refused.
    const t1r = await withTimeout($, $.session.turns().catch(() => NaN), c.ENGINE_CALL_TIMEOUT_MS)
    const t1 = t1r === 'timeout' ? NaN : t1r
    const stored = c.bindTurns(t0, t1)
    const b: Bound = { name: cue.name!, at: now, turns: stored ?? -1, rec }
    const setting = $.state.set(lane, b)
    const w = await withTimeout($, setting, c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
    if (w === 'timeout') {
      undoLate($, sid, setting, b)
      await log($, sid, 'error', 'bind-timeout')
    }
    if (!w || w === 'timeout' || w.isSet === false) return refuse('bind-failed')
    const leadLookup = keepLaneFacts($, sid, lanes.find((x) => x.name === cue.name)!, false, cue.lead, reg)
    if (stored === undefined) await refuse('bind-turns-mismatch')
    else await answer('ok')
    await withTimeout($, leadLookup, c.ENGINE_CALL_TIMEOUT_MS)
    return log($, sid, 'renamed')
  } finally {
    laneBinding.delete(sid)
  }
}

export async function handle($: any, sid: string, cue: c.Cue, answer: Answer) {
  // The answer goes first: the lead is waiting on it, and the log line costs several process runs.
  const refuse = async (reason: string) => {
    await answer('refused', reason)
    await log($, sid, 'refused', reason)
  }
  const hold = async (reason: string) => {
    await answer('held', reason)
    await log($, sid, 'held', reason)
  }
  const now = await $.clock.now()
  const bound = (await $.state.get(lane)).value as { name: string; turns?: number; rec?: string; adopted?: boolean; lead?: string } | null | undefined
  const first = (await $.state.get(seen)).value ?? now
  // One cue reads the registry and the lane list once.
  const reg = regOnce($)
  let lanesP: Promise<c.Lane[] | string> | undefined
  const lanesOnce = () => (lanesP ??= loadLanes($))
  // An on-cue request of the session's own, past its time or compacted now.
  const compactOwn = async (req: Request) => {
    if (!c.onCueValid(req.requestedMs, now)) {
      await answer('refused', 'no-request')
      return dropRequest($, sid, 'expired')
    }
    return doCompact($, sid, req, true, answer)
  }
  if (cue.verb === 'rename') return birthRename($, sid, cue, { bound, now, first, reg, lanesOnce, refuse, hold, answer })
  if (bound?.adopted) {
    const all = await lanesOnce()
    if (typeof all === 'string') return refuse(all)
    const rec = all.find((x) => x.name === bound.name)
    if (!rec) return refuse('unknown-lane')
    if (!rec.repo) return refuse('no-lead')
    if (!(await leadHere($, await sessionRoot($), rec.repo, rec.leadName, reg))) {
      // With no live lead, the verbs a manager may send (resume, compact, retire) are taken while a live manager passes every
      // presence check and has a reserved registry name (managerTrusted). A filter, not proof: any writer of the cue folder can send the cue then.
      const live = c.MANAGER_CUE_VERBS.includes(cue.verb) ? await reg() : undefined
      if (!live || !(await managerTrusted($, live, sid))) return refuse('no-lead')
    }
  }
  // A session holding a lead grant takes one verb, compact, and only while a live manager file of another session passes every presence
  // check and the registry names that session with a reserved name (c.managerNameOf); it acts only on an on-cue request of its own, and is never nudged. A
  // filter, not proof: any writer of the cue folder can send the cue while a manager is live; the request is the lead's own.
  if (!bound && grants.get(sid)?.level === 'lead') {
    if (cue.verb !== 'compact') return refuse('not-eligible')
    const live = await reg()
    if (!live) return refuse('registry-unreadable')
    // A trusted conductor that lists the lead's repo also qualifies (conductorsTrusted).
    if (!(await managerTrusted($, live, sid)) && (await conductorsTrusted($, live, sid, pinOf(sid))).length === 0) return refuse('not-eligible')
    const req = (await $.state.get(request)).value as Request | null | undefined
    if (!req || req.viaLead !== true || req.mode !== 'on-cue' || req.phase !== 'armed') return refuse('no-request')
    return compactOwn(req)
  }
  if (!(await isEligible($))) return refuse('not-eligible')
  if (cue.verb === 'compact') {
    const req = (await $.state.get(request)).value as Request | null | undefined
    // With no request of its own the session is nudged to make one; any other phase (called, armed now, compacting, compacted) is no-request, as before.
    if (!req) return leadNudge($, sid, now, answer, refuse)
    if (req.mode !== 'on-cue' || req.phase !== 'armed') return refuse('no-request')
    return compactOwn(req)
  }
  if (!bound) return refuse('not-bound')
  const lanes = await lanesOnce()
  if (typeof lanes === 'string') return refuse(lanes)
  const l = lanes.find((x) => x.name === bound.name)
  if (!l) return refuse('unknown-lane')
  if (!(await recMatch($, bound.rec, l))) return refuse('record-changed')
  if ((await sessionRoot($)) !== l.folder) return refuse('wrong-folder')
  if (cue.verb === 'start' && bound.adopted) return refuse('adopted-record')
  const blocked = await idleCheck($, sid, reg)
  if (blocked) return hold(blocked)
  if (cue.verb === 'retire' || cue.verb === 'park') {
    // The lead signals only on this answer; the session does not stop itself (no engine call gives it its own pid). A park keeps the conversation, so it
    // needs no signed report: the same idle, draft, agent and shell checks only.
    if (await busyAgents($)) return refuse('background-work')
    const shells = await backgroundShells($, sid, reg)
    if (shells) return refuse(shells)
    if (cue.verb === 'retire') {
      const bad = await retireReportCheck($, sid, l)
      if (bad) return refuse(bad)
    }
    await answer('ok')
    return log($, sid, cue.verb === 'retire' ? 'retire-confirmed' : 'park-confirmed', l.name)
  }
  if (cue.verb === 'start') {
    const ct = await counts($)
    if (ct.startDone) return refuse('start-done')
    if (!c.startTurnsOk(await $.session.turns(), bound.turns)) return refuse('not-empty')
    if (now - first > c.BIRTH_WINDOW_MS) return refuse('too-old')
    const p = (await where($))!
    const bf = await facts($, l.brief)
    if (!bf || bf.kind !== 'file' || bf.nlink !== 1 || bf.uid !== p.uid || bf.size > 65_536) return refuse('brief-file')
    const real = (await run($, [REALPATH, '--', l.brief])).stdout.trim()
    const realFolder = (await run($, [REALPATH, '--', l.folder])).stdout.trim()
    if (!real || !realFolder || !c.within(realFolder, real)) return refuse('brief-path')
    // Only a record that carries a model is switched (an older record is not). /model adds a turn, so a lane it fails on cannot be started later.
    if (l.model && !(await modelSet($, l.model))) return refuse('model-failed')
    await log($, sid, 'brief-sha256', await sha($, await $.fs.read(l.brief)))
    await bump($, (ct2) => ({ ...ct2, startDone: true }))
    try {
      await submitOwn($, c.startText(l.name, l.brief))
    } catch {
      await bump($, (ct2) => ({ ...ct2, startDone: false })).catch(() => undefined)
      await answer('refused', 'submit-failed')
      return log($, sid, 'start-failed')
    }
    await answer('ok')
    return log($, sid, 'started')
  }
  const no = c.resumeAllowed(await counts($), now)
  if (no) return refuse(no)
  await bump($, (ct2) => ({ ...ct2, resumeTimes: [...(ct2.resumeTimes ?? []).filter((t) => now - t < c.HOUR_MS), now] }))
  try {
    await submitOwn($, c.resumeText(l.name))
  } catch {
    await bump($, (ct2) => ({ ...ct2, resumeTimes: (ct2.resumeTimes ?? []).filter((t) => t !== now) })).catch(() => undefined)
    await answer('refused', 'submit-failed')
    return log($, sid, 'resume-failed')
  }
  await answer('ok')
  return log($, sid, 'resumed')
}

// /model in this session's own engine, then a read-back: the session's model name, lowercased, must contain the alias ("Haiku 5.5", "claude-haiku-5-5").
async function modelSet($: any, model: c.LaneModel): Promise<boolean> {
  try {
    if ((await withTimeout($, $.command.run({ command: 'model', args: model }), c.MODEL_TIMEOUT_MS)) === 'timeout') return false
    return String(await $.session.model()).toLowerCase().includes(model)
  } catch {
    return false
  }
}

// The folder the session started in ($.session.root(), engine 2.1.316). An engine without root() fails the call, and the live folder ($.session.cwd()) is
// read instead; a root() read that fails on an engine that has it reads cwd() the same way.
export async function sessionRoot($: any): Promise<any> {
  try {
    return await $.session.root()
  } catch {
    return $.session.cwd()
  }
}

// A binding write that timed out may still land. Once it does, it is undone while it is still that binding (same name and time), so a bind that was answered as
// failed leaves none behind. Best effort, logged.
function undoLateWrite($: any, sid: string, setting: Promise<any>, b: Bound, undo: (cur: Bound) => Promise<unknown>, undoneCode: string, failCode: string) {
  void setting
    .then(async (w) => {
      if (w?.isSet === false) return
      const cur = (await $.state.get(lane)).value as Bound | null | undefined
      if (cur && cur.name === b.name && cur.at === b.at) {
        await undo(cur)
        await log($, sid, 'error', undoneCode)
      }
    })
    .catch(logFail($, sid, failCode))
}
export function undoLate($: any, sid: string, setting: Promise<any>, b: Bound) {
  return undoLateWrite($, sid, setting, b, (cur) => detach($, sid, cur), 'late-bind-undone', 'late-bind')
}

// Claim <sid>.cue by renaming it to a name only this tick uses, then judge the file that was
// moved, not the one first seen: a cue replaced between the two is the one read, checked and
// answered, with its own inode, so the answer never names a file that was not read. A cue that
// appears after the move is the next tick's. The name it is moved to is new (a random part), must not
// exist yet, and the move must succeed: mv -n leaves a file already at that name in place.
export async function claim($: any, sid: string, p: { uid: number; root: string }) {
  const cueDir = `${p.root}/cue`
  const cue = `${cueDir}/${sid}.cue`
  const first = await facts($, cue)
  if (!first) return undefined
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, cueDir, p.uid))) return { bad: 'unsafe-dir', ino: first.ino }
  const refusal = c.cueFileOk(first, p.uid)
  if (refusal) return { bad: refusal, ino: first.ino }
  const taken = `${cueDir}/${sid}.${await $.clock.now()}.${++mem.seq}.${Math.random().toString(36).slice(2, 12)}.taken`
  if (await facts($, taken)) return { bad: 'claim-failed', ino: first.ino }
  if ((await run($, [MV, '-n', '--', cue, taken])).exitCode !== 0) return { bad: 'claim-failed', ino: first.ino }
  const moved = await facts($, taken)
  if (!moved) return { bad: 'claim-failed', ino: first.ino }
  const ino = moved.ino
  const movedRefusal = c.cueFileOk(moved, p.uid)
  if (movedRefusal) {
    if (moved.kind === 'file') await run($, [RM, '-f', '--', taken])
    return { bad: movedRefusal, ino }
  }
  if (moved.size > c.CUE_MAX_BYTES) {
    await run($, [RM, '-f', '--', taken])
    return { bad: 'too-long', ino }
  }
  const text = (await run($, [HEAD, '-c', String(c.CUE_MAX_BYTES + 1), '--', taken])).stdout
  const after = await facts($, taken)
  await run($, [RM, '-f', '--', taken])
  if (!after || !c.sameFile(moved, after)) return { bad: 'changed', ino }
  if (!c.isFresh(await $.clock.now(), moved.mtimeMs)) return { bad: 'stale', ino }
  return { text, ino }
}

export async function sweepTaken($: any, sid: string, p: { uid: number; root: string }) {
  const now = await $.clock.now()
  if (now - (takenSwept.get(sid) ?? -Infinity) < c.TAKEN_SWEEP_MS) return
  takenSwept.set(sid, now)
  const dir = `${p.root}/cue`
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return
  const files = ((await $.fs.list(dir).catch(() => [])) as { name: string; kind: string; isLink: boolean }[]).slice(0, 500)
  let n = 0
  for (const f of files) {
    const at = c.takenClaimMs(f.name, sid)
    if (at === undefined || !(now - at > c.TAKEN_SWEEP_MS)) continue
    if (f.kind !== 'file' && !f.isLink) {
      await log($, sid, 'error', 'taken-dir')
      continue
    }
    if ((await run($, [RM, '-f', '--', `${dir}/${f.name}`])).exitCode === 0) n++
  }
  if (n > 0) await log($, sid, 'taken-swept', String(n))
}

export async function renameTick($: any, sid: string) {
  const pr = pendingRename.get(sid)
  if (!pr) return
  pendingRename.delete(sid)
  // The manager's rename, while its grant still names it (the outcome is logged either way).
  const g = grants.get(sid)
  if (pr.manager ? !(g?.level === 'manager' && g.name === pr.name) : ((await $.state.get(lane)).value as { name?: string } | null | undefined)?.name !== pr.name) return
  const fail = async (why: string) => {
    await log($, sid, 'rename-failed', why)
    toast($, c.renameFailedToast(pr.name))
  }
  if ((await $.clock.now()) > pr.until) return fail('expired')
  // The name was free when the person said yes; another session may have taken it since.
  const reg = await registryEntries($)
  if (!reg) return fail('registry-unreadable')
  if (reg.some((e) => e.j.name === pr.name && e.j.sessionId !== sid)) return fail('name-taken')
  const done = await withTimeout($, Promise.resolve($.command.run({ command: 'rename', args: pr.name })).then(() => 'ok' as const, () => 'refused' as const), ACTION_TIMEOUT_MS)
  if (done === 'ok') await log($, sid, 'renamed', pr.manager ? 'manager' : 'attach')
  else await fail(done)
}

// The cheap part, every tick with no time limit (a state read): the binding the sync is due for, if any; its key is set here.
export async function sidSyncDue($: any, sid: string): Promise<Bound | undefined> {
  const b = (await $.state.get(lane)).value as Bound | null | undefined
  if (!b || typeof b.name !== 'string') return undefined
  const key = `${b.name}\n${b.at}\n${b.rec ?? ''}`
  if (sidSynced.get(sid) === key) return undefined
  sidSynced.set(sid, key)
  return b
}
export async function sidSync($: any, sid: string, b: Bound & { name: string }) {
  const failed = (code: string) => log($, sid, 'sid-heal-failed', code)
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return failed(lanes)
  const l = lanes.find((x) => x.name === b.name)
  if (!l || !l.src) return
  if (!(await recMatch($, b.rec, l))) return failed('record-changed')
  if ((await sessionRoot($)) !== l.folder) return failed('wrong-folder')
  if (l.sid === sid && l.parked === undefined) return
  const same = async () => {
    const now = (await $.state.get(lane)).value as Bound | null | undefined
    return !!now && now.name === b.name && now.at === b.at && now.rec === b.rec ? undefined : { no: 'changed' }
  }
  const r = await editStore($, l.src, async (cur) => {
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    let hit = false
    let done = false
    const lanes2: c.Store['lanes'] = []
    for (const x of parsed.store.lanes) {
      if (x.name === b.name && (await recMatch($, b.rec, x))) {
        hit = true
        done = x.sid === sid && x.parked === undefined
        lanes2.push({ ...x, sid, parked: undefined })
      } else lanes2.push(x)
    }
    if (!hit) return { no: 'record-changed' }
    if (done) return { skip: true }
    const t = c.storeText({ ...parsed.store, lanes: lanes2 })
    if ('no' in t) return t
    return { text: t.text, landed: (s) => !!s?.lanes.some((x) => x.name === b.name && x.sid === sid && x.parked === undefined) }
  }, same)
  if ('no' in r) return failed(r.no)
  if (r.text !== '') await log($, sid, 'sid-healed')
}

// A session that starts again under the id its store record names is that lane again, with no question: an unparked lane, a tab reopened by a window
// restart, a conversation resumed by hand. session.start marks it; the work runs from the tick, one try per tick, up to REBIND_TRIES. A session no record names
// ends at the first try with no registry read and no log. A lanes read that fails, a registry read that cannot be trusted (its dead-row filter was off) and a
// name another live session carries are tried again; any other refusal ends it at once. The bind is the restore's: turns -1, restored, startDone, the record's
// hash, the briefing note and the hint's counters. Where it does not happen, /callboard lane still offers the Restore question.
const REBIND_TRIES = 15

// A rebind write that timed out and lands late is only taken back: the binding goes while it is still this one; the record, its sid and the hint stay,
// so a later start or the Restore question can still bind it. Not detach, which would clear the sid and the hint for good.
function rebindUndoLate($: any, sid: string, setting: Promise<any>, b: Bound) {
  return undoLateWrite($, sid, setting, b, () => $.state.set(lane, null), 'late-rebind-undone', 'late-rebind')
}

export async function rebindTick($: any, sid: string) {
  const state = rebindPending.get(sid)
  if (state === undefined) return
  const seq = offSeq.get(sid) ?? 0
  const n = state.tries + 1
  rebindPending.set(sid, { ...state, tries: n })
  const end = async (code: string) => {
    const name = rebindPending.get(sid)?.name
    rebindPending.delete(sid)
    await log($, sid, 'rebind-rejected', code)
    // The lead may have been told the lane comes back by itself (lane_unpark): the person is told it did not. Not for a lead, nor a run with no person.
    if (name !== undefined && code !== 'lead-holder' && code !== 'not-interactive') toast($, c.rebindFailedToast(name))
  }
  const retry = async (code: string) => (n >= REBIND_TRIES ? end(code) : undefined)
  // A session bound already (attached or restored before this tick) is left as it is, with no read; the check runs again inside the mark below.
  if ((await $.state.get(lane)).value != null) return void rebindPending.delete(sid)
  const lanes = await loadLanes($).catch(() => 'lanes-error')
  if (typeof lanes === 'string') return retry(lanes)
  const named = lanes.filter((l) => l.sid === sid)
  if (named.length === 0) return void rebindPending.delete(sid)
  const pending = rebindPending.get(sid)
  if (named.length === 1 && pending) rebindPending.set(sid, { ...pending, name: named[0].name })
  // A lead restore still pending decides first: a session that becomes lead is refused below as lead-holder.
  if (leadRestorePending.has(sid)) return retry('lead-restore-pending')
  // A conductor restore still pending decides first (it ends on a lane record naming this session).
  if (conductorRestorePending.has(sid)) return retry('conductor-restore-pending')
  // A person's session only: a headless run resumed under this id does not become the lane. Tried again: a reopened panel's own registry row may come a
  // moment after session.start.
  if (!(await interactive($, sid))) return retry('not-interactive')
  const reg = await registryEntriesWhy($)
  if (!reg.rows) return retry('registry-unreadable')
  if (reg.why !== undefined) return retry(`registry-${reg.why}`)
  // A row of this same session id (the old process of this conversation, still dropping out) never blocks its own rebind.
  const others = reg.rows.filter((e) => e.j.sessionId !== sid).flatMap((e) => (typeof e.j.name === 'string' ? [e.j.name] : []))
  const now = await $.clock.now()
  const hint = c.parseHint(await $.store.get(`${c.HINT_PREFIX}${sid}`).catch(() => undefined), now)
  const v = c.rebindRefusal(lanes, sid, await sessionRoot($), others, hint)
  if (!v.ok) return v.reason === 'name-in-use' ? retry(v.reason) : end(v.reason)
  const l = v.lane
  if (leadBusy(sid)) return end('lead-holder')
  if (laneBinding.has(sid)) return retry('already-bound')
  laneBinding.add(sid)
  let binding: Bound | undefined
  try {
    // As the restore: inside the mark, and a read that does not answer counts as a binding. A session that is bound already is left as it is.
    const held = await withTimeout($, $.state.get(lane), c.ENGINE_CALL_TIMEOUT_MS)
    if (held === 'timeout' || held?.value != null) return void rebindPending.delete(sid)
    const b = { name: l.name, at: now, turns: -1, restored: true, rec: await sha($, c.recordText(l)), ...(l.adopted ? { adopted: true as const, lead: l.lead, key: l.src } : {}) }
    // A /callboard off since this tick began cancelled the rebind and cleared the record's sid: no binding is written after it.
    if (!rebindPending.has(sid) || (offSeq.get(sid) ?? 0) !== seq) return
    const setting = $.state.set(lane, b)
    const w = await withTimeout($, setting, c.ENGINE_CALL_TIMEOUT_MS)
    if (w === 'timeout') {
      rebindUndoLate($, sid, setting, b)
      rebindPending.delete(sid)
      return void (await log($, sid, 'error', 'rebind-bind-timeout'))
    }
    if (w?.isSet !== false) binding = b
  } finally {
    laneBinding.delete(sid)
  }
  rebindPending.delete(sid)
  if (!binding) return
  await keepLaneFacts($, sid, l, l.adopted === true, l.adopted ? l.lead : undefined)
  await briefLane($, sid)
  await bump($, (ct) => ({ ...c.mergeCounters(ct, hint?.counters ?? {}), startDone: true }))
  restoredOnce.add(sid)
  rebound.add(sid)
  await saveHint($, sid)
  await log($, sid, 'rebound', l.name)
  toast($, c.reboundToast(l.name))
}

// The steps every lead tool shares: main agent, grant, the lane list, the live registry.
const SUBAGENT = ['subagent', 'for the main agent only.'] as const
export async function leadBase($: any, e: unknown, sid: string) {
  if ((e as { agentId?: string }).agentId !== undefined) return { err: SUBAGENT }
  // The manager has eight tools (c.MANAGER_TOOLS: five lane tools and the three prompt tools); every other lane tool refuses it, declared or not.
  if (grantOf(sid)?.level === 'manager' && !c.MANAGER_TOOLS.includes(String((e as { tool?: unknown }).tool))) return { err: ['manager-tool', c.REASON_TEXT['manager-tool']] as const }
  // The conductor has six (c.CONDUCTOR_TOOLS: three lane tools and the three prompt tools).
  if (grantOf(sid)?.level === 'conductor' && !c.CONDUCTOR_TOOLS.includes(String((e as { tool?: unknown }).tool))) return { err: ['conductor-tool', c.REASON_TEXT['conductor-tool']] as const }
  return leadCore($, sid)
}

export async function leadCore($: any, sid: string) {
  if (!grants.has(sid)) return { err: ['off', 'the lead tools are off. Ask the person to turn them on.'] as const }
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return { err: [lanes, lanes] as const }
  const live = await registryEntries($)
  if (!live) return { err: ['registry-unreadable', c.REASON_TEXT['registry-unreadable']] as const }
  // Read after the awaits: an off meanwhile is refused here, not met later as a missing pin.
  const held = grantOf(sid)
  if (!held) return { err: ['off', 'the lead tools are off. Ask the person to turn them on.'] as const }
  // The effective grant: its name is read from the live registry now; the stored name is only a cache. No name ('') reaches only lanes that name no lead.
  // A manager's reach ignores the name, and its name is a reserved one (which c.leadNameOf never gives): it keeps the grant's.
  let g: c.Grant = held.level === 'lead' ? { ...held, name: c.leadNameOf(live.map((r) => r.j), sid) ?? '' } : held
  // A conductor's pins are read now: the list file, resolved, intersected with the approved list (a read that parses also ratchets it).
  if (held.level === 'conductor') {
    const reach = await conductorReach($, sid)
    const now = grantOf(sid)
    if (now?.level !== 'conductor' || ('no' in reach && reach.no === 'off')) return { err: ['off', 'the lead tools are off. Ask the person to turn them on.'] as const }
    if ('no' in reach) return { err: ['conductor-list', c.REASON_TEXT['conductor-list']] as const }
    g = { ...now, pins: reach.pins }
  }
  // A lane this read finds live counts as seen live for the check-in's gone.
  const seen = laneObs.get(sid)
  if (seen) {
    const entries = live.map(regEntry)
    for (const l of lanes) if (c.inReach(g, l) && c.laneSession(entries, l, sid).ok) seen.set(l.name, { ...(seen.get(l.name) ?? { goneN: 0 }), seenLive: true })
  }
  return { lanes, live, g }
}

// The table behind both lane_list and `/callboard lanes`, so the two cannot drift.
export async function laneTable($: any, sid: string) {
  const base = await leadCore($, sid)
  if ('err' in base) return { err: base.err }
  // The manager's list gains a Conductor column naming each live conductor's repos.
  const conductors = base.g.level === 'manager' ? await conductorsLive($, base.live, sid).catch(() => 'error' as const) : undefined
  const leads = await leadsInReach($, base.live, base.g).catch(() => [])
  const text = c.laneListText(base.lanes.filter((l) => c.inReach(base.g, l)), base.live.map(regEntry), await $.clock.now(), { level: base.g.level, name: base.g.name, conductors, leads })
  // A lead's own list shows only the lanes that name it; the ones that name a lead no live session carries are told by name, for the person's /callboard claim.
  const orphans = (await claimLanes($, base.live, base.lanes, base.g, sid).catch(() => [])).map((l) => l.name)
  return { text: orphans.length > 0 ? `${text}\n\n${c.CLAIM_HINT(orphans)}` : text }
}

const OBS_CLEAR_TOOLS = ['terminate', 'retire', 'park', 'unpark', 'resume'].map((v) => `mcp__callboard__lane_${v}`)

// ...then the lane's repo; an attached lane answers whichever lead holds the repo.
async function leadPrep($: any, e: unknown, sid: string) {
  const base = await leadBase($, e, sid)
  if ('err' in base) return { err: base.err }
  const pick = c.leadLane(base.lanes, base.g, (e as { lane?: unknown }).lane)
  if (!pick.ok) return { err: [pick.reason, c.reasonWhy(pick.reason)] as const }
  return { lane: pick.lane, entries: base.live.flatMap((r) => (typeof r.j.sessionId === 'string' ? [regEntry(r)] : [])) }
}

// The live lead whose registry name (c.leadNameOf) is the tool's lane argument, in any repo, never this session. undefined: no live lead
// carries it (the caller goes on to the lanes). A lane record of the same name refuses lane-or-lead: lane and lead names follow the same rules (NAME_RE, not
// reserved), so the two can meet, and neither is taken over the other.
async function leadByName($: any, e: unknown, sid: string): Promise<{ sid: string; name: string } | { err: readonly [string, string] } | undefined> {
  const name = (e as { lane?: unknown }).lane
  if (typeof name !== 'string' || !c.NAME_RE.test(name)) return undefined
  const base = await leadBase($, e, sid)
  if ('err' in base) return { err: base.err }
  const rows = base.live.map((r) => r.j)
  const leads = (await leadsFor($, base.live, undefined)).filter((x) => x.sid !== sid && c.leadNameOf(rows, x.sid) === name)
  if (leads.length === 0) return undefined
  if (leads.length > 1 || base.lanes.some((l) => l.name === name)) return { err: ['lane-or-lead', c.reasonWhy('lane-or-lead')] }
  // A conductor compacts only a lead of its repos.
  if (base.g.level === 'conductor' && !base.g.pins.includes(leads[0].repo)) return { err: ['other-repo', c.reasonWhy('other-repo')] }
  return { sid: leads[0].sid, name }
}

// ---- /callboard lane: an existing session becomes a lane of the lead that runs in its repo ----
// leadName: the lead's registry name now (c.leadNameOf), stamped on the record so only that lead reaches the lane; none leaves the record legacy.
// pick: the lead the person picked in the Join dialog when several run in the repo; without it several leads give { choices }.
export type Plan = { name: string; rename: boolean; repo: string; lead: string; cwd: string; key: string; leadName?: string; pick?: string }
export async function attachPlan($: any, sid: string, want: string | undefined, pick?: string): Promise<Plan | { no: string } | { choices: string[] }> {
  await reservedGet($, sid, true)
  if ((await $.state.get(lane)).value != null) return { no: 'already-bound' }
  if (grants.get(sid)?.level === 'manager') return { no: 'manager-holder' }
  // Nor a conductor, nor a session that was one since it started.
  if (grants.get(sid)?.level === 'conductor' || conductorRestorePending.has(sid)) return { no: 'conductor-holder' }
  if (conductorDeclared.has(sid)) return { no: 'lane-after-conductor' }
  // Nor a session that was the manager since it started (its manager tools stay declared), before the dialog and after a yes.
  if (managerDeclared.has(sid)) return { no: 'lane-after-manager' }
  if (grants.has(sid)) return { no: 'lead-holder' }
  const live = await registryEntries($)
  // Exactly one entry of this session: two live ones (a forged copy under a live pid) leave it unclear which name is the session's own.
  const mine = live?.filter((e) => e.j.sessionId === sid) ?? []
  if (mine.length > 1) return { no: 'session-duplicate' }
  const me = mine.length === 1 ? mine[0].j : undefined
  if (!live || !me) return { no: 'registry-unreadable' }
  // The session's current name, whatever set it (/rename, -n, a restore hook or an automatic title): the dialog shows the
  // name and the person confirms it, or answers no and passes NAME.
  const own = typeof me.name === 'string' && me.name !== '' ? me.name : undefined
  const name = want ?? own
  if (name === undefined) return { no: 'pass-name' }
  if (!c.NAME_RE.test(name)) return { no: want === undefined ? 'own-name-bad' : 'name-bad' }
  if (c.reservedHit(name)) return { no: 'name-reserved' }
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return { no: lanes }
  // A live name in any letter case: a lane `alpha` beside lead `Alpha` would make c.leadNameOf void the lead's name and strand its lanes.
  if (lanes.some((l) => l.name === name) || live.some((e) => typeof e.j.name === 'string' && e.j.name.toLowerCase() === name.toLowerCase() && e.j.sessionId !== sid)) return { no: 'name-taken' }
  const cwd = await sessionRoot($)
  // The checks on the session's own folder come before the lead, so they refuse before any dialog, the lead picker included.
  if ((await real($, cwd)) !== cwd) return { no: 'folder-bad' }
  if (!c.isSafeBrief(`${cwd}/${c.ATTACH_BRIEF}`)) return { no: 'folder-chars' }
  const found = await findLead($, live, cwd, pick)
  if (!('lead' in found)) return found
  // A dot folder below the repo (a Claude worktree under .claude/worktrees, .git) can never be a lane folder: parseStore refuses the whole store for such a record.
  if (c.dotBelow(found.lead.repo, cwd)) return { no: 'folder-dot' }
  const key = await sha($, found.lead.repo)
  if (lanes.filter((l) => l.src === key).length >= c.STORE_MAX_LANES) return { no: 'lane-cap' }
  const leadName = c.leadNameOf(live.map((e) => e.j), found.lead.sid)
  return { name, rename: name !== me.name, repo: found.lead.repo, lead: found.lead.sid, cwd, key, ...(leadName !== undefined ? { leadName } : {}), ...(pick !== undefined ? { pick } : {}) }
}

export type Bound = { name: string; at?: number; turns?: number; restored?: boolean; adopted?: boolean; lead?: string; key?: string; rec?: string }

// The session's own record, removed under the store lock. With the binding's `rec` the record must be the very one the binding was made from (name, attached,
// and the hash of its text, which covers the folder, so a session that has since changed folder still finds it); without one (a session with no binding) the
// folder must be the session's own. true: it is gone, or was never there (an absent store is done). false: an attached record of that name is still there
// and is not ours, or the store could not be edited: never reported as done.
export async function dropRecord($: any, name: string, key: string | undefined, rec: string | undefined, folder: string | undefined): Promise<boolean> {
  if (!key || !/^[0-9a-f]{64}$/.test(key) || (rec === undefined && folder === undefined)) return false
  const r = await editStore($, key, async (cur) => {
    if (cur.state === 'absent') return { skip: true }
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    const left: c.Store['lanes'] = []
    let hit = false
    for (const l of parsed.store.lanes) {
      const ours = l.name === name && l.adopted && (rec !== undefined ? await recMatch($, rec, l) : l.folder === folder)
      if (ours) hit = true
      else left.push(l)
    }
    if (!hit) return parsed.store.lanes.some((l) => l.name === name && l.adopted) ? { no: 'not-found' } : { skip: true }
    const text = JSON.stringify({ repo: parsed.store.repo, lanes: left.map(c.storeLaneJson), creates: parsed.store.creates.slice(-12) })
    return { text, landed: (s) => !!s && !s.lanes.some((l) => l.name === name && l.adopted) }
  })
  return 'text' in r
}

// A born store lane's record stops naming this session, so a lane the person turned off does not come back by itself after a restart. The record is
// found by name and by the binding's hash (a born binding has no store key); it is changed only while it still names this session. true: nothing names this
// session any more, or nothing needed clearing; false: a record may still name it (the lanes or the store could not be read or written).
async function sidClear($: any, sid: string, b: Bound): Promise<boolean> {
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return false
  let rec: c.Lane | undefined
  for (const l of lanes) if (l.name === b.name && l.src && b.rec !== undefined && (await recMatch($, b.rec, l))) rec = l
  // No record of that name and hash: the lane was removed or changed. Only a record that still names this session could bring it back.
  if (!rec) return !lanes.some((l) => l.sid === sid)
  const key = rec.src!
  const r = await editStore($, key, async (cur) => {
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    let hit = false
    const lanes2: c.Store['lanes'] = []
    for (const l of parsed.store.lanes) {
      if (l.name === b.name && l.sid === sid && (await recMatch($, b.rec, l))) {
        hit = true
        lanes2.push({ ...l, sid: undefined, parked: undefined })
      } else lanes2.push(l)
    }
    if (!hit) return { skip: true }
    const t = c.storeText({ ...parsed.store, lanes: lanes2 })
    if ('no' in t) return t
    return { text: t.text, landed: (s) => !!s && !s.lanes.some((l) => l.name === b.name && l.sid === sid) }
  })
  if ('no' in r) return false
  if (r.text !== '') await log($, sid, 'sid-cleared')
  return true
}

// Clears the binding and its hint first, then removes an attached session's record (or clears a born store lane's sid): whatever the removal does, the session
// is unbound. whole false: the record could not be removed (the person is told to rename the session). sidKept: a born lane's record may still name this
// session, so it could become the lane again after a restart (the person is told).
// /callboard off in a session that is not bound: no store record may keep naming it, or a restart would rebind it into that lane.
export async function sidClearAll($: any, sid: string): Promise<{ ok: boolean; name?: string }> {
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return { ok: false }
  const mine = lanes.filter((l) => l.sid === sid && l.src)
  if (mine.length === 0) return { ok: true }
  let ok = true
  for (const key of new Set(mine.map((l) => l.src!))) {
    const r = await editStore($, key, async (cur) => {
      if (cur.state !== 'ok') return { no: 'store-unreadable' }
      const parsed = c.parseStore(cur.text)
      if (!parsed.ok) return { no: parsed.reason }
      if (!parsed.store.lanes.some((l) => l.sid === sid)) return { skip: true }
      const t = c.storeText({ ...parsed.store, lanes: parsed.store.lanes.map((l) => (l.sid === sid ? { ...l, sid: undefined, parked: undefined } : l)) })
      if ('no' in t) return t
      return { text: t.text, landed: (st) => !!st && !st.lanes.some((l) => l.sid === sid) }
    })
    if ('no' in r) ok = false
    else if (r.text !== '') await log($, sid, 'sid-cleared')
  }
  if (!ok) await log($, sid, 'sid-uncleared')
  return { ok, name: mine[0].name }
}
export async function detach($: any, sid: string, b: Bound): Promise<{ whole: boolean; sidKept: boolean }> {
  pendingRename.delete(sid)
  sidSynced.delete(sid)
  laneBrief.delete(sid)
  laneBriefed.delete(sid)
  const folder = b.adopted && b.rec === undefined ? ((await sessionRoot($).catch(() => undefined)) as string | undefined) : undefined
  await $.state.set(lane, null)
  // Again after the write: facts kept while it was in flight go too.
  laneBrief.delete(sid)
  laneBriefed.delete(sid)
  try {
    await $.store.delete(`${c.HINT_PREFIX}${sid}`)
  } catch {
    await logq($, sid, 'error', 'hint-delete')
  }
  lastSaved.delete(sid)
  const whole = !b.adopted || (await dropRecord($, b.name, b.key, b.rec, folder).catch(() => false))
  if (!whole) await log($, sid, 'detach-incomplete')
  // A born lane's record stays and loses its sid. An attached record is removed whole; when that failed, its sid is cleared instead, so a restart cannot
  // rebind the session into it.
  const sidKept = (!b.adopted || !whole) && !(await sidClear($, sid, b).catch(() => false))
  if (sidKept) await log($, sid, 'sid-uncleared')
  return { whole, sidKept }
}

// An unbound session (its binding is gone, its record is not): the record is found by the session's own name and folder, never by a name alone, and never
// when another live session carries that name (it is that session's lane).
export async function strayRecord($: any, sid: string): Promise<'none' | 'removed' | 'stuck' | 'unknown'> {
  const rows = await registryEntries($)
  if (!rows) return 'unknown'
  // Exactly one entry of this session: with two, the name could be a twin's, and a record would be removed on it.
  const mine = rows.filter((e) => e.j.sessionId === sid)
  if (mine.length > 1) return 'unknown'
  const name = mine[0]?.j.name
  const cwd = await sessionRoot($)
  if (typeof name !== 'string' || rows.some((e) => e.j.name === name && e.j.sessionId !== sid)) return 'none'
  for (const s of await loadStores($)) {
    if (!s.store.lanes.some((l) => l.name === name && l.adopted && l.folder === cwd)) continue
    return (await dropRecord($, name, s.key, undefined, cwd).catch(() => false)) ? 'removed' : 'stuck'
  }
  return 'none'
}

export async function leadVerbCall($: any, e: any, next: any, verb: (typeof c.LEAD_VERBS)[number]) {
  return leadRun($, e, async () => {
      const sid = await $.session.id()
      const deadline = (await $.clock.now()) + c.RESULT_DEADLINE_MS
      ensureTimer($)
      const no = async (reason: string, why: string) => {
        await log($, sid, 'refused', `lead-${reason}`)
        return { deny: leadReason(verb, why) }
      }
      // The manager's lane_compact may name a live lead by its session name, in any repo (leadByName).
      // The conductor's too, for a lead of its repos.
      if (verb === 'compact' && (grantOf(sid)?.level === 'manager' || grantOf(sid)?.level === 'conductor')) {
        const ld = await leadByName($, e, sid)
        if (ld && 'err' in ld) return no(...ld.err)
        if (ld) {
          const sent = await cueExchange($, sid, ld.name, ld.sid, 'compact', deadline, no)
          if (sent) return sent
          return { result: `cue compact acted for lead ${ld.name}.` } as never
        }
      }
      let prep = await leadPrep($, e, sid)
      if ('err' in prep) return no(...prep.err)
      // A parked lane keeps its conversation: a new session is never bound over it (lane_unpark reopens it).
      if (verb === 'rename' && prep.lane.parked !== undefined) return no('parked', c.reasonWhy('parked'))
      let to = c.leadTarget(prep.entries, prep.lane, sid, verb, (e as { sid?: unknown }).sid)
      for (let i = 0; verb === 'start' && !to.ok && to.reason === 'no-live-session' && i < c.START_WAIT_TRIES; i++) {
        if (!(await pause($, c.START_WAIT_MS))) break
        const again = await leadPrep($, e, sid)
        if ('err' in again) return no(...again.err)
        prep = again
        to = c.leadTarget(prep.entries, prep.lane, sid, verb, (e as { sid?: unknown }).sid)
      }
      if (!to.ok) return no(to.reason, c.reasonWhy(to.reason))
      // A lead's lane_compact never cues a session that holds a live presence file (another lead carrying the lane's name),
      // as leadByName's lane-or-lead; a file whose check could not be made counts (fail closed).
      if (verb === 'compact' && (grantOf(sid)?.level === 'lead' || grantOf(sid)?.level === 'conductor')) {
        const live = await registryEntries($)
        if (!live) return no('registry-unreadable', c.reasonWhy('registry-unreadable'))
        if (await presenceHeld($, live, to.sid)) return no('lane-or-lead', c.reasonWhy('lane-or-lead'))
      }
      const sent = await cueExchange($, sid, prep.lane.name, to.sid, verb, deadline, no)
      if (sent) return sent
      return { result: `cue ${verb} acted for lane ${prep.lane.name}.` } as never
    })
}

export async function laneCreateCall($: any, e: any, next: any) {
  return leadRun($, e, async () => {
    const sid = await $.session.id()
    ensureTimer($)
    await reservedGet($, sid, true)
    const no = async (reason: string, why: string) => {
      await log($, sid, 'refused', `lead-${reason}`)
      return { deny: leadReason('create', why) }
    }
    if ((e as { agentId?: string }).agentId !== undefined) return no('subagent', 'for the main agent only.')
    // The manager never creates a lane (it has no pin either).
    if (grantOf(sid)?.level === 'manager') return no('manager-tool', c.REASON_TEXT['manager-tool'])
    if (grantOf(sid)?.level === 'conductor') return no('conductor-tool', c.REASON_TEXT['conductor-tool'])
    const pin = pinOf(sid)
    if (pin === undefined) return no('off', 'the lead tools are off. Ask the person to turn them on.')
    const p = await where($)
    if (!p) return no('no-paths', 'no-paths')
    const home = homeOf(p)
    const broad = c.pinRefusal(pin, home)
    if (broad) return no(broad, `${broad}: the lead folder is too broad or not a plain path, so it cannot hold lanes.`)
    if ((await real($, pin)) !== pin) return no('pin-link', 'pin-link: the lead folder is not its own real path.')
    const g = await gitRoot($, pin)
    if (g === 'error') return no('pin-check-error', 'pin-check-error: the lead folder could not be checked. Retry in a moment.')
    if (g !== 'yes') return no('pin-no-git', 'pin-no-git: the lead folder is not a git repo root.')
    const key = await sha($, pin)
    const a = e as { name?: unknown; task?: unknown; folder?: unknown; model?: unknown }
    let made: c.Lane | undefined
    const w = await ownWrite($, sid, () => editStore(
      $,
      key,
      async (cur, lanes: c.Lane[]) => {
        if (cur.state === 'bad') return { no: 'store-unreadable' }
        const parsed = cur.state === 'ok' ? c.parseStore(cur.text) : undefined
        if (parsed && !parsed.ok) return { no: parsed.reason }
        const parsedStore = parsed && parsed.ok ? parsed.store : undefined
        if (parsedStore && parsedStore.repo !== pin) return { no: 'store-repo' }
        // Records whose folder no longer resolves are invisible to every reader; they are dropped when the list is rewritten (judged here, on the record itself).
        const kept = parsedStore ? await keptLanes($, parsedStore.lanes) : []
        const store = parsedStore ? { ...parsedStore, lanes: kept } : undefined
        const now = await $.clock.now()
        const r = c.createRefusal({ name: a.name, task: a.task, folder: a.folder, model: a.model }, pin, lanes, store, now)
        if (!r.ok) return { no: r.reason, why: c.reasonWhy(r.reason) }
        const reg = await registryEntries($)
        if (!reg) return { no: 'registry-unreadable', why: c.REASON_TEXT['registry-unreadable'] }
        // Any letter case: a lane `alpha` beside lead `Alpha` would make c.leadNameOf void the lead's name and strand its lanes.
        if (reg.some((x) => typeof x.j.name === 'string' && x.j.name.toLowerCase() === r.lane.name.toLowerCase())) return { no: 'name-in-use', why: 'name-in-use: a live session already carries that name.' }
        // The record names this lead by its registry name now, so only it reaches the lane. A lead that had a name at its grant (the cached one) and has
        // none now is refused, so its lane is not made legacy by a passing clash; so is one with no name beside another live lead of the repo, whose
        // legacy lane that lead would reach too. A lone lead that never had a name makes a legacy lane, reachable by any lead of the repo.
        const leadName = c.leadNameOf(reg.map((x) => x.j), sid)
        if (leadName === undefined && ((grantOf(sid)?.name ?? '') !== '' || (await leadsFor($, reg, pin, pin)).some((x) => x.sid !== sid))) return { no: 'lead-unnamed', why: c.reasonWhy('lead-unnamed') }
        const lane = { ...r.lane, ...(leadName !== undefined ? { leadName } : {}), leadSid: sid }
        const df = await facts($, r.lane.folder)
        if (!df || df.kind !== 'dir' || df.uid !== p.uid || (await real($, r.lane.folder)) !== r.lane.folder) return { no: 'folder-bad', why: 'folder-bad: the folder must exist and be its own real path.' }
        // The brief is written only once every other check has passed; a store-changed retry writes the same text again. The checks below run after the write.
        const wb = await writeBrief($, p.uid, r.lane.brief, c.briefHead(r.lane.name), c.briefText(r.lane.name, a.task as string))
        if (wb) return { no: wb, why: c.reasonWhy(wb) }
        const bf = await facts($, r.lane.brief)
        if (!bf || bf.kind !== 'file' || bf.nlink !== 1 || bf.uid !== p.uid || (await real($, r.lane.brief)) !== r.lane.brief) return { no: 'brief-missing', why: c.reasonWhy('brief-missing') }
        const keep = kept.filter((l) => l.name !== r.lane.name).map(c.storeLaneJson)
        const text = JSON.stringify({
          repo: pin,
          lanes: [...keep, c.storeLaneJson(lane)],
          creates: [...(parsedStore?.creates ?? []).filter((t) => now - t < c.HOUR_MS && t <= now), now],
        })
        if (text.length > c.STORE_MAX_BYTES) return { no: 'store-size' }
        made = lane
        return { text, landed: (s) => !!s?.lanes.some((l) => l.name === r.lane.name && l.folder === r.lane.folder && l.leadName === lane.leadName && l.leadSid === sid) }
      },
      async () => {
        const lanes = await loadLanes($)
        return typeof lanes === 'string' ? { no: lanes } : lanes
      },
    ))
    if ('no' in w) return no(w.no, w.why ?? c.reasonWhy(w.no))
    await log($, sid, 'lane-created', made!.name)
    toast($, `Lane ${made!.name} created (model ${made!.model})`)
    return { result: `lane ${made!.name} created (model ${made!.model}); brief written to ${made!.brief}.${made!.leadName ? '' : c.LANE_NO_LEAD} Next: lane_open, then lane_rename with the id it returns, then lane_start.` } as never
  })
}

export async function laneOpenCall($: any, e: any, next: any) {
  return leadRun($, e, async () => {
    const sid = await $.session.id()
    ensureTimer($)
    const no = async (reason: string, why: string) => {
      await log($, sid, 'refused', `lead-${reason}`)
      return { deny: leadReason('open', why) }
    }
    const prep = await leadPrep($, e, sid)
    if ('err' in prep) return no(...prep.err)
    if (prep.lane.adopted) return no('adopted-record', c.reasonWhy('adopted-record'))
    if (prep.lane.parked !== undefined) return no('parked', c.reasonWhy('parked'))
    if (prep.entries.some((x) => x.name === prep.lane.name)) return no('name-in-use', 'a live session already carries that lane name.')
    const p = await where($)
    if (!p) return no('no-paths', 'no-paths')
    const result = `${p.root}/open/${prep.lane.name}.result`
    const request = `${p.root}/open/${prep.lane.name}.open`
    if (!(await resultDirOk($, p, 'open'))) return no('unsafe-open-dir', 'unsafe-open-dir: ~/.claude/callboard/open is not a private folder of yours. Ask the person to check it.')
    const openDeadline = (await $.clock.now()) + c.OPEN_POLL_MS * c.OPEN_POLL_MAX
    await run($, [RM, '-f', '--', result])
    const w = await writeIn($, 'open', `${prep.lane.name}.open`, c.OPEN_TEXT)
    if ('err' in w) return no(w.err, w.err)
    await log($, sid, 'open-requested', prep.lane.name)
    for (let i = 0; i < c.OPEN_POLL_MAX && (await $.clock.now()) < openDeadline; i++) {
      if (!(await pause($, c.OPEN_POLL_MS))) break
      const a = await readAnswer($, result, p.uid, Math.max(c.OPEN_POLL_MS, Math.min(5000, openDeadline - (await $.clock.now()))))
      if (a.state === 'absent') continue
      if (a.state === 'bad') return no('result-file', 'result-file')
      await run($, [RM, '-f', '--', result])
      const r = c.parseOpenResult(a.text)
      if (!r.ok) {
        const why = r.reason === 'bad-result' ? 'bad-result: the window answer was not valid.' : `${r.reason}: ${c.OPEN_TEXT_BY_CODE[r.reason]}`
        return no(`open-${r.reason}`, why)
      }
      await log($, sid, 'opened', prep.lane.name)
      return { result: `lane ${prep.lane.name}: panel opened as session ${r.sid}. Next: lane_rename with sid ${r.sid}, then lane_start.` } as never
    }
    await run($, [RM, '-f', '--', request])
    return no('open-timeout', 'no window answered in time. A VS Code window with the lane folder as its first workspace folder must run the callboard panels extension. A panel may still appear: check for an unnamed session in that folder first.')
  })
}

// lane_unpark reopens a store lane's saved conversation by its session id (the record's sid), through <LANE>.reopen in the spool; the reopened session
// rebinds itself (the tick's rebind step). Live means a registry row of that id whose process still has its start time. A row of the parked process that
// started before the park mark is waited for (up to 5 s) first: right after lane_park the stopped process can still be exiting.
export async function laneUnparkCall($: any, e: any, next: any) {
  return leadRun($, e, async () => {
    const sid = await $.session.id()
    ensureTimer($)
    const no = async (reason: string, why: string) => {
      await log($, sid, 'refused', `lead-${reason}`)
      return { deny: leadReason('unpark', why) }
    }
    let prep = await leadPrep($, e, sid)
    if ('err' in prep) return no(...prep.err)
    const rec = prep.lane
    const key = rec.src!
    if (rec.sid === undefined) return no('no-saved-session', c.reasonWhy('no-saved-session'))
    const want = rec.sid
    const name = rec.name
    const liveOf = async (entries: c.RegEntry[]) => {
      const out: c.RegEntry[] = []
      for (const x of entries.filter((y) => y.sessionId === want)) if (c.pidRefusal(x, await psStart($, x.pid)) !== 'pid-changed') out.push(x)
      return out
    }
    const stopped = (x: c.RegEntry) => rec.parked === undefined || typeof x.startedAt !== 'number' || x.startedAt <= rec.parked
    let live = await liveOf(prep.entries)
    // With no parked mark there is no park to wait for: one poll, so a process just stopped by a park whose mark failed is not taken for live.
    for (let i = 0; i < (rec.parked === undefined ? 1 : 10) && live.some(stopped); i++) {
      if (!(await pause($, c.OPEN_POLL_MS))) break
      const again = await leadPrep($, e, sid)
      if ('err' in again) return no(...again.err)
      prep = again
      live = await liveOf(prep.entries)
    }
    // The parked mark goes once the conversation is live again; a mark that stays is dropped by the lane's own sid sync once it is bound.
    const unmark = async () => {
      if (rec.parked === undefined) return
      const bad = await parkWrite($, e, sid, key, name, (l) => ({ ...l, parked: undefined }), (l) => l.sid === want)
      if (bad) await log($, sid, 'error', `unpark-unmarked ${bad}`)
    }
    // The parked process itself still running after the wait is not a reopened conversation: refused, never answered as already live.
    if (rec.parked !== undefined && live.some(stopped)) return no('session-live', c.reasonWhy('session-live'))
    if (live.length === 1 && live[0].name === name) {
      await unmark()
      return { result: c.alreadyLiveText(name, want) } as never
    }
    if (live.length > 0) return no('session-live', c.reasonWhy('session-live'))
    if (prep.entries.some((x) => x.name === name && x.sessionId !== want)) return no('name-in-use', c.reasonWhy('name-in-use'))
    const p = await where($)
    if (!p) return no('no-paths', 'no-paths')
    if (!(await resultDirOk($, p, 'open'))) return no('unsafe-open-dir', 'unsafe-open-dir: ~/.claude/callboard/open is not a private folder of yours. Ask the person to check it.')
    const result = `${p.root}/open/${name}.result`
    const request = `${p.root}/open/${name}.reopen`
    const openDeadline = (await $.clock.now()) + c.OPEN_POLL_MS * c.OPEN_POLL_MAX
    await run($, [RM, '-f', '--', result])
    const w = await writeIn($, 'open', `${name}.reopen`, `${want}\n`)
    if ('err' in w) return no(w.err, w.err)
    await log($, sid, 'reopen-requested', name)
    for (let i = 0; i < c.OPEN_POLL_MAX && (await $.clock.now()) < openDeadline; i++) {
      if (!(await pause($, c.OPEN_POLL_MS))) break
      const a = await readAnswer($, result, p.uid, Math.max(c.OPEN_POLL_MS, Math.min(5000, openDeadline - (await $.clock.now()))))
      if (a.state === 'absent') continue
      if (a.state === 'bad') return no('result-file', 'result-file')
      await run($, [RM, '-f', '--', result])
      const r = c.parseOpenResult(a.text, c.REOPEN_TEXT_BY_CODE)
      if (!r.ok) return no(`reopen-${r.reason}`, r.reason === 'bad-result' ? 'bad-result: the window answer was not valid.' : `${r.reason}: ${c.REOPEN_TEXT_BY_CODE[r.reason]}`)
      if (r.sid !== want) return no('reopen-bad-result', c.reasonWhy('reopen-bad-result'))
      await unmark()
      await log($, sid, 'reopened', name)
      toast($, `Lane ${name} reopened`)
      return { result: c.reopenedText(name, want) } as never
    }
    await run($, [RM, '-f', '--', request])
    return no('reopen-timeout', c.reasonWhy('reopen-timeout'))
  })
}

export async function laneListCall($: any, e: any, next: any) {
  return leadRun($, e, async () => {
    const sid = await $.session.id()
    ensureTimer($)
    const sub = (e as { agentId?: string }).agentId !== undefined
    const t = sub ? { err: SUBAGENT } : await laneTable($, sid)
    if ('err' in t) {
      await log($, sid, 'refused', `lead-${t.err[0]}`)
      return { deny: leadReason('list', t.err[1]) }
    }
    return { result: t.text } as never
  })
}

export async function stopVerbCall($: any, e: any, next: any, verb: (typeof c.STOP_VERBS)[number]) {
  return leadRun($, e, async () => {
      const sid = await $.session.id()
      let deadline = (await $.clock.now()) + c.RESULT_DEADLINE_MS
      ensureTimer($)
      let lastCode = ''
      const no = async (reason: string, why: string) => {
        lastCode = reason
        await log($, sid, 'refused', `lead-${reason}`)
        return { deny: leadReason(verb, why) }
      }
      // The level the call started under. At manager reach every stop asks the person once, in a dialog that names the repo, and nothing is
      // signalled unless the grant still holds at that level after the click.
      const level = grantOf(sid)?.level
      // The grant is the same one, not only the same level (an off and a new grant meanwhile ends the call).
      const epoch = epochOf(sid)
      const heldNow = () => grantOf(sid)?.level === level && epochOf(sid) === epoch
      // The engine abandons the dispatch when its time ran out or the person interrupted (`next.signal` aborts: plugin-authoring reference, "Work that outlives a dispatch");
      // the answer then went out already, so nothing may be signalled after it. An abandoned call answers nothing anyone reads, so it logs nothing and returns at once.
      const abandoned = () => next?.signal?.aborted === true
      const cut = () => ({ deny: leadReason(verb, c.reasonWhy('abandoned')) })
      let prep = await leadPrep($, e, sid)
      if ('err' in prep) return no(...prep.err)
      let one = c.laneSession(prep.entries, prep.lane, sid)
      // A retire or a force stop of a lane no live session carries removes its record directly (stopNoSession); a park has nothing to stop.
      if (!one.ok && one.reason === 'no-live-session' && verb !== 'park') return stopNoSession($, e, sid, verb, level, prep, no, abandoned)
      if (!one.ok) return no(one.reason, c.reasonWhy(one.reason))
      // A retire or park waits for the lane's idle time itself, up to c.IDLE_WAIT_MS, so a lead that calls it right after the lane's last turn
      // need not time it. Every poll reads the lane and the registry afresh (leadPrep, laneSession) and the grant again; the session must stay the same process.
      // Past the wait the check below refuses, naming the seconds left. The answer wait of the cue starts after this one (the deadline is set again).
      if (verb !== 'terminate' && c.idleRefusal(one.entry, await $.clock.now())) {
        const first = one.entry
        const until = (await $.clock.now()) + c.IDLE_WAIT_MS
        for (;;) {
          const left = until - (await $.clock.now())
          if (left <= 0) break
          // If the wait cannot run, the check below refuses naming the seconds left; looping on a failing wait would spin.
          const waited = await pause($, Math.min(c.IDLE_POLL_MS, left))
          if (abandoned()) return cut()
          if (!heldNow()) return no('grant-changed', c.reasonWhy('grant-changed'))
          if (!waited) break
          const again = await leadPrep($, e, sid)
          // A read that fails now and then (the lane's own registry row is rewritten just as it turns idle) is polled again; the refusal comes at the deadline.
          if ('err' in again && ['registry-unreadable', 'store-unreadable', 'store-busy'].includes(again.err[0])) continue
          if ('err' in again) return no(...again.err)
          const two = c.laneSession(again.entries, again.lane, sid)
          if (!two.ok) return no(two.reason, c.reasonWhy(two.reason))
          if (two.entry.sessionId !== first.sessionId || two.entry.pid !== first.pid || !c.sameStart(two.entry.procStart, first.procStart)) return no('session-changed', c.reasonWhy('session-changed'))
          prep = again
          one = two
          if (!c.idleRefusal(two.entry, await $.clock.now())) break
        }
        deadline = (await $.clock.now()) + c.RESULT_DEADLINE_MS
      }
      const target = one.entry
      if (!Number.isInteger(target.pid) || (target.pid as number) < 2) return no('no-pid', c.reasonWhy('no-pid'))
      // Before any dialog or cue: one registry file carries the session id (a file left by a process that ended would make the pid below ambiguous).
      if (prep.entries.filter((x) => x.sessionId === target.sessionId).some((x) => x !== target)) return no('session-duplicate', c.reasonWhy('session-duplicate'))
      // Exactly one entry of this session, as attach: with two, neither pid is known to be this process, so the self check below has none.
      const selfRows = prep.entries.filter((x) => x.sessionId === sid)
      const selfPid = selfRows.length === 1 ? selfRows[0].pid : undefined
      // At manager reach, before any dialog and again after it: a record that names a session must name this one, and the
      // session must hold no live presence file (a lead, a conductor or the manager may carry a lane's name: leadByName guards only lane_compact).
      const targetNo = async (lane: c.Lane, t: c.RegEntry) => {
        // A conductor's stop takes the manager's wide path.
        if (level === 'lead') return undefined
        if (lane.sid !== undefined && lane.sid !== t.sessionId) return no('sid-mismatch', c.reasonWhy('sid-mismatch'))
        const live = await registryEntries($)
        if (!live) return no('registry-unreadable', c.reasonWhy('registry-unreadable'))
        return (await presenceHeld($, live, t.sessionId)) ? no('target-is-lead', c.reasonWhy('target-is-lead')) : undefined
      }
      const notLane = await targetNo(prep.lane, target)
      if (notLane) return notLane
      const procCheck = async (t: c.RegEntry) => {
        // Any registry entry of this session itself, not only the one counted as its own: with a twin, the self check must still hold.
        if (selfRows.some((x) => x.pid === t.pid)) return no('self', c.reasonWhy('self'))
        const bad = c.pidRefusal(t, await psStart($, t.pid))
        if (bad) return no(bad, c.reasonWhy(bad))
        const notClaude = c.processRefusal(await psArgs($, t.pid), t.pid, selfPid)
        return notClaude ? no(notClaude, c.reasonWhy(notClaude)) : undefined
      }
      // After any wait (the person's dialog, the target's answer) the signal goes only to the process that was checked before it: the grant is still on, the lane
      // still this lead's and on exactly one live session, exactly one registry entry carries the session id and it is that one, and session id, pid and start
      // time are unchanged; then the process checks run again. `between` runs on the fresh entry before the process checks.
      const recheck = async (between?: (v: c.RegEntry) => Promise<{ deny: string } | undefined>): Promise<{ deny: string } | { victim: c.RegEntry }> => {
        const again = await leadPrep($, e, sid)
        if ('err' in again) return no(...again.err)
        if (!heldNow()) return no('grant-changed', c.reasonWhy('grant-changed'))
        const two = c.laneSession(again.entries, again.lane, sid)
        if (!two.ok) return no(two.reason, c.reasonWhy(two.reason))
        const v = two.entry
        // A regEntry whose file name is not its pid has no pid.
        const same = again.entries.filter((x) => x.sessionId === target.sessionId)
        if (same.length !== 1 || same[0] !== v) return no('session-changed', c.reasonWhy('session-changed'))
        if (v.sessionId !== target.sessionId || v.pid !== target.pid || !c.sameStart(v.procStart, target.procStart)) return no('session-changed', c.reasonWhy('session-changed'))
        const notLaneNow = await targetNo(again.lane, v)
        if (notLaneNow) return notLaneNow
        const held = await between?.(v)
        if (held) return held
        return (await procCheck(v)) ?? { victim: v }
      }
      let victim = target
      if (verb === 'terminate') {
        // The dialog shows a pid and a short session id: they must belong to a live claude process with that start time.
        const early = await procCheck(target)
        if (early) return early
        // At manager reach the question names the repo and is the one dialog of the session (askOnce): a second stop while it is open is refused busy.
        const r = level !== 'lead'
          ? await askOnce($, sid, c.terminateQuestion(prep.lane.name, target.sessionId, target.pid as number, prep.lane.repo, !prep.lane.adopted), c.TERMINATE_YES, c.TERMINATE_NO, c.HEADER.stop)
          : await ask($, c.terminateQuestion(prep.lane.name, target.sessionId, target.pid as number, undefined, !prep.lane.adopted), c.TERMINATE_YES, c.TERMINATE_NO, c.HEADER.stop)
        if (r === 'busy') return no('busy', c.reasonWhy('busy'))
        if (r === 'timed-out') return { deny: leadReason(verb, `${await timedOut($, sid)}.`) }
        if (r !== 'yes') return no('not-confirmed', 'the person did not confirm.')
        const fresh = await recheck()
        if ('deny' in fresh) {
          // The person clicked Force stop and nothing was sent: say so, with the code only.
          toast($, `Force stop not sent: ${lastCode}`)
          return fresh
        }
        victim = fresh.victim
      } else {
        // The registry and the report are a first filter only: the session itself confirms (draft box, idle, background agents and shells, a report newer than its last prompt).
        const idle = c.idleRefusal(target, await $.clock.now())
        if (idle) return no(idle, c.notIdleText(target, await $.clock.now()))
        // A park keeps the conversation: no signed report is needed.
        if (verb === 'retire') {
          const bad = await reportCheck($, prep.lane, target)
          if (bad) return no(bad, c.reasonWhy(bad))
        }
        const early = await procCheck(target)
        if (early) return early
        // A retire at manager reach asks the person once before the cue; anything but Retire sends nothing.
        if (verb === 'retire' && level === 'manager') {
          const r = await askOnce($, sid, c.retireQuestion(prep.lane.name, prep.lane.repo!, !prep.lane.adopted), c.RETIRE_YES, c.RETIRE_NO, c.HEADER.stop)
          if (r === 'busy') return no('busy', c.reasonWhy('busy'))
          if (r === 'timed-out') return { deny: leadReason(verb, `${await timedOut($, sid)}.`) }
          if (r !== 'yes') return no('not-confirmed', 'the person did not confirm.')
          if (grantOf(sid)?.level !== level) return no('grant-changed', c.reasonWhy('grant-changed'))
        }
        if (abandoned()) return cut()
      // The cue's answer is waited for from the cue write; a retire after a dialog gets its own full wait.
        const sent = await cueExchange($, sid, prep.lane.name, target.sessionId, verb, verb === 'retire' && level === 'manager' ? (await $.clock.now()) + c.RESULT_DEADLINE_MS : deadline, no, true)
        if (sent) return sent
        // Before the signal, the record must name the session being parked (the sid sync normally did that while it was bound): lane_unpark reopens it by that
        // id, so a park whose record cannot name it sends no signal.
        if (verb === 'park' && prep.lane.sid !== target.sessionId) {
          const named = await parkWrite($, e, sid, prep.lane.src!, prep.lane.name, (l) => ({ ...l, sid: target.sessionId }), () => true)
          if (named) return no(named, c.reasonWhy(named))
        }
        const fresh = await recheck(async (v) => {
          const idleNow = c.idleRefusal(v, await $.clock.now())
          return idleNow ? no(idleNow, c.notIdleText(v, await $.clock.now())) : undefined
        })
        if ('deny' in fresh) return fresh
        victim = fresh.victim
      }
      await log($, sid, verb === 'terminate' ? 'terminating' : verb === 'retire' ? 'retiring' : 'parking', prep.lane.name)
      // The grant is read once more right before the signal (the process checks and the log line above awaited).
      const stale = !heldNow() ? 'grant-changed' : abandoned() ? 'abandoned' : undefined
      if (stale === 'abandoned') {
        if (verb === 'terminate') toast($, 'Force stop not sent: abandoned')
        return cut()
      }
      if (stale) {
        const r = await no(stale, c.reasonWhy(stale))
        if (verb === 'terminate') toast($, `Force stop not sent: ${lastCode}`)
        return r
      }
      const k = await run($, [KILL, '-TERM', String(victim.pid)])
      if (k.exitCode !== 0) return no('kill-failed', 'the signal failed.')
      // The hook's .catch reads this: a call cut off from here on answers that the session was signalled, not "failed closed".
      const callKey = stopCallKey(sid, verb, (e as { lane?: unknown }).lane)
      signalledCalls.set(callKey, { name: prep.lane.name, pid: victim.pid as number })
      // From here the session has its signal, so a failure is answered as what it is: signalled, record unknown (code in the log), never "failed closed".
      const afterSignal = async () => {
        // Ask the VS Code window to close the dead tab: the extension's sweep acts only once that pid is dead and no live session carries the name. Best effort.
        const closeReq = await writeIn($, 'open', `${prep.lane.name}.close`, `${victim.sessionId}\n${victim.pid}\n${prep.lane.name}\n`).catch(() => ({ err: 'throw' }))
        await log($, sid, 'err' in closeReq ? 'error' : 'close-requested', 'err' in closeReq ? 'close-request' : prep.lane.name)
        if (verb === 'retire') toast($, `Lane ${prep.lane.name} retired (idle, report signed)`)
        if (verb === 'park') {
          // After the signal: the mark, only while the record still names the stopped session. It is a label (lane_list, lane_open); lane_unpark needs only sid.
          const at = await $.clock.now()
          const marked = await parkWrite($, e, sid, prep.lane.src!, prep.lane.name, (l) => ({ ...l, parked: at }), (l) => l.sid === victim.sessionId)
          toast($, `Lane ${prep.lane.name} parked`)
          if (marked) {
            await log($, sid, 'park-unmarked', marked)
            return { result: c.parkUnmarkedText(prep.lane.name, victim.pid as number) } as never
          }
          await log($, sid, 'parked', prep.lane.name)
          return { result: c.parkedText(prep.lane.name, victim.pid as number) } as never
        }
        // Retire and force stop end the lane for good: once the session got its signal, its store record goes too (the .archive folder and the
        // report stay). A lane a session joined keeps its record, which stops naming the stopped session, as before. A failed removal is told, with its code; the call
        // can be made again: the record stops naming the stopped session, so a retry goes by name and a by-hand reopen of that conversation asks Restore.
        // The record goes only once the process (that pid and start time) has ended, polled up to c.STOP_POLLS times.
        const ended = async (): Promise<boolean> => {
          for (let i = 0; ; i++) {
            // Only ps's own "no such process" (or another start time at that pid) is an end; a ps that failed is no answer, so the record is kept.
            const at = await psOne($, victim.pid, 'lstart=').catch((): 'error' => 'error')
            if (at === 'gone' || (at !== 'error' && !c.sameStart(victim.procStart, at.out))) return true
            if (i >= c.STOP_POLLS) return false
            // A wait that cannot run ends the call as signalled-with-unknown-record (afterSignal's catch), not as a session that is still running.
            if (!(await pause($, c.STOP_POLL_MS))) throw new Error('pause-failed')
          }
        }
        let outcome: 'removed' | 'kept' | 'alive' | { unremoved: string } = 'kept'
        if (prep.lane.src) {
          if (prep.lane.adopted) await sidClearAfterStop($, sid, prep.lane.src, prep.lane.name, victim.sessionId)
          else if (!(await ended())) {
            // A session that survives its SIGTERM keeps its record, so the lead can still stop it by name; the record stops naming the session at once, so reopening
            // that conversation by hand asks Restore again instead of making it the lane silently.
            outcome = 'alive'
            await logq($, sid, 'error', 'lane-still-running')
            await sidClearAfterStop($, sid, prep.lane.src, prep.lane.name, victim.sessionId)
          } else {
            const gone = await removeRecord($, e, sid, prep.lane.src, prep.lane.name, { kind: 'stopped', victim: victim.sessionId })
            // A record that is gone already (another writer took it out meanwhile) is the outcome wanted.
            if ('no' in gone && gone.no !== 'unknown-lane') {
              outcome = { unremoved: gone.no }
              await logq($, sid, 'error', `lane-unremoved ${gone.no}`)
              await sidClearAfterStop($, sid, prep.lane.src, prep.lane.name, victim.sessionId)
            } else {
              outcome = 'removed'
              await log($, sid, 'lane-removed', prep.lane.name)
            }
          }
        }
        return { result: c.stoppedText(verb as 'retire' | 'terminate', prep.lane.name, victim.pid as number, outcome) } as never
      }
      try {
        return await afterSignal()
      } catch {
        await logq($, sid, 'error', `after-signal-${verb}`)
        return { result: c.afterSignalFailedText(verb as 'retire' | 'park' | 'terminate', prep.lane.name, victim.pid as number) } as never
      } finally {
        signalledCalls.delete(callKey)
      }
    })
}

export async function stopVerbFailed($: any, e: any, next: any, verb: (typeof c.STOP_VERBS)[number]) {
    // The kind of the failure goes to the log, never its text (it could hold a path): throw, or timeout (the hook outran its 10 s of own time;
    // `next.error.kind`, HookFailure in the hook API). Before the signal nothing was done, and the run-on code stops at abandoned(). A call cut off after the signal
    // answers what happened (signalledCalls), never "failed closed". Nothing here may throw: the answer is built first, the log is best effort.
    const kind = next?.error?.kind === 'timeout' ? 'timeout' : 'throw'
    const sid = await Promise.resolve($.session.id()).catch(() => undefined)
    const sent = typeof sid === 'string' ? signalledCalls.get(stopCallKey(sid, verb, (e as { lane?: unknown }).lane)) : undefined
    if (typeof sid === 'string') await logq($, sid, 'error', `lane_${verb}-hook-${kind}${sent ? '-after-signal' : ''}`)
    return sent ? ({ result: c.afterSignalFailedText(verb as 'retire' | 'park' | 'terminate', sent.name, sent.pid) } as never) : { deny: `lane_${verb} failed closed.` }
}
