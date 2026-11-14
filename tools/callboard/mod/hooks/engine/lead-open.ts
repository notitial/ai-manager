// lead_open: a conductor opens a panel for a new lead in one of its repos (ADR 0006). The panel is not a lead until the person types /callboard lead in it.
// Trust rules held here: the repo is in the conductor's reach at the call; at most one live lead per repo and one open in flight per conductor; at most one successful
// open and three offers per repo per hour, counted from the ledger; every check runs before the first write, and a write that fails takes back the offer and voids its row.
import * as c from '../core.ts'
import { conductorHome } from '../mem.ts'
import { sha, where, statR, real, logq, toast, rmF } from './base.ts'
import { writeBrief, resultDirOk } from './store.ts'
import type { RegRow } from './store.ts'
import { leadsFor, cfgReadStrict, reservedGet } from './grants.ts'
import { leadTool, leadBase, openExchange } from './lanes.ts'
import { ledgerAdd, ledgerRowsFor, promptNewId } from './answer-hook.ts'
import { promptLinkOnce } from './answer-tiers.ts'

// The conductors that have an open running, by session id, and the names those opens carry (lower case): held until the offer is gone.
const opening = new Set<string>()
const openingNames = new Set<string>()

const TIMEOUT_WHY = 'no window answered in time. A VS Code window with the repo as its first workspace folder must run the callboard panels extension (1.2.0 or later). A panel may still appear in that folder: do not open another.'

export async function leadOpenCall($: any, e: any, next: any) {
  return leadTool($, e, 'lead_open', async (sid, no) => {
    await reservedGet($, sid, true)
    const base = await leadBase($, e, sid)
    if ('err' in base) return no(...base.err)
    if (base.g.level !== 'conductor') return no('not-conductor', c.reasonWhy('not-conductor'))
    const cfg = await cfgReadStrict($, sid)
    if (!cfg) return no('config-unreadable', c.reasonWhy('config-unreadable'))
    if (!cfg.conductorLeads) return no('conductor-leads-off', c.reasonWhy('conductor-leads-off'))
    if (opening.has(sid)) return no('open-in-flight', c.reasonWhy('open-in-flight'))
    // Another conductor's open of the same name is running: its request file would be replaced by this one's.
    const nm = typeof e.name === 'string' ? e.name.toLowerCase() : ''
    if (nm !== '' && openingNames.has(nm)) return no('name-in-open', c.reasonWhy('name-in-open'))
    opening.add(sid)
    if (nm !== '') openingNames.add(nm)
    try {
      return await openLead($, e, sid, base, no)
    } finally {
      opening.delete(sid)
      if (nm !== '') openingNames.delete(nm)
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
  const now = await $.clock.now()
  // An offer left behind (a crash, a reload) is taken away once it is older than OFFER_STALE_MS; a claim is never ours to remove.
  const left = await statR($, offer)
  if (left !== 'absent' && !(left !== 'error' && left.kind === 'file' && now - left.mtimeMs > c.OFFER_STALE_MS && (await rmF($, offer))?.exitCode === 0)) return no('offer-open', c.reasonWhy('offer-open'))
  if ((await statR($, `${p.root}/offers/${key}.claim`)) !== 'absent') return no('offer-open', c.reasonWhy('offer-open'))
  const rows = await ledgerRowsFor($, p, `"hash":"${key}"`)
  if (rows === 'unreadable') return no('ledger-unreadable', c.reasonWhy('ledger-unreadable'))
  if (c.leadOpenRate(rows, key, now) !== 'ok') return no('open-rate', c.reasonWhy('open-rate'))
  const me = base.live.find((r) => r.j.sessionId === sid)?.j
  if (!me || !Number.isInteger(me.pid) || typeof me.procStart !== 'string') return no('registry-unreadable', c.reasonWhy('registry-unreadable'))

  // The writes, in order: the ledger row, the offer (created only if absent), the request the extension reads, and once the panel is open the brief. A failure takes back the offer and voids the row.
  const nonce = (await promptNewId($)).replace(/-/g, '')
  const voided = (code: string) => ledgerAdd($, { kind: 'lead-offer-void', hash: key, nonce, code })
  if (!(await ledgerAdd($, { kind: 'lead-offer', hash: key, repo, lane: a.name, nonce, by: sid }))) return no('ledger-write', c.reasonWhy('ledger-write'))
  const fail = async (code: string, why: string) => {
    await rmF($, offer)
    await voided(code)
    return no(code, why)
  }
  const text = c.offerText({ v: 1, name: a.name, repo, model: a.model, conductor: { sid, pid: me.pid, start: me.procStart }, at: now, nonce })
  if (text.length > c.OFFER_MAX) {
    await voided('offer-write')
    return no('offer-write', c.reasonWhy('offer-write'))
  }
  const put = await promptLinkOnce($, offer, text)
  // Another offer took the repo between the check and the write: it is not ours to remove.
  if (put === 'exists') {
    await voided('offer-open')
    return no('offer-open', c.reasonWhy('offer-open'))
  }
  if (put !== 'ok') return fail('offer-write', c.reasonWhy('offer-write'))
  // From here the offer is ours: a throw while the request is out (a host call that times out) takes back the request and the offer like any other failure.
  let r: Awaited<ReturnType<typeof openExchange>>
  try {
    r = await openExchange($, sid, a.name, 'lead', c.leadRequestText(nonce, repo), TIMEOUT_WHY, fail, nonce)
  } catch {
    await rmF($, `${p.root}/open/${a.name}.lead`)
    return fail('offer-write', c.reasonWhy('offer-write'))
  }
  if ('deny' in r) return r
  // The panel is open and nothing here grants it: the offer goes, and the hour is not spent (no lead-grant row). What follows cannot undo the open, so none of it throws out.
  await rmF($, offer)
  await voided('panel-only')
  // The brief comes last, so a failed open leaves none behind; a panel that opened without one is reported as such.
  const wb = await writeBrief($, p.uid, c.briefPath(repo, a.name), c.leadBriefHead(a.name), c.leadBriefText(a.name, a.task)).catch(() => 'brief-write')
  await logq($, sid, 'lead-opened', a.name)
  toast($, `Conductor opened a panel for lead ${a.name} in ${c.folderName(repo)}. Type /callboard lead there to make it the lead.`)
  return { result: c.leadOpenedText(a.name, r.sid, wb || undefined) }
}
