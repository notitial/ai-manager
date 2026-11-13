import { expect, test } from 'claude-code/testing'
import { USAGE_FILE_MAX, USAGE_KEEP_MS, USAGE_SWEEP_MAX, usageFileText } from '../hooks/core'
import { SID, USAGE_DIR, extraStat, h, pdirs, pfs, quiet } from './harness'
import { ANY, LEADPS, OTHER, PIN, cueSession, dirStat, leadAt, leadSelfReg, listed, mdBox, noNote, putStore, started, ticks } from './fixtures'

const MIN = 60_000
const FILE = `${USAGE_DIR}/${SID}.json`
const OTHER_FILE = `${USAGE_DIR}/${OTHER}.json`
const FIGURES = { context: { tokens: 142_000 }, cost: { usd: 3.1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 34, resetsAt: '2090-01-01T00:00:00.000Z' }] }
// The measure hook does not wait for its write: wait for the mocks to go quiet.
const measure = async ($: any) => {
  await $.session.measure({ changed: ['cost'] } as any)
  await quiet()
}
const body = () => JSON.parse(pfs.get(FILE)!.text)
const put = (path: string, text: string, over: { mtimeSec?: number; mode?: string; nlink?: number; uid?: number } = {}) => pfs.set(path, { text, mtimeSec: (h.nowMs - 2 * MIN) / 1000, ...over })
// A lane API whose session is OTHER (pid 4500) under a lead; the usage folder exists.
async function laneWithUsage($: any, on: any) {
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...cueSession(OTHER, 'API', `${PIN}/api`, { pid: 4500 }) } })
  extraStat.set(`${PIN}/api`, dirStat)
  putStore([{ name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 1 }])
  pdirs.add(USAGE_DIR)
}
const otherText = (over: { pid?: number; at?: number; sid?: string; start?: string; figures?: unknown } = {}) =>
  usageFileText(over.sid ?? OTHER, over.pid ?? 4500, over.start ?? LEADPS, over.at ?? h.nowMs - 2 * MIN, over.figures ?? FIGURES)!
const apiRow = (cell: string) => mdBox(ANY, [['API', 'api', 'live', '–']]).replace('no reading', cell)

test('a measure writes the usage file with the figures of session.usage, through a private temp file moved into place', async ($, on) => {
  const argv: string[][] = []
  h.sessions = leadSelfReg()
  await started($, on, [], { clock: true, argv })
  h.usageExtra = FIGURES
  await measure($)
  expect(body()).toEqual({ v: 1, sid: SID, pid: 4400, procStart: LEADPS, at: body().at, tokens: 142_000, cost: 3.1, windows: [{ kind: 'five_hour', pct: 34, resetsAt: '2090-01-01T00:00:00.000Z' }] })
  expect(body().at).toBeGreaterThan(0)
  expect(body().at).toBeLessThanOrEqual(h.nowMs)
  const tee = argv.find((a) => a[0] === '/usr/bin/tee' && a[2].startsWith(`${USAGE_DIR}/.${SID}.json.`))!
  expect(tee.slice(0, 2)).toEqual(['/usr/bin/tee', '--'])
  expect(argv.find((a) => a[0] === '/bin/mv' && a[a.length - 1] === FILE)).toEqual(['/bin/mv', '-f', '--', tee[2], FILE])
})

test('the usage file is written at most every 30 s: a measure inside the gap leaves a trailing write for the tick, one after it writes at once', async ($, on) => {
  const argv: string[][] = []
  h.sessions = leadSelfReg()
  await started($, on, [], { clock: true, argv })
  h.usageExtra = FIGURES
  const writes = () => argv.filter((a) => a[0] === '/usr/bin/tee' && a[2].startsWith(`${USAGE_DIR}/`)).length
  await measure($)
  expect(writes()).toBe(1)
  h.usageExtra = { ...FIGURES, cost: { usd: 4 } }
  await measure($)
  h.usageExtra = { ...FIGURES, cost: { usd: 5 } }
  await measure($)
  expect(writes()).toBe(1)
  expect(body().cost).toBe(3.1)
  await ticks(10)
  expect(writes()).toBe(1)
  await ticks(6)
  expect(writes()).toBe(2)
  expect(body().cost).toBe(5)
  // Nothing owed: the quiet that follows writes nothing.
  await ticks(30)
  expect(writes()).toBe(2)
  h.usageExtra = { ...FIGURES, cost: { usd: 6 } }
  await measure($)
  expect(writes()).toBe(3)
  expect(body().cost).toBe(6)
})

test('a session end removes the usage file and nothing is written after it, not even a trailing write a measure left owed', async ($, on) => {
  h.sessions = leadSelfReg()
  await started($, on, [], { clock: true })
  await measure($)
  expect(pfs.has(FILE)).toBe(true)
  await measure($)
  await $.session.end({} as any)
  expect(pfs.has(FILE)).toBe(false)
  await ticks(20)
  expect(pfs.has(FILE)).toBe(false)
})

test('a write that could not land stays owed: the tick writes it once the registry shows one row of the session', async ($, on) => {
  h.sessions = { ...leadSelfReg(), ...cueSession(SID, 'LEAD', PIN, { pid: 4401 }) }
  await started($, on, [], { clock: true })
  await measure($)
  expect(pfs.has(FILE)).toBe(false)
  h.sessions = leadSelfReg()
  await ticks(10)
  expect(pfs.has(FILE)).toBe(false)
  await ticks(6)
  expect(pfs.has(FILE)).toBe(true)
})

test('no usage file when the registry holds two rows of the session: the pid could be a twin\'s', async ($, on) => {
  h.sessions = { ...leadSelfReg(), ...cueSession(SID, 'LEAD', PIN, { pid: 4401 }) }
  await started($, on, [], { clock: true })
  await measure($)
  await ticks(2)
  expect([...pfs.keys()].filter((k) => k.startsWith(USAGE_DIR))).toEqual([])
})

test('lane_list shows the reading of a live lane in the Usage column, and no reading when there is no file', async ($, on) => {
  await laneWithUsage($, on)
  expect(noNote(await listed($))).toBe(apiRow('no reading'))
  put(OTHER_FILE, otherText())
  expect(noNote(await listed($))).toBe(apiRow('ctx 142k · 5h 34% · $3.10 · 2m ago'))
})

test('a usage file that fails a check reads as no reading, never as an error: forged sid, pid, start, mode, owner, links, size, future time, a day old, bad JSON', async ($, on) => {
  await laneWithUsage($, on)
  const cases: [string, string, { mode?: string; nlink?: number; uid?: number }?][] = [
    ['sid', otherText({ sid: SID })],
    ['pid', otherText({ pid: 4501 })],
    ['start', otherText({ start: 'Wed Oct 28 20:37:50 2026' })],
    ['mode', otherText(), { mode: '644' }],
    ['owner', otherText(), { uid: 0 }],
    ['links', otherText(), { nlink: 2 }],
    ['size', JSON.stringify({ ...JSON.parse(otherText()), pad: 'x'.repeat(USAGE_FILE_MAX) })],
    ['future', otherText({ at: h.nowMs + MIN })],
    ['old', otherText({ at: h.nowMs - USAGE_KEEP_MS - MIN })],
    ['json', '{'],
  ]
  for (const [why, text, over] of cases) {
    put(OTHER_FILE, text, over)
    expect(noNote(await listed($)), why).toBe(apiRow('no reading'))
  }
  // A file of another session's name is not read for this one.
  pfs.delete(OTHER_FILE)
  put(FILE, otherText())
  expect(noNote(await listed($))).toBe(apiRow('no reading'))
})

test('a window whose reset time has passed shows ? and the other figures stay', async ($, on) => {
  await laneWithUsage($, on)
  put(OTHER_FILE, otherText({ figures: { ...FIGURES, rateLimits: [{ kind: 'five_hour', percentUsed: 34, resetsAt: new Date(h.nowMs - 1000).toISOString() }] } }))
  expect(noNote(await listed($))).toBe(apiRow('ctx 142k · 5h ? · $3.10 · 2m ago'))
})

test('the usage folder missing or not private reads as no reading for every row', async ($, on) => {
  await laneWithUsage($, on)
  put(OTHER_FILE, otherText())
  pdirs.delete(USAGE_DIR)
  expect(noNote(await listed($))).toBe(apiRow('no reading'))
})

test('the sweep removes the file of a gone session once a minute old and any file a day old, and keeps a live session\'s and a fresh one', async ($, on) => {
  await leadAt($, on, [], { clock: true, sess: { ...leadSelfReg(), ...cueSession(OTHER, 'API', `${PIN}/api`, { pid: 4500 }) } })
  pdirs.add(USAGE_DIR)
  const GONE = '6a1b2c3d-0000-4000-8000-123456789abc'
  const FRESH = '7a1b2c3d-0000-4000-8000-123456789abc'
  const OLD = '8a1b2c3d-0000-4000-8000-123456789abc'
  put(`${USAGE_DIR}/${GONE}.json`, otherText({ sid: GONE }))
  put(`${USAGE_DIR}/${FRESH}.json`, otherText({ sid: FRESH }), { mtimeSec: h.nowMs / 1000 })
  put(OTHER_FILE, otherText())
  put(`${USAGE_DIR}/${OLD}.json`, otherText({ sid: OLD }), { mtimeSec: (h.nowMs - USAGE_KEEP_MS - MIN) / 1000 })
  put(`${USAGE_DIR}/.${GONE}.json.1.2.tmp`, 'half', { mtimeSec: (h.nowMs - USAGE_KEEP_MS - MIN) / 1000 })
  put(`${USAGE_DIR}/notes.json`, 'x')
  await ticks(2)
  const left = () => [...pfs.keys()].filter((k) => k.startsWith(`${USAGE_DIR}/`) && !k.endsWith(`/${SID}.json`)).map((k) => k.slice(USAGE_DIR.length + 1)).sort()
  expect(left()).toEqual([`${FRESH}.json`, `${OTHER}.json`, 'notes.json'].sort())
})

test('one sweep removes at most USAGE_SWEEP_MAX files; the next one takes the rest', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  pdirs.add(USAGE_DIR)
  const gone = (i: number) => `${USAGE_DIR}/${String(i).padStart(8, '0')}-0000-4000-8000-123456789abc.json`
  for (let i = 0; i < USAGE_SWEEP_MAX + 6; i++) put(gone(i), 'x')
  const left = () => [...pfs.keys()].filter((k) => k.startsWith(`${USAGE_DIR}/`) && !k.endsWith(`/${SID}.json`)).length
  await ticks(2)
  expect(left()).toBe(6)
  await ticks(31)
  expect(left()).toBe(0)
})
