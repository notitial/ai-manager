// The module memory the engine files share: the module state as properties of `mem`, and the per-session maps and sets.
// It imports no engine file, so an import cycle between engine files cannot reach a constant that is not yet initialised.
import * as c from './core.ts'
import * as pr from './prompts.ts'

export const mem = {
  isTicking: false,
  timerOn: false,
  // own: the registry folder that holds this session's own row, `sessions` unless CLAUDE_CONFIG_DIR names another, undefined when it names a bad one.
  paths: undefined as { uid: number; root: string; sessions: string; own: string | undefined } | undefined,
  seq: 0,
  submits: 0,
  // The rejection is logged by the first own-row lookup that has a session id, once per load of the mod (the flag is set in the same step as the check).
  configDirLogged: false,
  presenceQ: Promise.resolve() as Promise<unknown>,
  // Presence checks that could not be made, counted: an apply that spans one reads the count before and after its lookups (promptApply).
  presenceErrors: 0,
  // The settings of /callboard config, machine-wide in $.store. Read at session start and then at most once a minute (the tick and the nudge hooks
  // call this), so a change made in one session reaches the others within a minute. A read that fails or times out keeps the last good value (the
  // defaults before any); a field that fell back is logged once per load of the mod.
  cfg: { ...c.CONFIG_DEFAULTS } as c.Config,
  cfgReadAt: undefined as number | undefined,
  // This machine's reserved names (c.RESERVE_KEY), read as the settings are: fresh at each start and fresh again on each
  // path that judges a new name or the manager's (lane_create, /callboard lane, /callboard lead, /callboard manager); else at most once a minute from the tick. A read that fails or times out keeps the last good list. The list lands in core (c.setLocalReserved), where
  // reservedHit and isManagerName read it.
  // The read time moves only on a good read, so a failed one is tried again from the next tick; reservedGen drops a read that a /callboard reserve
  // write overtook (that write set the list itself).
  reservedReadAt: undefined as number | undefined,
  reservedGen: 0,
  // Every timer call records its time, a running tick or not. A gap past SLEEP_GAP_MS since the last one means the Mac slept: wokeAt.
  // A reload loses both, so the first call after it only records.
  lastTimerAt: undefined as number | undefined,
  wokeAt: undefined as number | undefined,
  lastSweepAt: 0,
  sweepFrom: 0,
  lastQuestionsPruneAt: 0,
}

export const own = new Map<string, number>()
// The own texts that are not real work (the ping, a nudge, a notice, the lanes-changed turn), counted as own is; and every own submit, so the tick can
// tell whether anything went out while it ran.
export const unrealOwn = new Map<string, number>()

export const lastLogged = new Map<string, string>()
export const lastSaved = new Map<string, { sig: string; at: number }>()

// The stop calls (by session, verb and the lane as the lead typed it) whose process already got its signal, for the hook's .catch.
export const signalledCalls = new Map<string, { name: string; pid: number }>()

// Store writes of one repo go one at a time inside this process (a lead can issue parallel tool calls).
export const storeLocks = new Map<string, Promise<void>>()

// A release that could not be confirmed (twice) is owed: the tick tries again, up to 30 times, and stops when the folder is gone or names another holder.
// Nothing here lets a lock that names our own pid be removed by another take of the lock.
export const unlockOwed = new Map<string, { key: string; nonce: string; tries: number }>()

// Rows ps -p confirmed gone, as pid and start time: that process has ended for good, so a later read need not ask again. A pid reused later has another start
// time, so its row is stale anyway. Cleared whole when full, and at session start.
export const goneSeen = new Set<string>()

// restoredOnce: a restore was decided (restored, declined or refused for good); one asked, attempted or held back is asked again at the next /callboard lane.
export const restoredOnce = new Set<string>()

// One callboard question per session at a time: a second request while one is open is refused, not queued.
export const dialogOpen = new Set<string>()
// Counts the `off` commands that ran, so a restore or a join that waited on a dialog can see an `off` came in meanwhile and stop.
export const offSeq = new Map<string, number>()

// The lead grant lives only in this module's memory: a reload or a restart drops it, and /callboard lead has to be run and allowed again.
// It keeps the cwd the lead had when the person gave it, so a later cd cannot move the lead into another repo's lanes.
// The engine has no call that removes a tool, so after `off` the tools stay declared and refuse every call.
// One grant per session, in the shape every level shares (c.Grant).
export const grants = new Map<string, c.Grant>()

// A session is a lane or a lead, never both. Each grant path checks the other's mark and sets its own with no await in
// between, and holds it until its own write has landed, so a lead grant and a lane binding that race cannot both pass.
export const leadGranting = new Set<string>()
export const laneBinding = new Set<string>()

export const leadDeclared = new Set<string>()
// The pin the briefing note was last appended for, per session: one note per grant and pin, dropped with the grant.
export const briefed = new Map<string, string>()

export const presenceText = new Map<string, string>()

export const presenceErrs = new Map<string, { n: number; at: number }>()
// What a conductor's cached presence text was made from (its repo, name and pins).
export const conductorPresenceKey = new Map<string, string>()

// The lead grant ends: the tools stay declared and refuse, the presence file goes, the lane-list watch stops.
// Bumped by every leadDrop. A lead restore or a save of the grant that awaited across a drop sees the change and does nothing more, so an
// off or a Cancel is never undone by work that started before it.
export const leadEpoch = new Map<string, number>()

// The lead grant is kept in $.store as lead:<sid> = { pin, savedAt }, written at the grant, at a restore and once a day while lead is on; leadSavedAt
// holds the time of the last write (or try) so the daily check reads no store. A failed write is logged and tried again a day later; the grant stays on.
export const leadSavedAt = new Map<string, number>()

export const leadRestorePending = new Map<string, { hint: c.LeadHint; tries: number }>()

// The cut-compaction mark (c.CMP_PREFIX). cmpMarked: this load wrote the mark, so the tick clears it once the request has left `compacting`.
// cmpCutPending: a fresh mark found at start with no request left in $.state; the tick gives the note once the session counts as a person's.
export const cmpMarked = new Set<string>()
export const cmpCutPending = new Map<string, number>()

// Its facts per session, computed once where the binding is written (birth, attach, restore) and dropped at detach. Module memory: after a reload the
// prompt.compose hook falls back to the binding in the session's state, with the generic lead and report wording.
export const laneBrief = new Map<string, c.LaneFacts>()
// The lane name the briefing note was last appended for, per session: one note per binding, dropped at detach.
export const laneBriefed = new Map<string, string>()

// ---- the lead's watch on its own lane list ----
// cur: the hash of the store file as last read; told: the hash the lead has been told about (or was dropped); seen: the hash at the lead's last lane tool call.
export type Watch = { path: string; sig?: string; cur: string; told: string; seen: string }
export const watch = new Map<string, Watch>()
export const laneNotices = new Map<string, number[]>()
export const cappedLogged = new Set<string>()

// A store write of the lead's own (lane_create, a retire or terminate that removes a lane) is in flight: the tick leaves the list alone until watchOwn has taken the new state as known.
export const ownWriting = new Map<string, number>()

// One registration at a time per session: a /callboard lead after a timed-out one waits for the same registration instead of starting a second.
export const leadToolsInFlight = new Map<string, Promise<void>>()

// Whether a trusted manager (managerTrusted) runs on the Mac, as a lead's tick last saw it, for the lead's on-cue
// section: read at most once a minute, so prompt.compose reads no file. A read that fails or throws counts as none.
// A due look runs under ACTION_TIMEOUT_MS (managerSeenStep); one that times out or throws serves no section (live false) and frees the busy
// mark, so the next minute reads again. managerSeenBusy holds the running look's own token, and an answer is kept only while its stamp is still the one
// stored: a look that timed out, or a drop meanwhile (leadDrop, session.end), leaves nothing behind.
// conductors: the names ('' for none) of the conductors trusted for the lead's pin, as the same look saw them.
export const managerSeen = new Map<string, { at: number; live: boolean; conductors?: string[] }>()
export const managerSeenBusy = new Map<string, object>()

// The manager's five lane tools, declared at its grant, then the three prompt tools (eight in all, c.MANAGER_TOOLS). The handlers are the lead's (leadBase refuses every other lane tool at manager level).
export const managerDeclared = new Set<string>()

// Lead cue calls to one target go one at a time inside this process (a lead can issue parallel tool calls); they share one answer file.
export const cueInFlight = new Map<string, number>()

// What this session last answered per cue file, so a cue left in place (refused before the move) is not answered every tick.
export const lastAnswer = new Map<string, string>()

// The lane record of this session's binding, for the report path. Looked up once per binding (the cache is keyed by the binding's record hash).
export const boundLane = new Map<string, { name: string; rec: string; l: c.Lane }>()

// The turn mark: when the main agent's turn began and how big the lane's report was. Written at prompt.submit (any origin) and at turn.start of the
// main agent (wakes and queued messages never pass prompt.submit). An unbound session has no report: size null. One stat, only when bound.
export const lastTurnUnknown = new Set<string>()

export const cfgInvalidLogged = new Set<string>()

export const midTurnBusy = new Set<string>()
// The sessions whose turn carried a mid-turn nudge, until that turn ends (midTurnFallback).
export const midDelivered = new Set<string>()
export const midTurnSkip = new Map<string, number>()

export const lastSubmitAt = new Map<string, number>()
export const turnKind = new Map<string, 'ping' | 'unreal'>()
export const kaLogged = new Map<string, string>()
// The pings that went out since the real turn that ended at realEnd.
export const pingCount = new Map<string, { realEnd: number; count: number }>()

// Notice turns sent per session in the last hour (module memory: a reload starts the count over).
export const noticeTimes = new Map<string, number[]>()

// Ticks in a row whose request step threw, per session (module memory): the count and the time of the first throw.
// The request is dropped only after REQUEST_FAILS_MAX throws in a row that span REQUEST_FAIL_SPAN_MS, so a brief fault
// (a slow shasum or agent.list for a few ticks) never costs a session its request or its resume note.
export const requestFails = new Map<string, { n: number; firstMs: number }>()

// claim removes its .taken file, unless a throw or a killed process falls between the move and the rm. This session's own leftovers go, at most once per
// TAKEN_SWEEP_MS: only names claim makes, aged by the claim time in the name (mv keeps the cue's mtime, so a stale cue under claim looks old), and only a
// plain file or a link (rm without -r cannot remove a folder; a folder or another kind is logged and left). Another session's are never touched.
export const takenSwept = new Map<string, number>()

// The rename of an attached session cannot run inside the command (the engine refuses it there), so it runs from the next tick, once.
export const pendingRename = new Map<string, { name: string; until: number; manager?: true }>()

// A bound session makes sure its own store record names it, once per binding (name, time and record hash): the record of a lane born through lane_rename,
// one restored through the dialog, a rebind and every older record. Run from the tick before the cue is claimed, under a time limit. The key is set
// first, so a failure is not retried in this process (the next restart falls back to the Restore dialog, whose bind is followed by this sync). The write re-checks the binding inside the store queue, so a /callboard off that cleared it meanwhile is not undone.
export const sidSynced = new Map<string, string>()

// Per session: the tries so far, and the record's name once it is known (for the toast when the rebind ends refused). One entry, so ending it ends both.
export const rebindPending = new Map<string, { tries: number; name?: string }>()
// Sessions this process rebound: a Restore question already open when the bind lands ends with no "things changed" toast.
export const rebound = new Set<string>()

// A try still running after the tick's time limit: the next tick does not start another beside it.
export const rebindBusy = new Set<string>()

// Once a minute, whatever the idle gates, a lead observes the lanes in its reach (lanes and registry only, no reports) into laneObs. A lane gone, waiting on a
// prompt 5 min or quiet 30 min (c.checkinItems) and not yet told is then checked against the timing gates: check-ins on, not paused, no wake in the last 30 min,
// the lead idle 20 min since its last turn ended or its last prompt. Only then are reports read (signed done drops gone and quiet), and attentionNotice sends.
// A read that fails (lanes, registry, off) is no observation at all, never "all gone".
export const laneObs = new Map<string, Map<string, c.LaneObs>>()
export const obsAt = new Map<string, number>()
export const attnTold = new Map<string, Set<string>>()
export const attnCapped = new Set<string>()
export const checkinBusy = new Set<string>()
// The manager's per-repo lead verdicts, kept across evaluations (by the manager's session id; dropped with the grant).
// Evaluations land 60-62 s apart, so the window spans one of them plus a margin: a verdict is reused once and read
// again at the evaluation after, so leads are read about every 2 min and a gone lead is seen at most ~2 min late (130 s made it ~3 min).
export const leadlessSeen = new Map<string, Map<string, { at: number; leads: c.LeadFile[] | 'held' }>>()

// What each orderer (lead, conductor or manager) ordered: lane session id to { lane name, time of the first order }, in module memory (lost with the session or a reload,
// then no notice). Once a minute, an order older than c.ORDER_MS is looked up in $.store: the lane's own stamp (c.ORDER_PREFIX + its session id) is still there only if
// no compaction began (orderSpend), so only then, and only while the lane's session is live, the orderer gets one fixed notice, and the stamp goes. Nothing is
// stopped: the notice sends the orderer to the person.
export const orders = new Map<string, Map<string, { lane: string; at: number }>>()
export const orderChecked = new Map<string, number>()
export const orderBusy = new Set<string>()

export const renameChecked = new Map<string, number>()

// The saved manager grant, manager:<sid> = { name, savedAt }: written at the person's yes and once a day while the manager runs; removed by
// leadDrop (off) and by a Cancel on the restore question. A failed write is logged and tried again a day later; a drop while the write was in flight deletes the
// key again.
export const managerSavedAt = new Map<string, number>()

export type MgrPending = { hint: c.ManagerHint; tries: number; asking?: boolean }
export const managerRestorePending = new Map<string, MgrPending>()
// A restore is offered once per process and session: a session.start that is not a start (a compaction, a reload) never asks again.
export const managerRestoreOffered = new Set<string>()

// A conductor's reach is the list file in its own repo (c.CONDUCTOR_FILE), resolved at every read, intersected with the approved list: what the person approved in
// a dialog of this session (the grant, a later add or a restore that asked). The file only narrows. conductorHome: the conductor repo (the session's start folder at
// the grant). conductorApproved: the approved real paths. Both go with leadDrop.
export const conductorHome = new Map<string, string>()
export const conductorApproved = new Map<string, string[]>()
export const conductorSavedAt = new Map<string, number>()
export const conductorDeclared = new Set<string>()

export type CondPending = { hint: c.ConductorHint; tries: number; last?: string; ask?: { shown: string[]; added: string[] }; asking?: boolean }
export const conductorRestorePending = new Map<string, CondPending>()

export const conductorReadAt = new Map<string, number>()

type CheckEntry = { toolUseId: string; at: number; approver: unknown; facts: pr.CheckFacts; dup: boolean }
// What tool.check saw for an ask, joined to the PermissionRequest that follows by session, tool, whole-input hash and agent. PermissionRequest carries neither
// the approver nor the tool_use_id (probed), so both come from here.
export const checks = new Map<string, CheckEntry>()
// The calls whose request is open (or about to be), by tool_use_id: the three done events mark them, so a person's Yes (which fires no signal) is seen.
export const openReqs = new Map<string, { id?: string; dir?: string }>()
export const doneIds = new Set<string>()
// Requests whose hook ended with no closing row written (the write failed, or the dispatch was cut off by the person's No): the files stay and the tick writes the
// row, so every closed request ends with one. After UNCLOSED_TRIES failed tries the files are left to the sweep (session-gone, or swept after a day).
export const unclosed = new Map<string, { dir: string; row: Omit<pr.LedgerRow, 't'>; tries: number }>()

// The tiers this mod marked asking. At a turn's end the file is removed when the memory holds the mark or a stat finds the file (a reload loses the memory); a relay
// question's own end removes it whatever the memory holds (`always`).
export const askingSids = new Set<string>()
// The tiers that asked a relay question in the turn now running: the turn end sweeps their relays whatever the asking mark says (an answered question spends the mark,
// and an earlier one that was dismissed in the same turn would otherwise never be left).
export const relayAskedTurn = new Set<string>()

export const windowsSeen = new Map<string, Record<string, number>>()

// Per tier: the requests whose relay was seen (so that one that goes away with the request still open is told again).
export const promptRelaySeen = new Map<string, Set<string>>()
export const promptTold = new Map<string, Map<string, number>>()
export const promptNotices = new Map<string, number[]>()
export const promptCapLogged = new Set<string>()

// The fallback (like midTurnFallback): the engine may not surface the context, or the model may read it and not act. When the turn that carried a mid-turn notice ends,
// each request of it still open is owed again, once, and the idle tick sends it as the idle turn; that resend is not a mid-turn one (promptMidRetold), so it
// is told twice at most. A request that closed meanwhile is dropped by the tick's scan and its marks here with it.
export const promptMidSent = new Map<string, Set<string>>()
export const promptMidRetold = new Map<string, Set<string>>()
