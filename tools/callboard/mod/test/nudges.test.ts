import { expect, test } from 'claude-code/testing'
import { nudgeText, compactResumeText, OFF_NOTHING } from '../hooks/core'
import { h, GOOD, PS_TABLE, YES, laneSeed, longTest, psCalls, resultFiles, seen, submitted, toolDefs } from './harness'
import type { Trace } from './harness'
import { LEAD_LANES, MIN, NOT_ENABLED, NOW, OWN_ROW, REG, REGFILE, RESULT, SELF_PS, TURN, cue, lane, lead, leadAt, leadCall, logged, midCtx, newTrace, nudges, person, postBeneath, renameThroughTick, retireTarget, tickTwice, ticks } from './fixtures'

test('a compact cue with no request nudges an idle lane: held nudged, and the tick sends one nudge after the cue is answered, in the same tick', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  h.cueFile = { ino: 61, text: 'compact\n', present: true }
  // The answer and the nudge land in one tick, the nudge step after the cue: a nudge step run before the cue would send it a tick later.
  for (let i = 0; i < 4 && !resultFiles.get(RESULT)?.endsWith(' 61\n'); i++) await h.clock!.advance(2000)
  expect(resultFiles.get(RESULT)).toBe('compact held nudged 61\n')
  expect(nudges()).toEqual([nudgeText('lead')])
  await h.clock!.advance(2000)
  expect(nudges()).toEqual([nudgeText('lead')])
  expect(logged(stdins)).toContain('nudge-due:lead')
  expect(logged(stdins)).toContain('nudged:lead')
  await ticks(5)
  expect(nudges().length).toBe(1)
  expect(await cue(62, 'compact\n')).toBe('compact refused nudge-limit 62\n')
  await tickTwice()
  expect(nudges().length).toBe(1)
})

longTest('the lead reads a nudge as held, with its fixed text', async ($, on) => {
  await lead($, on, [])
  expect(toolDefs.filter((d) => d.includes('"lane_compact"')).at(-1)).toContain("Ask the lane's session to compact. If it asked for that with request_compact on-cue, it compacts now; otherwise it orders the lane to compact: the plugin tells it to save its notes and call request_compact on-cue, whatever its context size, and it compacts at the end of that turn. lane: the lane name.")
  h.autoAnswer = 'held nudged'
  expect(JSON.stringify(await $.tool.call(leadCall('compact')))).toContain('lane_compact refused: held, nudged: the lane was ordered to compact. It is told at the end of its current turn (now, if idle) and compacts itself when it asks on-cue, whatever its context size. If it has not asked within 15 minutes, you are told: then ask the person whether to lane_terminate it. Do not repeat this call unless the text says to retry.')
  h.autoAnswer = 'refused nudge-limit'
  expect(JSON.stringify(await $.tool.call(leadCall('compact')))).toContain('nudge-limit: the lane was nudged in the last 30 minutes, or already got this order. Do not repeat this call')
  h.autoAnswer = 'refused not-interactive'
  expect(JSON.stringify(await $.tool.call(leadCall('compact')))).toContain('not-interactive: the lane session is not an interactive session, so it cannot be nudged. Do not repeat this call')
})

test('a lead nudge to a busy lane is recorded and goes out once the lane is idle', async ($, on) => {
  await renameThroughTick($, on, [], 1)
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  expect(await cue(63, 'compact\n')).toBe('compact held nudged 63\n')
  await ticks(5)
  expect(nudges()).toEqual([])
  // A turn that ends past the level meanwhile does not replace the lead's nudge.
  h.tokensNow = 400_000
  await $.turn.complete(TURN as any)
  h.sessions = { [REGFILE]: REG() }
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('lead')])
})

test('a lead nudge recorded while a mid-turn nudge was being claimed is dropped at idle: nudge-limit, not a second nudge inside the gap', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await renameThroughTick($, on, stdins, 1, trace)
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  expect(await cue(63, 'compact\n')).toBe('compact held nudged 63\n')
  // The mid-turn hook's claim lands after the lead's check read the old counters.
  trace.st!.set('counters', { value: { lastNudgeMs: h.nowMs - 1000, nudgeTimes: [h.nowMs - 1000], lastNudgeKind: 'idle' }, version: 91 })
  h.tokensNow = 350_000
  h.sessions = { [REGFILE]: REG() }
  await ticks(2)
  expect(nudges()).toEqual([])
  expect(logged(stdins)).toContain('nudge-dropped:nudge-limit')
})

test('no lead nudge while the lane has a request in any phase: the answer stays no-request', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace)
  // Request writes are refused, so the tick leaves each phase as it is set here.
  trace.failKeys = new Set(['request'])
  let ino = 70
  for (const p of [{ phase: 'called', mode: 'on-cue' }, { phase: 'armed', mode: 'now' }, { phase: 'compacting', mode: 'now', compactingMs: h.nowMs }, { phase: 'compacted', mode: 'now', compactedMs: h.nowMs }]) {
    trace.st!.set('request', { value: { id: 'r1', focus: 'f', continuation: 'c', sha256: 'a'.repeat(64), requestedMs: h.nowMs, ...p }, version: 20 })
    await cue(ino, 'compact\n')
    expect(resultFiles.get(RESULT), p.phase).toBe(`compact refused no-request ${ino}\n`)
    ino++
  }
  expect(trace.st!.get('nudgeDue')?.value ?? null).toBe(null)
  expect(nudges()).toEqual([])
})

test('a person session is nudged at 300k tokens, not at 299k; the turn end records it and the tick sends it', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 299_999
  psCalls.length = 0
  await $.turn.complete(TURN as any)
  expect(psCalls).toEqual([])
  await ticks(3)
  expect(nudges()).toEqual([])
  h.tokensNow = 300_000
  await $.turn.complete(TURN as any)
  // The hook reads only the tokens and the cheap state: no process check, and the kind is left to the tick.
  expect(psCalls).toEqual([])
  expect(nudges()).toEqual([])
  expect(logged(stdins)).toContain('nudge-due:threshold')
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
  expect(logged(stdins)).toContain('nudged:idle')
})

for (const [what, setup] of [
  ['a background agent', () => { h.agentsNow = [{ status: 'running' }] }],
  ['a background shell', () => { h.psTable = `${SELF_PS} 4400  4999 /bin/zsh -c sleep 90\n` }],
  ['a session that cannot find itself in the process table', () => { h.psTable = PS_TABLE }],
] as const) {
  test(`a working session (${what}) gets the soft text at 300k, not 299k, and the hard text at 400k`, async ($, on) => {
    await person($, on)
    setup()
    h.tokensNow = 299_999
    await $.turn.complete(TURN as any)
    await ticks(2)
    expect(nudges()).toEqual([])
    h.tokensNow = 399_999
    await $.turn.complete(TURN as any)
    await ticks(1)
    expect(nudges()).toEqual([nudgeText('idle')])
    h.tokensNow = 400_000
    await $.turn.complete(TURN as any)
    await ticks(1)
    expect(nudges()).toEqual([nudgeText('idle'), nudgeText('working')])
  })
}

test('a lead is nudged from 300k with the soft text and from 400k with the hard one, idle or not', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.askAnswer = YES
  await $.command.run(lane('lead'))
  await $.turn.complete(TURN as any)
  h.tokensNow = 299_999
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges()).toEqual([])
  expect(logged(stdins)).not.toContain('nudge-due:threshold')
  h.tokensNow = 300_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
  expect(logged(stdins)).toContain('nudged:idle')
  h.tokensNow = 400_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle'), nudgeText('working')])
  expect(logged(stdins)).toContain('nudged:working')
})

test('a lane that has not signed done since its last prompt gets the soft text at 350k and the hard one at 400k (working no longer holds the soft text back)', async ($, on) => {
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  h.tokensNow = 299_999
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges()).toEqual([])
  h.tokensNow = 350_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
  expect(logged(stdins)).not.toContain('nudge-dropped:below-level')
  h.tokensNow = 400_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle'), nudgeText('working')])
})

test('a lane signed done is not nudged by its own level, at any size; its lead can still nudge it', async ($, on) => {
  const stdins: string[] = []
  await retireTarget($, on, stdins)
  h.tokensNow = 400_000
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges()).toEqual([])
  expect(logged(stdins)).toContain('nudge-dropped:lane-done')
  expect(await cue(66, 'compact\n')).toBe('compact held nudged 66\n')
  expect(nudges()).toEqual([nudgeText('lead')])
})

test('a tool call past 300k carries the soft text, past 400k the hard one after it; nothing below 300k, nothing twice, and no new turn is submitted', async ($, on) => {
  postBeneath(on)
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 299_999
  expect(await midCtx($)).toEqual([])
  h.tokensNow = 300_000
  expect(await midCtx($)).toEqual([nudgeText('idle')])
  expect(logged(stdins)).toContain('nudged:idle mid-turn')
  expect(await midCtx($)).toEqual([])
  expect(await midCtx($, 'PostToolUseFailure')).toEqual([])
  h.tokensNow = 400_000
  expect(await midCtx($)).toEqual([nudgeText('working')])
  expect(await midCtx($)).toEqual([])
  await ticks(2)
  expect(nudges()).toEqual([])
})

test('a failed tool call carries the nudge as well', async ($, on) => {
  postBeneath(on)
  await person($, on)
  h.tokensNow = 350_000
  expect(await midCtx($, 'PostToolUseFailure')).toEqual([nudgeText('idle')])
})

test('a working lane (not signed done) gets the soft text in the middle of a turn: a test fails if it gets none', async ($, on) => {
  postBeneath(on)
  const stdins: string[] = []
  await renameThroughTick($, on, stdins, 1)
  h.tokensNow = 350_000
  expect(await midCtx($)).toEqual([nudgeText('idle')])
  h.tokensNow = 400_000
  expect(await midCtx($)).toEqual([nudgeText('working')])
})

test('a lead gets the soft text in the middle of a turn', async ($, on) => {
  postBeneath(on)
  await person($, on)
  laneSeed.text = LEAD_LANES('/data/x/work')
  h.askAnswer = YES
  await $.command.run(lane('lead'))
  h.tokensNow = 300_000
  expect(await midCtx($)).toEqual([nudgeText('idle')])
})

test('a session with background work gets the soft text in the middle of a turn', async ($, on) => {
  postBeneath(on)
  await person($, on)
  h.agentsNow = [{ status: 'running' }]
  h.tokensNow = 300_000
  expect(await midCtx($)).toEqual([nudgeText('idle')])
})

test('a lane signed done gets no nudge in the middle of a turn, at any size', async ($, on) => {
  postBeneath(on)
  await retireTarget($, on, [])
  h.tokensNow = 450_000
  expect(await midCtx($)).toEqual([])
})

test('no nudge in the middle of a turn for a subagent call or a session with a request of its own', async ($, on) => {
  postBeneath(on)
  const trace = newTrace()
  await person($, on, [], trace, true)
  h.tokensNow = 400_000
  expect(await midCtx($, 'PostToolUse', { agent_id: 'sub1' })).toEqual([])
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  expect(await midCtx($)).toEqual([])
})

test('no nudge in the middle of a turn inside the 30-minute compaction gap', async ($, on) => {
  postBeneath(on)
  const trace = newTrace()
  await person($, on, [], trace)
  h.tokensNow = 400_000
  trace.st!.set('counters', { value: { lastCompactMs: h.nowMs - 60_000 }, version: 50 })
  expect(await midCtx($)).toEqual([])
})

test('a nudge recorded at a turn end is taken by the next tool call and the tick does not send it again', async ($, on) => {
  postBeneath(on)
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 300_000
  await $.turn.complete(TURN as any)
  expect(logged(stdins)).toContain('nudge-due:threshold')
  expect(await midCtx($)).toEqual([nudgeText('idle')])
  await ticks(3)
  expect(nudges()).toEqual([])
  expect(await midCtx($)).toEqual([])
})

test('a lead nudge recorded for the tick is left to the tick', async ($, on) => {
  postBeneath(on)
  await renameThroughTick($, on, [], 1)
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  expect(await cue(63, 'compact\n')).toBe('compact held nudged 63\n')
  h.tokensNow = 400_000
  expect(await midCtx($)).toEqual([])
  h.sessions = { [REGFILE]: REG() }
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('lead')])
})

// The fallback (2026-11-08): the engine may drop the context, or the model may read it and not act. A turn that carried a mid-turn nudge and ends with no request_compact
// gets the same nudge once as the idle turn, without waiting for the 30-minute gap.
test('a mid-turn nudge in a turn that ends with no request_compact is sent once more as the idle turn, inside the 30-minute gap, and only once', async ($, on) => {
  postBeneath(on)
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 350_000
  expect(await midCtx($)).toEqual([nudgeText('idle')])
  expect(nudges()).toEqual([])
  await $.turn.complete(TURN as any)
  expect(logged(stdins)).toContain('nudge-due:threshold again')
  await ticks(2)
  expect(nudges()).toEqual([nudgeText('idle')])
  expect(logged(stdins)).toContain('nudged:idle')
  // The resend is not a mid-turn one: nothing more follows, in that turn's end or in the next.
  await $.turn.complete(TURN as any)
  await ticks(3)
  expect(nudges()).toEqual([nudgeText('idle')])
  await $.turn.complete(TURN as any)
  await ticks(3)
  expect(nudges()).toEqual([nudgeText('idle')])
})

test('a mid-turn nudge in a turn that ends with a request_compact of the session is not sent again', async ($, on) => {
  postBeneath(on)
  const stdins: string[] = []
  await person($, on, stdins, undefined, true)
  h.tokensNow = 350_000
  expect(await midCtx($)).toEqual([nudgeText('idle')])
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await ticks(3)
  expect(nudges()).toEqual([])
  expect(logged(stdins).some((x) => x.endsWith(' again'))).toBe(false)
})

test('a mid-turn nudge is not sent again once the session compacted: back under the idle level', async ($, on) => {
  postBeneath(on)
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 350_000
  expect(await midCtx($)).toEqual([nudgeText('idle')])
  h.tokensNow = 250_000
  await $.turn.complete(TURN as any)
  await ticks(3)
  expect(nudges()).toEqual([])
  expect(logged(stdins)).toContain('nudge-dropped:below-level')
})

test('the resend of a mid-turn nudge is a hard one when the turn ended past the working level', async ($, on) => {
  postBeneath(on)
  await person($, on)
  h.tokensNow = 350_000
  expect(await midCtx($)).toEqual([nudgeText('idle')])
  h.tokensNow = 410_000
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges()).toEqual([nudgeText('working')])
})

longTest('a declined nudge is not repeated within 30 minutes; after that the next turn can be nudged again', async ($, on) => {
  await person($, on)
  h.tokensNow = 310_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges().length).toBe(1)
  await $.turn.complete(TURN as any)
  await ticks(2)
  await h.clock!.advance(10 * 60_000)
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges().length).toBe(1)
  await h.clock!.advance(20 * 60_000)
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges().length).toBe(2)
})

test('no self nudge for a subagent turn, a turn that did not end in an answer, or a non-interactive session', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 310_000 // v14: under the working level, so the soft text
  await $.turn.complete({ ...TURN, agentId: 'a1' } as any)
  await $.turn.complete({ ...TURN, isAborted: true, reason: 'aborted' } as any)
  await ticks(2)
  // Not interactive: session.start says no, and the session has no registry row of its own (a -p run).
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  h.ownEntryAuto = false
  await $.turn.complete(TURN as any)
  h.ownEntryAuto = true
  await ticks(2)
  expect(nudges()).toEqual([])
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
})

test('a session.start that says not interactive still counts as a person session when the session has its own registry row (a VS Code panel)', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: false })
  h.tokensNow = 310_000
  h.ownEntryAuto = false
  await $.turn.complete(TURN as any)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  h.ownEntryAuto = true
  await $.turn.complete(TURN as any)
  expect(logged(stdins)).toContain('nudge-due:threshold')
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
})

test('no self nudge while the session has a request of its own, or inside the 30-minute compaction gap', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await person($, on, stdins, trace, true)
  h.tokensNow = 310_000
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  expect(logged(stdins)).toContain('armed:on-cue')
  await $.prompt.submit({ text: 'hello' } as any)
  trace.st!.set('counters', { value: { lastCompactMs: h.nowMs - 60_000 }, version: 50 })
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(logged(stdins).some((x) => x.startsWith('nudge-'))).toBe(false)
  expect(nudges()).toEqual([])
})

test('off drops a recorded nudge and the grant; a later turn past the level is nudged again (off does not opt out)', async ($, on) => {
  const trace = newTrace()
  await person($, on, [], trace)
  h.tokensNow = 310_000
  h.draftNow = 'typing'
  await $.turn.complete(TURN as any)
  trace.st!.set('nudgedAt', { value: h.nowMs, version: 60 })
  expect(trace.st!.get('nudgeDue')?.value).not.toBe(null)
  await $.command.run(lane('off'))
  expect(trace.st!.get('nudgeDue')?.value ?? null).toBe(null)
  expect(trace.st!.get('nudgedAt')?.value ?? null).toBe(null)
  h.draftNow = ''
  await ticks(2)
  expect(nudges()).toEqual([])
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
})

test('a recorded nudge is dropped once the session no longer counts as interactive', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 310_000
  h.draftNow = 'typing'
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(logged(stdins).some((x) => x.startsWith('nudge-dropped'))).toBe(false)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  h.ownEntryAuto = false
  await ticks(1)
  expect(logged(stdins)).toContain('nudge-dropped:not-interactive')
  h.ownEntryAuto = true
  h.draftNow = ''
  await ticks(2)
  expect(nudges()).toEqual([])
})

test('a nudge waits while a draft sits in the box and is dropped after 10 minutes', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 310_000
  h.draftNow = 'typing'
  await $.turn.complete(TURN as any)
  await h.clock!.advance(9 * 60_000)
  expect(nudges()).toEqual([])
  expect(logged(stdins)).not.toContain('nudge-dropped:expired')
  await h.clock!.advance(2 * 60_000)
  expect(logged(stdins)).toContain('nudge-dropped:expired')
  h.draftNow = ''
  await ticks(2)
  expect(nudges()).toEqual([])
})

test('a recorded nudge is dropped once the session asks on its own, or once it may no longer compact', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins, undefined, true)
  h.tokensNow = 310_000
  h.draftNow = 'typing'
  await $.turn.complete(TURN as any)
  expect((await $.tool.call(GOOD as any)).result).toBe('queued')
  await ticks(1)
  expect(logged(stdins)).toContain('nudge-dropped:request')
  await $.prompt.submit({ text: 'hello' } as any)
  await $.turn.complete(TURN as any)
  h.tokensNow = 50_000
  await ticks(1)
  expect(logged(stdins)).toContain('nudge-dropped:context-floor')
  h.draftNow = ''
  await ticks(2)
  expect(nudges()).toEqual([])
})

test('a recorded nudge survives a reload within 10 minutes and is still sent', async ($, on) => {
  await person($, on)
  h.tokensNow = 310_000
  h.draftNow = 'typing'
  await $.turn.complete(TURN as any)
  await h.clock!.advance(60_000)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  h.draftNow = ''
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
})

test('a nudge whose submit outlasts the timeout is logged unconfirmed and never sent again', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 310_000
  h.submitHangs = true
  await $.turn.complete(TURN as any)
  await ticks(35)
  expect(logged(stdins)).toContain('nudge-unconfirmed:idle')
  h.submitHangs = false
  await ticks(5)
  expect(nudges()).toEqual([nudgeText('idle')])
})
// A person's session with no lane, nudged once at the idle level.
async function granted($: any, on: any, stdins: string[] = [], trace: Trace = { log: [], failCounters: false }) {
  await person($, on, stdins, trace)
  await $.command.run(lane('off'))
  h.tokensNow = 310_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
  return trace
}

test('an unbound session is nudged; request_compact on-cue is refused, and a now request within 15 minutes of the nudge is the nudged one', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('off'))
  h.tokensNow = 310_000
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain(NOT_ENABLED)
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
  await h.clock!.advance(14 * 60_000)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect(logged(stdins)).toContain('requested:now-nudged')
})

test('the grant ends 15 minutes after the nudge: a now request then is the session\'s own (self), not the nudged one', async ($, on) => {
  const stdins: string[] = []
  await granted($, on, stdins)
  await h.clock!.advance(15 * 60_000)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect(logged(stdins)).toContain('requested:now-self')
  expect(logged(stdins)).not.toContain('requested:now-nudged')
})

test('under the grant an on-cue request is always refused, and does not spend the grant', async ($, on) => {
  const stdins: string[] = []
  await granted($, on, stdins)
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain(NOT_ENABLED)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
})

test('under the grant the input is checked first; a refused input keeps the grant', async ($, on) => {
  await granted($, on)
  expect(JSON.stringify(await $.tool.call({ ...NOW, focus: '/compact' } as any))).toContain('request_compact refused: focus')
  expect(JSON.stringify(await $.tool.call({ ...NOW, mode: 'later' } as any))).toContain('request_compact refused: mode')
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
})

test('the grant is spent on use: the request says viaNudge, nudgedAt is cleared, and a second request is the session\'s own (self)', async ($, on) => {
  const stdins: string[] = []
  const trace = await granted($, on, stdins)
  expect(typeof trace.st!.get('nudgedAt')?.value).toBe('number')
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect((trace.st!.get('request')?.value as any).viaNudge).toBe(true)
  expect(trace.st!.get('nudgedAt')?.value).toBe(null)
  expect(logged(stdins).filter((x) => x.startsWith('requested:'))).toEqual(['requested:now-nudged'])
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect(logged(stdins).filter((x) => x.startsWith('requested:'))).toEqual(['requested:now-nudged', 'requested:now-self'])
})

test('a bound session never gets viaNudge, and its own request clears nudgedAt too', async ($, on) => {
  const trace = newTrace()
  const stdins: string[] = []
  await person($, on, stdins, trace, true)
  // A lane that has not signed done is working: its level is the working one.
  h.tokensNow = 410_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges().length).toBe(1)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect((trace.st!.get('request')?.value as any).viaNudge).toBeUndefined()
  expect(trace.st!.get('nudgedAt')?.value).toBe(null)
  expect(logged(stdins)).toContain('requested:now')
  expect(logged(stdins)).not.toContain('requested:now-nudged')
})

test('a bound lane nudged by its lead never gets viaNudge', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace)
  expect(await cue(64, 'compact\n')).toBe('compact held nudged 64\n')
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('lead')])
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect((trace.st!.get('request')?.value as any).viaNudge).toBeUndefined()
  expect(trace.st!.get('nudgedAt')?.value).toBe(null)
})

longTest('a nudge submit that threw takes the grant back; one that outlasts the timeout keeps it', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await person($, on, stdins, trace)
  await $.command.run(lane('off'))
  h.tokensNow = 310_000
  h.submitFails = true
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(logged(stdins)).toContain('nudge-failed:idle')
  expect(trace.st!.get('nudgedAt')?.value).toBe(null)
  h.submitFails = false
  await h.clock!.advance(30 * 60_000)
  h.submitHangs = true
  await $.turn.complete(TURN as any)
  await ticks(35)
  expect(logged(stdins)).toContain('nudge-unconfirmed:idle')
  h.submitHangs = false
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect(logged(stdins)).toContain('requested:now-nudged')
})

longTest('a granted request runs the now path, and its resume is still sent after PostCompact when the compaction outlives the 15 minutes', async ($, on) => {
  const stdins: string[] = []
  on('classic.PostCompact', () => ({}))
  const trace = await granted($, on, stdins)
  await h.clock!.advance(10 * 60_000)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(seen.compacted).toBe(true)
  expect((trace.st!.get('request')?.value as any).phase).toBe('compacting')
  await h.clock!.advance(10 * 60_000)
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' })
  expect((trace.st!.get('request')?.value as any).phase).toBe('compacted')
  await ticks(1)
  expect(submitted.filter((t) => t.startsWith('[compact-cue] This conversation was compacted'))).toEqual([compactResumeText(NOW.continuation)])
  expect(logged(stdins)).toContain('resumed:compact')
})

test('off in a session that is neither a lane nor a lead leaves its granted compaction alone: the resume still goes, and off says nothing was turned off', async ($, on) => {
  const stdins: string[] = []
  on('classic.PostCompact', () => ({}))
  const trace = await granted($, on, stdins)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect((trace.st!.get('request')?.value as any).phase).toBe('compacting')
  expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
  expect((trace.st!.get('request')?.value as any).viaNudge).toBe(true)
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' })
  await ticks(1)
  expect(submitted.filter((t) => t.startsWith('[compact-cue] This conversation was compacted'))).toEqual([compactResumeText(NOW.continuation)])
  expect(logged(stdins)).toContain('resumed:compact')
})

test('off in a session that is neither a lane nor a lead leaves a pending request of its own as it is', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await person($, on, stdins, trace)
  trace.st!.set('request', { value: { id: 'r1', phase: 'called', mode: 'now', focus: 'f', continuation: 'c', sha256: 'a'.repeat(64), requestedMs: h.nowMs, viaNudge: true }, version: 5 })
  expect((await $.command.run(lane('off'))).text).toBe(OFF_NOTHING)
  expect((trace.st!.get('request')?.value as any)?.id).toBe('r1')
  expect(logged(stdins)).not.toContain('dropped:disabled')
})

test('off during a lead\'s own compaction lets it finish but sends no resume: the request loses the grant, and off says so', async ($, on) => {
  const stdins: string[] = []
  on('classic.PostCompact', () => ({}))
  const trace = newTrace()
  await leadAt($, on, stdins, { clock: true, trace })
  trace.st!.set('request', { value: { id: 'r1', phase: 'compacting', mode: 'now', focus: 'f', continuation: 'next', sha256: 'a'.repeat(64), requestedMs: h.nowMs, compactingMs: h.nowMs, viaNudge: true }, version: 5 })
  expect((await $.command.run(lane('off'))).text).toBe('Lead is now off. The compaction under way will not resume the work.')
  expect((trace.st!.get('request')?.value as any).phase).toBe('compacting')
  expect((trace.st!.get('request')?.value as any).viaNudge).toBeUndefined()
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' })
  await tickTwice()
  expect(submitted.filter((t) => t.startsWith('[compact-cue] This conversation was compacted'))).toEqual([])
  expect(logged(stdins)).toContain('dropped:not-eligible')
})

test('a turn-end level check never replaces a lead nudge recorded while it ran', async ($, on) => {
  const trace = newTrace()
  const stdins: string[] = []
  await person($, on, stdins, trace)
  h.tokensNow = 310_000
  h.usageHook = () => {
    const cur = trace.st!.get('nudgeDue')
    trace.st!.set('nudgeDue', { value: { kind: 'lead', at: 1 }, version: (cur?.version ?? 0) + 1 })
  }
  await $.turn.complete(TURN as any)
  expect((trace.st!.get('nudgeDue')?.value as any).kind).toBe('lead')
  expect(logged(stdins)).toContain('nudge-skipped:changed')
})

test('a granted session that is not a lane refuses every cue: rename by the birth checks, the others as not-eligible; on-cue is never armed', async ($, on) => {
  const trace = await granted($, on)
  // A lane record in this folder and a fresh unnamed panel row: only the turns the session has had keep it from a birth rename.
  laneSeed.text = JSON.stringify({ lanes: [{ name: 'LABLANE', folder: '/data/x/work/lab', brief: '/data/x/work/lab/BRIEF.md', repo: '/data/x/work' }] })
  h.sessions = { [REGFILE]: REG() }
  h.turnsNow = 5
  expect(await cue(120, 'rename LABLANE\n')).toBe('rename refused not-empty 120\n')
  expect(trace.st!.get('lane')?.value ?? null).toBe(null)
  let ino = 121
  for (const verb of ['start', 'resume', 'retire', 'compact']) {
    await cue(ino, `${verb}\n`)
    expect(resultFiles.get(RESULT), verb).toBe(`${verb} refused not-eligible ${ino}\n`)
    ino++
  }
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain(NOT_ENABLED)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect(await cue(ino, 'compact\n')).toBe(`compact refused not-eligible ${ino}\n`)
})

test('a prompt of the person ends the grant; the nudge, a prompt of the mod\'s own, does not', async ($, on) => {
  const stdins: string[] = []
  const trace = await granted($, on, stdins)
  // The engine runs prompt.submit for the mod's own submit too (the kit does not): it is passed through here, and keeps the grant.
  await $.prompt.submit({ text: nudgeText('idle') } as any)
  expect(typeof trace.st!.get('nudgedAt')?.value).toBe('number')
  await $.prompt.submit({ text: 'something else first' } as any)
  expect(trace.st!.get('nudgedAt')?.value ?? null).toBe(null)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect(logged(stdins)).toContain('requested:now-self')
  expect(logged(stdins)).not.toContain('requested:now-nudged')
})

longTest('a lead nudge while one is pending is answered nudged without moving its time', async ($, on) => {
  const stdins: string[] = []
  const trace = newTrace()
  await renameThroughTick($, on, stdins, 1, trace)
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  expect(await cue(67, 'compact\n')).toBe('compact held nudged 67\n')
  const first = (trace.st!.get('nudgeDue')?.value as any).at
  await h.clock!.advance(60_000)
  expect(await cue(68, 'compact\n')).toBe('compact held nudged 68\n')
  expect(trace.st!.get('nudgeDue')?.value).toEqual({ kind: 'lead', at: first })
  expect(logged(stdins)).toContain('nudge-pending:lead')
  // Still the first time: it expires 10 minutes after the first cue, not the second.
  await h.clock!.advance(9 * 60_000)
  expect(logged(stdins)).toContain('nudge-dropped:expired')
  expect(nudges()).toEqual([])
})

test('a lead nudge while a threshold nudge is pending turns it into the lead\'s, with its own time, so it goes out below the working level', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace)
  h.sessions = { [REGFILE]: REG({ status: 'busy' }) }
  const at = h.nowMs
  trace.st!.set('nudgeDue', { value: { kind: 'threshold', at }, version: 70 })
  expect(await cue(69, 'compact\n')).toBe('compact held nudged 69\n')
  expect(trace.st!.get('nudgeDue')?.value).toEqual({ kind: 'lead', at })
  h.tokensNow = 300_000
  h.sessions = { [REGFILE]: REG() }
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('lead')])
})

test('a lead nudge to a lane session that is not interactive is refused not-interactive, and none is recorded', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace)
  trace.st!.set('interactive', { value: false, version: 80 })
  h.sessions = {}
  h.ownEntryAuto = false
  expect(await cue(71, 'compact\n')).toBe('compact refused not-interactive 71\n')
  expect(trace.st!.get('nudgeDue')?.value ?? null).toBe(null)
})

// ---- 2026-11-02: any interactive session may compact itself now, with no lane ----
test('an interactive session that is not a lane and not on may compact itself now with no nudge, and the compaction runs to the end, resume included', async ($, on) => {
  const stdins: string[] = []
  on('classic.PostCompact', () => ({}))
  const trace = newTrace()
  await person($, on, stdins, trace)
  await $.command.run(lane('off'))
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect(logged(stdins)).toContain('requested:now-self')
  expect((trace.st!.get('request')?.value as any).viaNudge).toBe(true)
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(seen.compacted).toBe(true)
  await ($ as any).classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' })
  await ticks(1)
  expect(submitted.filter((t) => t.startsWith('[compact-cue] This conversation was compacted'))).toEqual([compactResumeText(NOW.continuation)])
  expect(logged(stdins)).toContain('resumed:compact')
})

test('a self session still refuses on-cue and every lead cue; a session that is not interactive is refused now too', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  await $.command.run(lane('off'))
  expect(JSON.stringify(await $.tool.call(GOOD as any))).toContain(NOT_ENABLED)
  expect((await $.tool.call(NOW as any)).result).toBe('queued')
  expect(await cue(140, 'compact\n')).toBe('compact refused not-eligible 140\n')
  expect(await cue(141, 'resume\n')).toBe('resume refused not-eligible 141\n')
  // Not interactive: session.start says no, and the session has no registry row of its own (a -p run).
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  h.ownEntryAuto = false
  expect(JSON.stringify(await $.tool.call(NOW as any))).toContain(NOT_ENABLED)
  h.ownEntryAuto = true
})

test('a claude --bg worker (its own row is kind background) gets no threshold nudge', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  h.sessions = OWN_ROW({ kind: 'background' })
  h.tokensNow = 310_000 // v14: under the working level, so the soft text
  await $.turn.complete(TURN as any)
  await ticks(3)
  expect(logged(stdins).some((x) => x.startsWith('nudge-due'))).toBe(false)
  expect(nudges()).toEqual([])
  // The same session with a person's row is nudged.
  h.sessions = OWN_ROW()
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
})

test('a lane_compact nudge to a lane whose own row is kind background is refused not-interactive', async ($, on) => {
  const trace = newTrace()
  await renameThroughTick($, on, [], 1, trace)
  h.sessions = { [REGFILE]: REG({ kind: 'background' }) }
  expect(await cue(150, 'compact\n')).toBe('compact refused not-interactive 150\n')
  expect(trace.st!.get('nudgeDue')?.value ?? null).toBe(null)
  h.sessions = { [REGFILE]: REG() }
  expect(await cue(151, 'compact\n')).toBe('compact held nudged 151\n')
})

test('nudge: an idle session at or past the working level gets the hard text, under it the soft one', async ($, on) => {
  await person($, on)
  // Review c1 (S7): one token under the working level, the soft text.
  h.tokensNow = 399_999
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
  expect(nudges()[0]).toContain('Your context is past 300k tokens. Compact at your next natural boundary')
  h.tokensNow = 400_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle'), nudgeText('working')])
  expect(nudges()[1]).toContain('Your context is past 400k tokens. Stop as soon as you can, even mid-item')
  expect(nudges()[1]).toContain('If a background agent or shell is still running, call request_compact at the end of the turn in which it finishes, not before.')
})

longTest('nudge: a soft nudge may be followed by one hard one inside the 30-minute gap, never by a second hard one', async ($, on) => {
  const stdins: string[] = []
  await person($, on, stdins)
  h.tokensNow = 310_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle')])
  await h.clock!.advance(5 * MIN)
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges().length).toBe(1)
  h.tokensNow = 410_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle'), nudgeText('working')])
  await h.clock!.advance(5 * MIN)
  h.tokensNow = 450_000
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges().length).toBe(2)
  await h.clock!.advance(30 * MIN)
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('idle'), nudgeText('working'), nudgeText('working')])
})

longTest('nudge: a hard nudge is not followed by a soft one inside the gap; the numbers in both texts follow the config', async ($, on) => {
  await person($, on)
  await $.command.run(lane('config idle 200'))
  await $.command.run(lane('config working 300'))
  const lv = { idleK: 200, workingK: 300 }
  h.tokensNow = 300_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('working', lv)])
  expect(nudges()[0]).toContain('past 300k tokens. Stop as soon as you can')
  await h.clock!.advance(5 * MIN)
  h.tokensNow = 250_000
  await $.turn.complete(TURN as any)
  await ticks(2)
  expect(nudges().length).toBe(1)
  await h.clock!.advance(26 * MIN)
  h.tokensNow = 250_000
  await $.turn.complete(TURN as any)
  await ticks(1)
  expect(nudges()).toEqual([nudgeText('working', lv), nudgeText('idle', lv)])
  expect(nudges()[1]).toContain('past 200k tokens. Compact at your next natural boundary')
})
