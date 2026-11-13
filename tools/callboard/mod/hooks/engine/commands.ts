// The /callboard command handler and the commands under it (lane, manager, conductor list and grant, config, reserve, check-in, rest, escalation).
// Trust rules held here: a command that grants a level asks the person first; the person-only commands run only from the person's own origin.
import type { Request } from '../../types'
import * as c from '../core.ts'
import * as pr from '../prompts.ts'
import {
  grants,
  offSeq,
  restoredOnce,
  managerDeclared,
  conductorDeclared,
  dialogOpen,
  laneBinding,
  pendingRename,
  conductorRestorePending,
  leadGranting,
  leadRestorePending,
  leadDeclared,
  managerRestorePending,
  conductorHome,
  conductorApproved,
  rebindPending,
  leadEpoch,
  laneObs,
  attnTold,
  laneBrief,
  mem,
} from '../mem.ts'
import { logq, where, askOnce, timedOut, log, pickLead, ask, sha, withTimeout, toast, logFail } from './base.ts'
import type { Asked } from './base.ts'
import { editStore, registryEntries, keptLanes, loadLanes } from './store.ts'
import {
  cfgGet,
  epochOf,
  homeOf,
  leadBusy,
  reservedGet,
  managersLive,
  managerTools,
  presenceDrop,
  presenceTouch,
  leadDrop,
  managerSave,
  briefLead,
  colorLater,
  conductorHeld,
  conductorHere,
  writeConductorFile,
  conductorSave,
  conductorReach,
  conductorAddPlan,
  conductorShowable,
  conductorApply,
  briefConductor,
  nameGrant,
  leadsFor,
  managerForget,
  pinOf,
  secondLeadNo,
  leadSave,
  watchInit,
} from './grants.ts'
import type { CondOut } from './grants.ts'
import {
  detach,
  attachPlan,
  dropRecord,
  undoLate,
  keepLaneFacts,
  briefLane,
  laneTable,
  sessionRoot,
  leadToolsOnce,
  sidClearAll,
} from './lanes.ts'
import type { Bound, Plan } from './lanes.ts'
import { restoreFromHint, saveHint, bump, isEligible, dropRequest } from './compaction.ts'
import { ensureTimer } from './tick.ts'
import { ANSWERING_KEY, ledgerAdd, promptsOff } from './answer-hook.ts'
import { ledgerRestore } from './answer-tiers.ts'

// Until when /callboard checkin pause holds this session's check-ins. A reload keeps it, a restart loses it.
const checkinPauseRef = { plugin: 'callboard', key: 'checkinPauseUntil' } as const
// $.state keys declared again where they are used: `claude plugin validate` reads a key in the file that uses it.
const lane = { plugin: 'callboard', key: 'lane' } as const
const request = { plugin: 'callboard', key: 'request' } as const
const nudgeDueRef = { plugin: 'callboard', key: 'nudgeDue' } as const
const nudgedAtRef = { plugin: 'callboard', key: 'nudgedAt' } as const
const restRef = { plugin: 'callboard', key: 'restAt' } as const

async function restCommand($: any, sid: string, code: string) {
  try {
    if ((await $.state.set(restRef, await $.clock.now())).isSet === false) throw new Error('not set')
  } catch {
    return { text: c.REST_FAILED }
  }
  await logq($, sid, 'command', `rest:${code}`)
  return { text: c.REST_TEXT }
}

// /callboard checkin pause <N>m|<N>h and checkin on: the person's own, as config; a plugin, another session or a script gets a fixed refusal.
async function checkinCommand($: any, sid: string, code: c.OriginCode, op: c.CheckinOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: c.CHECKIN_USAGE }
  if (!c.originIsPerson(code)) {
    await logq($, sid, 'refused', `checkin-not-person:${code}`)
    return { text: c.CHECKIN_NOT_PERSON }
  }
  if (!grants.has(sid)) return { text: c.CHECKIN_NOT_LEAD }
  const now = await $.clock.now()
  const until = op === 'on' ? null : now + op.pauseMs
  if ((await $.state.set(checkinPauseRef, until))?.isSet === false) return { text: c.CHECKIN_UNSAVED }
  await logq($, sid, 'checkin-pause', `${op === 'on' ? 'on' : `${op.pauseMs / 60_000}m`}:${code}`)
  if (until !== null) return { text: c.checkinPausedText(until, now) }
  return { text: (await cfgGet($, sid)).checkin ? c.CHECKIN_ON_TEXT : c.CHECKIN_ON_BUT_OFF }
}

async function laneCommand($: any, sid: string, code: c.OriginCode, arg: c.CommandArg, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  const refuse = async (reason: string) => {
    await log($, sid, 'refused', reason)
    return { text: c.refusalText(reason) }
  }
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `lane-origin:${code}`)
    return { text: c.refusalText('lane-origin') }
  }
  const bound = (await $.state.get(lane)).value as Bound | null | undefined
  if (arg === 'lane-off') {
    if (!bound) return { text: `This session is not a lane. ${c.NO_LANE_RECORD}` }
    const d = await detach($, sid, bound)
    return { text: `This session is no longer lane ${bound.name}.${c.STOPPABLE_BY_NAME(bound.name)}${d.sidKept ? c.SID_KEPT(bound.name) : ''}` }
  }
  const seq = offSeq.get(sid) ?? 0
  const want = (arg as { lane: string | undefined }).lane
  // The Restore fallback: an unbound session whose hint names a lane, with no restore decided yet, is asked
  // the Restore question first (restoreFromHint, every check as before). A restored lane or a question nobody answered ends here; no hint, a refused or a
  // declined restore goes on to Join.
  // A session that was the manager skips the Restore question: attachPlan refuses it. So does one that was a conductor.
  if (!bound && want === undefined && !restoredOnce.has(sid) && !managerDeclared.has(sid) && !conductorDeclared.has(sid)) {
    const now = await $.clock.now()
    if (c.parseHint(await $.store.get(`${c.HINT_PREFIX}${sid}`).catch(() => undefined), now)?.lane) {
      if (dialogOpen.has(sid)) return busy()
      dialogOpen.add(sid)
      let asked: 'timed-out' | void
      try {
        asked = await restoreFromHint($, sid, now, () => (offSeq.get(sid) ?? 0) !== seq)
      } catch {
        await logq($, sid, 'error', 'restore')
      } finally {
        dialogOpen.delete(sid)
      }
      if ((offSeq.get(sid) ?? 0) !== seq) {
        await log($, sid, 'refused', 'off-meanwhile')
        return { text: 'Nothing changed: callboard was turned off meanwhile.' }
      }
      if (asked === 'timed-out') return { text: `Nothing changed: ${c.TIMED_OUT}.` }
      const got = (await $.state.get(lane)).value as Bound | null | undefined
      if (got) {
        // The hint takes the restored binding and the merged counters at once.
        await saveHint($, sid)
        return { text: c.reboundToast(got.name) }
      }
    }
  }
  const first = await attachPlan($, sid, want)
  if ('no' in first) return refuse(first.no)
  // With several leads the person picks one first: the picker and the Join question hold one dialog slot together.
  if (dialogOpen.has(sid)) return busy()
  dialogOpen.add(sid)
  let plan: Plan
  let r: Asked
  try {
    if ('choices' in first) {
      const picked = await pickLead($, first.choices)
      if (picked === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
      if (picked === 'error') {
        await log($, sid, 'refused', 'attach-not-confirmed')
        return { text: 'Cancelled. Nothing changed.' }
      }
      const p = await attachPlan($, sid, want, picked.name)
      if (!('name' in p)) return refuse('no' in p ? p.no : 'changed')
      plan = p
    } else plan = first
    r = await ask($, c.attachQuestion(plan.name, c.folderName(plan.cwd), c.folderName(plan.repo), plan.rename, plan.pick), c.ATTACH_YES, c.ATTACH_NO, c.HEADER.attach)
  } finally {
    dialogOpen.delete(sid)
  }
  if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'attach-not-confirmed')
    return { text: 'Cancelled. Nothing changed.' }
  }
  if ((offSeq.get(sid) ?? 0) !== seq) {
    await log($, sid, 'refused', 'off-meanwhile')
    return { text: 'Nothing changed: callboard was turned off meanwhile.' }
  }
  // The question stayed open for a while: the same facts must still hold, and the same lead, repo, folder and name. A picked lead is looked for by its name.
  const now2 = await attachPlan($, sid, want, plan.pick)
  if ('no' in now2) return refuse(now2.no)
  if ('choices' in now2) return refuse('changed')
  if (now2.name !== plan.name || now2.rename !== plan.rename || now2.lead !== plan.lead || now2.leadName !== plan.leadName || now2.repo !== plan.repo || now2.cwd !== plan.cwd) return refuse('changed')
  // From here until the binding is written, no lead grant may start, and none may be under way.
  if (leadBusy(sid)) return refuse('lead-holder')
  if (laneBinding.has(sid)) return refuse('already-bound')
  laneBinding.add(sid)
  try {
    const now = await $.clock.now()
    // The record names this session (sid), so the lane rebinds itself when the session starts again; sid is not part of the record's hash.
    const rec: c.Lane & { createdAt: number } = { name: plan.name, folder: plan.cwd, brief: `${plan.cwd}/${c.ATTACH_BRIEF}`, repo: plan.repo, createdAt: now, adopted: true, lead: plan.lead, sid, ...(plan.leadName !== undefined ? { leadName: plan.leadName } : {}) }
    const recHash = await sha($, c.recordText(rec))
    const w = await editStore($, plan.key, async (cur) => {
      if (cur.state === 'bad') return { no: 'store-unreadable' }
      const parsed = cur.state === 'ok' ? c.parseStore(cur.text) : undefined
      if (parsed && !parsed.ok) return { no: parsed.reason }
      const st = parsed?.ok ? parsed.store : undefined
      if (st && st.repo !== plan.repo) return { no: 'store-repo' }
      // As lane_create: a record whose folder no longer resolves is invisible to every reader and is dropped here.
      const kept = st ? await keptLanes($, st.lanes) : []
      if (kept.some((l) => l.name === plan.name)) return { no: 'name-taken' }
      if (kept.length >= c.STORE_MAX_LANES) return { no: 'lane-cap' }
      // The lead's name is read again under the lock: a lead renamed since the re-check must not be stamped with its old name.
      const rows = await withTimeout($, registryEntries($), c.ENGINE_CALL_TIMEOUT_MS)
      if (rows === 'timeout' || !rows) return { no: 'registry-unreadable' }
      if (c.leadNameOf(rows.map((e) => e.j), plan.lead) !== plan.leadName) return { no: 'changed' }
      // An attached lane is not a create: the creates list is carried over as it was.
      const text = JSON.stringify({ repo: plan.repo, lanes: [...kept, rec].map(c.storeLaneJson), creates: st?.creates ?? [] })
      if (text.length > c.STORE_MAX_BYTES) return { no: 'store-size' }
      return { text, landed: (s) => !!s?.lanes.some((l) => l.name === plan.name && l.adopted && l.lead === plan.lead && l.leadName === plan.leadName && l.folder === plan.cwd) }
    })
    // The undo of this Join's own write: the record it wrote goes again, with nothing bound to it.
    const undo = () => dropRecord($, plan.name, plan.key, recHash).catch(() => false)
    if ('no' in w) {
      // The write went through but the file does not show it: the record may be there, and nothing is bound to it.
      if (!w.wrote) return refuse(w.no)
      await log($, sid, 'refused', w.no)
      return { text: `Lane not changed: the record was not saved. ${(await undo()) ? 'It was removed.' : c.DETACH_INCOMPLETE}` }
    }
    // /callboard off during the write: the record goes again, and nothing is bound.
    if ((offSeq.get(sid) ?? 0) !== seq) {
      await undo()
      await log($, sid, 'refused', 'off-meanwhile')
      return { text: 'Nothing changed: callboard was turned off meanwhile.' }
    }
    const binding = { name: plan.name, at: now, turns: -1, rec: recHash, adopted: true, lead: plan.lead, key: plan.key }
    let written = false
    // Each engine call held inside the mark has a time limit (the command itself has none): a call that times out takes the failure path below.
    const limited = async <T,>(p: Promise<T>, what: string): Promise<T> => {
      const r = await withTimeout($, p, c.ENGINE_CALL_TIMEOUT_MS)
      if (r === 'timeout') {
        await logq($, sid, 'error', `attach-${what}-timeout`)
        throw new Error(`${what}-timeout`)
      }
      return r
    }
    try {
      await limited(bump($, (ct) => ({ ...ct, startDone: true })), 'counters')
      written = true
      const setting = $.state.set(lane, binding)
      const bw = await limited(setting, 'bind').catch((err: unknown) => {
        // A write that timed out may still land after the detach below: it is undone then.
        if (err instanceof Error && err.message === 'bind-timeout') undoLate($, sid, setting, binding)
        throw err
      })
      if (bw?.isSet !== false) await withTimeout($, keepLaneFacts($, sid, rec, true, plan.lead), c.ENGINE_CALL_TIMEOUT_MS)
      // An off that landed while the binding was being set could not unbind it: it ran before there was one.
      if ((offSeq.get(sid) ?? 0) !== seq) {
        await withTimeout($, detach($, sid, binding), c.ENGINE_CALL_TIMEOUT_MS)
        await undo()
        await log($, sid, 'refused', 'off-meanwhile')
        return { text: 'Nothing changed: callboard was turned off meanwhile.' }
      }
      await limited(saveHint($, sid), 'hint')
    } catch {
      await logq($, sid, 'error', 'attach-bind')
      // From the binding write on, it may be there: detach clears it, its hint and the briefing facts. The detach has the same time limit; undo takes the record back.
      if (written) await withTimeout($, detach($, sid, binding).catch(() => undefined), c.ENGINE_CALL_TIMEOUT_MS)
      await undo()
      return { text: 'Lane not changed: the session could not be bound.' }
    }
    await withTimeout($, briefLane($, sid), c.ENGINE_CALL_TIMEOUT_MS)
    if (plan.rename) pendingRename.set(sid, { name: plan.name, until: now + c.RENAME_PENDING_MS })
    await log($, sid, 'attached', plan.name)
    toast($, `Lane ${plan.name} joined`)
    return { text: c.attachedText(plan.name, c.folderName(plan.cwd), c.folderName(plan.repo), plan.rename) }
  } finally {
    laneBinding.delete(sid)
  }
}

// ---- /callboard manager [NAME] ----
// Any origin, as /callboard lead: the dialog is the gate the person answers, and another origin is named in its question. Refused before the dialog and again
// after a yes: in a bound lane, in a lead, in a session that ever was a lead (its lane tools stay declared: manager-after-lead), and while another live
// session holds a valid manager file (manager-exists). The grant lives in memory, and the person's yes also saves manager:<sid> (managerSave), so the
// same conversation asks again when it starts or resumes (managerRestoreAsk runs this function with restore set: the restore question, and its own log lines).
// After the grant the presence file must be written (one per machine rests on it), and a second manager that won the same moment makes both step back.
export async function managerCommand($: any, sid: string, code: c.OriginCode, want: string | undefined, busy: () => Promise<{ text: string }>, restore = false, alive: () => boolean = () => true): Promise<{ text: string }> {
  await reservedGet($, sid, true)
  // With no NAME, a session whose registry name (one row) is already reserved keeps it; otherwise MANAGER. An unreadable registry
  // gives MANAGER here and is refused by the check below.
  const own = want === undefined ? ((await registryEntries($).catch(() => undefined)) ?? []).filter((e) => e.j.sessionId === sid) : []
  const name = want ?? (own.length === 1 && c.managerNameRefusal(own[0].j.name) === undefined ? (own[0].j.name as string) : c.MANAGER_DEFAULT)
  const refuse = async (why: string) => {
    await log($, sid, restore ? 'manager-restore-rejected' : 'refused', why)
    return { text: c.managerRefusalText(why) }
  }
  if (c.managerNameRefusal(name)) return refuse('manager-name')
  // Another NAME changes nothing, and the answer says so.
  const cur = grants.get(sid)
  if (cur?.level === 'manager') return { text: c.managerAlreadyText(cur.name, want) }
  // marks: the lane and lead marks are this call's to read, not its own (the re-check below runs while it holds leadGranting).
  const held = async (marks: boolean): Promise<string | undefined> => {
    if ((marks && laneBinding.has(sid)) || (await $.state.get(lane)).value != null) return 'lane-holder'
    // A conductor (or one being restored), and a session that was one.
    if (grants.get(sid)?.level === 'conductor' || conductorRestorePending.has(sid)) return 'conductor-holder'
    if (grants.has(sid) || (marks && leadGranting.has(sid)) || leadRestorePending.has(sid)) return 'lead-holder'
    if (leadDeclared.has(sid)) return 'manager-after-lead'
    if (conductorDeclared.has(sid)) return 'manager-after-conductor'
    const live = await registryEntries($)
    if (!live) return 'registry-unreadable'
    return (await managersLive($, live, sid)).length > 0 ? 'manager-exists' : undefined
  }
  const before = await held(true)
  if (before) return refuse(before)
  // A restore whose pending entry went while these checks ran (an /callboard off, a manager grant by hand) asks nothing.
  if (restore && !alive()) return { text: '' }
  const seq = offSeq.get(sid) ?? 0
  const r = await askOnce($, sid, restore ? c.MANAGER_RESTORE_QUESTION : c.askedFrom(c.MANAGER_QUESTION, code), c.MANAGER_YES, c.MANAGER_NO, c.HEADER.manager)
  if (r === 'busy') return busy()
  // A restore: only the person's Cancel removes the saved grant; no answer (a timeout, a dismissal, an error) restores nothing and keeps it.
  if (restore && r !== 'yes') {
    if (r === 'no') {
      await Promise.resolve($.store.delete(`${c.MANAGER_HINT_PREFIX}${sid}`)).catch(logFail($, sid, 'manager-hint-delete'))
      await log($, sid, 'manager-restore-cancelled')
    } else {
      await log($, sid, 'manager-restore-unanswered')
      toast($, c.MANAGER_UNANSWERED_TOAST)
    }
    return { text: 'Manager stays off.' }
  }
  if (r === 'timed-out') {
    await timedOut($, sid)
    return { text: `Manager stays off. ${c.TIMED_OUT_SENTENCE}` }
  }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'manager-not-confirmed')
    return { text: 'Manager stays off.' }
  }
  // The post-click re-check, as the lead's: the marks are read and set with no await between.
  if (restore && !alive()) return refuse('changed')
  if (laneBinding.has(sid) || leadGranting.has(sid)) return refuse(laneBinding.has(sid) ? 'lane-holder' : 'lead-holder')
  leadGranting.add(sid)
  let grantEpoch = -1
  try {
    const after = await withTimeout($, held(false), c.ENGINE_CALL_TIMEOUT_MS)
    if (restore && !alive()) return refuse('changed')
    if (after !== undefined) return refuse(after === 'timeout' ? 'manager-check-slow' : after)
    if ((offSeq.get(sid) ?? 0) !== seq) {
      await log($, sid, 'refused', 'off-meanwhile')
      return { text: 'Nothing changed: callboard was turned off meanwhile.' }
    }
    let set: unknown
    try {
      set = await withTimeout($, managerTools($, sid), c.ENGINE_CALL_TIMEOUT_MS)
    } catch {
      set = 'error'
    }
    if (set !== undefined || (offSeq.get(sid) ?? 0) !== seq) {
      await logq($, sid, 'error', set === undefined ? 'off-meanwhile' : `manager-register-${set}`)
      return { text: c.MANAGER_FAILED }
    }
    grants.set(sid, { level: 'manager', pins: [], name })
    grantEpoch = epochOf(sid)
    // A grant the person made while a restore question was still pending stands; the pending restore ends here.
    managerRestorePending.delete(sid)
  } finally {
    leadGranting.delete(sid)
  }
  await presenceDrop($, sid).catch(() => undefined)
  const wrote = await presenceTouch($, sid).catch(() => false)
  const stepBack = async (why: string) => {
    if (epochOf(sid) === grantEpoch) await leadDrop($, sid)
    if (why !== 'manager-presence') return refuse(why)
    await log($, sid, 'error', why)
    return { text: c.MANAGER_FAILED }
  }
  if (epochOf(sid) !== grantEpoch) return { text: 'Manager is now off.' }
  if (wrote !== true) return stepBack('manager-presence')
  const live = await registryEntries($)
  if (!live) return stepBack('registry-unreadable')
  if ((await managersLive($, live, sid)).length > 0) return stepBack('manager-exists')
  if (epochOf(sid) !== grantEpoch) return { text: 'Manager is now off.' }
  await managerSave($, sid)
  if (epochOf(sid) !== grantEpoch) return { text: 'Manager is now off.' }
  await log($, sid, restore ? 'manager-restored' : 'manager-on', restore ? '' : code)
  if (restore) toast($, c.MANAGER_RESTORED_TOAST)
  await briefLead($, sid, '', name)
  // The rename cannot run inside the command: the tick runs it (as attach), unless the session already carries the name (a launch with -n NAME).
  const mine = live.filter((e) => e.j.sessionId === sid)
  if (mine.length === 1 && mine[0].j.name === name) await log($, sid, 'rename-skipped', 'manager')
  else pendingRename.set(sid, { name, until: (await $.clock.now()) + c.RENAME_PENDING_MS, manager: true })
  colorLater($, sid, grantEpoch)
  return { text: c.MANAGER_ON_TEXT }
}

// /callboard conductor add|remove, the person's own command only (from the prompt or the phone); any other origin is refused with no dialog. add asks once
// (naming the whole list as it would be); remove asks nothing (it only narrows). Neither grants: the grant is /callboard conductor and its own dialog.
async function conductorListCommand($: any, sid: string, code: c.OriginCode, op: { add: string } | { remove: string }, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  const verb = 'add' in op ? 'add' : 'remove'
  if (!c.originIsPerson(code)) {
    await logq($, sid, 'refused', `conductor-not-person:${code}`)
    return { text: c.CONDUCTOR_NOT_PERSON }
  }
  const refuse = async (why: string, home = '') => {
    await log($, sid, 'refused', why)
    return { text: c.conductorRefusalText(why, home) }
  }
  const p = await where($)
  const h = p ? homeOf(p) : undefined
  const inConductor = (home: string) => grants.get(sid)?.level === 'conductor' && conductorHome.get(sid) === home
  if ('remove' in op) {
    const held = await conductorHeld($, sid, true)
    if (held) return refuse(held)
    const here = await conductorHere($)
    if ('no' in here) return refuse(here.no)
    const home = here.home
    let removed: string | undefined
    // The match is made on the file's entries alone, with no filesystem look, so a deleted or renamed repo can still be removed.
    const w = await writeConductorFile($, home, (entries) => {
      const arg = op.remove
      const hits = c.siblingName(arg) ? entries.filter((e) => c.entryPath(home, e).slice(c.entryPath(home, e).lastIndexOf('/') + 1) === arg) : entries.filter((e) => e === arg || c.entryPath(home, e) === c.entryPath(home, arg))
      if (hits.length !== 1) return { no: 'conductor-not-listed' }
      removed = hits[0]
      return entries.filter((e) => e !== removed)
    })
    if ('no' in w) return w.no.startsWith('conductor-file-') && w.no !== 'conductor-file-bad' ? (await log($, sid, 'error', w.no), { text: c.conductorRefusalText(w.no, home) }) : refuse(w.no, home)
    await log($, sid, 'conductor-remove', code)
    if (inConductor(home) && removed !== undefined) {
      const gone = c.entryPath(home, removed)
      const was = conductorApproved.get(sid) ?? []
      if (was.includes(gone)) {
        conductorApproved.set(sid, was.filter((x) => x !== gone))
        await conductorSave($, sid)
      }
      await conductorReach($, sid).catch(() => undefined)
    }
    return { text: c.conductorRemovedText(removed ?? op.remove) }
  }
  const plan = await conductorAddPlan($, sid, op.add, true)
  if ('no' in plan) return refuse(plan.no, plan.home)
  // The click approves the repo for this session only when the dialog said so and the grant is the same one after it.
  const askedHere = inConductor(plan.home)
  const askedEpoch = epochOf(sid)
  const r = await askOnce($, sid, c.conductorAddQuestion(plan.home, plan.target, plan.list, h, askedHere), c.CONDUCTOR_ADD_YES, c.CONDUCTOR_ADD_NO, c.HEADER.conductor)
  if (r === 'busy') return busy()
  if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'conductor-add-not-confirmed')
    return { text: 'Cancelled. Nothing changed.' }
  }
  // Every check again after the click; the target must be the one the dialog named.
  const again = await conductorAddPlan($, sid, op.add, true)
  if ('no' in again) return refuse(again.no, again.home ?? plan.home)
  if (again.home !== plan.home || again.target !== plan.target) return refuse('conductor-file-changed', plan.home)
  const w = await writeConductorFile($, plan.home, (entries) => {
    const paths = entries.map((e) => c.entryPath(plan.home, e))
    const nest = c.nestRefusal(plan.home, paths, plan.target)
    if (nest) return { no: nest }
    if (entries.length + 1 > c.CONDUCTOR_REPOS_MAX) return { no: 'conductor-cap' }
    return [...entries, c.entryFor(plan.home, plan.target)]
  })
  if ('no' in w) return w.no.startsWith('conductor-file-') && w.no !== 'conductor-file-bad' ? (await log($, sid, 'error', w.no), { text: c.conductorRefusalText(w.no, plan.home) }) : refuse(w.no, plan.home)
  await log($, sid, 'conductor-add', code)
  // In a conductor session the click also approves the repo for this session.
  const here = askedHere && inConductor(plan.home) && epochOf(sid) === askedEpoch
  if (here) {
    const was = conductorApproved.get(sid) ?? []
    if (!was.includes(plan.target)) conductorApproved.set(sid, [...was, plan.target])
    await conductorSave($, sid)
    await conductorReach($, sid).catch(() => undefined)
  }
  return { text: c.conductorAddedText(plan.home, plan.target, h, here) }
}

// /callboard conductor, the grant. Any origin, as /callboard lead: the dialog is the gate the person answers, and another origin is named in its question.
// The dialog names every repo in reach (../NAME beside the conductor repo, any other in full; nothing cut). A yes approves exactly that list for this session; the
// file can only narrow it later. In a conductor session the command opens the dialog again only when the file names repos this session has not approved, and
// only from the person's own prompt or phone: another origin never widens a conductor.
async function conductorGrant($: any, sid: string, code: c.OriginCode, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  const on = () => grants.get(sid)?.level === 'conductor'
  const refuse = async (why: string, home = '', out: CondOut[] = []) => {
    await log($, sid, 'refused', why)
    return { text: `${c.conductorRefusalText(why, home, on() ? 'Conductor stays on' : 'Conductor stays off')}${c.conductorOutText(out)}` }
  }
  const p = await where($)
  const h = p ? homeOf(p) : undefined
  const first = await conductorShowable($, sid, true)
  if ('no' in first) return refuse(first.no, first.home, first.out)
  const home = first.home
  if (on()) {
    const approved = conductorApproved.get(sid) ?? []
    if (!c.originIsPerson(code) || first.ok.every((x) => approved.includes(x))) {
      const reach = await conductorReach($, sid)
      return { text: 'no' in reach ? c.conductorRefusalText('conductor-list', home, 'Conductor stays on') : c.conductorReachText(home, reach.pins, h, reach.out) }
    }
  }
  const approvedNow = on() ? (conductorApproved.get(sid) ?? []) : []
  const question = c.askedFrom(c.conductorQuestion(home, first.ok, h, on() ? first.ok.filter((x) => !approvedNow.includes(x)) : []), code)
  if (question.length > c.QUESTION_MAX) return refuse('conductor-list-too-long', home)
  const seq = offSeq.get(sid) ?? 0
  const r = await askOnce($, sid, question, c.CONDUCTOR_YES, c.CONDUCTOR_NO, c.HEADER.conductor)
  if (r === 'busy') return busy()
  if (r !== 'yes') {
    const wasOn = on()
    // A no from the person's own prompt or phone ends the grant and deletes its saved key (as the lead's Cancel); another origin's no, or no answer, changes nothing.
    const kept = r === 'no' && c.originIsPerson(code) && !(await leadDrop($, sid)) ? c.CONDUCTOR_KEPT : ''
    if (r === 'timed-out') {
      await timedOut($, sid)
      return { text: `${on() ? 'Conductor stays on.' : 'Conductor stays off.'} ${c.TIMED_OUT_SENTENCE}` }
    }
    await log($, sid, 'refused', 'conductor-not-confirmed')
    return { text: `${on() ? 'Conductor stays on.' : wasOn ? 'Conductor is now off.' : 'Conductor stays off.'}${kept}` }
  }
  // The post-click re-check, as the lead's and the manager's: the marks are read and set with no await between.
  if (laneBinding.has(sid) || leadGranting.has(sid)) return refuse(laneBinding.has(sid) ? 'lane-holder' : 'lead-holder', home)
  leadGranting.add(sid)
  let grantEpoch = -1
  try {
    const again = await withTimeout($, conductorShowable($, sid, false), c.ENGINE_CALL_TIMEOUT_MS)
    if (again === 'timeout') return refuse('conductor-file-error', home)
    if ('no' in again) return refuse(again.no, again.home ?? home, again.out)
    if ((offSeq.get(sid) ?? 0) !== seq) {
      await log($, sid, 'refused', 'off-meanwhile')
      return { text: 'Nothing changed: callboard was turned off meanwhile.' }
    }
    // The list resolved now must be the list the dialog showed.
    // The same repos in another order (a writer sorts the file) are no change.
    if (again.home !== home || [...again.ok].sort().join('\n') !== [...first.ok].sort().join('\n')) return refuse('conductor-changed', home)
    const a = await conductorApply($, sid, home, first.ok, first.ok, epochOf(sid))
    if (a !== 'ok') {
      await logq($, sid, 'error', `conductor-register-${a}`)
      return { text: c.CONDUCTOR_FAILED }
    }
    grantEpoch = epochOf(sid)
    // A grant the person made while a restore question was still pending stands, as the lead's does; the pending restore ends here,
    // so a later Cancel on its question cannot delete this grant's saved key.
    conductorRestorePending.delete(sid)
  } finally {
    leadGranting.delete(sid)
  }
  await conductorSave($, sid)
  if (epochOf(sid) !== grantEpoch) return { text: 'Conductor is now off.' }
  await presenceDrop($, sid).catch(() => undefined)
  await presenceTouch($, sid).catch(logFail($, sid, 'conductor-presence'))
  await log($, sid, 'conductor-on', code)
  await briefConductor($, sid, home)
  await nameGrant($, sid)
  return { text: `${c.CONDUCTOR_ON_TEXT}${c.conductorOutText(first.out)}` }
}

// /callboard config. Reading works from any origin and logs nothing (as status). A change is the person's own: from the prompt or the phone it is applied,
// from a plugin, another session or a script it is refused with a fixed text and no dialog. That is a convenience, not a control: any same-uid process can
// write the key itself, and the field bounds are what limit it. The change is a read-modify-write right before the write (two sessions in the same second: the
// last write wins), and the two levels are checked against each other as stored.
async function configCommand($: any, sid: string, code: c.OriginCode, op: c.ConfigOp): Promise<{ text: string }> {
  if (op === 'show') return { text: c.configText(await cfgGet($, sid, true)) }
  if (op === 'bad') return { text: c.CONFIG_USAGE }
  if (!c.originIsPerson(code)) {
    await logq($, sid, 'refused', `config-not-person:${code}`)
    return { text: c.CONFIG_NOT_PERSON }
  }
  // Each store call runs inside an async function, so a call that throws at once is answered like one that rejects.
  const raw = await withTimeout($, (async () => $.store.get(c.CONFIG_KEY))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  if (raw === 'timeout') return { text: c.CONFIG_UNREADABLE }
  const cur = c.parseConfig(raw).cfg
  let next: c.Config
  if (op === 'reset') next = { ...c.CONFIG_DEFAULTS }
  else if (op.field === 'keepalive' || op.field === 'checkin') next = { ...cur, [op.field]: op.value }
  else {
    const no = c.configLevelRefusal(op, cur)
    if (no) return { text: no }
    next = { ...cur, [op.field]: op.value }
  }
  const now = await $.clock.now()
  const w = await withTimeout($, (async () => $.store.set(c.CONFIG_KEY, { ...next, savedAt: now }))().then(() => 'ok' as const), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'failed' as const)
  if (w !== 'ok') {
    await logq($, sid, 'error', `config-write-${w}`)
    return { text: c.CONFIG_UNSAVED }
  }
  mem.cfg = next
  mem.cfgReadAt = now
  const field = op === 'reset' ? 'reset' : op.field
  await logq($, sid, 'config-set', `${field}:${code}`)
  return { text: op === 'reset' ? c.CONFIG_RESET_TEXT : c.configSetText(op.field, next) }
}

// /callboard reserve, this machine's reserved names. Showing works from any origin and logs nothing; a change is the person's own,
// as /callboard config (the same convenience, not a control: any same-uid process can write the key, and parseReserved bounds what it can hold). An add is
// refused while a lane record, a lead stamp or a live lead carries the name in any letter case: a lead would lose its lead name and its lanes with it.
async function reserveCommand($: any, sid: string, code: c.OriginCode, op: c.ReserveOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: c.RESERVE_USAGE }
  if (op === 'show') return { text: c.reserveShowText(await reservedGet($, sid, true)) }
  if (!c.originIsPerson(code)) {
    await logq($, sid, 'refused', `reserve-not-person:${code}`)
    return { text: c.RESERVE_NOT_PERSON }
  }
  // The list as stored now: also what managerNameOf reads for the remove guard below.
  await reservedGet($, sid, true)
  const raw = await withTimeout($, (async () => $.store.get(c.RESERVE_KEY))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  if (raw === 'timeout') return { text: c.RESERVE_UNREADABLE }
  const cur = c.parseReserved(raw)
  const key = ('remove' in op ? op.remove : op.add).toUpperCase()
  if ('remove' in op) {
    const hit = cur.find((x) => x.toUpperCase() === key)
    if (!hit) return { text: c.reserveNotListedText(op.remove) }
    // The live manager's name stays reserved while it runs, or leads would stop trusting it with nothing said.
    const live = await registryEntries($)
    if (!live) return { text: c.RESERVE_UNREADABLE }
    const mgrs = await managersLive($, live, '')
    if (mgrs.some((m) => m.unverified)) return { text: c.RESERVE_UNREADABLE }
    if (mgrs.some((m) => m.name?.toUpperCase() === key)) return { text: c.reserveManagerText(hit) }
  } else {
    const name = op.add
    let inUse: string | undefined
    const lanes = await loadLanes($)
    if (typeof lanes === 'string') return { text: c.RESERVE_UNREADABLE }
    // Judged by skeleton, as enforcement is, so a look-alike in use (LEAD2 for LEAD) counts too.
    const hit = (n: unknown) => typeof n === 'string' && c.reservedHit(n, [name])
    const rec = lanes.find((l) => hit(l.name) || hit(l.leadName))
    if (rec) inUse = hit(rec.name) ? `lane ${rec.name}` : `the lead stamp on lane ${rec.name}`
    if (!inUse) {
      const live = await registryEntries($)
      if (!live) return { text: c.RESERVE_UNREADABLE }
      const errs = { error: false }
      const leads = await leadsFor($, live, undefined, undefined, errs)
      if (errs.error) return { text: c.RESERVE_UNREADABLE }
      const rows = live.map((r) => r.j)
      const lead = leads.flatMap((x) => rows.filter((j) => j?.sessionId === x.sid && hit(j.name))).at(0)
      if (lead) inUse = `the live lead ${lead.name}`
    }
    const no = c.reserveAddRefusal(name, cur, inUse)
    if (no) return { text: no }
  }
  // The checks above take time; apply the change to the list as stored right now, so a change another session made meanwhile is kept.
  const raw2 = await withTimeout($, (async () => $.store.get(c.RESERVE_KEY))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  if (raw2 === 'timeout') return { text: c.RESERVE_UNREADABLE }
  const fresh = c.parseReserved(raw2)
  let next: string[]
  if ('remove' in op) next = fresh.filter((x) => x.toUpperCase() !== key)
  else {
    const no = c.reserveAddRefusal(op.add, fresh, undefined)
    if (no) return { text: no }
    next = [...fresh, op.add]
  }
  const now = await $.clock.now()
  const w = await withTimeout($, (async () => $.store.set(c.RESERVE_KEY, { names: next, savedAt: now }))().then(() => 'ok' as const), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'failed' as const)
  if (w !== 'ok') {
    await logq($, sid, 'error', `reserve-write-${w}`)
    return { text: c.RESERVE_UNSAVED }
  }
  mem.reservedGen++
  c.setLocalReserved(next)
  mem.reservedReadAt = now
  await logq($, sid, 'add' in op ? 'reserve-add' : 'reserve-remove', code)
  return { text: 'add' in op ? c.reserveAddedText(op.add) : c.reserveRemovedText(cur.find((x) => x.toUpperCase() === op.remove.toUpperCase())!) }
}

// /callboard escalation (the person's own command, one dialog) and /callboard escalation off (any origin, no dialog). One Allow stores scope `all` for permission prompts and questions alike;
// the two ledger rows are the ones the audit reads (the plain `answering-on`, then the one with code asks that opens the questions).
async function escalationCommand($: any, sid: string, code: c.OriginCode, op: pr.EscalationOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: pr.ESCALATION_USAGE }
  // Off narrows only: any origin, no dialog. It clears the stored switch as well, so deleting the OFF file later does not turn escalation back on.
  if (op === 'off') {
    try {
      await $.store.delete(ANSWERING_KEY)
    } catch {
      await logq($, sid, 'error', 'escalation-store')
      return { text: 'Escalation could not be changed: the store did not answer. Create ~/.claude/callboard/prompts/OFF to stop it now.' }
    }
    await ledgerAdd($, { kind: 'answering-off', code: 'off' })
    return { text: 'Escalation is off on this Mac.' }
  }
  // On is the person's own command, with a dialog that names exactly what turns on.
  if (!c.originIsPerson(code)) {
    await logq($, sid, 'refused', `escalation-not-person:${code}`)
    return { text: pr.ESCALATION_NOT_PERSON }
  }
  const r = await askOnce($, sid, pr.ESCALATION_QUESTION, pr.ESCALATION_YES, pr.ESCALATION_NO, pr.ESCALATION_HEADER)
  if (r === 'busy') return { text: 'A callboard question is already open. Answer it first.' }
  if (r !== 'yes') return { text: r === 'timed-out' ? 'Nothing changed: the question timed out.' : 'Cancelled. Nothing changed.' }
  // `asks: false` stays in the value so that an older mod after a rollback still reads it.
  const value: pr.Answering = { scope: 'all', asks: false, asksScope: 'all', savedAt: await $.clock.now() }
  // What was stored before (an earlier value, narrower or not) is kept to put back if the rows cannot be written.
  let before: unknown
  try {
    before = await $.store.get(ANSWERING_KEY)
    await $.store.set(ANSWERING_KEY, value)
  } catch {
    return { text: 'Escalation could not be turned on: the store did not answer. Nothing changed.' }
  }
  // The dialog took time: an `escalation off` typed meanwhile is overridden by this Allow, the person's own last word.
  // Both rows must land, plain first: the audit reads a question as covered only by the asks row, and a switch with no row is an anomaly. Else the value before stays.
  const hash = await sha($, pr.canonical(value)).catch(() => undefined)
  const plainRow = await ledgerAdd($, { kind: 'answering-on', hash })
  if (!plainRow || !(await ledgerAdd($, { kind: 'answering-on', code: 'asks', hash }))) {
    await logq($, sid, 'error', 'escalation-ledger')
    try {
      if (before === undefined || before === null) await $.store.delete(ANSWERING_KEY)
      else await $.store.set(ANSWERING_KEY, before)
    } catch {
      return { text: 'Escalation could not be turned on, and the store would not take it back: the ledger did not answer. Whether escalation is on is now unknown. Create ~/.claude/callboard/prompts/OFF to stop it now.' }
    }
    // The plain row may already be in the ledger, which would then read as a wider "on" than the value put back: it gets rows for that value (best effort, the ledger just failed once).
    if (plainRow && !(await ledgerRestore($, before))) await logq($, sid, 'error', 'escalation-ledger-restore')
    return { text: 'Escalation could not be turned on: the ledger did not answer. Nothing changed.' }
  }
  return { text: `${pr.escalationState(value, await promptsOff($))} ${pr.FLOOR_LINE}` }
}

async function promptsCommand($: any): Promise<{ text: string }> {
  const a = pr.parseAnswering(await $.store.get(ANSWERING_KEY).catch(() => undefined))
  const p = await where($)
  let open = 0
  if (p) {
    for (const d of ((await $.fs.list(`${p.root}/prompts`).catch(() => [])) as { name: string }[]).filter((x) => c.SID_RE.test(x.name)).slice(0, 512))
      open += ((await $.fs.list(`${p.root}/prompts/${d.name}`).catch(() => [])) as { name: string }[]).filter((f) => f.name.endsWith('.request.json')).length
  }
  return { text: pr.escalationText(a, await promptsOff($), open) }
}

export async function commandRun($: any, e: any) {
  const sid = await $.session.id()
  ensureTimer($)
  const code = c.originCode((e as { origin?: unknown }).origin)
  const rawArgs = (e as { args?: unknown }).args
  const line = typeof rawArgs === 'string' ? rawArgs.trim().replace(/[ \t]+/g, ' ') : ''
  // Escalation (ADR 0004): `escalation` and `prompts` are read here, so core's parser keeps its own forms.
  if (line === 'prompts') return promptsCommand($)
  // It only narrows (it stops pings), so any origin may type it, as `escalation off`.
  if (line === 'rest') return restCommand($, sid, code)
  if (line === 'escalation' || line.startsWith('escalation ')) return escalationCommand($, sid, code, pr.parseEscalationArgs(line.slice(10)))
  if (line === '' || line === 'help') return { text: c.helpText() }
  const arg = c.parseCommandArgs(rawArgs)
  if (!arg) return { text: c.HELP_USAGE }
  // Before the verb below, which would take any other object for a lane command.
  if (typeof arg === 'object' && 'config' in arg) return configCommand($, sid, code, arg.config)
  if (typeof arg === 'object' && 'checkin' in arg) return checkinCommand($, sid, code, arg.checkin)
  if (typeof arg === 'object' && 'reserve' in arg) return reserveCommand($, sid, code, arg.reserve)
  const verb = typeof arg === 'string' ? arg : 'manager' in arg ? 'manager' : 'conductor' in arg ? 'conductor' : 'lane'
  const busy = async () => {
    await log($, sid, 'refused', `busy:${verb}:${code}`)
    return { text: 'A callboard question is already open. Answer it first.' }
  }
  // A busy request is logged once, by the busy line below (same key, so a loop is de-duplicated); the person's own commands always get their line.
  if (verb !== 'status' && (!dialogOpen.has(sid) || c.originIsPerson(code))) await logq($, sid, 'command', `${verb}:${code}`)
  if (verb === 'lane' || verb === 'lane-off') return laneCommand($, sid, code, arg as c.CommandArg, busy)
  if (typeof arg === 'object' && 'manager' in arg) return managerCommand($, sid, code, arg.manager, busy)
  // The conductor list (add, remove) and the conductor grant.
  if (typeof arg === 'object' && 'conductor' in arg) {
    const op = arg.conductor
    if (op === 'bad') return { text: c.CONDUCTOR_USAGE }
    if (op === 'grant') return conductorGrant($, sid, code, busy)
    return conductorListCommand($, sid, code, op, busy)
  }
  // The table lane_list gives the lead, printed to the person with no model turn. Read-only: no store write, no notice, and the lanes-changed news is not marked as told.
  if (arg === 'lanes') {
    const t = await laneTable($, sid)
    if (!('err' in t)) return { text: t.text }
    if (t.err[0] === 'off') return { text: (await isEligible($)) ? c.LANES_IS_LANE : c.LANES_NO_LEVEL }
    return { text: `Lanes unavailable: ${c.hasText(t.err[0]) ? c.REASON_TEXT[t.err[0]] : t.err[1]}` }
  }
  if (arg === 'off' && !c.originIsPerson(code)) {
    const leaves = ((await $.state.get(lane)).value as Bound | null | undefined)?.name
    // In a conductor session the question names the conductor and its saved grant.
    const offQ = grants.get(sid)?.level === 'conductor' ? c.CONDUCTOR_OFF_QUESTION : c.offQuestionFor(leaves)
    const r = await askOnce($, sid, c.askedFrom(offQ, code), c.OFF_YES, c.OFF_NO, c.HEADER.enable)
    if (r === 'busy') return busy()
    if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
    if (r !== 'yes') {
      await log($, sid, 'refused', 'off-not-confirmed')
      return { text: 'Cancelled. Nothing changed.' }
    }
  }
  // The saved lead grant could not be deleted: the reply says lead may come back after a restart.
  let leadKept = false
  // What off found, for its answer, read before the drops below: a lead (a grant, or a saved one still being restored), a rebind still waiting
  // (and the lane it would take, once the tick has read it), and a saved lead grant with neither.
  let wasLead = false
  let wasManager = false
  let wasConductor = false
  let savedConductor = false
  let savedManager = false
  let rebindWas = false
  let rebindLane: string | undefined
  let savedLead = false
  if (arg === 'off') {
    offSeq.set(sid, (offSeq.get(sid) ?? 0) + 1)
    wasManager = grants.get(sid)?.level === 'manager'
    wasConductor = grants.get(sid)?.level === 'conductor' || conductorRestorePending.has(sid)
    wasLead = !wasManager && !wasConductor && (grants.has(sid) || leadRestorePending.has(sid))
    const rebinding = rebindPending.get(sid)
    rebindWas = rebinding !== undefined
    rebindLane = rebinding?.name
    // A rebind still waiting is cancelled before any await: a tick that starts after the bump would pass its own check and could bind after
    // off has read the binding.
    rebindPending.delete(sid)
    if (!wasLead && !wasManager && !wasConductor) {
      // A read that timed out says nothing about the grant: the reply then leaves it out.
      const got = await withTimeout($, (async () => $.store.get(`${c.LEAD_HINT_PREFIX}${sid}`))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
      savedLead = got !== undefined && got !== 'timeout'
      const gotC = await withTimeout($, (async () => $.store.get(`${c.CONDUCTOR_HINT_PREFIX}${sid}`))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
      savedConductor = gotC !== undefined && gotC !== 'timeout'
      const gotM = await withTimeout($, (async () => $.store.get(`${c.MANAGER_HINT_PREFIX}${sid}`))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
      savedManager = managerRestorePending.has(sid) || (gotM !== undefined && gotM !== 'timeout')
    }
    if (!(await leadDrop($, sid))) leadKept = true
    if (!(await managerForget($, sid))) leadKept = true
  }
  if (arg === 'lead') {
    // A lane is never a lead too: asked before the dialog and again after a yes, since the binding may land while the question is open.
    const laneHeld = async () => (await $.state.get(lane)).value != null
    const laneNo = async () => {
      await log($, sid, 'refused', 'lead-lane-holder')
      return { text: `${grants.has(sid) ? 'Lead stays on' : 'Lead stays off'}: ${c.REASON_TEXT['lane-holder']}` }
    }
    if (await laneHeld()) return laneNo()
    // The manager is never made a lead in place: a no would drop its grant and a yes replace it.
    if (grants.get(sid)?.level === 'manager') {
      await log($, sid, 'refused', 'lead-manager-holder')
      return { text: `Lead stays off: ${c.REASON_TEXT['manager-holder']}` }
    }
    // Nor is a session that was the manager since it started: its manager tools stay declared, and the lead's would be
    // declared over them. Asked before the dialog and again after a yes (as manager-after-lead).
    const wasManagerNo = async () => {
      await log($, sid, 'refused', 'lead-after-manager')
      return { text: `Lead stays off: ${c.REASON_TEXT['lead-after-manager']}` }
    }
    if (managerDeclared.has(sid)) return wasManagerNo()
    // Nor a conductor, nor a session that was one; asked again after a yes. A conductor restore still pending does not refuse: the person's lead grant
    // stands, and the restore then ends (lead-holder).
    const conductorNo = async (): Promise<{ text: string } | undefined> => {
      const code = grants.get(sid)?.level === 'conductor' ? 'conductor-holder' : conductorDeclared.has(sid) ? 'lead-after-conductor' : undefined
      if (!code) return undefined
      await log($, sid, 'refused', `lead-${code}`)
      return { text: `Lead stays off: ${c.REASON_TEXT[code]}` }
    }
    const cn = await conductorNo()
    if (cn) return cn
    let cwd: string
    try {
      cwd = await sessionRoot($)
    } catch {
      await logq($, sid, 'error', 'lead-register')
      return { text: 'Lead could not be set up.' }
    }
    // A grant from a plugin, session or script keeps the folder an earlier grant pinned; only the person's own prompt or phone moves it.
    const pinned = (!c.originIsPerson(code) && pinOf(sid)) || cwd
    // With another lead in the repo, both need a usable name. Asked before the dialog and again after a yes.
    const nameNo = async (why: string) => {
      await log($, sid, 'refused', why)
      return { text: `${grants.has(sid) ? 'Lead stays on' : 'Lead stays off'}: ${c.REASON_TEXT[why]}` }
    }
    await reservedGet($, sid, true)
    const named = await secondLeadNo($, sid, pinned)
    if (named !== undefined) return nameNo(named)
    const r = await askOnce($, sid, c.askedFrom(c.leadQuestion(pinned), code), c.LEAD_YES, c.LEAD_NO, c.HEADER.lead)
    if (r === 'busy') return busy()
    if (r !== 'yes') {
      const wasOn = grants.has(sid)
      const kept = (r === 'no' || c.originIsPerson(code)) && !(await leadDrop($, sid)) ? c.LEAD_KEPT : ''
      let why = ''
      if (r === 'timed-out') {
        await timedOut($, sid, 'timed-out', wasOn && !grants.has(sid) ? c.TIMED_OUT_LEAD_OFF_TOAST : c.TIMED_OUT_TOAST)
        why = ` ${c.TIMED_OUT_SENTENCE}`
      } else await log($, sid, 'refused', 'lead-not-confirmed')
      return { text: `${grants.has(sid) ? `Lead stays on.${why}` : wasOn ? `Lead is now off.${why}` : `Lead stays off.${why}`}${kept}` }
    }
    if (laneBinding.has(sid)) return laneNo()
    if (managerDeclared.has(sid)) return wasManagerNo()
    const cnAfter = await conductorNo()
    if (cnAfter) return cnAfter
    let grantEpoch = -1
    leadGranting.add(sid)
    try {
      // The engine calls held inside the mark have a time limit; a state read that does not answer counts as a lane binding.
      if ((await withTimeout($, laneHeld(), c.ENGINE_CALL_TIMEOUT_MS)) !== false) return laneNo()
      const namedNow = await withTimeout($, secondLeadNo($, sid, pinned), c.ENGINE_CALL_TIMEOUT_MS)
      if (namedNow !== undefined) return nameNo(namedNow === 'timeout' ? 'lead-check-slow' : namedNow)
      let set: unknown
      try {
        set = await withTimeout($, leadToolsOnce($, sid), c.ENGINE_CALL_TIMEOUT_MS)
      } catch {
        await logq($, sid, 'error', 'lead-register')
        return { text: 'Lead could not be set up.' }
      }
      if (set === 'timeout') {
        await logq($, sid, 'error', 'lead-register-timeout')
        return { text: 'Lead could not be set up.' }
      }
      // A re-grant with a new folder is a new reach: work in flight for the old one (a check-in) sees the epoch move and stops.
      const oldPin = pinOf(sid)
      if (oldPin !== undefined && oldPin !== pinned) {
        leadEpoch.set(sid, epochOf(sid) + 1)
        laneObs.delete(sid)
        attnTold.delete(sid)
      }
      grants.set(sid, c.leadGrant(pinned))
      grantEpoch = epochOf(sid)
    } finally {
      leadGranting.delete(sid)
    }
    // The grant survives a restart.
    await leadSave($, sid, pinned)
    // An off or a Cancel during the save leaves no presence, log, briefing or "Lead is on" behind.
    if (epochOf(sid) !== grantEpoch) return { text: 'Lead is now off.' }
    // A new grant may pin another folder: the old file and its checks go first.
    await presenceDrop($, sid).catch(() => undefined)
    await presenceTouch($, sid).catch(logFail($, sid, 'presence'))
    await watchInit($, sid).catch(logFail($, sid, 'lane-watch'))
    await log($, sid, 'lead-on')
    await briefLead($, sid, pinned)
    await nameGrant($, sid)
    return { text: 'Lead is on from your next prompt.\nOnly a force stop asks you.' }
  }
  const bound = (await $.state.get(lane)).value as Bound | null | undefined
  // Every session gets the keepalive and the nudges.
  // A lead's status adds its check-ins.
  const ckStatus: [string, string][] = arg === 'status' && grants.has(sid) && grants.get(sid)?.level !== 'conductor' ? [['Check-ins', c.checkinStatus((await cfgGet($, sid)).checkin, (await $.state.get(checkinPauseRef)).value, await $.clock.now())]] : []
  // The manager's status names its level in place of the lead's.
  const gs = grants.get(sid)
  const grantPart: [string, string] = gs?.level === 'manager' ? ['Manager', 'ON'] : gs?.level === 'conductor' ? ['Conductor', c.conductorStatus(gs.pins.length)] : ['Lead', grants.has(sid) ? 'ON' : 'OFF']
  const laneLead: [string, string][] = bound ? [["This lane's lead", c.laneStatusLead(laneBrief.get(sid), bound.name)]] : []
  if (arg === 'status') return { text: c.statusTableText([['Lane', bound ? bound.name : 'NONE'], grantPart, ...ckStatus, ...laneLead]) }
  if (arg === 'off') {
    // A recorded nudge and an open grant go too. Off does not opt out of nudges: a later turn past the level records a new one.
    await $.state.set(nudgeDueRef, null)
    await $.state.set(nudgedAtRef, null)
    if (!(await leadDrop($, sid))) leadKept = true
    // The rebind was cancelled above. No store record may keep naming a session that is off, or a restart would rebind it.
    // A session that is neither a lane nor a lead keeps its request as it is: off turns nothing off there, and its own request needs no lane.
    const cur = await $.state.get(request)
    const live = bound || wasLead || wasManager || wasConductor ? (cur.value as Request | null | undefined) : undefined
    // What off did, for its answer: a request dropped, or a compaction under way that loses its resume.
    let reqDone: 'dropped' | 'no-resume' | undefined
    if (live && live.phase !== 'compacting') {
      await dropRequest($, sid, 'disabled')
      reqDone = 'dropped'
    } else if (live?.viaNudge === true) {
      reqDone = 'no-resume'
      // A compaction under way through the nudge grant finishes, but loses the grant: its resume then needs the session to be eligible, which off
      // has just ended, so the continuation is dropped as not-eligible. If PostCompact moved it on meanwhile, the request is dropped as above.
      const { viaNudge: _granted, ...kept } = live
      if ((await $.state.set(request, kept, { ifVersion: cur.version })).isSet === false) {
        const again = (await $.state.get(request)).value as Request | null | undefined
        if (again && again.phase !== 'compacting') {
          await dropRequest($, sid, 'disabled')
          reqDone = 'dropped'
        }
      }
    }
    // A bound session is unbound too: off no longer leaves a lane that a lead can still cue.
    const d = bound ? await detach($, sid, bound) : { whole: true, sidKept: false }
    const loose = bound ? undefined : await sidClearAll($, sid).catch(() => ({ ok: false, name: undefined }))
    await log($, sid, 'disabled')
    // The answer says what off did; it never stops the keepalive or the nudges, which every session gets.
    const rebindTo = rebindWas ? (rebindLane ?? loose?.name) : undefined
    const did = [
      wasManager ? 'Manager is now off.' : wasConductor ? 'Conductor is now off.' : wasLead ? 'Lead is now off.' : savedLead ? 'Its saved lead grant was removed.' : savedConductor ? 'Its saved conductor grant was removed.' : savedManager ? 'Its saved manager grant was removed.' : '',
      bound ? `This session is no longer lane ${bound.name}.` : '',
      rebindTo !== undefined ? `Lane ${rebindTo} will not rebind automatically.` : '',
      loose?.ok && loose.name !== undefined ? `Lane ${loose.name} no longer names this session.` : '',
      reqDone === 'dropped' ? 'Its compaction request was dropped.' : reqDone === 'no-resume' ? 'The compaction under way will not resume the work.' : '',
    ].filter((x) => x !== '').join(' ')
    return { text: `${did || c.OFF_NOTHING}${bound ? c.STOPPABLE_BY_NAME(bound.name) : ''}${bound && d.sidKept ? c.SID_KEPT(bound.name) : ''}${loose && !loose.ok && loose.name ? c.SID_KEPT(loose.name) : ''}${leadKept ? (wasConductor || savedConductor ? c.CONDUCTOR_KEPT : wasManager || savedManager ? c.MANAGER_KEPT : c.LEAD_KEPT) : ''}` }
  }
}
