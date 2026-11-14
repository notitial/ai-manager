// The timers around a lead offer (ADR 0006). leadStartTick: the new lead's start turn, held until its panel is idle with an empty box. offerSweep: a conductor
// takes away its own offers that nobody answered, and voids their ledger rows. conductorGrantCheck: a conductor tells the person of a grant in its name that it did not ask for.
import * as c from '../core.ts'
import { leadStarts, grants, mem, offerSweptAt, condOffers, grantCheckedAt, grantTold } from '../mem.ts'
import type { LeadStart } from '../mem.ts'
import { HEAD, where, statR, readSmallR, dirOk, run, REALPATH, facts, log, logq, sha, submitOwn, toast, rmF } from './base.ts'
import { idleCheck } from './store.ts'
import { ledgerAdd, ledgerRowsFor } from './answer-hook.ts'

async function give($: any, sid: string, l: LeadStart, why: string) {
  leadStarts.delete(sid)
  await log($, sid, 'lead-start-dropped', why)
  // Only a turn the person began is a reason that needs no word: every other drop leaves a lead that was told to wait for a first turn.
  if (why !== 'turn-began') toast($, c.leadNotStartedToast(l.name, l.repo))
}

// Once the grant has taken the offer, the lead's first turn is held in memory: sent when the panel is idle with no draft, only while no turn has begun since
// the grant (turns equal the baseline) and the brief is still the plain file the conductor wrote. Anything else drops it; ten minutes unsent drop it with a toast.
export async function leadStartTick($: any, sid: string, submitsAtStart: number) {
  const l = leadStarts.get(sid)
  if (!l) return
  if (grants.get(sid)?.level !== 'lead') {
    leadStarts.delete(sid)
    return
  }
  const now = await $.clock.now()
  if (now > l.until) return give($, sid, l, 'give-up')
  const turns = await $.session.turns()
  if (turns !== l.turns) return give($, sid, l, 'turn-began')
  if ((await idleCheck($, sid)) !== undefined) return
  // The brief: a plain file of the user's, one link, within the repo, starting with the conductor's header line.
  const p = await where($)
  if (!p) return
  const bf = await facts($, l.brief)
  if (!bf || bf.kind !== 'file' || bf.nlink !== 1 || bf.uid !== p.uid || bf.size > 65_536) return give($, sid, l, 'brief-file')
  const real = (await run($, [REALPATH, '--', l.brief])).stdout.trim()
  const realRepo = (await run($, [REALPATH, '--', l.repo])).stdout.trim()
  if (!real || !realRepo || !c.within(realRepo, real)) return give($, sid, l, 'brief-path')
  // Its first line is still the conductor's header (the bytes after it are the task and are not read here).
  const head = c.leadBriefHead(l.name)
  const h = await run($, [HEAD, '-c', String(head.length), '--', l.brief])
  if (h.exitCode !== 0 || h.stdout !== head) return give($, sid, l, 'brief-head')
  // Every read is behind: a draft, another turn or another submit meanwhile wins, and nothing is awaited between the last guard and the submit.
  const draft = (await $.prompt.read()).text
  if (draft !== '' || mem.submits !== submitsAtStart || leadStarts.get(sid) !== l || grants.get(sid)?.level !== 'lead' || (await $.session.turns()) !== l.turns) return
  leadStarts.delete(sid)
  try {
    await submitOwn($, c.leadStartText(l.name, l.repo, l.brief))
  } catch {
    await logq($, sid, 'error', 'lead-start-failed')
    return
  }
  await log($, sid, 'lead-started', l.name)
}

const SWEEP_EVERY_MS = 60_000
const OFFER_FILE = /^[0-9a-f]{64}\.json$/

// A conductor's own offers older than OFFER_STALE_MS that no panel answered: the row is voided as expired first (a failed write leaves the files for the next
// minute), then the offer and its claim go. An offer of another conductor is left to that conductor. At most OFFER_SWEEP_MAX entries are read, once a minute.
export async function offerSweep($: any, sid: string) {
  const now = await $.clock.now()
  const last = offerSweptAt.get(sid)
  if (last !== undefined && now - last < SWEEP_EVERY_MS) return
  offerSweptAt.set(sid, now)
  const p = await where($)
  if (!p) return
  const dir = `${p.root}/offers`
  if ((await statR($, dir)) === 'absent' || !(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return
  const list = ((await $.fs.list(dir).catch(() => [])) as { name: string; kind: string; isLink: boolean; mtimeMs: number }[]).slice(0, c.OFFER_SWEEP_MAX)
  for (const f of list) {
    if (!OFFER_FILE.test(f.name) || f.kind !== 'file' || f.isLink || !(now - f.mtimeMs > c.OFFER_STALE_MS)) continue
    const path = `${dir}/${f.name}`
    const r = await readSmallR($, path, p.uid, c.OFFER_MAX)
    if (r.state !== 'ok') continue
    const offer = c.parseOffer(r.text)
    if (!offer || offer.conductor.sid !== sid) continue
    const key = f.name.slice(0, 64)
    if ((await sha($, offer.repo)) !== key) continue
    const rows = await ledgerRowsFor($, p, `"hash":"${key}"`)
    if (rows === 'unreadable') continue
    const mine = rows.filter((x) => x.nonce === offer.nonce && x.hash === key)
    // A grant or a void of this nonce already closed it: only the files are left.
    if (!mine.some((x) => x.kind === 'lead-grant' || x.kind === 'lead-offer-void') && !(await ledgerAdd($, { kind: 'lead-offer-void', hash: key, nonce: offer.nonce, code: 'expired' }))) continue
    await rmF($, [path, `${dir}/${key}.claim`])
    await logq($, sid, 'lead-offer-expired', offer.name)
  }
}

// The conductor's own check on the grants made in its name: the ledger rows of the last day that are lead-grant rows by this session and carry a nonce it has no record of
// offering. Each such grant is toasted once. Once a minute; a ledger that cannot be read is skipped until the next minute.
export async function conductorGrantCheck($: any, sid: string) {
  const now = await $.clock.now()
  const last = grantCheckedAt.get(sid)
  if (last !== undefined && now - last < SWEEP_EVERY_MS) return
  grantCheckedAt.set(sid, now)
  const p = await where($)
  if (!p) return
  const rows = await ledgerRowsFor($, p, `"by":"${sid}"`)
  if (rows === 'unreadable') return
  const asked = new Set((condOffers.get(sid) ?? []).map((o) => o.nonce))
  const told = grantTold.get(sid) ?? new Set<string>()
  for (const r of rows) {
    const at = Date.parse(r.t)
    if (r.kind !== 'lead-grant' || r.by !== sid || typeof r.nonce !== 'string' || asked.has(r.nonce) || told.has(r.nonce)) continue
    if (!Number.isNaN(at) && (at > now || now - at > c.COND_OFFERS_KEEP_MS)) continue
    told.add(r.nonce)
    grantTold.set(sid, new Set([...told].slice(-c.COND_OFFERS_MAX)))
    toast($, c.leadUnaskedToast(typeof r.lane === 'string' && c.NAME_RE.test(r.lane) ? r.lane : '?', typeof r.repo === 'string' ? r.repo : '/', sid))
    await logq($, sid, 'lead-grant-unasked', typeof r.lane === 'string' ? r.lane : '?')
  }
}
