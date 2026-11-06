// Prompt answering (ADR 0004), PR 1: the pure logic. No engine call lives here, so core.spec-style tests (prompts.spec.ts) cover it whole.
// The hook that uses it is in register.ts. Nothing in this file lets an agent decide anything: it recognises what no agent may answer (the floor), what an
// agent may judge (the classifier), what a request file may hold (redaction, caps), and when a decision file is valid (the apply checks).

export const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const HASH_RE = /^[0-9a-f]{64}$/

// ---- numbers (PLAN §3.5, §6.1) ----
export const POLL_MS = 2000
// A person's click only, for the first 30 s of awake time; then the lead may answer.
export const MIN_AGE_MS = 30_000
// A decision is valid while the wait is alive and before expiresAt: 21 minutes of awake time (one past the 20-minute deny that arrives with PR 3).
export const EXPIRES_MS = 21 * 60_000
// withPerson (PR 3) moves expiresAt to 2 hours and slows the poll; PR 1 carries the number and its test so Stage 0 has defined behaviour.
export const PERSON_EXPIRES_MS = 2 * 3_600_000
export const PERSON_POLL_MS = 10_000
// One awake clock: each poll adds its gap, capped, so a closed lid cannot age a prompt nobody could have answered.
export const AWAKE_GAP_CAP_MS = 10_000
// A decision seen before its `answered` row is held for this long (awake), then dropped.
export const LEDGER_GRACE_MS = 10_000
export const STRING_CAP = 2000
export const INPUT_CAP = 12 * 1024
export const REQUEST_MAX = 16 * 1024
export const DECISION_MAX = 4096
export const LEDGER_ROW_MAX = 4096
export const WHY_MAX = 200
export const SWEEP_MS = 24 * 3_600_000
export const REGISTRY_MAX = 512

// Awake time: the gap since the last poll, never more than the cap and never negative (a clock that ran back adds nothing).
export function awakeAdd(awake: number, gapMs: number): number {
  const g = Number.isFinite(gapMs) ? Math.min(Math.max(gapMs, 0), AWAKE_GAP_CAP_MS) : 0
  return awake + g
}
export const expiresAfter = (withPerson: boolean): number => (withPerson ? PERSON_EXPIRES_MS : EXPIRES_MS)
export const pollFor = (withPerson: boolean): number => (withPerson ? PERSON_POLL_MS : POLL_MS)

// ---- the whole-input hash: the same canonical text on both sides of the join (probed equal between tool.check and PermissionRequest) ----
export function canonical(v: unknown): string {
  const canon = (x: any): any => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x)
  return JSON.stringify(canon(v)) ?? 'null'
}
export const joinKey = (tool: string, inputHash: string, agentId: string | undefined): string => `${tool}\n${inputHash}\n${agentId ?? ''}`

// ---- redaction: a copy of the toolkit's audit-logger.sh rules, best effort (that script says the same of itself) ----
const REDACT: [RegExp, string | ((m: string, ...g: any[]) => string)][] = [
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[REDACTED_PEM]'],
  [/-----BEGIN[^-]*PRIVATE KEY-----(?:\\[nrt]|[A-Za-z0-9+/=:,\s-])*/g, '[REDACTED_PEM]'],
  [/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  [/NR[A-Z][A-Z]-[A-Za-z0-9]+/g, '[REDACTED_NRKEY]'],
  [/(AKIA|ASIA)[A-Z0-9]+/g, '[REDACTED_AWSKEY]'],
  [/gh[pousr]_[A-Za-z0-9]+/g, '[REDACTED_GHTOKEN]'],
  [/github_pat_[A-Za-z0-9_]+/g, '[REDACTED_GHTOKEN]'],
  [/glpat-[A-Za-z0-9_-]+/g, '[REDACTED_GLPAT]'],
  [/(?:(?<![A-Za-z0-9])|(?<=\\[nrt]))sk-(ant-)?[A-Za-z0-9_-]+/g, '[REDACTED_APIKEY]'],
  [/(sk|rk)_live_[A-Za-z0-9_-]+/g, '[REDACTED_STRIPE]'],
  [/AIza[A-Za-z0-9_-]+/g, '[REDACTED_GOOGLE]'],
  [/xox[bpasr]-[A-Za-z0-9-]+/g, '[REDACTED_SLACK]'],
  [/((?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^:@/\s]+:)[^@/\s]+@/g, (_m, u: string) => `${u}[REDACTED]@`],
  [/((?:api[_-]?key|apikey|access[_-]?(?:token|key)|token|secret|password|passwd|[_-]pass|pwd|service_role[a-z_]*|client[_-]?secret)[A-Za-z0-9_]*"?\s*[=:]\s*"?)[^\s"&|;,]+/gi, (_m, k: string) => `${k}[REDACTED]`],
  [/([Bb]earer\s+)[A-Za-z0-9._-]+/g, (_m, b: string) => `${b}[REDACTED]`],
]
export function redact(s: string): string {
  let out = s
  for (const [re, to] of REDACT) out = out.replace(re, to as any)
  return out
}

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: false })
// The text cut to at most `max` bytes (never in the middle of a character: a cut one is dropped).
export function capBytes(s: string, max: number): { text: string; cut: boolean } {
  const b = enc.encode(s)
  if (b.length <= max) return { text: s, cut: false }
  let t = dec.decode(b.slice(0, max))
  while (t.endsWith('\ufffd')) t = t.slice(0, -1)
  return { text: t, cut: true }
}

// The copy of a tool's input the tier reads: every string redacted and capped, the whole kept under INPUT_CAP. truncated: the tier has not seen all of it, and
// the rubric then passes it up. Anything not plain JSON (a function, a cycle) is cut the same way, never thrown.
export function capInput(input: unknown): { input: unknown; truncated: boolean } {
  let cut = false
  const walk = (v: any, depth: number): any => {
    if (typeof v === 'string') {
      const r = capBytes(redact(v), STRING_CAP)
      if (r.cut) cut = true
      return r.text
    }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
    if (depth > 12) {
      cut = true
      return '[too deep]'
    }
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1)).concat(v.length > 200 ? ((cut = true), ['[more]']) : [])
    if (v && typeof v === 'object') {
      const keys = Object.keys(v)
      if (keys.length > 100) cut = true
      return Object.fromEntries(keys.slice(0, 100).map((k) => [capBytes(k, 200).text, walk(v[k], depth + 1)]))
    }
    cut = true
    return '[unsupported]'
  }
  let out = walk(input, 0)
  let text = JSON.stringify(out) ?? 'null'
  if (enc.encode(text).length > INPUT_CAP) {
    cut = true
    out = { _head: capBytes(text, INPUT_CAP - 64).text }
    text = JSON.stringify(out)
  }
  return { input: out, truncated: cut }
}

// ---- the floor (PLAN §3.4): what no agent may answer, whatever it judges ----
export type FloorCategory = 'merge' | 'force-push' | 'protected-push' | 'destructive' | 'settings' | 'dialog'
export type FloorOpts = {
  // The current branch of the repo a git call names, resolved by the hook with a hardened read-only git call; undefined: unresolved (the floor holds).
  branch?: string
  // Real paths of the file tools' path arguments (the hook runs realpath), checked as well as the written ones.
  real?: string[]
  // The person's home folder, for ~ and for the callboard and settings folders.
  home?: string
  // Tracked folders of the live checkouts (ai-manager, ai-toolkit): an edit under one is the floor.
  roots?: string[]
  // The optional items (PR 5 sets them; PR 1 passes none, so both are on the floor).
  optional?: { merges?: boolean; forcePushes?: boolean }
  // A file tool's real path could not be resolved: the floor holds (fail closed).
  unresolved?: boolean
}

const PROTECTED = new Set(['main', 'master', 'production'])
const GIT = 'mcp__git-mcp__'
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

// A branch name as a push would see it: no `+`, no refs/heads/ or refs/remotes/, no remote prefix. '@' and HEAD are the current branch (undefined here).
export function normRef(ref: string, remote?: string): string | undefined {
  let r = ref.trim().replace(/^\+/, '')
  if (r === '@' || r.toUpperCase() === 'HEAD') return undefined
  r = r.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '').replace(/^refs\//, '')
  const slash = r.indexOf('/')
  if (slash > 0) {
    const first = r.slice(0, slash)
    if (first === (remote ?? 'origin') || first === 'origin' || first === 'upstream') r = r.slice(slash + 1)
  }
  return r.toLowerCase()
}
// Whether a pushed ref (a name or a src:dst refspec) reaches a protected branch. unresolved: it names the current branch, which the caller must read.
function refProtected(ref: string, remote: string | undefined, branch: string | undefined): boolean {
  const parts = ref.includes(':') ? ref.split(':') : [ref]
  for (const p of parts) {
    if (p === '') continue
    const n = normRef(p, remote)
    if (n === undefined) {
      const b = branch === undefined ? undefined : normRef(branch, remote)
      if (b === undefined || PROTECTED.has(b)) return true
    } else if (PROTECTED.has(n)) return true
  }
  return false
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
function pathArgs(input: Record<string, unknown>): string[] {
  return [input.file_path, input.notebook_path, input.path].filter((x): x is string => typeof x === 'string')
}
function lexical(p: string, home: string | undefined): string {
  let x = p
  if (home && (x === '~' || x.startsWith('~/'))) x = home + x.slice(1)
  const abs = x.startsWith('/')
  const out: string[] = []
  for (const s of x.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return (abs ? '/' : '') + out.join('/')
}
function settingsPath(p0: string, o: FloorOpts): boolean {
  const p = lexical(p0, o.home)
  if (/(^|\/)\.mcp\.json$/.test(p) || /(^|\/)\.git\/hooks(\/|$)/.test(p) || /(^|\/)install\.conf$/.test(p)) return true
  if (/(^|\/)\.claude\/settings[^/]*$/.test(p)) return true
  if (o.home && (p === `${o.home}/.claude` || p.startsWith(`${o.home}/.claude/`))) return true
  return (o.roots ?? []).some((r) => p === r || p.startsWith(`${r}/`))
}
// Shell text naming the settings, hooks or callboard state. Best effort: eval, an encoded payload or a script file can hide it.
function settingsText(cmd: string, o: FloorOpts): boolean {
  if (/(~|\$HOME|\$\{HOME\})\/\.claude\b/.test(cmd) || /\.claude\/settings/.test(cmd)) return true
  if (o.home && cmd.includes(`${o.home}/.claude`)) return true
  if (/\.mcp\.json|\.git\/hooks|install\.conf|CLAUDE_CODE_PLUGIN_DIRS/.test(cmd)) return true
  if (/(^|[\s;&|(])claude\s+mcp\b/.test(cmd)) return true
  if (/workspace-lock\.sh\b[^\n;&|]*\bclear\b/.test(cmd)) return true
  return (o.roots ?? []).some((r) => cmd.includes(r))
}

const SQL_DANGER = [/\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|COLUMN|USER|ROLE|FUNCTION|TRIGGER|POLICY|EXTENSION|MATERIALIZED|SEQUENCE|TYPE)\b/i, /\bTRUNCATE\b(\s+TABLE)?\s+\S/i, /\bDELETE\s+FROM\b/i]
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === 'string') out.push(v)
  else if (depth < 12 && Array.isArray(v)) for (const x of v) strings(x, out, depth + 1)
  else if (depth < 12 && v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out, depth + 1)
  return out
}
const BASH_DELETE: RegExp[] = [
  /(^|[\s;&|(`])rm\s/,
  /(^|[\s;&|(`])rm$/,
  /\bfind\b[^\n;&|]*\s-delete\b/,
  /(^|[\s;&|(`])truncate\s/,
  /(^|[\s;&|(`])dd\s[^\n;&|]*\bof=/,
  /(^|[\s;&|(`])mkfs(\.\w+)?\b/,
  /\bgit\s+(-\S+\s+)*branch\s+[^\n;&|]*(-D\b|-d\b|--delete\b)/,
  /\bgit\s+(-\S+\s+)*clean\b/,
  /\bgit\s+(-\S+\s+)*reset\s+[^\n;&|]*--(hard|merge|keep)\b/,
  /\bgit\s+(-\S+\s+)*stash\s+(drop|clear)\b/,
  /\bgit\s+(-\S+\s+)*tag\s+[^\n;&|]*(-d\b|--delete\b|-f\b|--force\b)/,
]

// The floor, or undefined when the call is not on it. Pure: the hook runs it before a request is written and again at apply.
export function floorCheck(tool: string, input0: unknown, o: FloorOpts = {}): FloorCategory | undefined {
  const input = obj(input0)
  const name = tool.split('__').pop() ?? tool
  // Dialogs of other kinds.
  if (tool === 'ExitPlanMode') return 'dialog'
  // Merges: any server's merge_pull_request, a branch update, and merging while on a protected branch. The one optional item lifts by its own tool name only.
  if (/^mcp__.+__merge_pull_request$/.test(tool) || /^mcp__.+__update_pull_request_branch$/.test(tool)) return 'merge'
  if (tool === 'mcp__machine-ops__pr_merge') return o.optional?.merges === true ? undefined : 'merge'
  if (tool === 'mcp__machine-ops__force_push') return o.optional?.forcePushes === true ? undefined : 'force-push'
  if (tool === `${GIT}git_merge`) {
    const b = o.branch === undefined ? undefined : normRef(o.branch)
    return b === undefined || PROTECTED.has(b) ? 'merge' : undefined
  }
  if (tool === `${GIT}git_push`) {
    if (input.force === true || input.forceWithLease === true) return 'force-push'
    if (input.delete === true) return 'destructive'
    const remote = str(input.remote)
    const refs = [str(input.branch), str(input.remoteBranch)].filter((x): x is string => x !== undefined)
    if (refs.length === 0) {
      const b = o.branch === undefined ? undefined : normRef(o.branch, remote)
      return b === undefined || PROTECTED.has(b) ? 'protected-push' : undefined
    }
    for (const r of refs) if (/^\+/.test(r.trim())) return 'force-push'
    return refs.some((r) => refProtected(r, remote, o.branch)) ? 'protected-push' : undefined
  }
  if (tool.startsWith(GIT)) {
    const mode = str(input.mode)
    if (name === 'git_clean') return 'destructive'
    if (name === 'git_reset') return mode === 'hard' || mode === 'merge' || mode === 'keep' ? 'destructive' : undefined
    if (name === 'git_branch') return mode === 'delete' || input.force === true ? 'destructive' : undefined
    if (name === 'git_stash') return mode === 'drop' || mode === 'clear' ? 'destructive' : undefined
    if (name === 'git_tag') return mode === 'delete' || input.force === true ? 'destructive' : undefined
    if (name === 'git_checkout') return input.force === true || (Array.isArray(input.paths) && input.paths.length > 0) ? 'destructive' : undefined
  }
  // File tools: settings, hooks, callboard state.
  if (WRITE_TOOLS.has(tool)) {
    if (o.unresolved) return 'settings'
    if (pathArgs(input).concat(o.real ?? []).some((p) => settingsPath(p, o))) return 'settings'
  }
  if (tool === 'Bash') {
    const cmd = str(input.command)
    if (cmd === undefined) return 'destructive'
    // Any Bash `git push`: Bash cannot be parsed reliably, and the toolkit turns it away anyway. A force flag or a + refspec is told apart first.
    if (/\bgit\b[^\n;&|]*\bpush\b/.test(cmd)) {
      return /(\s|^)(--force\S*|-f)(\s|$)|\s\+\S/.test(cmd) ? 'force-push' : 'protected-push'
    }
    if (/\bgit\b[^\n;&|]*\bmerge\b/.test(cmd)) {
      const b = o.branch === undefined ? undefined : normRef(o.branch)
      if (b === undefined || PROTECTED.has(b)) return 'merge'
    }
    if (/\bgh\s+pr\s+merge\b/.test(cmd)) return 'merge'
    if (settingsText(cmd, o)) return 'settings'
    if (BASH_DELETE.some((re) => re.test(cmd))) return 'destructive'
  }
  // SQL in any tool's string input (a query, a command, a file's content).
  if (strings(input0).some((s) => SQL_DANGER.some((re) => re.test(s)))) return 'destructive'
  return undefined
}

// Whether a call needs the current branch read before the floor can judge it (a push with no branch, a merge).
export function needsBranch(tool: string, input0: unknown): boolean {
  const input = obj(input0)
  if (tool === `${GIT}git_push`) {
    const refs = [str(input.branch), str(input.remoteBranch)].filter((x): x is string => x !== undefined)
    return refs.length === 0 || refs.some((r) => r.split(':').some((p) => normRef(p) === undefined))
  }
  if (tool === `${GIT}git_merge`) return true
  if (tool === 'Bash' && typeof input.command === 'string') return /\bgit\b[^\n;&|]*\b(merge|push)\b/.test(input.command)
  return false
}
// The repo folder a git call names (an absolute path), for the branch read.
export function gitPathOf(tool: string, input0: unknown): string | undefined {
  const p = str(obj(input0).path)
  return tool.startsWith(GIT) && p !== undefined && p.startsWith('/') ? p : undefined
}

// ---- the classifier (PLAN §3.3): which asks agents may judge ----
export type CheckFacts = { decision?: unknown; reason?: unknown; rule?: unknown; hook?: unknown; setting?: unknown; plugin?: unknown; ceiling?: unknown }
export const GUARD_PREFIX = 'github-mcp-guard: '
export const GUARD_TOOLS: readonly string[] = ['mcp__github__create_pull_request', 'mcp__github__add_issue_comment', 'mcp__github__add_reply_to_pull_request_comment', 'mcp__github__update_pull_request']
export type Raised = 'mode' | 'rule' | 'guard'
export type Judge = { judge: 'agents'; raisedBy: Raised } | { judge: 'person'; why: string }
const set = (v: unknown) => v !== undefined && v !== null && v !== ''
export function classify(tool: string, f: CheckFacts): Judge {
  if (f.decision !== 'ask') return { judge: 'person', why: 'not-ask' }
  // Questions stay the person's until PR 4 adds the limits of §7.2.
  if (tool === 'AskUserQuestion') return { judge: 'person', why: 'question' }
  if (set(f.setting) || set(f.plugin) || set(f.ceiling)) return { judge: 'person', why: 'setting-plugin-ceiling' }
  if (set(f.hook)) {
    // The named guard: a PreToolUse ask, no rule (an ask rule hides the guard's own reason), its prefix, one of its four tools.
    if (f.hook === 'PreToolUse' && !set(f.rule) && typeof f.reason === 'string' && f.reason.startsWith(GUARD_PREFIX) && GUARD_TOOLS.includes(tool)) return { judge: 'agents', raisedBy: 'guard' }
    return { judge: 'person', why: 'hook' }
  }
  return set(f.rule) ? { judge: 'agents', raisedBy: 'rule' } : { judge: 'agents', raisedBy: 'mode' }
}

// ---- the switch (PLAN §5.2): stored under `answering`; off by default ----
export type Answering = { scope: string; asks: boolean; savedAt: number }
export function parseAnswering(raw: unknown): Answering | undefined {
  const o = obj(raw)
  if (typeof o.scope !== 'string' || !/^(all|[A-Za-z0-9_-]{1,40})$/.test(o.scope) || typeof o.asks !== 'boolean' || typeof o.savedAt !== 'number') return undefined
  return { scope: o.scope, asks: o.asks, savedAt: o.savedAt }
}
// /callboard answering: show; off [asks]; on <LANE>|<LEAD>|all [asks]. Anything else is the usage line.
export type AnsweringOp = 'show' | 'off' | 'off-asks' | 'bad' | { on: string; asks: boolean }
export function parseAnsweringArgs(rest: string | undefined): AnsweringOp {
  const a = (rest ?? '').trim()
  if (a === '') return 'show'
  if (a === 'off') return 'off'
  if (a === 'off asks') return 'off-asks'
  const m = /^on ([A-Za-z0-9_-]{1,40})( asks)?$/.exec(a)
  return m ? { on: m[1], asks: m[2] !== undefined } : 'bad'
}
// Whether the switch covers a session: all, or the lane's name, or its lead's name, or the lead's own name. Names compare exactly (a look-alike covers nothing).
export function covers(a: Answering | undefined, who: { lane?: string; lead?: string; self?: string }): boolean {
  if (!a) return false
  if (a.scope === 'all') return true
  return a.scope === who.lane || a.scope === who.lead || a.scope === who.self
}

// ---- request and decision files (PLAN §3.5) ----
export type Request = {
  id: string
  sid: string
  pid: number
  procStart: string
  level: 'lane' | 'lead'
  lane?: string
  leadName?: string
  repo: string
  tool: string
  agentType?: string
  inputHash: string
  raisedBy: Raised
  at: number
  expiresAt: number
  nonce: string
  input: unknown
  truncated: boolean
}
export const requestText = (r: Request): string => JSON.stringify(r)

export type Decision = { id: string; inputHash: string; decision: 'allow' | 'deny'; why: string; by: { level: string; sid: string; name: string }; via?: 'person'; at: number; nonce: string }
// A decision file as text, or undefined for anything that is not one: one object, the exact keys' types, no answer (PR 4), at most DECISION_MAX bytes.
export function parseDecision(text: string): Decision | undefined {
  if (enc.encode(text).length > DECISION_MAX) return undefined
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  const o = obj(j)
  const by = obj(o.by)
  if (typeof o.id !== 'string' || typeof o.inputHash !== 'string' || typeof o.nonce !== 'string' || typeof o.why !== 'string' || typeof o.at !== 'number') return undefined
  if (o.decision !== 'allow' && o.decision !== 'deny') return undefined
  if (typeof by.level !== 'string' || typeof by.sid !== 'string' || typeof by.name !== 'string') return undefined
  if (o.via !== undefined && o.via !== 'person') return undefined
  return { id: o.id, inputHash: o.inputHash, decision: o.decision, why: o.why, by: { level: by.level, sid: by.sid, name: by.name }, via: o.via as 'person' | undefined, at: o.at, nonce: o.nonce }
}

export type ApplyIn = {
  req: Pick<Request, 'id' | 'nonce' | 'inputHash' | 'sid'>
  decision: Decision
  // The hash of the live input, taken again at apply.
  liveHash: string
  awakeMs: number
  expiresAt: number
  floor: FloorCategory | undefined
  // The decision's author is a live lead in reach of this asker, which is not the asker. PR 1 knows the lead tier only.
  byOk: boolean
  ledger: 'found' | 'missing' | 'unreadable'
  // How long (awake) the decision has been seen without its `answered` row.
  graceMs: number
}
export type ApplyOut = { ok: true } | { hold: 'early' | 'ledger' } | { drop: DropCode }
export type DropCode = 'id' | 'hash' | 'nonce' | 'expired' | 'floor' | 'by-sid' | 'no-answered-row' | 'ledger-unreadable'
// Every check, in this order; a failure is a dropped row and the wait goes on. A decision that is early is held, not dropped, so no retry costs a model turn.
export function applyCheck(a: ApplyIn): ApplyOut {
  const { req, decision: d } = a
  if (d.id !== req.id) return { drop: 'id' }
  if (!HASH_RE.test(d.inputHash) || d.inputHash !== req.inputHash || a.liveHash !== req.inputHash) return { drop: 'hash' }
  if (d.nonce !== req.nonce) return { drop: 'nonce' }
  if (a.awakeMs >= a.expiresAt) return { drop: 'expired' }
  if (a.floor !== undefined) return { drop: 'floor' }
  if (!a.byOk || d.by.sid === req.sid || !SID.test(d.by.sid) || d.by.level !== 'lead') return { drop: 'by-sid' }
  if (a.ledger === 'unreadable') return { drop: 'ledger-unreadable' }
  if (a.ledger === 'missing') return a.graceMs < LEDGER_GRACE_MS ? { hold: 'ledger' } : { drop: 'no-answered-row' }
  if (a.awakeMs < MIN_AGE_MS) return { hold: 'early' }
  return { ok: true }
}

// ---- the ledger (PLAN §3.5): machine-wide, one JSON row per line, no input text ----
export type RowKind = 'requested' | 'answered' | 'escalated' | 'dropped' | 'returned' | 'superseded' | 'expired-denied' | 'off' | 'abandoned' | 'floor' | 'not-judgeable' | 'no-tier' | 'floor-confirmed' | 'floor-off' | 'answering-on' | 'answering-off'
export type LedgerRow = { t: string; kind: RowKind; code?: string; id?: string; lane?: string; repo?: string; tool?: string; pattern?: string; hash?: string; tier?: string; why?: string; nonce?: string }
export function ledgerLine(row: LedgerRow): string {
  const r: LedgerRow = { ...row }
  if (r.why !== undefined) r.why = capBytes(redact(r.why).replace(/[\r\n]+/g, ' '), WHY_MAX).text
  if (r.pattern !== undefined) r.pattern = capBytes(r.pattern, 200).text
  if (r.repo !== undefined) r.repo = capBytes(r.repo, 300).text
  let line = JSON.stringify(r)
  // Each row stays whole under one append: drop the long fields first, never the identity.
  if (enc.encode(line).length >= LEDGER_ROW_MAX) {
    delete r.why
    delete r.repo
    line = JSON.stringify(r)
  }
  return `${line}\n`
}
export const ledgerFile = (now: number): string => `ledger-${new Date(now).toISOString().slice(0, 7)}.jsonl`
// The ledger file of the month before, for a decision written near a month's end.
export const ledgerFilePrev = (now: number): string => {
  const d = new Date(now)
  return ledgerFile(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15))
}
// What a row's `pattern` holds (never arguments, a host or a body): argv0 for Bash; the tool, owner/repo and number for a GitHub tool; the repo-relative path
// for a file tool; the tool name for the rest.
export function patternOf(tool: string, input0: unknown, repo?: string): string {
  const input = obj(input0)
  if (tool === 'Bash') {
    const first = (str(input.command) ?? '').trim().split(/\s+/)[0] ?? ''
    return first.replace(/^.*\//, '').slice(0, 60) || 'bash'
  }
  if (tool.startsWith('mcp__github__')) {
    const n = input.pullNumber ?? input.issue_number ?? input.number
    const where = typeof input.owner === 'string' && typeof input.repo === 'string' ? ` ${input.owner}/${input.repo}` : ''
    return `${tool}${where}${typeof n === 'number' ? ` #${n}` : ''}`
  }
  if (WRITE_TOOLS.has(tool) || tool === 'Read') {
    const p = pathArgs(input)[0]
    if (p === undefined) return tool
    if (repo && p.startsWith(`${repo}/`)) return `${tool} ${p.slice(repo.length + 1)}`
    return `${tool} <outside>`
  }
  return tool
}

// ---- the messages the hook gives back and the commands print (fixed text) ----
export const ANSWERING_USAGE = 'Use /callboard answering [on LANE|LEAD|all [asks], off [asks]].'
export const ANSWERING_NOT_PERSON = 'Turning prompt answering on is the person\'s own command, typed in the prompt or on the phone. Nothing changed.'
export const ANSWERING_YES = 'Allow'
export const ANSWERING_NO = 'Cancel'
export const ANSWERING_HEADER = 'Answering'
// The fixed text of the dialog, built from the parsed scope and flag only: no free text reaches it.
export function answeringQuestion(scope: string, asks: boolean): string {
  const who = scope === 'all' ? 'EVERY lane and lead' : `the lane or lead named ${scope}`
  return `On this Mac, let a lead answer the permission prompts of ${who}. The dialog stays open and your click always wins; an answer lands no earlier than 30 seconds after the prompt opens. Stays yours: merges, force pushes, pushes to main, master or production, destructive deletes, edits to settings, hooks or callboard, anything from a subagent, and the risk list. Questions stay yours too${asks ? ' (the asks flag is stored but has no effect yet)' : ''}. Turn it off at any time with /callboard answering off.`
}
export const FLOOR_LINE = 'Floor (never answered by an agent): merges, force pushes, pushes to main, master or production, destructive deletes, edits to settings, hooks and callboard state. The optional merge and force-push items are off.'
export function answeringState(a: Answering | undefined, offFile: boolean): string {
  const on = a ? `on for ${a.scope === 'all' ? 'all lanes and leads' : a.scope}${a.asks ? ' (asks flag set, no effect yet)' : ''}` : 'off'
  return `Prompt answering: ${on}.${offFile ? ' The OFF file exists, so it is off whatever is stored; delete it, then run /callboard answering on.' : ''}`
}
