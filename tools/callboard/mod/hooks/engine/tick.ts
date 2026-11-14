// The tick, its timer and its steps, and the session-start hook that arms them.
// Trust rules held here: one tick runs at a time; a step that throws is logged and does not stop the others.
import type { Request } from '../../types'
import * as c from '../core.ts'
import {
  cmpMarked,
  requestFails,
  leadRestorePending,
  cmpCutPending,
  grants,
  watch,
  leadSavedAt,
  rebindPending,
  rebindBusy,
  checkinBusy,
  orderBusy,
  goneSeen,
  managerRestoreOffered,
  managerRestorePending,
  mem,
} from '../mem.ts'
import { TICK_MS, withTimeout, ACTION_TIMEOUT_MS, log, logq, sha, submitOwn, logFail, where, liveCheckoutCheck } from './base.ts'
import { unlockRetry, answerer, pruneResults, pruneLogs } from './store.ts'
import type { Answer } from './store.ts'
import {
  reservedGet,
  leadRestore,
  conductorTick,
  managerTick,
  pinOf,
  watchInit,
  LEAD,
  presenceTouch,
  presencePrune,
  leadRenameTick,
  watchTick,
  managerSeenStep,
  checkinDue,
  checkinTick,
  orderDue,
  orderTick,
  cfgGet,
  presenceDrop,
  homeOf,
  conductorRestore,
} from './grants.ts'
import { levelSave } from './levels.ts'
import { renameTick, rebindTick, sidSyncDue, sidSync, sweepTaken, claim, handle } from './lanes.ts'
import {
  cmpClear,
  failRequest,
  dropRequest,
  requestOk,
  isEligible,
  doCompact,
  cmpCutTick,
  saveHint,
  nudgeTick,
  keepaliveTick,
  TOOL,
  pruneHints,
} from './compaction.ts'
import { promptCloseTick, promptSweep } from './answer-hook.ts'
import { promptNoticeTick } from './answer-tiers.ts'
import { usageFlush } from './usage.ts'
import { getRequest, getSeen, setInteractive, setRequest, setSeen } from '../state.ts'

const RESUME_TTL_MS = 120_000

export function ensureTimer($: any) {
  if (mem.timerOn) return
  mem.timerOn = true
  $.clock.every(TICK_MS, () => tick($))
}

const REQUEST_FAILS_MAX = 3
const REQUEST_FAIL_SPAN_MS = 60_000

// A once-a-minute step that runs beside the tick, not awaited: its busy flag is set now and cleared when the work itself ends (a work that outlives the
// timeout keeps it set, so the next tick starts no second one). A timeout logs <label>-timeout and a throw <label>-error; a failing log is swallowed.
function bgStep($: any, sid: string, busy: Set<string>, label: string, work: () => Promise<unknown>) {
  busy.add(sid)
  void withTimeout($, work().finally(() => busy.delete(sid)), ACTION_TIMEOUT_MS)
    .then((r) => (r === 'timeout' ? log($, sid, 'error', `${label}-timeout`) : undefined), () => log($, sid, 'error', `${label}-error`))
    .catch(() => undefined)
}

// A step of the tick under the action timeout. A timeout or a throw is logged as `event` with the reason `reason(outcome)` (outcome: 'timeout' or 'error'); a failing log is swallowed.
async function timedStep($: any, sid: string, work: Promise<unknown>, event: string, reason: (outcome: 'timeout' | 'error') => string) {
  const r = await withTimeout($, work, ACTION_TIMEOUT_MS).catch(() => 'error' as const)
  if (r === 'timeout' || r === 'error') await logq($, sid, event, reason(r))
}

// The request step of the tick: what a request needs next (clear, drop, resume, compact now). It is guarded: a step that throws on every tick must not keep the
// cue from being claimed, so a throw is logged and counted, and a request that keeps failing is dropped.
async function requestStep($: any, sid: string) {
  try {
    const read = await getRequest($)
    const req = read.value as Request | null | undefined
    if (cmpMarked.has(sid) && req?.phase !== 'compacting') await cmpClear($, sid)
    if (req && c.requestExpired(req, await $.clock.now())) {
      // A compaction that returned without PostCompact is never confirmed: say so, instead of dropping it silently.
      // Cleared only if it is still the request read here: a PostCompact that landed meanwhile keeps its resume.
      if (req.phase === 'compacting') {
        const told = await withTimeout($, failRequest($, sid, 'compact-unconfirmed', true, read.version), ACTION_TIMEOUT_MS)
        if (told === 'timeout') await log($, sid, 'error', 'tick-timeout')
      } else await dropRequest($, sid, 'expired')
    } else if (req && req.phase === 'compacted') {
      // The engine refuses a submit from inside PostCompact (it would wait on the turn the hook holds), so the resume goes out from here.
      // It expires from the compaction time, not the request time, and the request is cleared before the submit so it can go out at most once.
      if ((await $.clock.now()) - (req.compactedMs ?? req.requestedMs) > RESUME_TTL_MS) await dropRequest($, sid, 'resume-expired')
      else if ((await sha($, req.continuation)) !== req.sha256) await dropRequest($, sid, 'hash-mismatch')
      else {
        const cur = await getRequest($)
        const live = cur.value as Request | null | undefined
        if (!live || live.phase !== 'compacted' || live.id !== req.id) await log($, sid, 'dropped', 'cancelled-before-resume')
        else if ((await $.prompt.read()).text !== '') await dropRequest($, sid, 'draft-in-box')
        else if (!(await requestOk($, sid, live))) await dropRequest($, sid, 'not-eligible')
        else if ((await setRequest($, null, { ifVersion: cur.version })).isSet === false) await log($, sid, 'dropped', 'cancelled-before-resume')
        else {
          const sent = await withTimeout($, submitOwn($, c.compactResumeText(req.continuation)).then(() => 'ok' as const, () => 'failed' as const), ACTION_TIMEOUT_MS)
          if (sent === 'ok') await log($, sid, 'resumed', 'compact')
          else await log($, sid, 'resume-failed', sent === 'timeout' ? 'unconfirmed' : 'compact')
        }
      }
    }
    if (req && req.phase === 'armed' && (req.mode === 'now' || req.ordered === true)) {
      // A request made under the nudge grant keeps its way through every later step (it is the session's own, and only the mod's nudge granted it).
      if (!(req.viaNudge === true || (await isEligible($)))) await dropRequest($, sid, 'not-eligible')
      else {
        const done = await withTimeout($, doCompact($, sid, req, false), ACTION_TIMEOUT_MS)
        if (done === 'timeout') await log($, sid, 'error', 'tick-timeout')
      }
    }
    requestFails.delete(sid)
  } catch {
    await logq($, sid, 'error', 'request')
    const now = await $.clock.now()
    const f = requestFails.get(sid) ?? { n: 0, firstMs: now }
    const n = f.n + 1
    if (n < REQUEST_FAILS_MAX || now - f.firstMs < REQUEST_FAIL_SPAN_MS) requestFails.set(sid, { n, firstMs: f.firstMs })
    else {
      // Dropped; the count restarts whether or not the drop worked.
      requestFails.delete(sid)
      await dropRequest($, sid, 'request-failing').catch(logFail($, sid, 'request-drop'))
    }
  }
}

// A refused cue: the answer to the lead goes first (it is waiting on it), then the log line.
async function answerLog($: any, sid: string, answer: Answer, reason: string) {
  await answer('refused', reason)
  return await log($, sid, 'refused', reason)
}

async function tick($: any) {
  let startedAt: number | undefined
  try {
    const t = await $.clock.now()
    if (mem.lastTimerAt !== undefined && t - mem.lastTimerAt > c.SLEEP_GAP_MS) mem.wokeAt = t
    mem.lastTimerAt = t
    startedAt = t
  } catch {}
  if (mem.isTicking) return
  mem.isTicking = true
  // The keepalive step runs only when no step of this tick submitted anything.
  const submitsAtStart = mem.submits
  let sid: unknown
  let answer: Answer | undefined
  // Set once the request step is behind: the nudge step then runs last, after the cue was claimed and handled (or there was none).
  let nudge = false
  try {
    sid = await $.session.id()
    const p = await where($)
    if (typeof sid !== 'string' || !c.SID_RE.test(sid) || !p) return
    // Not awaited, so a slow store never holds the tick (reservedGet keeps the last good list meanwhile).
    void reservedGet($, sid).catch(() => undefined)
    // The trailing write of a usage reading a measure left owed (usage.ts).
    await usageFlush($, sid).catch(logFail($, sid, 'usage-write'))
    // None of these may stop the cue path below: each logs its own failure.
    const lr = leadRestorePending.get(sid)
    if (lr) await timedStep($, sid, leadRestore($, sid, lr.hint, lr.tries + 1), 'error', (r) => `lead-restore-${r}`)
    // A pending conductor restore, and a running conductor's reach and saved grant.
    await conductorTick($, sid).catch(logFail($, sid, 'conductor-tick'))
    // ADR 0004: close the requests of sessions that are gone, and any older than a day.
    await promptCloseTick($).catch(logFail($, sid, 'prompt-close'))
    await promptSweep($).catch(logFail($, sid, 'prompt-sweep'))
    // A pending manager restore, and a running manager's saved grant.
    await managerTick($, sid).catch(logFail($, sid, 'manager-tick'))
    // The cut-compaction note.
    const cut = cmpCutPending.get(sid)
    if (cut !== undefined) await cmpCutTick($, sid, cut).catch(logFail($, sid, 'compact-cut'))
    if (grants.has(sid)) {
      // A grant restored at start has no lane-list watch yet; and the saved grant is rewritten once a day, with no store read.
      if (!watch.has(sid) && pinOf(sid) !== undefined) await watchInit($, sid).catch(logFail($, sid, 'lane-watch'))
      const savedAt = leadSavedAt.get(sid)
      // A lead's pin only: a later non-lead grant must never save a lead hint without a pin.
      const pin = pinOf(sid)
      if (pin !== undefined && c.leadRefreshDue(savedAt, await $.clock.now(), LEAD.refreshMs)) await levelSave($, sid, LEAD, pin)
      await presenceTouch($, sid).catch(logFail($, sid, 'presence'))
      await presencePrune($).catch(logFail($, sid, 'presence-prune'))
      await leadRenameTick($, sid).catch(logFail($, sid, 'lead-rename'))
      await watchTick($, sid).catch(logFail($, sid, 'lane-watch'))
      // ADR 0004: the notice of a prompt waiting, after the lanes-changed one (a tick submits at most once).
      await promptNoticeTick($, sid, submitsAtStart).catch(logFail($, sid, 'prompt-notice'))
      // The lead's look for a live manager, once a minute; not awaited (as the check-in), so its reads never hold the tick.
      // A due look runs under a timeout (managerSeenStep).
      if (grants.get(sid)?.level === 'lead') void managerSeenStep($, sid as string).catch(() => undefined)
    }
    await unlockRetry($, sid).catch(logFail($, sid, 'unlock-retry'))
    await renameTick($, sid).catch(logFail($, sid, 'rename'))
    if (rebindPending.has(sid) && !rebindBusy.has(sid)) {
      rebindBusy.add(sid)
      await timedStep($, sid, rebindTick($, sid).finally(() => rebindBusy.delete(sid)), 'error', (r) => `rebind-${r}`)
    }
    const due = await sidSyncDue($, sid).catch(() => undefined)
    if (due) await timedStep($, sid, sidSync($, sid, due), 'sid-heal-failed', (r) => r)
    await requestStep($, sid)
    nudge = true
    await sweepTaken($, sid, p).catch(logFail($, sid, 'taken-sweep'))
    const got = await claim($, sid, p)
    if (!got) return
    // Every exit from here on answers the lead, with the inode of the cue file it answers.
    const parsed = 'bad' in got ? undefined : c.parseCue(got.text)
    answer = answerer($, sid, parsed?.ok ? parsed.cue.verb : '-', got.ino)
    if ('bad' in got) return await answerLog($, sid, answer, got.bad)
    if (!parsed!.ok) return await answerLog($, sid, answer, parsed!.reason)
    const done = await withTimeout($, handle($, sid, parsed!.cue, answer, got.mtimeMs).finally(() => saveHint($, sid)), ACTION_TIMEOUT_MS)
    if (done === 'timeout') {
      await answer('held', 'timeout')
      await log($, sid, 'error', 'tick-timeout')
    }
    // A no-op once handle answered; a path that forgot to still answers.
    await answer('refused', 'other')
  } catch {
    if (typeof sid === 'string' && c.SID_RE.test(sid)) {
      await answer?.('refused', 'other').catch(() => undefined)
      await logq($, sid, 'error', 'tick')
    }
  } finally {
    // Stamped before the keepalive step, so a tick's own length is not read as a sleep by the next call. A tick that itself lasted past
    // SLEEP_GAP_MS may have spanned one (or hung): its gap gets no ping either way.
    try {
      const end = await $.clock.now()
      if (startedAt !== undefined && end - startedAt > c.SLEEP_GAP_MS) mem.wokeAt = end
      mem.lastTimerAt = end
    } catch {}
    if (nudge) {
      await nudgeTick($, sid as string).catch(logFail($, sid as string, 'nudge'))
      await keepaliveTick($, sid as string, submitsAtStart).catch(logFail($, sid as string, 'keepalive'))
      // The lead check-in, after the ping, so the submits guard covers both. Only once a minute, for a lead: no timer is started on the other ticks.
      // Not awaited, so a slow observation never holds the tick (and the cue it claims); its own flag keeps one step at a time.
      const s = sid as string
      if (await checkinDue($, s).catch(() => false)) bgStep($, s, checkinBusy, 'checkin', () => checkinTick($, s, submitsAtStart))
      // The deadline of an order, for a lead, a conductor or the manager; once a minute, and only while the session has an order out.
      if (await orderDue($, s).catch(() => false)) bgStep($, s, orderBusy, 'order', () => orderTick($, s, submitsAtStart))
    }
    mem.isTicking = false
  }
}

export async function sessionStart($: any, e: any, next: any) {
  goneSeen.clear()
  const now = await $.clock.now()
  if ((await getSeen($)).value == null) await setSeen($, now)
  // One of the two signs of a person's session for the self-threshold nudge (interactive(): this, or an own registry row). A recorded nudge is left alone (it expires on its own).
  await setInteractive($, (e as { isInteractive?: unknown }).isInteractive === true).catch(async () => logq($, await $.session.id(), 'error', 'interactive'))
  const req = (await getRequest($)).value as Request | null | undefined
  // A request still in $.state means the state survived (a reload, not a restart): a cut-compaction mark then gives no note.
  const stateKept = req != null
  if (req) {
    await setRequest($, null)
    await log($, await $.session.id(), 'dropped', req.phase === 'compacted' ? 'restart-after-compact' : 'restart')
  }
  await $.tool.register({
    name: TOOL,
    description:
      "Ask this session to compact itself. focus: one sentence of printable ASCII saying what this session is (a hint for the summary). continuation: up to 5 lines (max 600) you read back after compaction: your role, the first file to read, the next step, the constraints. mode: now = compact when this turn ends; on-cue = wait for the lead's cue.",
    inputSchema: {
      type: 'object',
      properties: { focus: { type: 'string' }, continuation: { type: 'string' }, mode: { type: 'string', enum: ['now', 'on-cue'] } },
      required: ['focus', 'continuation', 'mode'],
    },
  })
  const me = await $.session.id()
  try {
    await $.command.register({ name: 'callboard', description: 'Give lead, make this session a lane, list the lanes, show status, show or change the settings, or turn lead and lane off for this session', argumentHint: 'help|lanes|status|lead|lane [NAME]|escalation [off]|off' })
  } catch {
    await log($, me, 'error', 'command-register')
  }
  try {
    await pruneHints($, me)
    if (c.parseHint(await $.store.get(`${c.HINT_PREFIX}${me}`), now)) await log($, me, 'hint-found')
  } catch {
    await logq($, me, 'error', 'hint-scan')
  }
  // The settings, read fresh at each start (cfgGet keeps the last good value when the read fails).
  await cfgGet($, me, true)
  await reservedGet($, me, true)
  await pruneResults($).catch(logFail($, me, 'result-prune'))
  await pruneLogs($, me).catch(logFail($, me, 'log-prune'))
  await presenceDrop($, me).catch(logFail($, me, 'presence-drop'))
  // A saved lead grant for this session, then whether a store record names it, looked at from the tick.
  if (c.SID_RE.test(me)) {
    try {
      const raw = await $.store.get(`${c.LEAD_HINT_PREFIX}${me}`)
      if (raw !== undefined) {
        const p = await where($)
        const h = p ? c.parseLeadHint(raw, now, homeOf(p)) : undefined
        if (!p) await log($, me, 'lead-restore-rejected', 'error')
        else if (!h) {
          await $.store.delete(`${c.LEAD_HINT_PREFIX}${me}`)
          await log($, me, 'lead-restore-rejected', 'invalid')
        } else await leadRestore($, me, h, 0)
      }
    } catch {
      await logq($, me, 'lead-restore-rejected', 'error')
    }
    // A saved conductor grant for this session, restored as the lead's is (conductorRestore).
    try {
      const raw = await $.store.get(`${c.CONDUCTOR_HINT_PREFIX}${me}`)
      if (raw !== undefined) {
        const p = await where($)
        const h = p ? c.parseConductorHint(raw, now, homeOf(p)) : undefined
        if (!p) await log($, me, 'conductor-restore-rejected', 'error')
        else if (!h) {
          await $.store.delete(`${c.CONDUCTOR_HINT_PREFIX}${me}`)
          await log($, me, 'conductor-restore-rejected', 'invalid')
        } else await conductorRestore($, me, h, 0)
      }
    } catch {
      await logq($, me, 'conductor-restore-rejected', 'error')
    }
    // A saved manager grant for this session: asked about from the tick (managerTick), not restored here. A session that still holds the grant (a
    // compaction) is not asked.
    try {
      const raw = await $.store.get(`${c.MANAGER_HINT_PREFIX}${me}`)
      if (raw !== undefined && grants.get(me)?.level !== 'manager' && !managerRestoreOffered.has(me)) {
        managerRestoreOffered.add(me)
        const h = c.parseManagerHint(raw, now)
        if (!h) {
          await $.store.delete(`${c.MANAGER_HINT_PREFIX}${me}`)
          await log($, me, 'manager-restore-rejected', 'invalid')
        } else managerRestorePending.set(me, { hint: h, tries: 0 })
      }
    } catch {
      await logq($, me, 'manager-restore-rejected', 'error')
    }
    // A compaction cut off by the restart. A stale mark, or one found while the state survived, goes with no note.
    try {
      const raw = await $.store.get(`${c.CMP_PREFIX}${me}`)
      if (raw !== undefined) {
        if (!stateKept && c.cmpMarkFresh(raw, now)) cmpCutPending.set(me, 0)
        else await cmpClear($, me)
      }
    } catch {
      await logq($, me, 'error', 'cmp-read')
    }
    rebindPending.set(me, { tries: 0 })
  }
  ensureTimer($)
  // Once per session start, after the restores and the timer, so a slow read delays none of them; it only warns.
  await liveCheckoutCheck($, me)
  return next(e)
}
