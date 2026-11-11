import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, lstatSync, readFileSync, utimesSync, truncateSync, rmSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audit, render, eachLine, floorShape, percentile, LEDGER_MAX_BYTES } from './prompt-audit.mjs'

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
function transcript(fx, name, { at, source = 'hook', decision = 'accept', tool = 'mcp__github__add_issue_comment', nested = false, useId = 'toolu_01', permReq = source === 'hook', attAfter = false, attEvent = 'PermissionRequest', reasonCode }) {
  const dir = join(fx.projects, '-Users-x-api')
  mkdirSync(dir, { recursive: true })
  const use = { type: 'assistant', sessionId: SID, timestamp: iso(at - 1000), message: { content: [{ type: 'tool_use', id: useId, name: tool, input: {} }] } }
  const pd = { decision, source, reasonType: 'hook', ...(reasonCode ? { reasonCode } : {}) }
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
  const bad = ['no-answered-row', 'id', 'hash', 'nonce', 'by-sid']
  const fine = ['expired', 'ledger-unreadable', 'file', 'shape', 'floor']
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

test('d: a floor row for the same tool, hash and floor context makes a later request an anomaly', () => {
  const fx = fixture()
  const C1 = 'c'.repeat(16)
  const rows = [ON(), R('floor', BASE - 1000, { ...T, ctx: C1, code: 'merge' }), ...clean(uid(1), BASE, uid(101), { ctx: C1 })]
  ledger(fx, rows)
  assert.deepEqual(rules(run(fx)), ['floor-row-then-asked'])
  const other = [ON(), R('floor', BASE - 1000, { ...T, hash: H('b'), ctx: C1, code: 'merge' }), ...clean(uid(1), BASE, uid(101), { ctx: C1 })]
  ledger(fx, other)
  assert.deepEqual(run(fx).anomalies, [])
})
test('review r2: the same input asked under another branch or config (another floor context) is not an anomaly; rows with no context are a note', () => {
  const fx = fixture()
  // A push floored on main, the identical call asked after a checkout of a feature branch.
  const changed = [ON(), R('floor', BASE - 1000, { ...T, ctx: 'a'.repeat(16), code: 'protected-push' }), ...clean(uid(1), BASE, uid(101), { ctx: 'b'.repeat(16) })]
  ledger(fx, changed)
  let rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.deepEqual(rep.notes.filter((n) => /floor context/.test(n)), [])
  // Rows from before the context was recorded cannot be compared: a note, not an anomaly.
  const old = [ON(), R('floor', BASE - 1000, { ...T, code: 'protected-push' }), ...clean()]
  ledger(fx, old)
  rep = run(fx)
  assert.deepEqual(rep.anomalies, [])
  assert.ok(rep.notes.some((n) => /1 request\(s\) share a tool and input hash with a floor row that recorded no floor context/.test(n)), rep.notes.join('|'))
})

test('d: a request that looks like a floor item by its tool or path is an anomaly', () => {
  const fx = fixture()
  const merge = clean(uid(1), BASE, uid(101), { tool: 'mcp__github__merge_pull_request', pattern: 'mcp__github__merge_pull_request x/y #3', hash: H('c') })
  const branch = clean(uid(2), BASE + 1000, uid(102), { tool: 'mcp__github__update_pull_request_branch', pattern: 'mcp__github__update_pull_request_branch x/y #3', hash: H('d') })
  const settings = clean(uid(3), BASE + 2000, uid(103), { tool: 'Edit', pattern: 'Edit .claude/settings.json', hash: H('e') })
  const ok = clean(uid(4), BASE + 3000, uid(104), { tool: 'Edit', pattern: 'Edit src/app.ts', hash: H('f') })
  ledger(fx, [ON(), ...merge, ...branch, ...settings, ...ok])
  const rep = run(fx)
  assert.deepEqual(rules(rep), ['floor-shape-asked', 'floor-shape-asked', 'floor-shape-asked'])
  assert.deepEqual(rep.anomalies.map((a) => a.id).sort(), [uid(1), uid(2), uid(3)])
  assert.equal(floorShape('mcp__machine-ops__reboot', 'x'), 'tool mcp__machine-ops__reboot')
  assert.equal(floorShape('Bash', 'git'), undefined)
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

test('review: a project hooks folder or settings.json is not a floor path; the hook\'s own paths are', () => {
  for (const p of ['Edit src/hooks/useAuth.ts', 'Edit .vscode/settings.json', 'Write app/settings.json', 'Edit hooks/a.sh']) assert.equal(floorShape('Edit', p), undefined, p)
  for (const p of ['Edit .claude/settings.json', 'Edit .claude/settings.local.json', 'Edit .claude/hooks/guard.sh', 'Edit .git/hooks/pre-commit', 'Edit .husky/pre-push', 'Edit .githooks/x', 'Edit .claude/callboard/state', 'Write .mcp.json']) assert.match(String(floorShape('Edit', p)), /^path in /, p)
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
function leadTranscript(fx, sid, calls, name = 'mcp__callboard__prompt_answer') {
  const dir = join(fx.projects, '-Users-x-lead')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sid}.jsonl`), lines(calls.map((id, i) => ({ type: 'assistant', sessionId: sid, timestamp: iso(BASE + 30_000 + i), message: { content: [{ type: 'tool_use', id: `toolu_${i}`, name, input: { id, decision: 'allow', why: 'reads only' } }] } }))))
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
