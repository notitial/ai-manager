// What the lead, conductor and manager grants share, read from one record per level (LevelDesc). The three records sit in grants.ts beside the behaviour only
// their level has; this file holds the type and the functions that read it.
// Trust rules held here: the holder and exclusion checks (core's holderNo), the epoch checks of the saved grant.
import * as c from '../core.ts'
import { logq, logFail } from './base.ts'
import type { Asked } from './base.ts'
import { briefed, grants, leadEpoch, leadGranting, leadRestorePending, conductorRestorePending, leadDeclared, conductorDeclared, managerDeclared, laneBinding } from '../mem.ts'

// $.state keys declared again where they are used: `claude plugin validate` reads a key in the file that uses it.
const lane = { plugin: 'callboard', key: 'lane' } as const

// A drop of the grant (leadDrop) moves the epoch: work begun under the old one sees it and stops.
export const epochOf = (sid: string) => leadEpoch.get(sid) ?? 0

export type LevelDesc = {
  level: c.Level
  // The saved grant: <hint><sid> in $.store, its fields (saved, read before the clock; undefined when the session holds no grant of this level) and savedAt;
  // held says the grant is still there. A write that ends after a drop is deleted again; saveEpochCheck: a new grant meanwhile counts as a drop too.
  hint: string
  savedAt: Map<string, number>
  saveEpochCheck: boolean
  unsaved: string
  hintDelete: string
  saved(sid: string, pin?: string): object | undefined
  held(sid: string, pin?: string): boolean
  // The presence file of a level that names no pin to check (the lead's does): its fields beyond sid, pid and procStart, the error logged when it cannot be written,
  // and, when the file changes while the grant stands, the text that tells it did (the conductor's repos).
  // The briefing note, once per grant and key (the pin, `manager:<name>` or `conductor:<home>` in `briefed`, so no two meet): note builds it from what the grant
  // is when it is appended, and err is logged when the append is refused or fails.
  // /callboard off: isOn (the session holds this level, or its saved grant is being restored: pending), the sentence when it ends, and the one added when its
  // saved grant could not be deleted.
  pending: Map<string, unknown>
  isOn(sid: string): boolean
  offText: string
  kept: string
  noteKey(arg: string): string
  note(sid: string, arg: string): string
  noteErr: string
  // The grant dialog (grantDialog in grants.ts). notYes: what a click that is not yes does to the grant, and its saved key: 'person-or-no' ends it on any no and on
  // any non-yes the person's own origin gets (a dismissal, a timeout), 'person-no' only on the person's own no, 'none' never. offCancelsDialog: a /callboard off
  // while it is open cancels the grant (refused off-meanwhile). presenceFirst: the presence file is written before the saved grant and must succeed (the manager);
  // otherwise it follows the save and a failed write is only logged. offToast: the toast of a timeout that ended the grant.
  notYes: 'person-or-no' | 'person-no' | 'none'
  offCancelsDialog: boolean
  presenceFirst: boolean
  offToast?: string
  presence?: { err: string; fields(g: c.Grant, home?: string): object; key?(g: c.Grant, home?: string): string }
}

type Refusal = { text: string } | void

// What a command hands grantDialog beside the level's LevelDesc: the question and closures over what the command read before it. A closure that refuses
// returns the reply, its refusal already logged. person: the origin is the person's own. on: the session holds this level.
export type GrantDialog = {
  question: string
  yes: string
  no: string
  header: string
  busy: () => Promise<{ text: string }>
  person: boolean
  on: () => boolean
  pin?: string
  // A question that is not the grant's own (the manager's restore) ends its own way when the answer is not yes.
  onNotYes?: (r: Asked) => Promise<{ text: string }>
  // The checks that read the marks, with no await: the marks are read and set with nothing between.
  postClick: () => Promise<{ text: string }> | undefined
  // Checks inside the mark, then the tools and the grant (offNow: an off came since the question).
  recheck: () => Promise<Refusal>
  apply: (offNow: () => boolean) => Promise<Refusal>
  // Once the presence file is written (presenceFirst: with its result, and a refusal ends the grant), or after the saved grant when presence follows it.
  afterPresence?: (wrote: unknown, epoch: number) => Promise<Refusal>
  onLog: [string, string]
  toast?: string
  briefArg: string
  after: (epoch: number) => Promise<void>
  text: string
}

// What the session already is or was, for core's holderNo. marks: the lane and lead marks are this call's to read, not its own (a re-check made while it holds
// leadGranting passes false).
export function holdsOf(sid: string, inLane: boolean, marks: boolean): c.Holds {
  const g = grants.get(sid)
  return {
    lane: inLane,
    grant: g !== undefined,
    lead: g?.level === 'lead',
    conductor: g?.level === 'conductor',
    manager: g?.level === 'manager',
    leadMark: marks && leadGranting.has(sid),
    leadPending: leadRestorePending.has(sid),
    conductorPending: conductorRestorePending.has(sid),
    wasLead: leadDeclared.has(sid),
    wasConductor: conductorDeclared.has(sid),
    wasManager: managerDeclared.has(sid),
  }
}

// The code a grant of `wants` is refused with, read now: the lane state first, then the memory, as holderNo orders them.
export async function heldNo($: any, sid: string, wants: c.Level, marks: boolean): Promise<string | undefined> {
  return c.holderNo(wants, holdsOf(sid, (marks && laneBinding.has(sid)) || (await $.state.get(lane)).value != null, marks))
}

// The saved grant, written at the grant and again once a day (c.leadRefreshDue): a failed write is logged and tried again a day later.
export async function levelSave($: any, sid: string, d: LevelDesc, pin?: string) {
  const epoch = epochOf(sid)
  const fields = d.saved(sid, pin)
  if (!fields) return
  const now = await $.clock.now()
  if (epochOf(sid) !== epoch || !d.held(sid, pin)) return
  d.savedAt.set(sid, now)
  const key = `${d.hint}${sid}`
  try {
    await $.store.set(key, { ...fields, savedAt: now })
  } catch {
    await logq($, sid, d.unsaved)
  }
  // A drop while the write was in flight: the key it wrote goes again.
  if ((d.saveEpochCheck && epochOf(sid) !== epoch) || !d.held(sid, pin)) await Promise.resolve($.store.delete(key)).catch(logFail($, sid, d.hintDelete))
}

// One briefing note, once per `key` in `marks`: the mark is set before the append, a refused or failed append unmarks it (if it is still this one) and logs errCode.
// `text` is a function so it is built inside the try, where a throw while building it is the same failed briefing.
export async function briefOnce($: any, sid: string, marks: Map<string, string>, key: string, text: () => string, errCode: string) {
  if (marks.get(sid) === key) return
  marks.set(sid, key)
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: text() }] } })
    if (r?.deny !== undefined) throw new Error('refused')
  } catch {
    if (marks.get(sid) === key) marks.delete(sid)
    await logq($, sid, 'error', errCode)
  }
}

// The level's briefing as one user-role note, once per grant. A refused or failed append changes nothing else: the grant stays, and the session is not marked
// briefed, so the next grant command tries again. The mark is set before the await, so a second grant during the append adds no second note and a
// /callboard off during it leaves no mark behind. A restore that asked nothing appends none: the history has the note from the grant.
export async function levelBrief($: any, sid: string, d: LevelDesc, arg: string) {
  await briefOnce($, sid, briefed, d.noteKey(arg), () => d.note(sid, arg), d.noteErr)
}
