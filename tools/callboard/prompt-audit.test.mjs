import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, lstatSync, readFileSync, utimesSync, truncateSync, rmSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audit, render, eachLine, labelFromText, percentile, LEDGER_MAX_BYTES } from './prompt-audit.mjs'

const SCRIPT = new URL('./prompt-audit.mjs', import.meta.url).pathname
const H = (c) => c.repeat(64)
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SID = '0a1b2c3d-0000-4000-8000-123456789abc'
const NOW = Date.now()
const BASE = NOW - 3600_000
const iso = (ms) => new Date(ms).toISOString()
const month = (ms) => iso(ms).slice(0, 7)

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'pa-'))
  const root = join(d, 'prompts')
  const projects = join(d, 'projects')
  mkdirSync(root)
  mkdirSync(projects)
  return { d, root, projects }
}
const R = (kind, at, f = {}) => ({ t: iso(at), kind, ...f })
const lines = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
function ledger(fx, rows, ms = BASE) {
  writeFileSync(join(fx.root, `ledger-${month(ms)}.jsonl`), lines(rows))
}
const T = { lane: 'api', repo: '/Users/x/api', tool: 'mcp__github__add_issue_comment', pattern: 'mcp__github__add_issue_comment x/y #3', hash: H('a') }
// A whole, ordinary request: on, requested, answered, returned.
function clean(id = uid(1), at = BASE, nonce = uid(101), extra = {}) {
  return [
    R('requested', at, { ...T, id, nonce, tier: 'lead', ...extra }),
    R('answered', at + 40_000, { ...T, id, nonce, tier: 'lead', why: 'reads only', code: 'allow', ...extra }),
    R('returned', at + 45_000, { ...T, id, code: 'allow', tier: 'lead', why: 'reads only', ...extra }),
  ]
}
const ON = (at = BASE - 60_000) => R('answering-on', at, { hash: H('9') })
const run = (fx, extra = {}) => audit({ root: fx.root, projects: fx.projects, now: NOW, ...extra })
const rules = (rep) => rep.anomalies.map((a) => a.code).sort()

// A transcript with one tool_use and its result line carrying the decision, in the shape Claude Code writes it.
// `permReq` writes the attachment line the engine adds for a PermissionRequest hook's decision (before or after the result line).
function transcript(fx, name, { at, source = 'hook', decision = 'accept', tool = 'mcp__github__add_issue_comment', nested = false, useId = 'toolu_01', permReq = source === 'hook', attAfter = false, attEvent = 'PermissionRequest', reasonCode, pdExtra = {} }) {
  const dir = join(fx.projects, '-Users-x-api')
  mkdirSync(dir, { recursive: true })
  const use = { type: 'assistant', sessionId: SID, timestamp: iso(at - 1000), message: { content: [{ type: 'tool_use', id: useId, name: tool, input: {} }] } }
  const pd = { decision, source, reasonType: 'hook', ...(reasonCode ? { reasonCode } : {}), ...pdExtra }
  const res = nested
    ? { type: 'user', sessionId: SID, timestamp: iso(at), message: { content: [{ type: 'tool_result', tool_use_id: useId }] }, toolUseResult: { permissionDecision: pd } }
    : { type: 'user', sessionId: SID, timestamp: iso(at), message: { content: [{ type: 'tool_result', tool_use_id: useId }] }, permissionDecision: pd }
  const att = { type: 'attachment', sessionId: SID, timestamp: iso(at), attachment: { type: 'hook_permission_decision', decision: decision === 'accept' ? 'allow' : 'deny', hookEvent: attEvent, toolUseID: useId } }
  writeFileSync(join(dir, `${name}.jsonl`), lines(permReq ? (attAfter ? [use, res, att] : [use, att, res]) : [use, res]))
}
const snapshot = (dir) => {
  const out = []
  const walk = (p) => {
    const st = lstatSync(p)
    out.push(`${p} ${st.mtimeMs} ${st.size} ${st.mode}`)
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n))
  }
  walk(dir)
  return out
}

test('a clean ledger has no anomalies, one table row and the right wait', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.table.length, 1)
  const t = rep.table[0]
  assert.equal(t.outcome, 'returned')
  assert.equal(t.decision, 'allow')
  assert.equal(t.age, 45)
  assert.equal(t.hash8, 'aaaaaaaa')
  assert.equal(t.tier, 'lead')
  assert.equal(t.lane, 'api')
  assert.match(render(rep), /ANOMALIES \(must be empty\)\nnone/)
})

test('lead-offer and lead-offer-void rows are read, counted by kind, and are no anomaly beside an ordinary request', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), R('lead-offer', BASE + 1000, { hash: H('c'), repo: '/Users/x/api', lane: 'LEAD-A', nonce: '0123456789abcdef0123456789abcdef', by: SID }), R('lead-offer-void', BASE + 2000, { hash: H('c'), nonce: '0123456789abcdef0123456789abcdef', code: 'panel-only' })])
  const rep = run(fx)
  assert.deepEqual(rules(rep), [])
  assert.equal(rep.counts.rowsByKind['lead-offer'], 1)
  assert.equal(rep.counts.rowsByKind['lead-offer-void'], 1)
})

test('a: a returned row with no answered row is an anomaly', () => {
  const fx = fixture()
  const rows = clean().filter((r) => r.kind !== 'answered')
  ledger(fx, [ON(), ...rows])
  assert.deepEqual(rules(run(fx)), ['returned-without-answered'])
})

test('a: an answered row whose nonce differs from the requested row is an anomaly', () => {
  const fx = fixture()
  const rows = clean()
  rows[1].nonce = uid(999)
  ledger(fx, [ON(), ...rows])
  assert.deepEqual(rules(run(fx)), ['answered-nonce-mismatch'])
})

test('a: an answered row with no requested row, and one later than the return, are anomalies', () => {
  const fx = fixture()
  const noReq = clean(uid(1)).filter((r) => r.kind !== 'requested')
  const late = clean(uid(2), BASE + 100_000, uid(102))
  late[1].t = iso(BASE + 100_000 + 60_000)
  ledger(fx, [ON(), ...noReq, ...late])
  assert.deepEqual(rules(run(fx)), ['answered-after-returned', 'answered-without-requested'])
})

test('a: dropped rows with a forgery code are anomalies, the ordinary codes are not', () => {
  const fx = fixture()
  const bad = ['no-answered-row', 'id', 'hash', 'nonce', 'by-sid', 'kind', 'answer']
  const fine = ['expired', 'ledger-unreadable', 'file', 'shape', 'dialog']
  const rows = [ON()]
  bad.forEach((code, i) => rows.push(R('requested', BASE + i, { ...T, id: uid(10 + i), nonce: uid(110 + i), tier: 'lead' }), R('dropped', BASE + 1000 + i, { ...T, id: uid(10 + i), code }), R('abandoned', BASE + 2000 + i, { id: uid(10 + i), code: 'swept' })))
  fine.forEach((code, i) => rows.push(R('requested', BASE + i, { ...T, id: uid(30 + i), nonce: uid(130 + i), tier: 'lead' }), R('dropped', BASE + 1000 + i, { ...T, id: uid(30 + i), code }), R('abandoned', BASE + 2000 + i, { id: uid(30 + i), code: 'swept' })))
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rules(rep), bad.map((c) => `dropped-${c}`).sort())
  assert.deepEqual(rep.notAnomalies.dropped.map((d) => d.code).sort(), [...fine].sort())
})

test('b: a request nothing ended for over 24 h is an anomaly; a young one and every abandoned code are not', () => {
  const fx = fixture()
  const old = NOW - 30 * 3600_000
  const rows = [ON(old - 60_000), R('requested', old, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }), R('requested', BASE, { ...T, id: uid(2), nonce: uid(102), tier: 'lead' })]
  ledger(fx, rows, BASE)
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['request-unended'])
  assert.equal(rep.anomalies[0].id, uid(1))
  assert.equal(rep.table.find((t) => t.id === uid(2)).outcome, 'open')
})

test('restarts and failed hooks are abandoned rows, never anomalies', () => {
  const fx = fixture()
  const old = NOW - 30 * 3600_000
  const rows = [ON(old - 60_000)]
  ;['session-gone', 'hook-failed', 'swept'].forEach((code, i) => rows.push(R('requested', old + i, { ...T, id: uid(50 + i), nonce: uid(150 + i), tier: 'lead' }), R('abandoned', old + 1000 + i, { id: uid(50 + i), code })))
  rows.push(R('abandoned', old + 5000, { code: 'hook-failed' }), R('abandoned', old + 6000, { ...T, code: 'no-tier' }))
  ledger(fx, rows, old)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.table.map((t) => t.outcome).sort(), ['abandoned hook-failed', 'abandoned session-gone', 'abandoned swept'])
  assert.equal(rep.notAnomalies.abandoned.length, 5)
})

test('expired-denied, off and superseded end a request cleanly', () => {
  const fx = fixture()
  const rows = [ON()]
  ;['expired-denied', 'off', 'superseded'].forEach((kind, i) => rows.push(R('requested', BASE + i, { ...T, id: uid(60 + i), nonce: uid(160 + i), tier: 'lead' }), R(kind, BASE + 1000 + i, { ...T, id: uid(60 + i) })))
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.table.map((t) => t.outcome).sort(), ['expired-denied', 'off', 'superseded'])
})

test('c: a hook-sourced allow in a transcript with no returned row in the window is an anomaly', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE + 45_000 + 11 * 60_000 })
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['hook-decision-unmatched'])
  assert.match(rep.anomalies[0].detail, /toolu_01/)
})

test('c: the same decision with a returned row of the same tool within 10 minutes is fine, also when nested', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), ...clean(uid(2), BASE + 1000, uid(102))])
  transcript(fx, SID, { at: BASE + 45_000 + 9 * 60_000 })
  transcript(fx, `${SID}-b`, { at: BASE + 45_000, nested: true, useId: 'toolu_02' })
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notAnomalies.hookDecisionsBacked, 2)
})

test('c: a returned row for another tool does not back the decision', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE + 45_000, tool: 'Bash' })
  assert.deepEqual(rules(run(fx)), ['hook-decision-unmatched'])
})

test('c: user_temporary with a returned row is a lost race, not an anomaly; a hook deny is not an approval', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE + 50_000, source: 'user_temporary' })
  transcript(fx, `${SID}-b`, { at: NOW - 5 * 3600_000, decision: 'reject', useId: 'toolu_03' })
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notAnomalies.lostRaces.length, 1)
  assert.equal(rep.notAnomalies.lostRaces[0].via, 'transcript')
  assert.equal(rep.notAnomalies.hookDeniesWithoutRow, 1)
})

test('lost race in the ledger: a returned row and a superseded row for one request', () => {
  const fx = fixture()
  const rows = [ON(), ...clean(), R('superseded', BASE + 46_000, { ...T, id: uid(1) })]
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notAnomalies.lostRaces.length, 1)
  assert.equal(rep.table[0].outcome, 'returned')
})

test('c: transcripts are read only inside the folder: a symlinked folder is not followed, a line over 1 MB is read like any other', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const outside = mkdtempSync(join(tmpdir(), 'pa-out-'))
  transcript({ projects: outside }, SID, { at: BASE + 20 * 60_000 })
  symlinkSync(join(outside, '-Users-x-api'), join(fx.projects, 'linked'))
  writeFileSync(join(fx.projects, 'big.jsonl'), `${'x'.repeat(1024 * 1024 + 10)}\n${JSON.stringify({ permissionDecision: { source: 'hook', decision: 'accept', reasonCode: 'hook:PermissionRequest' }, tool_use_id: 't', timestamp: iso(BASE + 20 * 60_000) })}\n`)
  const rep = run(fx)
  assert.equal(rep.scanned.transcriptFiles, 1)
  assert.deepEqual(rules(rep), ['hook-decision-unmatched'])
  assert.equal(rep.anomalies[0].file, 'big.jsonl')
  // Live test A, finding 4: a 1 MB line is no longer skipped, so it no longer makes the run INCOMPLETE.
  assert.deepEqual(rep.problems, [])
})
test('finding 4: a line over the cap with no decision text is streamed past and noted; one that holds decision text is a problem', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const dir = join(fx.projects, '-Users-x-api')
  mkdirSync(dir, { recursive: true })
  // The marker sits across a 64 KB chunk border in the second line, and in the middle of the first one never.
  writeFileSync(join(dir, 'a.jsonl'), `${'x'.repeat(300_000)}\n${'y'.repeat(65_530)}permissionDecision${'y'.repeat(300_000)}\n${'z'.repeat(10)}\n`)
  writeFileSync(join(dir, 'b.jsonl'), `${'x'.repeat(300_000)}\n`)
  const rep = run(fx, { transcriptLineMax: 100_000 })
  assert.equal(rep.scanned.transcriptFiles, 2)
  assert.equal(rep.problems.length, 1)
  assert.match(rep.problems[0], /a\.jsonl: 1 line\(s\) over 100000 bytes held permission-decision text/)
  assert.ok(rep.notes.some((n) => /2 line\(s\) over 100000 bytes held no permission-decision text/.test(n)), rep.notes.join('|'))
  assert.match(render(rep), /INCOMPLETE/)
  // Without any marker the run is complete.
  rmSync(join(dir, 'a.jsonl'))
  const rep2 = run(fx, { transcriptLineMax: 100_000 })
  assert.deepEqual(rep2.problems, [])
  assert.match(render(rep2), /ANOMALIES \(must be empty\)\nnone/)
})
test('eachLine: markers are found across chunk borders in a skipped line, and not in one that has none', () => {
  const d = mkdtempSync(join(tmpdir(), 'pa-m-'))
  const p = join(d, 'f.jsonl')
  writeFileSync(p, `${'a'.repeat(65_536 - 5)}needle${'b'.repeat(200_000)}\n${'c'.repeat(200_000)}\nneedle\n`)
  const got = []
  const s = eachLine(p, { maxLine: 100_000, markers: ['needle'] }, (l) => got.push(l))
  assert.deepEqual(got, ['needle'])
  assert.equal(s.skippedLong, 2)
  assert.equal(s.skippedMarked, 1)
  rmSync(d, { recursive: true })
})
test('review r2: a transcripts folder that is itself a symlink to a real folder is read, not skipped', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const real = mkdtempSync(join(tmpdir(), 'pa-real-'))
  transcript({ projects: real }, SID, { at: BASE + 20 * 60_000 })
  const link = join(fx.d, 'projects-link')
  symlinkSync(real, link)
  for (const explicit of [false, true]) {
    const rep = audit({ root: fx.root, projects: link, projectsExplicit: explicit, now: NOW })
    assert.equal(rep.scanned.transcriptFiles, 1, `explicit ${explicit}`)
    assert.deepEqual(rep.problems, [], `explicit ${explicit}`)
    assert.deepEqual(rep.notes.filter((n) => /not a readable folder/.test(n)), [], `explicit ${explicit}`)
  }
})

test('c: a hook allow with no PermissionRequest record is another hook event, counted and not flagged', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE + 20 * 60_000, permReq: false })
  transcript(fx, `${SID}-b`, { at: BASE + 21 * 60_000, useId: 'toolu_02', attEvent: 'PreToolUse' })
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notAnomalies.hookAllowsOtherEvent, 2)
})

test('c: the attachment may follow the result line, and a PermissionRequest reasonCode alone is enough', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE + 20 * 60_000, attAfter: true })
  transcript(fx, `${SID}-b`, { at: BASE + 21 * 60_000, useId: 'toolu_02', permReq: false, reasonCode: 'hook:PermissionRequest' })
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['hook-decision-unmatched', 'hook-decision-unmatched'])
  assert.equal(rep.notAnomalies.hookAllowsOtherEvent, 0)
})

test('c: the attachment of one tool_use id does not vouch for another', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const dir = join(fx.projects, '-Users-x-api')
  mkdirSync(dir, { recursive: true })
  const res = { type: 'user', timestamp: iso(BASE + 20 * 60_000), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A' }] }, permissionDecision: { decision: 'accept', source: 'hook' } }
  const att = { type: 'attachment', timestamp: iso(BASE + 20 * 60_000), attachment: { type: 'hook_permission_decision', decision: 'allow', hookEvent: 'PermissionRequest', toolUseID: 'toolu_B' } }
  writeFileSync(join(dir, 'x.jsonl'), lines([att, res]))
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notAnomalies.hookAllowsOtherEvent, 1)
})

test('c: --since keeps old transcripts out', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE - 3 * 86400_000 })
  assert.equal(run(fx).anomalies.length, 1)
  assert.deepEqual(run(fx, { since: BASE - 3600_000 }).anomalies, [])
})

test('d: a request for a dialog tool is an anomaly; a merge, a settings edit or a machine-ops call is not one', () => {
  const fx = fixture()
  const dialog = clean(uid(1), BASE, uid(101), { tool: 'ExitPlanMode', pattern: 'ExitPlanMode', hash: H('c') })
  const merge = clean(uid(2), BASE + 1000, uid(102), { tool: 'mcp__github__merge_pull_request', pattern: 'mcp__github__merge_pull_request x/y #3', hash: H('d') })
  const settings = clean(uid(3), BASE + 2000, uid(103), { tool: 'Edit', pattern: 'Edit .claude/settings.json', hash: H('e') })
  ledger(fx, [ON(), ...dialog, ...merge, ...settings])
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['dialog-asked'])
  assert.deepEqual(rep.anomalies.map((a) => a.id), [uid(1)])
})
test('d: a dialog row is read and is not an anomaly', () => {
  const fx = fixture()
  ledger(fx, [ON(), R('dialog', BASE - 1000, { ...T, tool: 'ExitPlanMode', pattern: 'ExitPlanMode' }), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
})

test('e: a request with no earlier answering-on row is an anomaly', () => {
  const fx = fixture()
  ledger(fx, clean())
  assert.deepEqual(rules(run(fx)), ['requested-before-answering-on'])
  ledger(fx, [ON(BASE + 10_000), ...clean()])
  assert.deepEqual(rules(run(fx)), ['requested-before-answering-on'])
  ledger(fx, [R('answering-off', BASE - 1000, { code: 'off' }), ON(BASE - 500), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
})

test('e: each request is compared with the latest answering row at its time: a later off makes the on row stale, a later on restores it', () => {
  const fx = fixture()
  // On, then off, then a request raised while it was off: flagged.
  ledger(fx, [ON(BASE - 3000), R('answering-off', BASE - 1000, { code: 'off' }), ...clean()])
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['requested-while-answering-off'])
  assert.match(rep.anomalies[0].detail, /answering was off/)
  // On, off, on again, then the request: fine.
  ledger(fx, [ON(BASE - 3000), R('answering-off', BASE - 2000, { code: 'off' }), ON(BASE - 1000), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
  // The questions row (a plain on followed by the asks row) is on.
  ledger(fx, [ON(BASE - 3000), R('answering-on', BASE - 2900, { code: 'asks' }), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
  // An off that only turned the questions off (an earlier mod's answering-off with code asks) leaves permission answering on.
  ledger(fx, [ON(BASE - 3000), R('answering-off', BASE - 1000, { code: 'asks' }), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
  // An off written in the same millisecond as the request but after it does not count for it; one written before does.
  ledger(fx, [ON(BASE - 3000), ...clean().slice(0, 1), R('answering-off', BASE, { code: 'off' }), ...clean().slice(1)])
  assert.deepEqual(run(fx).anomalies, [])
  ledger(fx, [ON(BASE - 3000), R('answering-off', BASE, { code: 'off' }), ...clean()])
  assert.deepEqual(rules(run(fx)), ['requested-while-answering-off'])
  // Two requests either side of an off are judged separately; a later off does not touch the earlier one.
  const a = clean(uid(1), BASE, uid(101))
  const b = clean(uid(2), BASE + 20_000, uid(102))
  ledger(fx, [ON(BASE - 3000), ...a, R('answering-off', BASE + 10_000, { code: 'off' }), ...b])
  const two = run(fx)
  assert.deepEqual(rules(two), ['requested-while-answering-off'])
  assert.equal(two.anomalies[0].id, uid(2))
})

test('e: an off typed between the hook\'s switch read and its requested row is not flagged when the request ends with an off row; a request raised while off still is', () => {
  const fx = fixture()
  const closedOff = (at) => [R('requested', at, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }), R('off', at + 5_000, { ...T, id: uid(1) })]
  // on, off, requested, off-closing: the race. Not an anomaly.
  ledger(fx, [ON(BASE - 60_000), R('answering-off', BASE - 2_000, { code: 'off' }), ...closedOff(BASE)])
  assert.deepEqual(run(fx).anomalies, [])
  // The same sequence, but the request was answered and returned: it ran while off. Flagged.
  ledger(fx, [ON(BASE - 60_000), R('answering-off', BASE - 2_000, { code: 'off' }), ...clean()])
  assert.deepEqual(rules(run(fx)), ['requested-while-answering-off'])
  // Ends with off, but the off row is long before the request (not the hook's window): flagged.
  ledger(fx, [ON(BASE - 3_600_000), R('answering-off', BASE - 600_000, { code: 'off' }), ...closedOff(BASE)])
  assert.deepEqual(rules(run(fx)), ['requested-while-answering-off'])
  // A request with no closing row at all: flagged.
  ledger(fx, [ON(BASE - 60_000), R('answering-off', BASE - 2_000, { code: 'off' }), closedOff(BASE)[0]])
  assert.deepEqual(rules(run(fx)), ['requested-while-answering-off'])
})

test('f: a request file older than 24 h in a session folder is an anomaly, by age only', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const dir = join(fx.root, SID)
  mkdirSync(dir)
  const stale = join(dir, `${uid(7)}.request.json`)
  const fresh = join(dir, `${uid(8)}.request.json`)
  writeFileSync(stale, '{}')
  writeFileSync(fresh, '{}')
  const old = new Date(NOW - 30 * 3600_000)
  utimesSync(stale, old, old)
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['stale-request-file'])
  assert.match(rep.anomalies[0].detail, new RegExp(uid(7)))
  assert.equal(rep.scanned.requestFiles, 2)
})

test('a month boundary: a request in one month and its decision in the next read as one request', () => {
  const fx = fixture()
  const t0 = Date.parse('2026-10-31T23:59:40.000Z')
  writeFileSync(join(fx.root, 'ledger-2026-10.jsonl'), lines([R('answering-on', t0 - 60_000, { hash: H('9') }), clean(uid(1), t0)[0], clean(uid(1), t0)[1]]))
  writeFileSync(join(fx.root, 'ledger-2026-11.jsonl'), lines([clean(uid(1), t0)[2]]))
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.scanned.ledgerFiles, 2)
  assert.equal(rep.table.length, 1)
  assert.equal(rep.table[0].outcome, 'returned')
  assert.equal(rep.table[0].age, 45)
})

test('garbage lines are tolerated, counted and never crash', () => {
  const fx = fixture()
  const rows = [ON(), 'not json', '{"kind":"requested"}', '[]', '{"t":"x","kind":"requested"}', JSON.stringify({ ...clean()[0], tool: 5 }), '\u0000\u0001\u0002', '', ...clean(), 'y'.repeat(70 * 1024)]
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.table.length, 1)
  assert.match(rep.notes.join('\n'), /7 ledger line\(s\) were not valid rows/)
})

test('a legacy floor row is skipped quietly, neither a row nor garbage', () => {
  const fx = fixture()
  ledger(fx, [ON(), JSON.stringify({ t: new Date(BASE).toISOString(), kind: 'floor', id: uid(9), code: 'settings' }), ...clean()])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.table.length, 1)
  assert.doesNotMatch(rep.notes.join('\n'), /not valid rows/)
})

test('--since keeps older requests and their anomalies out', () => {
  const fx = fixture()
  const oldAt = BASE - 5 * 86400_000
  const rows = [ON(oldAt - 60_000), ...clean(uid(1), oldAt, uid(101)).filter((r) => r.kind !== 'answered'), ...clean(uid(2), BASE, uid(102))]
  ledger(fx, rows, BASE)
  assert.deepEqual(rules(run(fx)), ['returned-without-answered'])
  const rep = run(fx, { since: BASE - 3600_000 })
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.table.map((t) => t.id), [uid(2)])
})

test('a symlinked ledger file is ignored and reported as a problem', () => {
  const fx = fixture()
  const real = join(fx.d, 'elsewhere.jsonl')
  writeFileSync(real, lines([ON(), ...clean()]))
  symlinkSync(real, join(fx.root, `ledger-${month(BASE)}.jsonl`))
  const rep = run(fx)
  assert.equal(rep.table.length, 0)
  assert.equal(rep.scanned.rows, 0)
  assert.match(rep.problems[0], /symlink/)
  const cli = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--projects', fx.projects], { encoding: 'utf8' })
  assert.equal(cli.status, 2)
})

test('an oversize ledger file is rejected cleanly, with the rest still read', () => {
  const fx = fixture()
  const big = join(fx.root, 'ledger-2026-01.jsonl')
  writeFileSync(big, '')
  truncateSync(big, LEDGER_MAX_BYTES + 1)
  ledger(fx, [ON(), ...clean()])
  const rep = run(fx)
  assert.equal(rep.table.length, 1)
  assert.match(rep.problems.join('\n'), /ledger-2026-01\.jsonl: too-large/)
  assert.throws(() => eachLine(big, { maxLine: 100, maxFileBytes: LEDGER_MAX_BYTES }, () => {}), /too-large/)
})

test('it writes nothing: no listing or mtime changes, and no write call in the source', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(), 'garbage'])
  mkdirSync(join(fx.root, SID))
  writeFileSync(join(fx.root, SID, `${uid(7)}.request.json`), '{}')
  writeFileSync(join(fx.root, `questions-${month(BASE)}.jsonl`), '{"q":1}\n')
  transcript(fx, SID, { at: BASE })
  const before = [...snapshot(fx.root), ...snapshot(fx.projects)]
  run(fx)
  const cli = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--projects', fx.projects, '--json'], { encoding: 'utf8' })
  assert.ok(cli.status === 0 || cli.status === 1)
  assert.deepEqual([...snapshot(fx.root), ...snapshot(fx.projects)], before)
  const src = readFileSync(SCRIPT, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(src, /\b(writeFile\w*|appendFile\w*|unlink\w*|mkdir\w*|rename\w*|rmSync|rmdir\w*|chmod\w*|copyFile\w*|symlinkSync|truncateSync|utimes\w*|createWriteStream)\(/)
})

test('a questions file is counted and listed raw, truncated', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  writeFileSync(join(fx.root, `questions-${month(BASE)}.jsonl`), lines([{ t: iso(BASE), q: 'a' }, { t: iso(BASE), q: 'b'.repeat(500) }, 'junk']))
  const rep = run(fx)
  assert.equal(rep.questions.count, 3)
  assert.ok(rep.questions.rows[1].length <= 203)
  assert.deepEqual(rep.anomalies, [])
  assert.match(render(rep), /QUESTIONS: 3 row/)
})

test('counts: median and p90 wait per tier and per tool', () => {
  const fx = fixture()
  const rows = [ON()]
  const waits = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  waits.forEach((w, i) => {
    const id = uid(200 + i)
    const at = BASE + i * 1000
    rows.push(R('requested', at, { ...T, id, nonce: uid(300 + i), tier: 'lead' }), R('answered', at + w * 1000 - 1, { ...T, id, nonce: uid(300 + i), tier: 'lead' }), R('returned', at + w * 1000, { ...T, id, code: 'allow', tier: 'lead' }))
  })
  ledger(fx, rows)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.counts.wait, { n: 10, median: 50, p90: 90 })
  assert.equal(rep.counts.byTier.lead.wait.p90, 90)
  assert.equal(rep.counts.byTool[T.tool].requests, 10)
  assert.equal(percentile([1, 2, 3], 50), 2)
  assert.equal(percentile([], 50), undefined)
})

test('eachLine: a line over the cap is skipped, lines across chunk edges are whole', () => {
  const d = mkdtempSync(join(tmpdir(), 'pa-l-'))
  const p = join(d, 'f.jsonl')
  const a = 'a'.repeat(100_000)
  writeFileSync(p, `short\n${'z'.repeat(2000)}\n${a}\nlast`)
  const got = []
  const s = eachLine(p, { maxLine: 150_000 }, (l) => got.push(l.length))
  assert.deepEqual(got, [5, 2000, 100_000, 4])
  const got2 = []
  const s2 = eachLine(p, { maxLine: 3000 }, (l) => got2.push(l.length))
  assert.deepEqual(got2, [5, 2000, 4])
  assert.equal(s2.skippedLong, 1)
  assert.equal(s.skippedLong, 0)
  rmSync(d, { recursive: true })
})

test('the command line: exit codes, --json, defaults from CLAUDE_CONFIG_DIR, usage errors', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const ok = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--projects', fx.projects, '--json'], { encoding: 'utf8' })
  assert.equal(ok.status, 0)
  assert.deepEqual(JSON.parse(ok.stdout).anomalies, [])
  const text = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--projects', fx.projects], { encoding: 'utf8' })
  assert.equal(text.status, 0)
  assert.match(text.stdout, /REQUESTS[\s\S]*ANOMALIES[\s\S]*NOT ANOMALIES[\s\S]*COUNTS/)

  const cfg = join(fx.d, 'cfg')
  mkdirSync(join(cfg, 'callboard', 'prompts'), { recursive: true })
  mkdirSync(join(cfg, 'projects'))
  writeFileSync(join(cfg, 'callboard', 'prompts', `ledger-${month(BASE)}.jsonl`), lines(clean()))
  const dflt = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } })
  assert.equal(dflt.status, 1)
  assert.deepEqual(JSON.parse(dflt.stdout).anomalies.map((a) => a.code), ['requested-before-answering-on'])

  for (const args of [['--root', join(fx.d, 'nope')], ['--since', 'yesterdayish'], ['--bogus'], ['--root']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } })
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, /prompt audit:/)
  }
})

test('a1: a returned row that differs from the answered row in decision or author is an anomaly', () => {
  const fx = fixture()
  const BY = uid(900)
  const rows = (ansCode, retCode, ansBy, retBy) => {
    const r = clean()
    r[1] = { ...r[1], code: ansCode, ...(ansBy ? { by: ansBy } : {}) }
    r[2] = { ...r[2], code: retCode, ...(retBy ? { by: retBy } : {}) }
    return [ON(), ...r]
  }
  ledger(fx, rows('deny', 'allow'))
  assert.deepEqual(rules(run(fx)), ['returned-differs-from-answered'])
  ledger(fx, rows('allow', 'allow', BY, uid(901)))
  assert.deepEqual(rules(run(fx)), ['returned-differs-from-answered'])
  ledger(fx, rows('allow', 'allow', BY, BY))
  assert.deepEqual(run(fx).anomalies, [])
  ledger(fx, rows('allow', 'allow', BY, undefined))
  assert.deepEqual(run(fx).anomalies, [])
})

test('a2: a hook allow is not backed by a returned deny', () => {
  const fx = fixture()
  const r = clean()
  r[1].code = 'deny'
  r[2].code = 'deny'
  ledger(fx, [ON(), ...r])
  transcript(fx, SID, { at: BASE + 45_000 })
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['hook-decision-unmatched'])
  assert.equal(rep.notAnomalies.hookDecisionsBacked, 0)
})

test('a2: a returned row backs one hook decision only, the second one is an anomaly', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE + 45_000 })
  transcript(fx, `${SID}-b`, { at: BASE + 46_000, useId: 'toolu_02' })
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['hook-decision-unmatched'])
  assert.equal(rep.notAnomalies.hookDecisionsBacked, 1)
  assert.match(rep.anomalies[0].detail, /toolu_02/)
})

test('a2: a returned row with a tuid backs the exact tool_use_id, with no time window, and no other', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), { tuid: 'toolu_01' })])
  transcript(fx, SID, { at: BASE + 45_000 + 3 * 3600_000 })
  let rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notAnomalies.hookDecisionsBacked, 1)
  // Another call of the same tool, inside the old window: a row with a tuid is not matched by time.
  transcript(fx, `${SID}-b`, { at: BASE + 50_000, useId: 'toolu_02' })
  rep = run(fx)
  assert.deepEqual(rules(rep), ['hook-decision-unmatched'])
  assert.match(rep.anomalies[0].detail, /toolu_02/)
})

test('a3: values from a ledger row cannot put control characters into the text output', () => {
  const fx = fixture()
  const evil = { pattern: 'x\u001b[2J\u001b[1;1H\u202eevil', lane: 'l\nnone\u2028X', why: 'a\rb\u0085c\u007fd', tool: 'Bash\u0007' }
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), evil)])
  const text = render(run(fx))
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/)
  assert.match(text, /x\\u001b\[2J\\u001b\[1;1H\\u202eevil/)
  assert.equal(text.split('\n').filter((l) => l === 'none').length, 1)
  assert.match(text, /l\\u000anone\\u2028X/)
  const json = JSON.parse(JSON.stringify(run(fx)))
  assert.equal(json.table[0].pattern, evil.pattern)
})

test('a4: with problems the text says INCOMPLETE in place of none', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  assert.match(render(run(fx)), /ANOMALIES \(must be empty\)\nnone\n/)
  const big = join(fx.root, 'ledger-2026-01.jsonl')
  writeFileSync(big, '')
  truncateSync(big, LEDGER_MAX_BYTES + 1)
  const text = render(run(fx))
  assert.match(text, /ANOMALIES \(must be empty\)\nINCOMPLETE: 1 problem\(s\), the audit did not see everything\n/)
  assert.doesNotMatch(text, /ANOMALIES \(must be empty\)\nnone/)
})

test('a4: an explicit --projects that cannot be read is a problem (exit 2), the default folder missing is a note', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  const missing = join(fx.d, 'nope')
  const rep = audit({ root: fx.root, projects: missing, projectsExplicit: true, now: NOW })
  assert.equal(rep.problems.length, 1)
  assert.match(rep.problems[0], /--projects/)
  const soft = audit({ root: fx.root, projects: missing, now: NOW })
  assert.deepEqual(soft.problems, [])
  assert.equal(soft.notes.length, 1)
  const explicit = spawnSync(process.execPath, [SCRIPT, '--root', fx.root, '--projects', missing], { encoding: 'utf8' })
  assert.equal(explicit.status, 2)
  assert.match(explicit.stdout, /INCOMPLETE: 1 problem/)
  const cfg = join(fx.d, 'cfg')
  mkdirSync(cfg)
  const dflt = spawnSync(process.execPath, [SCRIPT, '--root', fx.root], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } })
  assert.equal(dflt.status, 0)
})

test('a4: a total byte budget for transcripts: running out of it is a problem', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE })
  transcript(fx, `${SID}-b`, { at: BASE, useId: 'toolu_02' })
  assert.deepEqual(run(fx).problems, [])
  const rep = run(fx, { transcriptBudget: 200 })
  assert.equal(rep.problems.length, 1)
  assert.match(rep.problems[0], /byte budget of 200/)
  assert.match(render(rep), /INCOMPLETE: 1 problem/)
})

test('review: every way of not reading a transcript makes the run incomplete, not a clean result', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE })
  const dir = join(fx.projects, '-Users-x-api')
  for (let i = 0; i < 2001; i++) writeFileSync(join(dir, `pad-${i}.jsonl`), '')
  const rep = run(fx)
  assert.ok(rep.problems.some((p) => /only the 2000 newest of \d+ files/.test(p)), rep.problems.join('|'))
  assert.match(render(rep), /INCOMPLETE: \d+ problem/)
  assert.equal(rep.notes.some((n) => /newest of/.test(n)), false)
})

test('review: a transcript folder that cannot be listed is a problem', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean()])
  transcript(fx, SID, { at: BASE })
  const bad = join(fx.projects, '-Users-x-locked')
  mkdirSync(bad)
  chmodSync(bad, 0o000)
  try {
    const rep = run(fx)
    assert.ok(rep.problems.some((p) => /could not be listed/.test(p)), rep.problems.join('|'))
  } finally {
    chmodSync(bad, 0o700)
  }
})

// ---- live test A fixes ----
const LEAD = 'bbbbbbbb-0000-4000-8000-123456789abc'
// The lead's own transcript: one assistant line per prompt_answer call, as Claude Code writes a tool_use block.
function leadTranscript(fx, sid, calls, name = 'mcp__callboard__prompt_answer', decision = 'allow') {
  const dir = join(fx.projects, '-Users-x-lead')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sid}.jsonl`), lines(calls.map((id, i) => ({ type: 'assistant', sessionId: sid, timestamp: iso(BASE + 30_000 + i), message: { content: [{ type: 'tool_use', id: `toolu_${i}`, name, input: { id, decision, why: 'reads only' } }] } }))))
}
test('finding 3: an answered row by a lead needs a prompt_answer call for its id in that lead\'s transcript', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), { by: LEAD })])
  leadTranscript(fx, LEAD, [uid(1)])
  assert.deepEqual(run(fx).anomalies, [])
  assert.deepEqual(run(fx).problems, [])
  // A forged pair of row and file: the lead made no such call.
  leadTranscript(fx, LEAD, [uid(2)])
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['answered-without-prompt-answer'])
  assert.equal(rep.anomalies[0].rule, 'c')
  assert.equal(rep.anomalies[0].id, uid(1))
  // A call to another tool of the same name tail by another server still counts only by the callboard tool's name.
  leadTranscript(fx, LEAD, [uid(1)], 'mcp__other__not_prompt_answer')
  assert.deepEqual(rules(run(fx)), ['answered-without-prompt-answer'])
})
test('finding 3: a lead transcript that cannot be found makes the run incomplete, and no transcript folder leaves the check unrun', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), { by: LEAD })])
  mkdirSync(join(fx.projects, '-Users-x-lead'), { recursive: true })
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.ok(rep.problems.some((p) => p.includes(LEAD) && /not found/.test(p)), rep.problems.join('|'))
  const none = audit({ root: fx.root, projects: undefined, now: NOW })
  assert.deepEqual(none.anomalies, [])
  assert.deepEqual(none.problems, [])
})
test('finding 3: the check is per lead session: a call by one lead does not vouch for another lead\'s answer', () => {
  const fx = fixture()
  const OTHER = 'cccccccc-0000-4000-8000-123456789abc'
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), { by: LEAD })])
  leadTranscript(fx, OTHER, [uid(1)])
  leadTranscript(fx, LEAD, [])
  assert.deepEqual(rules(run(fx)), ['answered-without-prompt-answer'])
})
test('finding 1: a request with no ending row and no request file is a fault; with its file, or young, or on a lone ledger, it is not', () => {
  const fx = fixture()
  ledger(fx, [ON(), R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' })])
  // A ledger alone (no session folders): absence of files says nothing.
  assert.deepEqual(run(fx).anomalies, [])
  const sdir = join(fx.root, SID)
  mkdirSync(sdir)
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['request-closed-without-row'])
  assert.equal(rep.table[0].outcome, 'closed-no-row')
  // Young: the mod's tick has not had its time yet.
  assert.deepEqual(run(fx, { now: BASE + 5 * 60_000 }).anomalies, [])
  // The file is there: the request is open, not closed.
  writeFileSync(join(sdir, `${uid(1)}.request.json`), '{}')
  const open = run(fx)
  assert.deepEqual(open.anomalies, [])
  assert.equal(open.table[0].outcome, 'open')
  // An ending row of any kind closes it.
  rmSync(join(sdir, `${uid(1)}.request.json`))
  ledger(fx, [ON(), R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }), R('superseded', BASE + 20_000, { ...T, id: uid(1) })])
  assert.deepEqual(run(fx).anomalies, [])
})

// ---- tiers and the person relay (PR 3) ----
const MGR = 'dddddddd-0000-4000-8000-123456789abc'
const SHORT = uid(1).slice(0, 8)
// The relaying tier's transcript: its AskUserQuestion with header `Relay <short>` and the tool result carrying the person's answer, as Claude Code writes them.
function relayTranscript(fx, sid, { short = SHORT, header = `Relay ${short}`, answer = 'Yes', viaText = false } = {}) {
  const dir = join(fx.projects, '-Users-x-mgr')
  mkdirSync(dir, { recursive: true })
  const use = { type: 'assistant', sessionId: sid, timestamp: iso(BASE + 30_000), message: { content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: 'Allow it?', header, options: [{ label: 'Yes' }, { label: 'No' }] }] } }] } }
  const res = viaText
    ? { type: 'user', sessionId: sid, timestamp: iso(BASE + 40_000), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: `User has answered your questions: "Allow it?"="${answer}". You can now continue.` }] } }
    : { type: 'user', sessionId: sid, timestamp: iso(BASE + 40_000), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'ok' }] }, toolUseResult: { answers: { 'Allow it?': answer } } }
  writeFileSync(join(dir, `${sid}.jsonl`), lines([use, res]))
}
const personRows = (extra = {}) => [
  R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }),
  R('relayed', BASE + 20_000, { ...T, id: uid(1), nonce: uid(101), code: 'manager', short: SHORT, by: MGR }),
  R('answered', BASE + 40_000, { ...T, id: uid(1), nonce: uid(101), tier: 'manager', why: 'the person said yes', code: 'allow', by: MGR, via: 'person', short: SHORT, ...extra }),
  R('returned', BASE + 45_000, { ...T, id: uid(1), code: 'allow', tier: 'manager', why: 'the person said yes', by: MGR, via: 'person', short: SHORT, ...extra }),
]
test('tiers: the person\'s answer through a relay is checked against the relaying tier\'s `Relay <short>` question, and needs no prompt_answer call', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...personRows()])
  relayTranscript(fx, MGR)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.problems, [])
  assert.equal(rep.notAnomalies.relay.relayed.n, 1)
  assert.equal(rep.notAnomalies.relay.personAnswers.n, 1)
  // The answer is also read from the result's text when the structured answers are not there.
  relayTranscript(fx, MGR, { viaText: true })
  assert.deepEqual(run(fx).anomalies, [])
  // A different question text with the same answer is not enough: the header must be `Relay <short>` of this request.
  relayTranscript(fx, MGR, { header: 'Question' })
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  relayTranscript(fx, MGR, { short: 'ffffffff' })
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  // An answer other than Yes does not back an allow; No backs a deny only.
  relayTranscript(fx, MGR, { answer: 'No' })
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  relayTranscript(fx, MGR, { answer: 'Maybe' })
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  ledger(fx, [ON(), ...personRows({ code: 'deny' })])
  relayTranscript(fx, MGR, { answer: 'No' })
  assert.deepEqual(run(fx).anomalies, [])
})
test('tiers: the relaying tier\'s transcript missing makes the run incomplete', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...personRows()])
  mkdirSync(join(fx.projects, '-Users-x-mgr'), { recursive: true })
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.ok(rep.problems.some((p) => p.includes(MGR) && /not found/.test(p)), rep.problems.join('|'))
})
test('tiers: an agent\'s answer while the request is with the person is an anomaly, unless a relay-lost row came first', () => {
  const fx = fixture()
  const rows = (lost) => [
    R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }),
    R('relayed', BASE + 20_000, { ...T, id: uid(1), nonce: uid(101), code: 'manager', short: SHORT, by: MGR }),
    ...(lost ? [R('relay-lost', BASE + 30_000, { ...T, id: uid(1), code: 'not-asked', short: SHORT, by: MGR, tier: 'manager' })] : []),
    R('answered', BASE + 40_000, { ...T, id: uid(1), nonce: uid(101), tier: 'lead', why: 'reads only', code: 'allow', by: LEAD }),
    R('returned', BASE + 45_000, { ...T, id: uid(1), code: 'allow', tier: 'lead', why: 'reads only', by: LEAD }),
  ]
  ledger(fx, [ON(), ...rows(false)])
  assert.deepEqual(rules(run(fx)), ['answered-while-relayed', 'returned-while-relayed'])
  ledger(fx, [ON(), ...rows(true)])
  const ok = run(fx)
  assert.deepEqual(ok.anomalies, [])
  assert.equal(ok.notAnomalies.relay['relay-lost'].n, 1)
  assert.deepEqual(ok.notAnomalies.relay['relay-lost'].codes, { 'not-asked': 1 })
})
test('tiers: a tier that passed a request up does not answer it afterwards; another tier does', () => {
  const fx = fixture()
  const rows = (answerer) => [
    R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }),
    R('escalated', BASE + 20_000, { ...T, id: uid(1), code: 'lead', tier: 'lead', why: 'unsure' }),
    R('answered', BASE + 40_000, { ...T, id: uid(1), nonce: uid(101), tier: answerer, why: 'reads only', code: 'allow', by: LEAD }),
    R('returned', BASE + 45_000, { ...T, id: uid(1), code: 'allow', tier: answerer, why: 'reads only', by: LEAD }),
  ]
  ledger(fx, [ON(), ...rows('lead')])
  assert.deepEqual(rules(run(fx)), ['answered-after-own-pass-up'])
  ledger(fx, [ON(), ...rows('conductor')])
  assert.deepEqual(run(fx).anomalies, [])
})
test('tiers: relay-left, relay-late, expired-denied and deny-unclear are listed and counted, never anomalies', () => {
  const fx = fixture()
  ledger(fx, [
    ON(),
    R('requested', BASE, { ...T, id: uid(1), nonce: uid(101), tier: 'lead' }),
    R('relayed', BASE + 20_000, { ...T, id: uid(1), nonce: uid(101), code: 'conductor', short: SHORT, by: MGR }),
    R('relay-left', BASE + 30_000, { id: uid(1), short: SHORT, by: MGR, tier: 'conductor' }),
    R('relay-late', BASE + 40_000, { short: 'ffffffff', by: MGR, code: 'closed' }),
    R('expired-denied', BASE + 50_000, { ...T, id: uid(1), code: 'timeout' }),
    R('deny-unclear', BASE + 60_000, { ...T, id: uid(2), nonce: uid(102), code: 'deny', by: LEAD }),
  ])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  const r = rep.notAnomalies.relay
  assert.deepEqual([r.relayed.n, r['relay-left'].n, r['relay-late'].n, r['expired-denied'].n, r['deny-unclear'].n], [1, 1, 1, 1, 1])
  const text = render(rep)
  assert.match(text, /relay-late: 1 \(closed 1\)/)
  assert.match(text, /expired-denied: 1 \(timeout 1\)/)
  assert.match(text, /relayed: 1 \(conductor 1\)/)
  // The tier that asked, not "(none)": a relay-left row carries it in `tier`.
  assert.deepEqual(r['relay-left'].codes, { conductor: 1 })
  assert.match(text, /relay-left: 1 \(conductor 1\)/)
})
// One call with two relay questions, answered differently: each answer belongs to its own question.
function relayTranscript2(fx, sid, pairs) {
  const dir = join(fx.projects, '-Users-x-mgr')
  mkdirSync(dir, { recursive: true })
  const qs = pairs.map((p) => ({ question: p.question, header: `Relay ${p.short}`, options: [{ label: 'Yes' }, { label: 'No' }] }))
  const use = { type: 'assistant', sessionId: sid, timestamp: iso(BASE + 30_000), message: { content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: qs } }] } }
  const answers = Object.fromEntries(pairs.map((p) => [p.question, p.answer]))
  const res = { type: 'user', sessionId: sid, timestamp: iso(BASE + 40_000), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'ok' }] }, toolUseResult: { answers } }
  writeFileSync(join(dir, `${sid}.jsonl`), lines([use, res]))
}
test('tiers: with two relay questions in one call each answer backs only its own request; a forged Yes for the one answered No is an anomaly', () => {
  const fx = fixture()
  const ID2 = '10000000-0000-4000-8000-000000000002'
  const S2 = ID2.slice(0, 8)
  const second = (code) => [
    R('requested', BASE + 1000, { ...T, id: ID2, nonce: uid(102), tier: 'lead' }),
    R('relayed', BASE + 21_000, { ...T, id: ID2, nonce: uid(102), code: 'manager', short: S2, by: MGR }),
    R('answered', BASE + 41_000, { ...T, id: ID2, nonce: uid(102), tier: 'manager', why: 'the person answered', code, by: MGR, via: 'person', short: S2 }),
    R('returned', BASE + 46_000, { ...T, id: ID2, code, tier: 'manager', why: 'the person answered', by: MGR, via: 'person', short: S2 }),
  ]
  const pairs = [{ short: SHORT, question: `[${SHORT}] Allow A?`, answer: 'Yes' }, { short: S2, question: `[${S2}] Allow B?`, answer: 'No' }]
  ledger(fx, [ON(), ...personRows(), ...second('deny')])
  relayTranscript2(fx, MGR, pairs)
  assert.deepEqual(run(fx).anomalies, [])
  ledger(fx, [ON(), ...personRows(), ...second('allow')])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  assert.equal(run(fx).anomalies[0].id, ID2)
})
test('tiers: a person answer needs a relayed row of the same tier session and the request\'s own short id; the row\'s say-so does not count', () => {
  const fx = fixture()
  relayTranscript(fx, MGR)
  ledger(fx, [ON(), ...personRows().filter((r) => r.kind !== 'relayed')])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relayed-row'])
  ledger(fx, [ON(), ...personRows({ short: 'ffffffff' })])
  assert.deepEqual(rules(run(fx)), ['person-answer-short-mismatch'])
})
test('tiers: a person answer through the second tier is backed by that tier\'s own relayed row, not the first (the first relay was lost)', () => {
  const fx = fixture()
  const COND = '00000000-0000-4000-8000-0000000000c1'
  const rows = personRows({}).map((r) => (r.kind === 'answered' || r.kind === 'returned' ? { ...r, by: COND, tier: 'conductor' } : r))
  rows.splice(2, 0, R('relayed', BASE + 30_000, { ...T, id: uid(1), nonce: uid(101), code: 'conductor', short: SHORT, by: COND }))
  ledger(fx, [ON(), ...rows])
  relayTranscript(fx, COND)
  assert.deepEqual(run(fx).anomalies, [])
})
test('tiers: the relayed questions are listed with the request\'s tool and pattern, as the tier asked them', () => {
  const fx = fixture()
  ledger(fx, [ON(), ...personRows()])
  relayTranscript(fx, MGR)
  const rep = run(fx)
  assert.equal(rep.notAnomalies.relayedQuestions.length, 1)
  assert.deepEqual(rep.notAnomalies.relayedQuestions[0].questions, [{ question: 'Allow it?', answer: 'Yes' }])
  const text = render(rep)
  assert.match(text, /RELAYED QUESTIONS/)
  assert.match(text, /Allow it\? -> Yes/)
  assert.match(text, /mcp__github__add_issue_comment/)
})

// ---- questions (PR 4) ----
const lhOf = (id, label) => createHash('sha256').update(`${id}\n${label}`).digest('hex').slice(0, 16)
const QT = { lane: 'api', repo: '/Users/x/api', tool: 'AskUserQuestion', pattern: 'AskUserQuestion', hash: H('q') }
// The second `answering-on` row of `/callboard escalation` (code asks); it comes after the plain ON() row so that it is the one in force.
const ASKS = (at = BASE - 50_000) => R('answering-on', at, { code: 'asks', hash: H('8') })
// A tier's answer to a question: requested, answered, returned (code answer, with opt and the salted label hash).
function qClean({ id = uid(1), at = BASE, nonce = uid(101), label = 'Green', by, tuid, tier = 'lead' } = {}) {
  const f = { ...QT, id, tier, code: 'answer', opt: '1', lh: lhOf(id, label), why: 'settled by the brief', ...(by ? { by } : {}) }
  return [R('requested', at, { ...QT, id, nonce, tier }), R('answered', at + 40_000, { ...f, nonce }), R('returned', at + 45_000, { ...f, ...(tuid ? { tuid } : {}) })]
}
// The person's pick through a tier's relay: requested, relayed, answered and returned via person.
function qPerson({ id = uid(1), at = BASE, label = 'Green', lh = lhOf(id, label.trim()), by = MGR } = {}) {
  const short = id.slice(0, 8)
  const f = { ...QT, id, tier: 'manager', code: 'answer', opt: '1', lh, why: 'the person picked option 2', by, via: 'person', short }
  return [
    R('requested', at, { ...QT, id, nonce: uid(101), tier: 'lead' }),
    R('relayed', at + 20_000, { ...QT, id, nonce: uid(101), code: 'manager', short, by }),
    R('answered', at + 40_000, { ...f, nonce: uid(101) }),
    R('returned', at + 45_000, f),
  ]
}
const qrow = (extra = {}) => ({ t: iso(BASE), id: uid(1), lane: 'api', repo: '/Users/x/api', tier: 'lead', by: LEAD, header: 'Color', question: 'Which color?', options: ['Red', 'Green'], label: 'Green', ...extra })
const qfile = (fx, rows, ms = BASE) => writeFileSync(join(fx.root, `questions-${month(ms)}.jsonl`), lines(rows))

test('questions: a person\'s pick of a 150-character label is found in the relaying tier\'s transcript (structured and text form)', () => {
  const fx = fixture()
  const label = 'x'.repeat(150)
  ledger(fx, [ON(), ASKS(), ...qPerson({ label })])
  relayTranscript(fx, MGR, { answer: label })
  assert.deepEqual(run(fx).anomalies, [])
  relayTranscript(fx, MGR, { answer: label, viaText: true })
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.notes.filter((n) => /unverifiable/.test(n)), [])
  // A label of 256 characters is read whole; the old cut of 100 would have missed it.
  const long = 'y'.repeat(256)
  ledger(fx, [ON(), ASKS(), ...qPerson({ label: long })])
  relayTranscript(fx, MGR, { answer: long })
  assert.deepEqual(run(fx).anomalies, [])
})
test('questions: a wrong or missing lh is an anomaly, also when the answer is read from the result text', () => {
  const fx = fixture()
  relayTranscript(fx, MGR, { answer: 'Green' })
  ledger(fx, [ON(), ASKS(), ...qPerson({ lh: lhOf(uid(1), 'Blue') })])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  relayTranscript(fx, MGR, { answer: 'Green', viaText: true })
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  // The hash is salted with the request id: the hash of the bare label does not match.
  ledger(fx, [ON(), ASKS(), ...qPerson({ lh: createHash('sha256').update('Green').digest('hex').slice(0, 16) })])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  ledger(fx, [ON(), ASKS(), ...qPerson().map((r) => (r.lh === undefined ? r : { ...r, lh: undefined }))])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  ledger(fx, [ON(), ASKS(), ...qPerson()])
  assert.deepEqual(run(fx).anomalies, [])
})
test('questions: an answer with surrounding spaces matches the lh of its trimmed label', () => {
  const fx = fixture()
  ledger(fx, [ON(), ASKS(), ...qPerson({ label: 'Green' })])
  relayTranscript(fx, MGR, { answer: '  Green \t' })
  assert.deepEqual(run(fx).anomalies, [])
  // An lh over the untrimmed text is the mod's contract broken: it does not match.
  ledger(fx, [ON(), ASKS(), ...qPerson({ lh: lhOf(uid(1), '  Green \t') })])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
})
test('questions: a label holding < is hashed raw by the mod, and found whether the tier copied it raw or in the listed \\u003c form', () => {
  const fx = fixture()
  const label = 'List<String>'
  ledger(fx, [ON(), ASKS(), ...qPerson({ label })])
  relayTranscript(fx, MGR, { answer: label })
  assert.deepEqual(run(fx).anomalies, [])
  relayTranscript(fx, MGR, { answer: 'List\\u003cString>' })
  assert.deepEqual(run(fx).anomalies, [])
})
test('questions: a label holding an invisible character is hashed raw by the mod, and found when the tier copied it in the listed \\uXXXX form', () => {
  const fx = fixture()
  const label = 'Ship \u2764\ufe0f now'
  ledger(fx, [ON(), ASKS(), ...qPerson({ label })])
  relayTranscript(fx, MGR, { answer: 'Ship \u2764\\ufe0f now' })
  assert.deepEqual(run(fx).anomalies, [])
})
test('questions: a label holding a quote with no structured answers is a note, not an anomaly; with the structured answers it is checked', () => {
  const fx = fixture()
  const label = 'Say "hi"'
  ledger(fx, [ON(), ASKS(), ...qPerson({ label })])
  relayTranscript(fx, MGR, { answer: label, viaText: true })
  let rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.ok(rep.notes.some((n) => /^question-label-unverifiable: request /.test(n) && n.includes(uid(1))), rep.notes.join('|'))
  assert.match(render(rep), /not readable from the result text/)
  relayTranscript(fx, MGR, { answer: label })
  rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.notes.filter((n) => /unverifiable/.test(n)), [])
  // The structured form says another label: an anomaly, whatever the quote.
  relayTranscript(fx, MGR, { answer: 'Plain' })
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
  // A plain wrong label in the text form is no note either: only a cut that stops at a quote which does not close the pair is unreadable.
  ledger(fx, [ON(), ASKS(), ...qPerson({ label: 'Green' })])
  relayTranscript(fx, MGR, { answer: 'Blue', viaText: true })
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question'])
})
test('questions: one call with a Yes/No relay and a question relay: each answer is read by its own rule', () => {
  const fx = fixture()
  const ID2 = '10000000-0000-4000-8000-000000000002'
  const S2 = ID2.slice(0, 8)
  const pairs = [{ short: SHORT, question: `[${SHORT}] Allow A?`, answer: 'Yes' }, { short: S2, question: `[${S2}] Lane api asks: which color?`, answer: 'Green' }]
  ledger(fx, [ON(), ASKS(), ...personRows(), ...qPerson({ id: ID2, at: BASE + 1000, label: 'Green' })])
  relayTranscript2(fx, MGR, pairs)
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.problems, [])
  // The question's pick forged as another label: only that request is flagged.
  ledger(fx, [ON(), ASKS(), ...personRows(), ...qPerson({ id: ID2, at: BASE + 1000, label: 'Blue' })])
  const bad = run(fx)
  assert.deepEqual(rules(bad), ['person-answer-without-relay-question'])
  assert.equal(bad.anomalies[0].id, ID2)
  // The Yes/No relay's allow does not accept the question's label, and the question does not accept a Yes.
  relayTranscript2(fx, MGR, [{ ...pairs[0], answer: 'Green' }, { ...pairs[1], answer: 'Yes' }])
  ledger(fx, [ON(), ASKS(), ...personRows(), ...qPerson({ id: ID2, at: BASE + 1000, label: 'Green' })])
  assert.deepEqual(rules(run(fx)), ['person-answer-without-relay-question', 'person-answer-without-relay-question'])
})
test('questions: a code answer row backs a hook allow of an AskUserQuestion, by tuid and in the no-tuid window; the lead\'s prompt_answer call is still needed (rule c2)', () => {
  const fx = fixture()
  // A transcript shaped like what the probe captured: the hook's answer has source hook, reasonCode unknown and a hook_permission_decision attachment.
  for (const tuid of ['toolu_01', undefined]) {
    ledger(fx, [ON(), ASKS(), ...qClean({ by: LEAD, tuid })])
    leadTranscript(fx, LEAD, [uid(1)], undefined, 'answer')
    transcript(fx, SID, { at: BASE + 45_000, tool: 'AskUserQuestion', reasonCode: 'unknown' })
    const rep = run(fx)
    assert.deepEqual(rep.anomalies, [], String(tuid))
    assert.deepEqual(rep.problems, [], String(tuid))
    assert.equal(rep.notAnomalies.hookDecisionsBacked, 1, String(tuid))
    assert.deepEqual(rep.notes.filter((n) => /no hook decision/.test(n)), [], String(tuid))
  }
  leadTranscript(fx, LEAD, [uid(2)], undefined, 'answer')
  assert.deepEqual(rules(run(fx)), ['answered-without-prompt-answer'])
})
test('questions: a code answer row is not backed by another tool\'s allow in the no-tuid window, and not for a request that is not a question', () => {
  const fx = fixture()
  // The row is an answer to a question, the transcript's allow is a Bash call in the window: it stays unbacked.
  ledger(fx, [ON(), ASKS(), ...qClean()])
  transcript(fx, SID, { at: BASE + 45_000, tool: 'Bash', reasonCode: 'unknown' })
  assert.deepEqual(rules(run(fx)), ['hook-decision-unmatched'])
  // The row is an answer on a Bash request: it backs nothing, and it is an anomaly of its own.
  const bash = clean(uid(1), BASE, uid(101), { tool: 'Bash', pattern: 'Bash git', hash: H('b') }).map((r) => (r.kind === 'requested' ? r : { ...r, code: 'answer', opt: '0', lh: lhOf(uid(1), 'Green') }))
  ledger(fx, [ON(), ASKS(), ...bash])
  transcript(fx, SID, { at: BASE + 45_000, tool: 'Bash', reasonCode: 'unknown' })
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['hook-decision-unmatched', 'q-answer-not-question', 'q-answer-not-question'])
  assert.equal(rep.notAnomalies.hookDecisionsBacked, 0)
  // A returned allow still backs a Bash allow as before.
  ledger(fx, [ON(), ...clean(uid(1), BASE, uid(101), { tool: 'Bash', pattern: 'Bash git', hash: H('b') })])
  assert.deepEqual(run(fx).anomalies, [])
})
test('questions: a click on the card is a lost race with a note, not an anomaly', () => {
  const fx = fixture()
  ledger(fx, [ON(), ASKS(), ...qClean({ tuid: 'toolu_01' })])
  transcript(fx, SID, { at: BASE + 50_000, source: 'user_temporary', tool: 'AskUserQuestion', pdExtra: { grantScope: 'once' } })
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notAnomalies.lostRaces.length, 1)
  assert.ok(rep.notes.some((n) => /1 returned question answer\(s\) have a tool_use id with no hook decision/.test(n)), rep.notes.join('|'))
})
test('questions: q-no-asks-on: an asks row in force is needed; a later plain on, any off, or none at all is an anomaly', () => {
  const fx = fixture()
  const q = qClean()
  // `asks LANE`, then `on Y` (clears the questions scope), then a question request.
  ledger(fx, [ON(BASE - 120_000), ASKS(BASE - 90_000), ON(BASE - 60_000), ...q])
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['q-no-asks-on'])
  assert.equal(rep.anomalies[0].id, uid(1))
  assert.equal(rep.anomalies[0].rule, 'q')
  ledger(fx, [ON(BASE - 120_000), ASKS(BASE - 90_000), R('answering-off', BASE - 60_000, { code: 'asks' }), ...q])
  assert.deepEqual(rules(run(fx)), ['q-no-asks-on'])
  ledger(fx, [ON(BASE - 120_000), ...q])
  assert.deepEqual(rules(run(fx)), ['q-no-asks-on'])
  // asks on, then asks widened, then the question: in force. An `on Y` after the question changes nothing.
  ledger(fx, [ON(BASE - 120_000), ASKS(BASE - 90_000), ASKS(BASE - 60_000), ...q, ON(BASE + 60_000)])
  assert.deepEqual(run(fx).anomalies, [])
  // Permission requests need no asks row.
  ledger(fx, [ON(), ...clean()])
  assert.deepEqual(run(fx).anomalies, [])
})
test('questions: the two rows one /callboard escalation writes, in the same millisecond, put a later question in force', () => {
  const fx = fixture()
  ledger(fx, [ON(BASE - 60_000), ASKS(BASE - 60_000), ...qClean()])
  assert.deepEqual(run(fx).anomalies, [])
  // The plain row alone (the asks row never written) is not enough.
  ledger(fx, [ON(BASE - 60_000), ...qClean()])
  assert.deepEqual(rules(run(fx)), ['q-no-asks-on'])
})
test('questions: q-answer-not-question and q-decided-question', () => {
  const fx = fixture()
  const bash = clean(uid(2), BASE, uid(102)).map((r) => (r.kind === 'requested' ? r : { ...r, code: 'answer', opt: '0', lh: lhOf(uid(2), 'Green') }))
  ledger(fx, [ON(), ASKS(), ...bash])
  let rep = run(fx)
  assert.deepEqual(rules(rep), ['q-answer-not-question', 'q-answer-not-question'])
  assert.equal(rep.anomalies[0].id, uid(2))
  // A question decided allow or deny, in an answered row, a returned row or an expired-denied row.
  const decided = clean(uid(3), BASE, uid(103), { tool: 'AskUserQuestion', pattern: 'AskUserQuestion', hash: H('q') })
  const expired = [R('requested', BASE + 1000, { ...QT, id: uid(4), nonce: uid(104), tier: 'lead' }), R('expired-denied', BASE + 2000, { ...QT, id: uid(4), code: 'timeout' })]
  ledger(fx, [ON(), ASKS(), ...decided, ...expired])
  rep = run(fx)
  assert.deepEqual(rules(rep), ['q-decided-question', 'q-decided-question', 'q-decided-question'])
  assert.deepEqual([...new Set(rep.anomalies.map((a) => a.id))].sort(), [uid(3), uid(4)])
  // A question answered properly, with the same shape, has none of them.
  ledger(fx, [ON(), ASKS(), ...qClean()])
  assert.deepEqual(run(fx).anomalies, [])
})
test('questions: q-returned-differs: the returned answer must carry the answered row\'s option and label hash', () => {
  const fx = fixture()
  const rows = (ret) => {
    const r = qClean()
    r[2] = { ...r[2], ...ret }
    return [ON(), ASKS(), ...r]
  }
  ledger(fx, rows({}))
  assert.deepEqual(run(fx).anomalies, [])
  ledger(fx, rows({ opt: '0' }))
  assert.deepEqual(rules(run(fx)), ['q-returned-differs'])
  ledger(fx, rows({ lh: lhOf(uid(1), 'Red') }))
  assert.deepEqual(rules(run(fx)), ['q-returned-differs'])
  ledger(fx, rows({ lh: undefined }))
  assert.deepEqual(rules(run(fx)), ['q-returned-differs'])
})
test('questions: the opt and lh fields are read, and a non-string one drops the row like any other', () => {
  const fx = fixture()
  const r = qClean()
  ledger(fx, [ON(), ASKS(), ...r, JSON.stringify({ ...r[2], opt: 1 })])
  const rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.match(rep.notes.join('\n'), /1 ledger line\(s\) were not valid rows/)
})
test('questions: the notes: no questions row, a row past 90 days, not-judgeable counts, and the QUESTIONS table', () => {
  const fx = fixture()
  ledger(fx, [ON(), ASKS(), ...qClean(), R('not-judgeable', BASE + 100, { ...QT, code: 'question-scope' }), R('not-judgeable', BASE + 200, { ...QT, code: 'question-scope' }), R('not-judgeable', BASE + 300, { ...QT, code: 'question-multi' }), R('not-judgeable', BASE + 400, { ...T, code: 'no-check' })])
  let rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.ok(rep.notes.includes('1 returned question answer(s) have no questions row (a failed write, or the row was pruned)'), rep.notes.join('|'))
  assert.ok(rep.notes.includes('not-judgeable question rows by code: question-multi 1, question-scope 2'), rep.notes.join('|'))
  assert.equal(rep.notes.some((n) => /older than 90 days/.test(n)), false)
  const old = BASE - 100 * 86400_000
  qfile(fx, [qrow({ t: iso(BASE) }), qrow({ t: iso(old), id: uid(9), question: 'An old one?' }), qrow({ t: iso(BASE), id: uid(8), tier: 'manager', via: 'person', question: 'q'.repeat(300), header: 'Name', label: 'Beta' }), 'junk'])
  rep = run(fx)
  assert.equal(rep.notes.some((n) => /no questions row/.test(n)), false)
  assert.ok(rep.notes.includes('1 questions row(s) are older than 90 days (the prune is behind)'), rep.notes.join('|'))
  assert.equal(rep.questions.count, 4)
  assert.equal(rep.questions.list.length, 3)
  assert.equal(rep.questions.unreadable, 1)
  const text = render(rep)
  assert.match(text, /QUESTIONS: 4 row\(s\) in 1 file\(s\)/)
  assert.match(text, /time\s+lane\s+tier\s+header\s+question\s+label/)
  assert.match(text, /api\s+lead\s+Color\s+Which color\?\s+Green/)
  assert.match(text, /api\s+person via manager\s+Name\s+q{150,}~?\s+Beta/)
  assert.doesNotMatch(text, /q{201}/)
  assert.match(text, /1 row\(s\) were not valid JSON objects/)
  // --since keeps the old row out of the listing, but the note still counts it.
  rep = run(fx, { since: BASE - 3600_000 })
  assert.equal(rep.questions.list.length, 2)
  assert.ok(rep.notes.some((n) => /1 questions row\(s\) are older than 90 days/.test(n)))
})
test('questions: a relayed question is listed with the lane\'s own question, found by id with no cap on the file', () => {
  const fx = fixture()
  ledger(fx, [ON(), ASKS(), ...qPerson({ label: 'Green' })])
  relayTranscript(fx, MGR, { answer: 'Green' })
  // 250 earlier rows: the listing keeps 200, the join finds the row at the end all the same.
  const filler = Array.from({ length: 250 }, (_, i) => qrow({ t: iso(BASE - 1000 + i), id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, question: `Filler ${i}?` }))
  qfile(fx, [...filler, qrow({ tier: 'manager', via: 'person', question: 'Which color should the page use?', header: 'Color' })])
  const rep = run(fx)
  assert.equal(rep.questions.count, 251)
  assert.equal(rep.questions.list.length, 200)
  assert.deepEqual(rep.anomalies, [])
  assert.equal(rep.notes.some((n) => /no questions row/.test(n)), false)
  assert.equal(rep.notAnomalies.relayedQuestions[0].laneQuestion.question, 'Which color should the page use?')
  assert.match(render(rep), /the lane asked: \[Color\] Which color should the page use\? \(options: Red \| Green\)/)
})

// The audit keeps its own copy of the row kinds the mod writes (it is a stand-alone script and must not import the mod). A kind added to the mod and not here would make the
// audit drop those rows as not valid, so the two lists are compared as they are written in the sources.
test('the audit reads exactly the row kinds the mod writes', () => {
  const quoted = (text) => (text.match(/'([^']+)'/g) ?? []).map((q) => q.slice(1, -1))
  const mod = readFileSync(new URL('./mod/hooks/prompts.ts', import.meta.url), 'utf8')
  const mine = readFileSync(new URL('./prompt-audit.mjs', import.meta.url), 'utf8')
  const written = /export type RowKind = ([^\n]+)/.exec(mod)
  const read = /const KINDS = new Set\(\[([^\]]+)\]\)/.exec(mine)
  assert.ok(written && read, 'both lists were found')
  assert.ok(quoted(written[1]).length > 10)
  assert.deepEqual(quoted(read[1]).sort(), quoted(written[1]).sort())
})

test('labelFromText: the label of the quoted pair, undefined when the pair is absent, null when a quote inside the label cuts it short, at most 256 characters', () => {
  assert.equal(labelFromText('User has answered: "Allow x?"="Yes".', 'Allow x?'), 'Yes')
  assert.equal(labelFromText('"Allow x?"="No", "other"="a"', 'Allow x?'), 'No')
  assert.equal(labelFromText('"Allow x?"="Yes"', 'Allow x?'), 'Yes')
  assert.equal(labelFromText('"Other?"="Yes"', 'Allow x?'), undefined)
  assert.equal(labelFromText('"Allow x?"="Say "hi" now"', 'Allow x?'), null)
  assert.equal(labelFromText(`"Allow x?"="${'a'.repeat(300)}"`, 'Allow x?'), 'a'.repeat(256))
})

// Two more pieces the audit mirrors from the mod, compared as they are written in the sources: the id shape of a ledger row, and the hash that stands for a chosen label.
test('the audit reads an id as the mod writes it, and hashes a label by the mod\'s formula', () => {
  const mod = readFileSync(new URL('./mod/hooks/core.ts', import.meta.url), 'utf8')
  const answering = readFileSync(new URL('./mod/hooks/engine/answer-hook.ts', import.meta.url), 'utf8')
  const mine = readFileSync(new URL('./prompt-audit.mjs', import.meta.url), 'utf8')
  const idRe = /const ID_RE = (\/.+\/)\n/.exec(mine)
  const sidRe = /export const SID_RE = (\/.+\/)\n/.exec(mod)
  assert.ok(idRe && sidRe, 'both id patterns were found')
  assert.equal(idRe[1], sidRe[1])
  const theirs = /async function labelHash\([^)]*\)[^{]*\{\s*return \(await sha\(\$, (`[^`]+`)\)\)(\.slice\(0, 16\))\s*\}/.exec(answering)
  const ours = /const labelHash = [^\n]*update\((`[^`]+`)\)\.digest\('hex'\)(\.slice\(0, 16\))/.exec(mine)
  assert.ok(theirs && ours, 'both label hashes were found')
  assert.deepEqual(ours.slice(1), theirs.slice(1))
})
