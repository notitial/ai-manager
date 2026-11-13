// lead_open: a conductor opens a panel for a new lead in one of its repos (ADR 0006). The panel is not a lead until the person types /callboard lead in it.
// Trust rules held here: the repo is in the conductor's reach at the call; at most one live lead per repo and one open in flight per conductor; at most one successful
// open and three offers per repo per hour, counted from the ledger; every check runs before the first write, and a write that fails takes back what was written.
import * as c from '../core.ts'
import { conductorHome } from '../mem.ts'
import { sha, where, statR, real, log, toast, rmF } from './base.ts'
import { writeBrief, resultDirOk } from './store.ts'
import type { RegRow } from './store.ts'
import { leadsFor, cfgGet, reservedGet } from './grants.ts'
import { leadTool, leadBase, openExchange } from './lanes.ts'
import { ledgerAdd, ledgerRowsFor, promptNewId } from './answer-hook.ts'
import { promptLinkOnce } from './answer-tiers.ts'

// The conductors that have an open running, by session id: held until the offer is gone.
const opening = new Set<string>()

const TIMEOUT_WHY = 'no window answered in time. A VS Code window with the repo as its first workspace folder must run the callboard panels extension (1.2.0 or later). A panel may still appear in that folder: do not open another.'

export async function leadOpenCall($: any, e: any, next: any) {
  return leadTool($, e, 'lead_open', async (sid, no) => {
    await reservedGet($, sid, true)
    const base = await leadBase($, e, sid)
    if ('err' in base) return no(...base.err)
    if (base.g.level !== 'conductor') return no('not-conductor', c.reasonWhy('not-conductor'))
    if (!(await cfgGet($, sid, true)).conductorLeads) return no('conductor-leads-off', c.reasonWhy('conductor-leads-off'))
    if (opening.has(sid)) return no('open-in-flight', c.reasonWhy('open-in-flight'))
    opening.add(sid)
    try {
      return await openLead($, e, sid, base, no)
    } finally {
      opening.delete(sid)
    }
  })
}

async function openLead($: any, e: any, sid: string, base: { live: RegRow[]; lanes: c.Lane[]; g: c.Grant }, no: (reason: string, why: string) => Promise<{ deny: string }>) {
  const a = c.leadOpenArgs({ repo: e.repo, name: e.name, task: e.task, model: e.model })
  if (!a.ok) return no(a.reason, c.reasonWhy(a.reason))
  const p = await where($)
  if (!p) return no('no-paths', 'no-paths')
  // The repo must be its own real path and one of the conductor's pins now (the list file read at this call, intersected with its approved list).
  const repo = await real($, a.repo)
  if (repo !== a.repo || !base.g.pins.includes(repo)) return no('not-in-reach', c.reasonWhy('not-in-reach'))
  const home = conductorHome.get(sid)
  if (home === undefined || repo === home || c.within(home, repo) || c.within(repo, home)) return no('conductor-nested', c.reasonWhy('conductor-nested'))
  // The name, in any letter case: no live session, no lane record (or lead stamp) and no request in the open folder carries it. A result file left over is no request.
  const lower = a.name.toLowerCase()
  if (base.live.some((r) => typeof r.j.name === 'string' && r.j.name.toLowerCase() === lower) || base.lanes.some((l) => l.name.toLowerCase() === lower || l.leadName?.toLowerCase() === lower)) return no('name-in-use', c.reasonWhy('name-in-use'))
  const waiting = ((await $.fs.list(`${p.root}/open`).catch(() => [])) as { name: string }[]).some((f) => f.name.toLowerCase().startsWith(`${lower}.`) && !f.name.toLowerCase().endsWith('.result'))
  if (waiting) return no('name-in-open', c.reasonWhy('name-in-open'))
  // One live lead per repo, whoever made it; an unreadable file counts as a failure.
  const errs = { error: false }
  const leads = await leadsFor($, base.live, undefined, repo, errs)
  if (errs.error) return no('leads-unreadable', c.reasonWhy('leads-unreadable'))
  if (leads.length > 0) return no('lead-exists', c.reasonWhy('lead-exists'))
  // No offer or claim for the repo; an unreadable path counts as taken.
  const key = await sha($, repo)
  if (!(await resultDirOk($, p, 'offers'))) return no('unsafe-offers-dir', c.reasonWhy('unsafe-offers-dir'))
  const offer = `${p.root}/offers/${key}.json`
  for (const f of [offer, `${p.root}/offers/${key}.claim`]) if ((await statR($, f)) !== 'absent') return no('offer-open', c.reasonWhy('offer-open'))
  const rows = await ledgerRowsFor($, p, `"hash":"${key}"`)
  if (rows === 'unreadable') return no('ledger-unreadable', c.reasonWhy('ledger-unreadable'))
  const now = await $.clock.now()
  if (c.leadOpenRate(rows, key, now) !== 'ok') return no('open-rate', c.reasonWhy('open-rate'))
  const me = base.live.find((r) => r.j.sessionId === sid)?.j
  if (!me || !Number.isInteger(me.pid) || typeof me.procStart !== 'string') return no('registry-unreadable', c.reasonWhy('registry-unreadable'))

  // The writes, in order: the ledger row, the offer (created only if absent), the brief, the request the extension reads. A failure takes back what was written.
  const nonce = (await promptNewId($)).replace(/-/g, '')
  const voided = (code: string) => ledgerAdd($, { kind: 'lead-offer-void', hash: key, nonce, code })
  if (!(await ledgerAdd($, { kind: 'lead-offer', hash: key, repo, lane: a.name, nonce, by: sid }))) return no('ledger-write', c.reasonWhy('ledger-write'))
  const fail = async (code: string, why: string) => {
    await rmF($, offer)
    await voided(code)
    return no(code, why)
  }
  const text = c.offerText({ v: 1, name: a.name, repo, model: a.model, conductor: { sid, pid: me.pid, start: me.procStart }, at: now, nonce })
  if (text.length > c.OFFER_MAX) return fail('offer-write', c.reasonWhy('offer-write'))
  const put = await promptLinkOnce($, offer, text)
  // Another offer took the repo between the check and the write: it is not ours to remove.
  if (put === 'exists') {
    await voided('offer-open')
    return no('offer-open', c.reasonWhy('offer-open'))
  }
  if (put !== 'ok') return fail('offer-write', c.reasonWhy('offer-write'))
  const wb = await writeBrief($, p.uid, c.briefPath(repo, a.name), c.leadBriefHead(a.name), c.leadBriefText(a.name, a.task))
  if (wb) return fail(wb, c.reasonWhy(wb))
  const r = await openExchange($, sid, a.name, 'lead', c.leadRequestText(nonce, repo), TIMEOUT_WHY, fail)
  if ('deny' in r) return r
  // The panel is open and nothing here grants it: the offer goes, and the hour is not spent (no lead-grant row).
  await rmF($, offer)
  await voided('c2-only')
  await log($, sid, 'lead-opened', a.name)
  toast($, `Conductor opened a panel for lead ${a.name} in ${c.folderName(repo)}. Type /callboard lead there to make it the lead.`)
  return { result: c.leadOpenedText(a.name, r.sid) }
}
