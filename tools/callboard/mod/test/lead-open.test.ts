import { expect } from 'claude-code/testing'
import { REASON_TEXT } from '../hooks/core'
import * as c from '../hooks/core'
import { toasts, h, SID, pdirs, teeTexts, OFFERS_DIR, longTest, PROMPTS_DIR, ROOT, T0, extraStat, leadFiles, pfs } from './harness'
import { ledgerRows } from './answer-fixtures'
import { ticks, CSESS, LEADPS, OTHERLEAD, PIN, condOn, leadAt, regAs } from './fixtures'

const call = (over: Record<string, unknown> = {}) => ({ tool: 'mcp__callboard__lead_open', repo: PIN, name: 'LEAD-N', task: 'Do the work.', ...over }) as any
const NEWSID = '12345678-aaaa-4bbb-8ccc-dddddddddddd'
const KEY = 'a'.repeat(64)
const LEDGER = `${PROMPTS_DIR}/ledger-2023-11.jsonl`
const RESULT = `${ROOT}/open/LEAD-N.result`
const offers = () => [...pfs.keys()].filter((k) => k.startsWith(`${OFFERS_DIR}/`))
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString()
const seedRows = (...rows: Record<string, unknown>[]) => pfs.set(LEDGER, { text: rows.map((r) => JSON.stringify({ hash: KEY, nonce: 'n', ...r })).join('\n') + '\n', mtimeSec: T0 / 1000 })
const mvs = (argv: string[][], needle: string) => argv.filter((a) => a[0] === '/bin/mv' && a.some((x) => x.includes(needle)))
const cueTexts = (argv: string[][]) => mvs(argv, `${ROOT}/cue/`).map((a) => teeTexts.get(a[3]))

async function conductor($: any, on: any, argv: string[][], opts: { sess?: Record<string, string>; seed?: () => void } = {}) {
  await condOn($, on, [], { clock: true, argv, sess: opts.sess, seed: opts.seed })
  extraStat.set(ROOT, '501 700 2 Directory 8 64 1700000000\n')
  h.openResultPath = RESULT
}
// One call; `answer` is what the window writes into the result file once the request is out.
async function open($: any, answer?: string, over: Record<string, unknown> = {}) {
  const p = $.tool.call(call(over))
  if (answer !== undefined) {
    await h.clock!.advance(500)
    h.openResult = answer
    await h.clock!.advance(500)
  }
  return JSON.stringify(await p)
}
// A refusal before the first write leaves no ledger row, no offer, no brief and no request.
const wroteNothing = (argv: string[][]) => {
  expect(ledgerRows()).toEqual([])
  expect(offers()).toEqual([])
  expect(mvs(argv, '/BRIEF.md')).toEqual([])
  expect(mvs(argv, '.lead')).toEqual([])
}

longTest('lead_open opens a panel, writes the brief, cues it and reports the lead on: no void row, the offer and claim gone', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const r = await open($, `ok ${NEWSID}\n`)
  expect(r).toContain('lead LEAD-N is on as session 12345678')
  expect(r).not.toContain('model you asked for')
  expect(ledgerRows().map((x) => x.kind)).toEqual(['lead-offer'])
  expect(ledgerRows()[0]).toMatchObject({ hash: KEY, repo: PIN, lane: 'LEAD-N' })
  expect(offers()).toEqual([])
  expect(cueTexts(argv)).toEqual([`lead ${ledgerRows()[0].nonce}\n`])
  expect(mvs(argv, `${PIN}/.archive/LEAD-N/BRIEF.md`).length).toBeGreaterThan(0)
  expect(mvs(argv, `${ROOT}/open/LEAD-N.lead`).length).toBe(1)
  expect(ledgerRows().some((x) => x.kind === 'lead-grant')).toBe(false)
})

// The answer a window of the nonce-echoing extension writes: the request's nonce is the one the ledger row carries.
// The window answers after `waitMs` (a multiple of 500), with the nonce of the request's own ledger row.
async function openEchoing($: any, nonce: (real: string) => string, waitMs = 500) {
  const p = $.tool.call(call())
  for (let waited = 0; waited < waitMs; waited += 500) await h.clock!.advance(500)
  const real = String(ledgerRows().filter((x) => x.kind === 'lead-offer').slice(-1)[0].nonce)
  h.openResult = `ok ${NEWSID} ${nonce(real)}\n`
  await h.clock!.advance(500)
  return JSON.stringify(await p)
}

longTest('lead_open takes an answer that echoes the request nonce, one with none, and refuses one that names another nonce', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(await openEchoing($, (n) => n)).toContain('lead LEAD-N is on as session 12345678')
  expect(await open($, `ok ${NEWSID}\n`)).toContain('lead LEAD-N is on as session')
  const briefs = mvs(argv, '/BRIEF.md').length
  const takenBack = () => argv.filter((a) => a[0] === '/bin/rm' && a[a.length - 1] === `${ROOT}/open/LEAD-N.lead`).length
  const rmBefore = takenBack()
  const bad = await openEchoing($, () => 'f'.repeat(32))
  expect(takenBack()).toBe(rmBefore + 1)
  expect(bad).toContain('lead_open refused: bad-result: the window answer was not valid.')
  expect(mvs(argv, '/BRIEF.md').length).toBe(briefs)
  expect(offers()).toEqual([])
})

longTest('a lead panel is waited for up to 50 s: an answer at 30 s is taken, a window silent for the whole wait is not', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(await openEchoing($, (n) => n, 30_000)).toContain('lead LEAD-N is on as session')
  const p = $.tool.call(call({ name: 'LEAD-M' }))
  let done = false
  void p.then(() => { done = true })
  for (let i = 0; i < 45; i++) await h.clock!.advance(1000)
  expect(done).toBe(false)
  for (let i = 0; i < 10; i++) await h.clock!.advance(1000)
  expect(JSON.stringify(await p)).toContain('no window answered in time')
})

longTest('lead_open refuses before any write: repo, name, task and model that fail their checks, and a repo outside the conductor\'s reach', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const refused = async (over: Record<string, unknown>, code: string) => {
    expect(await open($, undefined, over), code).toContain(`lead_open refused: ${code}`)
    wroteNothing(argv)
  }
  await refused({ repo: 'app' }, 'bad-repo')
  await refused({ name: 'lead n' }, 'bad-name')
  await refused({ name: 'MANAGER' }, 'reserved-name')
  await refused({ task: '' }, 'bad-task')
  await refused({ model: 'gpt' }, 'bad-model')
  await refused({ repo: '/Users/x/code/other' }, 'not-in-reach')
  await refused({ repo: '/Users/x/code/cond' }, 'not-in-reach')
})

longTest('lead_open refuses a name a lane or a live session carries, in any letter case, and a request already waiting for that name', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  await open($, undefined, { name: 'api' }).then((r) => expect(r).toContain(REASON_TEXT['name-in-use']))
  wroteNothing(argv)
  h.openList = [{ name: 'LEAD-N.open', kind: 'file', size: 9, mtimeMs: 0, isLink: false }]
  expect(await open($)).toContain(REASON_TEXT['name-in-open'])
  h.openList = [{ name: 'lead-n.Reopen', kind: 'file', size: 9, mtimeMs: 0, isLink: false }]
  expect(await open($)).toContain(REASON_TEXT['name-in-open'])
  wroteNothing(argv)
  // A result file left over is no request.
  h.openList = [{ name: 'LEAD-N.result', kind: 'file', size: 9, mtimeMs: 0, isLink: false }]
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

longTest('lead_open refuses when the repo has a live lead (whoever made it), an offer or a claim is in place, or the hour is spent; each writes nothing', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv, {
    sess: { ...CSESS(), ...regAs(OTHERLEAD, 4243, 'LEAD-A') },
    seed: () => leadFiles.set(`${ROOT}/leads/${OTHERLEAD}.json`, { text: JSON.stringify({ sid: OTHERLEAD, pid: 4243, procStart: LEADPS, repo: PIN }) }),
  })
  expect(await open($)).toContain(REASON_TEXT['lead-exists'])
  wroteNothing(argv)
  leadFiles.clear()
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: '{}', mtimeSec: T0 / 1000 })
  expect(await open($)).toContain(REASON_TEXT['offer-open'])
  pfs.delete(`${OFFERS_DIR}/${KEY}.json`)
  pfs.set(`${OFFERS_DIR}/${KEY}.claim`, { text: '', mtimeSec: T0 / 1000 })
  expect(await open($)).toContain(REASON_TEXT['offer-open'])
  pfs.delete(`${OFFERS_DIR}/${KEY}.claim`)
  expect(ledgerRows()).toEqual([])
  expect(mvs(argv, '.lead')).toEqual([])
  seedRows({ kind: 'lead-grant', t: iso(10 * 60_000) })
  expect(await open($)).toContain(REASON_TEXT['open-rate'])
  expect(mvs(argv, '.lead')).toEqual([])
  expect(offers()).toEqual([])
})

longTest('lead_open: three offers in an hour use the repo up, a failing open included; an offer older than the hour does not count', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  seedRows({ kind: 'lead-offer', t: iso(61 * 60_000) }, { kind: 'lead-offer', t: iso(62 * 60_000) }, { kind: 'lead-offer', t: iso(63 * 60_000) })
  expect(await open($, 'error failed\n')).toContain('the panel did not open')
  expect(offers()).toEqual([])
  for (const code of ['timeout', 'unnamed-panel']) {
    h.openResult = undefined
    expect(await open($, `error ${code}\n`)).toContain('lead_open refused')
    expect(offers()).toEqual([])
  }
  h.openResult = undefined
  expect(await open($)).toContain(REASON_TEXT['open-rate'])
  expect(ledgerRows().map((x) => x.kind).filter((k) => k === 'lead-offer').length).toBe(3 + 3)
  expect(ledgerRows().filter((x) => x.kind === 'lead-offer-void').length).toBe(3)
  expect(ledgerRows().some((x) => x.kind === 'lead-grant')).toBe(false)
  expect(mvs(argv, '.lead').length).toBe(3)
})

longTest('a write that fails after the ledger row takes the offer back and voids the row with its code; nothing is left to block the next try', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.pfsFails = (a: string[]) => a[0] === '/bin/ln' && a.some((x) => x.startsWith(OFFERS_DIR))
  expect(await open($)).toContain(REASON_TEXT['offer-write'])
  expect(ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)).toEqual(['lead-offer', 'lead-offer-void offer-write'])
  expect(offers()).toEqual([])
  expect(mvs(argv, '.lead')).toEqual([])
  h.pfsFails = undefined
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

longTest('a throw while the request is written takes the offer back and voids it; an offer left behind is removed once it is ten minutes old, not before', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.mvHook = (path: string) => {
    if (path.endsWith('/open/LEAD-N.lead')) throw new Error('boom')
  }
  expect(await open($)).toContain('lead_open')
  h.mvHook = undefined
  expect(ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)).toEqual(['lead-offer', 'lead-offer-void offer-write'])
  expect(offers()).toEqual([])
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: '{}', mtimeSec: T0 / 1000 - 9 * 60 })
  expect(await open($)).toContain(REASON_TEXT['offer-open'])
  expect(pfs.has(`${OFFERS_DIR}/${KEY}.json`)).toBe(true)
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: '{}', mtimeSec: T0 / 1000 - 11 * 60 })
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
  expect(offers()).toEqual([])
})

longTest('a brief that cannot be written sends no cue: the offer is voided as brief-write and the panel stays an ordinary one', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.mvHook = (path: string) => {
    if (path.endsWith('/LEAD-N/BRIEF.md')) throw new Error('boom')
  }
  const r = await open($, `ok ${NEWSID}\n`)
  h.mvHook = undefined
  expect(r).toContain('lead_open refused: lead panel opened for LEAD-N')
  expect(r).toContain('its brief could not be written')
  expect(ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)).toEqual(['lead-offer', 'lead-offer-void brief-write'])
  expect(offers()).toEqual([])
  expect(mvs(argv, `${ROOT}/cue/`)).toEqual([])
})

longTest('the window never answering takes the offer back and says a panel may still appear; the conductor can ask again after', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const p = $.tool.call(call())
  for (let i = 0; i < 140; i++) await h.clock!.advance(1000)
  const r = JSON.stringify(await p)
  expect(r).toContain('no window answered in time')
  expect(offers()).toEqual([])
  expect(mvs(argv, '/BRIEF.md')).toEqual([])
  expect(ledgerRows().map((x) => x.kind)).toEqual(['lead-offer', 'lead-offer-void'])
  h.openResult = undefined
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

longTest('one open at a time per conductor: a second call while the first waits is refused, and the first still finishes', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const first = $.tool.call(call())
  await h.clock!.advance(500)
  expect(JSON.stringify(await $.tool.call(call({ name: 'LEAD-M' })))).toContain(REASON_TEXT['open-in-flight'])
  h.openResult = `ok ${NEWSID}\n`
  await h.clock!.advance(500)
  expect(JSON.stringify(await first)).toContain('is on as session')
  expect(mvs(argv, '.lead').length).toBe(1)
})

longTest('config conductor-leads off makes the tool refuse and writes nothing; on lets it through again', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.store.set('config', { conductorLeads: false, savedAt: h.nowMs })
  expect(await open($)).toContain(REASON_TEXT['conductor-leads-off'])
  wroteNothing(argv)
  h.store.set('config', { conductorLeads: true, savedAt: h.nowMs })
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
})

longTest('a settings read that fails makes lead_open refuse and write nothing, the switch not being checkable', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.storeThrowSync = 'get'
  const r = await open($)
  h.storeThrowSync = undefined
  expect(r).toContain(REASON_TEXT['config-unreadable'])
  wroteNothing(argv)
})

longTest('only a conductor has lead_open: a lead that calls it is refused, and nothing is written', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { argv, clock: true })
  extraStat.set(ROOT, '501 700 2 Directory 8 64 1700000000\n')
  expect(await open($)).toContain(REASON_TEXT['not-conductor'])
  wroteNothing(argv)
})

// A call that runs on until it ends: the window answers the open at once and the clock moves a second at a time (a wait for a held cue is a sleep).
async function openAdv($: any) {
  const p = $.tool.call(call())
  let done = false
  void p.then(() => { done = true })
  await h.clock!.advance(500)
  h.openResult = `ok ${NEWSID}\n`
  for (let i = 0; i < 80 && !done; i++) await h.clock!.advance(1000)
  return JSON.stringify(await p)
}
const nonceOf = () => String(ledgerRows().filter((x) => x.kind === 'lead-offer').slice(-1)[0].nonce)
const kinds = () => ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)

longTest('an ok answer that says model-unset tells the conductor the model was not changed', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'ok model-unset'
  const r = await open($, `ok ${NEWSID}\n`)
  expect(r).toContain('is on as session 12345678')
  expect(r).toContain('The model you asked for was not changed')
  expect(kinds()).toEqual(['lead-offer'])
})

longTest('a panel that is not ready twice is given up: offer and claim taken back, the row voided with the reason, the panel named', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'held draft-in-box'
  const r = await openAdv($)
  expect(cueTexts(argv)).toEqual([`lead ${nonceOf()}\n`, `lead ${nonceOf()}\n`])
  expect(r).toContain('it was not ready: draft-in-box')
  expect(r).toContain('the panel now carries that name, but it did not become a lead')
  expect(kinds()).toEqual(['lead-offer', 'lead-offer-void draft-in-box'])
  expect(offers()).toEqual([])
})

longTest('a panel that is not ready once and then ok is taken on the second cue', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'held not-idle'
  h.cueWriteHook = () => {
    if (cueTexts(argv).length >= 1) h.autoAnswer = 'ok -'
  }
  const r = await openAdv($)
  expect(r).toContain('is on as session 12345678')
  expect(cueTexts(argv).length).toBe(2)
  expect(kinds()).toEqual(['lead-offer'])
})

longTest('a refusal from the panel takes the offer and claim back and voids the row; the hour is not spent', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = 'refused offer-mismatch'
  const r = await open($, `ok ${NEWSID}\n`)
  expect(r).toContain('did not become a lead: offer-mismatch')
  expect(kinds()).toEqual(['lead-offer', 'lead-offer-void offer-mismatch'])
  expect(offers()).toEqual([])
  expect(cueTexts(argv).length).toBe(1)
})

longTest('no answer to the cue takes nothing back and says the panel may still become the lead', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.autoAnswer = undefined
  const p = $.tool.call(call())
  await h.clock!.advance(500)
  h.openResult = `ok ${NEWSID}\n`
  for (let i = 0; i < 60; i++) await h.clock!.advance(1000)
  const r = JSON.stringify(await p)
  expect(r).toContain('may still become the lead')
  expect(kinds()).toEqual(['lead-offer'])
  expect(offers().length).toBe(1)
})

// ---- the offer sweep ----
const staleOffer = (over: Record<string, unknown> = {}) =>
  c.offerText({ v: 1, name: 'LEAD-N', repo: PIN, model: 'sonnet', conductor: { sid: SID, pid: 4242, start: 'x' }, at: T0 - 11 * 60_000, nonce: 'b'.repeat(32), ...over } as any)

longTest('a conductor takes away its own offer nobody answered once it is ten minutes old: the row is voided as expired, the offer and claim go', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  pdirs.add(OFFERS_DIR)
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: staleOffer(), mtimeSec: T0 / 1000 - 11 * 60 })
  pfs.set(`${OFFERS_DIR}/${KEY}.claim`, { text: 'x', mtimeSec: T0 / 1000 - 11 * 60 })
  seedRows({ kind: 'lead-offer', t: iso(11 * 60_000), nonce: 'b'.repeat(32), by: SID })
  await ticks(32)
  expect(kinds()).toEqual(['lead-offer', 'lead-offer-void expired'])
  expect(offers()).toEqual([])
})

longTest('the sweep leaves a young offer, another conductor\'s offer and an offer already closed by a grant or void alone (the last only loses its files)', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  pdirs.add(OFFERS_DIR)
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: staleOffer(), mtimeSec: T0 / 1000 - 5 * 60 })
  seedRows({ kind: 'lead-offer', t: iso(11 * 60_000), nonce: 'b'.repeat(32), by: SID })
  await ticks(32)
  expect(offers().length).toBe(1)
  expect(kinds()).toEqual(['lead-offer'])
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: staleOffer({ conductor: { sid: OTHERLEAD, pid: 4243, start: 'x' } }), mtimeSec: T0 / 1000 - 11 * 60 })
  await ticks(32)
  expect(offers().length).toBe(1)
  pfs.set(`${OFFERS_DIR}/${KEY}.json`, { text: staleOffer(), mtimeSec: T0 / 1000 - 11 * 60 })
  seedRows({ kind: 'lead-offer', t: iso(11 * 60_000), nonce: 'b'.repeat(32), by: SID }, { kind: 'lead-grant', t: iso(10 * 60_000), nonce: 'b'.repeat(32) })
  await ticks(32)
  expect(offers()).toEqual([])
  expect(kinds()).toEqual(['lead-offer', 'lead-grant'])
})

// ---- the conductor's check on grants in its name ----
const unasked = () => toasts.filter((t) => t.includes('has no record of asking for it'))

longTest('a grant row in the conductor\'s name for a nonce it never offered is toasted once; one it offered, one by another session and an old one are not', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  expect(await open($, `ok ${NEWSID}\n`)).toContain('is on as session')
  const mine = nonceOf()
  const row = (over: Record<string, unknown>) => ({ kind: 'lead-grant', hash: 'c'.repeat(64), repo: PIN, lane: 'LEAD-X', by: SID, ...over })
  seedRows(
    { kind: 'lead-offer', t: iso(1000), hash: KEY, nonce: mine, by: SID },
    row({ t: iso(1000), nonce: mine }),
    row({ t: iso(2000), nonce: 'd'.repeat(32), by: OTHERLEAD }),
    row({ t: iso(25 * 3_600_000), nonce: 'e'.repeat(32) }),
  )
  await ticks(32)
  expect(unasked()).toEqual([])
  seedRows(row({ t: iso(1000), nonce: 'f'.repeat(32) }))
  await ticks(32)
  expect(unasked().length).toBe(1)
  expect(unasked()[0]).toContain('LEAD-X')
  await ticks(64)
  expect(unasked().length).toBe(1)
})
