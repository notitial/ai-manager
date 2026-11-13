// request_compact and the compaction turn, the nudges, the keepalive ping, orders, and the turn and prompt marks.
// Trust rules held here: nudges go only to a person's own interactive session, within the nudge limits; request_compact is refused for a subagent.
import type { Counters, Request } from '../../types'
import * as c from '../core.ts'
import {
  grants,
  lastSaved,
  cmpMarked,
  cmpCutPending,
  lastTurnUnknown,
  turnKind,
  midTurnBusy,
  midTurnSkip,
  midDelivered,
  kaLogged,
  dialogOpen,
  lastSubmitAt,
  pingCount,
  restoredOnce,
  laneBinding,
  rebound,
  noticeTimes,
  relayAskedTurn,
  own,
  unrealOwn,
  mem,
} from '../mem.ts'
import {
  logq,
  where,
  withTimeout,
  logFail,
  log,
  toast,
  psStart,
  run,
  PS,
  submitOwn,
  ACTION_TIMEOUT_MS,
  ask,
  timedOut,
  sha,
  ownTextOf,
  countDown,
} from './base.ts'
import { registryOf, idleCheck, regOnce, loadLanes, registryEntries, noAnswer } from './store.ts'
import type { Reg, Answer } from './store.ts'
import { homeOf, LEAD_RESTORE_TRIES, regEntry, cfgGet, leadBusy } from './grants.ts'
import { reportLaneOf, reportStat, retireReportCheck, sessionRoot, undoLate, detach, keepLaneFacts, briefLane } from './lanes.ts'
import type { Bound } from './lanes.ts'
import { ensureTimer } from './tick.ts'
import { promptDone, promptRelayPost, promptAskingClear, promptRelayTurnEnd } from './answer-hook.ts'
import { promptMidTurnNotice, promptMidFallback } from './answer-tiers.ts'

const counters = { plugin: 'callboard', key: 'counters' } as const
const request = { plugin: 'callboard', key: 'request' } as const
const nudgeDueRef = { plugin: 'callboard', key: 'nudgeDue' } as const
const interactiveRef = { plugin: 'callboard', key: 'interactive' } as const
// When the tick last sent this session a nudge: the grant's start. Only the tick's nudge submit sets it; any stored request_compact, a prompt that is
// not the mod's own, and /callboard off clear it.
const nudgedAtRef = { plugin: 'callboard', key: 'nudgedAt' } as const
// When a lead, conductor or manager last ordered this lane to compact (c.ORDER_MS).
const orderedAtRef = { plugin: 'callboard', key: 'orderedAt' } as const
// The keepalive ping: when the last main-agent turn ended, when the last real one ended (not started by a ping, a nudge, a notice or the lanes-changed
// turn), and when the tick last tried a ping. Kept in the session state: a reload keeps them (the cache is still warm), a restart loses them (unknown: no ping).
const turnEndRef = { plugin: 'callboard', key: 'turnEndAt' } as const
const realEndRef = { plugin: 'callboard', key: 'realEndAt' } as const
const pingAtRef = { plugin: 'callboard', key: 'pingAt' } as const
// `/callboard rest`: when it was typed. A real turn that starts clears it (turn.start), so the next real turn ends it; one typed while a turn runs holds past that turn's end. A reload keeps it.
const restRef = { plugin: 'callboard', key: 'restAt' } as const
// $.state keys declared again where they are used: `claude plugin validate` reads a key in the file that uses it.
const lane = { plugin: 'callboard', key: 'lane' } as const
const lastTurn = { plugin: 'callboard', key: 'lastTurnAt' } as const

export const TOOL = 'request_compact'
const BUSY_AGENT = ['pending', 'running', 'waiting']

const HINT_DELETE_MAX = 50

export async function counts($: any): Promise<Counters> {
  return ((await $.state.get(counters)).value ?? {}) as Counters
}

// Read-modify-write on the counters, read as late as possible and written only if unchanged.
export async function bump($: any, fn: (ct: Counters) => Counters) {
  for (let i = 0; i < 3; i++) {
    const cur = await $.state.get(counters)
    const res = await $.state.set(counters, fn((cur.value ?? {}) as Counters), { ifVersion: cur.version })
    if (res.isSet !== false) return
  }
  throw new Error('counters-conflict')
}

// A session takes lead cues, and may use request_compact with `on-cue`, only when the mod bound it to a lane. A `now` request for itself has its own
// gate (requestGate).
export async function isEligible($: any): Promise<boolean> {
  return (await $.state.get(lane)).value != null
}
// Whether a stored request may still run its way: one the nudge or the session itself granted, a bound lane's, or a lead's own on-cue
// request while it still holds a lead grant (the manager's compact cue acts on it).
export async function requestOk($: any, sid: string, req: Request): Promise<boolean> {
  return req.viaNudge === true || (req.viaLead === true && grants.get(sid)?.level === 'lead') || (await isEligible($))
}

// $.store is a file any same-uid process can write, so this is a hint only (ADR 0002): it is read back only after the person runs
// /callboard lane and allows the restore, and never written for a session that is not bound (an unbound session's
// lane hint is never overwritten, so it keeps its Restore offer).
export async function saveHint($: any, sid: string) {
  try {
    const l = (await $.state.get(lane)).value
    if (!l) return
    const body = { lane: l, counters: await counts($) }
    const sig = JSON.stringify(body)
    const now = await $.clock.now()
    const prev = lastSaved.get(sid)
    if (prev && prev.sig === sig && now - prev.at < c.HINT_REFRESH_MS) return
    await $.store.set(`${c.HINT_PREFIX}${sid}`, { ...body, savedAt: now })
    lastSaved.set(sid, { sig, at: now })
  } catch {
    await logq($, sid, 'error', 'hint-save')
  }
}

export async function pruneHints($: any, me: string) {
  const now = await $.clock.now()
  const all = (await $.store.keys()) as string[]
  const keys = all.filter((k) => k.startsWith(c.HINT_PREFIX)).slice(0, c.HINT_SCAN_MAX)
  let dels = 0
  for (const k of keys) {
    if (dels >= HINT_DELETE_MAX) break
    if (!c.SID_RE.test(k.slice(c.HINT_PREFIX.length)) || !c.parseHint(await $.store.get(k), now)) {
      await $.store.delete(k)
      dels++
    }
  }
  // An order stamp (ord:<sid>) nobody collected (its orderer is gone) goes after a day, under the same cap.
  let ordDels = 0
  for (const k of all.filter((x) => x.startsWith(c.ORDER_PREFIX)).slice(0, c.HINT_SCAN_MAX)) {
    if (ordDels >= HINT_DELETE_MAX) break
    // A read that failed is not a missing value: the stamp stays for the next pass (a deleted one would cost the orderer its notice).
    const v = await Promise.resolve($.store.get(k)).then((x: unknown) => ({ x }), () => null)
    if (!v) continue
    const at = (v.x as { at?: unknown } | null | undefined)?.at
    if (typeof at === 'number' && now >= at && now - at <= c.ORDER_STALE_MS) continue
    ordDels++
    await Promise.resolve()
      .then(() => $.store.delete(k))
      .catch(() => undefined)
  }
  const p = await where($)
  if (!p) return
  // The marks and saved grants of other sessions that fail their parse, each kind under the same caps; the starting session's own is read at start (a saved
  // grant's by its restore).
  const kinds: [string, (v: unknown) => boolean][] = [
    [c.CMP_PREFIX, (v) => c.cmpMarkFresh(v, now)],
    [c.CONDUCTOR_HINT_PREFIX, (v) => !!c.parseConductorHint(v, now, homeOf(p))],
    [c.MANAGER_HINT_PREFIX, (v) => !!c.parseManagerHint(v, now)],
    [c.LEAD_HINT_PREFIX, (v) => !!c.parseLeadHint(v, now, homeOf(p))],
  ]
  for (const [prefix, ok] of kinds) {
    let n = 0
    for (const k of all.filter((x) => x.startsWith(prefix) && x !== `${prefix}${me}`).slice(0, c.HINT_SCAN_MAX)) {
      if (n >= HINT_DELETE_MAX) break
      if (!c.SID_RE.test(k.slice(prefix.length)) || !ok(await $.store.get(k))) {
        await $.store.delete(k)
        n++
      }
    }
  }
}

export function cmpClear($: any, sid: string) {
  cmpMarked.delete(sid)
  // Bounded: a store that does not answer must not hold up PostCompact or the tick.
  return withTimeout($, Promise.resolve($.store.delete(`${c.CMP_PREFIX}${sid}`)).catch(logFail($, sid, 'cmp-clear')), c.ENGINE_CALL_TIMEOUT_MS)
}
// The note goes once, to a person's session only: a headless run under this id leaves the mark (it ages out), and after LEAD_RESTORE_TRIES ticks it is let go.
// The mark is deleted before the append, so a slow append is never repeated; a failed append is logged and not retried.
export async function cmpCutTick($: any, sid: string, tries: number) {
  if (!(await interactive($, sid))) {
    if (tries >= LEAD_RESTORE_TRIES) cmpCutPending.delete(sid)
    else cmpCutPending.set(sid, tries + 1)
    return
  }
  cmpCutPending.delete(sid)
  await cmpClear($, sid)
  let r: any
  try {
    r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: c.COMPACT_CUT_NOTE }] } })
  } catch {
    r = { deny: 'error' }
  }
  if (r?.deny !== undefined) return void (await log($, sid, 'error', 'compact-cut-note'))
  await log($, sid, 'compact-cut')
  toast($, c.COMPACT_CUT_TOAST)
}

async function markTurn($: any, sid: string) {
  try {
    const at = await $.clock.now()
    let size: number | null = null
    try {
      const l = await reportLaneOf($, sid)
      if (l) {
        const st = await reportStat($, l)
        size = 'no' in st ? (st.gone ? -1 : null) : st.f.size
      }
    } catch {}
    const w = await $.state.set(lastTurn, { at, size })
    if (w?.isSet === false) throw new Error('not-set')
    lastTurnUnknown.delete(sid)
  } catch {
    lastTurnUnknown.add(sid)
    await logq($, sid, 'error', 'last-turn')
  }
}

export async function busyAgents($: any): Promise<boolean> {
  return (await $.agent.list()).some((a: { status: string }) => BUSY_AGENT.includes(a.status))
}

// Background shells under this session's own claude process. Its pid comes from the registry: exactly one entry carries the session id, the file name is its
// pid and `ps` agrees with its procStart. Anything else, or a table that cannot be read or trusted, fails closed.
export async function backgroundShells($: any, sid: string, reg: Reg): Promise<'background-work' | 'background-unknown' | undefined> {
  const mine = ((await reg()) ?? []).filter((r) => r.j.sessionId === sid)
  if (mine.length !== 1) return 'background-unknown'
  const me = regEntry(mine[0])
  if (!Number.isInteger(me.pid) || (me.pid as number) < 2 || c.pidRefusal(me, await psStart($, me.pid)) !== undefined) return 'background-unknown'
  const ps = (argv: string[]) => run($, [PS, ...argv], undefined, { LC_ALL: 'C' }).catch(() => undefined)
  const pids = await ps(['-A', '-o', 'pid=,ppid=,comm='])
  if (!pids || pids.exitCode !== 0 || typeof pids.stdout !== 'string' || pids.stdout.length > c.PS_TABLE_MAX) return 'background-unknown'
  const kids = c.childPids(pids.stdout, me.pid as number)
  if (kids === undefined || kids.length > c.PS_CHILDREN_MAX) return 'background-unknown'
  if (kids.length === 0) return undefined
  const rows = await ps(['-o', 'pid=,ppid=,command=', '-p', kids.join(',')])
  if (!rows || rows.exitCode !== 0 || typeof rows.stdout !== 'string' || rows.stdout.length > c.PS_TABLE_MAX) return 'background-unknown'
  const n = c.shellChildren(rows.stdout, me.pid as number)
  return n === undefined ? 'background-unknown' : n > 0 ? 'background-work' : undefined
}

// The compaction nudge. Hooks only record it (nudgeDue in the session state, so it survives a reload); the tick sends it once the session is idle.
// A person's session: session.start said isInteractive, or the session has its own row in the session registry. A VS Code panel may report
// isInteractive false (the engine sets it only under the REPL); a -p run or the SDK writes no row, so it stays out. Both are live checks.
export async function interactive($: any, sid: string): Promise<boolean> {
  if ((await $.state.get(interactiveRef)).value === true) return true
  return (await registryOf($, sid)) !== undefined
}

// A person's own registry row, as the engine writes it for a VS Code panel or a terminal (kind interactive). A `claude --bg` background
// worker has a row too (kind background), so interactive() passes it; this does not. A row with no kind, two rows, or no row fail.
export async function personRow($: any, sid: string, reg: Reg = () => registryEntries($)): Promise<boolean> {
  return (await registryOf($, sid, reg))?.kind === 'interactive'
}

// Whether this session may be nudged at all: a person's session with its own interactive registry row (not isInteractive alone, so a worker is
// never nudged). One that is not bound or on gets the nudge grant for its own `now` request. interactive() still gates the self request and the restores.
function mayNudge($: any, sid: string): Promise<boolean> {
  return personRow($, sid)
}

// Written only if nudgeDue is unchanged since the read: a lead nudge recorded meanwhile (by the tick, while this hook awaited) is never replaced. ping: the
// keepalive step recorded it in place of a ping, so a drop is logged as a missed ping.
async function recordNudge($: any, sid: string, kind: c.NudgeDue['kind'], now: number, ifVersion: number, ping = false, again = false) {
  if ((await $.state.set(nudgeDueRef, { kind, at: now, ...(ping ? { ping: true } : {}), ...(again ? { again: true } : {}) }, { ifVersion })).isSet === false) {
    await log($, sid, 'nudge-skipped', 'changed')
    return false
  }
  await log($, sid, 'nudge-due', again ? `${kind} again` : kind)
  return true
}

// A bound lane whose report is signed and current. Not a lane: false.
async function laneSignedDone($: any, sid: string): Promise<boolean> {
  if ((await $.state.get(lane)).value == null) return false
  const l = await reportLaneOf($, sid)
  return !!l && (await retireReportCheck($, sid, l)) === undefined
}

// The session's state, judged by the tick (process and report reads, too slow for a hook): a bound lane signed done (its report signed and
// current) is not nudged by its own level; working is a bound lane not signed done since its last prompt, or a background agent or shell still
// running. A check that cannot tell counts as working. The state does not change which level nudges (the size alone does); the cache nudge
// still goes only to an idle one.
async function thresholdState($: any, sid: string): Promise<'done' | 'working' | 'idle'> {
  if ((await $.state.get(lane)).value != null) return (await laneSignedDone($, sid)) ? 'done' : 'working'
  if (await busyAgents($)) return 'working'
  if ((await backgroundShells($, sid, regOnce($))) !== undefined) return 'working'
  return 'idle'
}

// The self-threshold, at the end of a main-agent answer of a person's (interactive) session: past the idle level, one `threshold` nudge is recorded.
// The hook reads only the tokens and the cheap state; the tick picks the kind from the size and skips a lane signed done.
async function thresholdNudge($: any, sid: string) {
  if ((await $.state.get(request)).value) return
  const dueRead = await $.state.get(nudgeDueRef)
  if (dueRead.value) return
  const now = await $.clock.now()
  const ct = await counts($)
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const lv = await cfgGet($, sid)
  // At or past the working level a soft nudge inside the gap may be followed by one hard one.
  if (!c.nudgeAllowed(ct, now, tokens >= lv.workingK * 1000)) return
  // Every session, a lead too, is nudged from the idle level on.
  if (tokens < lv.idleK * 1000 || c.compactAllowed(ct, tokens, now)) return
  // After the level, so a turn below it reads no registry.
  if (!(await mayNudge($, sid))) return
  await recordNudge($, sid, 'threshold', now, dueRead.version)
}

// The tick's step: a recorded nudge is dropped once stale (10 minutes), once the session has a request of its own, or once it may not compact;
// it waits only while the session is not idle (a busy session's nudge may instead be taken by the PostToolUse hook, midTurnNudge). A `threshold` nudge then gets
// its kind from the size alone (thresholdKind): none for a lane signed done; below the idle level it is dropped. It is cleared and stamped, and the grant (nudgedAt) set, before the submit (as the compaction
// resume is), so a submit slower than the timeout still goes out once and is never retried; only a submit that threw takes the grant back.
export async function nudgeTick($: any, sid: string) {
  const read = await $.state.get(nudgeDueRef)
  const due = read.value as c.NudgeDue | null | undefined
  if (due == null) return
  const now = await $.clock.now()
  const drop = async (why: string) => {
    await $.state.set(nudgeDueRef, null)
    await log($, sid, 'nudge-dropped', why)
    // A nudge the keepalive step recorded in place of a ping: that gap gets no ping either.
    if (due.ping === true) await log($, sid, 'keepalive-skipped', 'nudge-dropped')
  }
  if (!c.nudgeDueFresh(due, now)) return drop('expired')
  if ((await $.state.get(request)).value) return drop('request')
  if (!(await mayNudge($, sid))) return drop('not-interactive')
  const tokens = (await $.session.usage()).context.tokens ?? 0
  // A lead's nudge is an order: no context floor, and the 30-minute gap does not apply (the hourly cap does).
  const no = c.compactAllowed(await counts($), tokens, now, due.kind === 'lead')
  if (no) return drop(no)
  if ((await idleCheck($, sid)) !== undefined) return
  let kind: c.NudgeKind | undefined = due.kind === 'threshold' ? undefined : due.kind
  if (due.kind === 'threshold') {
    if (await laneSignedDone($, sid)) return drop('lane-done')
    kind = c.thresholdKind(tokens, await cfgGet($, sid))
    if (!kind) return drop('below-level')
  }
  // The kind follows the size now; one that fell back to the soft text (a compaction meanwhile) keeps the gap. Every kind is checked here, not only a threshold one: a lead's or cache nudge recorded while a mid-turn nudge was being claimed would otherwise go out after it, inside the gap.
  // An order is sent past the 30-minute gap, but not after a nudge that went out since it was recorded (the race this check was added for).
  const ct = await counts($)
  if (kind === 'lead' && (ct.lastNudgeMs ?? 0) >= due.at) return drop('nudge-limit')
  if (!c.nudgeAllowed(ct, now, kind === 'working', due.again === true || kind === 'lead')) return drop('nudge-limit')
  if ((await $.state.set(nudgeDueRef, null, { ifVersion: read.version })).isSet === false) return
  await bump($, (ct) => ({ ...ct, lastNudgeMs: now, lastNudgeKind: kind!, nudgeTimes: c.pushRecent(ct.nudgeTimes ?? [], now) }))
  await $.state.set(nudgedAtRef, now)
  const sent = await withTimeout($, submitOwn($, c.nudgeText(kind!, await cfgGet($, sid)), false).then(() => 'ok' as const, () => 'failed' as const), ACTION_TIMEOUT_MS)
  if (sent === 'failed') await $.state.set(nudgedAtRef, null)
  if (sent === 'failed') turnKind.delete(sid)
  await log($, sid, sent === 'ok' ? 'nudged' : sent === 'timeout' ? 'nudge-unconfirmed' : 'nudge-failed', kind!)
}

// The nudge in the middle of a turn. A session that crosses a level inside a long turn would otherwise learn of it only when the turn ends
// (thresholdNudge) and the tick submits it, and a lane keeps working past 400k meanwhile. After a main-agent tool call (PostToolUse, or its failure) the hook
// below returns the nudge text as additionalContext, which the model reads with the tool's result, before its next step. Same limits as the tick's nudge:
// no request of the session's own, a person's interactive session, not a lane signed done, nudgeAllowed (30-minute gap, one hard after a soft, 3 an hour),
// compactAllowed. A recorded `threshold` nudge is taken over (cleared by version, so the tick's submit and this hook cannot both send it); a lead or cache one is
// left to the tick. The check order is cheap first: the token count, then state reads; a session that may not be nudged is not looked at again for a minute.
// The idle submit stays as the fallback for a turn that ends without a tool call after the level.
const MID_TURN_SKIP_MS = 60_000
// No timer here: a hook has 10 s of its own time and a $.clock.sleep counts against it (see pause), while the $ calls below do not. The claim is the last step before the
// text is returned, so a throw before it consumes nothing; one after it (the log) is caught and cannot cost the nudge.
async function midTurnNudge($: any, e: any): Promise<string | undefined> {
  if (typeof e?.agent_id === 'string' && e.agent_id !== '') return undefined
  const sid = await $.session.id()
  if (typeof sid !== 'string' || !c.SID_RE.test(sid) || midTurnBusy.has(sid)) return undefined
  midTurnBusy.add(sid)
  try {
    const now = await $.clock.now()
    if ((midTurnSkip.get(sid) ?? 0) > now) return undefined
    const lv = await cfgGet($, sid)
    const tokens = (await $.session.usage()).context.tokens ?? 0
    // The cheap gate: most tool calls end here.
    const kind = c.thresholdKind(tokens, lv)
    if (!kind) return undefined
    if ((await $.state.get(request)).value) return undefined
    const read = await $.state.get(nudgeDueRef)
    const due = read.value as c.NudgeDue | null | undefined
    if (due != null && due.kind !== 'threshold') return undefined
    const ct = await counts($)
    if (!c.nudgeAllowed(ct, now, kind === 'working') || c.compactAllowed(ct, tokens, now)) return undefined
    if (!(await mayNudge($, sid)) || (await laneSignedDone($, sid))) {
      midTurnSkip.set(sid, now + MID_TURN_SKIP_MS)
      return undefined
    }
    const text = c.nudgeText(kind, lv)
    // Cleared by version when a nudge was recorded; else the claim is the stamp below, and midTurnBusy keeps a second hook of the same batch out.
    if (due != null && (await $.state.set(nudgeDueRef, null, { ifVersion: read.version })).isSet === false) return undefined
    await bump($, (x) => ({ ...x, lastNudgeMs: now, lastNudgeKind: kind, nudgeTimes: c.pushRecent(x.nudgeTimes ?? [], now) }))
    await $.state.set(nudgedAtRef, now)
    midDelivered.add(sid)
    await logq($, sid, 'nudged', `${kind} mid-turn`)
    return text
  } catch {
    await logq($, sid, 'error', 'mid-turn-nudge')
    return undefined
  } finally {
    midTurnBusy.delete(sid)
  }
}

// The fallback of a mid-turn nudge. The engine may not surface the context, or the model may read it and not act: when the turn that carried it ends
// with no request of the session's own (no request_compact), one `threshold` nudge is recorded with `again`, which skips the 30-minute gap, and the tick sends it as
// the idle turn like any nudge. Once only: that resend is not a mid-turn one, so it records nothing further; a request, a compaction (the compaction gap, or a size back
// under the idle level), a lane signed done or a pending nudge of another kind send nothing (the tick's own checks).
async function midTurnFallback($: any, sid: string) {
  if ((await $.state.get(request)).value) return
  const read = await $.state.get(nudgeDueRef)
  if (read.value) return
  await recordNudge($, sid, 'threshold', await $.clock.now(), read.version, false, true)
}

// The PostToolUse and PostToolUseFailure hook: the prompt answering's done mark (doneHook), then the mid-turn nudge and the lead's mid-turn prompt notice added to the result's additionalContext.
export async function postToolHook($: any, e: any, next: any): Promise<any> {
  await promptDone($, e).catch(() => undefined)
  const r = await next(e)
  // Two texts, never one merged: the nudge, then the notice. Each path claims its own before it returns the text.
  const texts = [await midTurnNudge($, e), await promptMidTurnNotice($, e).catch(() => undefined), await promptRelayPost($, e).catch(() => undefined)].filter((t): t is string => typeof t === 'string')
  if (texts.length === 0) return r
  const extra = (r as { additionalContext?: unknown } | null | undefined)?.additionalContext
  return { ...(r ?? {}), additionalContext: [...(Array.isArray(extra) ? extra : []), ...texts] }
}

// The keepalive ping. The prompt cache lives an hour from the last call, and a turn's last call is at its end, so a session left idle past
// that pays a full re-write at its next turn. The tick's last step sends one fixed ping when, cheap checks first:
// - keepalive is on and no callboard dialog is open;
// - a main-agent turn was seen to end (turnEndAt: after a restart nothing is pinged until one has), the gap since then (or since the last prompt, if later) is at
//   least pingAfterMin, and no ping was tried in this gap;
// - any interactive session (personRow below);
// - the Mac did not sleep in this gap (else logged once);
// - the last real turn ended less than stopAfterH ago (else logged once; a real turn starts the count again), and the gap is at most KEEPALIVE_COLD_MS (past that
//   the cache is cold: logged once, and the next turn starts a new gap);
// - the session has no request and no recorded nudge;
// - the prompt box is empty, the registry reads idle and waiting for nothing, and the session's own registry row is an interactive one: a `claude --bg` background
//   worker (kind background) or a run with no row is never pinged;
// - nothing else was submitted in this tick (a nudge, a resume, a notice, a cue's prompt): one submit per tick.
// Then pingAt is stamped (one attempt per gap, whatever follows): a lane signed done gets nothing; a session past its compact level that may be nudged gets
// the nudge instead, recorded for nudgeTick; an idle one past CACHE_NUDGE_TOKENS after CACHE_NUDGE_AFTER_PINGS pings gets the cache nudge; any other
// gets the ping. A ping that throws or times out is logged and not tried again in that gap.
async function kaOnce($: any, sid: string, key: string, event: string, reason = '') {
  if (kaLogged.get(sid) === key) return
  kaLogged.set(sid, key)
  await log($, sid, event, reason)
}
export async function keepaliveTick($: any, sid: string, submitsAtStart: number) {
  const k = await cfgGet($, sid)
  if (!k.keepalive || dialogOpen.has(sid)) return
  const turnEnd = (await $.state.get(turnEndRef)).value
  const realEnd = (await $.state.get(realEndRef)).value
  // Both come only from a turn.complete this session state saw: after a restart they are unknown (and the cache cold), so nothing is pinged until a turn ends.
  if (typeof turnEnd !== 'number' || typeof realEnd !== 'number') return
  const now = await $.clock.now()
  const gapStart = Math.max(turnEnd, lastSubmitAt.get(sid) ?? 0)
  const gap = now - gapStart
  if (gap < k.pingAfterMin * 60_000) return
  const pingAt = (await $.state.get(pingAtRef)).value
  if (typeof pingAt === 'number' && pingAt >= gapStart) return
  // `/callboard rest`: the person left this session alone for this gap, so no ping and no cache nudge in its slot; the cache may expire.
  const restAt = (await $.state.get(restRef)).value
  if (typeof restAt === 'number') return kaOnce($, sid, `rest:${restAt}`, 'keepalive-skipped', 'rest')
  // Every interactive session, not only a lead, a lane or a session with callboard on; personRow below keeps it to a person's.
  // The Mac slept in this gap (lid closed, a dark wake): no ping; the next turn's gap pings as usual.
  if (mem.wokeAt !== undefined && mem.wokeAt >= gapStart) return kaOnce($, sid, `asleep:${gapStart}`, 'keepalive-skipped', 'asleep')
  if (now - realEnd >= k.stopAfterH * c.HOUR_MS) return kaOnce($, sid, `stopped:${realEnd}`, 'keepalive-stopped')
  if (gap > c.KEEPALIVE_COLD_MS) return kaOnce($, sid, `cold:${gapStart}`, 'keepalive-skipped', 'cold')
  if ((await $.state.get(request)).value != null) return
  const due = await $.state.get(nudgeDueRef)
  if (due.value != null) return
  const reg = regOnce($)
  if ((await idleCheck($, sid, reg)) !== undefined) return
  if (!(await personRow($, sid, reg))) return
  if (mem.submits !== submitsAtStart) return
  if ((await $.state.set(pingAtRef, now)).isSet === false) return
  const st = await thresholdState($, sid)
  if (st === 'done') return log($, sid, 'keepalive-skipped', 'lane-done')
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const ct = await counts($)
  const kind = c.thresholdKind(tokens, k)
  // The reads since the idle check take time: a submit or a draft that came meanwhile wins, and this gap is missed.
  const draft = (await $.prompt.read()).text
  if (mem.submits !== submitsAtStart || draft !== '' || (lastSubmitAt.get(sid) ?? 0) > gapStart) return kaOnce($, sid, `late:${gapStart}`, 'keepalive-skipped', 'late')
  if (kind && c.nudgeAllowed(ct, now, kind === 'working') && !c.compactAllowed(ct, tokens, now)) return recordNudge($, sid, kind, now, due.version, true)
  // An idle session past CACHE_NUDGE_TOKENS that had CACHE_NUDGE_AFTER_PINGS pings since its last real turn gets the cache nudge
  // in this slot instead: compacting while the cache is warm costs less than keeping it warm.
  const pc = pingCount.get(sid)
  const pinged = pc !== undefined && pc.realEnd === realEnd ? pc.count : 0
  if (!kind && pinged >= c.CACHE_NUDGE_AFTER_PINGS && st === 'idle' && tokens >= c.CACHE_NUDGE_TOKENS && c.nudgeAllowed(ct, now) && !c.compactAllowed(ct, tokens, now))
    return recordNudge($, sid, 'cache', now, due.version, true)
  const sent = await withTimeout($, submitOwn($, c.KEEPALIVE_TEXT, false).then(() => 'ok' as const, () => 'failed' as const), ACTION_TIMEOUT_MS)
  if (sent === 'ok') pingCount.set(sid, { realEnd, count: pinged + 1 })
  // A ping that failed leaves no mark its prompt hook may have set: the next turn is not taken for its turn. A timed-out one may still
  // go out, so its mark stays.
  if (sent === 'failed') turnKind.delete(sid)
  await log($, sid, sent === 'ok' ? 'keepalive' : sent === 'timeout' ? 'keepalive-unconfirmed' : 'keepalive-failed')
}

// The lead's lane_compact with no request of the session's own: a session that may be nudged, the same limits as a compaction, no background agents,
// the nudge throttle; then one nudge is recorded. A fresh nudge already pending is answered nudged as it stands (its time is kept, so the lead cannot
// stretch its 10 minutes); a pending one of another kind (size, idle, cache) becomes a lead nudge (the order text, not its own).
export async function leadNudge($: any, sid: string, now: number, answer: Answer, refuse: (reason: string) => Promise<void>) {
  // A cue's path: the session registry, as every cue check.
  if (!(await personRow($, sid, regOnce($)))) return refuse('not-interactive')
  const read = await $.state.get(nudgeDueRef)
  const pending = read.value as c.NudgeDue | null | undefined
  if (c.nudgeDueFresh(pending, now)) {
    if (pending.kind !== 'lead') await $.state.set(nudgeDueRef, { kind: 'lead', at: pending.at }, { ifVersion: read.version })
    await orderStamp($, sid, now)
    await answer('held', 'nudged')
    return log($, sid, 'nudge-pending', pending.kind)
  }
  // The order: the context floor does not apply and neither does the 30-minute gap; the compaction gap and the hourly nudge cap do.
  const ct = await counts($)
  const no = c.compactAllowed(ct, (await $.session.usage()).context.tokens ?? 0, now, true)
  if (no) return refuse(no)
  if (await busyAgents($)) return refuse('background-work')
  if (!c.nudgeAllowed(ct, now, false, true)) return refuse('nudge-limit')
  // A lane that already got this order's text is not sent it again; one whose nudge expired unsent (a long turn) is.
  const ordered = (await $.state.get(orderedAtRef)).value
  if (c.orderFresh(ordered, now) && (ct.lastNudgeMs ?? 0) >= ordered) return refuse('nudge-limit')
  await $.state.set(nudgeDueRef, { kind: 'lead', at: now })
  await orderStamp($, sid, now, true)
  await answer('held', 'nudged')
  await log($, sid, 'nudge-due', 'lead')
}

// Returns the stamp it spent, so a compaction the engine refused can put it back. The store delete is bounded: a store that does not answer must not hold up a compaction.
async function orderSpend($: any, sid: string): Promise<number | null> {
  const was = (await $.state.get(orderedAtRef).catch(() => ({ value: null }))).value
  await $.state.set(orderedAtRef, null).catch(() => undefined)
  await withTimeout($, Promise.resolve($.store.delete(`${c.ORDER_PREFIX}${sid}`)).catch(logFail($, sid, 'order-mark')), c.ENGINE_CALL_TIMEOUT_MS)
  return typeof was === 'number' ? was : null
}

// The lane's side of an order: the stamp that lets one on-cue request_compact pass the floor and count as cued (c.ORDER_MS), kept from the first order of a
// stretch so a repeated lane_compact cannot stretch the deadline, and a copy in $.store under the lane's session id that the orderer reads at the deadline.
// `restart`: the order is being sent again (the earlier one's nudge expired unsent), so its 15 minutes start over, for the lane and for the orderer's deadline.
async function orderStamp($: any, sid: string, now: number, restart = false) {
  if (!restart && c.orderFresh((await $.state.get(orderedAtRef)).value, now)) return
  await $.state.set(orderedAtRef, now)
  await $.store.set(`${c.ORDER_PREFIX}${sid}`, { at: now }).catch(logFail($, sid, 'order-mark'))
  await log($, sid, 'ordered')
}

// A restored binding is never a birth binding: turns -1 and startDone keep `start` shut, and it needs its own named confirmation.
export async function restoreFromHint($: any, sid: string, now: number, stale: () => boolean = () => false): Promise<'timed-out' | void> {
  if (restoredOnce.has(sid)) return
  const raw = await $.store.get(`${c.HINT_PREFIX}${sid}`).catch(() => undefined)
  if (raw === undefined) return
  const hint = c.parseHint(raw, now)
  if (!hint) return log($, sid, 'hint-rejected', 'invalid')
  if (hint.lane && (await $.state.get(lane)).value == null) {
    const lanes = await loadLanes($)
    if (typeof lanes === 'string') return log($, sid, 'hint-rejected', lanes)
    const live = await registryEntries($)
    if (!live) return log($, sid, 'hint-rejected', 'registry-unreadable')
    const others = live.filter((e) => e.j.sessionId !== sid).flatMap((e) => (typeof e.j.name === 'string' ? [e.j.name] : []))
    const no = c.restoreRefusal(hint, lanes, await sessionRoot($), others)
    if (no) {
      if (no !== 'name-in-use') restoredOnce.add(sid)
      return log($, sid, 'hint-rejected', no)
    }
    // A lead is never restored into a lane; the restore stays pending for a /callboard lane after lead off.
    const leadNo = () => log($, sid, 'refused', 'restore-lead-holder')
    if (leadBusy(sid)) return leadNo()
    const answer = await ask($, c.restoreQuestion(hint.lane.name), c.RESTORE_YES, c.RESTORE_NO, c.HEADER.restore)
    if (answer !== 'yes') {
      if (answer === 'no') restoredOnce.add(sid)
      // /callboard lane stops on a question nobody answered, and goes on to Join after a Cancel or a refusal.
      if (answer === 'timed-out') {
        await timedOut($, sid, 'restore-timed-out', c.TIMED_OUT_RESTORE_TOAST)
        return 'timed-out' as const
      }
      return log($, sid, 'refused', 'restore-not-confirmed')
    }
    // The question stayed open for up to 90 s: the same checks run again on fresh reads, and the bind uses the fresh record. The person said yes, so a restore
    // refused from here on says so in a toast.
    const notRestored = async (code: string, pending: boolean) => {
      if (!pending) restoredOnce.add(sid)
      toast($, c.restoreChangedToast(hint.lane!.name))
      return log($, sid, 'hint-rejected', code)
    }
    const lanesNow = await loadLanes($)
    if (typeof lanesNow === 'string') return notRestored(lanesNow, true)
    const liveNow = await registryEntries($)
    if (!liveNow) return notRestored('registry-unreadable', true)
    const othersNow = liveNow.filter((e) => e.j.sessionId !== sid).flatMap((e) => (typeof e.j.name === 'string' ? [e.j.name] : []))
    const noNow = c.restoreRefusal(hint, lanesNow, await sessionRoot($), othersNow)
    if (noNow) return notRestored(noNow, noNow === 'name-in-use')
    if (stale()) return log($, sid, 'refused', 'off-meanwhile')
    // A rebind that landed while the question was open bound the session already, and said so: no "things changed" toast then.
    if (leadBusy(sid) || laneBinding.has(sid)) {
      if (!rebound.has(sid)) toast($, c.restoreChangedToast(hint.lane.name))
      return leadNo()
    }
    laneBinding.add(sid)
    const rec = lanesNow.find((x) => x.name === hint.lane!.name)!
    let binding: Bound | undefined
    try {
      // Inside the mark: a birth rename cue takes the same mark before its own write, so this read cannot miss a binding written meanwhile.
      // A read that does not answer counts as a binding.
      const held = await withTimeout($, $.state.get(lane), c.ENGINE_CALL_TIMEOUT_MS)
      if (held === 'timeout' || held?.value != null) {
        restoredOnce.add(sid)
        if (!rebound.has(sid)) toast($, c.restoreChangedToast(hint.lane.name))
        return void (await log($, sid, 'refused', 'restore-already-bound'))
      }
      const b = { name: rec.name, at: now, turns: -1, restored: true, rec: await sha($, c.recordText(rec)), ...(rec.adopted ? { adopted: true as const, lead: rec.lead, key: rec.src } : {}) }
      const setting = $.state.set(lane, b)
      const w = await withTimeout($, setting, c.ENGINE_CALL_TIMEOUT_MS)
      if (w === 'timeout') {
        // Not pending: a write that lands late is undone with its hint, so there would be nothing to retry.
        undoLate($, sid, setting, b)
        restoredOnce.add(sid)
        return void (await log($, sid, 'error', 'restore-bind-timeout'))
      }
      if (w?.isSet !== false) binding = b
    } finally {
      laneBinding.delete(sid)
    }
    if (binding) {
      // As attach: an off that landed while the binding was being set ran before there was one, so it is undone here, with no note. The caller says so.
      if (stale()) return void (await detach($, sid, binding))
      // The registry is read again: the dialog may have been open a long time.
      await keepLaneFacts($, sid, rec, rec.adopted === true, rec.adopted ? rec.lead : undefined)
      await briefLane($, sid)
    }
    await bump($, (ct) => ({ ...c.mergeCounters(ct, hint.counters), startDone: true }))
  }
  restoredOnce.add(sid)
  await log($, sid, 'restored')
}

export async function dropRequest($: any, sid: string, reason: string): Promise<boolean> {
  if ((await $.state.get(request)).value) {
    await $.state.set(request, null)
    await log($, sid, 'dropped', reason)
    return true
  }
  return false
}

export async function failRequest($: any, sid: string, reason: string, notice: boolean, ifVersion?: number) {
  if (ifVersion === undefined) await $.state.set(request, null)
  else if ((await $.state.set(request, null, { ifVersion })).isSet === false) return log($, sid, 'dropped', 'changed-meanwhile')
  await log($, sid, 'refused', reason)
  // No notice turn goes to the session for these (the person is at it, or the refusal is final): a toast says that the request ended and why.
  if (!notice) return void toast($, c.compactSkippedToast(reason))
  const now = await $.clock.now()
  const times = noticeTimes.get(sid) ?? []
  if (!c.noticeAllowed(times, now)) return log($, sid, 'notice-capped', reason)
  noticeTimes.set(sid, c.pushRecent(times, now))
  await submitOwn($, c.noticeText(reason), false).catch(() => {
    turnKind.delete(sid)
    return log($, sid, 'notice-failed')
  })
}

// fromCue: the compaction was brought forward by a cue, so the session must be idle with no
// prompt open. For `now`, the request is acted on at the end of the requesting turn, when the
// registry may still read busy; only the draft box is checked there. answer tells the lead (cue only).
export async function doCompact($: any, sid: string, req: Request, fromCue: boolean, answer: Answer = noAnswer) {
  const now = await $.clock.now()
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const refuse = c.compactAllowed(await counts($), tokens, now, req.ordered === true)
  if (refuse) {
    await answer('refused', refuse)
    return failRequest($, sid, refuse, false)
  }
  if (await busyAgents($)) {
    await answer('refused', 'background-work')
    return failRequest($, sid, 'background-work', true)
  }
  const blocked = fromCue ? await idleCheck($, sid) : (await $.prompt.read()).text !== '' ? 'draft-in-box' : undefined
  if (blocked === 'draft-in-box') {
    await answer('refused', 'draft-in-box')
    return failRequest($, sid, 'draft-in-box', false)
  }
  if (blocked) {
    await answer('held', blocked)
    return log($, sid, 'held', blocked)
  }
  const live = (await $.state.get(request)).value as Request | null | undefined
  if (!live || live.id !== req.id || live.phase !== 'armed' || !(await requestOk($, sid, live))) {
    await answer('refused', 'no-request')
    return log($, sid, 'dropped', 'cancelled-before-compact')
  }
  await $.state.set(request, { ...req, phase: 'compacting', compactingMs: await $.clock.now() })
  // A compaction that begins spends the order (whatever request began it): the orderer's deadline finds no stamp. A request that ends without one leaves it.
  const spent = await orderSpend($, sid)
  // The mark that survives a restart (c.CMP_PREFIX); set after `compacting`, so a tick in between cannot clear it as left behind.
  cmpMarked.add(sid)
  const markAt = await $.clock.now()
  await withTimeout($, Promise.resolve($.store.set(`${c.CMP_PREFIX}${sid}`, { at: markAt })).catch(logFail($, sid, 'cmp-mark')), c.ENGINE_CALL_TIMEOUT_MS)
  // A compaction runs far longer than the lead waits: `ok` means it began; its end is in the log (`compacted`).
  await answer('ok')
  await log($, sid, 'compacting', req.mode)
  // Said before the command goes: from here the session compacts, and the person sees that callboard started it.
  toast($, c.COMPACT_START_TOAST)
  try {
    await $.command.run({ command: 'compact', args: req.focus })
  } catch {
    // The engine refused the command: the lane did not compact, so the order stands (its stamp goes back while it is still fresh).
    if (spent !== null && c.orderFresh(spent, await $.clock.now())) await orderStamp($, sid, spent, true).catch(() => undefined)
    await failRequest($, sid, 'rejected', true)
    // The start toast above was said: the person is told it did not start.
    toast($, c.compactSkippedToast('rejected'))
  }
}

export async function requestCompactCall($: any, e: any, next: any) {
  const sid = await $.session.id()
  ensureTimer($)
  if ((e as { agentId?: string }).agentId !== undefined) {
    await log($, sid, 'refused', 'subagent')
    return { deny: 'request_compact is for the main agent only.' }
  }
  // The input first: a session nudged moments ago is let through on its mode, so the mode must be a valid one.
  const v = c.validateRequest(e)
  if (!v.ok) return { deny: `request_compact refused: ${v.reason}` }
  const now = await $.clock.now()
  // Any interactive session may compact itself now (self; requestGate keeps it to mode `now`); the person's session check reads the registry only when the
  // session is not eligible.
  const elig = await isEligible($)
  // A session holding a lead grant may ask on-cue too: only the manager's compact cue acts on it.
  const leadCue = !elig && v.req.mode === 'on-cue' && grants.get(sid)?.level === 'lead'
  const self = !elig && !leadCue && (await interactive($, sid))
  const gate = leadCue ? 'lead' : c.requestGate(elig, v.req.mode, (await $.state.get(nudgedAtRef)).value, now, self)
  if (!gate) {
    await log($, sid, 'refused', 'not-eligible')
    return { deny: "request_compact is not enabled for this session: mode on-cue needs a lane, mode now a person's session." }
  }
  const ct = await counts($)
  // An on-cue request within c.ORDER_MS of an order from the lane's lead is ordered: it passes the context floor and counts as cued (the tick compacts it).
  const ordered = gate === 'eligible' && v.req.mode === 'on-cue' && c.orderFresh((await $.state.get(orderedAtRef)).value, now)
  const early = c.compactAllowed(ct, (await $.session.usage()).context.tokens ?? 0, now, ordered)
  if (early) {
    await log($, sid, 'refused', early)
    return { deny: c.compactDenyText(early, ct.lastCompactMs, now) }
  }
  const sum = await sha($, v.req.continuation)
  // Any stored request spends the grant, before it is stored: a failure after this point leaves no grant behind.
  await $.state.set(nudgedAtRef, null)
  await $.state.set(request, {
    id: `${now}`,
    mode: v.req.mode,
    focus: v.req.focus,
    continuation: v.req.continuation,
    sha256: sum,
    requestedMs: now,
    phase: 'called',
    ...(gate === 'nudge' || gate === 'self' ? { viaNudge: true } : {}),
    ...(gate === 'lead' ? { viaLead: true } : {}),
    ...(ordered ? { ordered: true } : {}),
  })
  await log($, sid, 'requested', ordered ? 'on-cue-ordered' : gate === 'nudge' ? `${v.req.mode}-nudged` : gate === 'self' ? `${v.req.mode}-self` : gate === 'lead' ? `${v.req.mode}-lead` : v.req.mode)
  return { result: 'queued' } as never
}

export async function turnComplete($: any, e: any, next: any) {
  const sid = await $.session.id()
  try {
    const req = (await $.state.get(request)).value as Request | null | undefined
    if (req && (e as { agentId?: string }).agentId === undefined) {
      if (req.phase === 'called') {
        if (e.reason !== 'answer') await dropRequest($, sid, 'turn-ended-badly')
        else {
          await $.state.set(request, { ...req, phase: 'armed' })
          await log($, sid, 'armed', req.mode)
        }
      } else if (req.phase === 'armed' && req.mode === 'on-cue' && req.ordered !== true) {
        await dropRequest($, sid, 'new-turn')
      }
    }
  } catch {
    await dropRequest($, sid, 'turn-complete-error').catch(() => undefined)
  }
  if ((e as { agentId?: string }).agentId === undefined) {
    // When the main agent's turn ended starts the keepalive gap; a real turn (not one the mod's ping, nudge, notice or lanes-changed text started)
    // also restarts the stop clock. A ping turn never records a nudge: a session waiting past its level would otherwise get one after every ping.
    const kind = turnKind.get(sid)
    turnKind.delete(sid)
    try {
      const at = await $.clock.now()
      await $.state.set(turnEndRef, at)
      if (kind === undefined) await $.state.set(realEndRef, at)
    } catch {
      await logq($, sid, 'error', 'turn-end')
    }
    const mid = midDelivered.delete(sid)
    promptMidFallback(sid)
    // A turn that ended has no question open: the tier is no longer asking (a dismissal that fired no hook of its own).
    const askedThisTurn = relayAskedTurn.delete(sid)
    const wasAsking = (await promptAskingClear($, sid).catch(() => false)) || askedThisTurn
    // The question cannot outlive the turn: one still unanswered was dismissed without a hook of its own (probed: the person's X fires neither PostToolUseFailure nor
    // PermissionDenied, and the model only reads "Denied by user"). Its relay is left, so the wait ends and the dialog stays with the person.
    if (wasAsking) await promptRelayTurnEnd($, sid).catch(() => undefined)
    if (kind !== 'ping' && e.reason === 'answer') {
      if (mid) await midTurnFallback($, sid).catch(logFail($, sid, 'nudge-fallback'))
      else await thresholdNudge($, sid).catch(logFail($, sid, 'nudge-check'))
    }
  }
  return next(e)
}

export async function promptSubmit($: any, e: any, next: any) {
  const sid = await $.session.id()
  const n = own.get(e.text) ?? 0
  // A prompt starts a new keepalive gap. The mod's own prompts do not reach this hook (engine 2.1.316); their gap starts at their turn's end.
  // Were an engine to show them, the ping is the one prompt that leaves the turn mark alone: it is no work, so a lane's signed report stays current
  // and a lane signed done is not read as working.
  const ping = n > 0 && e.text === c.KEEPALIVE_TEXT
  lastSubmitAt.set(sid, await $.clock.now())
  // Every other prompt of every origin, the mod's own included, so a signed report goes stale at the next turn.
  if (!ping) await markTurn($, sid)
  if (n > 0) {
    // A turn the ping, a nudge, a notice or the lanes-changed text starts is not real work (A): it does not restart the keepalive stop clock.
    // Nothing is counted down here; the turn.start that carries the text does it, so nothing is counted twice.
    if ((unrealOwn.get(e.text) ?? 0) > 0) turnKind.set(sid, ping ? 'ping' : 'unreal')
    else turnKind.delete(sid)
    return next(e)
  }
  turnKind.delete(sid)
  // A prompt that is not the mod's own ends the nudge grant: it covers the nudge turn and the turns that follow without the person typing.
  if ((await $.state.get(nudgedAtRef)).value != null) await $.state.set(nudgedAtRef, null)
  const req = (await $.state.get(request)).value as Request | null | undefined
  if (req && req.phase !== 'compacting') {
    const dropped = await dropRequest($, sid, req.phase === 'compacted' ? 'user-message-cancelled-resume' : 'new-prompt')
    // A compaction that was queued (called, or armed for the turn's end) is cancelled by the person's message: said, not silent. A resume after a compaction is not a queued one.
    if (dropped && req.phase !== 'compacted') toast($, c.COMPACT_CANCELLED_TOAST)
  }
  return next(e)
}

export async function turnStart($: any, e: any, next: any) {
  // The ping's own turn leaves the turn mark alone, as its prompt does.
  if ((e as { agentId?: string }).agentId === undefined) {
    // A turn that carries one of the mod's own texts (framed or not) is that submit's: counted down, and not real for a not-real text. Any other
    // (a person's prompt, a wake, a queued message) is real.
    const t = ownTextOf((e as { text?: unknown }).text)
    let kind: 'ping' | 'unreal' | undefined
    if (t !== undefined) {
      countDown(own, t)
      if ((unrealOwn.get(t) ?? 0) > 0) {
        countDown(unrealOwn, t)
        kind = t === c.KEEPALIVE_TEXT ? 'ping' : 'unreal'
      }
    }
    const sid = await $.session.id()
    if (kind) turnKind.set(sid, kind)
    else {
      turnKind.delete(sid)
      // A real turn ends a `/callboard rest`.
      if (typeof (await $.state.get(restRef)).value === 'number') await $.state.set(restRef, null).catch(() => undefined)
    }
    if (kind !== 'ping') await markTurn($, sid)
  }
  const req = (await $.state.get(request)).value as Request | null | undefined
  if (req && req.phase === 'armed' && req.mode === 'on-cue' && req.ordered !== true && (e as { agentId?: string }).agentId === undefined) await dropRequest($, await $.session.id(), 'new-turn')
  return next(e)
}

export async function postCompact($: any, e: any, next: any) {
  const sid = await $.session.id()
  try {
    const req = (await $.state.get(request)).value as Request | null | undefined
    if (req && req.phase === 'compacting') {
      const doneAt = await $.clock.now()
      await bump($, (ct) => ({ ...ct, lastCompactMs: doneAt })).catch(() => log($, sid, 'error', 'postcompact-counter'))
      await $.state.set(request, { ...req, phase: 'compacted', compactedMs: doneAt })
      await log($, sid, 'compacted')
      await saveHint($, sid)
    }
  } finally {
    // Any compaction that ended clears the mark, whatever the request says (a reload may have dropped it) and even if the step above threw;
    // after the request, so it delays nothing.
    await cmpClear($, sid)
    // A compaction the mod did not start (the engine's own, the person's /compact) ends the order too, so the orderer is not sent after a lane that compacted.
    await orderSpend($, sid).catch(() => undefined)
  }
  return next(e)
}
