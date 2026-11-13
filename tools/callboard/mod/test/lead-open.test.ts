import { expect } from 'claude-code/testing'
import { REASON_TEXT } from '../hooks/core'
import { h, OFFERS_DIR, longTest, PROMPTS_DIR, ROOT, T0, extraStat, leadFiles, pfs } from './harness'
import { ledgerRows } from './answer-fixtures'
import { CSESS, LEADPS, OTHERLEAD, PIN, condOn, leadAt, regAs } from './fixtures'

const call = (over: Record<string, unknown> = {}) => ({ tool: 'mcp__callboard__lead_open', repo: PIN, name: 'LEAD-N', task: 'Do the work.', ...over }) as any
const NEWSID = '12345678-aaaa-4bbb-8ccc-dddddddddddd'
const KEY = 'a'.repeat(64)
const LEDGER = `${PROMPTS_DIR}/ledger-2023-11.jsonl`
const RESULT = `${ROOT}/open/LEAD-N.result`
const offers = () => [...pfs.keys()].filter((k) => k.startsWith(`${OFFERS_DIR}/`))
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString()
const seedRows = (...rows: Record<string, unknown>[]) => pfs.set(LEDGER, { text: rows.map((r) => JSON.stringify({ hash: KEY, nonce: 'n', ...r })).join('\n') + '\n', mtimeSec: T0 / 1000 })
const mvs = (argv: string[][], needle: string) => argv.filter((a) => a[0] === '/bin/mv' && a.some((x) => x.includes(needle)))

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

longTest('lead_open opens a panel: ledger row, offer, brief and request in order; the answer takes the offer back and voids it as panel-only', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const r = await open($, `ok ${NEWSID}\n`)
  expect(r).toContain('lead panel opened for LEAD-N as session 12345678')
  expect(ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)).toEqual(['lead-offer', 'lead-offer-void panel-only'])
  expect(ledgerRows()[0]).toMatchObject({ hash: KEY, repo: PIN, lane: 'LEAD-N' })
  expect(ledgerRows()[0].nonce).toBe(ledgerRows()[1].nonce)
  expect(offers()).toEqual([])
  expect(mvs(argv, `${PIN}/.archive/LEAD-N/BRIEF.md`).length).toBeGreaterThan(0)
  expect(mvs(argv, `${ROOT}/open/LEAD-N.lead`).length).toBe(1)
  expect(ledgerRows().some((x) => x.kind === 'lead-grant')).toBe(false)
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
  expect(await open($, `ok ${NEWSID}\n`)).toContain('lead panel opened')
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
  expect(await open($, `ok ${NEWSID}\n`)).toContain('lead panel opened')
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
  expect(await open($, `ok ${NEWSID}\n`)).toContain('lead panel opened')
  expect(offers()).toEqual([])
})

longTest('a throw after the window answered leaves the panel standing: the conductor is told it opened and the brief is missing; one void row only', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.mvHook = (path: string) => {
    if (path.endsWith('/LEAD-N/BRIEF.md')) throw new Error('boom')
  }
  const r = await open($, `ok ${NEWSID}\n`)
  h.mvHook = undefined
  expect(r).toContain('lead panel opened for LEAD-N')
  expect(r).toContain('its brief could not be written')
  expect(ledgerRows().map((x) => `${x.kind}${x.code ? ` ${x.code}` : ''}`)).toEqual(['lead-offer', 'lead-offer-void panel-only'])
  expect(offers()).toEqual([])
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
  expect(await open($, `ok ${NEWSID}\n`)).toContain('lead panel opened')
})

longTest('one open at a time per conductor: a second call while the first waits is refused, and the first still finishes', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  const first = $.tool.call(call())
  await h.clock!.advance(500)
  expect(JSON.stringify(await $.tool.call(call({ name: 'LEAD-M' })))).toContain(REASON_TEXT['open-in-flight'])
  h.openResult = `ok ${NEWSID}\n`
  await h.clock!.advance(500)
  expect(JSON.stringify(await first)).toContain('lead panel opened')
  expect(mvs(argv, '.lead').length).toBe(1)
})

longTest('config conductor-leads off makes the tool refuse and writes nothing; on lets it through again', async ($, on) => {
  const argv: string[][] = []
  await conductor($, on, argv)
  h.store.set('config', { conductorLeads: false, savedAt: h.nowMs })
  expect(await open($)).toContain(REASON_TEXT['conductor-leads-off'])
  wroteNothing(argv)
  h.store.set('config', { conductorLeads: true, savedAt: h.nowMs })
  expect(await open($, `ok ${NEWSID}\n`)).toContain('lead panel opened')
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
