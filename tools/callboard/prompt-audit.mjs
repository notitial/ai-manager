#!/usr/bin/env node
// callboard prompt-audit [--since DATE] [--root DIR] [--projects DIR] [--json]
// Read-only audit of prompt answering (ADR 0004, "Rollout, off switch and audit"): one table of every request, the anomalies
// that must stay empty, what is deliberately not an anomaly, and wait counts. Nothing here writes: it never creates, edits,
// renames, removes or touches a file, and it follows no symlink inside the folders it reads. Convenience only: every real
// limit lives in the mod. Exit 0: no anomalies. 1: anomalies. 2: usage error, an unreadable root, or a ledger file that could
// not be read (an audit that missed a ledger file proves nothing, so it never exits 0).
//
// The ledger rows it reads (prompts.ts, LedgerRow): { t, kind, code?, id?, lane?, repo?, tool?, pattern?, hash?, tier?, why?, nonce? }.
//   requested  id, nonce, lane, repo, tool, pattern, hash, tier     the hook asked a tier
//   answered   id, nonce (the requested row's), code allow|deny, by (the answering lead's session id), tier, why, lane, repo, tool, pattern, hash
//              a tier decided (written by prompt_answer)
//   returned   id, code allow|deny, by, tuid (the tool_use_id of the call), tier, why (+ the request's fields)  the hook gave the decision
//              back; carries no nonce. An older ledger's returned rows have no tuid and no by.
//   superseded | expired-denied | off | abandoned <code>   each ends a request (abandoned: session-gone, swept, hook-failed, no-tier, expired)
//   dropped <code>   a decision the hook refused or could not read
//   relayed    id, code (the relaying tier's level), short (the first 8 hex of the id), by (its session id)   the top tier took the request to the person
//   relay-lost id?, code (not-asked | gone | ...), short, by, tier   the relay did not reach the person; the request is open to the tiers again
//   relay-left id, short, by, tier   the person dismissed or answered something else; relay-late short, by, code (closed | decided)   an answer after the request ended
//   deny-unclear   a deny whose reason the cleaner-command rule found too vague to judge
//   answered / returned rows of the person's own answer carry via: "person", short and by = the relaying tier's session id (no prompt_answer call exists for them)
//   floor <category>, not-judgeable, no-tier, escalated, floor-confirmed, floor-off, answering-on, answering-off   no request of their own
//
// Rule c (a hook-sourced decision in a transcript that the ledger never saw), and its blind spot. A result line's
// `permissionDecision.source: "hook"` does not say which hook event decided: PreToolUse guards allow and deny with the same source. Real
// transcripts show the difference in two places only. The engine writes an attachment line { type: "hook_permission_decision",
// hookEvent: "PermissionRequest", toolUseID, decision } for a PermissionRequest hook's decision (seen: 32 of 32 such decisions, each
// with a result line of source hook at the same second), and a PreToolUse deny carries reasonCode "hook:PreToolUse". So an allow is
// checked only when its tool_use id has that attachment, or its reasonCode names PermissionRequest. Blind spot: an allow that the
// engine records as source hook but without that attachment is not checked and is only counted ("hook allows with no PermissionRequest
// record"); if a later engine stops writing the attachment, rule c goes quiet while that count rises, so read the count. A hook deny
// is never flagged: it grants nothing.
import { openSync, closeSync, readSync, fstatSync, lstatSync, readdirSync, realpathSync, constants } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

export const LEDGER_MAX_BYTES = 16 * 1024 * 1024
export const LEDGER_LINE_MAX = 64 * 1024
// A transcript line holds a whole tool result or attachment, so real ones pass 1 MB (live test A: three sessions). Lines up to this size are read and tested like any other;
// a longer one is streamed past, looking only for the text a decision needs (TRANSCRIPT_MARKERS), and is a problem only if it holds one.
export const TRANSCRIPT_LINE_MAX = 32 * 1024 * 1024
const TRANSCRIPT_MARKERS = ['permissionDecision', 'hook_permission_decision']
// A request whose hook ended without a row is closed by the mod's tick within seconds; a request with no ending row and no request file after this long is a fault.
export const CLOSE_GRACE_MS = 10 * 60 * 1000
export const TRANSCRIPT_MAX_BYTES = 1024 * 1024 * 1024
export const TRANSCRIPT_TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const TRANSCRIPT_FILES_MAX = 2000
export const DIR_ENTRIES_MAX = 50000
export const WALK_DEPTH_MAX = 6
export const JSON_DEPTH_MAX = 8
export const JSON_NODES_MAX = 5000
export const DAY_MS = 24 * 60 * 60 * 1000
export const WINDOW_MS = 10 * 60 * 1000
const LIST_MAX = 200

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KINDS = new Set(['requested', 'answered', 'escalated', 'dropped', 'returned', 'superseded', 'expired-denied', 'off', 'abandoned', 'floor', 'not-judgeable', 'no-tier', 'floor-confirmed', 'floor-off', 'answering-on', 'answering-off', 'relayed', 'relay-lost', 'relay-left', 'relay-late', 'deny-unclear'])
const FIELDS = ['code', 'id', 'lane', 'repo', 'tool', 'pattern', 'hash', 'ctx', 'tier', 'why', 'nonce', 'tuid', 'by', 'via', 'short']
const ENDS = new Set(['returned', 'superseded', 'expired-denied', 'off', 'abandoned'])
// A `dropped` row with one of these codes is a decision the hook refused as forged or wrong: an anomaly. The others are ordinary.
const DROP_ANOMALY = new Set(['no-answered-row', 'id', 'hash', 'nonce', 'by-sid'])
const DROP_FINE = new Set(['expired', 'ledger-unreadable', 'file', 'shape', 'floor'])

// The small built-in floor check of rule d, best effort. A ledger row never holds arguments (patternOf keeps a command's first word,
// a tool's repository and number, a file's repo-relative path), so only shapes visible in `tool` and `pattern` can be recognised:
// merge and branch-update tools, an assumed machine-ops server (`mcp__machine-ops__*` or `mcp__machine_ops__*`), and a write tool
// whose path is one the hook's own floor holds (.claude/settings*, .claude/hooks, callboard's folder, .git, .husky, .githooks); a hooks folder or a settings.json of
// a project is not one. A force push cannot be told from a plain one here.
const FLOOR_TOOL_RE = /(^|__)(merge_pull_request|update_pull_request_branch)$|^mcp__machine[-_]ops__/
const FLOOR_PATH_RE = /(^|\/)(\.claude\/(settings[^/]*|hooks(\/|$)|callboard(\/|$))|callboard\/(prompts|cue|leads|open)(\/|$)|\.git(\/|$)|\.husky(\/|$)|\.githooks(\/|$)|\.mcp\.json$|install\.conf$)/
const WRITE_TOOL_RE = /^(Edit|Write|MultiEdit|NotebookEdit)\b/
export function floorShape(tool, pattern) {
  if (typeof tool !== 'string') return undefined
  if (FLOOR_TOOL_RE.test(tool)) return `tool ${tool}`
  if (WRITE_TOOL_RE.test(tool) && typeof pattern === 'string' && FLOOR_PATH_RE.test(pattern.replace(/^\S+\s+/, ''))) return `path in ${pattern}`
  return undefined
}

class AuditError extends Error {}

// ---- bounded, symlink-refusing reads ----
// Reads a regular file line by line through O_NOFOLLOW and an fstat of the open descriptor. A line over maxLine is skipped, never
// buffered whole (with `markers`, it is streamed past and counted in skippedMarked when it held one of them). Throws AuditError('symlink' | 'not-a-file' | 'too-large' | ...) with a short code in .code.
function codeErr(code, path) {
  const e = new AuditError(`${code}: ${path}`)
  e.code = code
  return e
}
export function eachLine(path, { maxLine, maxFileBytes, maxRead, markers = [] }, onLine) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    throw codeErr(e.code === 'ELOOP' ? 'symlink' : e.code === 'ENOENT' ? 'missing' : 'unreadable', path)
  }
  const stats = { skippedLong: 0, skippedMarked: 0, truncated: false, bytes: 0 }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw codeErr('not-a-file', path)
    if (maxFileBytes !== undefined && st.size > maxFileBytes) throw codeErr('too-large', path)
    const buf = Buffer.allocUnsafe(64 * 1024)
    let parts = []
    let len = 0
    let skipping = false
    // A line being skipped is searched for the markers across chunk borders: the last bytes of what was seen are kept and put before the next piece.
    const mk = markers.map((m) => Buffer.from(m))
    const keep = Math.max(0, ...mk.map((m) => m.length - 1))
    let marked = false
    let tail = Buffer.alloc(0)
    const scan = (seg) => {
      if (mk.length === 0) return
      const hay = tail.length > 0 ? Buffer.concat([tail, seg]) : seg
      if (!marked && mk.some((m) => hay.includes(m))) marked = true
      tail = Buffer.from(hay.subarray(Math.max(0, hay.length - keep)))
    }
    const flush = () => {
      if (skipping) {
        stats.skippedLong++
        if (marked) stats.skippedMarked++
      } else if (len > 0) onLine(Buffer.concat(parts, len).toString('utf8'))
      parts = []
      len = 0
      skipping = false
      marked = false
      tail = Buffer.alloc(0)
    }
    for (;;) {
      if (maxRead !== undefined && stats.bytes >= maxRead) {
        // At the limit: truncated only when more data follows (a file of exactly the limit is complete).
        stats.truncated = readSync(fd, buf, 0, 1, null) > 0
        break
      }
      const n = readSync(fd, buf, 0, Math.min(buf.length, maxRead === undefined ? buf.length : maxRead - stats.bytes), null)
      if (n === 0) break
      stats.bytes += n
      const chunk = buf.subarray(0, n)
      let from = 0
      while (from < n) {
        const nl = chunk.indexOf(10, from)
        const end = nl === -1 ? n : nl
        if (!skipping) {
          len += end - from
          if (len > maxLine) {
            skipping = true
            scan(Buffer.concat([...parts, chunk.subarray(from, end)]))
            parts = []
            len = 0
          } else parts.push(Buffer.from(chunk.subarray(from, end)))
        } else scan(chunk.subarray(from, end))
        if (nl === -1) break
        flush()
        from = nl + 1
      }
    }
    flush()
  } finally {
    closeSync(fd)
  }
  return stats
}

// A directory listing that never follows a link: entries with their kind from lstat semantics (withFileTypes uses d_type).
function list(dir) {
  return readdirSync(dir, { withFileTypes: true })
}

// ---- the ledger ----
function parseRow(line) {
  let j
  try {
    j = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.kind !== 'string' || !KINDS.has(j.kind)) return undefined
  const ms = typeof j.t === 'string' ? Date.parse(j.t) : NaN
  if (!Number.isFinite(ms)) return undefined
  const r = { t: j.t, ms, kind: j.kind }
  for (const f of FIELDS) {
    if (j[f] === undefined) continue
    if (typeof j[f] !== 'string') return undefined
    r[f] = j[f].slice(0, 500)
  }
  if (r.id !== undefined && !ID_RE.test(r.id)) return undefined
  return r
}

function readLedger(root, entries, problems, notes) {
  const rows = []
  let garbage = 0
  let files = 0
  const names = entries.filter((d) => /^ledger-\d{4}-\d{2}\.jsonl$/.test(d.name)).sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const d of names) {
    if (d.isSymbolicLink()) {
      problems.push(`${d.name}: a symlink, not read`)
      continue
    }
    if (!d.isFile()) {
      problems.push(`${d.name}: not a regular file, not read`)
      continue
    }
    try {
      const s = eachLine(join(root, d.name), { maxLine: LEDGER_LINE_MAX, maxFileBytes: LEDGER_MAX_BYTES }, (line) => {
        if (line.trim() === '') return
        const r = parseRow(line)
        if (r) rows.push({ ...r, seq: rows.length, file: d.name })
        else garbage++
      })
      garbage += s.skippedLong
      files++
    } catch (e) {
      problems.push(e instanceof AuditError ? `${d.name}: ${e.code}, not read` : `${d.name}: ${e.message}`)
    }
  }
  if (garbage > 0) notes.push(`${garbage} ledger line(s) were not valid rows and were ignored`)
  rows.sort((a, b) => a.ms - b.ms || a.seq - b.seq)
  return { rows, garbage, files }
}

function readQuestions(root, entries, since, problems) {
  const out = { files: 0, count: 0, rows: [] }
  for (const d of entries.filter((x) => /^questions-\d{4}-\d{2}\.jsonl$/.test(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!d.isFile()) {
      problems.push(`${d.name}: ${d.isSymbolicLink() ? 'a symlink' : 'not a regular file'}, not read`)
      continue
    }
    try {
      eachLine(join(root, d.name), { maxLine: LEDGER_LINE_MAX, maxFileBytes: LEDGER_MAX_BYTES }, (line) => {
        if (line.trim() === '') return
        let ms
        try {
          const t = JSON.parse(line)?.t
          ms = typeof t === 'string' ? Date.parse(t) : NaN
        } catch {}
        if (since !== undefined && Number.isFinite(ms) && ms < since) return
        out.count++
        if (out.rows.length < LIST_MAX) out.rows.push(line.length > 200 ? `${line.slice(0, 200)}...` : line)
      })
      out.files++
    } catch (e) {
      problems.push(e instanceof AuditError ? `${d.name}: ${e.code}, not read` : `${d.name}: ${e.message}`)
    }
  }
  return out
}

// ---- transcripts (rule c) ----
function findDecision(root0) {
  // Walks the parsed line to a bounded depth and node count for an object whose `permissionDecision` is an object with a string
  // `source` (the real shape puts it on the top level of a tool_result line; the spec also accepts it under message,
  // toolUseResult or attachment). Also returns the first tool_use_id found.
  let nodes = 0
  let pd
  let toolUseId
  const stack = [[root0, 0]]
  while (stack.length > 0 && nodes < JSON_NODES_MAX) {
    const [o, depth] = stack.pop()
    nodes++
    if (o === null || typeof o !== 'object') continue
    if (!Array.isArray(o)) {
      if (pd === undefined && o.permissionDecision && typeof o.permissionDecision === 'object' && typeof o.permissionDecision.source === 'string') pd = o.permissionDecision
      if (toolUseId === undefined) for (const k of ['tool_use_id', 'toolUseID', 'toolUseId']) if (typeof o[k] === 'string') toolUseId = o[k].slice(0, 100)
    }
    if (depth >= JSON_DEPTH_MAX) continue
    for (const v of Object.values(o)) if (v !== null && typeof v === 'object') stack.push([v, depth + 1])
  }
  return pd === undefined ? undefined : { pd, toolUseId }
}

function collectTranscriptFiles(projects, since, problems) {
  const found = []
  let visited = 0
  let deep = false
  let unreadable = 0
  const walk = (dir, depth) => {
    if (depth > WALK_DEPTH_MAX) {
      deep = true
      return
    }
    let ents
    try {
      ents = list(dir)
    } catch {
      unreadable++
      return
    }
    for (const d of ents) {
      if (++visited > DIR_ENTRIES_MAX) return
      const p = join(dir, d.name)
      if (d.isSymbolicLink()) continue
      if (d.isDirectory()) walk(p, depth + 1)
      else if (d.isFile() && d.name.endsWith('.jsonl')) {
        let st
        try {
          st = lstatSync(p)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        if (since !== undefined && st.mtimeMs < since) continue
        found.push({ path: p, mtimeMs: st.mtimeMs })
      }
    }
  }
  walk(projects, 0)
  // A transcript that is not listed is a transcript that is not read: the run is incomplete, whatever the anomalies say.
  if (visited > DIR_ENTRIES_MAX) problems.push(`transcripts: stopped listing after ${DIR_ENTRIES_MAX} entries`)
  if (deep) problems.push(`transcripts: folders deeper than ${WALK_DEPTH_MAX} levels were not listed`)
  if (unreadable > 0) problems.push(`transcripts: ${unreadable} folder(s) could not be listed`)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (found.length > TRANSCRIPT_FILES_MAX) {
    problems.push(`transcripts: only the ${TRANSCRIPT_FILES_MAX} newest of ${found.length} files were scanned; narrow it with --since`)
    found.length = TRANSCRIPT_FILES_MAX
  }
  return found
}

function scanTranscripts(projects, since, notes, problems, budget, lineMax) {
  const decisions = []
  // The prompt_answer calls each session made (session id -> request ids), and the sessions whose transcript was read at all (rule c2).
  const answerCalls = new Map()
  // The person-relay questions each session asked (session id -> short -> the labels it was answered with): an AskUserQuestion whose header is `Relay <8 hex>`.
  const relayAsks = new Map()
  // Every relay question as the tier asked it, with the answer it got (for the list the person reads, plan section 4).
  const relayQs = []
  const sessions = new Set()
  let longUnmarked = 0
  let scanned = 0
  let total = 0
  const files = collectTranscriptFiles(projects, since, problems)
  for (const [n, f] of files.entries()) {
    // A total byte budget over all transcripts: running out of it leaves the rest unread, which makes the audit incomplete.
    if (total >= budget) {
      problems.push(`transcripts: the byte budget of ${budget} was used up; ${files.length - n} file(s) were not read`)
      break
    }
    const room = budget - total
    const names = new Map()
    const relayIds = new Map()
    // tool_use ids the engine records as decided by a PermissionRequest hook (an attachment line, hookEvent PermissionRequest).
    const permReq = new Set()
    const first = decisions.length
    let lineNo = 0
    const fileSid = basename(f.path, '.jsonl')
    // The sessions this file speaks for, counted as read only once the whole file was (a partly read transcript says nothing about a missing call).
    const fileSessions = new Set([fileSid])
    try {
      const s = eachLine(f.path, { maxLine: lineMax, maxRead: Math.min(TRANSCRIPT_MAX_BYTES, room), markers: TRANSCRIPT_MARKERS }, (line) => {
        lineNo++
        const hasPd = line.includes('permissionDecision')
        const hasAtt = line.includes('hook_permission_decision')
        if (!hasPd && !hasAtt && !line.includes('"tool_use"') && !(relayIds.size > 0 && line.includes('"tool_use_id"'))) return
        let j
        try {
          j = JSON.parse(line)
        } catch {
          return
        }
        if (!j || typeof j !== 'object') return
        // A tool_use block names the tool; its result line (which holds the decision) does not.
        const content = j.message?.content
        if (Array.isArray(content)) {
          for (const b of content) {
            if (!b || b.type !== 'tool_use') continue
            if (typeof b.id === 'string' && typeof b.name === 'string' && names.size < 100000) names.set(b.id, b.name.slice(0, 200))
            if (typeof b.name === 'string' && /(^|__)AskUserQuestion$/.test(b.name) && Array.isArray(b.input?.questions) && typeof b.id === 'string' && relayIds.size < 100000) {
              for (const q of b.input.questions.slice(0, 8)) {
                const m = typeof q?.header === 'string' ? /^Relay ([0-9a-f]{8})$/.exec(q.header) : null
                if (!m) continue
                const sidKey = typeof j.sessionId === 'string' ? j.sessionId : fileSid
                fileSessions.add(sidKey)
                // One call may carry several relay questions (a tier coalesces): each is kept with its own text, which keys its answer.
                const list = relayIds.get(b.id) ?? []
                const entry = { sid: sidKey, short: m[1], question: typeof q.question === 'string' ? q.question : '' }
                list.push(entry)
                if (relayQs.length < 5000) relayQs.push({ ...entry, label: undefined })
                relayIds.set(b.id, list)
                let per = relayAsks.get(sidKey)
                if (!per) relayAsks.set(sidKey, (per = new Map()))
                if (!per.has(m[1])) per.set(m[1], [])
              }
            }
            // A lead's answer is a prompt_answer call of the callboard tool, whose input names the request id.
            if (typeof b.name === 'string' && /(^|__)prompt_answer$/.test(b.name) && typeof b.input?.id === 'string') {
              const sidKey = typeof j.sessionId === 'string' ? j.sessionId : fileSid
              fileSessions.add(sidKey)
              let set = answerCalls.get(sidKey)
              if (!set) answerCalls.set(sidKey, (set = new Set()))
              if (set.size < 100000) set.add(b.input.id.slice(0, 100))
            }
          }
        }
        // The answer to a relay question: the labels of the tool result (toolUseResult.answers, or the quoted pairs of its text).
        if (relayIds.size > 0 && Array.isArray(content)) {
          for (const b of content) {
            const asks = b && b.type === 'tool_result' && typeof b.tool_use_id === 'string' ? relayIds.get(b.tool_use_id) : undefined
            if (!asks) continue
            // Each answer belongs to the question whose text keys it (the result's `answers` is keyed by question text); with the structured form missing, to the
            // quoted `"question"="label"` pair of the result's text. Never pooled across the call's questions.
            const ans = j.toolUseResult?.answers
            const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : ''
            for (const ask of asks) {
              let label
              if (ans && typeof ans === 'object' && Object.prototype.hasOwnProperty.call(ans, ask.question) && typeof ans[ask.question] === 'string') label = ans[ask.question].slice(0, 100)
              else if (!ans && ask.question !== '') {
                const at = text.indexOf(`"${ask.question}"="`)
                if (at !== -1) label = /^[^"]{0,100}/.exec(text.slice(at + ask.question.length + 4))?.[0]
              }
              if (label !== undefined) relayAsks.get(ask.sid)?.get(ask.short)?.push(label)
              const rec = relayQs.find((x) => x.sid === ask.sid && x.short === ask.short && x.question === ask.question && x.label === undefined)
              if (rec) rec.label = label
            }
          }
        }
        const att = j.attachment
        if (hasAtt && att && typeof att === 'object' && att.type === 'hook_permission_decision' && att.hookEvent === 'PermissionRequest' && typeof att.toolUseID === 'string' && permReq.size < 100000) permReq.add(att.toolUseID.slice(0, 100))
        if (!hasPd) return
        const found = findDecision(j)
        if (!found) return
        const tsRaw = typeof j.timestamp === 'string' ? j.timestamp : typeof j.message?.timestamp === 'string' ? j.message.timestamp : undefined
        const ts = tsRaw !== undefined && Number.isFinite(Date.parse(tsRaw)) ? Date.parse(tsRaw) : f.mtimeMs
        if (since !== undefined && ts < since) return
        decisions.push({
          file: basename(f.path),
          line: lineNo,
          sid: typeof j.sessionId === 'string' ? j.sessionId : typeof j.session_id === 'string' ? j.session_id : basename(f.path, '.jsonl'),
          ms: ts,
          source: found.pd.source.slice(0, 40),
          decision: typeof found.pd.decision === 'string' ? found.pd.decision.slice(0, 20) : '',
          reasonCode: typeof found.pd.reasonCode === 'string' ? found.pd.reasonCode.slice(0, 60) : '',
          toolUseId: found.toolUseId,
          tool: found.toolUseId !== undefined ? names.get(found.toolUseId) : undefined,
        })
      })
      // The attachment may come before or after the result line, so it is matched once the file is read.
      for (let i = first; i < decisions.length; i++) decisions[i].permissionRequest = decisions[i].toolUseId !== undefined && permReq.has(decisions[i].toolUseId)
      scanned++
      total += s.bytes
      if (!s.truncated) for (const k of fileSessions) sessions.add(k)
      if (s.skippedMarked > 0) problems.push(`transcripts: ${basename(f.path)}: ${s.skippedMarked} line(s) over ${lineMax} bytes held permission-decision text and were not parsed, so a decision on one was not checked`)
      longUnmarked += s.skippedLong - s.skippedMarked
      if (s.truncated && room < TRANSCRIPT_MAX_BYTES) {
        problems.push(`transcripts: the byte budget of ${budget} was used up inside ${basename(f.path)}; the rest of it and ${files.length - n - 1} more file(s) were not read`)
        break
      }
      if (s.truncated) problems.push(`transcripts: ${basename(f.path)} was read only to its first ${TRANSCRIPT_MAX_BYTES} bytes`)
    } catch (e) {
      problems.push(`transcripts: ${basename(f.path)}: ${e instanceof AuditError ? e.code : e.message}, not read`)
    }
  }
  if (longUnmarked > 0) notes.push(`transcripts: ${longUnmarked} line(s) over ${lineMax} bytes held no permission-decision text and were streamed past unparsed`)
  return { decisions, scanned, filesFound: files.length, answerCalls, relayAsks, relayQs, sessions }
}

// ---- stats ----
export function percentile(sorted, p) {
  if (sorted.length === 0) return undefined
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}
function waitStats(values) {
  const s = [...values].sort((a, b) => a - b)
  return { n: s.length, median: percentile(s, 50), p90: percentile(s, 90) }
}

// ---- the audit ----
export function audit({ root, projects, since, now = Date.now(), projectsExplicit = false, transcriptBudget = TRANSCRIPT_TOTAL_MAX_BYTES, transcriptLineMax = TRANSCRIPT_LINE_MAX }) {
  const problems = []
  const notes = []
  let rootReal
  try {
    rootReal = realpathSync(root)
    if (!lstatSync(rootReal).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new AuditError(`cannot read the prompts folder: ${root}`)
  }
  let entries
  try {
    entries = list(rootReal)
  } catch (e) {
    throw new AuditError(`cannot list the prompts folder: ${e.code ?? e.message}`)
  }
  const { rows, files: ledgerFiles } = readLedger(rootReal, entries, problems, notes)
  const questions = readQuestions(rootReal, entries, since, problems)
  const inRange = (ms) => since === undefined || ms >= since

  // Group by request id.
  const byId = new Map()
  for (const r of rows) {
    if (r.id === undefined) continue
    let g = byId.get(r.id)
    if (!g) byId.set(r.id, (g = { id: r.id, rows: [], requested: [], answered: [], escalated: [], returned: [], dropped: [], relayed: [], relayLost: [], ends: [] }))
    g.rows.push(r)
    if (r.kind === 'requested') g.requested.push(r)
    else if (r.kind === 'answered') g.answered.push(r)
    else if (r.kind === 'escalated') g.escalated.push(r)
    else if (r.kind === 'returned') g.returned.push(r)
    else if (r.kind === 'dropped') g.dropped.push(r)
    else if (r.kind === 'relayed') g.relayed.push(r)
    else if (r.kind === 'relay-lost') g.relayLost.push(r)
    if (ENDS.has(r.kind)) g.ends.push(r)
  }
  const groups = [...byId.values()].filter((g) => inRange(g.rows[0].ms))
  const anomalies = []
  const flag = (rule, code, detail, extra = {}) => anomalies.push({ rule, code, detail, ...extra })
  const lostRaces = []
  const abandoned = []
  const dropsFine = []
  const table = []
  const waits = []

  for (const g of groups) {
    const req = g.requested[0]
    const ret = g.returned[0]
    const ans = g.answered[g.answered.length - 1]
    const esc = g.escalated[g.escalated.length - 1]
    const first = g.rows[0]
    const meta = req ?? ans ?? ret ?? first
    const end = ret ?? g.ends.find((r) => r.kind !== 'abandoned') ?? g.ends[g.ends.length - 1]
    const outcome = end ? (end.kind === 'abandoned' ? `abandoned ${end.code ?? ''}`.trim() : end.kind) : 'open'
    const decision = ret ? (ret.code ?? '-') : ans ? `answered:${ans.code ?? '-'}` : esc ? 'escalated' : '-'
    const age = ret && req ? (ret.ms - req.ms) / 1000 : undefined
    table.push({
      t: (req ?? first).t,
      id: g.id,
      lane: meta.lane ?? '',
      tool: meta.tool ?? '',
      pattern: meta.pattern ?? '',
      hash8: (meta.hash ?? '').slice(0, 8),
      tier: ret?.tier ?? ans?.tier ?? req?.tier ?? esc?.tier ?? '',
      decision,
      why: ret?.why ?? ans?.why ?? esc?.why ?? '',
      age,
      outcome,
    })
    if (age !== undefined && age >= 0) waits.push({ tier: ret.tier ?? req.tier ?? '', tool: meta.tool ?? '', age })

    // a. a decision with no log row, and decisions the hook refused as forged.
    if (g.requested.length > 1 && new Set(g.requested.map((r) => r.nonce)).size > 1) flag('a', 'requested-twice', `request ${g.id} has ${g.requested.length} requested rows with different nonces`, { id: g.id })
    if (ret && g.answered.length === 0) flag('a', 'returned-without-answered', `request ${g.id} was returned (${ret.code ?? '?'}) with no answered row`, { id: g.id, t: ret.t })
    if (ret && g.answered.length > 0 && g.answered[0].ms > ret.ms) flag('a', 'answered-after-returned', `request ${g.id}: the answered row (${g.answered[0].t}) is later than the returned row (${ret.t})`, { id: g.id, t: ret.t })
    // What the hook returned must be what the tier answered: the same decision, by the same lead (each checked only when both rows carry it).
    if (ret && g.answered.length > 0) {
      const before = g.answered.filter((r) => r.ms <= ret.ms)
      const ref = (before.length > 0 ? before : g.answered)[(before.length > 0 ? before : g.answered).length - 1]
      if (ret.code !== undefined && ref.code !== undefined && ret.code !== ref.code) flag('a', 'returned-differs-from-answered', `request ${g.id}: returned ${ret.code} but the answered row says ${ref.code}`, { id: g.id, t: ret.t })
      else if (ret.by !== undefined && ref.by !== undefined && ret.by !== ref.by) flag('a', 'returned-differs-from-answered', `request ${g.id}: the returned row's author differs from the answered row's`, { id: g.id, t: ret.t })
    }
    for (const a of g.answered) {
      if (!req) flag('a', 'answered-without-requested', `request ${g.id} has an answered row and no requested row`, { id: g.id, t: a.t })
      else if (a.nonce !== req.nonce) flag('a', 'answered-nonce-mismatch', `request ${g.id}: the answered row's nonce differs from the requested row's`, { id: g.id, t: a.t })
    }
    for (const d of g.dropped) {
      if (DROP_ANOMALY.has(d.code)) flag('a', `dropped-${d.code}`, `request ${g.id}: the hook refused a decision (${d.code})`, { id: g.id, t: d.t })
    }
    // Tiers (PR 3). A tier that passed the request up (an `escalated` row, code = its level) does not answer it afterwards; a request taken to the person (`relayed`) is decided by the person, and
    // an agent's answer after it counts only if a relay-lost row came first (the relay never reached the person, so the tiers had it again).
    for (const a of g.answered) {
      if (a.via === 'person') continue
      const passed = g.escalated.find((e) => e.code !== undefined && e.code === a.tier && e.ms < a.ms)
      if (passed) flag('a', 'answered-after-own-pass-up', `request ${g.id}: tier ${a.tier} answered at ${a.t} after it had passed the request up at ${passed.t}`, { id: g.id, t: a.t })
      const rel = g.relayed.find((r) => r.ms < a.ms)
      if (rel && !g.relayLost.some((l) => l.ms > rel.ms && l.ms <= a.ms)) flag('a', 'answered-while-relayed', `request ${g.id}: an agent answered at ${a.t} while the request was with the person (relayed at ${rel.t}, no relay-lost row)`, { id: g.id, t: a.t })
    }
    for (const r of g.ends.filter((x) => x.kind === 'returned')) {
      if (r.via === 'person') continue
      const rel = g.relayed.find((x) => x.ms < r.ms)
      if (rel && !g.relayLost.some((l) => l.ms > rel.ms && l.ms <= r.ms)) flag('a', 'returned-while-relayed', `request ${g.id}: a decision not the person's was returned at ${r.t} while the request was with the person (relayed at ${rel.t}, no relay-lost row)`, { id: g.id, t: r.t })
    }
    // b. a request nothing ended, older than 24 h. Restarts and failed hooks write `abandoned`, which ends it.
    if (req && g.ends.length === 0 && now - req.ms > DAY_MS) flag('b', 'request-unended', `request ${g.id} (${req.tool ?? '?'}) has no ending row after ${Math.floor((now - req.ms) / 3600000)} h`, { id: g.id, t: req.t })
    // The two benign shapes.
    if (g.ends.some((r) => r.kind === 'abandoned')) for (const r of g.ends.filter((x) => x.kind === 'abandoned')) abandoned.push({ id: g.id, t: r.t, code: r.code ?? '', tool: meta.tool ?? '' })
    if (ret && g.ends.some((r) => r.kind === 'superseded')) lostRaces.push({ id: g.id, t: ret.t, via: 'ledger', detail: 'a returned row and a superseded row for one request' })
    for (const d of g.dropped) if (!DROP_ANOMALY.has(d.code)) dropsFine.push({ id: g.id, t: d.t, code: d.code ?? '' })
  }
  // `abandoned` rows that carry no id (a hook that failed before it had one) are counted, not listed per request.
  const abandonedNoId = rows.filter((r) => r.kind === 'abandoned' && r.id === undefined && inRange(r.ms))
  for (const r of abandonedNoId) abandoned.push({ id: '', t: r.t, code: r.code ?? '', tool: r.tool ?? '' })

  // d. the floor.
  let floorCtxUnknown = 0
  const floorRows = rows.filter((r) => r.kind === 'floor' && r.hash !== undefined && r.tool !== undefined)
  for (const g of groups) {
    const probe = g.rows.find((r) => (r.kind === 'requested' || r.kind === 'answered' || r.kind === 'returned') && r.tool !== undefined)
    if (!probe) continue
    const touched = g.requested.length > 0 || g.answered.length > 0
    if (!touched) continue
    const hit = probe.hash !== undefined ? floorRows.find((f) => f.tool === probe.tool && f.hash === probe.hash && Math.abs(f.ms - probe.ms) <= DAY_MS) : undefined
    // The floor reads the branch, the push config and the folder as well as the input: the same input is floored under one and asked under another. Both rows
    // record a hash of that context; the same input in the same context is the anomaly. A row without one (written before it was recorded) is only a note.
    if (hit && hit.ctx !== undefined && probe.ctx !== undefined) {
      if (hit.ctx === probe.ctx) flag('d', 'floor-row-then-asked', `request ${g.id} (${probe.tool}) shares its tool, input hash and floor context with a floor row (${hit.code ?? '?'}) within 24 h`, { id: g.id, t: probe.t })
    } else if (hit) floorCtxUnknown++
    const shape = floorShape(probe.tool, probe.pattern ?? '')
    if (shape) flag('d', 'floor-shape-asked', `request ${g.id} was asked of an agent but looks like a floor item (${shape})`, { id: g.id, t: probe.t })
  }

  if (floorCtxUnknown > 0) notes.push(`${floorCtxUnknown} request(s) share a tool and input hash with a floor row that recorded no floor context; not counted as anomalies (the branch or config may differ)`)

  // e. answering must have been turned on before the first request.
  const firstOn = rows.find((r) => r.kind === 'answering-on')
  for (const g of groups) {
    const req = g.requested[0]
    if (req && (!firstOn || req.ms < firstOn.ms)) flag('e', 'requested-before-answering-on', `request ${g.id} was asked ${firstOn ? 'before the first' : 'with no'} answering-on row`, { id: g.id, t: req.t })
  }

  // f. request files older than 24 h, by age only (the live-session test is not applied here).
  let requestFiles = 0
  const requestIds = new Set()
  let sessionDirs = 0
  let unlisted = 0
  for (const d of entries) {
    if (!d.isDirectory() || !ID_RE.test(d.name)) continue
    sessionDirs++
    let inner
    try {
      inner = list(join(rootReal, d.name))
    } catch {
      unlisted++
      continue
    }
    for (const f of inner) {
      if (!f.isFile() || !/^[0-9a-f-]{36}\.request\.json$/.test(f.name)) continue
      let st
      try {
        st = lstatSync(join(rootReal, d.name, f.name))
      } catch {
        continue
      }
      requestFiles++
      requestIds.add(f.name.slice(0, 36))
      if (st.isFile() && now - st.mtimeMs > DAY_MS) flag('f', 'stale-request-file', `${d.name}/${f.name} is ${Math.floor((now - st.mtimeMs) / 3600000)} h old`, { id: f.name.slice(0, 36) })
    }
  }

  // b2. a request with no ending row whose request file is gone: the hook (or a sweep) removed the files without a closing row. The mod writes the row first and keeps the
  // files until it has, so this is a fault. Only judged when the folder holds session folders at all: a copy of the ledger alone shows no files, and absence says nothing there.
  // A folder that could not be listed hides its request files: the check is not run then, and the run says so.
  if (unlisted > 0) problems.push(`${unlisted} session folder(s) under the prompts folder could not be listed; requests closed without a row were not checked`)
  if (sessionDirs > 0 && unlisted === 0) {
    for (const g of groups) {
      const req = g.requested[0]
      if (req && g.ends.length === 0 && !requestIds.has(g.id) && now - req.ms > CLOSE_GRACE_MS && now - req.ms <= DAY_MS) {
        flag('b', 'request-closed-without-row', `request ${g.id} (${req.tool ?? '?'}) has no ending row and no request file ${Math.floor((now - req.ms) / 60000)} min on`, { id: g.id, t: req.t })
        const row = table.find((t) => t.id === g.id)
        if (row && row.outcome === 'open') row.outcome = 'closed-no-row'
      }
    }
  }

  // c. hook-sourced decisions in lane transcripts. Matching is one to one and decision-aware: a transcript allow is backed only by a
  // `returned allow` row (a deny only by a `returned deny`), and each `returned` row backs at most one hook decision.
  //  - A returned row with `tuid` backs the decision whose tool_use_id equals it exactly (no time window).
  //  - A returned row without `tuid` (an older ledger) backs the nearest decision within 10 minutes with the same tool (the tool named by
  //    the tool_use block of the same tool_use_id in the same file; when that block is not seen, any tool). The ledger holds no session id.
  // Decisions are taken in time order, so the result does not depend on file order.
  let tx = { decisions: [], scanned: 0, filesFound: 0, answerCalls: new Map(), relayAsks: new Map(), relayQs: [], sessions: new Set() }
  let txRan = false
  if (projects !== undefined) {
    try {
      // The folder may itself be a link (a dotfiles setup): its real path is what is checked and read, as for the prompts root.
      const projectsReal = realpathSync(projects)
      if (!lstatSync(projectsReal).isDirectory()) throw new Error('not a directory')
      tx = scanTranscripts(projectsReal, since, notes, problems, transcriptBudget, transcriptLineMax)
      txRan = true
    } catch {
      // A folder named with --projects that cannot be read is a problem (rule c did not run); the default folder may simply not exist.
      if (projectsExplicit) problems.push(`--projects ${projects}: not a readable folder; rule c was not checked`)
      else notes.push(`transcripts: ${projects} is not a readable folder; rule c was not checked`)
    }
  }
  tx.decisions.sort((x, y) => x.ms - y.ms || (x.file < y.file ? -1 : x.file > y.file ? 1 : 0) || x.line - y.line)
  const returnedRows = rows.filter((r) => r.kind === 'returned')
  const used = new Set()
  const backing = (d, want, consume) => {
    const codeOk = (r) => want === undefined || r.code === want
    let hit
    if (d.toolUseId !== undefined) hit = returnedRows.find((r) => r.tuid === d.toolUseId && !used.has(r) && codeOk(r))
    if (!hit) {
      let best
      for (const r of returnedRows) {
        if (r.tuid !== undefined || used.has(r) || !codeOk(r) || Math.abs(r.ms - d.ms) > WINDOW_MS || (d.tool !== undefined && r.tool !== d.tool)) continue
        if (!best || Math.abs(r.ms - d.ms) < Math.abs(best.ms - d.ms)) best = r
      }
      hit = best
    }
    if (hit && consume) used.add(hit)
    return hit
  }
  let hookBacked = 0
  let hookAllowOther = 0
  const hookDenies = []
  for (const d of tx.decisions) {
    const allow = d.decision === 'accept' || d.decision === 'allow'
    if (d.source === 'hook') {
      // Only a PermissionRequest hook can be callboard's: the engine writes an attachment line (hookEvent PermissionRequest) with the
      // same tool_use id for it, and a reasonCode naming PermissionRequest on its denies. A hook allow with neither came from another
      // hook event (in practice a PreToolUse guard) and is counted, not flagged.
      const permReq = d.permissionRequest === true || /PermissionRequest/.test(d.reasonCode)
      if (allow && !permReq) {
        hookAllowOther++
        continue
      }
      const b = backing(d, allow ? 'allow' : 'deny', true)
      if (b) hookBacked++
      else if (allow) flag('c', 'hook-decision-unmatched', `transcript ${d.file}:${d.line} (${d.tool ?? 'tool unknown'}${d.toolUseId ? `, ${d.toolUseId}` : ''}) holds a hook-sourced ${d.decision} at ${new Date(d.ms).toISOString()} with no unused returned allow row (by tool_use_id, or by tool within 10 minutes)`, { t: new Date(d.ms).toISOString(), file: d.file, line: d.line })
      else hookDenies.push({ file: d.file, line: d.line, t: new Date(d.ms).toISOString(), tool: d.tool ?? '' })
    } else if (d.source.startsWith('user')) {
      // A lost race: the person's click won while the ledger returned a decision. It consumes nothing, since no hook decision stands in the transcript.
      const b = backing(d, undefined, false)
      if (b && d.source === 'user_temporary') lostRaces.push({ id: b.id ?? '', t: new Date(d.ms).toISOString(), via: 'transcript', detail: `${d.file}:${d.line}: ${d.source} while the ledger returned a decision at ${b.t}` })
    }
  }

  // c2. a lead's answer must be a real call: for each answered row, the answering lead's own transcript holds a prompt_answer call for that request id. This is what shows a
  // decision file and an answered row written by hand (PLAN 8.7). Its bound: someone who also writes that call into the lead's transcript passes, as does one who
  // writes both with the lead's own tool; it is a check against a forged row, not against a forger who can rewrite files the lead's session owns.
  if (txRan) {
    const missingLead = new Set()
    for (const g of groups) {
      for (const a of g.answered) {
        if (a.by === undefined || a.id === undefined) continue
        if (!tx.sessions.has(a.by)) {
          missingLead.add(a.by)
          continue
        }
        // The person's own answer (via person) is not a prompt_answer call: the relaying tier's transcript must hold the `Relay <short>` question, answered Yes (allow) or No (deny).
        if (a.via === 'person') {
          // The short id is the request's own (its first eight characters), never the row's say-so.
          const short = a.id.slice(0, 8)
          if (a.short !== undefined && a.short !== short) flag('c', 'person-answer-short-mismatch', `request ${g.id}: the answered row (${a.t}) carries the short id ${a.short}, not the request's ${short}`, { id: g.id, t: a.t })
          const rel = g.relayed.find((x) => x.ms <= a.ms)
          if (!rel || rel.by !== a.by || (rel.short ?? short) !== short) flag('c', 'person-answer-without-relayed-row', `request ${g.id}: the answered row (${a.t}) is the person's, but no relayed row of tier session ${a.by} with that short id came before it`, { id: g.id, t: a.t })
          const labels = tx.relayAsks.get(a.by)?.get(short)
          const want = a.code === 'allow' ? 'Yes' : a.code === 'deny' ? 'No' : undefined
          if (!labels || want === undefined || !labels.includes(want)) flag('c', 'person-answer-without-relay-question', `request ${g.id}: the answered row (${a.t}) is the person's ${a.code ?? '?'} through tier session ${a.by}, whose transcript holds no "Relay ${short}" question answered ${want ?? '?'}`, { id: g.id, t: a.t })
          continue
        }
        if (!tx.answerCalls.get(a.by)?.has(a.id)) flag('c', 'answered-without-prompt-answer', `request ${g.id}: the answered row (${a.t}) names lead session ${a.by}, whose transcript holds no prompt_answer call for it`, { id: g.id, t: a.t })
      }
    }
    for (const sidMissing of missingLead) problems.push(`transcripts: the transcript of lead session ${sidMissing} was not found, so its answered rows were not checked against a prompt_answer call`)
  }

  anomalies.sort((x, y) => (x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : 0))

  // Counts.
  const group = (key) => {
    const m = new Map()
    for (const t of table) {
      const k = t[key] || '(none)'
      if (!m.has(k)) m.set(k, { requests: 0, outcomes: {} })
      const e = m.get(k)
      e.requests++
      const o = t.outcome.split(' ')[0]
      e.outcomes[o] = (e.outcomes[o] ?? 0) + 1
    }
    const out = {}
    for (const [k, e] of [...m.entries()].sort()) {
      const w = waits.filter((x) => (x[key] || '(none)') === k).map((x) => x.age)
      out[k] = { ...e, wait: waitStats(w) }
    }
    return out
  }
  const kinds = {}
  for (const r of rows) if (inRange(r.ms)) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1

  // The tier rows that are not anomalies, counted by kind (and by code where one is recorded): what happened to the requests that went to the person, and the cleaner-command denies.
  const relayCounts = {}
  for (const k of ['relayed', 'relay-lost', 'relay-left', 'relay-late', 'expired-denied', 'deny-unclear']) {
    const mine = rows.filter((r) => r.kind === k && inRange(r.ms))
    const codes = {}
    for (const r of mine) codes[r.code ?? '(none)'] = (codes[r.code ?? '(none)'] ?? 0) + 1
    relayCounts[k] = { n: mine.length, codes }
  }
  // Each relayed request with the question as the tier put it to the person, from the tier's own transcript, beside the request's tool and pattern: the one place a tier's
  // wrong summary can be seen after the fact. Needs the tier's transcript (rule c); without it the question reads "(transcript not read)".
  const relayedList = []
  for (const g of groups) {
    for (const r of g.relayed) {
      if (!inRange(r.ms) || relayedList.length >= LIST_MAX) continue
      const short = g.id.slice(0, 8)
      const qs = tx.relayQs.filter((x) => x.sid === r.by && x.short === short)
      const req = g.requested[0] ?? g.rows[0]
      relayedList.push({ id: g.id, t: r.t, tier: r.code ?? '', tool: req.tool ?? '', pattern: req.pattern ?? '', questions: qs.length > 0 ? qs.map((x) => ({ question: x.question.slice(0, 400), answer: x.label ?? '(none)' })) : [{ question: '(transcript not read)', answer: '' }] })
    }
  }
  const personAnswers = rows.filter((r) => r.kind === 'answered' && r.via === 'person' && inRange(r.ms)).length
  relayCounts.personAnswers = { n: personAnswers, codes: {} }

  return {
    root: rootReal,
    since: since === undefined ? null : new Date(since).toISOString(),
    scanned: { ledgerFiles, rows: rows.length, requests: table.length, transcriptFiles: tx.scanned, transcriptDecisions: tx.decisions.length, requestFiles },
    table,
    anomalies,
    notAnomalies: {
      lostRaces: lostRaces.slice(0, LIST_MAX),
      abandoned: abandoned.slice(0, LIST_MAX),
      dropped: dropsFine.slice(0, LIST_MAX),
      relay: relayCounts,
      relayedQuestions: relayedList,
      hookDeniesWithoutRow: hookDenies.length,
      hookDecisionsBacked: hookBacked,
      hookAllowsOtherEvent: hookAllowOther,
    },
    counts: { byTier: group('tier'), byTool: group('tool'), rowsByKind: kinds, wait: waitStats(waits.map((w) => w.age)) },
    questions,
    problems,
    notes,
  }
}

// ---- output ----
// C0 and C1 controls, DEL, the line and paragraph separators and the bidi controls, shown as \uXXXX so the text stays readable and inert.
const CONTROLS_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
export const escapeControls = (s) => String(s).replace(CONTROLS_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}~` : s)
const sec = (v) => (v === undefined ? '-' : v < 100 ? v.toFixed(1) : Math.round(v).toString())
function pad(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd())
}
export function render(rep) {
  const out = []
  out.push(`prompt audit: ${rep.root}${rep.since ? `, since ${rep.since}` : ''}`)
  const s = rep.scanned
  out.push(`ledger files ${s.ledgerFiles}, rows ${s.rows}, requests ${s.requests}; transcript files ${s.transcriptFiles}, hook/user decisions seen ${s.transcriptDecisions}; request files ${s.requestFiles}`)
  out.push('', 'REQUESTS')
  if (rep.table.length === 0) out.push('(none)')
  else {
    const head = ['time', 'lane', 'tool', 'pattern', 'hash8', 'tier', 'decision', 'why', 'age s', 'outcome']
    out.push(...pad([head, ...rep.table.map((t) => [t.t.replace(/\.\d+Z$/, 'Z'), cut(t.lane, 14), cut(t.tool, 28), cut(t.pattern, 28), t.hash8, t.tier, t.decision, cut(t.why.replace(/\s+/g, ' '), 40), sec(t.age), t.outcome])]))
  }
  out.push('', 'ANOMALIES (must be empty)')
  // "none" is said only when nothing was missed: a skipped file or an unread folder makes the audit incomplete, and it must say so here.
  if (rep.problems.length > 0) out.push(`INCOMPLETE: ${rep.problems.length} problem(s), the audit did not see everything`)
  else if (rep.anomalies.length === 0) out.push('none')
  for (const a of rep.anomalies) out.push(`${a.rule} ${a.code}: ${a.detail}`)
  const n = rep.notAnomalies
  out.push('', 'NOT ANOMALIES')
  out.push(`lost races: ${n.lostRaces.length}`)
  for (const r of n.lostRaces) out.push(`  ${r.t} ${r.id} (${r.via}) ${r.detail}`)
  out.push(`abandoned: ${n.abandoned.length}`)
  const byCode = {}
  for (const r of n.abandoned) byCode[r.code || '(none)'] = (byCode[r.code || '(none)'] ?? 0) + 1
  for (const [c, k] of Object.entries(byCode).sort()) out.push(`  ${c}: ${k}`)
  out.push(`dropped, ordinary: ${n.dropped.length}`)
  const dc = {}
  for (const r of n.dropped) dc[r.code || '(none)'] = (dc[r.code || '(none)'] ?? 0) + 1
  for (const [c, k] of Object.entries(dc).sort()) out.push(`  ${c}: ${k}`)
  for (const [k, v] of Object.entries(n.relay)) out.push(`${k === 'personAnswers' ? 'answered by the person (relay)' : k}: ${v.n}${Object.keys(v.codes).length > 0 ? ` (${Object.entries(v.codes).sort().map(([c, m]) => `${c} ${m}`).join(', ')})` : ''}`)
  if (n.relayedQuestions.length > 0) {
    out.push('', 'RELAYED QUESTIONS (as the tier put them to the person; read them: a tier\'s summary is its own)')
    for (const r of n.relayedQuestions) {
      out.push(`  ${r.t} ${r.id.slice(0, 8)} ${r.tier} ${r.tool} ${r.pattern}`)
      for (const x of r.questions) out.push(`    ${x.question.replace(/\s+/g, ' ')}${x.answer ? ` -> ${x.answer}` : ''}`)
    }
    out.push('')
  }
  out.push(`hook decisions in transcripts backed by a returned row: ${n.hookDecisionsBacked}`)
  out.push(`hook allows with no PermissionRequest record, not callboard's (see the header, rule c): ${n.hookAllowsOtherEvent}`)
  out.push(`hook denies in transcripts with no returned row (a deny grants nothing): ${n.hookDeniesWithoutRow}`)
  out.push('', 'COUNTS (wait = seconds from request to decision, returned rows)')
  const c = rep.counts
  out.push(`all: n ${c.wait.n}, median ${sec(c.wait.median)}, p90 ${sec(c.wait.p90)}`)
  for (const [title, m] of [['tier', c.byTier], ['tool', c.byTool]]) {
    const rows = [[title, 'requests', 'outcomes', 'n', 'median', 'p90']]
    for (const [k, e] of Object.entries(m)) rows.push([cut(k, 40), String(e.requests), Object.entries(e.outcomes).map(([o, v]) => `${o} ${v}`).join(', '), String(e.wait.n), sec(e.wait.median), sec(e.wait.p90)])
    if (rows.length > 1) out.push(...pad(rows))
  }
  out.push(`rows by kind: ${Object.entries(c.rowsByKind).sort().map(([k, v]) => `${k} ${v}`).join(', ') || '(none)'}`)
  if (rep.questions.files > 0 || rep.questions.count > 0) {
    out.push('', `QUESTIONS: ${rep.questions.count} row(s) in ${rep.questions.files} file(s) (raw, truncated)`)
    for (const r of rep.questions.rows) out.push(`  ${r}`)
  }
  if (rep.problems.length > 0) out.push('', 'PROBLEMS (the audit is incomplete)', ...rep.problems.map((p) => `  ${p}`))
  if (rep.notes.length > 0) out.push('', 'NOTES', ...rep.notes.map((p) => `  ${p}`))
  // Every line is escaped as a whole, so no value from a ledger row, a transcript, a file name or a path can carry a control character.
  return `${out.map(escapeControls).join('\n')}\n`
}

// ---- command line ----
const USAGE = 'usage: prompt-audit.mjs [--since DATE] [--root DIR] [--projects DIR] [--json]'
export function parseArgs(argv, env = process.env) {
  const cfg = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude')
  const o = { root: join(cfg, 'callboard', 'prompts'), projects: join(cfg, 'projects'), since: undefined, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new AuditError(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--json') o.json = true
    else if (a === '--root') o.root = val()
    else if (a === '--projects') {
      o.projects = val()
      o.projectsExplicit = true
    }
    else if (a === '--since') {
      const v = val()
      const ms = Date.parse(v)
      if (!Number.isFinite(ms)) throw new AuditError(`bad --since date: ${v}`)
      o.since = ms
    } else throw new AuditError(`unknown argument: ${a}`)
  }
  return o
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const o = parseArgs(process.argv.slice(2))
    const rep = audit(o)
    process.stdout.write(o.json ? `${JSON.stringify(rep, null, 2)}\n` : render(rep))
    process.exitCode = rep.anomalies.length > 0 ? 1 : rep.problems.length > 0 ? 2 : 0
  } catch (e) {
    if (!(e instanceof AuditError)) throw e
    console.error(`prompt audit: ${escapeControls(e.message)}`)
    console.error(USAGE)
    process.exitCode = 2
  }
}
