import { expect, test } from 'claude-code/testing'
import { orderText, COMPACT_START_TOAST, COMPACT_CANCELLED_TOAST, mergeCounters, requestExpired, ON_CUE_TTL_MS, RESUME_PER_HOUR, STOPPABLE_BY_NAME, RESTORE_YES, nudgeText, COMPACT_CUT_NOTE } from '../hooks/core'
import { h, GOOD, NO, SID, T0, YES, laneSeed, longTest, resultFiles, seen, submitted, toasts } from './harness'
import type { Trace } from './harness'
import { LANES, MIN, NOW, OTHER, REG, REGFILE, RESULT, STATUS_NONE, TURN, allEvents, armNow, ckLead, cue, events, idleFor, lane, leadCall, leadSelfReg, logged, newTrace, nudges, person, renameThroughTick, retireTarget, started, ticks } from './fixtures'

test('request_compact is refused for a subagent and for invalid input', async ($, on) => {
  await started($, on, [])
  const sub = await $.tool.call({ ...GOOD, agentId: 'a1' } as any)
  expect(JSON.stringify(sub)).toContain('main agent only')
  for (const bad of [{ focus: '/compact' }, { mode: 'later' }, { continuation: '1\n2\n3\n4\n5\n6' }, { focus: 'x'.repeat(1201) }]) {
    const r = await $.tool.call({ ...GOOD, ...bad } as any)
    expect(JSON.stringify(r)).toContain('refused')
  }
})

test('a valid request is queued and logged with fixed fields only', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { bound: true })
  const r = await $.tool.call(GOOD as any)
  expect(r.result).toBe('queued')
  const lines = stdins.filter((x) => x.includes('"requested"'))
  expect(lines.length).toBe(1)
  expect(JSON.parse(lines[0])).toEqual({ t: '2023-11-14T22:13:20.000Z', event: 'requested', reason: 'on-cue' })
  expect(stdins.join('')).not.toContain('keep the plan')
})

// v15.2 (ADR 0003): the live checkout's HEAD is read once at session start. Main says nothing; any other branch or a detached commit warns with one toast
// and `warn live-checkout-not-main`; an unreadable or odd HEAD logs `warn live-checkout-unknown` and shows nothing. Nothing is ever refused.
const warns = (stdins: string[]) => allEvents(stdins).filter((e) => e.event === 'warn').map((e) => e.reason)
const liveToasts = () => toasts.filter((t) => t.startsWith('Callboard loads from '))

test('a live checkout on main starts silently: one bounded read of .git/HEAD, no toast, no warn line', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins)
  expect(h.liveHeadReads).toBe(1)
  expect(h.liveHeadAsked?.path).toMatch(/^\/.+\/\.git\/HEAD$/)
  expect(h.liveHeadAsked?.bytes).toBe('257')
  expect(liveToasts()).toEqual([])
  expect(warns(stdins)).toEqual([])
})

test('a live checkout on another branch warns once with a toast and a log line, and nothing is blocked', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { seed: () => { h.liveHead = 'ref: refs/heads/feat/symlink-install\n' } })
  const checkout = h.liveHeadAsked!.path.slice(0, -'/.git/HEAD'.length)
  expect(liveToasts()).toEqual([`Callboard loads from ${checkout}, which is not on main (it is on branch feat/symlink-install). Whatever is checked out there is live in every session.`])
  expect(warns(stdins)).toEqual(['live-checkout-not-main'])
  expect(allEvents(stdins).find((e) => e.event === 'warn')).toEqual({ t: '2023-11-14T22:13:20.000Z', event: 'warn', reason: 'live-checkout-not-main' })
  expect(stdins.filter((x) => x.includes('live-checkout')).join('')).not.toContain(checkout)
  expect((await $.command.run(lane('status'))).text).toBe(STATUS_NONE)
  await $.tool.call(GOOD as any)
  await $.prompt.submit({ text: 'hello' } as any)
  expect(h.liveHeadReads).toBe(1)
  expect(liveToasts().length).toBe(1)
  expect(warns(stdins)).toEqual(['live-checkout-not-main'])
})

test('a detached live checkout warns too, and says so', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { seed: () => { h.liveHead = `${'0123abcd'.repeat(5)}\n` } })
  expect(liveToasts().length).toBe(1)
  expect(liveToasts()[0]).toMatch(/, which is not on main \(it is on a detached commit\)\. Whatever is checked out there is live in every session\.$/)
  expect(liveToasts()[0]).not.toContain('0123abcd')
  expect(warns(stdins)).toEqual(['live-checkout-not-main'])
})

test('a branch whose name fails the strict check still warns, without the name', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { seed: () => { h.liveHead = 'ref: refs/heads/fix+é\r\n' } })
  expect(liveToasts().length).toBe(1)
  expect(liveToasts()[0]).toMatch(/, which is not on main \(it is on another branch\)\. Whatever is checked out there is live in every session\.$/)
  expect(liveToasts()[0]).not.toContain('fix+')
  expect(warns(stdins)).toEqual(['live-checkout-not-main'])
})

// One engine per test, so each odd HEAD is a test of its own.
for (const [label, odd] of [['unreadable', undefined], ['empty', ''], ['a newline', '\n'], ['a tag ref', 'ref: refs/tags/v1\n'], ['an empty branch name', 'ref: refs/heads/\n'], ['garbage', 'garbage'], ['41 hex', `${'a'.repeat(41)}\n`], ['two lines', 'ref: refs/heads/main\nextra\n']] as const) {
  test(`${label} HEAD logs live-checkout-unknown and shows no toast`, async ($, on) => {
    const stdins: string[] = []
    await started($, on, stdins, { seed: () => { h.liveHead = odd } })
    expect(h.liveHeadReads).toBe(1)
    expect(liveToasts()).toEqual([])
    expect(warns(stdins)).toEqual(['live-checkout-unknown'])
  })
}

test('every process call uses a fixed absolute executable and no shell', async ($, on) => {
  const argv: string[][] = []
  await started($, on, [], { argv })
  await $.tool.call(GOOD as any)
  expect(argv.length).toBeGreaterThan(0)
  for (const a of argv) {
    expect(a[0].startsWith('/')).toBe(true)
    expect(['/bin/sh', '/bin/bash', '/bin/zsh']).not.toContain(a[0])
    expect(a.every((x) => !x.includes('\0'))).toBe(true)
  }
})

test('an on-cue request is armed after a normal turn and dropped by the next prompt', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { bound: true })
  await $.tool.call(GOOD as any)
  await $.turn.complete(TURN as any)
  await $.prompt.submit({ text: 'hello' } as any)
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toEqual(['requested:on-cue', 'armed:on-cue', 'dropped:new-prompt'])
})

test('an interrupted turn drops the request instead of arming it', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { bound: true })
  await $.tool.call(GOOD as any)
  await $.turn.complete({ ...TURN, isAborted: true, reason: 'aborted' } as any)
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toEqual(['requested:on-cue', 'dropped:turn-ended-badly'])
})

test('a now-request is not compacted inside the turn.complete hook; it waits for the tick', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { bound: true })
  await $.tool.call({ ...GOOD, mode: 'now' } as any)
  await $.turn.complete(TURN as any)
  expect(seen.compacted).toBe(false)
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toEqual(['requested:now', 'armed:now'])
})

test('a user prompt drops an armed now-request, which lives one turn', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { bound: true })
  await $.tool.call({ ...GOOD, mode: 'now' } as any)
  await $.turn.complete(TURN as any)
  await $.prompt.submit({ text: 'hello' } as any)
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toEqual(['requested:now', 'armed:now', 'dropped:new-prompt'])
})

test('a person\'s message that cancels a queued compaction says so in a toast, for an on-cue and a now request; a resume after a compaction is not a queued one', async ($, on) => {
  await started($, on, [], { bound: true })
  for (const mode of ['on-cue', 'now']) {
    toasts.length = 0
    await $.tool.call({ ...GOOD, mode } as any)
    await $.turn.complete(TURN as any)
    await $.prompt.submit({ text: 'hello' } as any)
    expect(toasts.filter((t) => t === COMPACT_CANCELLED_TOAST).length, mode).toBe(1)
  }
  // No request: no toast.
  toasts.length = 0
  await $.prompt.submit({ text: 'again' } as any)
  expect(toasts).toEqual([])
})

test('a compaction that callboard starts is announced in a toast, once, as it starts', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { clock: true })
  await $.tool.call({ ...GOOD, mode: 'now' } as any)
  await $.turn.complete(TURN as any)
  expect(toasts.filter((t) => t === COMPACT_START_TOAST).length).toBe(0)
  await h.clock!.advance(2000)
  expect(seen.compacted).toBe(true)
  expect(toasts.filter((t) => t === COMPACT_START_TOAST).length).toBe(1)
})

test('a compact command the engine refuses: the start toast is followed by a toast that says it did not start', async ($, on) => {
  await started($, on, [], { clock: true })
  h.compactThrows = true
  await $.tool.call({ ...GOOD, mode: 'now' } as any)
  await $.turn.complete(TURN as any)
  await h.clock!.advance(2000)
  expect(toasts.indexOf(COMPACT_START_TOAST)).toBeGreaterThanOrEqual(0)
  expect(toasts).toContain('Compaction skipped: the engine refused the command.')
})
let theTrace: Trace
for (const [name, why, set, undo] of [
  ['a draft in the prompt box', 'draft in the prompt box', () => { h.draftNow = 'half a sentence' }, () => { h.draftNow = '' }],
  ['a context that fell under the floor after the request was accepted', 'context is below 100k tokens', () => { h.tokensNow = 5 }, () => { h.tokensNow = 150_000 }],
  ['a compaction inside the gap, after the request was accepted', 'one compaction every 30 minutes at most', () => theTrace.st!.set('counters', { value: { lastCompactMs: h.nowMs - 60_000 }, version: 99 }), () => undefined],
] as [string, string, () => void, () => void][]) {
  test(`a queued compaction refused with no notice turn (${name}) says so in a toast, and starts nothing`, async ($, on) => {
    const stdins: string[] = []
    theTrace = { log: [], failCounters: false }
    await started($, on, stdins, { clock: true, bound: true, trace: theTrace })
    await $.tool.call({ ...GOOD, mode: 'now' } as any)
    await $.turn.complete(TURN as any)
    set()
    await h.clock!.advance(2000)
    expect(seen.compacted).toBe(false)
    expect(toasts).toContain(`Compaction skipped: ${why}.`)
    expect(toasts).not.toContain(COMPACT_START_TOAST)
    expect(submitted.some((t) => t.includes('Compaction did not run'))).toBe(false)
    undo()
  })
}

test('a repeated identical refusal is logged once', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins)
  for (let i = 0; i < 3; i++) {
    await $.tool.call({ ...GOOD, agentId: 'a1' } as any)
  }
  expect(events(stdins).filter((e) => e.reason === 'subagent').length).toBe(1)
})

test('a session that is not bound cannot use request_compact on-cue', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, {})
  const r = await $.tool.call(GOOD as any)
  expect(JSON.stringify(r)).toContain('not enabled')
  expect(events(stdins).map((e) => `${e.event}:${e.reason}`)).toEqual(['refused:not-eligible'])
})

test('off drops a pending request, and says so', async ($, on) => {
  await started($, on, [], { bound: true })
  await $.tool.call({ ...GOOD, mode: 'now' } as any)
  await $.turn.complete(TURN as any)
  expect((await $.command.run(lane('off'))).text).toBe(`This session is no longer lane LABLANE. Its compaction request was dropped.${STOPPABLE_BY_NAME('LABLANE')}`)
  expect(seen.compacted).toBe(false)
})

test('mergeCounters never loosens: no duplicate resumes, the later compaction wins, the newest RESUME_PER_HOUR are kept', async () => {
  expect(mergeCounters({ resumeTimes: [5, 6] }, { resumeTimes: [5, 6] })).toEqual({ resumeTimes: [5, 6] })
  expect(mergeCounters({ lastCompactMs: 9 }, { lastCompactMs: 4 }).lastCompactMs).toBe(9)
  expect(mergeCounters({ lastCompactMs: 4 }, { lastCompactMs: 9 }).lastCompactMs).toBe(9)
  const old = Array.from({ length: RESUME_PER_HOUR }, (_, i) => i + 1)
  expect(mergeCounters({ resumeTimes: [100, 101] }, { resumeTimes: old }).resumeTimes).toEqual([...old.slice(2), 100, 101])
})

test('a decline after a dismissed dialog is final: the hint stays as it was, and is not offered again', async ($, on) => {
  const hint = { lane: { name: 'LABLANE', at: 1 }, counters: {}, savedAt: T0 }
  try {
    await started($, on, [], { seed: () => { laneSeed.text = LANES; h.store.set(`sess:${SID}`, hint) } })
    h.restoreAnswer = 'Something else'
    await $.command.run(lane('lane'))
    h.restoreAnswer = NO
    await $.command.run(lane('lane'))
    expect(h.store.get(`sess:${SID}`)).toEqual(hint)
    h.restoreAnswer = YES
    h.askedOptions = []
    await $.command.run(lane('lane'))
    expect(h.askedOptions.some((o) => o[0] === RESTORE_YES)).toBe(false)
  } finally {
    laneSeed.text = undefined
  }
})

test('requestExpired: a compacting request expires from when the compaction started, not from the request', () => {
  const now = 10_000_000
  const min = 60_000
  const req = (phase: string, requestedMs: number, compactingMs?: number) => ({ phase, requestedMs, compactingMs })
  expect(requestExpired(req('called', now - ON_CUE_TTL_MS), now)).toBe(false)
  expect(requestExpired(req('called', now - ON_CUE_TTL_MS - 1), now)).toBe(true)
  expect(requestExpired(req('compacting', now - 20 * min, now - min), now)).toBe(false)
  expect(requestExpired(req('compacting', now - 20 * min, now - 16 * min), now)).toBe(true)
  expect(requestExpired(req('compacting', now - 16 * min), now)).toBe(true)
  expect(requestExpired(req('compacting', now - 14 * min), now)).toBe(false)
})

test('an unconfirmed compaction whose request changed meanwhile is left alone: no clear, no notice', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await retireTarget($, on, stdins, trace)
  const old = h.nowMs - ON_CUE_TTL_MS - 60_000
  trace.st!.set('request', { value: { phase: 'compacting', mode: 'now', requestedMs: old, compactingMs: old, id: 'r1', focus: 'f', continuation: 'c' }, version: 9 })
  trace.failKeys = new Set(['request'])
  await h.clock!.advance(2000)
  expect(logged(stdins)).toContain('dropped:changed-meanwhile')
  expect(logged(stdins)).not.toContain('refused:compact-unconfirmed')
  expect(submitted.some((t) => t.includes('compact-unconfirmed'))).toBe(false)
  expect((trace.st!.get('request')!.value as { phase: string }).phase).toBe('compacting')
})

test('a request step that throws for 60 s is dropped; a few throwing ticks are not; the cue is answered on every tick; a clean tick resets the count', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await retireTarget($, on, stdins, trace)
  h.agentListThrows = true
  armNow(trace)
  for (const ino of [150, 151]) {
    h.cueFile = { ino, text: 'bogus\n', present: true }
    await h.clock!.advance(2000)
    expect(resultFiles.get(RESULT)).toBe(`- refused grammar ${ino}\n`)
  }
  trace.st!.set('request', { value: null, version: 10 })
  await h.clock!.advance(2000)
  armNow(trace)
  for (const ino of [152, 153, 154, 155]) {
    h.cueFile = { ino, text: 'bogus\n', present: true }
    await h.clock!.advance(2000)
    expect(resultFiles.get(RESULT)).toBe(`- refused grammar ${ino}\n`)
  }
  expect(logged(stdins)).not.toContain('dropped:request-failing')
  await h.clock!.advance(56_000)
  h.cueFile = { ino: 156, text: 'bogus\n', present: true }
  await h.clock!.advance(2000)
  expect(resultFiles.get(RESULT)).toBe('- refused grammar 156\n')
  expect(logged(stdins)).toContain('dropped:request-failing')
  expect(trace.st!.get('request')!.value).toBeNull()
})

const noQueue = (stdins: string[]) => {
  const seenEvents = events(stdins).map((e) => `${e.event}:${e.reason}`)
  expect(seenEvents.some((x) => x.startsWith('requested') || x.startsWith('armed'))).toBe(false)
  expect(submitted.some((t) => t.includes('Compaction did not run'))).toBe(false)
  return seenEvents
}

test('request_compact is denied at once inside the 30-minute gap: nothing queued, no notice', async ($, on) => {
  const stdins: string[] = []
  h.sessions = {}
  await started($, on, stdins, { bound: true, seed: () => h.store.set(`sess:${SID}`, { counters: { lastCompactMs: T0 - 60_000 }, savedAt: T0 - 1000 }) })
  const r = JSON.stringify(await $.tool.call(GOOD as any))
  expect(r).toContain('Compaction not allowed: rate-limit')
  expect(r).toContain('about 29 minutes')
  await $.turn.complete(TURN as any)
  expect(noQueue(stdins)).toContain('refused:rate-limit')
})

test('request_compact is denied at once below the context floor: nothing queued, no notice', async ($, on) => {
  const stdins: string[] = []
  h.sessions = {}
  await started($, on, stdins, { bound: true })
  h.tokensNow = 5
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('Compaction not allowed: context-floor')
  await $.turn.complete(TURN as any)
  expect(noQueue(stdins)).toContain('refused:context-floor')
})

test('a background-work notice goes out at most 3 times an hour', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { clock: true })
  h.agentsNow = [{ status: 'running' }]
  for (let i = 0; i < 4; i++) {
    await $.tool.call({ ...GOOD, mode: 'now' } as any)
    await $.turn.complete(TURN as any)
    await h.clock!.advance(2000)
  }
  expect(submitted.filter((t) => t.startsWith('[compact-cue] Compaction did not run (background-work)')).length).toBe(3)
  expect(allEvents(stdins).map((e) => `${e.event}:${e.reason}`)).toContain('notice-capped:background-work')
})

longTest('a compaction that starts but never confirms is cleared after 15 minutes with one notice that says it may have run', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { clock: true })
  h.compactHangs = true
  await $.tool.call({ ...GOOD, mode: 'now' } as any)
  await $.turn.complete(TURN as any)
  await h.clock!.advance(2000)
  expect(seen.compacted).toBe(true)
  await h.clock!.advance(ON_CUE_TTL_MS - 60_000)
  expect(submitted.some((t) => t.includes('compact-unconfirmed'))).toBe(false)
  await h.clock!.advance(2 * 60_000)
  const notices = submitted.filter((t) => t.startsWith('[compact-cue] Compaction was started but never confirmed (compact-unconfirmed). It may or may not have run.'))
  expect(notices.length).toBe(1)
  expect(notices[0]).not.toContain('Nothing changed')
  const names = allEvents(stdins).map((e) => `${e.event}:${e.reason}`)
  expect(names).toContain('refused:compact-unconfirmed')
  expect(names).not.toContain('dropped:expired')
  await h.clock!.advance(60_000)
  expect(submitted.filter((t) => t.includes('compact-unconfirmed')).length).toBe(1)
})

test('a request that expires before it was armed is still dropped with no notice', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { clock: true })
  await $.tool.call({ ...GOOD, mode: 'now' } as any)
  await h.clock!.advance(ON_CUE_TTL_MS + 4000)
  const names = allEvents(stdins).map((e) => `${e.event}:${e.reason}`)
  expect(names).toContain('dropped:expired')
  expect(submitted.some((t) => t.startsWith('[compact-cue]'))).toBe(false)
})

test('a lead order is refused inside the compaction gap, and background-work with a background agent; none is recorded (the context floor no longer applies to an order)', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace)
  h.tokensNow = 150_000
  trace.st!.set('counters', { value: { lastCompactMs: h.nowMs - 60_000 }, version: 30 })
  expect(await cue(81, 'compact\n')).toBe('compact refused rate-limit 81\n')
  trace.st!.set('counters', { value: {}, version: 31 })
  h.agentsNow = [{ status: 'running' }]
  expect(await cue(82, 'compact\n')).toBe('compact refused background-work 82\n')
  expect(trace.st!.get('nudgeDue')?.value ?? null).toBe(null)
  h.agentsNow = []
  await ticks(3)
  expect(nudges()).toEqual([])
})

test('an order (lane_compact, no request) lifts the floor for one on-cue request: it compacts at the turn end with no second cue, and the order is spent; an unordered request below 100k is still refused', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  h.tokensNow = 50_000
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('Compaction not allowed: context-floor')
  expect(await cue(96, 'compact\n')).toBe('compact held nudged 96\n')
  expect(nudges()).toEqual([nudgeText('lead')])
  expect(h.store.get(`ord:${SID}`)).toEqual({ at: expect.any(Number) })
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('queued')
  // The request does not spend the order; the compaction that begins does.
  expect(h.store.has(`ord:${SID}`)).toBe(true)
  await $.turn.complete(TURN as any)
  await ticks(3)
  expect(seen.compacted).toBe(true)
  expect(h.store.has(`ord:${SID}`)).toBe(false)
  expect(logged(stdins)).toContain('requested:on-cue-ordered')
  expect(logged(stdins).filter((x) => x === 'refused:context-floor').length).toBe(1)
})

test('an order is not a standing lift: a request made after the 15 minutes meets the floor again, and a request in mode now never gets the lift', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  h.tokensNow = 50_000
  expect(await cue(97, 'compact\n')).toBe('compact held nudged 97\n')
  expect(JSON.stringify(await $.tool.call({ ...GOOD, mode: 'now' } as any))).toContain('Compaction not allowed: context-floor')
  await h.clock!.advance(16 * 60_000)
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('Compaction not allowed: context-floor')
})

test('an order past the 30-minute gap of an earlier nudge is sent; a repeat of the same order is refused nudge-limit', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace)
  h.tokensNow = 50_000
  trace.st!.set('counters', { value: { lastNudgeMs: h.nowMs - 60_000, nudgeTimes: [h.nowMs - 60_000], lastNudgeKind: 'idle' }, version: 40 })
  expect(await cue(98, 'compact\n')).toBe('compact held nudged 98\n')
  expect(nudges()).toEqual([nudgeText('lead')])
  expect(await cue(99, 'compact\n')).toBe('compact refused nudge-limit 99\n')
  expect(nudges().length).toBe(1)
})

test('an order stands when the engine refuses the compact command: the stamp is put back, so the deadline notice still comes', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  h.tokensNow = 50_000
  await cue(120, 'compact\n')
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('queued')
  const at = (h.store.get(`ord:${SID}`) as { at: number }).at
  h.compactThrows = true
  await $.turn.complete(TURN as any)
  await ticks(3)
  expect(seen.compacted).toBe(false)
  expect(h.store.get(`ord:${SID}`)).toEqual({ at })
})

test('a compaction the mod did not start (PostCompact with no request) spends the order too', async ($, on) => {
  on('classic.PostCompact', () => ({}))
  await renameThroughTick($, on, [], 1)
  h.tokensNow = 50_000
  await cue(121, 'compact\n')
  expect(h.store.has(`ord:${SID}`)).toBe(true)
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 's' })
  expect(h.store.has(`ord:${SID}`)).toBe(false)
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain('Compaction not allowed: context-floor')
})

longTest('an order sent again after its first nudge expired unsent restarts the 15 minutes, for the lane and the orderer', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  expect(await cue(122, 'compact\n')).toBe('compact held nudged 122\n')
  const first = (h.store.get(`ord:${SID}`) as { at: number }).at
  await h.clock!.advance(11 * MIN)
  expect(await cue(123, 'compact\n', { mtimeSec: h.nowMs / 1000 })).toBe('compact held nudged 123\n')
  expect((h.store.get(`ord:${SID}`) as { at: number }).at).toBeGreaterThan(first)
})

test('a pending nudge of any kind becomes the order and is stamped', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace)
  h.tokensNow = 50_000
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  trace.st!.set('nudgeDue', { value: { kind: 'cache', at: h.nowMs }, version: 50 })
  expect(await cue(124, 'compact\n')).toBe('compact held nudged 124\n')
  expect(trace.st!.get('nudgeDue')?.value).toEqual({ kind: 'lead', at: expect.any(Number) })
  expect(h.store.get(`ord:${SID}`)).toEqual({ at: expect.any(Number) })
})

const orderNotices = () => submitted.filter((t) => t.includes('did not compact after your order'))

test('the deadline of an order: 15 minutes on, a lane that never asked (its stamp is still in the store) gets its orderer one fixed notice, once; nothing is stopped', async ($, on) => {
  const stdins: string[] = []
  await ckLead($, on, stdins)
  h.autoAnswer = 'held nudged'
  await $.tool.call(leadCall('compact', { lane: 'API' }))
  h.store.set(`ord:${OTHER}`, { at: h.nowMs })
  await idleFor(12 * MIN)
  expect(orderNotices()).toEqual([])
  await idleFor(6 * MIN)
  expect(orderNotices()).toEqual([orderText(['API'])])
  expect(orderNotices()[0]).toContain('Ask the person whether to lane_terminate it; they confirm in a dialog every time.')
  expect(logged(stdins)).toContain('order-notice:ordered:1')
  expect(h.store.has(`ord:${OTHER}`)).toBe(false)
  await idleFor(40 * MIN)
  expect(orderNotices().length).toBe(1)
})

test('the deadline of an order: a lane that compacted (its stamp spent) costs its orderer no notice', async ($, on) => {
  await ckLead($, on)
  h.autoAnswer = 'held nudged'
  await $.tool.call(leadCall('compact', { lane: 'API' }))
  h.store.set(`ord:${OTHER}`, { at: h.nowMs })
  await idleFor(5 * MIN)
  h.store.delete(`ord:${OTHER}`)
  await idleFor(20 * MIN)
  expect(orderNotices()).toEqual([])
})

test('the deadline of an order: a newer order of the lane restarts the 15 minutes, and a lane whose session is gone is not reported', async ($, on) => {
  await ckLead($, on)
  h.autoAnswer = 'held nudged'
  await $.tool.call(leadCall('compact', { lane: 'API' }))
  h.store.set(`ord:${OTHER}`, { at: h.nowMs })
  await idleFor(10 * MIN)
  h.store.set(`ord:${OTHER}`, { at: h.nowMs })
  await idleFor(8 * MIN)
  expect(orderNotices()).toEqual([])
  await idleFor(8 * MIN)
  expect(orderNotices()).toEqual([orderText(['API'])])
  await $.tool.call(leadCall('compact', { lane: 'API' }))
  h.store.set(`ord:${OTHER}`, { at: h.nowMs })
  h.sessions = leadSelfReg()
  await idleFor(20 * MIN)
  expect(orderNotices().length).toBe(1)
})

// ---- v13.1: a compaction cut off by a restart ----
const CMPKEY = `cmp:${SID}`
const cutNotes = () => h.appendRows.filter((m) => m.content?.[0]?.text === COMPACT_CUT_NOTE)

test('a fresh cut mark at start gives one note and a toast on the first tick, and is deleted', async ($, on) => {
  const stdins: string[] = []
  await started($, on, stdins, { clock: true, seed: () => h.store.set(CMPKEY, { at: T0 - 60_000 }) })
  expect(cutNotes().length).toBe(0)
  await ticks(1)
  expect(cutNotes().length).toBe(1)
  expect(toasts).toContain('A compaction may have been cut off by the restart.')
  expect(logged(stdins)).toContain('compact-cut:')
  expect(h.store.has(CMPKEY)).toBe(false)
  await ticks(3)
  expect(cutNotes().length).toBe(1)
})

test('a stale cut mark is deleted with no note', async ($, on) => {
  await started($, on, [], { clock: true, seed: () => h.store.set(CMPKEY, { at: T0 - 16 * 60_000 }) })
  await ticks(2)
  expect(cutNotes().length).toBe(0)
  expect(h.store.has(CMPKEY)).toBe(false)
})

test('a cut mark found while the state survived (a request still in it) is deleted with no note', async ($, on) => {
  const trace = newTrace()
  await started($, on, [], {
    clock: true,
    trace,
    seed: () => {
      h.store.set(CMPKEY, { at: T0 - 60_000 })
      trace.st!.set('request', { value: { phase: 'compacting', mode: 'now', requestedMs: T0 - 60_000, compactingMs: T0 - 60_000, id: 'r1', focus: 'f', continuation: 'c' }, version: 3 })
    },
  })
  await ticks(2)
  expect(cutNotes().length).toBe(0)
  expect(h.store.has(CMPKEY)).toBe(false)
})

test('a run with no person leaves the cut mark and gets no note', async ($, on) => {
  await started($, on, [], { clock: true, interactive: false, seed: () => ((h.sessions = {}), (h.ownEntryAuto = false), h.store.set(CMPKEY, { at: T0 - 60_000 })) })
  await ticks(17)
  expect(cutNotes().length).toBe(0)
  expect(h.store.has(CMPKEY)).toBe(true)
})

test('the cut mark is written when the compaction starts and cleared at PostCompact', async ($, on) => {
  const stdins: string[] = []
  on('classic.PostCompact', () => ({}))
  await person($, on, stdins)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(seen.compacted).toBe(true)
  expect(h.store.has(CMPKEY)).toBe(true)
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' })
  expect(h.store.has(CMPKEY)).toBe(false)
})
