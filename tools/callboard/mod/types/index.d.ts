// v14 (2026-11-04): lastNudgeKind, the kind of the last nudge sent (a soft one may be followed by one hard one inside the gap).
export type Counters = { lastCompactMs?: number; startDone?: boolean; resumeTimes?: number[]; lastNudgeMs?: number; nudgeTimes?: number[]; lastNudgeKind?: 'lead' | 'idle' | 'working' | 'cache' }
export type Lane = { name: string; at: number; turns?: number; restored?: boolean; rec?: string; adopted?: true; lead?: string; key?: string }
export type Request = {
  id: string
  mode: 'now' | 'on-cue'
  focus: string
  continuation: string
  sha256: string
  requestedMs: number
  phase: 'called' | 'armed' | 'compacting' | 'compacted'
  compactingMs?: number
  compactedMs?: number
  viaNudge?: true
  // v14 (2026-11-04): an on-cue request of a session holding a lead grant (the manager's compact cue, S7).
  viaLead?: true
}

declare module 'claude-code' {
  interface PluginState {
    'callboard': {
      lane: Lane | null
      enabled: { at: number } | null
      seen: number | null
      counters: Counters
      request: Request | null
      lastTurnAt: { at: number; size: number | null } | null
      nudgeDue: { kind: 'lead' | 'idle' | 'working' | 'cache' | 'threshold'; at: number; ping?: true } | null
      interactive: boolean | null
      nudgedAt: number | null
      turnEndAt: number | null
      realEndAt: number | null
      pingAt: number | null
      // v13.6: until when /callboard checkin pause holds this session's check-ins.
      checkinPauseUntil: number | null
    }
  }
}
