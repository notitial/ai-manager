// The usage readings: every session writes its own figures to <root>/usage/<sid>.json, and a lane list reads the files of the live rows it shows.
// Trust rules held here: display only (no check, hold or answer depends on a reading); the writer holds no credential and writes through writeIn (private folder, 0600, one link);
// a reader trusts only a private file of ours within the size bound, and a file that fails a check reads as no reading (core.ts, usage readings).
import * as c from '../core.ts'
import { where, dirOk, run, RM, log, logFail } from './base.ts'
import { mem, usageWrittenAt, usageOwed, usageWriting } from '../mem.ts'
import { registryEntries, registryOf, writeIn, readStoreFile } from './store.ts'

// false: the file could not be written now (no single registry row, or the write failed), so the write stays owed.
async function usageWrite($: any, sid: string): Promise<boolean> {
  // Exactly one registry row of this session: with two, the pid could be a twin's.
  const me = await registryOf($, sid)
  if (!Number.isInteger(me?.pid) || typeof me?.procStart !== 'string') return false
  const text = c.usageFileText(sid, me.pid, me.procStart, await $.clock.now(), await $.session.usage())
  if (text === undefined) return true
  const w = await writeIn($, 'usage', `${sid}.json`, text)
  if ('err' in w) await log($, sid, 'error', 'usage-write')
  return !('err' in w)
}

// Writes when a measure is owed and the last write is 30 s old; one that came sooner waits for the tick (the trailing write).
export async function usageFlush($: any, sid: string) {
  if (!c.SID_RE.test(sid)) return
  const now = await $.clock.now()
  if (!usageOwed.has(sid) || now - (usageWrittenAt.get(sid) ?? -Infinity) < c.USAGE_WRITE_MS) return
  usageOwed.delete(sid)
  usageWrittenAt.set(sid, now)
  const p = usageWrite($, sid)
  usageWriting.set(sid, p)
  try {
    // A write that did not land is owed again, for the tick to try after the gap; not once the session has ended (usageDrop clears the stamp).
    if (!(await p) && usageWrittenAt.has(sid)) usageOwed.add(sid)
  } finally {
    if (usageWriting.get(sid) === p) usageWriting.delete(sid)
  }
}

export async function usageMeasure($: any, e: any, next: any) {
  const sid = await $.session.id()
  if (!c.SID_RE.test(sid)) return next(e)
  usageOwed.add(sid)
  // Not awaited: a registry scan and a write must not hold the measure chain.
  void usageFlush($, sid).catch(logFail($, sid, 'usage-write'))
  return next(e)
}

export async function usageDrop($: any, sid: string) {
  if (!c.SID_RE.test(sid)) return
  usageOwed.delete(sid)
  usageWrittenAt.delete(sid)
  await usageWriting.get(sid)?.catch(() => undefined)
  usageOwed.delete(sid)
  const p = await where($)
  if (p) await run($, [RM, '-f', '--', `${p.root}/usage/${sid}.json`])
}

// Removes a file of a session no live registry row names (once it is a minute old) and any file a day old, at most once a minute. Runs with the presence prune of a lead's tick.
export async function usageSweep($: any) {
  const now = await $.clock.now()
  if (mem.usageSweptAt !== undefined && now >= mem.usageSweptAt && now - mem.usageSweptAt < c.USAGE_SWEEP_MS) return
  mem.usageSweptAt = now
  const p = await where($)
  const dir = p && `${p.root}/usage`
  if (!p || !(await dirOk($, dir!, p.uid))) return
  const live = await registryEntries($)
  if (!live) return
  const sids = new Set(live.map((r) => r.j.sessionId))
  let removed = 0
  for (const f of (await $.fs.list(dir!).catch(() => [])) as { name: string; mtimeMs?: number }[]) {
    if (typeof f.mtimeMs !== 'number' || removed >= c.USAGE_SWEEP_MAX) continue
    const sid = f.name.endsWith('.json') ? f.name.slice(0, -5) : ''
    const dead = c.SID_RE.test(sid) && !sids.has(sid) && now - f.mtimeMs > c.USAGE_SWEEP_MS
    if (!dead && now - f.mtimeMs <= c.USAGE_KEEP_MS) continue
    removed++
    await run($, [RM, '-f', '--', `${dir}/${f.name}`])
  }
}

// The readings of the given live registry entries that pass every check, by session id; at most USAGE_READS_MAX files are read.
export async function usageReadings($: any, rows: c.RegEntry[], now: number): Promise<Map<string, c.UsageReading>> {
  const out = new Map<string, c.UsageReading>()
  const p = await where($)
  if (!p || !(await dirOk($, p.root, p.uid)) || !(await dirOk($, `${p.root}/usage`, p.uid))) return out
  await Promise.all(
    rows.slice(0, c.USAGE_READS_MAX).map(async (e) => {
      if (!c.SID_RE.test(e.sessionId)) return
      const f = await readStoreFile($, `${p.root}/usage/${e.sessionId}.json`, p.uid, c.USAGE_FILE_MAX).catch(() => undefined)
      const r = f?.state === 'ok' ? c.parseUsage(f.text, e.sessionId, e, now) : undefined
      if (r) out.set(e.sessionId, r)
    }),
  )
  return out
}
