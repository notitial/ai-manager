// The lane store (read, edit, record writers), the registry rows and the store's lock folders, and the cue, result and brief files.
// Trust rules held here: a store write is a locked read-modify-write; a lock is released only by its owner and a stale one is broken by one breaker at a time; spool files are written private and moved into place.
import * as c from '../core.ts'
import { storeLocks, unlockOwed, goneSeen, grants, cueInFlight, orders, lastAnswer, mem } from '../mem.ts'
import {
  realR,
  logq,
  where,
  dirOk,
  sha,
  real,
  gitRoot,
  run,
  STAT,
  STAT_FMT,
  HEAD,
  MKDIR,
  INSTALL,
  TEE,
  RM,
  RMDIR,
  pause,
  PS,
  facts,
  readSmall,
  MV,
  log,
  readSmallR,
  psStarts,
  psConfirm,
  statR,
  toast,
  countDown,
} from './base.ts'

// The records of a store that a rewrite keeps: a record goes only when its folder is gone or is not its own real path; one whose check failed is kept (every
// reader skips an unresolvable record anyway), and that is logged once per write.
export async function keptLanes($: any, lanes: c.Store['lanes']): Promise<c.Store['lanes']> {
  const kept: c.Store['lanes'] = []
  let failed = false
  for (const l of lanes) {
    const r = await realR($, l.folder)
    if (r === 'error') failed = true
    if (r === 'error' || (r !== 'absent' && r.path === l.folder)) kept.push(l)
  }
  if (failed) await logq($, await $.session.id().catch(() => ''), 'error', 'store-check')
  return kept
}

// The lanes a lead made: one file per repo in the user's own callboard folder, named by the hash of the repo's real path, never found by walking up
// from a folder. Anything that fails a check is skipped whole; a lane whose folder is not its own real path is skipped.
export async function loadStores($: any): Promise<{ key: string; store: c.Store }[]> {
  const p = await where($)
  if (!p) return []
  const dir = `${p.root}/lanes`
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return []
  const home = p.root.slice(0, -'/.claude/callboard'.length)
  const files = ((await $.fs.list(dir).catch(() => [])) as { name: string }[]).map((f) => f.name).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).sort().slice(0, c.STORE_MAX_FILES)
  const out: { key: string; store: c.Store }[] = []
  for (const n of files) {
    const cur = await readStoreFile($, `${dir}/${n}`, p.uid)
    if (cur.state !== 'ok') continue
    const parsed = c.parseStore(cur.text)
    const key = n.slice(0, -5)
    if (!parsed.ok || c.pinRefusal(parsed.store.repo, home) !== undefined) continue
    if ((await sha($, parsed.store.repo)) !== key || (await real($, parsed.store.repo)) !== parsed.store.repo) continue
    if ((await gitRoot($, parsed.store.repo)) !== 'yes') continue
    const lanes: c.Store['lanes'] = []
    for (const l of parsed.store.lanes) if ((await real($, l.folder)) === l.folder) lanes.push(l)
    out.push({ key, store: { ...parsed.store, lanes } })
  }
  return out
}

// The lanes the leads made, from the per-user stores. A store lane whose name is taken in another store is dropped.
export async function loadLanes($: any): Promise<c.Lane[] | string> {
  const stores = await loadStores($)
  const count = new Map<string, number>()
  for (const s of stores) for (const l of s.store.lanes) count.set(l.name, (count.get(l.name) ?? 0) + 1)
  const out: c.Lane[] = []
  for (const s of stores) for (const l of s.store.lanes) if (count.get(l.name) === 1) out.push({ name: l.name, folder: l.folder, brief: l.brief, repo: l.repo, src: s.key, ...(l.adopted ? { adopted: true as const, lead: l.lead } : {}), ...(l.model ? { model: l.model } : {}), ...(l.sid !== undefined ? { sid: l.sid } : {}), ...(l.parked !== undefined ? { parked: l.parked } : {}), ...(l.leadName ? { leadName: l.leadName } : {}), ...(l.leadSid ? { leadSid: l.leadSid } : {}) })
  return out
}

// Lanes a lead makes live in ~/.claude/callboard/lanes/<sha256 of the repo's real path>.json; the grant's folder is the repo.
export async function storePath($: any, key: string): Promise<string> {
  return `${(await where($))!.root}/lanes/${key}.json`
}
// absent: no file. bad: something is there that the loader would not trust or could not read. ok: a plain private file of ours, read with a bound.
export async function readStoreFile($: any, path: string, uid: number, max = c.STORE_MAX_BYTES): Promise<{ state: 'absent' | 'bad' | 'ok'; text: string }> {
  const r0 = await run($, [STAT, '-f', STAT_FMT, '--', path], undefined, { LC_ALL: 'C' })
  if (r0.exitCode !== 0) return { state: /No such file or directory/.test(r0.stderr) ? 'absent' : 'bad', text: '' }
  const f = c.parseStat(r0.stdout)
  if (!f || c.cueFileOk(f, uid) || f.size > max) return { state: 'bad', text: '' }
  const r = await run($, [HEAD, '-c', String(max + 1), '--', path])
  return r.exitCode === 0 ? { state: 'ok', text: r.stdout } : { state: 'bad', text: '' }
}

export async function lockStore(key: string): Promise<() => void> {
  const prev = storeLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => (release = r))
  storeLocks.set(key, prev.then(() => mine))
  await prev
  return release
}

// One store write, from any of the four writers: the in-process queue, then the mkdir lock between processes, then read, compute and write only,
// then a re-read: a writer whose change is not in the file after its own write says so (wrote: the file was replaced, so that writer may have to undo it). `pre` runs after the queue and before the lock (it may be slow).
export type Edit = { no: string; why?: string } | { skip: true } | { text: string; landed: (s: c.Store | undefined) => boolean }
export async function editStore($: any, key: string, fn: (cur: { state: 'absent' | 'bad' | 'ok'; text: string }, ctx: any) => Promise<Edit>, pre?: () => Promise<any>): Promise<{ no: string; why?: string; wrote?: true } | { text: string }> {
  const p = await where($)
  if (!p) return { no: 'no-paths' }
  const release = await lockStore(key)
  try {
    const ctx = pre ? await pre() : undefined
    if (ctx && typeof ctx === 'object' && 'no' in ctx) return ctx
    const held = await lockDir($, p, key)
    if ('no' in held) return held
    try {
      const path = await storePath($, key)
      const cur = await readStoreFile($, path, p.uid)
      const e = await fn(cur, ctx)
      if ('no' in e) return e
      if ('skip' in e) return { text: '' }
      const again = await readStoreFile($, path, p.uid)
      if (again.state !== cur.state || again.text !== cur.text) return { no: 'store-changed' }
      const w = await writeIn($, 'lanes', `${key}.json`, e.text)
      if ('err' in w) return { no: w.err }
      const after = await readStoreFile($, path, p.uid)
      const parsed = after.state === 'ok' ? c.parseStore(after.text) : undefined
      return e.landed(parsed?.ok ? parsed.store : undefined) ? { text: e.text } : { no: 'store-changed', wrote: true }
    } finally {
      await unlockDir($, p, key, held.owner)
    }
  } finally {
    release()
  }
}

// editStore for a writer that needs the store as it is: a file that is absent, untrusted or unparsable is refused (store-unreadable, or the parser's reason), and fn gets the parsed store.
export function editLanes($: any, key: string, fn: (store: c.Store) => Promise<Edit>, pre?: () => Promise<any>) {
  return editStore($, key, async (cur) => {
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    return fn(parsed.store)
  }, pre)
}

// The lock is a folder made with mkdir (atomic) holding an owner file {pid, procStart, nonce} of the process that made it; the nonce tells one holding from
// the next one of the same process. It is advisory: it keeps honest callboard processes from losing each other's updates. Only a lock whose owner is gone
// (or, with no owner file at all, older than 10 s) is broken, and only by one breaker at a time (a second mkdir lock, itself broken by age alone).
const lockPath = (p: { root: string }, key: string) => `${p.root}/lanes/.${key}.lock`
async function lockDir($: any, p: { uid: number; root: string }, key: string): Promise<{ owner: string } | { no: string }> {
  const lock = lockPath(p, key)
  await run($, [MKDIR, '-p', '-m', '700', p.root, `${p.root}/lanes`])
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, `${p.root}/lanes`, p.uid))) return { no: 'unsafe-dir' }
  const sid = await $.session.id()
  const rows = await registryEntries($)
  if (!rows) return { no: 'registry-unreadable' }
  // Exactly one entry of this session: with two, the owner pid could be a twin's, and the lock could then be broken while held.
  const mine = rows.filter((e) => e.j.sessionId === sid)
  if (mine.length > 1) return { no: 'self-duplicate' }
  const me = mine.find((e) => String(e.j.pid) === e.pid)
  // A process that cannot name itself in the registry does not take the lock: no lock is ever left that only its age could free.
  if (!me || typeof me.j.procStart !== 'string' || !Number.isInteger(Number(me.pid)) || Number(me.pid) < 2) return { no: 'store-busy' }
  const owner = JSON.stringify({ pid: Number(me.pid), procStart: me.j.procStart, nonce: `${await $.clock.now()}-${++mem.seq}-${Math.random().toString(36).slice(2, 12)}` })
  const deadline = (await $.clock.now()) + c.LOCK_WAIT_MS
  for (;;) {
    // The 'File exists' test below reads the message: it must not be translated.
    const m = await run($, [MKDIR, '-m', '700', '--', lock], undefined, { LC_ALL: 'C' })
    if (m.exitCode === 0) {
      const file = `${lock}/owner`
      const made = await run($, [INSTALL, '-m', '600', '/dev/null', file])
      const wrote = made.exitCode === 0 ? await run($, [TEE, '--', file], owner) : made
      if (wrote.exitCode !== 0) {
        await run($, [RM, '-f', '--', file])
        await run($, [RMDIR, '--', lock])
        return { no: 'store-busy' }
      }
      return { owner }
    }
    if (!/File exists/.test(m.stderr)) return { no: 'store-busy' }
    const broke = await breakStale($, p, lock)
    const left = deadline - (await $.clock.now())
    if (left <= 0) return { no: 'store-busy' }
    if (!broke && !(await pause($, Math.min(c.LOCK_POLL_MS, left)))) return { no: 'store-busy' }
  }
}

// 'dead' only when ps says so (no such process, or another start time); a ps that failed any other way leaves the lock alone.
async function ownerGone($: any, o: { pid: number; procStart: string }): Promise<boolean> {
  const r = await run($, [PS, '-o', 'lstart=', '-p', String(o.pid)], undefined, { TZ: 'UTC', LC_ALL: 'C' })
  return r.exitCode === 0 ? !c.sameStart(r.stdout, o.procStart) : r.exitCode === 1 && r.stdout.trim() === ''
}

// True only when this call removed a stale lock. One breaker at a time: the gate is a second mkdir lock, broken by age alone; it is removed at the end only
// while it is still the folder this call made (same inode). The lock folder is judged twice (before and after its owner file is read: the same folder, and
// the later mtime counts for its age), then moved to a name of its own, and what was moved must be the very folder judged stale (same owner text with its nonce,
// same inode) before anything in it is removed. A folder that turns out to be someone else's is put back with mv -n, unless a lock has been made again
// meanwhile: then it stays aside (never moved into the new lock) and is logged.
async function breakStale($: any, p: { uid: number; root: string }, lock: string): Promise<boolean> {
  const gate = `${lock}.break`
  if ((await run($, [MKDIR, '-m', '700', '--', gate])).exitCode !== 0) {
    const g = await facts($, gate)
    if (g && (await $.clock.now()) - g.mtimeMs > c.LOCK_BREAKER_MS) await run($, [RMDIR, '--', gate])
    return false
  }
  const mine = await facts($, gate)
  try {
    const f = await facts($, lock)
    if (!f) return false
    const o = await readSmall($, `${lock}/owner`, p.uid, 256)
    const f2 = await facts($, lock)
    if (!f2 || f2.ino !== f.ino) return false
    const owner = o ? c.parseOwner(o.text) : undefined
    const stale = owner ? await ownerGone($, owner) : (await $.clock.now()) - Math.max(f.mtimeMs, f2.mtimeMs) > c.LOCK_ORPHAN_MS
    if (!stale) return false
    const moved = `${lock}.stale.${await $.clock.now()}.${++mem.seq}`
    if ((await run($, [MV, '-n', '--', lock, moved])).exitCode !== 0) return false
    const again = await readSmall($, `${moved}/owner`, p.uid, 256)
    const there = await facts($, moved)
    if ((again?.text ?? '') === (o?.text ?? '') && there?.ino === f.ino) {
      await run($, [RM, '-f', '--', `${moved}/owner`])
      await run($, [RMDIR, '--', moved])
      return true
    }
    const sid = await $.session.id()
    if (await facts($, lock)) await log($, sid, 'error', 'lock-aside')
    else if ((await run($, [MV, '-n', '--', moved, lock])).exitCode !== 0) await log($, sid, 'error', 'lock-moved')
    return false
  } finally {
    // A gate that could not be looked at after it was made is left to its 30 s age: nothing here can remove a gate that is not ours.
    if (!mine) await logq($, await $.session.id().catch(() => ''), 'error', 'lock-gate')
    else if ((await facts($, gate))?.ino === mine.ino) await run($, [RMDIR, '--', gate])
  }
}

// Released only while the owner file still carries our nonce. Our own folder is emptied and removed; never rm -rf. 'lost': the folder is gone or names another
// holder; 'unknown': the owner file could not be read to a verdict.
async function releaseIfOurs($: any, p: { uid: number; root: string }, key: string, nonce: string | undefined): Promise<'done' | 'lost' | 'unknown'> {
  const lock = lockPath(p, key)
  const o = await readSmall($, `${lock}/owner`, p.uid, 256)
  const seenOwner = o ? c.parseOwner(o.text) : undefined
  if (nonce !== undefined && seenOwner?.nonce === nonce) {
    await run($, [RM, '-f', '--', `${lock}/owner`])
    await run($, [RMDIR, '--', lock])
    return 'done'
  }
  if (seenOwner || !(await facts($, lock))) return 'lost'
  return 'unknown'
}

async function unlockDir($: any, p: { uid: number; root: string }, key: string, owner: string) {
  const sid = await $.session.id().catch(() => '')
  try {
    const nonce = c.parseOwner(owner)?.nonce
    let st: 'done' | 'lost' | 'unknown' = 'unknown'
    for (let i = 0; i < 2 && st !== 'done'; i++) st = await releaseIfOurs($, p, key, nonce)
    if (st === 'done') return
    await log($, sid, 'error', st === 'lost' ? 'lock-lost' : 'lock-unconfirmed')
    if (st === 'unknown' && nonce) unlockOwed.set(`${key}:${nonce}`, { key, nonce, tries: 0 })
  } catch {
    await logq($, sid, 'error', 'unlock')
  }
}
export async function unlockRetry($: any, sid: string) {
  if (unlockOwed.size === 0) return
  const p = await where($)
  if (!p) return
  for (const [k, o] of [...unlockOwed]) {
    const st = await releaseIfOurs($, p, o.key, o.nonce).catch(() => 'unknown' as const)
    if (st === 'unknown' && ++o.tries < 30) continue
    unlockOwed.delete(k)
    if (st === 'unknown') await log($, sid, 'error', 'unlock-gave-up')
  }
}

// undefined means the registry could not be trusted or found, which is not the same as "no live sessions": callers that
// treat an empty list as permission (name-in-use, duplicate-open guards) must refuse on it.
export type RegRow = { pid: string; j: any }
export async function registryEntries($: any): Promise<RegRow[] | undefined> {
  return (await registryEntriesWhy($)).rows
}

// The same read, with the reason the dead-row filter was off for it (the rebind): undefined only when this session's own row is live and every row the
// table lacks was confirmed gone or absent; 'ps-confirm' when that confirmation failed or was cut (every row kept).
export async function registryEntriesWhy($: any): Promise<{ rows: RegRow[] | undefined; why?: string }> {
  const p = await where($)
  if (!p) return { rows: undefined }
  const dir = p.sessions
  if (!(await dirOk($, dir, p.uid))) return { rows: undefined }
  const out: RegRow[] = []
  const names = ((await $.fs.list(dir).catch(() => [])) as { name: string }[]).map((f) => f.name).filter((n) => /^[A-Za-z0-9-]{1,64}\.json$/.test(n))
  // A registry longer than the cap cannot be looked at whole, and a name could hide past the cap: no answer, not a cut one.
  if (names.length > c.REGISTRY_FILES_MAX) {
    await logq($, await $.session.id().catch(() => ''), 'error', 'registry-too-many')
    return { rows: undefined }
  }
  for (const n of names) {
    // The engine's own files are 0644: a plain file of ours that nobody else can write. The engine rewrites them while it runs: a file that changed under
    // the read is read once more; one that is still changing makes the whole scan untrustworthy (a name could hide in it), which callers refuse on.
    let r = await readSmallR($, `${dir}/${n}`, p.uid, c.REGISTRY_FILE_MAX, true)
    if (r.state === 'changed' || r.state === 'failed') r = await readSmallR($, `${dir}/${n}`, p.uid, c.REGISTRY_FILE_MAX, true)
    if (r.state === 'changed' || r.state === 'failed') return { rows: undefined }
    if (r.state !== 'ok') continue
    try {
      const j = JSON.parse(r.text)
      // Only an object that names its own file's pid: anything else is not a session's own entry (a copy, a forged file, or not an entry at all).
      if (j !== null && typeof j === 'object' && !Array.isArray(j) && String(j.pid) === n.slice(0, -5)) out.push({ pid: n.slice(0, -5), j })
    } catch {}
  }
  // ps runs after the listing, so every listed file's process had started by then. A file left by a process that has died is dropped here, for every caller.
  const self = await $.session.id().catch(() => '')
  const fresh = c.freshRowsWhy(out, await psStarts($), self)
  // Every row kept: the filter is off for this read, which is the behaviour before it. Logged (once in a row) so it is seen.
  if (fresh.why) await logq($, self, 'error', `registry-${fresh.why}`)
  // A row whose pid the table lacks is dropped only once ps -p agrees it is gone: a table cut at a line boundary passes every table check. Any doubt keeps every
  // row (the behaviour before the filter): keeping a dead row makes readers refuse; dropping a live one would free its name.
  const ask = fresh.absent.filter((r) => {
    const k = c.goneKey(r)
    return k === undefined || !goneSeen.has(k)
  })
  const pids = c.confirmPids(ask)
  if (pids.length > 0) {
    const listed = await psConfirm($, pids)
    const v = listed && c.confirmGone(ask, listed)
    if (!v || v.cut) {
      await logq($, self, 'error', v ? 'registry-ps-cut' : 'registry-ps-confirm')
      return { rows: out, why: 'ps-confirm' }
    }
    for (const r of v.gone) {
      const k = c.goneKey(r)
      if (k === undefined) continue
      if (goneSeen.size >= c.GONE_CACHE_MAX) goneSeen.clear()
      goneSeen.add(k)
    }
  }
  return { rows: fresh.rows, why: fresh.why }
}

// One cue or one tool call reads the registry once: a memo that its steps share.
export type Reg = () => Promise<RegRow[] | undefined>
export function regOnce($: any): Reg {
  let p: ReturnType<Reg> | undefined
  return () => (p ??= registryEntries($))
}

export async function liveNames($: any, reg: Reg = () => registryEntries($)): Promise<string[]> {
  return ((await reg()) ?? []).flatMap((e) => (typeof e.j.name === 'string' ? [e.j.name] : []))
}

export async function registryOf($: any, sid: string, reg: Reg = () => registryEntries($)): Promise<any | undefined> {
  // Exactly one entry of this session, as attach: with two, it is unclear which status and name are its own.
  const mine = (await reg())?.filter((e) => e.j.sessionId === sid) ?? []
  return mine.length === 1 ? mine[0].j : undefined
}

export async function idleCheck($: any, sid: string, reg: Reg = () => registryEntries($)): Promise<string | undefined> {
  const draft = await $.prompt.read()
  if (draft.text !== '') return 'draft-in-box'
  const j = await registryOf($, sid, reg)
  if (!j) return 'registry-unreadable'
  if (j.status !== 'idle' || (j.waitingFor ?? null) !== null) return 'not-idle'
  return undefined
}

// A new 0600 temp file, which must be a private file of ours (cueFileOk): its facts, or undefined when it is not (it is removed then).
async function privateTmp($: any, tmp: string, uid: number) {
  await run($, [INSTALL, '-m', '600', '/dev/null', tmp])
  const f = await facts($, tmp)
  if (f && !c.cueFileOk(f, uid)) return f
  await run($, [RM, '-f', '--', tmp])
}

// A 0600 temp file in a 0700 folder under the callboard root, then one rename into place.
// It returns the temp file's inode, which the rename keeps: the target can claim a cue within the same tick, so a stat after the write may find nothing.
export async function writeIn($: any, folder: string, file: string, text: string): Promise<{ err: string } | { ino: number }> {
  const p = await where($)
  if (!p) return { err: 'no-paths' }
  const dir = `${p.root}/${folder}`
  await run($, [MKDIR, '-p', '-m', '700', p.root, dir])
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return { err: 'unsafe-dir' }
  const tmp = `${dir}/.${file}.${await $.clock.now()}.${++mem.seq}.tmp`
  const f = await privateTmp($, tmp, p.uid)
  if (!f) return { err: 'tmp-unsafe' }
  const w = await run($, [TEE, '--', tmp], text)
  const m = w.exitCode === 0 ? await run($, [MV, '-f', '--', tmp, `${dir}/${file}`]) : w
  if (m.exitCode !== 0) {
    await run($, [RM, '-f', '--', tmp])
    return { err: 'write-failed' }
  }
  return { ino: f.ino }
}

function writeCue($: any, sid: string, text: string) {
  return writeIn($, 'cue', `${sid}.cue`, text)
}

// The lane brief lane_create writes: <folder>/.archive/<NAME>/BRIEF.md, in the repo, so writeIn's private 0700 folder does not fit. .archive and
// .archive/<NAME> must each be a real folder of the user's (not a link) that is its own real path, before and after mkdir -p. The text goes to a 0600
// temp file in .archive/<NAME>, then one rename into place. A BRIEF.md already there (a removed lane of the same name left it) is replaced only when it
// is a plain file of the user's with one link whose first line is the mod's own header (`head`; only that many bytes are read). undefined: written;
// otherwise the refusal code.
export async function writeBrief($: any, uid: number, brief: string, head: string, text: string): Promise<string | undefined> {
  const dir = brief.slice(0, brief.lastIndexOf('/'))
  const archive = dir.slice(0, dir.lastIndexOf('/'))
  const dirs = async (): Promise<'ok' | 'absent' | 'bad'> => {
    for (const d of [archive, dir]) {
      const f = await statR($, d)
      if (f === 'absent') return 'absent'
      if (f === 'error') return 'bad'
      if (f.kind !== 'dir' || f.uid !== uid || (await real($, d)) !== d) return 'bad'
    }
    return 'ok'
  }
  if ((await dirs()) === 'bad') return 'archive-unsafe'
  await run($, [MKDIR, '-p', '--', dir])
  const after = await dirs()
  if (after !== 'ok') return after === 'bad' ? 'archive-unsafe' : 'brief-write'
  const tmp = `${dir}/.BRIEF.md.${await $.clock.now()}.${++mem.seq}.tmp`
  if (!(await privateTmp($, tmp, uid))) return 'brief-write'
  const w = await run($, [TEE, '--', tmp], text)
  const old = w.exitCode === 0 ? await statR($, brief) : 'error'
  let keep = old === 'error' ? 'brief-write' : old !== 'absent' && (old.kind !== 'file' || old.uid !== uid || old.nlink !== 1) ? 'brief-exists' : undefined
  if (!keep && old !== 'absent') {
    const h = await run($, [HEAD, '-c', String(head.length), '--', brief])
    if (h.exitCode !== 0 || h.stdout !== head) keep = 'brief-exists'
  }
  const m = keep ? undefined : await run($, [MV, '-f', '--', tmp, brief])
  if (keep || m?.exitCode !== 0) {
    await run($, [RM, '-f', '--', tmp])
    return keep ?? 'brief-write'
  }
  return undefined
}

// An answer file (an open result or a cue result): a plain 0600 file of ours with one link, read with a bound and checked
// again after the read; never with $.fs.read, which a FIFO put in its place would hang. An unsafe file is removed; a file that
// changed during the read is left for the next poll; the caller removes an answer it takes.
export async function readAnswer($: any, path: string, uid: number, timeoutMs = 5000, max = c.RESULT_MAX): Promise<{ state: 'absent' | 'bad' } | { state: 'ok'; text: string }> {
  const f = await facts($, path)
  if (!f) return { state: 'absent' }
  if (c.cueFileOk(f, uid) || f.size > max) {
    await run($, [RM, '-f', '--', path])
    return { state: 'bad' }
  }
  const r = await $.process.run([HEAD, '-c', String(max + 1), '--', path], { timeoutMs })
  const after = await facts($, path)
  // Changed during the read, or a read that failed or ran out of time: left for the next poll.
  if (!after || !c.sameFile(f, after) || r.exitCode !== 0) return { state: 'absent' }
  if (r.stdout.length > max) {
    await run($, [RM, '-f', '--', path])
    return { state: 'bad' }
  }
  return { state: 'ok', text: r.stdout }
}

// The lead waits for the target's answer to its cue until one deadline counted from the tool call (the start wait counts against it).
// Only its own answer is removed; one for another cue (other inode) is left for the call that sent it, and the poll goes on.
// The read is bounded by the time left, so a FIFO swapped in cannot hold the call past the deadline.
async function awaitResult($: any, path: string, uid: number, verb: c.Verb, ino: number, deadline: number, pollMs = c.RESULT_POLL_MS) {
  for (;;) {
    const left = deadline - (await $.clock.now())
    const a = await readAnswer($, path, uid, Math.max(pollMs, Math.min(5000, left)))
    if (a.state === 'ok') {
      const r = c.parseResult(a.text, verb, ino)
      if (r) {
        await run($, [RM, '-f', '--', path])
        return r
      }
    }
    if ((await $.clock.now()) + pollMs > deadline) return undefined
    if (!(await pause($, pollMs))) return undefined
  }
}

// The lead's result folder must be a private folder of the user before it removes or reads anything in it.
export async function resultDirOk($: any, p: { uid: number; root: string }, folder: string): Promise<boolean> {
  await run($, [MKDIR, '-p', '-m', '700', p.root, `${p.root}/${folder}`])
  return (await dirOk($, p.root, p.uid)) && (await dirOk($, `${p.root}/${folder}`, p.uid))
}

// One cue to one target and the wait for its answer (lane_start, lane_retire and the other cue tools): the per-target lock, the answer file and
// the one deadline counted from the tool call. undefined: the target answered ok; otherwise the deny to return.
export async function cueExchange($: any, sid: string, laneName: string, toSid: string, verb: c.Verb, deadline: number, no: (reason: string, why: string) => Promise<{ deny: string }>, retire = false): Promise<{ deny: string } | undefined> {
  const text = c.cueLine(verb, laneName, verb === 'rename' ? sid : undefined)
  if (!text) return no('grammar', 'bad cue.')
  // Any grant (a lead's or the manager's); each tool has checked its own reach.
  if (!grants.has(sid)) return no('off', 'the lead tools are off. Ask the person to turn them on.')
  const p = await where($)
  if (!p) return no('no-paths', 'no-paths')
  if (!(await resultDirOk($, p, 'result'))) return no('unsafe-result-dir', 'unsafe-result-dir: ~/.claude/callboard/result is not a private folder of yours. Ask the person to check it.')
  const key = `cue:${toSid}`
  const waitMs = Math.max(0, deadline - (await $.clock.now()) - 3000)
  // Read and counted with no await between, so two parallel calls cannot both see the target free.
  const contended = (cueInFlight.get(key) ?? 0) > 0
  cueInFlight.set(key, (cueInFlight.get(key) ?? 0) + 1)
  // The wait for an earlier call is bounded too: a call that gives up (or whose wait fails) frees its place as soon as it gets it.
  const locked = lockStore(key)
  let got: (() => void) | undefined
  try {
    got = contended ? await Promise.race([locked, $.clock.sleep(waitMs).then(() => undefined)]) : await locked
    if (!got) return no('cue-busy', c.reasonWhy('cue-busy'))
    // A call that waited behind another to the same session and has too little time left does not send its cue.
    if (contended && (await $.clock.now()) + 2 * c.RESULT_POLL_MS + 2000 > deadline) return no('cue-busy', c.reasonWhy('cue-busy'))
    // An answer left from an earlier cue goes first; one that still lands later carries another inode and is skipped.
    const resultPath = `${p.root}/result/${toSid}.result`
    await run($, [RM, '-f', '--', resultPath])
    const w = await writeCue($, toSid, text)
    if ('err' in w) return no(w.err, w.err)
    await log($, sid, 'cued', `${verb} ${laneName}`)
    toast($, `${verb[0].toUpperCase()}${verb.slice(1)} sent to lane ${laneName}`)
    // A retire waits from the cue write (its target answers on its next tick, and the checks before the cue take time), and polls faster to shorten the window before the signal.
    const r = await awaitResult($, resultPath, p.uid, verb, w.ino, retire ? (await $.clock.now()) + c.RETIRE_WAIT_MS : deadline, retire ? c.RETIRE_POLL_MS : c.RESULT_POLL_MS)
    if (!r) return no('no-answer', c.NO_ANSWER)
    // An order the lane took (held nudged): kept in memory, from its first cue, for the deadline notice (orderTick).
    if (verb === 'compact' && r.outcome === 'held' && r.reason === 'nudged') {
      const mine = orders.get(sid) ?? new Map<string, { lane: string; at: number }>()
      orders.set(sid, mine)
      if (!mine.has(toSid)) mine.set(toSid, { lane: laneName, at: await $.clock.now() })
    }
    if (r.outcome !== 'ok') return no(`${r.outcome}-${r.reason}`, c.cueRefusalText(verb, r.outcome, r.reason))
    await log($, sid, 'acted', `${verb} ${laneName}`)
    return undefined
  } finally {
    if (got) got()
    else void locked.then((r) => r())
    countDown(cueInFlight, key)
  }
}

export type Answer = (outcome: c.Outcome, reason?: string) => Promise<void>
export const noAnswer: Answer = async () => undefined

// The target's answer to one claimed cue, written at most once, into <root>/result/<own sid>.result.
export function answerer($: any, sid: string, verb: c.Verb | '-', ino: number): Answer {
  let sent = false
  return async (outcome, reason = '-') => {
    if (sent) return
    sent = true
    const line = c.resultLine(verb, outcome, reason, ino)
    if (lastAnswer.get(sid) === line) return
    // Recorded before the write: a failed write is not retried every tick for a cue left in place (the log would grow without bound).
    lastAnswer.set(sid, line)
    const w = await writeIn($, 'result', `${sid}.result`, line).catch(() => ({ err: 'throw' }))
    if ('err' in w) await log($, sid, 'error', 'result-write')
  }
}

// Answers no lead read in time stay behind: drop those older than 10 minutes, as the extension does for open results.
export async function pruneResults($: any) {
  const p = await where($)
  if (!p) return
  const dir = `${p.root}/result`
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return
  const now = await $.clock.now()
  const files = ((await $.fs.list(dir).catch(() => [])) as { name: string; mtimeMs: number }[]).slice(0, 200)
  for (const f of files) {
    if (/^[0-9a-f-]{36}\.result$/.test(f.name) && c.SID_RE.test(f.name.slice(0, 36)) && now - f.mtimeMs > c.RESULT_KEEP_MS) await run($, [RM, '-f', '--', `${dir}/${f.name}`])
  }
}

// A session log nobody wrote to in LOG_KEEP_MS goes: never this session's own, never a link or a folder, at most LOG_PRUNE_MAX a start.
export async function pruneLogs($: any, me: string) {
  const p = await where($)
  if (!p) return
  const dir = `${p.root}/log`
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return
  const now = await $.clock.now()
  const all = (await $.fs.list(dir).catch(() => [])) as { name: string; kind: string; isLink: boolean; mtimeMs: number }[]
  const files = [...all].sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, 500)
  let gone = 0
  for (const f of files) {
    if (gone >= c.LOG_PRUNE_MAX) return
    const sid = f.name.slice(0, 36)
    if (f.kind !== 'file' || f.isLink || !/^[0-9a-f-]{36}\.jsonl$/.test(f.name) || !c.SID_RE.test(sid) || sid === me || !(now - f.mtimeMs > c.LOG_KEEP_MS)) continue
    await run($, [RM, '-f', '--', `${dir}/${f.name}`])
    gone++
  }
}
