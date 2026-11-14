import { expect } from 'claude-code/testing'
import * as c from '../hooks/core'
import { h, longTest, pfs, pdirs, OFFERS_DIR, PROMPTS_DIR, ROOT, SID, T0, extraStat, laneSeed, leadFiles, modelRuns, renames, resultFiles, toasts } from './harness'
import { ledgerRows } from './answer-fixtures'
import { COND, KEY, LEADPS, OTHERLEAD, PIN, RESULT, cue, condPresenceOf, dirStat, grantAt, lane, leadFileText, leadReg, LEADPATH, logged, putCond, regAs, started, tickTwice, ticks, waitFor } from './fixtures'

// The new panel taking a conductor's lead offer (ADR 0006). The session under test is the new panel (SID) in PIN; the conductor (OTHERLEAD, CONDX) is a fixture
// with its registry row, presence file, saved grant and list file, as the lead's compact-cue tests build it.
const NONCE = '0123456789abcdef0123456789abcdef'
const LEDGER = `${PROMPTS_DIR}/ledger-2023-11.jsonl`
const OFFER_PATH = `${OFFERS_DIR}/${KEY}.json`
const CLAIM_PATH = `${OFFERS_DIR}/${KEY}.claim`
const CUE = `lead ${NONCE}\n`
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString()
const panel = (over: Record<string, unknown> = {}) => ({
  '4300.json': JSON.stringify({ sessionId: SID, name: 'quiet-fox', nameSource: 'auto', cwd: PIN, status: 'idle', pid: 4300, procStart: LEADPS, startedAt: T0 - 30_000, statusUpdatedAt: T0 - 10_000, kind: 'interactive', ...over }),
})
const offerOf = (over: Record<string, unknown> = {}) => ({ v: 1, name: 'LEAD-N', repo: PIN, model: 'haiku', conductor: { sid: OTHERLEAD, pid: 4243, start: LEADPS }, at: T0 - 5_000, nonce: NONCE, ...over })
const offerRow = (over: Record<string, unknown> = {}) => ({ t: iso(5_000), kind: 'lead-offer', hash: KEY, repo: PIN, lane: 'LEAD-N', nonce: NONCE, by: OTHERLEAD, ...over })
const offers = () => [...pfs.keys()].filter((k) => k.startsWith(`${OFFERS_DIR}/`))
const grantRows = () => ledgerRows().filter((r) => r.kind === 'lead-grant')
const leadKey = () => h.store.get(`lead:${SID}`)

type Setup = {
  stdins?: string[]
  panel?: Record<string, unknown>
  offer?: Record<string, unknown> | string | null
  rows?: Record<string, unknown>[]
  extra?: Record<string, string>
  seed?: () => void
  bound?: boolean
  noOwnRow?: boolean
}
async function accepting($: any, on: any, o: Setup = {}) {
  laneSeed.text = undefined
  h.ownEntryAuto = false
  h.sessions = { ...(o.noOwnRow ? {} : panel(o.panel)), ...regAs(OTHERLEAD, 4243, 'CONDX'), ...o.extra }
  await started($, on, o.stdins ?? [], { clock: true, bound: o.bound })
  h.callerCwd = PIN
  h.onRename = (name) => { h.sessions = { ...panel({ ...o.panel, name }), ...regAs(OTHERLEAD, 4243, 'CONDX'), ...o.extra } }
  extraStat.set(ROOT, '501 700 2 Directory 8 64 1700000000\n')
  extraStat.set(`${PIN}/.git`, dirStat)
  extraStat.set(`${COND}/.git`, dirStat)
  putCond(['../app'])
  h.store.set(`conductor:${OTHERLEAD}`, { home: COND, repos: [PIN], savedAt: T0 - 60_000 })
  condPresenceOf(OTHERLEAD, 4243, 'CONDX', [PIN])
  pdirs.add(OFFERS_DIR)
  if (o.offer !== null) pfs.set(OFFER_PATH, { text: typeof o.offer === 'string' ? o.offer : c.offerText(offerOf(o.offer) as any), mtimeSec: (T0 - 5_000) / 1000 })
  const rows = o.rows ?? [offerRow()]
  pfs.set(LEDGER, { text: rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), mtimeSec: T0 / 1000 })
  o.seed?.()
}
// A refusal leaves a plain panel: no grant row, no saved lead, no lead tools, no briefing, no start turn held.
const plain = (seededGrants = 0) => {
  expect(grantRows().length).toBe(seededGrants)
  expect(leadKey()).toBeUndefined()
}

longTest('the new panel takes the offer: rename, ledger row, grant, toast, model, answer ok, offer and claim gone', async ($, on) => {
  const stdins: string[] = []
  await accepting($, on, { stdins })
  expect(await cue(70, CUE)).toBe('lead ok - 70\n')
  expect(renames).toEqual(['LEAD-N'])
  expect(ledgerRows().map((r) => r.kind)).toEqual(['lead-offer', 'lead-grant'])
  expect(grantRows()[0]).toMatchObject({ hash: KEY, repo: PIN, lane: 'LEAD-N', nonce: NONCE, by: OTHERLEAD, target: SID })
  expect(leadKey()).toMatchObject({ pin: PIN })
  expect(offers()).toEqual([])
  expect(toasts).toContain(c.leadOnToast('LEAD-N', OTHERLEAD, PIN))
  expect(logged(stdins)).toContain(`lead-on:via conductor ${OTHERLEAD.slice(0, 8)}`)
  expect(modelRuns.map((m) => m.split('@')[0])).toEqual(['haiku'])
  expect(leadFiles.has(`${ROOT}/leads/${SID}.json`)).toBe(true)
})

const REFUSALS: [string, Setup, string?][] = [
  ['already-bound', { bound: true }],
  ['not-repo-root', { seed: () => { h.callerRoot = `${PIN}/lab` } }],
  ['not-interactive', { panel: { kind: 'background' } }],
  ['user-named', { panel: { nameSource: 'user' } }],
  ['not-new-panel', { panel: { startedAt: T0 - 600_000 } }],
  ['not-new-panel', { seed: () => { h.turnsNow = 1 } }, 'a turn already ran'],
  ['offer-missing', { offer: null }],
  ['offer-bad', { offer: 'not json' }],
  ['offer-bad', { offer: { extra: 1 } }, 'an extra key'],
  ['offer-bad', { seed: () => { pfs.set(OFFER_PATH, { ...pfs.get(OFFER_PATH)!, mode: '644' }) } }, 'a file others can write'],
  ['offer-bad', { seed: () => { pfs.set(OFFER_PATH, { ...pfs.get(OFFER_PATH)!, nlink: 2 }) } }, 'a file with two links'],
  ['offer-bad', { seed: () => { pfs.set(OFFER_PATH, { ...pfs.get(OFFER_PATH)!, uid: 502 }) } }, 'a file of another owner'],
  ['offer-mismatch', { offer: { nonce: 'f'.repeat(32) } }],
  ['offer-mismatch', { offer: { repo: '/Users/x/code/other' } }],
  ['offer-old', { offer: { at: T0 - 300_000 } }],
  ['offer-old', { offer: { at: T0 + 300_000 } }, 'an offer from the future'],
  ['name-reserved', { offer: { name: 'MANAGER' } }],
  ['name-in-use', { extra: regAs('9a1b2c3d-0000-4000-8000-123456789abc', 4801, 'lead-n') }],
  ['offer-unlogged', { rows: [] }],
  ['offer-unlogged', { rows: [offerRow({ by: '9a1b2c3d-0000-4000-8000-123456789abc' })] }, 'a row by another session'],
  ['offer-used', { rows: [offerRow(), { t: iso(1000), kind: 'lead-grant', hash: KEY, nonce: NONCE }] }],
  ['offer-used', { rows: [offerRow(), { t: iso(1000), kind: 'lead-offer-void', hash: KEY, nonce: NONCE, code: 'x' }] }],
  ['conductor-leads-off', { seed: () => h.store.set('config', { conductorLeads: false, savedAt: h.nowMs }) }],
  ['conductor-not-live', { extra: {} , seed: () => { h.sessions = { ...panel() } } }],
  ['conductor-not-live', { offer: { conductor: { sid: OTHERLEAD, pid: 4243, start: 'Wed Oct 28 20:37:50 2026' } } }, 'another start time'],
  ['conductor-not-trusted', { seed: () => leadFiles.delete(`${ROOT}/leads/${OTHERLEAD}.json`) }, 'no presence file'],
  ['conductor-not-trusted', { seed: () => h.store.set(`conductor:${OTHERLEAD}`, { home: COND, repos: ['/Users/x/code/app2'], savedAt: T0 - 60_000 }) }, 'saved grant does not hold the repo'],
  ['lead-exists', { extra: leadReg(), seed: () => leadFiles.set(LEADPATH, { text: leadFileText() }) }],
  ['lead-offer-taken', { seed: () => pfs.set(CLAIM_PATH, { text: '9a1b2c3d-0000-4000-8000-123456789abc', mtimeSec: T0 / 1000 }) }],
]
REFUSALS.forEach(([code, setup, why], i) => {
  longTest(`a panel that fails a check answers refused ${code}${why ? ` (${why})` : ''} and stays plain (case ${i})`, async ($, on) => {
    await accepting($, on, setup)
    const ino = 100 + i
    expect(await cue(ino, CUE)).toBe(`lead refused ${code} ${ino}\n`)
    plain(setup.rows?.filter((r) => r.kind === 'lead-grant').length ?? 0)
    // Before the claim nothing is renamed; the claim taken by another session stays theirs.
    expect(renames).toEqual([])
    expect(offers().includes(CLAIM_PATH)).toBe(code === 'lead-offer-taken')
    expect(modelRuns).toEqual([])
  })
})

longTest('a lead panel is refused already-lead, and a panel with no registry row yet is held registry-pending', async ($, on) => {
  await accepting($, on, {})
  await grantAt($, PIN)
  expect(await cue(120, CUE)).toBe('lead refused already-lead 120\n')
  expect(renames).toEqual([])
  expect(grantRows()).toEqual([])
})

longTest('a panel whose row is not in the session list yet answers held registry-pending and writes nothing', async ($, on) => {
  await accepting($, on, { noOwnRow: true })
  expect(await cue(121, CUE)).toMatch(/^lead held registry-(pending|unreadable) 121\n$/)
  expect(offers().includes(CLAIM_PATH)).toBe(false)
  plain()
})

longTest('a cue more than 25 s old is refused late before the rename', async ($, on) => {
  await accepting($, on)
  expect(await cue(122, CUE, { mtimeSec: T0 / 1000 - 40 })).toBe('lead refused late 122\n')
  expect(renames).toEqual([])
  plain()
})

longTest('a draft in the box holds the cue before the rename; the same panel then takes its own claim again and is granted', async ($, on) => {
  await accepting($, on)
  h.draftNow = 'half a sentence'
  expect(await cue(123, CUE)).toBe('lead held draft-in-box 123\n')
  expect(renames).toEqual([])
  expect(pfs.get(CLAIM_PATH)?.text).toBe(SID)
  plain()
  h.draftNow = ''
  expect(await cue(124, CUE, { mtimeSec: h.nowMs / 1000 })).toBe('lead ok - 124\n')
  expect(renames).toEqual(['LEAD-N'])
  expect(grantRows().length).toBe(1)
  expect(offers()).toEqual([])
})

longTest('a rename that fails writes no ledger row and grants nothing; the claim stays for the conductor to take back', async ($, on) => {
  await accepting($, on)
  h.renameMode = 'throw'
  expect(await cue(125, CUE)).toBe('lead refused rename-failed 125\n')
  plain()
  expect(offers().includes(CLAIM_PATH)).toBe(true)
})

longTest('a rename that leaves the registry without the name is refused rename-failed with no ledger row', async ($, on) => {
  await accepting($, on)
  h.onRename = undefined
  h.cueFile = { ino: 126, text: CUE, present: true }
  await ticks(12)
  expect(resultFiles.get(RESULT)).toBe('lead refused rename-failed 126\n')
  plain()
})

longTest('a ledger that does not take the row grants nothing: refused ledger-write, the session renamed and plain', async ($, on) => {
  await accepting($, on)
  h.pfsFails = (a) => a[0] === '/usr/bin/tee' && a.includes(LEDGER)
  expect(await cue(128, CUE)).toBe('lead refused ledger-write 128\n')
  expect(renames).toEqual(['LEAD-N'])
  plain()
  expect(leadFiles.has(`${ROOT}/leads/${SID}.json`)).toBe(false)
})

longTest('a grant that fails after the ledger row writes a void row of the same nonce, so the hour is not spent', async ($, on) => {
  await accepting($, on)
  const refusing = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('refused')), 0))
  refusing.catch(() => undefined)
  h.registerGate = refusing
  expect(await cue(129, CUE)).toBe('lead refused grant-failed 129\n')
  expect(ledgerRows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)).toEqual(['lead-offer', 'lead-grant', 'lead-offer-void grant-failed'])
  expect(c.leadOpenRate(ledgerRows(), KEY, T0 + 10_000)).toBe('ok')
  expect(leadKey()).toBeUndefined()
  expect(h.sessions['4300.json']).toContain('LEAD-N')
})

longTest('/callboard off typed while the accept runs refuses off-meanwhile and grants nothing', async ($, on) => {
  await accepting($, on)
  let release!: () => void
  h.renameGate = new Promise<void>((r) => (release = r))
  h.cueFile = { ino: 130, text: CUE, present: true }
  const ticking = tickTwice()
  await new Promise((r) => setTimeout(r, 50))
  await $.command.run(lane('off'))
  release()
  await ticking
  await waitFor(() => resultFiles.has(RESULT))
  h.renameGate = undefined
  expect(resultFiles.get(RESULT)).toBe('lead refused off-meanwhile 130\n')
  expect(leadKey()).toBeUndefined()
  expect(ledgerRows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)).toEqual(['lead-offer', 'lead-grant', 'lead-offer-void off-meanwhile'])
})

longTest('a model that cannot be set keeps the lead, toasts, and the answer says the model was not set', async ($, on) => {
  await accepting($, on)
  h.modelMode = 'stay'
  expect(await cue(131, CUE)).toBe('lead ok model-unset 131\n')
  expect(leadKey()).toBeDefined()
  expect(toasts.some((t) => t.includes('could not be set'))).toBe(true)
  expect(offers()).toEqual([])
})

longTest('a panel that took over 25 s is refused late after the rename, writes no ledger row and grants nothing', async ($, on) => {
  await accepting($, on)
  let release!: () => void
  h.renameGate = new Promise<void>((r) => (release = r))
  h.cueFile = { ino: 132, text: CUE, present: true }
  const ticking = tickTwice()
  await new Promise((r) => setTimeout(r, 50))
  await h.clock!.advance(26_000)
  release()
  await ticking
  await waitFor(() => resultFiles.has(RESULT))
  h.renameGate = undefined
  expect(resultFiles.get(RESULT)).toBe('lead refused late 132\n')
  expect(renames).toEqual(['LEAD-N'])
  plain()
})

longTest('an offer removed after the checks and before the grant is set refuses the grant: the last guard reads the file', async ($, on) => {
  await accepting($, on)
  let release!: () => void
  h.registerGate = new Promise<void>((r) => (release = r))
  h.cueFile = { ino: 133, text: CUE, present: true }
  const ticking = tickTwice()
  await new Promise((r) => setTimeout(r, 50))
  pfs.delete(OFFER_PATH)
  release()
  await ticking
  await waitFor(() => resultFiles.has(RESULT))
  h.registerGate = undefined
  expect(resultFiles.get(RESULT)).toBe('lead refused offer-bad 133\n')
  expect(leadKey()).toBeUndefined()
  expect(ledgerRows().map((r) => `${r.kind}${r.code ? ` ${r.code}` : ''}`)).toEqual(['lead-offer', 'lead-grant', 'lead-offer-void offer-bad'])
})

longTest('the lead the panel became is a lead like any other: /callboard off removes the grant, the saved key and the presence file', async ($, on) => {
  await accepting($, on)
  expect(await cue(134, CUE)).toBe('lead ok - 134\n')
  expect(leadKey()).toBeDefined()
  await $.command.run(lane('off'))
  expect(leadKey()).toBeUndefined()
  expect(leadFiles.has(`${ROOT}/leads/${SID}.json`)).toBe(false)
})

longTest('a claim that names this very session is taken again (the retry after a held answer)', async ($, on) => {
  await accepting($, on, { seed: () => pfs.set(CLAIM_PATH, { text: SID, mtimeSec: T0 / 1000 }) })
  expect(await cue(135, CUE)).toBe('lead ok - 135\n')
})
