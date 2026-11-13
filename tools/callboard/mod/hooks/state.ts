// Every $.state key the mod uses, with a read and a write function for each. `claude plugin validate` reads a key in the file that calls $.state with it, so
// the keys are declared here and every other file goes through these functions. A function here that no hook reaches is refused by the validator;
// state.spec.ts pins that each one has a caller. Imports nothing: it holds no state and decides nothing.
const lane = { plugin: 'callboard', key: 'lane' } as const
const seen = { plugin: 'callboard', key: 'seen' } as const
const request = { plugin: 'callboard', key: 'request' } as const
const counters = { plugin: 'callboard', key: 'counters' } as const
const lastTurn = { plugin: 'callboard', key: 'lastTurnAt' } as const
const nudgeDue = { plugin: 'callboard', key: 'nudgeDue' } as const
const interactive = { plugin: 'callboard', key: 'interactive' } as const
// When the tick last sent this session a nudge: the grant's start. Only the tick's nudge submit sets it; any stored request_compact, a prompt that is
// not the mod's own, and /callboard off clear it.
const nudgedAt = { plugin: 'callboard', key: 'nudgedAt' } as const
// The keepalive ping: when the last main-agent turn ended, when the last real one ended (not started by a ping, a nudge, a notice or the lanes-changed
// turn), and when the tick last tried a ping. Kept in the session state: a reload keeps them (the cache is still warm), a restart loses them (unknown: no ping).
const turnEnd = { plugin: 'callboard', key: 'turnEndAt' } as const
const realEnd = { plugin: 'callboard', key: 'realEndAt' } as const
const pingAt = { plugin: 'callboard', key: 'pingAt' } as const
// `/callboard rest`: when it was typed. A real turn that starts clears it (turn.start), so the next real turn ends it; one typed while a turn runs holds past that turn's end. A reload keeps it.
const rest = { plugin: 'callboard', key: 'restAt' } as const
// Until when /callboard checkin pause holds this session's check-ins. A reload keeps it, a restart loses it.
const checkinPause = { plugin: 'callboard', key: 'checkinPauseUntil' } as const
// When a lead, conductor or manager last ordered this lane to compact (c.ORDER_MS).
const orderedAt = { plugin: 'callboard', key: 'orderedAt' } as const

// A write that names ifVersion lands only if the version is still that one (isSet is false when it is not).
type IfVersion = [{ ifVersion: number }?]

export function getLane($: any) { return $.state.get(lane) }
export function setLane($: any, v: unknown) { return $.state.set(lane, v) }
export function getSeen($: any) { return $.state.get(seen) }
export function setSeen($: any, v: unknown) { return $.state.set(seen, v) }
export function getRequest($: any) { return $.state.get(request) }
export function setRequest($: any, v: unknown, ...o: IfVersion) { return $.state.set(request, v, ...o) }
export function getCounters($: any) { return $.state.get(counters) }
export function setCounters($: any, v: unknown, ...o: IfVersion) { return $.state.set(counters, v, ...o) }
export function getLastTurn($: any) { return $.state.get(lastTurn) }
export function setLastTurn($: any, v: unknown) { return $.state.set(lastTurn, v) }
export function getNudgeDue($: any) { return $.state.get(nudgeDue) }
export function setNudgeDue($: any, v: unknown, ...o: IfVersion) { return $.state.set(nudgeDue, v, ...o) }
export function getInteractive($: any) { return $.state.get(interactive) }
export function setInteractive($: any, v: unknown) { return $.state.set(interactive, v) }
export function getNudgedAt($: any) { return $.state.get(nudgedAt) }
export function setNudgedAt($: any, v: unknown) { return $.state.set(nudgedAt, v) }
export function getTurnEnd($: any) { return $.state.get(turnEnd) }
export function setTurnEnd($: any, v: unknown) { return $.state.set(turnEnd, v) }
export function getRealEnd($: any) { return $.state.get(realEnd) }
export function setRealEnd($: any, v: unknown) { return $.state.set(realEnd, v) }
export function getPingAt($: any) { return $.state.get(pingAt) }
export function setPingAt($: any, v: unknown) { return $.state.set(pingAt, v) }
export function getRest($: any) { return $.state.get(rest) }
export function setRest($: any, v: unknown) { return $.state.set(rest, v) }
export function getCheckinPause($: any) { return $.state.get(checkinPause) }
export function setCheckinPause($: any, v: unknown) { return $.state.set(checkinPause, v) }
export function getOrderedAt($: any) { return $.state.get(orderedAt) }
export function setOrderedAt($: any, v: unknown) { return $.state.set(orderedAt, v) }
