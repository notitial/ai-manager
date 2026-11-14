// The new panel's side of a conductor's lead offer (ADR 0006): the cue `lead <nonce>` only makes this session look at the offer for its own repo. Every check runs
// here, in this session, and nothing a conductor, a lane or a file says makes it a lead by itself. The order: the session's own state (cheap reads, nothing written),
// the offer file, the ledger, the person's switch, the conductor, other leads, the exclusive claim, the idle check, the rename, the same checks once more, the
// ledger row (no row, no grant), the grant through the lead command's own steps, then the offer and claim go, the model is set, the start turn is held, and the
// conductor is answered. A read that fails or times out is a refusal: nothing defaults to yes. The panel acts within LEAD_ACCEPT_LATE_MS of the cue file's time.
import * as c from '../core.ts'
import { grants, leadStarts, laneBinding, offSeq } from '../mem.ts'
import { log, logq, sha, where, real, statR, readSmallR, gitRoot, rmF, withTimeout, pause, toast, dirOk } from './base.ts'
import { registryEntries, idleCheck } from './store.ts'
import type { Reg, Answer } from './store.ts'
import { sessionRoot, modelSet } from './lanes.ts'
import { leadBusy, conductorsTrusted, leadsFor, cfgReadStrict } from './grants.ts'
import { heldNo } from './levels.ts'
import { ledgerAdd, ledgerRowsFor } from './answer-hook.ts'
import { promptLinkOnce } from './answer-tiers.ts'
import { grantLead } from './commands.ts'

// The wait for the registry to carry the new name, in 1 s tries.
const NAME_TRIES = 5

// x.seq: the off counter, read before the first await of the cue's handling. x.seen: when this module first saw the session (undefined: never recorded).
export async function leadAccept(
  $: any,
  sid: string,
  cue: c.Cue,
  x: { bound: boolean; seen: number | undefined; seq: number; cueMtimeMs: number; reg: Reg; refuse: (reason: string) => Promise<void>; hold: (reason: string) => Promise<void>; answer: Answer },
) {
  const { reg, refuse, hold, answer } = x
  const nonce = cue.nonce as string
  const stop = (code: string) => (c.LEAD_HELD_CODES.includes(code) ? hold(code) : refuse(code))
  const bounded = async <T,>(p: Promise<T>): Promise<T | undefined> => {
    try {
      const r = await withTimeout($, p, c.ENGINE_CALL_TIMEOUT_MS)
      return r === 'timeout' ? undefined : r
    } catch {
      return undefined
    }
  }
  const tooLate = async () => c.leadLate(await $.clock.now(), x.cueMtimeMs)
  const now = await $.clock.now()
  if (c.leadLate(now, x.cueMtimeMs)) return stop('late')

  // This session. Its own registry row, folder, turns and holds; the row is read whole.
  const p = await where($)
  if (!p) return refuse('unsafe-dir')
  const rows = await reg()
  const mine = rows?.filter((e) => e.j.sessionId === sid)
  const j = mine?.length === 1 ? mine[0].j : undefined
  const root = await bounded(sessionRoot($))
  const rootOk = typeof root === 'string' && root !== '' && c.isCleanAbs(root)
  const isRepoRoot = rootOk && (await bounded(real($, root))) === root && (await bounded(gitRoot($, root))) === 'yes'
  const turns = (await bounded(Promise.resolve($.session.turns()))) ?? NaN
  const heldR = await withTimeout($, heldNo($, sid, 'lead', true), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  const self = c.leadSelfNo({
    now,
    bound: x.bound,
    laneRecord: laneBinding.has(sid),
    busy: leadBusy(sid),
    held: heldR === 'timeout' ? 'grant-failed' : heldR,
    isRepoRoot,
    rows: mine?.length,
    kind: typeof j?.kind === 'string' ? j.kind : undefined,
    startedAt: typeof j?.startedAt === 'number' ? j.startedAt : undefined,
    seenMs: x.seen,
    turns,
    nameSource: typeof j?.nameSource === 'string' ? j.nameSource : undefined,
  })
  if (self) return stop(self)
  const repo = root as string

  // The offer file, at the key of this session's own folder (never one the cue names).
  const key = await sha($, repo)
  const dir = `${p.root}/offers`
  const dst = await statR($, dir)
  if (dst === 'absent') return refuse('offer-missing')
  if (dst === 'error' || !(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return refuse('unsafe-offers-dir')
  const offerPath = `${dir}/${key}.json`
  const claimPath = `${dir}/${key}.claim`
  const ost = await statR($, offerPath)
  if (ost === 'absent') return refuse('offer-missing')
  if (ost === 'error') return refuse('offer-bad')
  const readOffer = async () => {
    let r = await readSmallR($, offerPath, p.uid, c.OFFER_MAX)
    if (r.state === 'changed' || r.state === 'failed') r = await readSmallR($, offerPath, p.uid, c.OFFER_MAX)
    return r.state === 'ok' ? c.parseOffer(r.text) : undefined
  }
  const offer = await readOffer()
  if (!offer) return refuse('offer-bad')
  const names = (rows ?? []).filter((e) => e.j.sessionId !== sid).flatMap((e) => (typeof e.j.name === 'string' ? [e.j.name.toLowerCase()] : []))
  const offerNo = c.leadOfferNo(offer, { now, cueNonce: nonce, repo, liveNames: names })
  if (offerNo) return refuse(offerNo)

  // The ledger, then the switch, the conductor and the other leads, read afresh each time they are asked.
  const ledgerNo = async () => {
    const l = await ledgerRowsFor($, p, `"hash":"${key}"`)
    return l === 'unreadable' ? 'ledger-unreadable' : c.leadLedgerNo(l, offer, key)
  }
  const ledgerRefusal = await ledgerNo()
  if (ledgerRefusal) return refuse(ledgerRefusal)
  const trustNo = async (): Promise<string | undefined> => {
    const cfg = await bounded(cfgReadStrict($, sid))
    const live = await registryEntries($)
    if (!live) return 'registry-unreadable'
    const cond = live.find((r) => r.j.sessionId === offer.conductor.sid && String(r.j.pid) === r.pid && r.pid === String(offer.conductor.pid) && c.sameStart(r.j.procStart, offer.conductor.start))
    const trusted = cond !== undefined && (await bounded(conductorsTrusted($, live, sid, repo)))?.some((t) => t.sid === offer.conductor.sid) === true
    const errs = { error: false }
    const leads = await bounded(leadsFor($, live, undefined, repo, errs))
    return c.leadTrustNo({
      switchOn: cfg === undefined ? undefined : cfg.conductorLeads === true,
      conductorLive: cond !== undefined,
      conductorTrusted: trusted,
      leadsError: errs.error || leads === undefined,
      otherLeads: leads?.filter((l) => l.sid !== sid).length ?? 0,
    })
  }
  const trustRefusal = await trustNo()
  if (trustRefusal) return refuse(trustRefusal)

  // The claim, created exclusively with this session's id. The same session finds its own claim again (a retry after `held`); any other claim is taken.
  const claimedBySelf = async () => {
    const r = await readSmallR($, claimPath, p.uid, 64)
    return r.state === 'ok' && r.text === sid
  }
  if (await tooLate()) return stop('late')
  const put = await promptLinkOnce($, claimPath, sid)
  if (put === 'failed') return refuse('offer-bad')
  if (put === 'exists' && !(await claimedBySelf())) return refuse('lead-offer-taken')

  // Idle (no draft, registry idle), then the rename. A refusal from here on leaves the offer and claim for the conductor to take back.
  const idle = await withTimeout($, idleCheck($, sid, () => registryEntries($)), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'not-idle' as const)
  if (idle === 'timeout') return hold('not-idle')
  if (idle) return stop(idle)
  if (await tooLate()) return stop('late')
  const t0 = await bounded(Promise.resolve($.session.turns()))
  if (t0 === undefined) return hold('not-idle')
  if (t0 !== 0) return refuse('not-new-panel')
  let renamed: unknown
  try {
    renamed = await withTimeout($, $.command.run({ command: 'rename', args: offer.name }), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return refuse('rename-failed')
  }
  if (renamed === 'timeout') {
    await log($, sid, 'error', 'rename-timeout')
    return refuse('rename-failed')
  }
  let named = false
  for (let i = 0; i < NAME_TRIES && !named; i++) {
    const rs = await registryEntries($)
    named = rs !== undefined && c.leadNameOf(rs.map((r) => r.j), sid) === offer.name
    if (!named && i < NAME_TRIES - 1) await pause($, 1000)
  }
  if (!named) return refuse('rename-failed')
  await log($, sid, 'renamed', 'lead')

  // The checks again, now that the waits are behind. The rename adds at most one turn.
  if (c.bindTurns(t0, (await bounded(Promise.resolve($.session.turns()))) ?? NaN) === undefined) return refuse('not-new-panel')
  if (await tooLate()) return refuse('late')
  const again = await readOffer()
  if (!again || c.offerText(again) !== c.offerText(offer)) return refuse('offer-bad')
  if (!(await claimedBySelf())) return refuse('lead-offer-taken')
  const ledgerAgain = await ledgerNo()
  if (ledgerAgain) return refuse(ledgerAgain)
  const trustAgain = await trustNo()
  if (trustAgain) return refuse(trustAgain)

  // The ledger row first. No row, no grant; a failure after the row writes a void row of the same nonce, which gives the repo its hour back.
  if (await tooLate()) return refuse('late')
  if (!(await ledgerAdd($, { kind: 'lead-grant', hash: key, repo, lane: offer.name, nonce, by: offer.conductor.sid, target: sid }))) return refuse('ledger-write')
  const voided = (code: string) => ledgerAdd($, { kind: 'lead-offer-void', hash: key, nonce, code })
  const failed = async (code: string) => {
    await voided(code)
    return refuse(code)
  }

  // The grant, through the lead command's own steps with its question skipped. The last guard runs just before the grant is set.
  let r: Awaited<ReturnType<typeof grantLead>>
  try {
    r = await grantLead($, sid, 'plugin', async () => ({ text: 'busy', code: 'grant-failed' }), {
      silent: true,
      seq: x.seq,
      pinned: repo,
      onLog: ['lead-on', `via conductor ${offer.conductor.sid.slice(0, 8)}`],
      toast: c.leadOnToast(offer.name, offer.conductor.sid, repo),
      extraRecheck: async () => {
        if (await tooLate()) return { text: 'late', code: 'late' }
        // The ledger row is ours by now (a lead-offer-void of the nonce is the only thing that ends the offer); the switch and the conductor are read once more.
        const l = await ledgerRowsFor($, p, `"hash":"${key}"`)
        if (l === 'unreadable' || l.some((x) => x.nonce === nonce && x.kind === 'lead-offer-void')) return { text: 'offer used', code: 'offer-used' }
        const t = await trustNo()
        return t ? { text: t, code: t } : undefined
      },
      extraApply: async () => {
        const last = await readOffer()
        if (!last || last.nonce !== nonce) return { text: 'offer gone', code: 'offer-bad' }
        return (await tooLate()) ? { text: 'late', code: 'late' } : undefined
      },
    })
  } catch {
    // A throw after the grant was set (a save, the presence file or the briefing) leaves a lead: it carries on to the answer, never a void row for a live lead.
    if (grants.get(sid)?.level !== 'lead') return failed('grant-failed')
    r = { text: 'granted' }
    toast($, c.leadOnToast(offer.name, offer.conductor.sid, repo))
  }
  if (r.code !== undefined || grants.get(sid)?.level !== 'lead') return failed(r.code ?? ((offSeq.get(sid) ?? 0) !== x.seq ? 'off-meanwhile' : 'grant-failed'))

  // The offer and claim go, the model is set (/model adds a turn, so it comes before the turn count the start turn is held against), then the answer.
  const before = await bounded(Promise.resolve($.session.turns()))
  await rmF($, [offerPath, claimPath])
  const modelOk = await modelSet($, offer.model)
  if (!modelOk) {
    await logq($, sid, 'error', 'lead-model')
    toast($, `Lead ${offer.name} runs on the window's own model: the model the conductor asked for (${offer.model}) could not be set.`)
  }
  // The baseline is the count before /model ran plus the turn it adds, so a turn typed meanwhile is not counted away.
  const baseline = before === undefined ? undefined : before + (modelOk ? 1 : 0)
  leadStarts.set(sid, { name: offer.name, repo, brief: c.briefPath(repo, offer.name), turns: baseline ?? NaN, until: (await $.clock.now()) + c.LEAD_START_GIVE_UP_MS })
  return answer('ok', modelOk ? undefined : c.LEAD_MODEL_UNSET)
}
