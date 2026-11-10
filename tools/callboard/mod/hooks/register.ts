import type { Register } from 'claude-code'
import type { Counters, Request } from '../types'
import * as c from './core'
import * as pr from './prompts'

const ID = '/usr/bin/id'
const STAT = '/usr/bin/stat'
const MV = '/bin/mv'
const RM = '/bin/rm'
const RMDIR = '/bin/rmdir'
const MKDIR = '/bin/mkdir'
const TEE = '/usr/bin/tee'
const INSTALL = '/usr/bin/install'
const SHASUM = '/usr/bin/shasum'
const REALPATH = '/bin/realpath'
const HEAD = '/usr/bin/head'
const PS = '/bin/ps'
const KILL = '/bin/kill'
const SLEEP = '/bin/sleep'
const STAT_FMT = '%u %Lp %l %HT %i %z %m'
const TICK_MS = 2000
const ACTION_TIMEOUT_MS = 60_000
const RESUME_TTL_MS = 120_000
const TOOL = 'request_compact'
const BUSY_AGENT = ['pending', 'running', 'waiting']

type R = { exitCode: number; stdout: string; stderr: string }

let isTicking = false
let timerOn = false
// own (v13.3): the registry folder that holds this session's own row, `sessions` unless CLAUDE_CONFIG_DIR names another, undefined when it names a bad one.
let paths: { uid: number; root: string; sessions: string; own: string | undefined } | undefined
let seq = 0
const own = new Map<string, number>()
// v13.2: the own texts that are not real work (the ping, a nudge, a notice, the lanes-changed turn), counted as own is; and every own submit, so the tick can
// tell whether anything went out while it ran.
const unrealOwn = new Map<string, number>()
let submits = 0
const lastLogged = new Map<string, string>()
const lastSaved = new Map<string, { sig: string; at: number }>()

const lane = { plugin: 'callboard', key: 'lane' } as const
const seen = { plugin: 'callboard', key: 'seen' } as const
const counters = { plugin: 'callboard', key: 'counters' } as const
const request = { plugin: 'callboard', key: 'request' } as const
const enabledRef = { plugin: 'callboard', key: 'enabled' } as const
const lastTurn = { plugin: 'callboard', key: 'lastTurnAt' } as const
const nudgeDueRef = { plugin: 'callboard', key: 'nudgeDue' } as const
const interactiveRef = { plugin: 'callboard', key: 'interactive' } as const
// When the tick last sent this session a nudge: the grant's start. Only the tick's nudge submit sets it; any stored request_compact, a prompt that is
// not the mod's own, and /callboard off clear it.
const nudgedAtRef = { plugin: 'callboard', key: 'nudgedAt' } as const
// v13.2, the keepalive ping: when the last main-agent turn ended, when the last real one ended (not started by a ping, a nudge, a notice or the lanes-changed
// turn), and when the tick last tried a ping. Kept in the session state: a reload keeps them (the cache is still warm), a restart loses them (unknown: no ping).
const turnEndRef = { plugin: 'callboard', key: 'turnEndAt' } as const
const realEndRef = { plugin: 'callboard', key: 'realEndAt' } as const
const pingAtRef = { plugin: 'callboard', key: 'pingAt' } as const
// v13.6 (2026-11-03): until when /callboard checkin pause holds this session's check-ins. A reload keeps it, a restart loses it.
const checkinPauseRef = { plugin: 'callboard', key: 'checkinPauseUntil' } as const
const ASK_TIMEOUT_MS = 90_000
const HINT_DELETE_MAX = 50

const run = ($: any, argv: string[], stdin?: string): Promise<R> =>
  $.process.run(argv, { timeoutMs: 5000, ...(stdin === undefined ? {} : { stdin }) })

// v15.4: the stop calls (by session, verb and the lane as the lead typed it) whose process already got its signal, for the hook's .catch.
const signalledCalls = new Map<string, { name: string; pid: number }>()
const stopCallKey = (sid: string, verb: string, lane: unknown) => `${sid}\n${verb}\n${String(lane)}`
// v15.4 (2026-11-06): a wait inside one tool call goes through a host process, never $.clock.sleep. A hook has 10 s of its own time per dispatch (HookBudget.ms),
// and a $.clock.sleep counts against it while no $ call does; a hook past it is cut off, its .catch answers, and the code that was running goes on unseen.
// false: the process did not run or failed, so the caller must not loop on it.
async function pause($: any, ms: number): Promise<boolean> {
  if (!Number.isFinite(ms) || ms <= 0) return false
  const r = await $.process.run([SLEEP, String(ms / 1000)], { timeoutMs: ms + 5000 }).catch(() => undefined)
  return r?.exitCode === 0
}

async function where($: any) {
  if (paths) return paths
  const u = await run($, [ID, '-u'])
  const n = await run($, [ID, '-un'])
  const uid = Number(u.stdout.trim())
  const name = n.stdout.trim()
  if (u.exitCode !== 0 || n.exitCode !== 0 || !Number.isInteger(uid) || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name)) return undefined
  const sessions = `/Users/${name}/.claude/sessions`
  // v13.3: only the own-row lookups follow CLAUDE_CONFIG_DIR (ownRegistryEntries); the cues, lanes, leads and logs stay under ~/.claude. A throw while reading the
  // variable is a bad value too; null reads as unset. The name is a string literal, as `claude plugin validate` reads it.
  let configDir: unknown
  let envFailed = false
  try {
    configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  } catch {
    envFailed = true
  }
  if (configDir === null) configDir = undefined
  let ownDir = envFailed ? undefined : c.ownRegistryDir(configDir as string | undefined, name, sessions)
  // A set folder is resolved once, the config folder itself (it exists: the engine runs from it, where `sessions` may not yet): a link anywhere in it
  // (a parent component the lexical check cannot see) refuses it, so it cannot lead out of the config folders by a link. `sessions` is still held to dirOk
  // at every read (a missing folder or a link there gives no row).
  if (ownDir !== undefined && ownDir !== sessions) {
    const cfg = ownDir.slice(0, -'/sessions'.length)
    const r = await run($, [REALPATH, '--', cfg]).catch(() => undefined)
    if (!r || r.exitCode !== 0 || r.stdout.trim() !== cfg) ownDir = undefined
  }
  paths = { uid, root: `/Users/${name}/.claude/callboard`, sessions, own: ownDir }
  return paths
}

// The rejection is logged by the first own-row lookup that has a session id, once per load of the mod (the flag is set in the same step as the check).
let configDirLogged = false
async function configDirRejected($: any) {
  const sid = await $.session.id().catch(() => '')
  if (configDirLogged || !c.SID_RE.test(sid)) return
  configDirLogged = true
  await log($, sid, 'error', 'config-dir-rejected').catch(() => undefined)
}

async function facts($: any, path: string) {
  const r = await run($, [STAT, '-f', STAT_FMT, '--', path])
  return r.exitCode === 0 ? c.parseStat(r.stdout) : undefined
}

async function dirOk($: any, path: string, uid: number): Promise<boolean> {
  const f = await facts($, path)
  return !!f && f.kind === 'dir' && f.uid === uid && f.mode === 0o700
}

// One log file per session id; fixed reason codes and lane names from the lane stores only.
// Repeated identical refusals (and capped notices) are logged once, so a stuck cue cannot fill the disk.
async function log($: any, sid: string, event: string, reason = '') {
  if (!c.SID_RE.test(sid)) return
  const key = `${event}:${reason}`
  if ((event === 'refused' || event === 'error' || event === 'notice-capped') && lastLogged.get(sid) === key) return
  const p = await where($)
  if (!p) return
  const dir = `${p.root}/log`
  const file = `${dir}/${sid}.jsonl`
  await run($, [MKDIR, '-p', '-m', '700', p.root, dir])
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return
  let f = await facts($, file)
  if (!f) {
    await run($, [INSTALL, '-m', '600', '/dev/null', file])
    f = await facts($, file)
  }
  if (!f || f.kind !== 'file' || f.uid !== p.uid || f.mode !== 0o600 || f.nlink !== 1) return
  // Past LOG_MAX_BYTES only the noisy kinds stop: every rename, stop and compaction line is still written.
  lastLogged.set(sid, key)
  if ((event === 'refused' || event === 'error' || event === 'notice-capped') && f.size > c.LOG_MAX_BYTES) return
  const line = JSON.stringify({ t: new Date(await $.clock.now()).toISOString(), event, reason })
  await run($, [TEE, '-a', '--', file], `${line}\n`)
}

function ensureTimer($: any) {
  if (timerOn) return
  timerOn = true
  $.clock.every(TICK_MS, () => tick($))
}

async function sha($: any, text: string): Promise<string> {
  const r = await run($, [SHASUM, '-a', '256'], text)
  const h = r.stdout.slice(0, 64)
  if (r.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(h)) throw new Error('sha-failed')
  return h
}

async function real($: any, path: string): Promise<string> {
  const r = await run($, [REALPATH, '--', path])
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

// "Not a directory": a part of the path is a file, so the path cannot exist as written; it is as absent as a missing one.
const GONE_RE = /No such file or directory|Not a directory/

// A path's real path, or 'absent' when realpath says there is no such file, or 'error' when the check itself failed (a timeout, a spawn failure, anything
// else): a writer must not treat a failed check as a folder that is gone. The message is read, so it runs in the C locale.
async function realR($: any, path: string): Promise<{ path: string } | 'absent' | 'error'> {
  try {
    const r = await $.process.run([REALPATH, '--', path], { timeoutMs: 5000, env: { LC_ALL: 'C' } })
    if (r.exitCode === 0) return { path: r.stdout.trim() }
    return GONE_RE.test(r.stderr) ? 'absent' : 'error'
  } catch {
    return 'error'
  }
}

// lstat facts of a path, 'absent', or 'error' (any failure but "no such file" or "not a directory", or a throw).
async function statR($: any, path: string): Promise<(c.FileFacts & { ino: number }) | 'absent' | 'error'> {
  try {
    const r = await $.process.run([STAT, '-f', STAT_FMT, '--', path], { timeoutMs: 5000, env: { LC_ALL: 'C' } })
    if (r.exitCode === 0) return c.parseStat(r.stdout) ?? 'error'
    return GONE_RE.test(r.stderr) ? 'absent' : 'error'
  } catch {
    return 'error'
  }
}

// Whether a folder is a git repo root, by one rule for every caller: `.git` (not followed if it is a link) is a folder holding a plain HEAD file, or a plain
// file whose first line starts `gitdir: ` (a worktree or submodule). A symlinked `.git`, an empty `.git` folder or anything else is not. 'error': a check
// failed, which is neither answer.
async function gitRoot($: any, dir: string): Promise<'yes' | 'no' | 'error'> {
  const g = await statR($, `${dir}/.git`)
  if (g === 'error') return 'error'
  if (g === 'absent') return 'no'
  if (g.kind === 'dir') {
    const h = await statR($, `${dir}/.git/HEAD`)
    return h === 'error' ? 'error' : h !== 'absent' && h.kind === 'file' ? 'yes' : 'no'
  }
  if (g.kind !== 'file') return 'no'
  const p = await where($)
  if (!p) return 'error'
  const r = await readSmallR($, `${dir}/.git`, p.uid, 4096, true)
  if (r.state === 'changed' || r.state === 'failed') return 'error'
  return r.state === 'ok' && r.text.startsWith('gitdir: ') ? 'yes' : 'no'
}

// The records of a store that a rewrite keeps: a record goes only when its folder is gone or is not its own real path; one whose check failed is kept (every
// reader skips an unresolvable record anyway), and that is logged once per write.
async function keptLanes($: any, lanes: c.Store['lanes']): Promise<c.Store['lanes']> {
  const kept: c.Store['lanes'] = []
  let failed = false
  for (const l of lanes) {
    const r = await realR($, l.folder)
    if (r === 'error') failed = true
    if (r === 'error' || (r !== 'absent' && r.path === l.folder)) kept.push(l)
  }
  if (failed) await log($, await $.session.id().catch(() => ''), 'error', 'store-check').catch(() => undefined)
  return kept
}

// The lanes a lead made: one file per repo in the user's own callboard folder, named by the hash of the repo's real path, never found by walking up
// from a folder. Anything that fails a check is skipped whole; a lane whose folder is not its own real path is skipped.
async function loadStores($: any): Promise<{ key: string; store: c.Store }[]> {
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
async function loadLanes($: any): Promise<c.Lane[] | string> {
  const stores = await loadStores($)
  const count = new Map<string, number>()
  for (const s of stores) for (const l of s.store.lanes) count.set(l.name, (count.get(l.name) ?? 0) + 1)
  const out: c.Lane[] = []
  for (const s of stores) for (const l of s.store.lanes) if (count.get(l.name) === 1) out.push({ name: l.name, folder: l.folder, brief: l.brief, repo: l.repo, src: s.key, ...(l.adopted ? { adopted: true as const, lead: l.lead } : {}), ...(l.model ? { model: l.model } : {}), ...(l.sid !== undefined ? { sid: l.sid } : {}), ...(l.parked !== undefined ? { parked: l.parked } : {}), ...(l.leadName ? { leadName: l.leadName } : {}) })
  return out
}

// Lanes a lead makes live in ~/.claude/callboard/lanes/<sha256 of the repo's real path>.json; the grant's folder is the repo.
async function storePath($: any, key: string): Promise<string> {
  return `${(await where($))!.root}/lanes/${key}.json`
}
// absent: no file. bad: something is there that the loader would not trust or could not read. ok: a plain private file of ours, read with a bound.
async function readStoreFile($: any, path: string, uid: number): Promise<{ state: 'absent' | 'bad' | 'ok'; text: string }> {
  const r0 = await $.process.run([STAT, '-f', STAT_FMT, '--', path], { timeoutMs: 5000, env: { LC_ALL: 'C' } })
  if (r0.exitCode !== 0) return { state: /No such file or directory/.test(r0.stderr) ? 'absent' : 'bad', text: '' }
  const f = c.parseStat(r0.stdout)
  if (!f || f.kind !== 'file' || f.uid !== uid || f.mode !== 0o600 || f.nlink !== 1 || f.size > c.STORE_MAX_BYTES) return { state: 'bad', text: '' }
  const r = await run($, [HEAD, '-c', String(c.STORE_MAX_BYTES + 1), '--', path])
  return r.exitCode === 0 ? { state: 'ok', text: r.stdout } : { state: 'bad', text: '' }
}

// Store writes of one repo go one at a time inside this process (a lead can issue parallel tool calls).
const storeLocks = new Map<string, Promise<void>>()
async function lockStore(key: string): Promise<() => void> {
  const prev = storeLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((r) => (release = r))
  storeLocks.set(key, prev.then(() => mine))
  await prev
  return release
}

// One store write, from any of the four writers: the in-process queue, then the mkdir lock between processes, then read, compute and write only,
// then a re-read: a writer whose change is not in the file after its own write says so (wrote: the file was replaced, so that writer may have to undo it). `pre` runs after the queue and before the lock (it may be slow).
type Edit = { no: string; why?: string } | { skip: true } | { text: string; landed: (s: c.Store | undefined) => boolean }
async function editStore($: any, key: string, fn: (cur: { state: 'absent' | 'bad' | 'ok'; text: string }, ctx: any) => Promise<Edit>, pre?: () => Promise<any>): Promise<{ no: string; why?: string; wrote?: true } | { text: string }> {
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
  const owner = JSON.stringify({ pid: Number(me.pid), procStart: me.j.procStart, nonce: `${await $.clock.now()}-${++seq}-${Math.random().toString(36).slice(2, 12)}` })
  const deadline = (await $.clock.now()) + c.LOCK_WAIT_MS
  for (;;) {
    // The 'File exists' test below reads the message: it must not be translated.
    const m = await $.process.run([MKDIR, '-m', '700', '--', lock], { timeoutMs: 5000, env: { LC_ALL: 'C' } })
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
  const r = await $.process.run([PS, '-o', 'lstart=', '-p', String(o.pid)], { timeoutMs: 5000, env: { TZ: 'UTC', LC_ALL: 'C' } })
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
    const moved = `${lock}.stale.${await $.clock.now()}.${++seq}`
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
    if (!mine) await log($, await $.session.id().catch(() => ''), 'error', 'lock-gate').catch(() => undefined)
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
// A release that could not be confirmed (twice) is owed: the tick tries again, up to 30 times, and stops when the folder is gone or names another holder.
// Nothing here lets a lock that names our own pid be removed by another take of the lock.
const unlockOwed = new Map<string, { key: string; nonce: string; tries: number }>()
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
    await log($, sid, 'error', 'unlock').catch(() => undefined)
  }
}
async function unlockRetry($: any, sid: string) {
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

// A small plain file of ours (0600 unless `loose`, one link), read with a bound and checked again after the read; never with $.fs.read, which a FIFO would hang.
// 'changed': the file was replaced while it was read (worth one more try); 'failed': it was there but the read or the second look failed (also worth one more
// try, and never the same as 'bad'); 'bad': gone, too big or not a file we trust.
type Small = { state: 'ok'; text: string; mtimeMs: number } | { state: 'changed' | 'failed' | 'bad' }
async function readSmallR($: any, path: string, uid: number, max: number, loose = false): Promise<Small> {
  const f = await facts($, path)
  if (!f || f.kind !== 'file' || f.uid !== uid || (loose ? (f.mode & 0o7022) !== 0 : f.mode !== 0o600) || f.nlink !== 1 || f.size > max) return { state: 'bad' }
  const r = await run($, [HEAD, '-c', String(max + 1), '--', path])
  const after = await facts($, path)
  if (r.exitCode !== 0 || !after) return { state: 'failed' }
  if (r.stdout.length > max) return { state: 'bad' }
  return c.sameFile(f, after) ? { state: 'ok', text: r.stdout, mtimeMs: f.mtimeMs } : { state: 'changed' }
}
async function readSmall($: any, path: string, uid: number, max: number): Promise<{ text: string; mtimeMs: number } | undefined> {
  const r = await readSmallR($, path, uid, max)
  return r.state === 'ok' ? r : undefined
}

// undefined means the registry could not be trusted or found, which is not the same as "no live sessions": callers that
// treat an empty list as permission (name-in-use, duplicate-open guards) must refuse on it.
async function registryEntries($: any): Promise<{ pid: string; j: any }[] | undefined> {
  return (await registryEntriesWhy($)).rows
}

// The same read, with the reason the dead-row filter was off for it (v13, the rebind): undefined only when this session's own row is live and every row the
// table lacks was confirmed gone or absent; 'ps-confirm' when that confirmation failed or was cut (every row kept).
// dir (v13.3): the folder to read, `sessions` unless the caller asks for the own registry (ownRegistryEntries). One call reads one folder; rows of two registries
// are never put in one list.
async function registryEntriesWhy($: any, dirArg?: string): Promise<{ rows: { pid: string; j: any }[] | undefined; why?: string }> {
  const p = await where($)
  if (!p) return { rows: undefined }
  const dir = dirArg ?? p.sessions
  if (!(await dirOk($, dir, p.uid))) return { rows: undefined }
  const out: { pid: string; j: any }[] = []
  const names = ((await $.fs.list(dir).catch(() => [])) as { name: string }[]).map((f) => f.name).filter((n) => /^[A-Za-z0-9-]{1,64}\.json$/.test(n))
  // A registry longer than the cap cannot be looked at whole, and a name could hide past the cap: no answer, not a cut one.
  if (names.length > c.REGISTRY_FILES_MAX) {
    await log($, await $.session.id().catch(() => ''), 'error', 'registry-too-many').catch(() => undefined)
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
  if (fresh.why) await log($, self, 'error', `registry-${fresh.why}`).catch(() => undefined)
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
      await log($, self, 'error', v ? 'registry-ps-cut' : 'registry-ps-confirm').catch(() => undefined)
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

// Rows ps -p confirmed gone, as pid and start time: that process has ended for good, so a later read need not ask again. A pid reused later has another start
// time, so its row is stale anyway. Cleared whole when full, and at session start.
const goneSeen = new Set<string>()

// The start times of the asked pids, by one ps call; undefined on any doubt (a throw, a timeout, another exit, output that does not parse).
async function psConfirm($: any, pids: number[]): Promise<Map<number, string> | undefined> {
  try {
    const r = await $.process.run([PS, '-o', 'pid=,lstart=', '-p', pids.join(',')], { timeoutMs: 5000, env: { TZ: 'UTC', LC_ALL: 'C' } })
    return typeof r.stdout === 'string' && r.stdout.length <= c.PS_TABLE_MAX ? c.parsePsConfirm(r.stdout, r.exitCode, pids, r.stderr) : undefined
  } catch {
    return undefined
  }
}

// Every process's start time, as the registry records it (UTC, C locale). undefined: ps failed, threw, or printed what cannot be trusted.
async function psStarts($: any): Promise<Map<number, string> | undefined> {
  try {
    const r = await $.process.run([PS, '-A', '-o', 'pid=,lstart='], { timeoutMs: 5000, env: { TZ: 'UTC', LC_ALL: 'C' } })
    return r.exitCode === 0 && typeof r.stdout === 'string' && r.stdout.length <= c.PS_TABLE_MAX ? c.parsePsStarts(r.stdout) : undefined
  } catch {
    return undefined
  }
}

// One cue or one tool call reads the registry once: a memo that its steps share.
type Reg = () => Promise<{ pid: string; j: any }[] | undefined>
const regOnce = ($: any): Reg => {
  let p: ReturnType<Reg> | undefined
  return () => (p ??= registryEntries($))
}

// v13.3: the registry that holds this session's OWN row: `sessions` unless CLAUDE_CONFIG_DIR names a good folder, none (no row, fails closed) when it names a bad
// one. Used only where the session looks at itself (a person's row, idle, its shells, the nudge and the ping); everything that looks at other sessions or at
// a cue (names, lanes, leads, the lock owner, a cue's idle check) reads `sessions` alone through registryEntries.
async function ownRegistryEntries($: any): Promise<{ pid: string; j: any }[] | undefined> {
  const p = await where($)
  if (p && p.own === undefined) await configDirRejected($)
  return p?.own === undefined ? undefined : (await registryEntriesWhy($, p.own)).rows
}
const ownRegOnce = ($: any): Reg => {
  let p: ReturnType<Reg> | undefined
  return () => (p ??= ownRegistryEntries($))
}
const ownReg = ($: any): Reg => () => ownRegistryEntries($)

async function liveNames($: any, reg: Reg = () => registryEntries($)): Promise<string[]> {
  return ((await reg()) ?? []).flatMap((e) => (typeof e.j.name === 'string' ? [e.j.name] : []))
}

async function registryOf($: any, sid: string, reg: Reg = () => registryEntries($)): Promise<any | undefined> {
  // Exactly one entry of this session, as attach: with two, it is unclear which status and name are its own.
  const mine = (await reg())?.filter((e) => e.j.sessionId === sid) ?? []
  return mine.length === 1 ? mine[0].j : undefined
}

async function idleCheck($: any, sid: string, reg: Reg = () => registryEntries($)): Promise<string | undefined> {
  const draft = await $.prompt.read()
  if (draft.text !== '') return 'draft-in-box'
  const j = await registryOf($, sid, reg)
  if (!j) return 'registry-unreadable'
  if (j.status !== 'idle' || (j.waitingFor ?? null) !== null) return 'not-idle'
  return undefined
}

const countDown = (m: Map<string, number>, text: string) => {
  const n = (m.get(text) ?? 1) - 1
  if (n > 0) m.set(text, n)
  else m.delete(text)
}

// real: false for a turn that is not work (A, v13.2): it moves no stop clock of the keepalive ping. v13.4: the counts are taken down by the turn.start that
// carries the text (ownTextOf), or here when the submit throws.
async function submitOwn($: any, text: string, real = true) {
  own.set(text, (own.get(text) ?? 0) + 1)
  if (!real) unrealOwn.set(text, (unrealOwn.get(text) ?? 0) + 1)
  submits++
  try {
    await $.prompt.submit({ text })
  } catch (e) {
    countDown(own, text)
    if (!real) countDown(unrealOwn, text)
    throw e
  }
}

// v13.4 (2026-11-03): the own text a main-loop turn.start carries (see c.OWN_FRAME_HEAD): one submitted and not yet counted down, as it stands or framed.
const ownTextOf = (startText: unknown): string | undefined => c.ownTextOf(startText, own.keys())

async function counts($: any): Promise<Counters> {
  return ((await $.state.get(counters)).value ?? {}) as Counters
}

// Read-modify-write on the counters, read as late as possible and written only if unchanged.
async function bump($: any, fn: (ct: Counters) => Counters) {
  for (let i = 0; i < 3; i++) {
    const cur = await $.state.get(counters)
    const res = await $.state.set(counters, fn((cur.value ?? {}) as Counters), { ifVersion: cur.version })
    if (res.isSet !== false) return
  }
  throw new Error('counters-conflict')
}

// v13.5 (2026-11-03): a bound lane only; /callboard on is retired.
async function isEligible($: any): Promise<boolean> {
  return c.eligible((await $.state.get(lane)).value != null)
}
// Whether a stored request may still run its way: one the nudge or the session itself granted, a bound lane's, or (v14, 2026-11-04) a lead's own on-cue
// request while it still holds a lead grant (S7: the manager's compact cue acts on it).
async function requestOk($: any, sid: string, req: Request): Promise<boolean> {
  return req.viaNudge === true || (req.viaLead === true && grants.get(sid)?.level === 'lead') || (await isEligible($))
}

// $.store is a file any same-uid process can write, so this is a hint only (ADR 0002, v7): it is read back only after the person runs
// /callboard lane (v13.5; /callboard on before) and allows the restore, and never written for a session that is not bound (v13.5: an unbound session's
// lane hint is never overwritten, so it keeps its Restore offer).
async function saveHint($: any, sid: string) {
  try {
    const l = (await $.state.get(lane)).value
    if (!l) return
    const body = { lane: l, counters: await counts($) }
    const sig = JSON.stringify(body)
    const now = await $.clock.now()
    const prev = lastSaved.get(sid)
    if (prev && prev.sig === sig && now - prev.at < c.HINT_REFRESH_MS) return
    await $.store.set(`${c.HINT_PREFIX}${sid}`, { ...body, savedAt: now })
    lastSaved.set(sid, { sig, at: now })
  } catch {
    await log($, sid, 'error', 'hint-save').catch(() => undefined)
  }
}

async function pruneHints($: any, me: string) {
  const now = await $.clock.now()
  const all = (await $.store.keys()) as string[]
  const keys = all.filter((k) => k.startsWith(c.HINT_PREFIX)).slice(0, c.HINT_SCAN_MAX)
  let dels = 0
  for (const k of keys) {
    if (dels >= HINT_DELETE_MAX) break
    if (!c.SID_RE.test(k.slice(c.HINT_PREFIX.length)) || !c.parseHint(await $.store.get(k), now)) {
      await $.store.delete(k)
      dels++
    }
  }
  // v13: lead grants (lead:<sid>), with their own caps. The starting session's own is left to the lead restore, which reads it and deletes it itself.
  const p = await where($)
  if (!p) return
  // v13.5: a saved on (on:<sid>) is never read now (/callboard on is retired): every other session's goes, unread, under the same cap; a delete that fails
  // stops nothing. The starting session's own goes in onLeftovers.
  let onDels = 0
  for (const k of all.filter((x) => x.startsWith(c.ON_HINT_PREFIX) && x !== `${c.ON_HINT_PREFIX}${me}`).slice(0, c.HINT_SCAN_MAX)) {
    if (onDels >= HINT_DELETE_MAX) break
    onDels++
    await Promise.resolve()
      .then(() => $.store.delete(k))
      .catch(() => undefined)
  }
  // v13.1: cut-compaction marks (cmp:<sid>) of other sessions, under the same caps; the starting session's own is read at start.
  for (const [prefix, ok] of [[c.CMP_PREFIX, (v: unknown) => c.cmpMarkFresh(v, now)]] as const) {
    let n = 0
    for (const k of all.filter((x) => x.startsWith(prefix) && x !== `${prefix}${me}`).slice(0, c.HINT_SCAN_MAX)) {
      if (n >= HINT_DELETE_MAX) break
      if (!c.SID_RE.test(k.slice(prefix.length)) || !ok(await $.store.get(k))) {
        await $.store.delete(k)
        n++
      }
    }
  }
  // v15: other sessions' saved conductor grants (conductor:<sid>) that fail the parse, under the same caps.
  let condDels = 0
  for (const k of all.filter((x) => x.startsWith(c.CONDUCTOR_HINT_PREFIX) && x !== `${c.CONDUCTOR_HINT_PREFIX}${me}`).slice(0, c.HINT_SCAN_MAX)) {
    if (condDels >= HINT_DELETE_MAX) break
    if (!c.SID_RE.test(k.slice(c.CONDUCTOR_HINT_PREFIX.length)) || !c.parseConductorHint(await $.store.get(k), now, homeOf(p))) {
      await $.store.delete(k)
      condDels++
    }
  }
  // v15.3: other sessions' saved manager grants (manager:<sid>) that fail the parse, under the same caps.
  let mgrDels = 0
  for (const k of all.filter((x) => x.startsWith(c.MANAGER_HINT_PREFIX) && x !== `${c.MANAGER_HINT_PREFIX}${me}`).slice(0, c.HINT_SCAN_MAX)) {
    if (mgrDels >= HINT_DELETE_MAX) break
    if (!c.SID_RE.test(k.slice(c.MANAGER_HINT_PREFIX.length)) || !c.parseManagerHint(await $.store.get(k), now)) {
      await $.store.delete(k)
      mgrDels++
    }
  }
  const leads = all.filter((k) => k.startsWith(c.LEAD_HINT_PREFIX) && k !== `${c.LEAD_HINT_PREFIX}${me}`).slice(0, c.HINT_SCAN_MAX)
  let leadDels = 0
  for (const k of leads) {
    if (leadDels >= HINT_DELETE_MAX) break
    if (!c.SID_RE.test(k.slice(c.LEAD_HINT_PREFIX.length)) || !c.parseLeadHint(await $.store.get(k), now, homeOf(p))) {
      await $.store.delete(k)
      leadDels++
    }
  }
}

// restoredOnce: a restore was decided (restored, declined or refused for good); one asked, attempted or held back is asked again at the next /callboard lane.
const restoredOnce = new Set<string>()

// 'error' covers a failed dialog and any answer that is neither button; 'timed-out' a question nobody answered in time. Neither is
// a decision, and every caller treats them alike: only 'no' clears anything. The engine dialog stays on screen (no cancel call); a late click is ignored.
type Asked = 'yes' | 'no' | 'error' | 'timed-out'
async function ask($: any, question: string, yes: string, no: string, header: string): Promise<Asked> {
  try {
    const a = await withTimeout($, $.ui.ask(question, { options: [yes, no], header }) as Promise<string>, ASK_TIMEOUT_MS)
    return a === 'timeout' ? 'timed-out' : a === yes ? 'yes' : a === no ? 'no' : 'error'
  } catch {
    return 'error'
  }
}

// The log line and toast for a question nobody answered; returns the words the command or tool result ends with.
async function timedOut($: any, sid: string, code = 'timed-out', toastText: string = c.TIMED_OUT_TOAST): Promise<string> {
  await log($, sid, 'refused', code)
  toast($, toastText)
  return c.TIMED_OUT
}

// A toast only informs: it runs after the effect it reports and can never change the result of the call.
function toast($: any, text: string) {
  try {
    Promise.resolve($.ui.toast(text)).catch(() => undefined)
  } catch {}
}

// v15.2: the live checkout's branch, checked once per session start (ADR 0003). The checkout is found from the mod's own folder ($.plugin.root, the folder
// holding plugin.json: <checkout>/tools/callboard/mod); .git/HEAD is read as a plain file with a bound, never through git (a changed .git/config could run
// code). Main: nothing. Another branch or a detached commit: one toast and `warn live-checkout-not-main`. No checkout at that place, a .git that is a file (a
// worktree), an unreadable or odd HEAD: `warn live-checkout-unknown`, no toast. It only warns: the mod loads and nothing is blocked. No path enters a log line.
async function liveCheckoutCheck($: any, sid: string): Promise<void> {
  try {
    let root: unknown
    try {
      root = $.plugin.root
    } catch {}
    const checkout = c.liveCheckout(root)
    let head: c.LiveHead = { kind: 'unknown' }
    if (checkout) {
      const r = await run($, [HEAD, '-c', String(c.LIVE_HEAD_MAX + 1), '--', `${checkout}/.git/HEAD`]).catch(() => undefined)
      if (r && r.exitCode === 0) head = c.parseLiveHead(r.stdout)
    }
    if (head.kind === 'main') return
    if (!checkout || head.kind === 'unknown') {
      await log($, sid, 'warn', 'live-checkout-unknown')
      return
    }
    toast($, c.liveCheckoutToast(checkout, head))
    await log($, sid, 'warn', 'live-checkout-not-main')
  } catch {}
}

// One callboard question per session at a time: a second request while one is open is refused, not queued.
const dialogOpen = new Set<string>()
// Counts the `off` commands that ran, so a restore or a join that waited on a dialog can see an `off` came in meanwhile and stop.
const offSeq = new Map<string, number>()
async function askOnce($: any, sid: string, question: string, yes: string, no: string, header: string): Promise<Asked | 'busy'> {
  if (dialogOpen.has(sid)) return 'busy'
  dialogOpen.add(sid)
  try {
    return await ask($, question, yes, no, header)
  } finally {
    dialogOpen.delete(sid)
  }
}

// The Join dialog's lead picker (S2b), with ask's time limit and error handling. More… turns the page; a dismissal, a failure or an answer not offered is 'error'.
// The answer is wrapped, so a lead named like the timeout mark is still a name.
async function pickLead($: any, names: string[]): Promise<{ name: string } | 'error' | 'timed-out'> {
  for (let page = 0; ; page++) {
    const options = c.leadPickOptions(names, page)
    try {
      const a = await withTimeout($, Promise.resolve($.ui.ask(c.LEAD_PICK_QUESTION, { options, header: c.HEADER.attach })).then((x: unknown) => ({ x })), ASK_TIMEOUT_MS)
      if (a === 'timeout') return 'timed-out'
      if (a.x === c.LEAD_MORE && options.includes(c.LEAD_MORE)) continue
      // Cancel beside a lone name is a cancel, even for a lead named Cancel.
      if (names.length === 1 && a.x === c.ATTACH_NO) return 'error'
      return typeof a.x === 'string' && names.includes(a.x) && options.includes(a.x) ? { name: a.x } : 'error'
    } catch {
      return 'error'
    }
  }
}


// The lead grant lives only in this module's memory: a reload or a restart drops it, and /callboard lead has to be run and allowed again.
// It keeps the cwd the lead had when the person gave it, so a later cd cannot move the lead into another repo's lanes.
// The engine has no call that removes a tool, so after `off` the tools stay declared and refuse every call.
// The levels plan (S1b): one grant per session, in the shape every level shares (c.Grant). Only lead grants are made so far.
const grants = new Map<string, c.Grant>()
// A lead's one pin; undefined for no grant, and for any other level (a conductor or manager has no single pin; S6 and S4 read their grants whole).
const pinOf = (sid: string): string | undefined => {
  const g = grants.get(sid)
  return g?.level === 'lead' ? g.pins[0] : undefined
}
// A session is a lane or a lead, never both. Each grant path checks the other's mark and sets its own with no await in
// between, and holds it until its own write has landed, so a lead grant and a lane binding that race cannot both pass.
const leadGranting = new Set<string>()
const laneBinding = new Set<string>()
const leadBusy = (sid: string) => grants.has(sid) || leadGranting.has(sid)
const grantOf = (sid: string): c.Grant | undefined => grants.get(sid)
// The grant's name: the session's registry name just after the grant, by c.leadNameOf ('' when it gives none). Set only if the grant is still the same object,
// so an off or a re-grant meanwhile is never overwritten. Nothing reads it for reach: leadCore reads the name from the live registry again at every lead tool
// call (S2). It is read by lane_create, to tell a lead that had a name at its grant and lost it (refused lead-unnamed) from one that never had one, and by the
// rename carry (leadRenameTick), which moves it when the lead is renamed.
// Run last on both grant paths (S1b review c1), so its registry scan never widens the window in which an off races the grant; bounded by NAME_GRANT_MS.
const NAME_GRANT_MS = 5000
async function nameGrant($: any, sid: string) {
  const g = grants.get(sid)
  if (!g) return
  try {
    const rows = await withTimeout($, registryEntries($), NAME_GRANT_MS)
    const n = (rows === 'timeout' || !rows ? undefined : c.leadNameOf(rows.map((e) => e.j), sid)) ?? ''
    if (grants.get(sid) === g) grants.set(sid, { ...g, name: n })
  } catch {
    await log($, sid, 'error', 'grant-name').catch(() => undefined)
  }
}
const leadDeclared = new Set<string>()
// The pin the briefing note was last appended for, per session: one note per grant and pin, dropped with the grant.
const briefed = new Map<string, string>()

const leadReason = (verb: string, why: string) => `lane_${verb} refused: ${why}`

const homeOf = (p: { root: string }) => p.root.slice(0, -'/.claude/callboard'.length)

// ---- the lead's presence file: <root>/leads/<lead sid>.json, a filter that says a lead runs for a repo; nothing is ever sent to the sid in it ----
// Written at the grant (only for a pin lane_create would accept), rewritten every tick and at the start of every lead tool call so its mtime stays fresh,
// removed on off, on a Deny, at session start and at session end. Its writes and its removal go one at a time, so a removal is not undone by a write in flight.
const presenceText = new Map<string, string>()
let presenceQ: Promise<unknown> = Promise.resolve()
const queued = <T>(fn: () => Promise<T>): Promise<T> => {
  const r = presenceQ.then(fn, fn)
  presenceQ = r.catch(() => undefined)
  return r
}
// presenceText: undefined = not set up yet; '' = this pin cannot hold lanes, so no file. A check that failed (not a no) is not cached: the next tick or lead
// tool call tries again, then the pin is cached as a no and logged once PRESENCE_TRIES failures have been counted. At most one failure counts per tick
// interval, so a burst of lead tool calls against an error that comes back at once cannot spend the budget in a second.
const PRESENCE_TRIES = 5
const presenceErrs = new Map<string, { n: number; at: number }>()
// v15: what a conductor's cached presence text was made from (its repo, name and pins).
const conductorPresenceKey = new Map<string, string>()
// v14 (2026-11-04): a manager's file names no repo, so none of the pin checks; it resolves true once the file was written.
function presenceTouch($: any, sid: string): Promise<boolean | void> {
  return queued(async () => {
    const pin = pinOf(sid)
    const g = grants.get(sid)
    const p = await where($)
    if (g?.level === 'manager' && p) {
      let text = presenceText.get(sid)
      if (text === undefined) {
        const mine = (await registryEntries($))?.filter((e) => e.j.sessionId === sid) ?? []
        const me = mine.length === 1 && String(mine[0].j.pid) === mine[0].pid ? mine[0] : undefined
        if (!me || typeof me.j.procStart !== 'string') return false
        text = c.leadFileText({ sid, pid: Number(me.pid), procStart: me.j.procStart, level: 'manager', name: g.name }) ?? ''
        // The grant may have ended while the registry was read: its file is not written.
        if (grants.get(sid) !== g) return false
        presenceText.set(sid, text)
      }
      if (text === '') return false
      const w = await writeIn($, 'leads', `${sid}.json`, text)
      if ('err' in w) await log($, sid, 'error', 'presence')
      return !('err' in w)
    }
    // v15 (2026-11-05): a conductor's file names its repos (its pins now) and its own repo, never repo; it is rewritten when those change, and goes when
    // no repo is left in reach.
    if (g?.level === 'conductor' && p) {
      const home = conductorHome.get(sid)
      if (home === undefined) return false
      if (g.pins.length === 0) {
        presenceText.delete(sid)
        conductorPresenceKey.delete(sid)
        await run($, [RM, '-f', '--', `${p.root}/leads/${sid}.json`])
        return false
      }
      const key = `${home}\n${g.name}\n${g.pins.join('\n')}`
      let text = presenceText.get(sid)
      if (text === undefined || conductorPresenceKey.get(sid) !== key) {
        const mine = (await registryEntries($))?.filter((e) => e.j.sessionId === sid) ?? []
        const me = mine.length === 1 && String(mine[0].j.pid) === mine[0].pid ? mine[0] : undefined
        if (!me || typeof me.j.procStart !== 'string') return false
        text = c.leadFileText({ sid, pid: Number(me.pid), procStart: me.j.procStart, level: 'conductor', name: g.name, repos: g.pins, home }) ?? ''
        if (grants.get(sid) !== g) return false
        presenceText.set(sid, text)
        conductorPresenceKey.set(sid, key)
      }
      if (text === '') return false
      const w = await writeIn($, 'leads', `${sid}.json`, text)
      if ('err' in w) await log($, sid, 'error', 'conductor-presence')
      return !('err' in w)
    }
    if (pin === undefined || !p) return
    let text = presenceText.get(sid)
    if (text === undefined) {
      const r = c.pinRefusal(pin, homeOf(p)) !== undefined ? 'no' : await realR($, pin)
      const g = r === 'no' || r === 'error' || r === 'absent' || r.path !== pin ? undefined : await gitRoot($, pin)
      if (r === 'error' || g === 'error') {
        const now = await $.clock.now()
        const was = presenceErrs.get(sid)
        const n = was && now - was.at < TICK_MS ? was.n : (was?.n ?? 0) + 1
        if (n !== was?.n) presenceErrs.set(sid, { n, at: now })
        if (n < PRESENCE_TRIES) return await log($, sid, 'error', 'presence-check')
        presenceText.set(sid, '')
        return await log($, sid, 'error', 'presence-git-error')
      }
      if (g !== 'yes') {
        presenceText.set(sid, '')
        return
      }
      // Exactly one entry of this session, else no file: with two, the pid could be a twin's. The text is computed once, from that one entry, so it stays right
      // if a twin appears later.
      const mine = (await registryEntries($))?.filter((e) => e.j.sessionId === sid) ?? []
      const me = mine.length === 1 && String(mine[0].j.pid) === mine[0].pid ? mine[0] : undefined
      if (!me || typeof me.j.procStart !== 'string') return
      text = c.leadFileText({ sid, pid: Number(me.pid), procStart: me.j.procStart, repo: pin }) ?? ''
      presenceText.set(sid, text)
    }
    if (text === '') return
    const w = await writeIn($, 'leads', `${sid}.json`, text)
    if ('err' in w) await log($, sid, 'error', 'presence')
  })
}
function presenceDrop($: any, sid: string) {
  presenceText.delete(sid)
  presenceErrs.delete(sid)
  conductorPresenceKey.delete(sid)
  return queued(async () => {
    const p = await where($)
    if (p) await run($, [RM, '-f', '--', `${p.root}/leads/${sid}.json`])
  })
}
// The lead grant ends: the tools stay declared and refuse, the presence file goes, the lane-list watch stops.
// v13 review (F1): bumped by every leadDrop. A lead restore or a save of the grant that awaited across a drop sees the change and does nothing more, so an
// off or a Cancel is never undone by work that started before it.
const leadEpoch = new Map<string, number>()
const epochOf = (sid: string) => leadEpoch.get(sid) ?? 0
// Resolves true when the saved grant is gone, false when its delete failed (the off and Cancel replies then say lead may come back after a restart).
function leadDrop($: any, sid: string): Promise<boolean> {
  leadEpoch.set(sid, epochOf(sid) + 1)
  grants.delete(sid)
  briefed.delete(sid)
  watch.delete(sid)
  cappedLogged.delete(sid)
  // v13.6: the check-in memory goes with the grant; laneNotices (the hourly cap) stays.
  laneObs.delete(sid)
  attnTold.delete(sid)
  attnCapped.delete(sid)
  obsAt.delete(sid)
  // v14 (2026-11-04, review c2): what the lead last saw of a manager and the manager's lead-less verdicts go too, so a new grant reads afresh.
  managerSeen.delete(sid)
  managerSeenBusy.delete(sid)
  leadlessSeen.delete(sid)
  leadSavedAt.delete(sid)
  leadRestorePending.delete(sid)
  // v15 (2026-11-05): a conductor's repo, approved list and pending restore go too, and its saved grant below.
  conductorHome.delete(sid)
  conductorApproved.delete(sid)
  conductorSavedAt.delete(sid)
  conductorRestorePending.delete(sid)
  conductorReadAt.delete(sid)
  // v15.3 (2026-11-06): the manager's saved-grant clock goes too. Its pending restore and saved grant do not: a Cancel on a lead's or a conductor's question, or a
  // failed manager grant, must not delete a mark the person never answered (managerForget, from /callboard off and the restore's Cancel, does).
  managerSavedAt.delete(sid)
  // v13: the saved grant goes too, so the session is not lead again after a restart.
  const unsave = Promise.resolve()
    .then(() => $.store.delete(`${c.LEAD_HINT_PREFIX}${sid}`))
    .then(() => $.store.delete(`${c.CONDUCTOR_HINT_PREFIX}${sid}`))
    .then(
      () => true,
      async () => {
        await log($, sid, 'error', 'lead-hint-delete').catch(() => undefined)
        return false
      },
    )
  return Promise.all([presenceDrop($, sid), unsave]).then((r) => r[1])
}

// v13: the lead grant is kept in $.store as lead:<sid> = { pin, savedAt } (D5), written at the grant, at a restore and once a day while lead is on; leadSavedAt
// holds the time of the last write (or try) so the daily check reads no store. A failed write is logged and tried again a day later; the grant stays on.
const leadSavedAt = new Map<string, number>()
async function leadSave($: any, sid: string, pin: string) {
  const epoch = epochOf(sid)
  const now = await $.clock.now()
  if (epochOf(sid) !== epoch || pinOf(sid) !== pin) return
  leadSavedAt.set(sid, now)
  try {
    await $.store.set(`${c.LEAD_HINT_PREFIX}${sid}`, { pin, savedAt: now })
  } catch {
    await log($, sid, 'lead-unsaved').catch(() => undefined)
  }
  // A drop while the write was in flight: the key it wrote goes again.
  if (pinOf(sid) !== pin) await Promise.resolve($.store.delete(`${c.LEAD_HINT_PREFIX}${sid}`)).catch(() => log($, sid, 'error', 'lead-hint-delete').catch(() => undefined))
}

// v13: a session whose saved grant names its own folder is lead again when it starts, with no question (D5). Started in session.start; a cwd read or a tool
// registration that does not answer in time is tried again from the tick, up to LEAD_RESTORE_TRIES ticks, and the key is kept. A grant for another folder is
// deleted. A bound session keeps the key and is not made lead. The briefing note stays in the history from the first grant: no second note.
const LEAD_RESTORE_TRIES = 15
const leadRestorePending = new Map<string, { hint: c.LeadHint; tries: number }>()
// One try: a code when it is to be tried again, undefined when it ended (made lead, or refused and logged).
async function leadRestoreTry($: any, me: string, hint: c.LeadHint): Promise<string | undefined> {
  const reject = (code: string) => log($, me, 'lead-restore-rejected', code)
  const epoch = epochOf(me)
  const dropped = () => epochOf(me) !== epoch
  // A person's session only (F5): a headless run resumed under this id is not made lead; the key is kept and the tick asks again (the registry row of a
  // reopened panel may come a moment after session.start).
  if (!(await interactive($, me))) return dropped() ? undefined : 'not-interactive'
  if (dropped()) return
  let cwd: unknown
  try {
    cwd = await withTimeout($, sessionRoot($), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return 'cwd-unreadable'
  }
  if (dropped()) return
  if (cwd === 'timeout' || typeof cwd !== 'string') return 'cwd-unreadable'
  if (cwd !== hint.pin) {
    await $.store.delete(`${c.LEAD_HINT_PREFIX}${me}`)
    return void (await reject('wrong-folder'))
  }
  // A lane is never a lead too (the rebind refuses a lead in turn); a read that does not answer counts as a binding.
  const held = await withTimeout($, $.state.get(lane), c.ENGINE_CALL_TIMEOUT_MS)
  if (dropped()) return
  if (held === 'timeout' || held?.value != null || laneBinding.has(me)) return void (await reject('lane-holder'))
  // The person granted lead meanwhile: that grant stands.
  if (leadBusy(me)) return
  leadGranting.add(me)
  try {
    // S2b: the same second-lead check as /callboard lead. A refusal ends the try, keeps the key and tells the person. An unreadable session list or a
    // check that does not answer is tried again from the tick, as a cwd read is; the person is told once the tries run out (leadRestore).
    const named = await withTimeout($, secondLeadNo($, me, hint.pin), c.ENGINE_CALL_TIMEOUT_MS)
    if (dropped()) return
    if (named === 'timeout') return 'lead-check-slow'
    if (named === 'registry-unreadable') return named
    if (named !== undefined) {
      await reject(named)
      return void toast($, c.leadNotRestoredToast(named))
    }
    let set: unknown
    try {
      set = await withTimeout($, leadToolsOnce($, me), c.ENGINE_CALL_TIMEOUT_MS)
    } catch {
      return void (await reject('tools'))
    }
    // An off or a Cancel while the tools were registering: nothing is granted, and nothing is tried again.
    if (dropped()) return
    if (set === 'timeout') return 'tools-timeout'
    grants.set(me, c.leadGrant(hint.pin))
  } finally {
    leadGranting.delete(me)
  }
  await leadSave($, me, hint.pin)
  // An off or a Cancel during the save: no note, log or toast says lead is on.
  if (dropped()) return
  briefed.set(me, hint.pin)
  await log($, me, 'lead-restored')
  toast($, c.leadRestoredToast(hint.pin))
  await nameGrant($, me)
}
async function leadRestore($: any, me: string, hint: c.LeadHint, tries: number) {
  const epoch = epochOf(me)
  let again: string | undefined
  try {
    again = await leadRestoreTry($, me, hint)
  } catch {
    again = undefined
    await log($, me, 'lead-restore-rejected', 'error').catch(() => undefined)
  }
  if (again === undefined || epochOf(me) !== epoch) return void leadRestorePending.delete(me)
  if (tries >= LEAD_RESTORE_TRIES) {
    leadRestorePending.delete(me)
    await log($, me, 'lead-restore-rejected', again)
    // The second-lead check never got an answer: the key is kept, and the person is told why the lead did not come back (S2b).
    if (again === 'registry-unreadable' || again === 'lead-check-slow') toast($, c.leadNotRestoredToast(again))
    return
  }
  leadRestorePending.set(me, { hint, tries })
}

// v13.5 (2026-11-03): /callboard on is retired. What it left (the enabled state, the saved on:<sid> of v13.1) is cleared at session.start, with
// no toast: it no longer means anything, and the session is eligible only as a bound lane.
async function onLeftovers($: any, sid: string) {
  try {
    if ((await $.state.get(enabledRef)).value != null) {
      await $.state.set(enabledRef, null)
      await log($, sid, 'on-cleared', 'state')
    }
  } catch {
    await log($, sid, 'error', 'on-clear').catch(() => undefined)
  }
  if (!c.SID_RE.test(sid)) return
  // Each store call has the engine-call limit and runs inside an async function, so one that throws at once is answered like one that rejects (as config).
  try {
    const key = `${c.ON_HINT_PREFIX}${sid}`
    const raw = await withTimeout($, (async () => $.store.get(key))(), c.ENGINE_CALL_TIMEOUT_MS)
    if (raw === 'timeout') throw new Error('timeout')
    if (raw !== undefined) {
      const d = await withTimeout($, (async () => $.store.delete(key))().then(() => 'ok' as const), c.ENGINE_CALL_TIMEOUT_MS)
      if (d !== 'ok') throw new Error('timeout')
      await log($, sid, 'on-cleared', 'saved')
    }
  } catch {
    await log($, sid, 'error', 'on-hint-delete').catch(() => undefined)
  }
}

// v13.1: the cut-compaction mark (c.CMP_PREFIX). cmpMarked: this load wrote the mark, so the tick clears it once the request has left `compacting`.
// cmpCutPending: a fresh mark found at start with no request left in $.state; the tick gives the note once the session counts as a person's.
const cmpMarked = new Set<string>()
const cmpCutPending = new Map<string, number>()
const cmpClear = ($: any, sid: string) => {
  cmpMarked.delete(sid)
  // Bounded (review c1, finding 4): a store that does not answer must not hold up PostCompact or the tick.
  return withTimeout($, Promise.resolve($.store.delete(`${c.CMP_PREFIX}${sid}`)).catch(() => log($, sid, 'error', 'cmp-clear').catch(() => undefined)), c.ENGINE_CALL_TIMEOUT_MS)
}
// The note goes once, to a person's session only: a headless run under this id leaves the mark (it ages out), and after LEAD_RESTORE_TRIES ticks it is let go.
// The mark is deleted before the append, so a slow append is never repeated; a failed append is logged and not retried.
async function cmpCutTick($: any, sid: string, tries: number) {
  if (!(await interactive($, sid))) {
    if (tries >= LEAD_RESTORE_TRIES) cmpCutPending.delete(sid)
    else cmpCutPending.set(sid, tries + 1)
    return
  }
  cmpCutPending.delete(sid)
  await cmpClear($, sid)
  let r: any
  try {
    r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: c.COMPACT_CUT_NOTE }] } })
  } catch {
    r = { deny: 'error' }
  }
  if (r?.deny !== undefined) return void (await log($, sid, 'error', 'compact-cut-note'))
  await log($, sid, 'compact-cut')
  toast($, c.COMPACT_CUT_TOAST)
}

// The briefing as one user-role note (c.leadBriefingNote), once per grant and pin. A refused or failed append is logged and changes nothing else: lead stays on, and the
// session is not marked briefed, so the next /callboard lead tries again. The mark is set before the await, so a second grant during the append adds no second note
// and a /callboard off during it leaves no mark behind.
// v14 (2026-11-04): the manager's note, keyed `manager:<name>` in the same map (a pin is an absolute path, so the two never meet).
async function briefLead($: any, sid: string, pin: string, manager?: string) {
  const key = manager === undefined ? pin : `manager:${manager}`
  if (briefed.get(sid) === key) return
  briefed.set(sid, key)
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: manager === undefined ? c.leadBriefingNote(pin) : c.managerBriefingNote(manager) }] } })
    if (r?.deny !== undefined) throw new Error('refused')
  } catch {
    if (briefed.get(sid) === key) briefed.delete(sid)
    await log($, sid, 'error', manager === undefined ? 'lead-briefing' : 'manager-briefing').catch(() => undefined)
  }
}

type RegRow = { pid: string; j: any }
const regEntry = (r: RegRow): c.RegEntry => ({ sessionId: r.j.sessionId as string, name: r.j.name, cwd: r.j.cwd, pid: String(r.j.pid) === r.pid ? r.j.pid : undefined, procStart: r.j.procStart, startedAt: r.j.startedAt, status: r.j.status, statusUpdatedAt: r.j.statusUpdatedAt, waitingFor: r.j.waitingFor })

// One presence file, every check: a plain 0600 file of ours, at most c.LEAD_FILE_MAX (4096) bytes, written in the last 30 s, naming its own file name as the sid; the registry has the
// pid's own file for that session with the same start time, and ps agrees; the repo is one lane_create would accept; the asking folder is in it.
// v14 (2026-11-04): cwd undefined skips the folder check (the manager's lane_compact looks a lead up by name, in any repo).
// v14 (2026-11-04, review c2, CR3): errs, when given, is set when the presence check could not be made (a lead not clearly gone).
// only: a filter on the file's repo that runs before any process is asked about it (the list of a conductor reads only the leads of its repos).
async function leadFileOk($: any, p: { uid: number; root: string }, live: RegRow[], sid: string, cwd: string | undefined, errs?: { error: boolean }, only?: (repo: string) => boolean): Promise<c.LeadFile | undefined> {
  const lf = await presenceFileOk($, p, live, sid, (f) => f.level === 'lead' && (cwd === undefined || cwd === f.repo || c.within(f.repo, cwd)) && (only === undefined || only(f.repo)), errs)
  if (lf?.level !== 'lead') return undefined
  if (c.pinRefusal(lf.repo, homeOf(p)) !== undefined || (await real($, lf.repo)) !== lf.repo || (await gitRoot($, lf.repo)) !== 'yes') return undefined
  return lf
}
// The checks every presence file gets, whatever its level; want filters the parsed file before any process is asked about it.
async function presenceFileOk($: any, p: { uid: number; root: string }, live: RegRow[], sid: string, want: (f: c.PresenceFile) => boolean, errs?: { error: boolean }): Promise<c.PresenceFile | undefined> {
  const r = await presenceCheck($, p, live, sid, want)
  if (r === 'error' && errs) errs.error = true
  return typeof r === 'string' ? undefined : r
}
// v14 (2026-11-04, review c1, L2): the same checks, saying how a file failed them: 'no' for a clear no (gone, not a plain file of ours, stale, another level, no
// registry row, a dead pid, another start time, not claude), 'error' for a check that could not be made (a read that failed or kept changing, a ps that failed).
// A trust check (presenceFileOk) takes both as no; manager-exists and a manager's stop count 'error' as a file that holds (fail closed).
async function presenceCheck($: any, p: { uid: number; root: string }, live: RegRow[], sid: string, want: (f: c.PresenceFile) => boolean): Promise<c.PresenceFile | 'no' | 'error'> {
  const path = `${p.root}/leads/${sid}.json`
  // A lead rewrites its file by renaming a new one into place: a read that met the swap gets one more try.
  let f = await readSmallR($, path, p.uid, c.LEAD_FILE_MAX)
  if (f.state === 'changed') f = await readSmallR($, path, p.uid, c.LEAD_FILE_MAX)
  // v14 (2026-11-04, review c2, CR2): one more read before a failed or changing read counts as 'error', so a passing failure is not a check that failed.
  if (f.state === 'failed' || f.state === 'changed') f = await readSmallR($, path, p.uid, c.LEAD_FILE_MAX)
  if (f.state === 'failed' || f.state === 'changed') return 'error'
  if (f.state !== 'ok' || !c.leadFileFresh(await $.clock.now(), f.mtimeMs)) return 'no'
  const lf = c.parsePresenceFile(f.text, sid)
  if (!lf || !want(lf)) return 'no'
  const reg = live.find((e) => e.pid === String(lf.pid) && e.j.sessionId === sid && c.sameStart(e.j.procStart, lf.procStart) && String(e.j.pid) === e.pid)
  if (!reg) return 'no'
  const start = await psOne($, lf.pid, 'lstart=')
  if (start === 'error') return 'error'
  if (c.pidRefusal(regEntry(reg), start === 'gone' ? undefined : start.out) !== undefined) return 'no'
  // The presence pid must be a claude process, as for the stop tools: a file naming some other live process is not a lead.
  const args = await psOne($, lf.pid, 'args=')
  if (args === 'error') return 'error'
  if (c.processRefusal(args === 'gone' ? undefined : args.out, lf.pid, undefined) !== undefined) return 'no'
  return lf
}
// psStart and psArgs with the failure told apart (review c1, L2): exit 0 is the answer; exit 1 with no output is ps's "no such process" (gone); any other
// result is a ps that failed. A ps that throws still throws, as before.
async function psOne($: any, pid: unknown, field: 'lstart=' | 'args='): Promise<{ out: string } | 'gone' | 'error'> {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return 'gone'
  const r = await $.process.run([PS, '-o', field, '-p', String(pid)], { timeoutMs: 5000, env: field === 'lstart=' ? { TZ: 'UTC', LC_ALL: 'C' } : { LC_ALL: 'C' } })
  if (r.exitCode === 0) return { out: r.stdout }
  return r.exitCode === 1 && `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() === '' ? 'gone' : 'error'
}
// The fresh presence file names, cut to the fresh ones before the cap (as leadsFor). strict (review c2, SA-L1): a list that throws throws, not "none".
async function freshPresence($: any, p: { root: string }, strict = false): Promise<string[]> {
  const now = await $.clock.now()
  const list = (await (strict ? $.fs.list(`${p.root}/leads`) : $.fs.list(`${p.root}/leads`).catch(() => []))) as { name: string; mtimeMs?: number }[]
  return list.filter((f) => f.name.endsWith('.json') && c.SID_RE.test(f.name.slice(0, -5)) && typeof f.mtimeMs === 'number' && c.leadFileFresh(now, f.mtimeMs)).map((f) => f.name.slice(0, -5)).sort().slice(0, c.LEAD_FILES_MAX)
}
// v14 (2026-11-04): every live manager file of another session, each with its registry name if that is a reserved one (c.managerNameOf). manager-exists counts
// every such file, whatever its name; a lead takes a compact cue only while one with a reserved name is live (S7).
// Review c1 (L2): a fresh file whose check could not be made (a read or ps that failed) is listed too, unverified, with no name: manager-exists counts it
// (fail closed); managerTrusted never does.
// Review c2 (SA-L1): a leads folder that is there but fails its checks, or whose list throws, is one unverified manager (manager-exists counts it); a missing
// folder is none.
async function managersLive($: any, live: RegRow[], except: string): Promise<{ sid: string; name?: string; unverified?: true }[]> {
  const d = await presenceNames($)
  if (d === 'none') return []
  if (d === 'error') return [{ sid: '', unverified: true }]
  const p = d.p
  const rows = live.map((r) => r.j)
  const out: { sid: string; name?: string; unverified?: true }[] = []
  for (const s of d.names) {
    if (s === except) continue
    const r = await presenceCheck($, p, live, s, (f) => f.level === 'manager')
    if (r === 'error') out.push({ sid: s, unverified: true })
    else if (r !== 'no') out.push({ sid: s, name: c.managerNameOf(rows, s) })
  }
  return out
}
// A live manager whose cue a session may take (S7; review c1 W1 and the lead's on-cue section): its file passed every check and the registry gives it a reserved
// name no other live row carries.
async function managerTrusted($: any, live: RegRow[], except: string): Promise<boolean> {
  return (await managersLive($, live, except)).some((m) => m.unverified !== true && m.name !== undefined)
}
// v15 S7: the live conductors a lead (pin) takes a compact cue from: another session's fresh conductor file that passes presenceCheck and lists the pin, whose
// home is its own real path, not too broad and a git root; that session's saved grant (conductor:<sid>) parses, names the same home and approves the pin; and the
// list file at that home, resolved, lists the pin. Any read that fails: not trusted. Names by c.laneLeadOf; at most 4. A filter, not proof (as the manager's).
const CONDUCTORS_SEEN_MAX = 4
async function conductorsTrusted($: any, live: RegRow[], except: string, pin: string | undefined): Promise<{ sid: string; name?: string }[]> {
  if (pin === undefined) return []
  return conductorsReaching($, live, except, (r) => r === pin)
}
// The same checks for the conductors whose approved list holds a repo that `match` accepts (PR 3: a request's folder is in a conductor's reach when a pin holds it,
// the same within-folder match a lead's pin gets), every one of them judged against the pins that matched.
async function conductorsReaching($: any, live: RegRow[], except: string, match: (repo: string) => boolean): Promise<{ sid: string; name?: string }[]> {
  const d = await presenceNames($)
  if (typeof d === 'string') return []
  const p = d.p
  const rows = live.map((r) => r.j)
  const now = await $.clock.now()
  const out: { sid: string; name?: string }[] = []
  for (const s of d.names) {
    if (s === except || out.length >= CONDUCTORS_SEEN_MAX) continue
    const f = await presenceCheck($, p, live, s, (x) => x.level === 'conductor' && x.repos.some(match))
    if (typeof f === 'string' || f.level !== 'conductor') continue
    const home = f.home
    if (c.pinRefusal(home, homeOf(p)) !== undefined || (await real($, home)) !== home || (await gitRoot($, home)) !== 'yes') continue
    const raw = await (async () => $.store.get(`${c.CONDUCTOR_HINT_PREFIX}${s}`))().catch(() => undefined)
    const h = c.parseConductorHint(raw, now, homeOf(p))
    if (!h || h.home !== home || !h.repos.some(match)) continue
    const lf = await readConductorFile($, home)
    if (lf.state !== 'ok') continue
    if (!(await resolveConductorList($, home, lf.entries)).ok.some(match)) continue
    const name = c.laneLeadOf(rows, s)?.name
    out.push({ sid: s, ...(name ? { name } : {}) })
  }
  return out
}
// v14 (2026-11-04, review c1, M2): whether a session holds a fresh presence file of any level (a lead, a conductor, the manager) that passes the checks, or
// whose check could not be made (fail closed). A manager's stop is never sent to such a session.
// Review c2 (SA-L1): a leads folder that is there but fails its checks, or whose list throws, counts as held; a missing folder does not.
async function presenceHeld($: any, live: RegRow[], sid: string): Promise<boolean> {
  const d = await presenceNames($)
  if (d === 'none') return false
  if (d === 'error') return true
  if (!d.names.includes(sid)) return false
  return (await presenceCheck($, d.p, live, sid, () => true)) !== 'no'
}
// v14 (2026-11-04, review c2, SA-L1): the fresh presence file names for a check that fails closed: 'none' when the callboard or leads folder is not there,
// 'error' when one is there but fails dirOk's rules, its stat could not be made, or the list throws.
async function presenceNames($: any): Promise<{ p: { uid: number; root: string }; names: string[] } | 'none' | 'error'> {
  const p = await where($)
  if (!p) return 'error'
  for (const dir of [p.root, `${p.root}/leads`]) {
    const f = await statR($, dir)
    if (f === 'absent') return 'none'
    if (f === 'error' || f.kind !== 'dir' || f.uid !== p.uid || f.mode !== 0o700) return 'error'
  }
  try {
    return { p, names: await freshPresence($, p, true) }
  } catch {
    return 'error'
  }
}

async function leadsDirOk($: any): Promise<{ uid: number; root: string } | undefined> {
  const p = await where($)
  return p && (await dirOk($, p.root, p.uid)) && (await dirOk($, `${p.root}/leads`, p.uid)) ? p : undefined
}

// Every live lead whose repo holds this folder. The list is cut to the fresh files before the cap, so a pile of old files cannot push a live one out of it.
// v14: cwd undefined, every live lead in any repo. Review c2 (CR3): with errs, the folder and its list fail closed (presenceNames), and errs is set when they,
// or a lead's check, could not be made.
async function leadsFor($: any, live: RegRow[], cwd: string | undefined, repo?: string, errs?: { error: boolean }, only?: (repo: string) => boolean): Promise<c.LeadFile[]> {
  const d = errs ? await presenceNames($) : await leadsDirOk($).then(async (p) => (p ? { p, names: await freshPresence($, p) } : ('none' as const)))
  if (d === 'error') errs!.error = true
  if (typeof d === 'string') return []
  const p = d.p
  const found: c.LeadFile[] = []
  for (const s of d.names) {
    const lf = await leadFileOk($, p, live, s, cwd, errs, only)
    if (lf && (repo === undefined || lf.repo === repo)) found.push(lf)
  }
  return found
}

// The live lead for this folder: the one there is, or with several (S2b) the one named pick. Several and no pick: the choices, their usable names (c.leadNameOf)
// sorted, and ambiguous-lead when none has one. A pick no live lead carries any more: changed.
async function findLead($: any, live: RegRow[], cwd: string, pick?: string): Promise<{ lead: c.LeadFile } | { no: string } | { choices: string[] }> {
  const found = await leadsFor($, live, cwd)
  const rows = live.map((r) => r.j)
  if (pick !== undefined) {
    const hit = found.find((x) => c.leadNameOf(rows, x.sid) === pick)
    return hit ? { lead: hit } : { no: 'changed' }
  }
  if (found.length <= 1) return found.length === 1 ? { lead: found[0] } : { no: 'no-lead' }
  const choices = found.flatMap((x) => c.leadNameOf(rows, x.sid) ?? []).sort()
  return choices.length > 0 ? { choices } : { no: 'ambiguous-lead' }
}

// S2b: a second lead in the repo of the pin needs a usable name, and so does every other lead there (c.secondLeadRefusal). An unreadable registry refuses.
async function secondLeadNo($: any, sid: string, pin: string): Promise<string | undefined> {
  const live = await registryEntries($)
  if (!live) return 'registry-unreadable'
  const others = (await leadsFor($, live, pin, pin)).filter((x) => x.sid !== sid)
  return c.secondLeadRefusal(live.map((r) => r.j), sid, others.map((x) => x.sid))
}

// ---- the lane's briefing (c.laneBriefing) ----
// Its facts per session, computed once where the binding is written (birth, attach, restore) and dropped at detach. Module memory: after a reload the
// prompt.compose hook falls back to the binding in the session's state, with the generic lead and report wording.
const laneBrief = new Map<string, c.LaneFacts>()
// The lane name the briefing note was last appended for, per session: one note per binding, dropped at detach.
const laneBriefed = new Map<string, string>()

// The facts of a binding just written, kept at once without a lead; then the lead. Only a lead with a valid presence file for the lane's own repo counts (never
// one of a parent repo, nor any lead of a lane with no repo): for a record naming its lead (S2), the live lead with that registry name and no other; else the
// attached record's lead while it holds one, else the one lead of that repo. It is named only as c.laneLeadOf allows. The lead is added only to the entry
// this call kept, so a detach meanwhile leaves nothing behind. A failure keeps the generic lead wording and is logged as lane-lead; c.laneBriefing checks
// every field again.
async function keepLaneFacts($: any, sid: string, l: c.Lane, attached: boolean, leadSid: string | undefined, reg: Reg = () => registryEntries($)) {
  const base: c.LaneFacts = { name: l.name, sid, folder: l.folder, report: c.reportPath(l), attached }
  laneBrief.set(sid, base)
  try {
    if (!l.repo) return
    const live = await reg()
    if (!live) return
    const leads = await leadsFor($, live, l.folder, l.repo)
    const rows = live.map((r) => r.j)
    const lead = l.leadName !== undefined ? leads.find((x) => c.leadNameOf(rows, x.sid) === l.leadName) : leadSid !== undefined ? leads.find((x) => x.sid === leadSid) : leads.length === 1 ? leads[0] : undefined
    const known = lead ? c.laneLeadOf(rows, lead.sid) : undefined
    if (known && laneBrief.get(sid) === base) laneBrief.set(sid, { ...base, lead: known })
  } catch {
    await log($, sid, 'error', 'lane-lead').catch(() => undefined)
  }
}

// The briefing as one user-role note, at attach and restore only: a born lane has had no request yet, so its first one (the start prompt) carries the section, and
// a note there could count as a turn and make lane_start refuse not-empty. As briefLead: the mark is set before the await, and a refused or failed append is logged
// as lane-briefing and changes nothing else.
async function briefLane($: any, sid: string) {
  const kept = laneBrief.get(sid)
  const note = kept && c.laneBriefingNote(kept)
  if (!kept || !note || laneBriefed.get(sid) === kept.name) return
  laneBriefed.set(sid, kept.name)
  try {
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
    if (r?.deny !== undefined) throw new Error('refused')
  } catch {
    if (laneBriefed.get(sid) === kept.name) laneBriefed.delete(sid)
    await log($, sid, 'error', 'lane-briefing').catch(() => undefined)
  }
}

// An attached lane works with whichever lead holds a valid grant for its repo (consent given under one lead carries to the next one the person allows there);
// the store is writable by any process of the user, so the presence file passes every check; the record's leadName (S2) can only narrow it, never stand in.
// The lead's repo must be the lane's own repo, not any repo that happens to hold the folder (a lead at a parent repo has no business with a nested one).
// A record naming its lead needs a live lead of that repo with that registry name (c.leadNameOf); a legacy record, any lead of the repo.
async function leadHere($: any, cwd: string, repo: string, leadName: string | undefined, reg: Reg = () => registryEntries($)): Promise<boolean> {
  const live = await reg()
  if (!live) return false
  const leads = await leadsFor($, live, cwd, repo)
  const rows = live.map((r) => r.j)
  return leadName === undefined ? leads.length > 0 : leads.some((x) => c.leadNameOf(rows, x.sid) === leadName)
}

// A lead's tick removes presence files nobody has written for ten minutes (a session that died without its end hook).
async function presencePrune($: any) {
  const p = await leadsDirOk($)
  if (!p) return
  const now = await $.clock.now()
  for (const f of (await $.fs.list(`${p.root}/leads`).catch(() => [])) as { name: string; mtimeMs?: number }[]) {
    if (f.name.endsWith('.json') && c.SID_RE.test(f.name.slice(0, -5)) && typeof f.mtimeMs === 'number' && now - f.mtimeMs > c.LEAD_PRUNE_MS) await run($, [RM, '-f', '--', `${p.root}/leads/${f.name}`])
  }
}

// ---- the lead's watch on its own lane list ----
// cur: the hash of the store file as last read; told: the hash the lead has been told about (or was dropped); seen: the hash at the lead's last lane tool call.
type Watch = { path: string; sig?: string; cur: string; told: string; seen: string }
const watch = new Map<string, Watch>()
const laneNotices = new Map<string, number[]>()
const cappedLogged = new Set<string>()

async function watchPoll($: any, sid: string) {
  const w = watch.get(sid)
  const p = await where($)
  if (!w || !p) return
  const f = await facts($, w.path)
  const sig = f ? `${f.ino}:${f.size}:${f.mtimeMs}` : 'none'
  if (sig === w.sig) return
  const cur = f ? await readStoreFile($, w.path, p.uid) : { state: 'absent', text: '' }
  w.sig = sig
  // Hashed without each lane's sid and parked (c.watchText): a lane's own sid write, a park or an unpark is not news to the lead.
  w.cur = await sha($, c.watchText(cur.state, cur.text))
}
// The first look at grant time is the baseline: no notice for what was already there.
async function watchInit($: any, sid: string) {
  const pin = pinOf(sid)
  const p = await where($)
  if (pin === undefined || !p) return
  const w: Watch = { path: await storePath($, await sha($, pin)), cur: '', told: '', seen: '' }
  watch.set(sid, w)
  await watchPoll($, sid)
  w.told = w.seen = w.cur
}
// The lead's own write is not news to it, unless something else changed before it.
async function watchOwn($: any, sid: string) {
  const w = watch.get(sid)
  if (!w) return
  const was = w.cur
  await watchPoll($, sid)
  if (was === w.told) w.told = w.cur
  if (was === w.seen) w.seen = w.cur
}
// A store write of the lead's own (lane_create, a retire or terminate that removes a lane) is in flight: the tick leaves the list alone until watchOwn has taken the new state as known.
const ownWriting = new Map<string, number>()
async function ownWrite<T>($: any, sid: string, fn: () => Promise<T>): Promise<T> {
  ownWriting.set(sid, (ownWriting.get(sid) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    await watchOwn($, sid).catch(() => undefined)
    const n = (ownWriting.get(sid) ?? 1) - 1
    if (n > 0) ownWriting.set(sid, n)
    else ownWriting.delete(sid)
  }
}
async function watchTick($: any, sid: string) {
  // Review c2 (N1): a check-in runs beside the tick; one that went out during this step's reads wins the moment.
  const submitsAt = submits
  if (ownWriting.has(sid)) return
  // After a compaction the resume text goes out from the tick: a notice must not take the idle moment before it.
  if (((await $.state.get(request)).value as Request | null | undefined)?.phase === 'compacted') return
  await watchPoll($, sid)
  const w = watch.get(sid)
  if (!w || w.cur === w.told) return
  const now = await $.clock.now()
  const times = laneNotices.get(sid) ?? []
  // A change over the hourly cap stays owed (told is not moved): it goes out on a later tick, once the hour has a free slot. It is logged once per
  // capped stretch, whatever else the tick logs, and the stretch ends when a notice goes out.
  if (!c.noticeAllowed(times, now, c.LANES_NOTICES_PER_HOUR)) {
    if (cappedLogged.has(sid)) return
    cappedLogged.add(sid)
    return log($, sid, 'notice-capped', 'lanes-changed')
  }
  if ((await idleCheck($, sid)) !== undefined) return
  if (submits !== submitsAt) return
  const before = w.told
  const seenBefore = w.seen
  // The notice is the telling: seen moves with told, so the lane_list the lead makes in answer carries no footer for the same change.
  w.told = w.seen = w.cur
  cappedLogged.delete(sid)
  laneNotices.set(sid, [...times.filter((t) => t <= now && now - t < c.HOUR_MS), now])
  // A notice that did not go out is still owed: told and seen go back (unless something moved them meanwhile).
  await submitOwn($, c.LANES_CHANGED_TEXT, false).catch(async () => {
    turnKind.delete(sid)
    if (w.told === w.cur) w.told = before
    if (w.seen === w.cur) w.seen = seenBefore
    await log($, sid, 'notice-failed')
  })
}
// Every lead tool call (it runs the tool's body through this) refreshes the presence file first and, once, tells the lead the lane list changed since its last lane tool call.
async function leadRun($: any, e: unknown, body: () => Promise<any>) {
  const sid = await $.session.id()
  await presenceTouch($, sid).catch(() => undefined)
  await watchPoll($, sid).catch(() => undefined)
  const w = watch.get(sid)
  // Only a call that is served to the main agent of a lead that is on tells it anything: a refused one (a subagent, tools off) leaves the news for later.
  const served = grants.has(sid) && (e as { agentId?: string }).agentId === undefined
  const moved = served && !!w && w.cur !== w.seen
  // What the lead is told by this call (or looks at in it) needs no notice of its own; a change that lands while the body runs is news again.
  if (served && w) w.seen = w.told = w.cur
  const out = await body()
  // v13.6 (review c1, S1): the lead acted on that lane itself (a served call that succeeded), so what the check-in saw of it starts over.
  if (served && typeof out?.result === 'string' && OBS_CLEAR_TOOLS.includes(String((e as { tool?: unknown }).tool))) laneObs.get(sid)?.delete(String((e as { lane?: unknown }).lane))
  if (!moved || !out) return out
  // v14.1: a lane_list box ends in a table, so the note goes after a blank line, never on a table row.
  return typeof out.result === 'string' ? { ...out, result: `${out.result}${out.result.startsWith('>') ? '\n\n' : ' '}${c.LANES_CHANGED_NOTE}` } : typeof out.deny === 'string' ? { ...out, deny: `${out.deny} ${c.LANES_CHANGED_NOTE}` } : out
}

// One registration at a time per session: a /callboard lead after a timed-out one waits for the same registration instead of starting a second.
const leadToolsInFlight = new Map<string, Promise<void>>()
function leadToolsOnce($: any, sid: string): Promise<void> {
  let p = leadToolsInFlight.get(sid)
  if (!p) {
    p = leadTools($, sid).finally(() => leadToolsInFlight.delete(sid))
    leadToolsInFlight.set(sid, p)
  }
  return p
}
async function leadTools($: any, sid: string) {
  if (leadDeclared.has(sid)) return
  const text = { type: 'string' }
  for (const verb of c.LEAD_VERBS) {
    await $.tool.register({
      name: `lane_${verb}`,
      description:
        verb === 'rename'
          ? 'Bind a brand-new session to a lane: writes a rename cue for the session with this id. sid: its session id. lane: the lane name. The session must be in the lane folder, empty and unnamed, and less than 2 minutes old.'
          : verb === 'compact'
            ? "Ask the lane's session to compact. If it asked for that with request_compact on-cue, it compacts now; otherwise the plugin nudges it to save its notes and compact itself at the end of its turn. lane: the lane name."
            : `Cue the lane's session to ${verb}. lane: the lane name. The session applies its own limits. A start only works within 2 minutes of the session opening.`,
      inputSchema: {
        type: 'object',
        properties: verb === 'rename' ? { sid: text, lane: text } : { lane: text },
        required: verb === 'rename' ? ['sid', 'lane'] : ['lane'],
      },
    })
  }
  for (const verb of c.STOP_VERBS) {
    await $.tool.register({
      name: `lane_${verb}`,
      description:
        verb === 'terminate'
          ? "Stop the lane's session with SIGTERM, whatever it is doing. The person is asked to confirm every time. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and report stay; a lane a session joined keeps its record while a session carries it; a second stop removes it once the session is gone). A lane with no live session is removed directly. lane: the lane name."
          : verb === 'park'
            ? "Park the lane's session: stop it and close its tab, but keep the conversation. lane_unpark reopens it later. The session must confirm first: idle for 30 seconds, an empty prompt box, no background agents or shells. No report is needed; the lane's record stays, the only stop that keeps it. The call itself waits up to 40 seconds for the idle time, so call it right after the lane's last turn; if it still refuses not-idle, wait the seconds it names and try once, never in a loop. Works for lanes you made and lanes a session joined. lane: the lane name."
            : "Stop the lane's session once it confirms it can end: idle, empty prompt box, no background agents or shells, and the last line of <repo>/.archive/<LANE>/REPORT.md reads `status: done <its session id>` in a file newer than its last prompt. Does nothing otherwise. The call itself waits up to 40 seconds for the idle time, so call it right after the lane's last turn; if it still refuses not-idle, wait the seconds it names and try once, never in a loop. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and signed report stay; a lane a session joined keeps its record while a session carries it; a second stop removes it once the session is gone). A lane with no live session is removed directly, with no signed report. Retire is final: the conversation cannot be reopened with lane_unpark. Use lane_park for a lane you may need again, the only stop that keeps the lane. lane: the lane name.",
      inputSchema: { type: 'object', properties: { lane: text }, required: ['lane'] },
    })
  }
  await $.tool.register({
    name: 'lane_create',
    description:
      "Create a lane in the repo this lead was allowed in: name and task (what the lane should do: plain text, 1 to 8000 characters, newlines allowed). The mod writes the task to <folder>/.archive/<name>/BRIEF.md, which the lane reads as its first instructions. folder is optional: an absolute path to an existing folder inside the repo; the repo root by default. model is optional: opus, sonnet, haiku or fable, sonnet by default; the lane switches to it when it starts. No sudo needed. At most 16 lanes per repo and 12 creates an hour. Then lane_open, lane_rename with the session id it returns, and lane_start.",
    inputSchema: { type: 'object', properties: { name: text, task: text, folder: text, model: { type: 'string', enum: [...c.LANE_MODELS] } }, required: ['name', 'task'] },
  })
  await $.tool.register({
    name: 'lane_open',
    description:
      'Open a new panel in the lane folder (VS Code only) and return its session id. Then call lane_rename with that id and the lane, and lane_start. lane: the lane name. Refused when a live session already carries the lane name. Refused for a parked lane: use lane_unpark.',
    inputSchema: { type: 'object', properties: { lane: text }, required: ['lane'] },
  })
  await $.tool.register({
    name: 'lane_unpark',
    description:
      "Reopen a lane's saved conversation in its VS Code window, with its full history. Use it for a parked lane, or one whose session was closed. Not for a retired lane: retire is final, so lane_open starts a new conversation for it. The session becomes the lane again by itself within a few seconds; then call lane_resume. lane: the lane name.",
    inputSchema: { type: 'object', properties: { lane: text }, required: ['lane'] },
  })
  await $.tool.register({
    name: 'lane_list',
    description: 'List the lanes of the repo this lead was allowed in, in one box per lead (the box header names the lead, whether it is live, and the repo folder name): each lane, its folder when it is outside the repo root, whether a live session carries its name or it is parked, and how many minutes it has waited on a prompt. Call it when told the lanes changed.',
    inputSchema: { type: 'object', properties: {} },
  })
  // ADR 0004 (prompt answering): the three tools of every tier.
  await promptToolsRegister($)
  leadDeclared.add(sid)
}

// The three prompt tools, declared for a lead, a conductor and the manager alike (the handlers are shared; what a tier may do with a request depends on its place in
// the chain, PLAN-PR3 §3). They answer only while the person has turned answering on.
async function promptToolsRegister($: any) {
  const text = { type: 'string' }
  await $.tool.register({
    name: 'prompt_list',
    description: "List the permission prompts in your reach that are waiting for an answer: each one's id, lane, tool, how long it has been open, where it stands for you (whether you are the top tier, whether your window has opened) and its input (data from the lane, in an untrusted frame), then the rubric to judge it by. Call it when told a lane has a prompt waiting. Shows nothing while prompt answering is off.",
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'prompt_answer',
    description: "Answer one waiting prompt in your reach: id (from prompt_list), decision (allow or deny) and why (one line, at most 200 characters, no data values). Your answer is yours, never the person's, and carries no approval for anything else. It lands once the prompt has been open 30 seconds; the person's click always wins. Allow only by the rubric; deny only if you are certain; a call you cannot follow whole (truncated, encoded, built at run time) is denied with the cleaner-command message, never allowed; otherwise prompt_escalate.",
    inputSchema: { type: 'object', properties: { id: text, decision: { type: 'string', enum: ['allow', 'deny'] }, why: text }, required: ['id', 'decision', 'why'] },
  })
  await $.tool.register({
    name: 'prompt_escalate',
    description: "Pass one waiting prompt up: id (from prompt_list) and why (one line, at most 200 characters). A tier that is not the top one passes it to the next tier. The top tier (the highest one live) puts it to the person instead: the result lists the steps (a Haiku summary, then one AskUserQuestion headed `Relay <short>`). Use it for anything you cannot judge from the rubric, at once.",
    inputSchema: { type: 'object', properties: { id: text, why: text }, required: ['id', 'why'] },
  })
}

// v14 (2026-11-04, review c1, 01:39): whether a trusted manager (managerTrusted) runs on the Mac, as a lead's tick last saw it, for the lead's on-cue
// section: read at most once a minute, so prompt.compose reads no file. A read that fails or throws counts as none.
// Review c2 (CR1): a due look runs under ACTION_TIMEOUT_MS (managerSeenStep); one that times out or throws serves no section (live false) and frees the busy
// mark, so the next minute reads again. managerSeenBusy holds the running look's own token, and an answer is kept only while its stamp is still the one
// stored: a look that timed out, or a drop meanwhile (leadDrop, session.end), leaves nothing behind.
// v15 S7: conductors, the names ('' for none) of the conductors trusted for the lead's pin, as the same look saw them.
const managerSeen = new Map<string, { at: number; live: boolean; conductors?: string[] }>()
const managerSeenBusy = new Map<string, object>()
const MANAGER_SEEN_EVERY_MS = 60_000
async function managerSeenTick($: any, sid: string, stamp: { at: number; live: boolean; conductors?: string[] }) {
  let live = false
  let conductors: string[] = []
  try {
    const rows = await registryEntries($)
    live = rows !== undefined && (await managerTrusted($, rows, sid))
    conductors = rows === undefined ? [] : (await conductorsTrusted($, rows, sid, pinOf(sid))).map((x) => x.name ?? '')
  } catch {
    await log($, sid, 'error', 'manager-seen').catch(() => undefined)
  }
  if (managerSeen.get(sid) === stamp) managerSeen.set(sid, { at: stamp.at, live, conductors })
}
async function managerSeenStep($: any, sid: string) {
  if (managerSeenBusy.has(sid)) return
  const now = await $.clock.now()
  const last = managerSeen.get(sid)
  if (managerSeenBusy.has(sid) || (last !== undefined && now >= last.at && now - last.at < MANAGER_SEEN_EVERY_MS)) return
  // v15 S7b: the conductors last seen stay served while the new look runs, as live does.
  const stamp = { at: now, live: last?.live ?? false, conductors: last?.conductors }
  managerSeen.set(sid, stamp)
  const token = {}
  managerSeenBusy.set(sid, token)
  const failed = async (reason: string) => {
    if (managerSeen.get(sid) === stamp) managerSeen.set(sid, { at: now, live: false })
    await log($, sid, 'error', reason).catch(() => undefined)
  }
  void withTimeout($, managerSeenTick($, sid, stamp), ACTION_TIMEOUT_MS)
    .then((r) => (r === 'timeout' ? failed('manager-seen-timeout') : undefined), () => failed('manager-seen'))
    .catch(() => undefined)
    .finally(() => {
      if (managerSeenBusy.get(sid) === token) managerSeenBusy.delete(sid)
    })
}

// v14 (2026-11-04): the manager's five tools, declared at its grant (six from v14.1 to v15.2: lane_remove, dropped in v15.3). The handlers are the lead's (leadBase refuses every other lane tool at manager level).
const managerDeclared = new Set<string>()
async function managerTools($: any, sid: string) {
  if (managerDeclared.has(sid)) return
  const lane = { type: 'object', properties: { lane: { type: 'string' } }, required: ['lane'] }
  const tools: [string, string, unknown][] = [
    ['lane_list', 'List every lane on this Mac, in one box per repo and lead (the box header names the lead, whether it is live, and the repo folder name): each lane, its folder when it is outside the repo root, whether a live session carries its name or it is parked, and how many minutes it has waited on a prompt.', { type: 'object', properties: {} }],
    ['lane_resume', "Cue a lane's session to resume from its own notes. The session applies its own limits. lane: the lane name.", lane],
    ['lane_compact', "Ask a lane's session to compact: at once if it asked for that with request_compact on-cue, otherwise the plugin nudges it to save its notes and compact itself. lane: the lane name, or the session name of a live lead; a lead compacts only when it asked with request_compact on-cue, and is never nudged.", lane],
    ['lane_terminate', "Stop a lane's session with SIGTERM, whatever it is doing. Every stop asks the person: they confirm in a dialog that names the lane, its repo, the session and the pid. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and report stay; a lane a session joined keeps its record while a session carries it; a second stop removes it once the session is gone). A lane with no live session is removed directly. lane: the lane name.", lane],
    ['lane_retire', "Stop a lane's session once it confirms it can end: idle, empty prompt box, no background agents or shells, and its report signed done. Every stop asks the person: they confirm in a dialog first, then the lane must confirm. The call itself waits up to 40 seconds for the idle time, so call it right after the lane's last turn; if it still refuses not-idle, wait the seconds it names and try once, never in a loop. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and signed report stay; a lane a session joined keeps its record while a session carries it; a second stop removes it once the session is gone). A lane with no live session is removed directly, with no signed report. Retire is final. lane: the lane name.", lane],
  ]
  for (const [name, description, inputSchema] of tools) await $.tool.register({ name, description, inputSchema })
  await promptToolsRegister($)
  managerDeclared.add(sid)
}

// Whether a binding's stored record hash (rec) is this record's. The hash of an attached record leaves its lead's name out; a session bound before that holds the
// older one, which includes it, and still counts, so a pull never makes a live attached lane refuse record-changed or fail to detach.
async function recMatch($: any, rec: string | undefined, l: c.Lane): Promise<boolean> {
  if (rec === undefined) return false
  if (c.recOk(rec, await sha($, c.recordText(l)))) return true
  return l.adopted === true && l.leadName !== undefined && c.recOk(rec, await sha($, c.recordTextLegacy(l)))
}

// v15.3 (2026-11-06): lane_remove is gone; lane_retire and lane_terminate delete the lane's record themselves. A lane is live when a registry row carries its
// name, or (audit L1) when its record names a session that has a live row under any name (renamed by hand, or opened and not yet renamed): name-in-use; a
// session holding a live presence file is target-is-lead. Used for a lane with no live session before anything is asked and again inside the store lock.
async function laneLive($: any, live: RegRow[], l: { name: string; sid?: string }): Promise<string | undefined> {
  const entries = live.flatMap((r) => (typeof r.j.sessionId === 'string' ? [regEntry(r)] : []))
  if (entries.some((x) => x.name === l.name)) return 'name-in-use'
  if (l.sid !== undefined && (await presenceHeld($, live, l.sid))) return 'target-is-lead'
  if (l.sid !== undefined && entries.some((x) => x.sessionId === l.sid)) return 'name-in-use'
  return undefined
}

// One lane's record out of its store, in one editStore write wrapped in ownWrite (so the repo's lead still gets its lanes-changed notice). A lane a session
// joined (adopted) is removed only with no live session carrying it (mode idle), never right after a stop signalled one. mode idle: the lane has no live session; the record must still be the one the question or the report check saw (same
// session id, same parked state), no live session may carry it now (checked again on the records as they are, inside the lock), and the grant must still hold.
// mode stopped: the session got its signal; the record must name that session or none (the dying session may still carry the lane name for a moment).
// No stored field is added. { ok } when the record is gone, otherwise the refusal code.
type RemoveMode = { kind: 'idle'; sid: string | undefined; parked: boolean; seen: c.Lane; held: () => boolean } | { kind: 'stopped'; victim: string }
async function removeRecord($: any, e: unknown, me: string, key: string, name: string, mode: RemoveMode): Promise<{ ok: true } | { no: string; why?: string }> {
  const w = await ownWrite($, me, () => editStore(
    $,
    key,
    async (cur) => {
      const parsed = cur.state === 'ok' ? c.parseStore(cur.text) : undefined
      if (!parsed) return { no: 'store-unreadable' }
      if (!parsed.ok) return { no: parsed.reason }
      const rec = parsed.store.lanes.find((l) => l.name === name)
      if (!rec) return { no: 'unknown-lane' }
      // A stop that just signalled a session keeps a joined record (the caller never asks for it); with no session carrying it, laneLive below is the guard.
      if (rec.adopted && mode.kind === 'stopped') return { no: 'adopted-record' }
      if (mode.kind === 'stopped') {
        if (rec.sid !== undefined && rec.sid !== mode.victim) return { no: 'changed' }
      } else {
        if (rec.sid !== mode.sid || (rec.parked !== undefined) !== mode.parked) return { no: 'changed' }
        // The record the question or the check saw: not one remade under the name, nor one a claim re-pointed at another lead meanwhile.
        if (rec.leadName !== mode.seen.leadName || (rec.adopted === true) !== (mode.seen.adopted === true) || rec.lead !== mode.seen.lead) return { no: 'changed' }
        const rows = await registryEntries($)
        if (!rows) return { no: 'registry-unreadable', why: c.reasonWhy('registry-unreadable') }
        const live = await laneLive($, rows, rec)
        if (live) return { no: live, why: c.reasonWhy(live) }
        // The last check before the write.
        if (!mode.held()) return { no: 'grant-changed', why: c.reasonWhy('grant-changed') }
      }
      const left = parsed.store.lanes.filter((l) => l.name !== name).map(c.storeLaneJson)
      return { text: JSON.stringify({ repo: parsed.store.repo, lanes: left, creates: parsed.store.creates.slice(-12) }), landed: (st) => !!st && !st.lanes.some((l) => l.name === name) }
    },
    async () => {
      if (mode.kind === 'stopped') return undefined
      const again = await leadPrep($, e, me)
      if ('err' in again) return { no: again.err[0], why: again.err[1] }
      return again.lane.src === key ? undefined : { no: 'changed', why: c.reasonWhy('changed') }
    },
  )).catch(() => ({ no: 'store-busy' }))
  return 'no' in w ? w : { ok: true }
}

// A retire or a force stop of a lane no live session carries (never opened, crashed, stale, parked, or a lane a session joined whose session has gone): nothing
// runs, so the record is removed directly, an attached one too (the person's Join made it; its session is the only other way to detach it). lane_retire needs no signed report here (nothing runs, so there is no session to sign) and, at
// manager reach, asks as for a live lane; lane_terminate always asks the person (the remove question). Checked before the question and again after the click.
async function stopNoSession($: any, e: unknown, sid: string, verb: 'retire' | 'terminate', level: string | undefined, prep: { lane: c.Lane }, no: (reason: string, why: string) => Promise<{ deny: string }>, abandoned: () => boolean) {
  const l = prep.lane
  if (l.src === undefined || l.repo === undefined) return no('no-live-session', c.reasonWhy('no-live-session'))
  const epoch = epochOf(sid)
  const held = () => grantOf(sid)?.level === level && epochOf(sid) === epoch
  const live = await registryEntries($)
  if (!live) return no('registry-unreadable', c.reasonWhy('registry-unreadable'))
  const refused = await laneLive($, live, l)
  if (refused) return no(refused, c.reasonWhy(refused))
  // The same question for both verbs (review): the repo by its path, that the lane has no live session, and the parked sentence. A retire at lead level asks only
  // for a parked lane, whose record holds the only callboard pointer to its saved conversation.
  if (verb === 'terminate' || level === 'manager' || l.parked !== undefined) {
    const p = await where($)
    const r = await askOnce($, sid, c.removeQuestion(l.name, l.repo, l.parked !== undefined, p ? homeOf(p) : undefined), c.REMOVE_YES, c.REMOVE_NO, c.HEADER.stop)
    if (r === 'busy') return no('busy', c.reasonWhy('busy'))
    if (r === 'timed-out') return { deny: leadReason(verb, `${await timedOut($, sid)}.`) }
    if (r !== 'yes') return no('not-confirmed', 'the person did not confirm. Nothing was removed.')
  }
  if (!held()) return no('grant-changed', c.reasonWhy('grant-changed'))
  // v15.4: a call the engine abandoned (its answer went out already) removes nothing.
  if (abandoned()) return { deny: leadReason(verb, c.reasonWhy('abandoned')) }
  const w = await removeRecord($, e, sid, l.src, l.name, { kind: 'idle', sid: l.sid, parked: l.parked !== undefined, seen: l, held })
  if ('no' in w) return no(w.no, w.why ?? c.reasonWhy(w.no))
  await log($, sid, 'lane-removed', l.name)
  return { result: c.removedNoSessionText(verb, l.name) } as never
}

// lane_park's two store writes (the record names the session before the signal; the mark after it): the record of that name, changed only when `ok` holds for it.
// The pre re-runs leadPrep and checks only that the lane still comes from this store, as the removal of a record does; never its name-in-use check, since the stopped
// session may still carry the name for a moment after the signal. undefined: written (or already so); otherwise the refusal code.
async function parkWrite($: any, e: unknown, me: string, key: string, name: string, change: (l: c.Store['lanes'][number]) => c.Store['lanes'][number], ok: (l: c.Store['lanes'][number]) => boolean): Promise<string | undefined> {
  const r = await ownWrite($, me, () => editStore($, key, async (cur) => {
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    const rec = parsed.store.lanes.find((l) => l.name === name)
    if (!rec) return { no: 'unknown-lane' }
    if (!ok(rec)) return { no: 'changed' }
    const next = change(rec)
    const t = c.storeText({ ...parsed.store, lanes: parsed.store.lanes.map((l) => (l === rec ? next : l)) })
    if ('no' in t) return t
    return { text: t.text, landed: (s) => !!s?.lanes.some((l) => l.name === name && l.sid === next.sid && l.parked === next.parked) }
  }, async () => {
    const again = await leadPrep($, e, me)
    if ('err' in again) return { no: again.err[0] }
    return again.lane.src === key ? undefined : { no: 'changed' }
  })).catch(() => ({ no: 'store-busy' }))
  return 'no' in r ? r.no : undefined
}

// After a retire or a force stop whose signal went out: the record of that name stops naming the stopped session (and is no longer parked). A failure is logged only.
async function sidClearAfterStop($: any, me: string, key: string, name: string, victim: string) {
  const r = await ownWrite($, me, () => editStore($, key, async (cur) => {
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    if (!parsed.store.lanes.some((l) => l.name === name && l.sid === victim)) return { skip: true }
    const t = c.storeText({ ...parsed.store, lanes: parsed.store.lanes.map((l) => (l.name === name && l.sid === victim ? { ...l, sid: undefined, parked: undefined } : l)) })
    if ('no' in t) return t
    return { text: t.text, landed: (s) => !!s && !s.lanes.some((l) => l.name === name && l.sid === victim) }
  })).catch(() => ({ no: 'throw' }))
  if ('no' in r) await log($, me, 'sid-uncleared', r.no)
  else if (r.text !== '') await log($, me, 'sid-cleared', name)
}

// Same steps as callboard-send.mjs: a 0600 temp file in a 0700 folder under the callboard root, then one rename into place.
// It returns the temp file's inode, which the rename keeps: the target can claim a cue within the same tick, so a stat after the write may find nothing.
async function writeIn($: any, folder: string, file: string, text: string): Promise<{ err: string } | { ino: number }> {
  const p = await where($)
  if (!p) return { err: 'no-paths' }
  const dir = `${p.root}/${folder}`
  await run($, [MKDIR, '-p', '-m', '700', p.root, dir])
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return { err: 'unsafe-dir' }
  const tmp = `${dir}/.${file}.${await $.clock.now()}.${++seq}.tmp`
  await run($, [INSTALL, '-m', '600', '/dev/null', tmp])
  const f = await facts($, tmp)
  if (!f || f.kind !== 'file' || f.uid !== p.uid || f.mode !== 0o600 || f.nlink !== 1) {
    await run($, [RM, '-f', '--', tmp])
    return { err: 'tmp-unsafe' }
  }
  const w = await run($, [TEE, '--', tmp], text)
  const m = w.exitCode === 0 ? await run($, [MV, '-f', '--', tmp, `${dir}/${file}`]) : w
  if (m.exitCode !== 0) {
    await run($, [RM, '-f', '--', tmp])
    return { err: 'write-failed' }
  }
  return { ino: f.ino }
}

const writeCue = ($: any, sid: string, text: string) => writeIn($, 'cue', `${sid}.cue`, text)

// The lane brief lane_create writes: <folder>/.archive/<NAME>/BRIEF.md, in the repo, so writeIn's private 0700 folder does not fit. .archive and
// .archive/<NAME> must each be a real folder of the user's (not a link) that is its own real path, before and after mkdir -p. The text goes to a 0600
// temp file in .archive/<NAME>, then one rename into place. A BRIEF.md already there (a removed lane of the same name left it) is replaced only when it
// is a plain file of the user's with one link whose first line is the mod's own header (`head`; only that many bytes are read). undefined: written;
// otherwise the refusal code.
async function writeBrief($: any, uid: number, brief: string, head: string, text: string): Promise<string | undefined> {
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
  const tmp = `${dir}/.BRIEF.md.${await $.clock.now()}.${++seq}.tmp`
  await run($, [INSTALL, '-m', '600', '/dev/null', tmp])
  const f = await facts($, tmp)
  if (!f || f.kind !== 'file' || f.uid !== uid || f.mode !== 0o600 || f.nlink !== 1) {
    await run($, [RM, '-f', '--', tmp])
    return 'brief-write'
  }
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
async function readAnswer($: any, path: string, uid: number, timeoutMs = 5000): Promise<{ state: 'absent' | 'bad' } | { state: 'ok'; text: string }> {
  const f = await facts($, path)
  if (!f) return { state: 'absent' }
  if (f.kind !== 'file' || f.uid !== uid || f.mode !== 0o600 || f.nlink !== 1 || f.size > c.RESULT_MAX) {
    await run($, [RM, '-f', '--', path])
    return { state: 'bad' }
  }
  const r = await $.process.run([HEAD, '-c', String(c.RESULT_MAX + 1), '--', path], { timeoutMs })
  const after = await facts($, path)
  // Changed during the read, or a read that failed or ran out of time: left for the next poll.
  if (!after || !c.sameFile(f, after) || r.exitCode !== 0) return { state: 'absent' }
  if (r.stdout.length > c.RESULT_MAX) {
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

// Lead cue calls to one target go one at a time inside this process (a lead can issue parallel tool calls); they share one answer file.
const cueInFlight = new Map<string, number>()

// The lead's result folder must be a private folder of the user before it removes or reads anything in it.
async function resultDirOk($: any, p: { uid: number; root: string }, folder: string): Promise<boolean> {
  await run($, [MKDIR, '-p', '-m', '700', p.root, `${p.root}/${folder}`])
  return (await dirOk($, p.root, p.uid)) && (await dirOk($, `${p.root}/${folder}`, p.uid))
}

// One cue to one target and the wait for its answer (lane_start, lane_retire and the other cue tools): the per-target lock, the answer file and
// the one deadline counted from the tool call. undefined: the target answered ok; otherwise the deny to return.
async function cueExchange($: any, sid: string, laneName: string, toSid: string, verb: c.Verb, deadline: number, no: (reason: string, why: string) => Promise<{ deny: string }>, retire = false): Promise<{ deny: string } | undefined> {
  const text = c.cueLine(verb, laneName, verb === 'rename' ? sid : undefined)
  if (!text) return no('grammar', 'bad cue.')
  // v14: any grant (a lead's or the manager's); each tool has checked its own reach.
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
    if (r.outcome !== 'ok') return no(`${r.outcome}-${r.reason}`, c.cueRefusalText(verb, r.outcome, r.reason))
    await log($, sid, 'acted', `${verb} ${laneName}`)
    return undefined
  } finally {
    if (got) got()
    else void locked.then((r) => r())
    const n = (cueInFlight.get(key) ?? 1) - 1
    if (n > 0) cueInFlight.set(key, n)
    else cueInFlight.delete(key)
  }
}

type Answer = (outcome: c.Outcome, reason?: string) => Promise<void>
const noAnswer: Answer = async () => undefined
// What this session last answered per cue file, so a cue left in place (refused before the move) is not answered every tick.
const lastAnswer = new Map<string, string>()

// The target's answer to one claimed cue, written at most once, into <root>/result/<own sid>.result.
function answerer($: any, sid: string, verb: c.Verb | '-', ino: number): Answer {
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
async function pruneResults($: any) {
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
async function pruneLogs($: any, me: string) {
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

// Start time of a process as `ps` prints it in UTC, the way the session registry records `procStart`.
async function psStart($: any, pid: unknown): Promise<string | undefined> {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return undefined
  const r = await $.process.run([PS, '-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5000, env: { TZ: 'UTC', LC_ALL: 'C' } })
  return r.exitCode === 0 ? r.stdout : undefined
}

async function psArgs($: any, pid: unknown): Promise<string | undefined> {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return undefined
  const r = await $.process.run([PS, '-o', 'args=', '-p', String(pid)], { timeoutMs: 5000, env: { LC_ALL: 'C' } })
  return r.exitCode === 0 ? r.stdout : undefined
}

// The lane's report: a plain file of the user's, one link, at most REPORT_MAX. One stat, bounded; gone: stat said there is no file at that
// path. Any other stat failure is not gone, so a turn mark records the size as unknown (null) rather than no file (-1).
async function reportStat($: any, l: c.Lane): Promise<{ no: string; gone?: true } | { path: string; f: NonNullable<Awaited<ReturnType<typeof facts>>> }> {
  const path = c.reportPath(l)
  const p = await where($)
  if (!path || !p) return { no: 'report-missing' }
  const r = await $.process.run([STAT, '-f', STAT_FMT, '--', path], { timeoutMs: 5000, env: { LC_ALL: 'C' } })
  if (r.exitCode !== 0) return /No such file or directory/.test(r.stderr) ? { no: 'report-missing', gone: true } : { no: 'report-missing' }
  const f = c.parseStat(r.stdout)
  if (!f) return { no: 'report-missing' }
  if (f.kind !== 'file' || f.nlink !== 1 || f.uid !== p.uid || f.size > c.REPORT_MAX) return { no: 'report-file' }
  return { path, f }
}

// Inside the lane repo, and read with a bound.
async function readReport($: any, l: c.Lane): Promise<{ no: string } | { text: string; mtimeMs: number; size: number }> {
  const st = await reportStat($, l)
  if ('no' in st) return { no: st.no }
  const real = (await run($, [REALPATH, '--', st.path])).stdout.trim()
  const realRepo = (await run($, [REALPATH, '--', l.repo!])).stdout.trim()
  if (!real || !realRepo || !c.within(realRepo, real)) return { no: 'report-path' }
  // The file may grow after the stat above: read at most one byte past the limit and refuse anything longer.
  const r = await run($, [HEAD, '-c', String(c.REPORT_MAX + 1), '--', st.path])
  if (r.exitCode !== 0 || r.stdout.length > c.REPORT_MAX) return { no: 'report-file' }
  return { text: r.stdout, mtimeMs: st.f.mtimeMs, size: st.f.size }
}

async function reportCheck($: any, l: c.Lane, target: c.RegEntry): Promise<string | undefined> {
  const r = await readReport($, l)
  return 'no' in r ? r.no : c.reportRefusal(r.text, target.sessionId, r.mtimeMs, target.startedAt)
}

// The target's side of a retire: the same report, signed with its own id, newer than the last turn and grown since then.
async function retireReportCheck($: any, sid: string, l: c.Lane): Promise<string | undefined> {
  // A failed write of the turn mark leaves the old one, which would pass: until a write succeeds the signature cannot be shown to be last.
  if (lastTurnUnknown.has(sid)) return 'report-unknown'
  const r = await readReport($, l)
  return 'no' in r ? r.no : c.retireRefusal(r.text, sid, r.mtimeMs, r.size, (await $.state.get(lastTurn)).value)
}

// The lane record of this session's binding, for the report path. Looked up once per binding (the cache is keyed by the binding's record hash).
const boundLane = new Map<string, { name: string; rec: string; l: c.Lane }>()
async function reportLaneOf($: any, sid: string): Promise<c.Lane | undefined> {
  const b = (await $.state.get(lane)).value as { name: string; rec?: string } | null | undefined
  if (!b) return undefined
  const hit = boundLane.get(sid)
  if (hit && hit.name === b.name && hit.rec === (b.rec ?? '')) return hit.l
  const lanes = await loadLanes($)
  const l = typeof lanes === 'string' ? undefined : lanes.find((x) => x.name === b.name)
  if (l) boundLane.set(sid, { name: b.name, rec: b.rec ?? '', l })
  return l
}

// The turn mark: when the main agent's turn began and how big the lane's report was. Written at prompt.submit (any origin) and at turn.start of the
// main agent (wakes and queued messages never pass prompt.submit). An unbound session has no report: size null. One stat, only when bound.
const lastTurnUnknown = new Set<string>()
async function markTurn($: any, sid: string) {
  try {
    const at = await $.clock.now()
    let size: number | null = null
    try {
      const l = await reportLaneOf($, sid)
      if (l) {
        const st = await reportStat($, l)
        size = 'no' in st ? (st.gone ? -1 : null) : st.f.size
      }
    } catch {}
    const w = await $.state.set(lastTurn, { at, size })
    if (w?.isSet === false) throw new Error('not-set')
    lastTurnUnknown.delete(sid)
  } catch {
    lastTurnUnknown.add(sid)
    await log($, sid, 'error', 'last-turn').catch(() => undefined)
  }
}

const busyAgents = async ($: any): Promise<boolean> => (await $.agent.list()).some((a: { status: string }) => BUSY_AGENT.includes(a.status))

// Background shells under this session's own claude process. Its pid comes from the registry: exactly one entry carries the session id, the file name is its
// pid and `ps` agrees with its procStart. Anything else, or a table that cannot be read or trusted, fails closed.
async function backgroundShells($: any, sid: string, reg: Reg): Promise<'background-work' | 'background-unknown' | undefined> {
  const mine = ((await reg()) ?? []).filter((r) => r.j.sessionId === sid)
  if (mine.length !== 1) return 'background-unknown'
  const me = regEntry(mine[0])
  if (!Number.isInteger(me.pid) || (me.pid as number) < 2 || c.pidRefusal(me, await psStart($, me.pid)) !== undefined) return 'background-unknown'
  const ps = (argv: string[]) => $.process.run([PS, ...argv], { timeoutMs: 5000, env: { LC_ALL: 'C' } }).catch(() => undefined)
  const pids = await ps(['-A', '-o', 'pid=,ppid=,comm='])
  if (!pids || pids.exitCode !== 0 || typeof pids.stdout !== 'string' || pids.stdout.length > c.PS_TABLE_MAX) return 'background-unknown'
  const kids = c.childPids(pids.stdout, me.pid as number)
  if (kids === undefined || kids.length > c.PS_CHILDREN_MAX) return 'background-unknown'
  if (kids.length === 0) return undefined
  const rows = await ps(['-o', 'pid=,ppid=,command=', '-p', kids.join(',')])
  if (!rows || rows.exitCode !== 0 || typeof rows.stdout !== 'string' || rows.stdout.length > c.PS_TABLE_MAX) return 'background-unknown'
  const n = c.shellChildren(rows.stdout, me.pid as number)
  return n === undefined ? 'background-unknown' : n > 0 ? 'background-work' : undefined
}

// The compaction nudge. Hooks only record it (nudgeDue in the session state, so it survives a reload); the tick sends it once the session is idle.
// A person's session: session.start said isInteractive, or the session has its own row in the session registry. A VS Code panel may report
// isInteractive false (the engine sets it only under the REPL); a -p run or the SDK writes no row, so it stays out. Both are live checks.
async function interactive($: any, sid: string): Promise<boolean> {
  if ((await $.state.get(interactiveRef)).value === true) return true
  const row = await registryOf($, sid, ownReg($))
  if (row === undefined) return false
  // v13.3 (security audit c1): in a config folder other than ~/.claude the row must be a person's (kind interactive): a bg or kind-less row there is not a person's
  // session for the restores, the rebind or the self request. Under ~/.claude any row still counts, as before.
  const p = await where($)
  return p?.own === p?.sessions || row.kind === 'interactive'
}

// v13.2 (security audit c1): a person's own registry row, as the engine writes it for a VS Code panel or a terminal (kind interactive). A `claude --bg` background
// worker has a row too (kind background), so interactive() passes it; this does not. A row with no kind, two rows, or no row fail.
// v13.3: the default registry is the own one (CLAUDE_CONFIG_DIR); a caller that works from a cue passes the plain one.
async function personRow($: any, sid: string, reg: Reg = ownReg($)): Promise<boolean> {
  return (await registryOf($, sid, reg))?.kind === 'interactive'
}

// Whether this session may be nudged at all: a person's session with its own interactive registry row (v13.2: no longer isInteractive alone, so a worker is
// never nudged). One that is not bound or on gets the nudge grant for its own `now` request. interactive() still gates the self request and the restores.
const mayNudge = ($: any, sid: string): Promise<boolean> => personRow($, sid)

// Written only if nudgeDue is unchanged since the read: a lead nudge recorded meanwhile (by the tick, while this hook awaited) is never replaced. ping: the
// keepalive step recorded it in place of a ping (v13.2), so a drop is logged as a missed ping.
async function recordNudge($: any, sid: string, kind: c.NudgeDue['kind'], now: number, ifVersion: number, ping = false, again = false) {
  if ((await $.state.set(nudgeDueRef, { kind, at: now, ...(ping ? { ping: true } : {}), ...(again ? { again: true } : {}) }, { ifVersion })).isSet === false) {
    await log($, sid, 'nudge-skipped', 'changed')
    return false
  }
  await log($, sid, 'nudge-due', again ? `${kind} again` : kind)
  return true
}

// v13.2: the settings of /callboard config, machine-wide in $.store. Read at session start and then at most once a minute (the tick and the nudge hooks
// call this), so a change made in one session reaches the others within a minute. A read that fails or times out keeps the last good value (the
// defaults before any); a field that fell back is logged once per load of the mod.
let cfg: c.Config = { ...c.CONFIG_DEFAULTS }
let cfgReadAt: number | undefined
const cfgInvalidLogged = new Set<string>()
async function cfgGet($: any, sid: string, force = false): Promise<c.Config> {
  const now = await $.clock.now()
  if (!force && cfgReadAt !== undefined && now >= cfgReadAt && now - cfgReadAt < c.CONFIG_READ_MS) return cfg
  cfgReadAt = now
  try {
    const raw = await withTimeout($, (async () => $.store.get(c.CONFIG_KEY))(), c.ENGINE_CALL_TIMEOUT_MS)
    if (raw === 'timeout') throw new Error('timeout')
    const parsed = c.parseConfig(raw)
    cfg = parsed.cfg
    for (const f of parsed.invalid) {
      if (cfgInvalidLogged.has(f)) continue
      cfgInvalidLogged.add(f)
      await log($, sid, 'config-invalid', f).catch(() => undefined)
    }
  } catch {
    await log($, sid, 'error', 'config-read').catch(() => undefined)
  }
  return cfg
}

// v15.1 (2026-11-05): this machine's reserved names (c.RESERVE_KEY), read as the settings are: fresh at each start and, review c1, fresh again on each
// path that judges a new name or the manager's (lane_create, /callboard lane, /callboard lead, /callboard manager); else at most once a minute from the tick. A read that fails or times out keeps the last good list. The list lands in core (c.setLocalReserved), where
// reservedHit and isManagerName read it.
// Review c1: the read time moves only on a good read, so a failed one is tried again from the next tick; reservedGen drops a read that a /callboard reserve
// write overtook (that write set the list itself).
let reservedReadAt: number | undefined
let reservedGen = 0
async function reservedGet($: any, sid: string, force = false): Promise<readonly string[]> {
  const now = await $.clock.now()
  if (!force && reservedReadAt !== undefined && now >= reservedReadAt && now - reservedReadAt < c.CONFIG_READ_MS) return c.localReservedNames()
  const gen = reservedGen
  try {
    const raw = await withTimeout($, (async () => $.store.get(c.RESERVE_KEY))(), c.ENGINE_CALL_TIMEOUT_MS)
    if (raw === 'timeout') throw new Error('timeout')
    if (gen === reservedGen) {
      c.setLocalReserved(c.parseReserved(raw))
      reservedReadAt = now
    }
  } catch {
    await log($, sid, 'error', 'reserve-read').catch(() => undefined)
  }
  return c.localReservedNames()
}

// A bound lane whose report is signed and current. Not a lane: false.
async function laneSignedDone($: any, sid: string): Promise<boolean> {
  if ((await $.state.get(lane)).value == null) return false
  const l = await reportLaneOf($, sid)
  return !!l && (await retireReportCheck($, sid, l)) === undefined
}

// The session's state, judged by the tick (process and report reads, too slow for a hook): a bound lane signed done (its report signed and
// current) is not nudged by its own level; working is a bound lane not signed done since its last prompt, or a background agent or shell still
// running. A check that cannot tell counts as working. v16: the state no longer changes which level nudges (the size alone does); the cache nudge
// still goes only to an idle one.
async function thresholdState($: any, sid: string): Promise<'done' | 'working' | 'idle'> {
  if ((await $.state.get(lane)).value != null) return (await laneSignedDone($, sid)) ? 'done' : 'working'
  if (await busyAgents($)) return 'working'
  if ((await backgroundShells($, sid, ownRegOnce($))) !== undefined) return 'working'
  return 'idle'
}

// The self-threshold, at the end of a main-agent answer of a person's (interactive) session: past the idle level, one `threshold` nudge is recorded.
// The hook reads only the tokens and the cheap state; the tick picks the kind from the size and skips a lane signed done.
async function thresholdNudge($: any, sid: string) {
  if ((await $.state.get(request)).value) return
  const dueRead = await $.state.get(nudgeDueRef)
  if (dueRead.value) return
  const now = await $.clock.now()
  const ct = await counts($)
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const lv = await cfgGet($, sid)
  // v14 (2026-11-04): at or past the working level a soft nudge inside the gap may be followed by one hard one.
  if (!c.nudgeAllowed(ct, now, tokens >= lv.workingK * 1000)) return
  // v16 (2026-11-08): every session, a lead too, is nudged from the idle level on.
  if (tokens < lv.idleK * 1000 || c.compactAllowed(ct, tokens, now)) return
  // After the level, so a turn below it reads no registry.
  if (!(await mayNudge($, sid))) return
  await recordNudge($, sid, 'threshold', now, dueRead.version)
}

// The tick's step: a recorded nudge is dropped once stale (10 minutes), once the session has a request of its own, or once it may not compact;
// it waits only while the session is not idle (v16: a busy session's nudge may instead be taken by the PostToolUse hook, midTurnNudge). A `threshold` nudge then gets
// its kind from the size alone (thresholdKind): none for a lane signed done; below the idle level it is dropped. It is cleared and stamped, and the grant (nudgedAt) set, before the submit (as the compaction
// resume is), so a submit slower than the timeout still goes out once and is never retried; only a submit that threw takes the grant back.
async function nudgeTick($: any, sid: string) {
  const read = await $.state.get(nudgeDueRef)
  const due = read.value as c.NudgeDue | null | undefined
  if (due == null) return
  const now = await $.clock.now()
  const drop = async (why: string) => {
    await $.state.set(nudgeDueRef, null)
    await log($, sid, 'nudge-dropped', why)
    // v13.2: a nudge the keepalive step recorded in place of a ping: that gap gets no ping either.
    if (due.ping === true) await log($, sid, 'keepalive-skipped', 'nudge-dropped')
  }
  if (!c.nudgeDueFresh(due, now)) return drop('expired')
  if ((await $.state.get(request)).value) return drop('request')
  if (!(await mayNudge($, sid))) return drop('not-interactive')
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const no = c.compactAllowed(await counts($), tokens, now)
  if (no) return drop(no)
  if ((await idleCheck($, sid, ownReg($))) !== undefined) return
  let kind: c.NudgeKind | undefined = due.kind === 'threshold' ? undefined : due.kind
  if (due.kind === 'threshold') {
    if (await laneSignedDone($, sid)) return drop('lane-done')
    kind = c.thresholdKind(tokens, await cfgGet($, sid))
    if (!kind) return drop('below-level')
  }
  // v14: the kind follows the size now; one that fell back to the soft text (a compaction meanwhile) keeps the gap. Every kind is checked here, not only a threshold one
  // (review, 2026-11-08): a lead's or cache nudge recorded while a mid-turn nudge was being claimed would otherwise go out after it, inside the gap.
  if (!c.nudgeAllowed(await counts($), now, kind === 'working', due.again === true)) return drop('nudge-limit')
  if ((await $.state.set(nudgeDueRef, null, { ifVersion: read.version })).isSet === false) return
  await bump($, (ct) => ({ ...ct, lastNudgeMs: now, lastNudgeKind: kind!, nudgeTimes: [...(ct.nudgeTimes ?? []).filter((t) => t <= now && now - t < c.HOUR_MS), now] }))
  await $.state.set(nudgedAtRef, now)
  const sent = await withTimeout($, submitOwn($, c.nudgeText(kind!, await cfgGet($, sid)), false).then(() => 'ok' as const, () => 'failed' as const), ACTION_TIMEOUT_MS)
  if (sent === 'failed') await $.state.set(nudgedAtRef, null)
  if (sent === 'failed') turnKind.delete(sid)
  await log($, sid, sent === 'ok' ? 'nudged' : sent === 'timeout' ? 'nudge-unconfirmed' : 'nudge-failed', kind!)
}

// v16 (2026-11-08): the nudge in the middle of a turn. A session that crosses a level inside a long turn would otherwise learn of it only when the turn ends
// (thresholdNudge) and the tick submits it, and a lane keeps working past 400k meanwhile. After a main-agent tool call (PostToolUse, or its failure) the hook
// below returns the nudge text as additionalContext, which the model reads with the tool's result, before its next step. Same limits as the tick's nudge:
// no request of the session's own, a person's interactive session, not a lane signed done, nudgeAllowed (30-minute gap, one hard after a soft, 3 an hour),
// compactAllowed. A recorded `threshold` nudge is taken over (cleared by version, so the tick's submit and this hook cannot both send it); a lead or cache one is
// left to the tick. The check order is cheap first: the token count, then state reads; a session that may not be nudged is not looked at again for a minute.
// The idle submit stays as the fallback for a turn that ends without a tool call after the level.
const midTurnBusy = new Set<string>()
// The sessions whose turn carried a mid-turn nudge, until that turn ends (midTurnFallback).
const midDelivered = new Set<string>()
const midTurnSkip = new Map<string, number>()
const MID_TURN_SKIP_MS = 60_000
// No timer here: a hook has 10 s of its own time and a $.clock.sleep counts against it (see pause), while the $ calls below do not. The claim is the last step before the
// text is returned, so a throw before it consumes nothing; one after it (the log) is caught and cannot cost the nudge.
async function midTurnNudge($: any, e: any): Promise<string | undefined> {
  if (typeof e?.agent_id === 'string' && e.agent_id !== '') return undefined
  const sid = await $.session.id()
  if (typeof sid !== 'string' || !c.SID_RE.test(sid) || midTurnBusy.has(sid)) return undefined
  midTurnBusy.add(sid)
  try {
    const now = await $.clock.now()
    if ((midTurnSkip.get(sid) ?? 0) > now) return undefined
    const lv = await cfgGet($, sid)
    const tokens = (await $.session.usage()).context.tokens ?? 0
    // The cheap gate: most tool calls end here.
    const kind = c.thresholdKind(tokens, lv)
    if (!kind) return undefined
    if ((await $.state.get(request)).value) return undefined
    const read = await $.state.get(nudgeDueRef)
    const due = read.value as c.NudgeDue | null | undefined
    if (due != null && due.kind !== 'threshold') return undefined
    const ct = await counts($)
    if (!c.nudgeAllowed(ct, now, kind === 'working') || c.compactAllowed(ct, tokens, now)) return undefined
    if (!(await mayNudge($, sid)) || (await laneSignedDone($, sid))) {
      midTurnSkip.set(sid, now + MID_TURN_SKIP_MS)
      return undefined
    }
    const text = c.nudgeText(kind, lv)
    // Cleared by version when a nudge was recorded; else the claim is the stamp below, and midTurnBusy keeps a second hook of the same batch out.
    if (due != null && (await $.state.set(nudgeDueRef, null, { ifVersion: read.version })).isSet === false) return undefined
    await bump($, (x) => ({ ...x, lastNudgeMs: now, lastNudgeKind: kind, nudgeTimes: [...(x.nudgeTimes ?? []).filter((t) => t <= now && now - t < c.HOUR_MS), now] }))
    await $.state.set(nudgedAtRef, now)
    midDelivered.add(sid)
    await log($, sid, 'nudged', `${kind} mid-turn`).catch(() => undefined)
    return text
  } catch {
    await log($, sid, 'error', 'mid-turn-nudge').catch(() => undefined)
    return undefined
  } finally {
    midTurnBusy.delete(sid)
  }
}

// The fallback of a mid-turn nudge (2026-11-08). The engine may not surface the context, or the model may read it and not act: when the turn that carried it ends
// with no request of the session's own (no request_compact), one `threshold` nudge is recorded with `again`, which skips the 30-minute gap, and the tick sends it as
// the idle turn like any nudge. Once only: that resend is not a mid-turn one, so it records nothing further; a request, a compaction (the compaction gap, or a size back
// under the idle level), a lane signed done or a pending nudge of another kind send nothing (the tick's own checks).
async function midTurnFallback($: any, sid: string) {
  if ((await $.state.get(request)).value) return
  const read = await $.state.get(nudgeDueRef)
  if (read.value) return
  await recordNudge($, sid, 'threshold', await $.clock.now(), read.version, false, true)
}

// The PostToolUse and PostToolUseFailure hook: the prompt answering's done mark (doneHook), then the mid-turn nudge and the lead's mid-turn prompt notice added to the result's additionalContext.
async function postToolHook($: any, e: any, next: any): Promise<any> {
  await promptDone($, e).catch(() => undefined)
  const r = await next(e)
  // Two texts, never one merged: the nudge, then the notice. Each path claims its own before it returns the text.
  const texts = [await midTurnNudge($, e), await promptMidTurnNotice($, e).catch(() => undefined), await promptRelayPost($, e).catch(() => undefined)].filter((t): t is string => typeof t === 'string')
  if (texts.length === 0) return r
  const extra = (r as { additionalContext?: unknown } | null | undefined)?.additionalContext
  return { ...(r ?? {}), additionalContext: [...(Array.isArray(extra) ? extra : []), ...texts] }
}

// v13.2 (2026-11-02): the keepalive ping. The prompt cache lives an hour from the last call, and a turn's last call is at its end, so a session left idle past
// that pays a full re-write at its next turn. The tick's last step sends one fixed ping when, cheap checks first:
// - keepalive is on and no callboard dialog is open;
// - a main-agent turn was seen to end (turnEndAt: after a restart nothing is pinged until one has), the gap since then (or since the last prompt, if later) is at
//   least pingAfterMin, and no ping was tried in this gap;
// - v13.5: any interactive session (personRow below; until v13.5 a bound lane, on, or a lead, D4);
// - v13.4: the Mac did not sleep in this gap (else logged once);
// - the last real turn ended less than stopAfterH ago (else logged once; a real turn starts the count again), and the gap is at most KEEPALIVE_COLD_MS (past that
//   the cache is cold: logged once, and the next turn starts a new gap);
// - the session has no request and no recorded nudge;
// - the prompt box is empty, the registry reads idle and waiting for nothing, and the session's own registry row is an interactive one: a `claude --bg` background
//   worker (kind background) or a run with no row is never pinged;
// - nothing else was submitted in this tick (a nudge, a resume, a notice, a cue's prompt): one submit per tick.
// Then pingAt is stamped (one attempt per gap, whatever follows): a lane signed done gets nothing (D5); a session past its compact level that may be nudged gets
// the nudge instead, recorded for nudgeTick (D2); v13.4: an idle one past CACHE_NUDGE_TOKENS after CACHE_NUDGE_AFTER_PINGS pings gets the cache nudge; any other
// gets the ping. A ping that throws or times out is logged and not tried again in that gap.
const lastSubmitAt = new Map<string, number>()
const turnKind = new Map<string, 'ping' | 'unreal'>()
const kaLogged = new Map<string, string>()
// v13.4: the pings that went out since the real turn that ended at realEnd.
const pingCount = new Map<string, { realEnd: number; count: number }>()
async function kaOnce($: any, sid: string, key: string, event: string, reason = '') {
  if (kaLogged.get(sid) === key) return
  kaLogged.set(sid, key)
  await log($, sid, event, reason)
}
async function keepaliveTick($: any, sid: string, submitsAtStart: number) {
  const k = await cfgGet($, sid)
  if (!k.keepalive || dialogOpen.has(sid)) return
  const turnEnd = (await $.state.get(turnEndRef)).value
  const realEnd = (await $.state.get(realEndRef)).value
  // Both come only from a turn.complete this session state saw: after a restart they are unknown (and the cache cold), so nothing is pinged until a turn ends.
  if (typeof turnEnd !== 'number' || typeof realEnd !== 'number') return
  const now = await $.clock.now()
  const gapStart = Math.max(turnEnd, lastSubmitAt.get(sid) ?? 0)
  const gap = now - gapStart
  if (gap < k.pingAfterMin * 60_000) return
  const pingAt = (await $.state.get(pingAtRef)).value
  if (typeof pingAt === 'number' && pingAt >= gapStart) return
  // v13.5 (2026-11-03): every interactive session, not only a lead, a lane or a session with callboard on; personRow below keeps it to a person's.
  // v13.4 (2026-11-03): the Mac slept in this gap (lid closed, a dark wake): no ping; the next turn's gap pings as usual.
  if (wokeAt !== undefined && wokeAt >= gapStart) return kaOnce($, sid, `asleep:${gapStart}`, 'keepalive-skipped', 'asleep')
  if (now - realEnd >= k.stopAfterH * c.HOUR_MS) return kaOnce($, sid, `stopped:${realEnd}`, 'keepalive-stopped')
  if (gap > c.KEEPALIVE_COLD_MS) return kaOnce($, sid, `cold:${gapStart}`, 'keepalive-skipped', 'cold')
  if ((await $.state.get(request)).value != null) return
  const due = await $.state.get(nudgeDueRef)
  if (due.value != null) return
  const reg = ownRegOnce($)
  if ((await idleCheck($, sid, reg)) !== undefined) return
  if (!(await personRow($, sid, reg))) return
  if (submits !== submitsAtStart) return
  if ((await $.state.set(pingAtRef, now)).isSet === false) return
  const st = await thresholdState($, sid)
  if (st === 'done') return log($, sid, 'keepalive-skipped', 'lane-done')
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const ct = await counts($)
  const kind = c.thresholdKind(tokens, k)
  // The reads since the idle check take time: a submit or a draft that came meanwhile wins, and this gap is missed (review c1).
  const draft = (await $.prompt.read()).text
  if (submits !== submitsAtStart || draft !== '' || (lastSubmitAt.get(sid) ?? 0) > gapStart) return kaOnce($, sid, `late:${gapStart}`, 'keepalive-skipped', 'late')
  if (kind && c.nudgeAllowed(ct, now, kind === 'working') && !c.compactAllowed(ct, tokens, now)) return recordNudge($, sid, kind, now, due.version, true)
  // v13.4 (2026-11-03): an idle session past CACHE_NUDGE_TOKENS that had CACHE_NUDGE_AFTER_PINGS pings since its last real turn gets the cache nudge
  // in this slot instead: compacting while the cache is warm costs less than keeping it warm.
  const pc = pingCount.get(sid)
  const pinged = pc !== undefined && pc.realEnd === realEnd ? pc.count : 0
  if (!kind && pinged >= c.CACHE_NUDGE_AFTER_PINGS && st === 'idle' && tokens >= c.CACHE_NUDGE_TOKENS && c.nudgeAllowed(ct, now) && !c.compactAllowed(ct, tokens, now))
    return recordNudge($, sid, 'cache', now, due.version, true)
  const sent = await withTimeout($, submitOwn($, c.KEEPALIVE_TEXT, false).then(() => 'ok' as const, () => 'failed' as const), ACTION_TIMEOUT_MS)
  if (sent === 'ok') pingCount.set(sid, { realEnd, count: pinged + 1 })
  // A ping that failed leaves no mark its prompt hook may have set: the next turn is not taken for its turn (review c1). A timed-out one may still
  // go out, so its mark stays (review c2).
  if (sent === 'failed') turnKind.delete(sid)
  await log($, sid, sent === 'ok' ? 'keepalive' : sent === 'timeout' ? 'keepalive-unconfirmed' : 'keepalive-failed')
}

// The lead's lane_compact with no request of the session's own: a session that may be nudged, the same limits as a compaction, no background agents,
// the nudge throttle; then one nudge is recorded. A fresh nudge already pending is answered nudged as it stands (its time is kept, so the lead cannot
// stretch its 10 minutes); a pending `threshold` one becomes a lead nudge (the lead text, not the size's).
async function leadNudge($: any, sid: string, now: number, answer: Answer, refuse: (reason: string) => Promise<void>) {
  // A cue's path: the plain registry, as every cue check (a lead's cue never reaches a session whose row is only in another config folder).
  if (!(await personRow($, sid, regOnce($)))) return refuse('not-interactive')
  const read = await $.state.get(nudgeDueRef)
  const pending = read.value as c.NudgeDue | null | undefined
  if (c.nudgeDueFresh(pending, now)) {
    if (pending.kind === 'threshold') await $.state.set(nudgeDueRef, { kind: 'lead', at: pending.at }, { ifVersion: read.version })
    await answer('held', 'nudged')
    return log($, sid, 'nudge-pending', pending.kind)
  }
  const ct = await counts($)
  const no = c.compactAllowed(ct, (await $.session.usage()).context.tokens ?? 0, now)
  if (no) return refuse(no)
  if (await busyAgents($)) return refuse('background-work')
  if (!c.nudgeAllowed(ct, now)) return refuse('nudge-limit')
  await $.state.set(nudgeDueRef, { kind: 'lead', at: now })
  await answer('held', 'nudged')
  await log($, sid, 'nudge-due', 'lead')
}

// A restored binding is never a birth binding: turns -1 and startDone keep `start` shut, and it needs its own named confirmation.
async function restoreFromHint($: any, sid: string, now: number, stale: () => boolean = () => false): Promise<'timed-out' | void> {
  if (restoredOnce.has(sid)) return
  const raw = await $.store.get(`${c.HINT_PREFIX}${sid}`).catch(() => undefined)
  if (raw === undefined) return
  const hint = c.parseHint(raw, now)
  if (!hint) return log($, sid, 'hint-rejected', 'invalid')
  if (hint.lane && (await $.state.get(lane)).value == null) {
    const lanes = await loadLanes($)
    if (typeof lanes === 'string') return log($, sid, 'hint-rejected', lanes)
    const live = await registryEntries($)
    if (!live) return log($, sid, 'hint-rejected', 'registry-unreadable')
    const others = live.filter((e) => e.j.sessionId !== sid).flatMap((e) => (typeof e.j.name === 'string' ? [e.j.name] : []))
    const no = c.restoreRefusal(hint, lanes, await sessionRoot($), others)
    if (no) {
      if (no !== 'name-in-use') restoredOnce.add(sid)
      return log($, sid, 'hint-rejected', no)
    }
    // A lead is never restored into a lane; the restore stays pending for a /callboard lane after lead off.
    const leadNo = () => log($, sid, 'refused', 'restore-lead-holder')
    if (leadBusy(sid)) return leadNo()
    const answer = await ask($, c.restoreQuestion(hint.lane.name), c.RESTORE_YES, c.RESTORE_NO, c.HEADER.restore)
    if (answer !== 'yes') {
      if (answer === 'no') restoredOnce.add(sid)
      // v13.5: /callboard lane stops on a question nobody answered, and goes on to Join after a Cancel or a refusal.
      if (answer === 'timed-out') {
        await timedOut($, sid, 'restore-timed-out', c.TIMED_OUT_RESTORE_TOAST)
        return 'timed-out' as const
      }
      return log($, sid, 'refused', 'restore-not-confirmed')
    }
    // The question stayed open for up to 90 s: the same checks run again on fresh reads, and the bind uses the fresh record. The person said yes, so a restore
    // refused from here on says so in a toast.
    const notRestored = async (code: string, pending: boolean) => {
      if (!pending) restoredOnce.add(sid)
      toast($, c.restoreChangedToast(hint.lane!.name))
      return log($, sid, 'hint-rejected', code)
    }
    const lanesNow = await loadLanes($)
    if (typeof lanesNow === 'string') return notRestored(lanesNow, true)
    const liveNow = await registryEntries($)
    if (!liveNow) return notRestored('registry-unreadable', true)
    const othersNow = liveNow.filter((e) => e.j.sessionId !== sid).flatMap((e) => (typeof e.j.name === 'string' ? [e.j.name] : []))
    const noNow = c.restoreRefusal(hint, lanesNow, await sessionRoot($), othersNow)
    if (noNow) return notRestored(noNow, noNow === 'name-in-use')
    if (stale()) return log($, sid, 'refused', 'off-meanwhile')
    // A rebind that landed while the question was open (v13) bound the session already, and said so: no "things changed" toast then.
    if (leadBusy(sid) || laneBinding.has(sid)) {
      if (!rebound.has(sid)) toast($, c.restoreChangedToast(hint.lane.name))
      return leadNo()
    }
    laneBinding.add(sid)
    const rec = lanesNow.find((x) => x.name === hint.lane!.name)!
    let binding: Bound | undefined
    try {
      // Inside the mark: a birth rename cue takes the same mark before its own write, so this read cannot miss a binding written meanwhile.
      // A read that does not answer counts as a binding.
      const held = await withTimeout($, $.state.get(lane), c.ENGINE_CALL_TIMEOUT_MS)
      if (held === 'timeout' || held?.value != null) {
        restoredOnce.add(sid)
        if (!rebound.has(sid)) toast($, c.restoreChangedToast(hint.lane.name))
        return void (await log($, sid, 'refused', 'restore-already-bound'))
      }
      const b = { name: rec.name, at: now, turns: -1, restored: true, rec: await sha($, c.recordText(rec)), ...(rec.adopted ? { adopted: true as const, lead: rec.lead, key: rec.src } : {}) }
      const setting = $.state.set(lane, b)
      const w = await withTimeout($, setting, c.ENGINE_CALL_TIMEOUT_MS)
      if (w === 'timeout') {
        // Not pending: a write that lands late is undone with its hint, so there would be nothing to retry.
        undoLate($, sid, setting, b)
        restoredOnce.add(sid)
        return void (await log($, sid, 'error', 'restore-bind-timeout'))
      }
      if (w?.isSet !== false) binding = b
    } finally {
      laneBinding.delete(sid)
    }
    if (binding) {
      // As attach: an off that landed while the binding was being set ran before there was one, so it is undone here, with no note. The caller says so.
      if (stale()) return void (await detach($, sid, binding))
      // The registry is read again: the dialog may have been open a long time.
      await keepLaneFacts($, sid, rec, rec.adopted === true, rec.adopted ? rec.lead : undefined)
      await briefLane($, sid)
    }
    await bump($, (ct) => ({ ...c.mergeCounters(ct, hint.counters), startDone: true }))
  }
  restoredOnce.add(sid)
  await log($, sid, 'restored')
}

async function dropRequest($: any, sid: string, reason: string) {
  if ((await $.state.get(request)).value) {
    await $.state.set(request, null)
    await log($, sid, 'dropped', reason)
  }
}

// Notice turns sent per session in the last hour (module memory: a reload starts the count over).
const noticeTimes = new Map<string, number[]>()

// Ticks in a row whose request step threw, per session (module memory): the count and the time of the first throw.
// The request is dropped only after REQUEST_FAILS_MAX throws in a row that span REQUEST_FAIL_SPAN_MS, so a brief fault
// (a slow shasum or agent.list for a few ticks) never costs a session its request or its resume note.
const requestFails = new Map<string, { n: number; firstMs: number }>()
const REQUEST_FAILS_MAX = 3
const REQUEST_FAIL_SPAN_MS = 60_000

async function failRequest($: any, sid: string, reason: string, notice: boolean, ifVersion?: number) {
  if (ifVersion === undefined) await $.state.set(request, null)
  else if ((await $.state.set(request, null, { ifVersion })).isSet === false) return log($, sid, 'dropped', 'changed-meanwhile')
  await log($, sid, 'refused', reason)
  if (!notice) return
  const now = await $.clock.now()
  const times = noticeTimes.get(sid) ?? []
  if (!c.noticeAllowed(times, now)) return log($, sid, 'notice-capped', reason)
  noticeTimes.set(sid, [...times.filter((t) => t <= now && now - t < c.HOUR_MS), now])
  await submitOwn($, c.noticeText(reason), false).catch(() => {
    turnKind.delete(sid)
    return log($, sid, 'notice-failed')
  })
}

// fromCue: the compaction was brought forward by a cue, so the session must be idle with no
// prompt open. For `now`, the request is acted on at the end of the requesting turn, when the
// registry may still read busy; only the draft box is checked there. answer tells the lead (cue only).
async function doCompact($: any, sid: string, req: Request, fromCue: boolean, answer: Answer = noAnswer) {
  const now = await $.clock.now()
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const refuse = c.compactAllowed(await counts($), tokens, now)
  if (refuse) {
    await answer('refused', refuse)
    return failRequest($, sid, refuse, false)
  }
  if (await busyAgents($)) {
    await answer('refused', 'background-work')
    return failRequest($, sid, 'background-work', true)
  }
  const blocked = fromCue ? await idleCheck($, sid) : (await $.prompt.read()).text !== '' ? 'draft-in-box' : undefined
  if (blocked === 'draft-in-box') {
    toast($, 'Compaction skipped: draft in the prompt box.')
    await answer('refused', 'draft-in-box')
    return failRequest($, sid, 'draft-in-box', false)
  }
  if (blocked) {
    await answer('held', blocked)
    return log($, sid, 'held', blocked)
  }
  const live = (await $.state.get(request)).value as Request | null | undefined
  if (!live || live.id !== req.id || live.phase !== 'armed' || !(await requestOk($, sid, live))) {
    await answer('refused', 'no-request')
    return log($, sid, 'dropped', 'cancelled-before-compact')
  }
  await $.state.set(request, { ...req, phase: 'compacting', compactingMs: await $.clock.now() })
  // v13.1: the mark that survives a restart (c.CMP_PREFIX); set after `compacting`, so a tick in between cannot clear it as left behind.
  cmpMarked.add(sid)
  const markAt = await $.clock.now()
  await withTimeout($, Promise.resolve($.store.set(`${c.CMP_PREFIX}${sid}`, { at: markAt })).catch(() => log($, sid, 'error', 'cmp-mark').catch(() => undefined)), c.ENGINE_CALL_TIMEOUT_MS)
  // A compaction runs far longer than the lead waits: `ok` means it began; its end is in the log (`compacted`).
  await answer('ok')
  await log($, sid, 'compacting', req.mode)
  try {
    await $.command.run({ command: 'compact', args: req.focus })
  } catch {
    await failRequest($, sid, 'rejected', true)
  }
}

async function handle($: any, sid: string, cue: c.Cue, answer: Answer) {
  // The answer goes first: the lead is waiting on it, and the log line costs several process runs.
  const refuse = async (reason: string) => {
    await answer('refused', reason)
    await log($, sid, 'refused', reason)
  }
  const hold = async (reason: string) => {
    await answer('held', reason)
    await log($, sid, 'held', reason)
  }
  const now = await $.clock.now()
  const bound = (await $.state.get(lane)).value as { name: string; turns?: number; rec?: string; adopted?: boolean; lead?: string } | null | undefined
  const first = (await $.state.get(seen)).value ?? now
  // One cue reads the registry and the lane list once.
  const reg = regOnce($)
  let lanesP: Promise<c.Lane[] | string> | undefined
  const lanesOnce = () => (lanesP ??= loadLanes($))
  if (cue.verb === 'rename') {
    if (bound) return refuse('already-bound')
    // A lead is never renamed into a lane: the two grants would hold one session.
    if (leadBusy(sid)) return refuse('lead-holder')
    if (laneBinding.has(sid)) return refuse('already-bound')
    // v15.1 (security review): a record name that is reserved on this machine (one written in the moment of a reserve) is never
    // taken by a rename.
    if (c.reservedHit(cue.name!)) return refuse('name-reserved')
    laneBinding.add(sid)
    try {
      // The engine calls held inside the mark have a time limit: one that never returns would hold the mark, and refuse every lead grant and bind, until a reload.
      // A session read that does not answer fails its check (no folder, no turn count, not idle).
      const bounded = async <T,>(p: Promise<T>): Promise<T | undefined> => {
        const r = await withTimeout($, p, c.ENGINE_CALL_TIMEOUT_MS)
        return r === 'timeout' ? undefined : r
      }
      const lanes = await lanesOnce()
      if (typeof lanes === 'string') return refuse(lanes)
      const me = await registryOf($, sid, reg)
      const no = c.birthRenameOk(
        lanes,
        cue.name!,
        { cwd: (await bounded(sessionRoot($))) ?? '', turns: (await bounded($.session.turns())) ?? NaN, nameSource: me?.nameSource, firstSeenMs: first, liveNames: await liveNames($, reg) },
        now,
      )
      if (no) return refuse(no)
      const blocked = await withTimeout($, idleCheck($, sid, reg), c.ENGINE_CALL_TIMEOUT_MS)
      if (blocked === 'timeout') return hold('not-idle')
      if (blocked) return hold(blocked)
      // Everything that can fail without a trace runs before the rename: a session renamed but left unbound is refused by every later rename and attach.
      const rec = await sha($, c.recordText(lanes.find((x) => x.name === cue.name)!)).catch(() => undefined)
      if (!rec) return refuse('sha-failed')
      const t0 = await bounded($.session.turns())
      if (t0 === undefined) return hold('not-idle')
      let renamed: unknown
      try {
        renamed = await withTimeout($, $.command.run({ command: 'rename', args: cue.name! }), c.ENGINE_CALL_TIMEOUT_MS)
      } catch {
        return refuse('rename-failed')
      }
      if (renamed === 'timeout') {
        await log($, sid, 'error', 'rename-timeout')
        return refuse('rename-failed')
      }
      // A failed read counts as other turns: the binding stores -1, and lane_start is refused.
      const t1r = await withTimeout($, $.session.turns().catch(() => NaN), c.ENGINE_CALL_TIMEOUT_MS)
      const t1 = t1r === 'timeout' ? NaN : t1r
      const stored = c.bindTurns(t0, t1)
      const b: Bound = { name: cue.name!, at: now, turns: stored ?? -1, rec }
      const setting = $.state.set(lane, b)
      const w = await withTimeout($, setting, c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
      if (w === 'timeout') {
        undoLate($, sid, setting, b)
        await log($, sid, 'error', 'bind-timeout')
      }
      if (!w || w === 'timeout' || w.isSet === false) return refuse('bind-failed')
      const leadLookup = keepLaneFacts($, sid, lanes.find((x) => x.name === cue.name)!, false, cue.lead, reg)
      if (stored === undefined) await refuse('bind-turns-mismatch')
      else await answer('ok')
      await withTimeout($, leadLookup, c.ENGINE_CALL_TIMEOUT_MS)
      return log($, sid, 'renamed')
    } finally {
      laneBinding.delete(sid)
    }
  }
  if (bound?.adopted) {
    const all = await lanesOnce()
    if (typeof all === 'string') return refuse(all)
    const rec = all.find((x) => x.name === bound.name)
    if (!rec) return refuse('unknown-lane')
    if (!rec.repo) return refuse('no-lead')
    if (!(await leadHere($, await sessionRoot($), rec.repo, rec.leadName, reg))) {
      // v14 (2026-11-04, review c1, W1): with no live lead, the verbs a manager may send (resume, compact, retire) are taken while a live manager passes every
      // presence check and has a reserved registry name (managerTrusted, as S7). A filter, not proof: any writer of the cue folder can send the cue then.
      const live = c.MANAGER_CUE_VERBS.includes(cue.verb) ? await reg() : undefined
      if (!live || !(await managerTrusted($, live, sid))) return refuse('no-lead')
    }
  }
  // v14 (2026-11-04, S7): a session holding a lead grant takes one verb, compact, and only while a live manager file of another session passes every presence
  // check and the registry names that session with a reserved name (c.managerNameOf); it acts only on an on-cue request of its own, and is never nudged. A
  // filter, not proof: any writer of the cue folder can send the cue while a manager is live; the request is the lead's own.
  if (!bound && grants.get(sid)?.level === 'lead') {
    if (cue.verb !== 'compact') return refuse('not-eligible')
    const live = await reg()
    if (!live) return refuse('registry-unreadable')
    // v15 S7: or while a trusted conductor lists the lead's repo (conductorsTrusted).
    if (!(await managerTrusted($, live, sid)) && (await conductorsTrusted($, live, sid, pinOf(sid))).length === 0) return refuse('not-eligible')
    const req = (await $.state.get(request)).value as Request | null | undefined
    if (!req || req.viaLead !== true || req.mode !== 'on-cue' || req.phase !== 'armed') return refuse('no-request')
    if (!c.onCueValid(req.requestedMs, now)) {
      await answer('refused', 'no-request')
      return dropRequest($, sid, 'expired')
    }
    return doCompact($, sid, req, true, answer)
  }
  if (!(await isEligible($))) return refuse('not-eligible')
  if (cue.verb === 'compact') {
    const req = (await $.state.get(request)).value as Request | null | undefined
    // With no request of its own the session is nudged to make one; any other phase (called, armed now, compacting, compacted) is no-request, as before.
    if (!req) return leadNudge($, sid, now, answer, refuse)
    if (req.mode !== 'on-cue' || req.phase !== 'armed') return refuse('no-request')
    if (!c.onCueValid(req.requestedMs, now)) {
      await answer('refused', 'no-request')
      return dropRequest($, sid, 'expired')
    }
    return doCompact($, sid, req, true, answer)
  }
  if (!bound) return refuse('not-bound')
  const lanes = await lanesOnce()
  if (typeof lanes === 'string') return refuse(lanes)
  const l = lanes.find((x) => x.name === bound.name)
  if (!l) return refuse('unknown-lane')
  if (!(await recMatch($, bound.rec, l))) return refuse('record-changed')
  if ((await sessionRoot($)) !== l.folder) return refuse('wrong-folder')
  if (cue.verb === 'start' && bound.adopted) return refuse('adopted-record')
  const blocked = await idleCheck($, sid, reg)
  if (blocked) return hold(blocked)
  if (cue.verb === 'retire' || cue.verb === 'park') {
    // The lead signals only on this answer; the session does not stop itself (no engine call gives it its own pid). A park keeps the conversation, so it
    // needs no signed report: the same idle, draft, agent and shell checks only.
    if (await busyAgents($)) return refuse('background-work')
    const shells = await backgroundShells($, sid, reg)
    if (shells) return refuse(shells)
    if (cue.verb === 'retire') {
      const bad = await retireReportCheck($, sid, l)
      if (bad) return refuse(bad)
    }
    await answer('ok')
    return log($, sid, cue.verb === 'retire' ? 'retire-confirmed' : 'park-confirmed', l.name)
  }
  if (cue.verb === 'start') {
    const ct = await counts($)
    if (ct.startDone) return refuse('start-done')
    if (!c.startTurnsOk(await $.session.turns(), bound.turns)) return refuse('not-empty')
    if (now - first > c.BIRTH_WINDOW_MS) return refuse('too-old')
    const p = (await where($))!
    const bf = await facts($, l.brief)
    if (!bf || bf.kind !== 'file' || bf.nlink !== 1 || bf.uid !== p.uid || bf.size > 65_536) return refuse('brief-file')
    const real = (await run($, [REALPATH, '--', l.brief])).stdout.trim()
    const realFolder = (await run($, [REALPATH, '--', l.folder])).stdout.trim()
    if (!real || !realFolder || !c.within(realFolder, real)) return refuse('brief-path')
    // Only a record that carries a model is switched (an older record is not). /model adds a turn, so a lane it fails on cannot be started later.
    if (l.model && !(await modelSet($, l.model))) return refuse('model-failed')
    await log($, sid, 'brief-sha256', await sha($, await $.fs.read(l.brief)))
    await bump($, (ct2) => ({ ...ct2, startDone: true }))
    try {
      await submitOwn($, c.startText(l.name, l.brief))
    } catch {
      await bump($, (ct2) => ({ ...ct2, startDone: false })).catch(() => undefined)
      await answer('refused', 'submit-failed')
      return log($, sid, 'start-failed')
    }
    await answer('ok')
    return log($, sid, 'started')
  }
  const no = c.resumeAllowed(await counts($), now)
  if (no) return refuse(no)
  await bump($, (ct2) => ({ ...ct2, resumeTimes: [...(ct2.resumeTimes ?? []).filter((t) => now - t < c.HOUR_MS), now] }))
  try {
    await submitOwn($, c.resumeText(l.name))
  } catch {
    await bump($, (ct2) => ({ ...ct2, resumeTimes: (ct2.resumeTimes ?? []).filter((t) => t !== now) })).catch(() => undefined)
    await answer('refused', 'submit-failed')
    return log($, sid, 'resume-failed')
  }
  await answer('ok')
  return log($, sid, 'resumed')
}

// /model in this session's own engine, then a read-back: the session's model name, lowercased, must contain the alias ("Haiku 5.5", "claude-haiku-5-5").
async function modelSet($: any, model: c.LaneModel): Promise<boolean> {
  try {
    if ((await withTimeout($, $.command.run({ command: 'model', args: model }), c.MODEL_TIMEOUT_MS)) === 'timeout') return false
    return String(await $.session.model()).toLowerCase().includes(model)
  } catch {
    return false
  }
}

// The folder the session started in ($.session.root(), engine 2.1.316). An engine without root() fails the call, and the live folder ($.session.cwd()) is
// read instead, the check of v12; a root() read that fails on an engine that has it reads cwd() the same way.
async function sessionRoot($: any): Promise<any> {
  try {
    return await $.session.root()
  } catch {
    return $.session.cwd()
  }
}

async function withTimeout<T>($: any, p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, $.clock.sleep(ms).then(() => 'timeout' as const)])
}

// A binding write that timed out may still land. Once it does, it is undone while it is still that binding (same name and time), so a bind that was answered as
// failed leaves none behind. Best effort, logged.
function undoLate($: any, sid: string, setting: Promise<any>, b: Bound) {
  void setting
    .then(async (w) => {
      if (w?.isSet === false) return
      const cur = (await $.state.get(lane)).value as Bound | null | undefined
      if (cur && cur.name === b.name && cur.at === b.at) {
        await detach($, sid, cur)
        await log($, sid, 'error', 'late-bind-undone')
      }
    })
    .catch(() => log($, sid, 'error', 'late-bind').catch(() => undefined))
}

// Claim <sid>.cue by renaming it to a name only this tick uses, then judge the file that was
// moved, not the one first seen: a cue replaced between the two is the one read, checked and
// answered, with its own inode, so the answer never names a file that was not read. A cue that
// appears after the move is the next tick's. The name it is moved to is new (a random part), must not
// exist yet, and the move must succeed: mv -n leaves a file already at that name in place.
async function claim($: any, sid: string, p: { uid: number; root: string }) {
  const cueDir = `${p.root}/cue`
  const cue = `${cueDir}/${sid}.cue`
  const first = await facts($, cue)
  if (!first) return undefined
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, cueDir, p.uid))) return { bad: 'unsafe-dir', ino: first.ino }
  const refusal = c.cueFileOk(first, p.uid)
  if (refusal) return { bad: refusal, ino: first.ino }
  const taken = `${cueDir}/${sid}.${await $.clock.now()}.${++seq}.${Math.random().toString(36).slice(2, 12)}.taken`
  if (await facts($, taken)) return { bad: 'claim-failed', ino: first.ino }
  if ((await run($, [MV, '-n', '--', cue, taken])).exitCode !== 0) return { bad: 'claim-failed', ino: first.ino }
  const moved = await facts($, taken)
  if (!moved) return { bad: 'claim-failed', ino: first.ino }
  const ino = moved.ino
  const movedRefusal = c.cueFileOk(moved, p.uid)
  if (movedRefusal) {
    if (moved.kind === 'file') await run($, [RM, '-f', '--', taken])
    return { bad: movedRefusal, ino }
  }
  if (moved.size > c.CUE_MAX_BYTES) {
    await run($, [RM, '-f', '--', taken])
    return { bad: 'too-long', ino }
  }
  const text = (await run($, [HEAD, '-c', String(c.CUE_MAX_BYTES + 1), '--', taken])).stdout
  const after = await facts($, taken)
  await run($, [RM, '-f', '--', taken])
  if (!after || !c.sameFile(moved, after)) return { bad: 'changed', ino }
  if (!c.isFresh(await $.clock.now(), moved.mtimeMs)) return { bad: 'stale', ino }
  return { text, ino }
}

// claim removes its .taken file, unless a throw or a killed process falls between the move and the rm. This session's own leftovers go, at most once per
// TAKEN_SWEEP_MS: only names claim makes, aged by the claim time in the name (mv keeps the cue's mtime, so a stale cue under claim looks old), and only a
// plain file or a link (rm without -r cannot remove a folder; a folder or another kind is logged and left). Another session's are never touched.
const takenSwept = new Map<string, number>()
async function sweepTaken($: any, sid: string, p: { uid: number; root: string }) {
  const now = await $.clock.now()
  if (now - (takenSwept.get(sid) ?? -Infinity) < c.TAKEN_SWEEP_MS) return
  takenSwept.set(sid, now)
  const dir = `${p.root}/cue`
  if (!(await dirOk($, p.root, p.uid)) || !(await dirOk($, dir, p.uid))) return
  const files = ((await $.fs.list(dir).catch(() => [])) as { name: string; kind: string; isLink: boolean }[]).slice(0, 500)
  let n = 0
  for (const f of files) {
    const at = c.takenClaimMs(f.name, sid)
    if (at === undefined || !(now - at > c.TAKEN_SWEEP_MS)) continue
    if (f.kind !== 'file' && !f.isLink) {
      await log($, sid, 'error', 'taken-dir')
      continue
    }
    if ((await run($, [RM, '-f', '--', `${dir}/${f.name}`])).exitCode === 0) n++
  }
  if (n > 0) await log($, sid, 'taken-swept', String(n))
}

// The rename of an attached session cannot run inside the command (the engine refuses it there), so it runs from the next tick, once.
const pendingRename = new Map<string, { name: string; until: number; manager?: true }>()
async function renameTick($: any, sid: string) {
  const pr = pendingRename.get(sid)
  if (!pr) return
  pendingRename.delete(sid)
  // v14 (2026-11-04): the manager's rename, while its grant still names it (probe P6 not run: the outcome is logged either way).
  const g = grants.get(sid)
  if (pr.manager ? !(g?.level === 'manager' && g.name === pr.name) : ((await $.state.get(lane)).value as { name?: string } | null | undefined)?.name !== pr.name) return
  const fail = async (why: string) => {
    await log($, sid, 'rename-failed', why)
    toast($, c.renameFailedToast(pr.name))
  }
  if ((await $.clock.now()) > pr.until) return fail('expired')
  // The name was free when the person said yes; another session may have taken it since.
  const reg = await registryEntries($)
  if (!reg) return fail('registry-unreadable')
  if (reg.some((e) => e.j.name === pr.name && e.j.sessionId !== sid)) return fail('name-taken')
  const done = await withTimeout($, Promise.resolve($.command.run({ command: 'rename', args: pr.name })).then(() => 'ok' as const, () => 'refused' as const), ACTION_TIMEOUT_MS)
  if (done === 'ok') await log($, sid, 'renamed', pr.manager ? 'manager' : 'attach')
  else await fail(done)
}

// v13: a bound session makes sure its own store record names it, once per binding (name, time and record hash): the record of a lane born through lane_rename,
// one restored through the dialog, a rebind and every record written before v13. Run from the tick before the cue is claimed, under a time limit. The key is set
// first, so a failure is not retried in this process (the next restart falls back to the Restore dialog, whose bind is followed by this sync). The write re-checks the binding inside the store queue, so a /callboard off that cleared it meanwhile is not undone.
const sidSynced = new Map<string, string>()
// The cheap part, every tick with no time limit (a state read): the binding the sync is due for, if any; its key is set here.
async function sidSyncDue($: any, sid: string): Promise<Bound | undefined> {
  const b = (await $.state.get(lane)).value as Bound | null | undefined
  if (!b || typeof b.name !== 'string') return undefined
  const key = `${b.name}\n${b.at}\n${b.rec ?? ''}`
  if (sidSynced.get(sid) === key) return undefined
  sidSynced.set(sid, key)
  return b
}
// A binding made before the lead name left an attached record's hash holds the older hash. It is rewritten to the current one the first time the record is read
// (this sync runs once per binding, from the first tick after a reload), so a later carry or claim of the lead name never leaves that lane with no matching hash.
async function hashUpgraded($: any, sid: string, b: Bound & { name: string }, l: c.Lane): Promise<Bound & { name: string }> {
  if (l.adopted !== true || b.rec === undefined) return b
  const cur = await sha($, c.recordText(l))
  if (c.recOk(b.rec, cur)) return b
  const now = (await $.state.get(lane)).value as Bound | null | undefined
  if (!now || now.name !== b.name || now.at !== b.at || now.rec !== b.rec) return b
  const up = { ...now, name: b.name, rec: cur }
  await $.state.set(lane, up)
  sidSynced.set(sid, `${up.name}\n${up.at}\n${up.rec}`)
  await log($, sid, 'hash-upgraded')
  return up
}
async function sidSync($: any, sid: string, b: Bound & { name: string }) {
  const failed = (code: string) => log($, sid, 'sid-heal-failed', code)
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return failed(lanes)
  const l = lanes.find((x) => x.name === b.name)
  if (!l || !l.src) return
  if (!(await recMatch($, b.rec, l))) return failed('record-changed')
  b = await hashUpgraded($, sid, b, l)
  if ((await sessionRoot($)) !== l.folder) return failed('wrong-folder')
  if (l.sid === sid && l.parked === undefined) return
  const same = async () => {
    const now = (await $.state.get(lane)).value as Bound | null | undefined
    return !!now && now.name === b.name && now.at === b.at && now.rec === b.rec ? undefined : { no: 'changed' }
  }
  const r = await editStore($, l.src, async (cur) => {
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    let hit = false
    let done = false
    const lanes2: c.Store['lanes'] = []
    for (const x of parsed.store.lanes) {
      if (x.name === b.name && (await recMatch($, b.rec, x))) {
        hit = true
        done = x.sid === sid && x.parked === undefined
        lanes2.push({ ...x, sid, parked: undefined })
      } else lanes2.push(x)
    }
    if (!hit) return { no: 'record-changed' }
    if (done) return { skip: true }
    const t = c.storeText({ ...parsed.store, lanes: lanes2 })
    if ('no' in t) return t
    return { text: t.text, landed: (s) => !!s?.lanes.some((x) => x.name === b.name && x.sid === sid && x.parked === undefined) }
  }, same)
  if ('no' in r) return failed(r.no)
  if (r.text !== '') await log($, sid, 'sid-healed')
}

// v13: a session that starts again under the id its store record names is that lane again, with no question (D4): an unparked lane, a tab reopened by a window
// restart, a conversation resumed by hand. session.start marks it; the work runs from the tick, one try per tick, up to REBIND_TRIES. A session no record names
// ends at the first try with no registry read and no log. A lanes read that fails, a registry read that cannot be trusted (its dead-row filter was off) and a
// name another live session carries are tried again; any other refusal ends it at once. The bind is the restore's: turns -1, restored, startDone, the record's
// hash, the briefing note and the hint's counters. Where it does not happen, /callboard lane still offers the Restore question.
const REBIND_TRIES = 15
const rebindPending = new Map<string, number>()
// Sessions this process rebound: a Restore question already open when the bind lands ends with no "things changed" toast.
const rebound = new Set<string>()
// The record's name while a rebind is pending, for the toast when it ends refused.
const rebindName = new Map<string, string>()
// A rebind write that timed out and lands late is only taken back (W1): the binding goes while it is still this one; the record, its sid and the hint stay,
// so a later start or the Restore question can still bind it. Not detach, which would clear the sid and the hint for good.
function rebindUndoLate($: any, sid: string, setting: Promise<any>, b: Bound) {
  void setting
    .then(async (w) => {
      if (w?.isSet === false) return
      const cur = (await $.state.get(lane)).value as Bound | null | undefined
      if (cur && cur.name === b.name && cur.at === b.at) {
        await $.state.set(lane, null)
        await log($, sid, 'error', 'late-rebind-undone')
      }
    })
    .catch(() => log($, sid, 'error', 'late-rebind').catch(() => undefined))
}
// A try still running after the tick's time limit: the next tick does not start another beside it.
const rebindBusy = new Set<string>()
async function rebindTick($: any, sid: string) {
  const tries = rebindPending.get(sid)
  if (tries === undefined) return
  const seq = offSeq.get(sid) ?? 0
  const n = tries + 1
  rebindPending.set(sid, n)
  const end = async (code: string) => {
    rebindPending.delete(sid)
    const name = rebindName.get(sid)
    rebindName.delete(sid)
    await log($, sid, 'rebind-rejected', code)
    // The lead may have been told the lane comes back by itself (lane_unpark): the person is told it did not (W3). Not for a lead, nor a run with no person.
    if (name !== undefined && code !== 'lead-holder' && code !== 'not-interactive') toast($, c.rebindFailedToast(name))
  }
  const retry = async (code: string) => (n >= REBIND_TRIES ? end(code) : undefined)
  // A session bound already (attached or restored before this tick) is left as it is, with no read; the check runs again inside the mark below.
  if ((await $.state.get(lane)).value != null) return void rebindPending.delete(sid)
  const lanes = await loadLanes($).catch(() => 'lanes-error')
  if (typeof lanes === 'string') return retry(lanes)
  const named = lanes.filter((l) => l.sid === sid)
  if (named.length === 0) return void rebindPending.delete(sid)
  if (named.length === 1) rebindName.set(sid, named[0].name)
  // A lead restore still pending (D5) decides first: a session that becomes lead is refused below as lead-holder.
  if (leadRestorePending.has(sid)) return retry('lead-restore-pending')
  // v15 (c2, M-B): a conductor restore still pending decides first (it ends on a lane record naming this session).
  if (conductorRestorePending.has(sid)) return retry('conductor-restore-pending')
  // A person's session only (F5): a headless run resumed under this id does not become the lane. Tried again: a reopened panel's own registry row may come a
  // moment after session.start.
  if (!(await interactive($, sid))) return retry('not-interactive')
  const reg = await registryEntriesWhy($)
  if (!reg.rows) return retry('registry-unreadable')
  if (reg.why !== undefined) return retry(`registry-${reg.why}`)
  // A row of this same session id (the old process of this conversation, still dropping out) never blocks its own rebind.
  const others = reg.rows.filter((e) => e.j.sessionId !== sid).flatMap((e) => (typeof e.j.name === 'string' ? [e.j.name] : []))
  const now = await $.clock.now()
  const hint = c.parseHint(await $.store.get(`${c.HINT_PREFIX}${sid}`).catch(() => undefined), now)
  const v = c.rebindRefusal(lanes, sid, await sessionRoot($), others, hint)
  if (!v.ok) return v.reason === 'name-in-use' ? retry(v.reason) : end(v.reason)
  const l = v.lane
  if (leadBusy(sid)) return end('lead-holder')
  if (laneBinding.has(sid)) return retry('already-bound')
  laneBinding.add(sid)
  let binding: Bound | undefined
  try {
    // As the restore: inside the mark, and a read that does not answer counts as a binding. A session that is bound already is left as it is.
    const held = await withTimeout($, $.state.get(lane), c.ENGINE_CALL_TIMEOUT_MS)
    if (held === 'timeout' || held?.value != null) return void rebindPending.delete(sid)
    const b = { name: l.name, at: now, turns: -1, restored: true, rec: await sha($, c.recordText(l)), ...(l.adopted ? { adopted: true as const, lead: l.lead, key: l.src } : {}) }
    // A /callboard off since this tick began cancelled the rebind and cleared the record's sid: no binding is written after it.
    if (!rebindPending.has(sid) || (offSeq.get(sid) ?? 0) !== seq) return
    const setting = $.state.set(lane, b)
    const w = await withTimeout($, setting, c.ENGINE_CALL_TIMEOUT_MS)
    if (w === 'timeout') {
      rebindUndoLate($, sid, setting, b)
      rebindPending.delete(sid)
      return void (await log($, sid, 'error', 'rebind-bind-timeout'))
    }
    if (w?.isSet !== false) binding = b
  } finally {
    laneBinding.delete(sid)
  }
  rebindPending.delete(sid)
  if (!binding) return
  await keepLaneFacts($, sid, l, l.adopted === true, l.adopted ? l.lead : undefined)
  await briefLane($, sid)
  await bump($, (ct) => ({ ...c.mergeCounters(ct, hint?.counters ?? {}), startDone: true }))
  restoredOnce.add(sid)
  rebound.add(sid)
  await saveHint($, sid)
  await log($, sid, 'rebound', l.name)
  toast($, c.reboundToast(l.name))
}

// v13.4 (2026-11-03): every timer call records its time, a running tick or not. A gap past SLEEP_GAP_MS since the last one means the Mac slept: wokeAt.
// A reload loses both, so the first call after it only records.
let lastTimerAt: number | undefined
let wokeAt: number | undefined
async function tick($: any) {
  let startedAt: number | undefined
  try {
    const t = await $.clock.now()
    if (lastTimerAt !== undefined && t - lastTimerAt > c.SLEEP_GAP_MS) wokeAt = t
    lastTimerAt = t
    startedAt = t
  } catch {}
  if (isTicking) return
  isTicking = true
  // v13.2: the keepalive step runs only when no step of this tick submitted anything.
  const submitsAtStart = submits
  let sid: unknown
  let answer: Answer | undefined
  // Set once the request step is behind: the nudge step then runs last, after the cue was claimed and handled (or there was none).
  let nudge = false
  try {
    sid = await $.session.id()
    const p = await where($)
    if (typeof sid !== 'string' || !c.SID_RE.test(sid) || !p) return
    // v15.1: not awaited, so a slow store never holds the tick (reservedGet keeps the last good list meanwhile).
    void reservedGet($, sid).catch(() => undefined)
    // None of these may stop the cue path below: each logs its own failure.
    const lr = leadRestorePending.get(sid)
    if (lr) {
      const r = await withTimeout($, leadRestore($, sid, lr.hint, lr.tries + 1), ACTION_TIMEOUT_MS).catch(() => 'error' as const)
      if (r === 'timeout' || r === 'error') await log($, sid, 'error', `lead-restore-${r}`).catch(() => undefined)
    }
    // v15: a pending conductor restore, and a running conductor's reach and saved grant.
    await conductorTick($, sid).catch(() => log($, sid, 'error', 'conductor-tick').catch(() => undefined))
    // ADR 0004: close the requests of sessions that are gone, and any older than a day.
    await promptCloseTick($).catch(() => log($, sid, 'error', 'prompt-close').catch(() => undefined))
    await promptSweep($).catch(() => log($, sid, 'error', 'prompt-sweep').catch(() => undefined))
    // v15.3: a pending manager restore, and a running manager's saved grant.
    await managerTick($, sid).catch(() => log($, sid, 'error', 'manager-tick').catch(() => undefined))
    // v13.1: the cut-compaction note.
    const cut = cmpCutPending.get(sid)
    if (cut !== undefined) await cmpCutTick($, sid, cut).catch(() => log($, sid, 'error', 'compact-cut').catch(() => undefined))
    if (grants.has(sid)) {
      // A grant restored at start has no lane-list watch yet; and the saved grant is rewritten once a day, with no store read.
      if (!watch.has(sid) && pinOf(sid) !== undefined) await watchInit($, sid).catch(() => log($, sid, 'error', 'lane-watch').catch(() => undefined))
      const savedAt = leadSavedAt.get(sid)
      // A lead's pin only (S1b review c1): a later non-lead grant must never save a lead hint without a pin.
      const pin = pinOf(sid)
      if (pin !== undefined && c.leadRefreshDue(savedAt, await $.clock.now())) await leadSave($, sid, pin)
      await presenceTouch($, sid).catch(() => log($, sid, 'error', 'presence').catch(() => undefined))
      await presencePrune($).catch(() => log($, sid, 'error', 'presence-prune').catch(() => undefined))
      await leadRenameTick($, sid).catch(() => log($, sid, 'error', 'lead-rename').catch(() => undefined))
      await watchTick($, sid).catch(() => log($, sid, 'error', 'lane-watch').catch(() => undefined))
      // ADR 0004: the notice of a prompt waiting, after the lanes-changed one (a tick submits at most once).
      await promptNoticeTick($, sid, submitsAtStart).catch(() => log($, sid, 'error', 'prompt-notice').catch(() => undefined))
      // v14 review c1: the lead's look for a live manager, once a minute; not awaited (as the check-in), so its reads never hold the tick. Review c2 (CR1):
      // a due look runs under a timeout (managerSeenStep).
      if (grants.get(sid)?.level === 'lead') void managerSeenStep($, sid as string).catch(() => undefined)
    }
    await unlockRetry($, sid).catch(() => log($, sid, 'error', 'unlock-retry').catch(() => undefined))
    await renameTick($, sid).catch(() => log($, sid, 'error', 'rename').catch(() => undefined))
    if (rebindPending.has(sid) && !rebindBusy.has(sid)) {
      rebindBusy.add(sid)
      const step = rebindTick($, sid).finally(() => rebindBusy.delete(sid))
      const r = await withTimeout($, step, ACTION_TIMEOUT_MS).catch(() => 'error' as const)
      if (r === 'timeout' || r === 'error') await log($, sid, 'error', `rebind-${r}`).catch(() => undefined)
    }
    const due = await sidSyncDue($, sid).catch(() => undefined)
    if (due) {
      const synced = await withTimeout($, sidSync($, sid, due), ACTION_TIMEOUT_MS).catch(() => 'error' as const)
      if (synced === 'timeout' || synced === 'error') await log($, sid, 'sid-heal-failed', synced).catch(() => undefined)
    }
    // The request step is guarded too: a step that throws on every tick must not keep the cue below from being claimed.
    try {
      const read = await $.state.get(request)
      const req = read.value as Request | null | undefined
      if (cmpMarked.has(sid) && req?.phase !== 'compacting') await cmpClear($, sid)
      if (req && c.requestExpired(req, await $.clock.now())) {
        // A compaction that returned without PostCompact is never confirmed: say so, instead of dropping it silently.
        // Cleared only if it is still the request read here: a PostCompact that landed meanwhile keeps its resume.
        if (req.phase === 'compacting') {
          const told = await withTimeout($, failRequest($, sid, 'compact-unconfirmed', true, read.version), ACTION_TIMEOUT_MS)
          if (told === 'timeout') await log($, sid, 'error', 'tick-timeout')
        } else await dropRequest($, sid, 'expired')
      } else if (req && req.phase === 'compacted') {
        // The engine refuses a submit from inside PostCompact (it would wait on the turn the hook holds), so the resume goes out from here.
        // It expires from the compaction time, not the request time, and the request is cleared before the submit so it can go out at most once.
        if ((await $.clock.now()) - (req.compactedMs ?? req.requestedMs) > RESUME_TTL_MS) await dropRequest($, sid, 'resume-expired')
        else if ((await sha($, req.continuation)) !== req.sha256) await dropRequest($, sid, 'hash-mismatch')
        else {
          const cur = await $.state.get(request)
          const live = cur.value as Request | null | undefined
          if (!live || live.phase !== 'compacted' || live.id !== req.id) await log($, sid, 'dropped', 'cancelled-before-resume')
          else if ((await $.prompt.read()).text !== '') await dropRequest($, sid, 'draft-in-box')
          else if (!(await requestOk($, sid, live))) await dropRequest($, sid, 'not-eligible')
          else if ((await $.state.set(request, null, { ifVersion: cur.version })).isSet === false) await log($, sid, 'dropped', 'cancelled-before-resume')
          else {
            const sent = await withTimeout($, submitOwn($, c.compactResumeText(req.continuation)).then(() => 'ok' as const, () => 'failed' as const), ACTION_TIMEOUT_MS)
            if (sent === 'ok') await log($, sid, 'resumed', 'compact')
            else await log($, sid, 'resume-failed', sent === 'timeout' ? 'unconfirmed' : 'compact')
          }
        }
      }
      if (req && req.phase === 'armed' && req.mode === 'now') {
        // A request made under the nudge grant keeps its way through every later step (it is the session's own, and only the mod's nudge granted it).
        if (!(req.viaNudge === true || (await isEligible($)))) await dropRequest($, sid, 'not-eligible')
        else {
        const done = await withTimeout($, doCompact($, sid, req, false), ACTION_TIMEOUT_MS)
        if (done === 'timeout') await log($, sid, 'error', 'tick-timeout')
        }
      }
      requestFails.delete(sid)
    } catch {
      await log($, sid, 'error', 'request').catch(() => undefined)
      const now = await $.clock.now()
      const f = requestFails.get(sid) ?? { n: 0, firstMs: now }
      const n = f.n + 1
      if (n < REQUEST_FAILS_MAX || now - f.firstMs < REQUEST_FAIL_SPAN_MS) requestFails.set(sid, { n, firstMs: f.firstMs })
      else {
        // Dropped; the count restarts whether or not the drop worked.
        requestFails.delete(sid)
        await dropRequest($, sid, 'request-failing').catch(() => log($, sid, 'error', 'request-drop').catch(() => undefined))
      }
    }
    nudge = true
    await sweepTaken($, sid, p).catch(() => log($, sid, 'error', 'taken-sweep').catch(() => undefined))
    const got = await claim($, sid, p)
    if (!got) return
    // Every exit from here on answers the lead, with the inode of the cue file it answers.
    const parsed = 'bad' in got ? undefined : c.parseCue(got.text)
    answer = answerer($, sid, parsed?.ok ? parsed.cue.verb : '-', got.ino)
    if ('bad' in got) {
      await answer('refused', got.bad)
      return await log($, sid, 'refused', got.bad)
    }
    if (!parsed!.ok) {
      await answer('refused', parsed!.reason)
      return await log($, sid, 'refused', parsed!.reason)
    }
    const done = await withTimeout($, handle($, sid, parsed!.cue, answer).finally(() => saveHint($, sid)), ACTION_TIMEOUT_MS)
    if (done === 'timeout') {
      await answer('held', 'timeout')
      await log($, sid, 'error', 'tick-timeout')
    }
    // A no-op once handle answered; a path that forgot to still answers.
    await answer('refused', 'other')
  } catch {
    if (typeof sid === 'string' && c.SID_RE.test(sid)) {
      await answer?.('refused', 'other').catch(() => undefined)
      await log($, sid, 'error', 'tick').catch(() => undefined)
    }
  } finally {
    // v13.4 (W2): stamped before the keepalive step, so a tick's own length is not read as a sleep by the next call. A tick that itself lasted past
    // SLEEP_GAP_MS may have spanned one (or hung): its gap gets no ping either way.
    try {
      const end = await $.clock.now()
      if (startedAt !== undefined && end - startedAt > c.SLEEP_GAP_MS) wokeAt = end
      lastTimerAt = end
    } catch {}
    if (nudge) {
      await nudgeTick($, sid as string).catch(() => log($, sid as string, 'error', 'nudge').catch(() => undefined))
      await keepaliveTick($, sid as string, submitsAtStart).catch(() => log($, sid as string, 'error', 'keepalive').catch(() => undefined))
      // v13.6: the lead check-in, after the ping, so the submits guard covers both. Only once a minute, for a lead: no timer is started on the other ticks.
      // Review c1 (W3): not awaited, so a slow observation never holds the tick (and the cue it claims); its own flag keeps one step at a time.
      const s = sid as string
      if (await checkinDue($, s).catch(() => false)) {
        checkinBusy.add(s)
        void withTimeout($, checkinTick($, s, submitsAtStart).finally(() => checkinBusy.delete(s)), ACTION_TIMEOUT_MS)
          .then((r) => (r === 'timeout' ? log($, s, 'error', 'checkin-timeout') : undefined), () => log($, s, 'error', 'checkin-error'))
          .catch(() => undefined)
      }
    }
    isTicking = false
  }
}

// The steps every lead tool shares: main agent, grant, the lane list, the live registry.
const SUBAGENT = ['subagent', 'for the main agent only.'] as const
async function leadBase($: any, e: unknown, sid: string) {
  if ((e as { agentId?: string }).agentId !== undefined) return { err: SUBAGENT }
  // v14 (2026-11-04): the manager has five tools (c.MANAGER_TOOLS; six since v14.1, 2026-11-04); every other lane tool refuses it, declared or not.
  if (grantOf(sid)?.level === 'manager' && !c.MANAGER_TOOLS.includes(String((e as { tool?: unknown }).tool))) return { err: ['manager-tool', c.REASON_TEXT['manager-tool']] as const }
  // v15: the conductor has three (c.CONDUCTOR_TOOLS).
  if (grantOf(sid)?.level === 'conductor' && !c.CONDUCTOR_TOOLS.includes(String((e as { tool?: unknown }).tool))) return { err: ['conductor-tool', c.REASON_TEXT['conductor-tool']] as const }
  return leadCore($, sid)
}

async function leadCore($: any, sid: string) {
  if (!grants.has(sid)) return { err: ['off', 'the lead tools are off. Ask the person to turn them on.'] as const }
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return { err: [lanes, lanes] as const }
  const live = await registryEntries($)
  if (!live) return { err: ['registry-unreadable', c.REASON_TEXT['registry-unreadable']] as const }
  // Read after the awaits (S1a review c1): an off meanwhile is refused here, not met later as a missing pin.
  const held = grantOf(sid)
  if (!held) return { err: ['off', 'the lead tools are off. Ask the person to turn them on.'] as const }
  // The effective grant (S2): its name is read from the live registry now; the stored name is only a cache. No name ('') reaches only lanes that name no lead.
  // v14: a manager's reach ignores the name, and its name is a reserved one (which c.leadNameOf never gives): it keeps the grant's.
  let g: c.Grant = held.level === 'lead' ? { ...held, name: c.leadNameOf(live.map((r) => r.j), sid) ?? '' } : held
  // v15 (2.1 #3): a conductor's pins are read now: the list file, resolved, intersected with the approved list (a read that parses also ratchets it).
  if (held.level === 'conductor') {
    const reach = await conductorReach($, sid)
    const now = grantOf(sid)
    if (now?.level !== 'conductor' || ('no' in reach && reach.no === 'off')) return { err: ['off', 'the lead tools are off. Ask the person to turn them on.'] as const }
    if ('no' in reach) return { err: ['conductor-list', c.REASON_TEXT['conductor-list']] as const }
    g = { ...now, pins: reach.pins }
  }
  // v13.6: a lane this read finds live counts as seen live for the check-in's gone.
  const seen = laneObs.get(sid)
  if (seen) {
    const entries = live.map(regEntry)
    for (const l of lanes) if (c.inReach(g, l) && c.laneSession(entries, l, sid).ok) seen.set(l.name, { ...(seen.get(l.name) ?? { goneN: 0 }), seenLive: true })
  }
  return { lanes, live, g }
}

// S6c: every other session's live conductor file that passes presenceCheck, with its registry name (c.laneLeadOf) or none; display only. A file that fails the
// check gives no box; a leads folder that cannot be read is 'error' (the list is drawn flat).
async function conductorsLive($: any, live: RegRow[], except: string): Promise<c.ConductorView[] | 'error'> {
  const d = await presenceNames($)
  if (d === 'none') return []
  if (d === 'error') return 'error'
  const rows = live.map((r) => r.j)
  const out: c.ConductorView[] = []
  for (const s of d.names) {
    if (s === except) continue
    const f = await presenceCheck($, d.p, live, s, (x) => x.level === 'conductor')
    if (typeof f === 'string' || f.level !== 'conductor') continue
    const name = c.laneLeadOf(rows, s)?.name
    out.push({ ...(name ? { name } : {}), repos: f.repos })
  }
  return out
}

// Display only: the live leads a conductor (the repos it lists) or the manager (every repo) reaches, each with its registry name, so a lead with no lanes is listed.
// Each presence file passes leadFileOk, the checks every lead lookup uses (fresh, registry row, start time, claude process, repo a git root); a lead without a
// usable name is left out (no lane can name it either). A lead's own list never asks. Any read that fails leaves the leads out, as for a lead that is gone.
async function leadsInReach($: any, live: RegRow[], g: c.Grant): Promise<c.LiveLead[]> {
  if (g.level === 'lead') return []
  const rows = live.map((r) => r.j)
  const out: c.LiveLead[] = []
  for (const lf of await leadsFor($, live, undefined, undefined, undefined, g.level === 'manager' ? undefined : (r) => g.pins.includes(r))) {
    const name = c.leadNameOf(rows, lf.sid)
    if (name !== undefined) out.push({ name, repo: lf.repo })
  }
  return out
}

// The table behind both lane_list and `/callboard lanes`, so the two cannot drift.
async function laneTable($: any, sid: string) {
  const base = await leadCore($, sid)
  if ('err' in base) return { err: base.err }
  // S6c (Q6): the manager's list puts each live conductor's repos inside its Conductor box.
  const conductors = base.g.level === 'manager' ? await conductorsLive($, base.live, sid).catch(() => 'error' as const) : undefined
  const leads = await leadsInReach($, base.live, base.g).catch(() => [])
  const text = c.laneListText(base.lanes.filter((l) => c.inReach(base.g, l)), base.live.map(regEntry), await $.clock.now(), { level: base.g.level, name: base.g.name, conductors, leads })
  // A lead's own list shows only the lanes that name it; the ones that name a lead no live session carries are told by name, for the person's /callboard claim.
  const orphans = (await claimLanes($, base.live, base.lanes, base.g, sid).catch(() => [])).map((l) => l.name)
  return { text: orphans.length > 0 ? `${text}\n\n${c.CLAIM_HINT(orphans)}` : text }
}

// ---- v13.6 (live 2026-11-03): lead check-ins and the shared attention notice ----
// Once a minute, whatever the idle gates, a lead observes the lanes in its reach (lanes and registry only, no reports) into laneObs. A lane gone, waiting on a
// prompt 5 min or quiet 30 min (c.checkinItems) and not yet told is then checked against the timing gates: check-ins on, not paused, no wake in the last 30 min,
// the lead idle 20 min since its last turn ended or its last prompt. Only then are reports read (signed done drops gone and quiet), and attentionNotice sends.
// A read that fails (lanes, registry, off) is no observation at all, never "all gone".
const laneObs = new Map<string, Map<string, c.LaneObs>>()
const obsAt = new Map<string, number>()
const attnTold = new Map<string, Set<string>>()
const attnCapped = new Set<string>()
const checkinBusy = new Set<string>()
// v14 (2026-11-04, review c2, CR3): the manager's per-repo lead verdicts, kept across evaluations (by the manager's session id; dropped with the grant).
// v14.1 (2026-11-04, review c3; PR review): evaluations land 60-62 s apart, so the window spans one of them plus a margin: a verdict is reused once and read
// again at the evaluation after, so leads are read about every 2 min and a gone lead is seen at most ~2 min late (130 s made it ~3 min).
const leadlessSeen = new Map<string, Map<string, { at: number; leads: c.LeadFile[] | 'held' }>>()
const LEADLESS_KEEP_MS = c.CHECKIN_EVERY_MS + 10_000
const OBS_CLEAR_TOOLS = ['terminate', 'retire', 'park', 'unpark', 'resume'].map((v) => `mcp__callboard__lane_${v}`)
// A lead's observation is due once a minute; the stamp is taken here, so a step that fails or times out waits for the next minute.
async function checkinDue($: any, sid: string): Promise<boolean> {
  // v14 (2026-11-04): the manager too, over the lanes no live lead reaches. v15 (Q4): never a conductor.
  if (!grants.has(sid) || grants.get(sid)?.level === 'conductor') return false
  const now = await $.clock.now()
  const last = obsAt.get(sid)
  if (last !== undefined && now >= last && now - last < c.CHECKIN_EVERY_MS) return false
  obsAt.set(sid, now)
  // Review c2 (N4): the last step has not settled (an engine read that hangs): no new one; logged once per stall (the log keeps one line per event and reason).
  if (checkinBusy.has(sid)) {
    await log($, sid, 'checkin-stalled').catch(() => undefined)
    return false
  }
  return true
}
async function checkinTick($: any, sid: string, submitsAtStart: number) {
  const now = await $.clock.now()
  const ep = epochOf(sid)
  const base = await leadCore($, sid)
  // Review c1 (W5): a lead that had a name and has no usable one now (a twin row, a rename, a reserved name) sees only legacy lanes for a while: no observation,
  // as for a failed read. Review c2 (B1): a lead that never had a name (a lone lead may stay unnamed) is observed as usual.
  if ('err' in base || (base.g.level === 'lead' && base.g.name === '' && (grants.get(sid)?.name ?? '') !== '') || epochOf(sid) !== ep) return
  const entries = base.live.map(regEntry)
  const prev = laneObs.get(sid) ?? new Map<string, c.LaneObs>()
  // Parked lanes are skipped: someone stopped them on purpose.
  const obs = new Map<string, c.LaneObs>()
  for (const l of base.lanes) if (l.parked === undefined && c.inReach(base.g, l)) obs.set(l.name, c.observeLane(prev.get(l.name), l, entries, sid, now))
  laneObs.set(sid, obs)
  const items = c.checkinItems(obs, now)
  // The told set keeps only conditions that still hold: one that cleared and comes back has a new since.
  const told = attnTold.get(sid) ?? new Set<string>()
  attnTold.set(sid, told)
  const keys = new Set(items.map(c.checkinKey))
  for (const k of told) if (!keys.has(k)) told.delete(k)
  const owed = items.filter((i) => !told.has(c.checkinKey(i)))
  if (owed.length === 0) return
  if (!(await cfgGet($, sid)).checkin) return
  const pause = (await $.state.get(checkinPauseRef)).value
  if (typeof pause === 'number' && pause > now) return
  if (wokeAt !== undefined && now - wokeAt < c.CHECKIN_WAKE_MS) return
  const turnEnd = (await $.state.get(turnEndRef)).value
  if (typeof turnEnd !== 'number' || now - Math.max(turnEnd, lastSubmitAt.get(sid) ?? 0) < c.CHECKIN_IDLE_MS) return
  // v14 (2026-11-04: "we follow hierarchy"): the manager is told only of lanes no live lead reaches, by leadHere's rule (a lane naming its lead: a live
  // lead of its repo with that registry name; a legacy lane: any live lead of its repo). The leads of a repo are read at most once per evaluation. A lane a lead
  // reaches is left untold, so it is told once its lead is gone. Review c1 (W2): the filter runs right after the timing gates, before the notice's own gate
  // reads, and a manager left with nothing owed stops here.
  // Review c2 (CR3): a repo's leads are kept LEADLESS_KEEP_MS across evaluations (leadlessSeen); a lead check that could not be made ('held': not clearly
  // gone) counts as a live lead of the repo, so no notice.
  const leadless = async (items: c.AttentionItem[]) => {
    const rows = base.live.map((r) => r.j)
    const byRepo = leadlessSeen.get(sid) ?? new Map<string, { at: number; leads: c.LeadFile[] | 'held' }>()
    leadlessSeen.set(sid, byRepo)
    const out: c.AttentionItem[] = []
    for (const i of items) {
      const l = base.lanes.find((x) => x.name === i.lane)
      if (!l?.repo) continue
      let seen = byRepo.get(l.repo)
      if (!seen || now < seen.at || now - seen.at > LEADLESS_KEEP_MS) {
        const errs = { error: false }
        const leads = await leadsFor($, base.live, l.repo, l.repo, errs)
        byRepo.set(l.repo, (seen = { at: now, leads: errs.error ? 'held' : leads }))
      }
      const leads = seen.leads
      if (leads !== 'held' && !(l.leadName !== undefined ? leads.some((x) => c.leadNameOf(rows, x.sid) === l.leadName) : leads.length > 0)) out.push(i)
    }
    return out
  }
  const mine = base.g.level === 'manager' ? await leadless(owed) : owed
  if (mine.length === 0) return
  // Signed done drops gone and quiet. Read only once the notice's own gates hold (review c1, W2); quiet by the live session's id, gone by the record's (W4).
  const signed = async (items: c.AttentionItem[]) => {
    const send: c.AttentionItem[] = []
    for (const i of items) {
      const l = base.lanes.find((x) => x.name === i.lane)
      if (i.code !== 'prompt' && l) {
        const r = await readReport($, l).catch(() => ({ no: 'report-read' }))
        // A lane signed done is told as done: its report is not read again while the condition holds.
        if (!('no' in r) && c.reportSigned(r.text, i.code === 'quiet' ? (obs.get(i.lane)?.sid ?? '') : l.sid)) {
          told.add(c.checkinKey(i))
          continue
        }
      }
      send.push(i)
    }
    return send
  }
  await attentionNotice($, sid, mine, submitsAtStart, ep, signed)
}

// The shared attention notice (§2a; PR 4 reuses it): the caller owns timing and pause, this owns the mechanical gates. One notice per key; the hourly cap is
// the lanes-changed notice's (a notice over it stays owed, logged once per capped stretch); a submit that throws puts its items back, one that times out does not.
// filter: the caller's own last reads (the check-in's report signatures), run only once the gates hold.
async function attentionNotice($: any, sid: string, items: c.AttentionItem[], submitsAtStart: number, ep: number, filter?: (items: c.AttentionItem[]) => Promise<c.AttentionItem[]>) {
  const told = attnTold.get(sid)
  if (!told) return
  const untold = (xs: c.AttentionItem[]) => xs.filter((i) => !told.has(c.checkinKey(i)))
  if (c.checkinText(untold(items)) === undefined || dialogOpen.has(sid) || submits !== submitsAtStart) return
  const sentAt = lastSubmitAt.get(sid)
  if ((await $.state.get(request)).value != null || (await $.state.get(nudgeDueRef)).value != null) return
  const capped = async () => {
    if (c.noticeAllowed(laneNotices.get(sid) ?? [], await $.clock.now(), c.LANES_NOTICES_PER_HOUR)) return false
    if (!attnCapped.has(sid)) {
      attnCapped.add(sid)
      await log($, sid, 'notice-capped', 'attention')
    }
    return true
  }
  if (await capped()) return
  if (await busyAgents($)) return
  const reg = ownRegOnce($)
  if ((await idleCheck($, sid, reg)) !== undefined) return
  if (!(await personRow($, sid, reg))) return
  if ((await backgroundShells($, sid, reg)) !== undefined) return
  const kept = filter ? await filter(untold(items)) : items
  // The reads since the first checks take time: a draft, a prompt, a dialog, a request or nudge, another submit or a grant change meanwhile wins. The cap and
  // the told set are read again (review c1, S3). Review c2 (N1, N2): every read comes before the last guard, so nothing is awaited between it and the submit.
  if (await capped()) return
  const now = await $.clock.now()
  if (dialogOpen.has(sid) || (await $.state.get(request)).value != null || (await $.state.get(nudgeDueRef)).value != null) return
  if ((await idleCheck($, sid, ownReg($))) !== undefined) return
  const draft = (await $.prompt.read()).text
  if (draft !== '' || dialogOpen.has(sid) || submits !== submitsAtStart || lastSubmitAt.get(sid) !== sentAt || !grants.has(sid) || epochOf(sid) !== ep) return
  const fresh = untold(kept)
  const text = c.checkinText(fresh)
  if (text === undefined) return
  const keys = fresh.map(c.checkinKey)
  for (const k of keys) told.add(k)
  attnCapped.delete(sid)
  cappedLogged.delete(sid)
  laneNotices.set(sid, [...(laneNotices.get(sid) ?? []).filter((t) => t <= now && now - t < c.HOUR_MS), now])
  const sent = await withTimeout($, submitOwn($, text, false).then(() => 'ok' as const, () => 'failed' as const), ACTION_TIMEOUT_MS)
  if (sent === 'failed') {
    turnKind.delete(sid)
    for (const k of keys) told.delete(k)
  }
  const codes = [...new Set(fresh.map((i) => i.code))].sort().join('+')
  await log($, sid, sent === 'ok' ? 'checkin' : sent === 'timeout' ? 'checkin-unconfirmed' : 'checkin-failed', `${codes}:${fresh.length}`)
}

// /callboard checkin pause <N>m|<N>h and checkin on: the person's own, as config (D3); a plugin, another session or a script gets a fixed refusal.
async function checkinCommand($: any, sid: string, code: c.OriginCode, op: c.CheckinOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: c.CHECKIN_USAGE }
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `checkin-not-person:${code}`).catch(() => undefined)
    return { text: c.CHECKIN_NOT_PERSON }
  }
  if (!grants.has(sid)) return { text: c.CHECKIN_NOT_LEAD }
  const now = await $.clock.now()
  const until = op === 'on' ? null : now + op.pauseMs
  if ((await $.state.set(checkinPauseRef, until))?.isSet === false) return { text: c.CHECKIN_UNSAVED }
  await log($, sid, 'checkin-pause', `${op === 'on' ? 'on' : `${op.pauseMs / 60_000}m`}:${code}`).catch(() => undefined)
  if (until !== null) return { text: c.checkinPausedText(until, now) }
  return { text: (await cfgGet($, sid)).checkin ? c.CHECKIN_ON_TEXT : c.CHECKIN_ON_BUT_OFF }
}

// ---- the rename carry and /callboard claim (see c.claimable) ----
// A lead that is renamed keeps the lanes its own session joined: once a lead's registry name (c.leadNameOf) differs from the one cached at its grant, the attached
// records of its repo that name its session id (adopted, lead == this session) and its old name take the new name, in one store write under the lock. A record it
// cannot prove is its own (a lane it made carries no lead session id; a lead that restarted has another session id) is left to /callboard claim. A rename that
// leaves no usable name carries nothing and keeps the old name cached, so the next valid name still finds the records. Checked at most every RENAME_CHECK_MS.
const RENAME_CHECK_MS = 10_000
const renameChecked = new Map<string, number>()
async function leadRenameTick($: any, sid: string) {
  const g = grantOf(sid)
  const epoch = epochOf(sid)
  if (g?.level !== 'lead' || g.name === '' || g.pins.length !== 1) return
  const now = await $.clock.now()
  const last = renameChecked.get(sid)
  if (last !== undefined && now >= last && now - last < RENAME_CHECK_MS) return
  renameChecked.set(sid, now)
  const live = await registryEntries($)
  if (!live) return
  const cur = c.leadNameOf(live.map((r) => r.j), sid)
  if (cur === undefined || cur === g.name) return
  const old = g.name
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return
  const mine = lanes.filter((l) => l.src !== undefined && l.repo === g.pins[0] && l.adopted === true && l.lead === sid && l.leadName === old)
  if (mine.length > 0) {
    const r = await ownWrite($, sid, () => editStore($, mine[0].src!, async (file) => {
      const parsed = file.state === 'ok' ? c.parseStore(file.text) : undefined
      if (!parsed) return { no: 'store-unreadable' }
      if (!parsed.ok) return { no: parsed.reason }
      const rows = await registryEntries($)
      if (!rows) return { no: 'registry-unreadable' }
      // The last checks before the write: the name is still the one seen, and this is still the same grant.
      if (c.leadNameOf(rows.map((x) => x.j), sid) !== cur || grantOf(sid)?.level !== 'lead' || epochOf(sid) !== epoch) return { no: 'changed' }
      const own = (l: c.Store['lanes'][number]) => l.adopted === true && l.lead === sid && l.leadName === old
      if (!parsed.store.lanes.some(own)) return { skip: true }
      const t = c.storeText({ ...parsed.store, lanes: parsed.store.lanes.map((l) => (own(l) ? { ...l, leadName: cur } : l)) })
      if ('no' in t) return t
      return { text: t.text, landed: (s) => !!s && !s.lanes.some(own) }
    })).catch(() => ({ no: 'store-busy' }))
    if ('no' in r) {
      await log($, sid, 'error', `lead-rename-carry ${r.no}`)
      return
    }
    if (r.text !== '') await log($, sid, 'lead-rename-carried', String(mine.length))
  }
  if (grants.get(sid) === g) grants.set(sid, { ...g, name: cur })
}

// The names of every live session but this one: a lead renamed only in letter case (Twin to TWIN) still has its made lanes to claim, and the registry already
// guarantees no other row carries its name in any case (c.leadNameOf).
const otherNames = (live: RegRow[], sid: string): string[] => live.flatMap((r) => (typeof r.j.name === 'string' && r.j.sessionId !== sid ? [r.j.name] : []))

// A claim is held back while another live lead of the repo has no usable name (its lanes would look like a gone lead's), or while the registry or the presence
// files cannot be read; undefined when it may go on. Run for the plan and again inside the store lock.
async function claimBlocked($: any, live: RegRow[], sid: string, pin: string): Promise<string | undefined> {
  const errs = { error: false }
  const leads = (await leadsFor($, live, pin, pin, errs)).filter((x) => x.sid !== sid)
  if (errs.error) return 'unreadable'
  const rows = live.map((r) => r.j)
  return leads.some((x) => c.leadNameOf(rows, x.sid) === undefined) ? 'other-unnamed' : undefined
}
// An attached record whose lead session is live is that lead's, whatever name it carries now.
const leadLiveFor = (live: RegRow[], l: { adopted?: true | boolean; lead?: string }, own: string): boolean => l.adopted === true && l.lead !== undefined && l.lead !== own && live.some((r) => r.j.sessionId === l.lead)
// The records /callboard claim would take now: claimable, minus an attached record whose lead is another live session and a lane the lead made that a live session carries.
async function claimLanes($: any, live: RegRow[], lanes: c.Lane[], g: c.Grant, sid: string): Promise<c.Lane[]> {
  const out: c.Lane[] = []
  for (const l of c.claimable(lanes, g, otherNames(live, sid))) if (!leadLiveFor(live, l, sid) && (l.adopted || (await laneLive($, live, l)) === undefined)) out.push(l)
  return out
}

// What /callboard claim would claim now: the lead's grant and name, and the claimable records of its one store. A record still names a lead no live session carries.
type ClaimPlan = { g: c.Grant; lanes: c.Lane[]; key: string; repo: string }
async function claimPlan($: any, sid: string): Promise<{ text: string } | ClaimPlan> {
  const base = await leadCore($, sid)
  if ('err' in base) return { text: base.err[0] === 'off' ? c.CLAIM_NOT_LEAD : c.CLAIM_UNREADABLE }
  if (base.g.level !== 'lead') return { text: c.CLAIM_NOT_LEAD }
  if (base.g.name === '') return { text: c.CLAIM_UNNAMED }
  const blocked = await claimBlocked($, base.live, sid, base.g.pins[0])
  if (blocked) return { text: blocked === 'unreadable' ? c.CLAIM_UNREADABLE : c.CLAIM_OTHER_UNNAMED }
  // A lane the lead made that a live session carries is left out: its stored hash would break (an attached record's does not hold the lead name).
  const lanes = await claimLanes($, base.live, base.lanes, base.g, sid)
  if (lanes.length === 0) return { text: c.CLAIM_NONE }
  // One repo has one store: every claimable record comes from it.
  return { g: base.g, lanes, key: lanes[0].src!, repo: base.g.pins[0] }
}

// /callboard claim: the person's own command (a prompt or the phone), in a lead. One dialog names the lanes, the lead names they carry and the claiming lead; a yes
// re-points those records at this lead's name, in one write inside the store lock (all or none). Each record is checked again there: it still names the same lead,
// that name is still carried by no live session, no live session carries a lane the lead made (its stored hash would break), and the grant is the same.
async function claimCommand($: any, sid: string, code: c.OriginCode, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `claim-not-person:${code}`).catch(() => undefined)
    return { text: c.CLAIM_NOT_PERSON }
  }
  const plan = await claimPlan($, sid)
  if ('text' in plan) return plan
  const epoch = epochOf(sid)
  const p = await where($)
  const names = plan.lanes.map((l) => l.name)
  const olds = [...new Set(plan.lanes.map((l) => l.leadName!))]
  const r = await askOnce($, sid, c.claimQuestion(names, plan.repo, olds, plan.g.name, p ? homeOf(p) : undefined), c.CLAIM_YES, c.CLAIM_NO, c.HEADER.claim)
  if (r === 'busy') return busy()
  if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'claim-not-confirmed')
    return { text: 'Cancelled. Nothing changed.' }
  }
  const again = await claimPlan($, sid)
  const same = !('text' in again) && again.key === plan.key && again.g.name === plan.g.name && again.lanes.map((l) => l.name).join() === names.join() && again.lanes.every((l, i) => l.leadName === plan.lanes[i].leadName)
  if (!same || epochOf(sid) !== epoch) return { text: c.claimRefusedText('changed') }
  const w = await ownWrite($, sid, () => editStore($, plan.key, async (file) => {
    const parsed = file.state === 'ok' ? c.parseStore(file.text) : undefined
    if (!parsed) return { no: 'store-unreadable' }
    if (!parsed.ok) return { no: parsed.reason }
    const rows = await registryEntries($)
    if (!rows) return { no: 'registry-unreadable' }
    const rowsJ = rows.map((x) => x.j)
    if (grantOf(sid)?.level !== 'lead' || epochOf(sid) !== epoch || c.leadNameOf(rowsJ, sid) !== plan.g.name) return { no: 'grant-changed' }
    const live = otherNames(rows, sid).map((n) => n.toLowerCase())
    const hit = new Set(names)
    const want = new Map(plan.lanes.map((l) => [l.name, l.leadName]))
    const recs = parsed.store.lanes.filter((l) => hit.has(l.name))
    if (recs.length !== names.length) return { no: 'changed' }
    const held = await claimBlocked($, rows, sid, plan.repo)
    if (held) return { no: held === 'unreadable' ? 'registry-unreadable' : 'other-lead-unnamed' }
    for (const l of recs) {
      if (l.leadName !== want.get(l.name) || live.includes(l.leadName!.toLowerCase()) || leadLiveFor(rows, l, sid)) return { no: 'changed' }
      if (!l.adopted) {
        const busyLane = await laneLive($, rows, l)
        if (busyLane) return { no: busyLane }
      }
    }
    const t = c.storeText({ ...parsed.store, lanes: parsed.store.lanes.map((l) => (hit.has(l.name) ? { ...l, leadName: plan.g.name } : l)) })
    if ('no' in t) return t
    return { text: t.text, landed: (s) => !!s && names.every((n) => s.lanes.some((l) => l.name === n && l.leadName === plan.g.name)) }
  })).catch(() => ({ no: 'store-busy' }))
  if ('no' in w) {
    await log($, sid, 'error', `claim-refused ${w.no}`)
    return { text: c.claimRefusedText(w.no) }
  }
  await log($, sid, 'lanes-claimed', String(names.length))
  return { text: c.claimedText(names, plan.g.name) }
}

// ...then the lane's repo; an attached lane answers whichever lead holds the repo.
async function leadPrep($: any, e: unknown, sid: string) {
  const base = await leadBase($, e, sid)
  if ('err' in base) return { err: base.err }
  const pick = c.leadLane(base.lanes, base.g, (e as { lane?: unknown }).lane)
  if (!pick.ok) return { err: [pick.reason, c.reasonWhy(pick.reason)] as const }
  return { lane: pick.lane, entries: base.live.flatMap((r) => (typeof r.j.sessionId === 'string' ? [regEntry(r)] : [])) }
}

// v14 (2026-11-04, S7): the live lead whose registry name (c.leadNameOf) is the tool's lane argument, in any repo, never this session. undefined: no live lead
// carries it (the caller goes on to the lanes). A lane record of the same name refuses lane-or-lead: lane and lead names follow the same rules (NAME_RE, not
// reserved), so the two can meet, and neither is taken over the other.
async function leadByName($: any, e: unknown, sid: string): Promise<{ sid: string; name: string } | { err: readonly [string, string] } | undefined> {
  const name = (e as { lane?: unknown }).lane
  if (typeof name !== 'string' || !c.NAME_RE.test(name)) return undefined
  const base = await leadBase($, e, sid)
  if ('err' in base) return { err: base.err }
  const rows = base.live.map((r) => r.j)
  const leads = (await leadsFor($, base.live, undefined)).filter((x) => x.sid !== sid && c.leadNameOf(rows, x.sid) === name)
  if (leads.length === 0) return undefined
  if (leads.length > 1 || base.lanes.some((l) => l.name === name)) return { err: ['lane-or-lead', c.reasonWhy('lane-or-lead')] }
  // v15 (F, Q3): a conductor compacts only a lead of its repos.
  if (base.g.level === 'conductor' && !base.g.pins.includes(leads[0].repo)) return { err: ['other-repo', c.reasonWhy('other-repo')] }
  return { sid: leads[0].sid, name }
}

// ---- /callboard lane: an existing session becomes a lane of the lead that runs in its repo ----
// leadName: the lead's registry name now (c.leadNameOf), stamped on the record so only that lead reaches the lane (S2); none leaves the record legacy.
// pick: the lead the person picked in the Join dialog when several run in the repo (S2b); without it several leads give { choices }.
type Plan = { name: string; rename: boolean; repo: string; lead: string; cwd: string; key: string; leadName?: string; pick?: string }
async function attachPlan($: any, sid: string, want: string | undefined, pick?: string): Promise<Plan | { no: string } | { choices: string[] }> {
  await reservedGet($, sid, true)
  if ((await $.state.get(lane)).value != null) return { no: 'already-bound' }
  if (grants.get(sid)?.level === 'manager') return { no: 'manager-holder' }
  // v15: nor a conductor, nor a session that was one since it started.
  if (grants.get(sid)?.level === 'conductor' || conductorRestorePending.has(sid)) return { no: 'conductor-holder' }
  if (conductorDeclared.has(sid)) return { no: 'lane-after-conductor' }
  // v14 (2026-11-04, review c2): nor a session that was the manager since it started (its manager tools stay declared), before the dialog and after a yes.
  if (managerDeclared.has(sid)) return { no: 'lane-after-manager' }
  if (grants.has(sid)) return { no: 'lead-holder' }
  const live = await registryEntries($)
  // Exactly one entry of this session: two live ones (a forged copy under a live pid) leave it unclear which name is the session's own.
  const mine = live?.filter((e) => e.j.sessionId === sid) ?? []
  if (mine.length > 1) return { no: 'session-duplicate' }
  const me = mine.length === 1 ? mine[0].j : undefined
  if (!live || !me) return { no: 'registry-unreadable' }
  // The session's current name, whatever set it (/rename, -n, a restore hook or an automatic title): the dialog shows the
  // name and the person confirms it, or answers no and passes NAME (2026-11-02).
  const own = typeof me.name === 'string' && me.name !== '' ? me.name : undefined
  const name = want ?? own
  if (name === undefined) return { no: 'pass-name' }
  if (!c.NAME_RE.test(name)) return { no: want === undefined ? 'own-name-bad' : 'name-bad' }
  if (c.reservedHit(name)) return { no: 'name-reserved' }
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return { no: lanes }
  // A live name in any letter case (S2): a lane `alpha` beside lead `Alpha` would make c.leadNameOf void the lead's name and strand its lanes.
  if (lanes.some((l) => l.name === name) || live.some((e) => typeof e.j.name === 'string' && e.j.name.toLowerCase() === name.toLowerCase() && e.j.sessionId !== sid)) return { no: 'name-taken' }
  const cwd = await sessionRoot($)
  // The checks on the session's own folder come before the lead (S2b), so they refuse before any dialog, the lead picker included.
  if ((await real($, cwd)) !== cwd) return { no: 'folder-bad' }
  if (!c.isSafeBrief(`${cwd}/${c.ATTACH_BRIEF}`)) return { no: 'folder-chars' }
  const found = await findLead($, live, cwd, pick)
  if (!('lead' in found)) return found
  // A dot folder below the repo (a Claude worktree under .claude/worktrees, .git) can never be a lane folder: parseStore refuses the whole store for such a record.
  if (c.dotBelow(found.lead.repo, cwd)) return { no: 'folder-dot' }
  const key = await sha($, found.lead.repo)
  if (lanes.filter((l) => l.src === key).length >= c.STORE_MAX_LANES) return { no: 'lane-cap' }
  const leadName = c.leadNameOf(live.map((e) => e.j), found.lead.sid)
  return { name, rename: name !== me.name, repo: found.lead.repo, lead: found.lead.sid, cwd, key, ...(leadName !== undefined ? { leadName } : {}), ...(pick !== undefined ? { pick } : {}) }
}

type Bound = { name: string; at?: number; turns?: number; restored?: boolean; adopted?: boolean; lead?: string; key?: string; rec?: string }

// The session's own record, removed under the store lock. With the binding's `rec` the record must be the very one the binding was made from (name, attached,
// and the hash of its text, which covers the folder, so a session that has since changed folder still finds it); without one (a session with no binding) the
// folder must be the session's own. true: it is gone, or was never there (an absent store is done). false: an attached record of that name is still there
// and is not ours, or the store could not be edited: never reported as done.
async function dropRecord($: any, name: string, key: string | undefined, rec: string | undefined, folder: string | undefined): Promise<boolean> {
  if (!key || !/^[0-9a-f]{64}$/.test(key) || (rec === undefined && folder === undefined)) return false
  const r = await editStore($, key, async (cur) => {
    if (cur.state === 'absent') return { skip: true }
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    const left: c.Store['lanes'] = []
    let hit = false
    for (const l of parsed.store.lanes) {
      const ours = l.name === name && l.adopted && (rec !== undefined ? await recMatch($, rec, l) : l.folder === folder)
      if (ours) hit = true
      else left.push(l)
    }
    if (!hit) return parsed.store.lanes.some((l) => l.name === name && l.adopted) ? { no: 'not-found' } : { skip: true }
    const text = JSON.stringify({ repo: parsed.store.repo, lanes: left.map(c.storeLaneJson), creates: parsed.store.creates.slice(-12) })
    return { text, landed: (s) => !!s && !s.lanes.some((l) => l.name === name && l.adopted) }
  })
  return 'text' in r
}

// A born store lane's record stops naming this session (v13), so a lane the person turned off does not come back by itself after a restart. The record is
// found by name and by the binding's hash (a born binding has no store key); it is changed only while it still names this session. true: nothing names this
// session any more, or nothing needed clearing; false: a record may still name it (the lanes or the store could not be read or written).
async function sidClear($: any, sid: string, b: Bound): Promise<boolean> {
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return false
  let rec: c.Lane | undefined
  for (const l of lanes) if (l.name === b.name && l.src && b.rec !== undefined && (await recMatch($, b.rec, l))) rec = l
  // No record of that name and hash: the lane was removed or changed. Only a record that still names this session could bring it back.
  if (!rec) return !lanes.some((l) => l.sid === sid)
  const key = rec.src!
  const r = await editStore($, key, async (cur) => {
    if (cur.state !== 'ok') return { no: 'store-unreadable' }
    const parsed = c.parseStore(cur.text)
    if (!parsed.ok) return { no: parsed.reason }
    let hit = false
    const lanes2: c.Store['lanes'] = []
    for (const l of parsed.store.lanes) {
      if (l.name === b.name && l.sid === sid && (await recMatch($, b.rec, l))) {
        hit = true
        lanes2.push({ ...l, sid: undefined, parked: undefined })
      } else lanes2.push(l)
    }
    if (!hit) return { skip: true }
    const t = c.storeText({ ...parsed.store, lanes: lanes2 })
    if ('no' in t) return t
    return { text: t.text, landed: (s) => !!s && !s.lanes.some((l) => l.name === b.name && l.sid === sid) }
  })
  if ('no' in r) return false
  if (r.text !== '') await log($, sid, 'sid-cleared')
  return true
}

// Clears the binding and its hint first, then removes an attached session's record (or clears a born store lane's sid): whatever the removal does, the session
// is unbound. whole false: the record could not be removed (the person is told to rename the session). sidKept: a born lane's record may still name this
// session, so it could become the lane again after a restart (the person is told).
// v13 review (F4): /callboard off in a session that is not bound: no store record may keep naming it, or a restart would rebind it into that lane.
async function sidClearAll($: any, sid: string): Promise<{ ok: boolean; name?: string }> {
  const lanes = await loadLanes($)
  if (typeof lanes === 'string') return { ok: false }
  const mine = lanes.filter((l) => l.sid === sid && l.src)
  if (mine.length === 0) return { ok: true }
  let ok = true
  for (const key of new Set(mine.map((l) => l.src!))) {
    const r = await editStore($, key, async (cur) => {
      if (cur.state !== 'ok') return { no: 'store-unreadable' }
      const parsed = c.parseStore(cur.text)
      if (!parsed.ok) return { no: parsed.reason }
      if (!parsed.store.lanes.some((l) => l.sid === sid)) return { skip: true }
      const t = c.storeText({ ...parsed.store, lanes: parsed.store.lanes.map((l) => (l.sid === sid ? { ...l, sid: undefined, parked: undefined } : l)) })
      if ('no' in t) return t
      return { text: t.text, landed: (st) => !!st && !st.lanes.some((l) => l.sid === sid) }
    })
    if ('no' in r) ok = false
    else if (r.text !== '') await log($, sid, 'sid-cleared')
  }
  if (!ok) await log($, sid, 'sid-uncleared')
  return { ok, name: mine[0].name }
}
async function detach($: any, sid: string, b: Bound): Promise<{ whole: boolean; sidKept: boolean }> {
  pendingRename.delete(sid)
  sidSynced.delete(sid)
  laneBrief.delete(sid)
  laneBriefed.delete(sid)
  const folder = b.adopted && b.rec === undefined ? ((await sessionRoot($).catch(() => undefined)) as string | undefined) : undefined
  await $.state.set(lane, null)
  // Again after the write: facts kept while it was in flight go too.
  laneBrief.delete(sid)
  laneBriefed.delete(sid)
  try {
    await $.store.delete(`${c.HINT_PREFIX}${sid}`)
  } catch {
    await log($, sid, 'error', 'hint-delete').catch(() => undefined)
  }
  lastSaved.delete(sid)
  const whole = !b.adopted || (await dropRecord($, b.name, b.key, b.rec, folder).catch(() => false))
  if (!whole) await log($, sid, 'detach-incomplete')
  // A born lane's record stays and loses its sid. An attached record is removed whole; when that failed, its sid is cleared instead (F3), so a restart cannot
  // rebind the session into it.
  const sidKept = (!b.adopted || !whole) && !(await sidClear($, sid, b).catch(() => false))
  if (sidKept) await log($, sid, 'sid-uncleared')
  return { whole, sidKept }
}

// An unbound session (its binding is gone, its record is not): the record is found by the session's own name and folder, never by a name alone, and never
// when another live session carries that name (it is that session's lane).
async function strayRecord($: any, sid: string): Promise<'none' | 'removed' | 'stuck' | 'unknown'> {
  const rows = await registryEntries($)
  if (!rows) return 'unknown'
  // Exactly one entry of this session: with two, the name could be a twin's, and a record would be removed on it.
  const mine = rows.filter((e) => e.j.sessionId === sid)
  if (mine.length > 1) return 'unknown'
  const name = mine[0]?.j.name
  const cwd = await sessionRoot($)
  if (typeof name !== 'string' || rows.some((e) => e.j.name === name && e.j.sessionId !== sid)) return 'none'
  for (const s of await loadStores($)) {
    if (!s.store.lanes.some((l) => l.name === name && l.adopted && l.folder === cwd)) continue
    return (await dropRecord($, name, s.key, undefined, cwd).catch(() => false)) ? 'removed' : 'stuck'
  }
  return 'none'
}

async function laneCommand($: any, sid: string, code: c.OriginCode, arg: c.CommandArg, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  const refuse = async (reason: string) => {
    await log($, sid, 'refused', reason)
    return { text: c.refusalText(reason) }
  }
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `lane-origin:${code}`)
    return { text: c.refusalText('lane-origin') }
  }
  const bound = (await $.state.get(lane)).value as Bound | null | undefined
  if (arg === 'lane-off') {
    if (!bound) {
      const stray = await strayRecord($, sid)
      return { text: stray === 'removed' ? 'Removed its leftover lane record.' : stray === 'stuck' ? c.DETACH_INCOMPLETE : stray === 'unknown' ? c.LANE_RECORD_UNKNOWN : `This session is not a lane. ${c.NO_LANE_RECORD}` }
    }
    const d = await detach($, sid, bound)
    return { text: d.whole ? `This session is no longer lane ${bound.name}.${bound.adopted ? '' : c.STOPPABLE_BY_NAME(bound.name)}${d.sidKept ? c.SID_KEPT(bound.name) : ''}` : `${c.DETACH_INCOMPLETE}${d.sidKept ? c.SID_KEPT(bound.name) : ''}` }
  }
  const seq = offSeq.get(sid) ?? 0
  const want = (arg as { lane: string | undefined }).lane
  // v13.5 (2026-11-03): the Restore fallback /callboard on had. An unbound session whose hint names a lane, with no restore decided yet, is asked
  // the Restore question first (restoreFromHint, every check as before). A restored lane or a question nobody answered ends here; no hint, a refused or a
  // declined restore goes on to Join.
  // A session that was the manager skips the Restore question: attachPlan refuses it (review c2). v15 PR review (#284): so does one that was a conductor.
  if (!bound && want === undefined && !restoredOnce.has(sid) && !managerDeclared.has(sid) && !conductorDeclared.has(sid)) {
    const now = await $.clock.now()
    if (c.parseHint(await $.store.get(`${c.HINT_PREFIX}${sid}`).catch(() => undefined), now)?.lane) {
      if (dialogOpen.has(sid)) return busy()
      dialogOpen.add(sid)
      let asked: 'timed-out' | void
      try {
        asked = await restoreFromHint($, sid, now, () => (offSeq.get(sid) ?? 0) !== seq)
      } catch {
        await log($, sid, 'error', 'restore').catch(() => undefined)
      } finally {
        dialogOpen.delete(sid)
      }
      if ((offSeq.get(sid) ?? 0) !== seq) {
        await log($, sid, 'refused', 'off-meanwhile')
        return { text: 'Nothing changed: callboard was turned off meanwhile.' }
      }
      if (asked === 'timed-out') return { text: `Nothing changed: ${c.TIMED_OUT}.` }
      const got = (await $.state.get(lane)).value as Bound | null | undefined
      if (got) {
        // As /callboard on did after a restore: the hint takes the restored binding and the merged counters at once.
        await saveHint($, sid)
        return { text: c.reboundToast(got.name) }
      }
    }
  }
  const first = await attachPlan($, sid, want)
  if ('no' in first) return refuse(first.no)
  // With several leads the person picks one first (S2b): the picker and the Join question hold one dialog slot together.
  if (dialogOpen.has(sid)) return busy()
  dialogOpen.add(sid)
  let plan: Plan
  let r: Asked
  try {
    if ('choices' in first) {
      const picked = await pickLead($, first.choices)
      if (picked === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
      if (picked === 'error') {
        await log($, sid, 'refused', 'attach-not-confirmed')
        return { text: 'Cancelled. Nothing changed.' }
      }
      const p = await attachPlan($, sid, want, picked.name)
      if (!('name' in p)) return refuse('no' in p ? p.no : 'changed')
      plan = p
    } else plan = first
    r = await ask($, c.attachQuestion(plan.name, c.folderName(plan.cwd), c.folderName(plan.repo), plan.rename, plan.pick), c.ATTACH_YES, c.ATTACH_NO, c.HEADER.attach)
  } finally {
    dialogOpen.delete(sid)
  }
  if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'attach-not-confirmed')
    return { text: 'Cancelled. Nothing changed.' }
  }
  if ((offSeq.get(sid) ?? 0) !== seq) {
    await log($, sid, 'refused', 'off-meanwhile')
    return { text: 'Nothing changed: callboard was turned off meanwhile.' }
  }
  // The question stayed open for a while: the same facts must still hold, and the same lead, repo, folder and name. A picked lead is looked for by its name.
  const now2 = await attachPlan($, sid, want, plan.pick)
  if ('no' in now2) return refuse(now2.no)
  if ('choices' in now2) return refuse('changed')
  if (now2.name !== plan.name || now2.rename !== plan.rename || now2.lead !== plan.lead || now2.leadName !== plan.leadName || now2.repo !== plan.repo || now2.cwd !== plan.cwd) return refuse('changed')
  // From here until the binding is written, no lead grant may start, and none may be under way.
  if (leadBusy(sid)) return refuse('lead-holder')
  if (laneBinding.has(sid)) return refuse('already-bound')
  laneBinding.add(sid)
  try {
    const now = await $.clock.now()
    // The record names this session (sid, v13), so the lane rebinds itself when the session starts again; sid is not part of the record's hash.
    const rec: c.Lane & { createdAt: number } = { name: plan.name, folder: plan.cwd, brief: `${plan.cwd}/${c.ATTACH_BRIEF}`, repo: plan.repo, createdAt: now, adopted: true, lead: plan.lead, sid, ...(plan.leadName !== undefined ? { leadName: plan.leadName } : {}) }
    const recHash = await sha($, c.recordText(rec))
    const w = await editStore($, plan.key, async (cur) => {
      if (cur.state === 'bad') return { no: 'store-unreadable' }
      const parsed = cur.state === 'ok' ? c.parseStore(cur.text) : undefined
      if (parsed && !parsed.ok) return { no: parsed.reason }
      const st = parsed?.ok ? parsed.store : undefined
      if (st && st.repo !== plan.repo) return { no: 'store-repo' }
      // As lane_create: a record whose folder no longer resolves is invisible to every reader and is dropped here.
      const kept = st ? await keptLanes($, st.lanes) : []
      if (kept.some((l) => l.name === plan.name)) return { no: 'name-taken' }
      if (kept.length >= c.STORE_MAX_LANES) return { no: 'lane-cap' }
      // The lead's name is read again under the lock (S2): a lead renamed since the re-check must not be stamped with its old name.
      const rows = await withTimeout($, registryEntries($), c.ENGINE_CALL_TIMEOUT_MS)
      if (rows === 'timeout' || !rows) return { no: 'registry-unreadable' }
      if (c.leadNameOf(rows.map((e) => e.j), plan.lead) !== plan.leadName) return { no: 'changed' }
      // An attached lane is not a create: the creates list is carried over as it was.
      const text = JSON.stringify({ repo: plan.repo, lanes: [...kept, rec].map(c.storeLaneJson), creates: st?.creates ?? [] })
      if (text.length > c.STORE_MAX_BYTES) return { no: 'store-size' }
      return { text, landed: (s) => !!s?.lanes.some((l) => l.name === plan.name && l.adopted && l.lead === plan.lead && l.leadName === plan.leadName && l.folder === plan.cwd) }
    })
    const undo = () => dropRecord($, plan.name, plan.key, recHash, undefined).catch(() => false)
    if ('no' in w) {
      // The write went through but the file does not show it: the record may be there, and nothing is bound to it.
      if (!w.wrote) return refuse(w.no)
      await log($, sid, 'refused', w.no)
      return { text: `Lane not changed: the record was not saved. ${(await undo()) ? 'It was removed.' : c.DETACH_INCOMPLETE}` }
    }
    // /callboard off during the write: the record goes again, and nothing is bound.
    if ((offSeq.get(sid) ?? 0) !== seq) {
      await undo()
      await log($, sid, 'refused', 'off-meanwhile')
      return { text: 'Nothing changed: callboard was turned off meanwhile.' }
    }
    const binding = { name: plan.name, at: now, turns: -1, rec: recHash, adopted: true, lead: plan.lead, key: plan.key }
    let written = false
    // Each engine call held inside the mark has a time limit (the command itself has none): a call that times out takes the failure path below.
    const limited = async <T,>(p: Promise<T>, what: string): Promise<T> => {
      const r = await withTimeout($, p, c.ENGINE_CALL_TIMEOUT_MS)
      if (r === 'timeout') {
        await log($, sid, 'error', `attach-${what}-timeout`).catch(() => undefined)
        throw new Error(`${what}-timeout`)
      }
      return r
    }
    try {
      await limited(bump($, (ct) => ({ ...ct, startDone: true })), 'counters')
      written = true
      const setting = $.state.set(lane, binding)
      const bw = await limited(setting, 'bind').catch((err: unknown) => {
        // A write that timed out may still land after the detach below: it is undone then.
        if (err instanceof Error && err.message === 'bind-timeout') undoLate($, sid, setting, binding)
        throw err
      })
      if (bw?.isSet !== false) await withTimeout($, keepLaneFacts($, sid, rec, true, plan.lead), c.ENGINE_CALL_TIMEOUT_MS)
      // An off that landed while the binding was being set could not unbind it: it ran before there was one.
      if ((offSeq.get(sid) ?? 0) !== seq) {
        await withTimeout($, detach($, sid, binding), c.ENGINE_CALL_TIMEOUT_MS)
        await log($, sid, 'refused', 'off-meanwhile')
        return { text: 'Nothing changed: callboard was turned off meanwhile.' }
      }
      await limited(saveHint($, sid), 'hint')
    } catch {
      await log($, sid, 'error', 'attach-bind').catch(() => undefined)
      // From the binding write on, it may be there: detach clears it, its hint and the briefing facts, and takes the record back; undo is the fallback for the record.
      // The detach has the same time limit: a timeout counts as not done, and undo takes the record back.
      if (!written || (await withTimeout($, detach($, sid, binding).then((d) => d.whole, () => false), c.ENGINE_CALL_TIMEOUT_MS)) !== true) await undo()
      return { text: 'Lane not changed: the session could not be bound.' }
    }
    await withTimeout($, briefLane($, sid), c.ENGINE_CALL_TIMEOUT_MS)
    if (plan.rename) pendingRename.set(sid, { name: plan.name, until: now + c.RENAME_PENDING_MS })
    await log($, sid, 'attached', plan.name)
    toast($, `Lane ${plan.name} joined`)
    return { text: c.attachedText(plan.name, c.folderName(plan.cwd), c.folderName(plan.repo), plan.rename) }
  } finally {
    laneBinding.delete(sid)
  }
}

// ---- v14 (live 2026-11-03/04): /callboard manager [NAME] ----
// Any origin, as /callboard lead: the dialog is the gate the person answers, and another origin is named in its question. Refused before the dialog and again
// after a yes: in a bound lane, in a lead, in a session that ever was a lead (its lane tools stay declared: manager-after-lead), and while another live
// session holds a valid manager file (manager-exists). The grant lives in memory, and since v15.3 the person's yes also saves manager:<sid> (managerSave), so the
// same conversation asks again when it starts or resumes (managerRestoreAsk runs this function with restore set: the restore question, and its own log lines).
// After the grant the presence file must be written (one per machine rests on it), and a second manager that won the same moment makes both step back.
async function managerCommand($: any, sid: string, code: c.OriginCode, want: string | undefined, busy: () => Promise<{ text: string }>, restore = false, alive: () => boolean = () => true): Promise<{ text: string }> {
  await reservedGet($, sid, true)
  // v14.1 (2026-11-04): with no NAME, a session whose registry name (one row) is already reserved keeps it; otherwise MANAGER. An unreadable registry
  // gives MANAGER here and is refused by the check below.
  const own = want === undefined ? ((await registryEntries($).catch(() => undefined)) ?? []).filter((e) => e.j.sessionId === sid) : []
  const name = want ?? (own.length === 1 && c.managerNameRefusal(own[0].j.name) === undefined ? (own[0].j.name as string) : c.MANAGER_DEFAULT)
  const refuse = async (why: string) => {
    await log($, sid, restore ? 'manager-restore-rejected' : 'refused', why)
    return { text: c.managerRefusalText(why) }
  }
  if (c.managerNameRefusal(name)) return refuse('manager-name')
  // Review c1 (S10): another NAME changes nothing, and the answer says so.
  const cur = grants.get(sid)
  if (cur?.level === 'manager') return { text: c.managerAlreadyText(cur.name, want) }
  // marks: the lane and lead marks are this call's to read, not its own (the re-check below runs while it holds leadGranting).
  const held = async (marks: boolean): Promise<string | undefined> => {
    if ((marks && laneBinding.has(sid)) || (await $.state.get(lane)).value != null) return 'lane-holder'
    // v15: a conductor (or one being restored), and a session that was one.
    if (grants.get(sid)?.level === 'conductor' || conductorRestorePending.has(sid)) return 'conductor-holder'
    if (grants.has(sid) || (marks && leadGranting.has(sid)) || leadRestorePending.has(sid)) return 'lead-holder'
    if (leadDeclared.has(sid)) return 'manager-after-lead'
    if (conductorDeclared.has(sid)) return 'manager-after-conductor'
    const live = await registryEntries($)
    if (!live) return 'registry-unreadable'
    return (await managersLive($, live, sid)).length > 0 ? 'manager-exists' : undefined
  }
  const before = await held(true)
  if (before) return refuse(before)
  // A restore whose pending entry went while these checks ran (an /callboard off, a manager grant by hand) asks nothing.
  if (restore && !alive()) return { text: '' }
  const seq = offSeq.get(sid) ?? 0
  const r = await askOnce($, sid, restore ? c.MANAGER_RESTORE_QUESTION : c.askedFrom(c.MANAGER_QUESTION, code), c.MANAGER_YES, c.MANAGER_NO, c.HEADER.manager)
  if (r === 'busy') return busy()
  // A restore: only the person's Cancel removes the saved grant; no answer (a timeout, a dismissal, an error) restores nothing and keeps it.
  if (restore && r !== 'yes') {
    if (r === 'no') {
      await Promise.resolve($.store.delete(`${c.MANAGER_HINT_PREFIX}${sid}`)).catch(() => log($, sid, 'error', 'manager-hint-delete').catch(() => undefined))
      await log($, sid, 'manager-restore-cancelled')
    } else {
      await log($, sid, 'manager-restore-unanswered')
      toast($, c.MANAGER_UNANSWERED_TOAST)
    }
    return { text: 'Manager stays off.' }
  }
  if (r === 'timed-out') {
    await timedOut($, sid)
    return { text: `Manager stays off. ${c.TIMED_OUT_SENTENCE}` }
  }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'manager-not-confirmed')
    return { text: 'Manager stays off.' }
  }
  // The post-click re-check, as the lead's: the marks are read and set with no await between.
  if (restore && !alive()) return refuse('changed')
  if (laneBinding.has(sid) || leadGranting.has(sid)) return refuse(laneBinding.has(sid) ? 'lane-holder' : 'lead-holder')
  leadGranting.add(sid)
  let grantEpoch = -1
  try {
    const after = await withTimeout($, held(false), c.ENGINE_CALL_TIMEOUT_MS)
    if (restore && !alive()) return refuse('changed')
    if (after !== undefined) return refuse(after === 'timeout' ? 'manager-check-slow' : after)
    if ((offSeq.get(sid) ?? 0) !== seq) {
      await log($, sid, 'refused', 'off-meanwhile')
      return { text: 'Nothing changed: callboard was turned off meanwhile.' }
    }
    let set: unknown
    try {
      set = await withTimeout($, managerTools($, sid), c.ENGINE_CALL_TIMEOUT_MS)
    } catch {
      set = 'error'
    }
    if (set !== undefined || (offSeq.get(sid) ?? 0) !== seq) {
      await log($, sid, 'error', set === undefined ? 'off-meanwhile' : `manager-register-${set}`).catch(() => undefined)
      return { text: c.MANAGER_FAILED }
    }
    grants.set(sid, { level: 'manager', pins: [], name })
    grantEpoch = epochOf(sid)
    // A grant the person made while a restore question was still pending stands; the pending restore ends here.
    managerRestorePending.delete(sid)
  } finally {
    leadGranting.delete(sid)
  }
  await presenceDrop($, sid).catch(() => undefined)
  const wrote = await presenceTouch($, sid).catch(() => false)
  const stepBack = async (why: string) => {
    if (epochOf(sid) === grantEpoch) await leadDrop($, sid)
    if (why !== 'manager-presence') return refuse(why)
    await log($, sid, 'error', why)
    return { text: c.MANAGER_FAILED }
  }
  if (epochOf(sid) !== grantEpoch) return { text: 'Manager is now off.' }
  if (wrote !== true) return stepBack('manager-presence')
  const live = await registryEntries($)
  if (!live) return stepBack('registry-unreadable')
  if ((await managersLive($, live, sid)).length > 0) return stepBack('manager-exists')
  if (epochOf(sid) !== grantEpoch) return { text: 'Manager is now off.' }
  await managerSave($, sid)
  if (epochOf(sid) !== grantEpoch) return { text: 'Manager is now off.' }
  await log($, sid, restore ? 'manager-restored' : 'manager-on', restore ? '' : code)
  if (restore) toast($, c.MANAGER_RESTORED_TOAST)
  await briefLead($, sid, '', name)
  // The rename cannot run inside the command: the tick runs it (as attach), unless the session already carries the name (a launch with -n NAME).
  const mine = live.filter((e) => e.j.sessionId === sid)
  if (mine.length === 1 && mine[0].j.name === name) await log($, sid, 'rename-skipped', 'manager')
  else pendingRename.set(sid, { name, until: (await $.clock.now()) + c.RENAME_PENDING_MS, manager: true })
  colorLater($, sid, grantEpoch)
  return { text: c.MANAGER_ON_TEXT }
}

// v15.3 (2026-11-06): the saved manager grant, manager:<sid> = { name, savedAt }: written at the person's yes and once a day while the manager runs; removed by
// leadDrop (off) and by a Cancel on the restore question. A failed write is logged and tried again a day later; a drop while the write was in flight deletes the
// key again.
const managerSavedAt = new Map<string, number>()
// /callboard off: the pending restore and the saved grant go. Resolves false when the delete failed (the reply then says the manager may come back).
async function managerForget($: any, sid: string): Promise<boolean> {
  managerRestorePending.delete(sid)
  try {
    await $.store.delete(`${c.MANAGER_HINT_PREFIX}${sid}`)
    return true
  } catch {
    await log($, sid, 'error', 'manager-hint-delete').catch(() => undefined)
    return false
  }
}
async function managerSave($: any, sid: string) {
  const epoch = epochOf(sid)
  const g = grants.get(sid)
  if (g?.level !== 'manager') return
  const now = await $.clock.now()
  if (epochOf(sid) !== epoch) return
  managerSavedAt.set(sid, now)
  const key = `${c.MANAGER_HINT_PREFIX}${sid}`
  try {
    await $.store.set(key, { name: g.name, savedAt: now })
  } catch {
    await log($, sid, 'manager-unsaved').catch(() => undefined)
  }
  if (epochOf(sid) !== epoch || grants.get(sid)?.level !== 'manager') await Promise.resolve($.store.delete(key)).catch(() => log($, sid, 'error', 'manager-hint-delete').catch(() => undefined))
}

// A session whose saved manager grant is there when it starts is asked once whether to restore it, as the conductor's widened list is (conductorRestoreAsk): only
// in a person's session (a registry row of kind interactive: never a --bg worker), and only once the session is idle with an empty prompt box. A session that
// still holds the grant in memory (a compaction) is never asked. Manager: the usual grant with every usual check again after the yes (one per Mac, a reserved
// name, not a lane, lead or conductor). Cancel: the saved grant goes. No answer: it stays, nothing is restored. A check that fails: logged, nothing restored, the
// saved grant stays. The tries count only the ticks before the registry shows the session's own row.
const MANAGER_RESTORE_TRIES = 15
type MgrPending = { hint: c.ManagerHint; tries: number; asking?: boolean }
const managerRestorePending = new Map<string, MgrPending>()
// A restore is offered once per process and session: a session.start that is not a start (a compaction, a reload) never asks again.
const managerRestoreOffered = new Set<string>()
async function managerRestoreAsk($: any, me: string, pend: MgrPending) {
  let busy = false
  pend.asking = true
  try {
    await managerCommand($, me, 'prompt', pend.hint.name, async () => {
      busy = true
      return { text: '' }
    }, true, () => managerRestorePending.get(me) === pend)
  } finally {
    pend.asking = false
  }
  // A question already open asks again at the next idle tick; every other end is final for this start.
  if (!busy && managerRestorePending.get(me) === pend) managerRestorePending.delete(me)
}
async function managerTick($: any, sid: string) {
  if (grants.get(sid)?.level === 'manager') {
    managerRestorePending.delete(sid)
    if (c.leadRefreshDue(managerSavedAt.get(sid), await $.clock.now())) await managerSave($, sid)
    return
  }
  const pend = managerRestorePending.get(sid)
  if (!pend || pend.asking) return
  const row = await registryOf($, sid, ownReg($))
  if (managerRestorePending.get(sid) !== pend) return
  if (row === undefined && pend.tries++ < MANAGER_RESTORE_TRIES) return
  if (row?.kind !== 'interactive') {
    managerRestorePending.delete(sid)
    return void (await log($, sid, 'manager-restore-rejected', 'not-person'))
  }
  // A lane on its way back (a rebind still waiting, a lane hint, a store record naming this session) is not asked, as the conductor's restore (conductorRestoreTry).
  if (rebindPending.has(sid)) return
  const reject = async (why: string) => {
    if (managerRestorePending.get(sid) === pend) managerRestorePending.delete(sid)
    await log($, sid, 'manager-restore-rejected', why)
  }
  if (c.parseHint(await $.store.get(`${c.HINT_PREFIX}${sid}`).catch(() => undefined), await $.clock.now())?.lane) return void (await reject('lane-holder'))
  const lanes = await loadLanes($).catch(() => 'lanes-error')
  if (typeof lanes === 'string') return
  if (lanes.some((l) => l.sid === sid)) return void (await reject('lane-holder'))
  if ((await idleCheck($, sid)) !== undefined) return
  if (managerRestorePending.get(sid) !== pend) return
  void managerRestoreAsk($, sid, pend).catch(() => log($, sid, 'error', 'manager-restore-ask').catch(() => undefined))
}

// ---- v15 (2026-11-05): the conductor level (PR 2 of the levels plan) ----
// A conductor's reach is the list file in its own repo (c.CONDUCTOR_FILE), resolved at every read, intersected with the approved list: what the person approved in
// a dialog of this session (the grant, a later add or a restore that asked). The file only narrows. conductorHome: the conductor repo (the session's start folder at
// the grant). conductorApproved: the approved real paths. Both go with leadDrop.
const conductorHome = new Map<string, string>()
const conductorApproved = new Map<string, string[]>()
const conductorSavedAt = new Map<string, number>()
const conductorDeclared = new Set<string>()

// The saved grant, conductor:<sid> = { home, repos: approved, savedAt }: written at the grant, at each add or remove in this session, after a ratchet and once a day.
// A failed write is logged and tried again a day later. A drop while the write was in flight deletes the key again.
async function conductorSave($: any, sid: string) {
  const epoch = epochOf(sid)
  const home = conductorHome.get(sid)
  const repos = conductorApproved.get(sid)
  if (grants.get(sid)?.level !== 'conductor' || home === undefined || repos === undefined) return
  const now = await $.clock.now()
  if (epochOf(sid) !== epoch) return
  conductorSavedAt.set(sid, now)
  const key = `${c.CONDUCTOR_HINT_PREFIX}${sid}`
  try {
    await $.store.set(key, { home, repos: [...repos], savedAt: now })
  } catch {
    await log($, sid, 'conductor-unsaved').catch(() => undefined)
  }
  if (epochOf(sid) !== epoch || grants.get(sid)?.level !== 'conductor') await Promise.resolve($.store.delete(key)).catch(() => log($, sid, 'error', 'conductor-hint-delete').catch(() => undefined))
}

// The list file, read as a plain small file of the user's (group and other may read it, not write it), with one more try when a read failed or met a swap.
// absent: no .claude folder or no file. unsafe: .claude or the file is a link, has two links or is not the user's. bad: too big or not a list. error: a check or
// read that failed or kept changing.
type CondRead = { state: 'ok'; entries: string[]; text: string } | { state: 'absent' | 'unsafe' | 'bad' | 'error' }
async function readConductorFile($: any, home: string): Promise<CondRead> {
  const p = await where($)
  if (!p) return { state: 'error' }
  const d = await statR($, `${home}/.claude`)
  if (d === 'error') return { state: 'error' }
  if (d === 'absent') return { state: 'absent' }
  // v15 security review (F1): nor a .claude group or other may write.
  if (d.kind !== 'dir' || d.uid !== p.uid || (d.mode & 0o022) !== 0) return { state: 'unsafe' }
  const path = `${home}/${c.CONDUCTOR_FILE}`
  const f = await statR($, path)
  if (f === 'error') return { state: 'error' }
  if (f === 'absent') return { state: 'absent' }
  if (f.kind !== 'file' || f.uid !== p.uid || f.nlink !== 1 || (f.mode & 0o7022) !== 0) return { state: 'unsafe' }
  let r = await readSmallR($, path, p.uid, c.CONDUCTOR_FILE_MAX, true)
  if (r.state === 'changed' || r.state === 'failed') r = await readSmallR($, path, p.uid, c.CONDUCTOR_FILE_MAX, true)
  if (r.state === 'changed' || r.state === 'failed') return { state: 'error' }
  if (r.state !== 'ok') return { state: 'bad' }
  const entries = c.parseConductorFile(r.text)
  return entries ? { state: 'ok', entries, text: r.text } : { state: 'bad' }
}

// Each entry to its real path: it must be its own real path, not too broad, not the conductor repo or inside or around it, and a git root. An entry that fails is
// left out and named with why; 'error' is a check that could not be made (it is left out of reach now, but no ratchet drops it).
type CondOut = { entry: string; why: 'not-found' | 'not-real' | 'not-git' | 'broad' | 'nested' | 'error' | 'unapproved' }
async function resolveConductorList($: any, home: string, entries: string[]): Promise<{ ok: string[]; out: CondOut[] }> {
  const p = await where($)
  const ok: string[] = []
  const out: CondOut[] = []
  for (const entry of entries) {
    const path = c.entryPath(home, entry)
    if (!p) {
      out.push({ entry, why: 'error' })
      continue
    }
    if (c.pinRefusal(path, homeOf(p)) !== undefined) {
      out.push({ entry, why: 'broad' })
      continue
    }
    if (path === home || c.within(home, path) || c.within(path, home)) {
      out.push({ entry, why: 'nested' })
      continue
    }
    const r = await realR($, path)
    if (r === 'error') out.push({ entry, why: 'error' })
    else if (r === 'absent') out.push({ entry, why: 'not-found' })
    else if (r.path !== path) out.push({ entry, why: 'not-real' })
    else {
      const g = await gitRoot($, path)
      // v15 review c1 (W3): two entries naming one repo (../app and its absolute path, written by hand) reach it once.
      if (g === 'yes') ok.includes(path) ? undefined : ok.push(path)
      else out.push({ entry, why: g === 'error' ? 'error' : 'not-git' })
    }
  }
  return { ok, out }
}

// The conductor repo: the session's start folder, a clean path that is not too broad, its own real path and a git root.
async function conductorHere($: any): Promise<{ home: string } | { no: string }> {
  const p = await where($)
  if (!p) return { no: 'conductor-here' }
  let home: unknown
  try {
    home = await withTimeout($, sessionRoot($), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return { no: 'conductor-here' }
  }
  if (typeof home !== 'string' || !c.isCleanAbs(home) || c.pinRefusal(home, homeOf(p)) !== undefined) return { no: 'conductor-here' }
  const r = await realR($, home)
  if (r === 'error' || r === 'absent' || r.path !== home || (await gitRoot($, home)) !== 'yes') return { no: 'conductor-here' }
  return { home }
}

// Q9 (2026-11-05): a conductor repo is a repo of its own: no lane store with a lane, and no live lead whose repo holds it (a lead on a parent repo included).
// A check that cannot be made refuses (conductor-repo-check).
async function conductorRepoInUse($: any, home: string): Promise<string | undefined> {
  const p = await where($)
  if (!p) return 'conductor-repo-check'
  const st = await readStoreFile($, await storePath($, await sha($, home)), p.uid).catch(() => ({ state: 'bad' as const, text: '' }))
  if (st.state === 'bad') return 'conductor-repo-check'
  if (st.state === 'ok') {
    const parsed = c.parseStore(st.text)
    if (!parsed.ok || parsed.store.lanes.length > 0) return 'conductor-repo-in-use'
  }
  const live = await registryEntries($)
  if (!live) return 'registry-unreadable'
  const errs = { error: false }
  const leads = await leadsFor($, live, home, undefined, errs)
  if (leads.length > 0) return 'conductor-repo-in-use'
  return errs.error ? 'conductor-repo-check' : undefined
}

// Lane, lead, conductor, manager: one per session. marks: the lane and lead marks are this call's to read (not after it set its own).
async function conductorHeld($: any, sid: string, marks: boolean): Promise<string | undefined> {
  if ((marks && laneBinding.has(sid)) || (await $.state.get(lane)).value != null) return 'lane-holder'
  const g = grants.get(sid)
  if (g?.level === 'manager') return 'manager-holder'
  if (g?.level === 'lead' || (marks && leadGranting.has(sid)) || leadRestorePending.has(sid)) return 'lead-holder'
  if (leadDeclared.has(sid)) return 'conductor-after-lead'
  if (managerDeclared.has(sid)) return 'conductor-after-manager'
  return undefined
}

// The list file writer, beside writeBrief: one write at a time per conductor repo in this process; .claude must be a real folder of the user's (made 0755 when
// absent); an existing list file is replaced only while it is a plain file of the user's with one link; the file is read, the new list computed, the file read
// again (a change meanwhile refuses conductor-file-changed), then a temp file is renamed into place.
async function writeConductorFile($: any, home: string, fn: (entries: string[]) => string[] | { no: string }): Promise<{ entries: string[] } | { no: string }> {
  const p = await where($)
  if (!p) return { no: 'conductor-file-error' }
  const release = await lockStore(`conductor:${home}`)
  try {
    const dir = `${home}/.claude`
    const path = `${home}/${c.CONDUCTOR_FILE}`
    const dirState = async (): Promise<'ok' | 'absent' | 'bad' | 'error'> => {
      const f = await statR($, dir)
      if (f === 'absent' || f === 'error') return f
      return f.kind === 'dir' && f.uid === p.uid && (f.mode & 0o022) === 0 && (await real($, dir)) === dir ? 'ok' : 'bad'
    }
    let d = await dirState()
    if (d === 'absent') {
      await run($, [MKDIR, '-m', '755', '--', dir])
      d = await dirState()
    }
    if (d === 'bad') return { no: 'conductor-file-unsafe' }
    if (d !== 'ok') return { no: 'conductor-file-error' }
    const unsafe = async (): Promise<string | undefined> => {
      const f = await statR($, path)
      if (f === 'error') return 'conductor-file-error'
      return f !== 'absent' && (f.kind !== 'file' || f.uid !== p.uid || f.nlink !== 1) ? 'conductor-file-unsafe' : undefined
    }
    const before = await unsafe()
    if (before) return { no: before }
    const cur = await readConductorFile($, home)
    if (cur.state === 'unsafe') return { no: 'conductor-file-unsafe' }
    if (cur.state === 'bad') return { no: 'conductor-file-bad' }
    if (cur.state === 'error') return { no: 'conductor-file-error' }
    const next = fn(cur.state === 'ok' ? cur.entries : [])
    if ('no' in next) return next
    const text = c.conductorFileText(next)
    if (text.length > c.CONDUCTOR_FILE_MAX) return { no: 'conductor-too-long' }
    const tmp = `${dir}/.callboard-conductor.json.${await $.clock.now()}.${++seq}.tmp`
    const drop = async (code: string) => {
      await run($, [RM, '-f', '--', tmp])
      return { no: code }
    }
    // v15 review c1 (S4): a step that throws removes the temp file too.
    try {
      await run($, [INSTALL, '-m', '644', '/dev/null', tmp])
      const t = await facts($, tmp)
      if (!t || t.kind !== 'file' || t.uid !== p.uid || (t.mode & 0o7022) !== 0 || t.nlink !== 1) return drop('conductor-file-write')
      if ((await run($, [TEE, '--', tmp], text)).exitCode !== 0) return drop('conductor-file-write')
      // v15 security review (F1): the temp file is still the one checked (not swapped for a link) before it is renamed into place.
      const t2 = await facts($, tmp)
      if (!t2 || t2.ino !== t.ino || t2.uid !== p.uid || t2.kind !== 'file' || t2.nlink !== 1) return drop('conductor-file-write')
      const again = await readConductorFile($, home)
      if (again.state !== cur.state || (again.state === 'ok' && cur.state === 'ok' && again.text !== cur.text)) return drop('conductor-file-changed')
      const after = await unsafe()
      if (after) return drop(after)
      if ((await run($, [MV, '-f', '--', tmp, path])).exitCode !== 0) return drop('conductor-file-write')
    } catch (e) {
      await drop('conductor-file-write').catch(() => undefined)
      throw e
    }
    return { entries: next }
  } finally {
    release()
  }
}

// /callboard conductor add ARG: the target a folder name or ../NAME resolves to (the sibling at the same depth), or the path given.
const conductorTarget = (home: string, arg: string): string => (c.siblingName(arg) ? c.siblingOf(home, arg) : c.entryPath(home, arg))
// Every check of an add before the dialog and again after a yes; the list as it would be, shown whole in the dialog.
async function conductorAddPlan($: any, sid: string, arg: string, marks: boolean): Promise<{ home: string; target: string; list: string[] } | { no: string; home?: string }> {
  const held = await conductorHeld($, sid, marks)
  if (held) return { no: held }
  const here = await conductorHere($)
  if ('no' in here) return here
  const home = here.home
  const used = await conductorRepoInUse($, home)
  if (used) return { no: used, home }
  const p = await where($)
  if (!p) return { no: 'conductor-check-failed', home }
  const target = conductorTarget(home, arg)
  if (c.pinRefusal(target, homeOf(p)) !== undefined) return { no: 'conductor-broad', home }
  const r = await realR($, target)
  if (r === 'error') return { no: 'conductor-check-failed', home }
  if (r === 'absent') return { no: 'conductor-not-found', home }
  if (r.path !== target) return { no: 'conductor-not-real', home }
  const g = await gitRoot($, target)
  if (g !== 'yes') return { no: g === 'error' ? 'conductor-check-failed' : 'conductor-not-git', home }
  const cur = await readConductorFile($, home)
  if (cur.state === 'unsafe') return { no: 'conductor-file-unsafe', home }
  if (cur.state === 'bad') return { no: 'conductor-file-bad', home }
  if (cur.state === 'error') return { no: 'conductor-file-error', home }
  const entries = cur.state === 'ok' ? cur.entries : []
  const paths = entries.map((e) => c.entryPath(home, e))
  const nest = c.nestRefusal(home, paths, target)
  if (nest) return { no: nest, home }
  const list = [...paths, target]
  if (list.length > c.CONDUCTOR_REPOS_MAX) return { no: 'conductor-cap', home }
  if (!c.conductorPresenceFits(home, list)) return { no: 'conductor-too-long', home }
  // No repo may be added that no grant dialog could carry.
  const h = homeOf(p)
  // v15 review (S2, F2): and the grant and restore questions that may follow, with the new repo marked.
  if (c.conductorQuestion(home, list, h, [target]).length > c.QUESTION_MAX || c.conductorAddQuestion(home, target, list, h, true).length > c.QUESTION_MAX || c.conductorRestoreQuestion(home, list, [target], h).length > c.QUESTION_MAX) return { no: 'conductor-list-long', home }
  return { home, target, list }
}

// v15: /callboard conductor add|remove, the person's own command only (from the prompt or the phone); any other origin is refused with no dialog. add asks once
// (naming the whole list as it would be); remove asks nothing (it only narrows). Neither grants: the grant is /callboard conductor and its own dialog.
async function conductorListCommand($: any, sid: string, code: c.OriginCode, op: { add: string } | { remove: string }, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  const verb = 'add' in op ? 'add' : 'remove'
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `conductor-not-person:${code}`).catch(() => undefined)
    return { text: c.CONDUCTOR_NOT_PERSON }
  }
  const refuse = async (why: string, home = '') => {
    await log($, sid, 'refused', why)
    return { text: c.conductorRefusalText(why, home) }
  }
  const p = await where($)
  const h = p ? homeOf(p) : undefined
  const inConductor = (home: string) => grants.get(sid)?.level === 'conductor' && conductorHome.get(sid) === home
  if ('remove' in op) {
    const held = await conductorHeld($, sid, true)
    if (held) return refuse(held)
    const here = await conductorHere($)
    if ('no' in here) return refuse(here.no)
    const home = here.home
    let removed: string | undefined
    // The match is made on the file's entries alone, with no filesystem look, so a deleted or renamed repo can still be removed.
    const w = await writeConductorFile($, home, (entries) => {
      const arg = op.remove
      const hits = c.siblingName(arg) ? entries.filter((e) => c.entryPath(home, e).slice(c.entryPath(home, e).lastIndexOf('/') + 1) === arg) : entries.filter((e) => e === arg || c.entryPath(home, e) === c.entryPath(home, arg))
      if (hits.length !== 1) return { no: 'conductor-not-listed' }
      removed = hits[0]
      return entries.filter((e) => e !== removed)
    })
    if ('no' in w) return w.no.startsWith('conductor-file-') && w.no !== 'conductor-file-bad' ? (await log($, sid, 'error', w.no), { text: c.conductorRefusalText(w.no, home) }) : refuse(w.no, home)
    await log($, sid, 'conductor-remove', code)
    if (inConductor(home) && removed !== undefined) {
      const gone = c.entryPath(home, removed)
      const was = conductorApproved.get(sid) ?? []
      if (was.includes(gone)) {
        conductorApproved.set(sid, was.filter((x) => x !== gone))
        await conductorSave($, sid)
      }
      await conductorReach($, sid).catch(() => undefined)
    }
    return { text: c.conductorRemovedText(removed ?? op.remove) }
  }
  const plan = await conductorAddPlan($, sid, op.add, true)
  if ('no' in plan) return refuse(plan.no, plan.home)
  // v15 security review (F3): the click approves the repo for this session only when the dialog said so and the grant is the same one after it.
  const askedHere = inConductor(plan.home)
  const askedEpoch = epochOf(sid)
  const r = await askOnce($, sid, c.conductorAddQuestion(plan.home, plan.target, plan.list, h, askedHere), c.CONDUCTOR_ADD_YES, c.CONDUCTOR_ADD_NO, c.HEADER.conductor)
  if (r === 'busy') return busy()
  if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
  if (r !== 'yes') {
    await log($, sid, 'refused', 'conductor-add-not-confirmed')
    return { text: 'Cancelled. Nothing changed.' }
  }
  // Every check again after the click; the target must be the one the dialog named.
  const again = await conductorAddPlan($, sid, op.add, true)
  if ('no' in again) return refuse(again.no, again.home ?? plan.home)
  if (again.home !== plan.home || again.target !== plan.target) return refuse('conductor-file-changed', plan.home)
  const w = await writeConductorFile($, plan.home, (entries) => {
    const paths = entries.map((e) => c.entryPath(plan.home, e))
    const nest = c.nestRefusal(plan.home, paths, plan.target)
    if (nest) return { no: nest }
    if (entries.length + 1 > c.CONDUCTOR_REPOS_MAX) return { no: 'conductor-cap' }
    return [...entries, c.entryFor(plan.home, plan.target)]
  })
  if ('no' in w) return w.no.startsWith('conductor-file-') && w.no !== 'conductor-file-bad' ? (await log($, sid, 'error', w.no), { text: c.conductorRefusalText(w.no, plan.home) }) : refuse(w.no, plan.home)
  await log($, sid, 'conductor-add', code)
  // v15 (2.1 #6): in a conductor session the click also approves the repo for this session.
  const here = askedHere && inConductor(plan.home) && epochOf(sid) === askedEpoch
  if (here) {
    const was = conductorApproved.get(sid) ?? []
    if (!was.includes(plan.target)) conductorApproved.set(sid, [...was, plan.target])
    await conductorSave($, sid)
    await conductorReach($, sid).catch(() => undefined)
  }
  return { text: c.conductorAddedText(plan.home, plan.target, h, here) }
}

// The reach of a conductor now: the list file at its repo, resolved, intersected with the approved list. Every read that parses also ratchets the approved list
// (approved := approved ∩ what the file still lists and resolves; a check that could not be made keeps its repo) and saves it when it shrank. off: no conductor
// grant (or one dropped meanwhile); conductor-list: the file is unreadable or bad, or nothing is left in reach.
async function conductorReach($: any, sid: string): Promise<{ pins: string[]; out: CondOut[] } | { no: 'off' | 'conductor-list' }> {
  const epoch = epochOf(sid)
  const home = conductorHome.get(sid)
  if (grants.get(sid)?.level !== 'conductor' || home === undefined) return { no: 'off' }
  // v15 review c1 (W2): the approved list as this read began; an add click that lands during the read is not ratcheted away by it.
  const snap = conductorApproved.get(sid) ?? []
  const f = await readConductorFile($, home)
  if (epochOf(sid) !== epoch || grants.get(sid)?.level !== 'conductor') return { no: 'off' }
  if (f.state !== 'ok') {
    // v15 security review (F4): nothing is in reach, so the presence file, the briefing and the status say none (the approved list stays).
    const g0 = grants.get(sid)!
    if (g0.pins.length > 0) grants.set(sid, { ...g0, pins: [] })
    return { no: 'conductor-list' }
  }
  const r = await resolveConductorList($, home, f.entries)
  if (epochOf(sid) !== epoch || grants.get(sid)?.level !== 'conductor') return { no: 'off' }
  const approved = conductorApproved.get(sid) ?? []
  const keep = new Set([...r.ok, ...r.out.filter((o) => o.why === 'error').map((o) => c.entryPath(home, o.entry))])
  const kept = approved.filter((a) => keep.has(a) || !snap.includes(a))
  if (kept.length < approved.length) {
    conductorApproved.set(sid, kept)
    await log($, sid, 'conductor-ratchet', String(approved.length - kept.length))
    await conductorSave($, sid)
  }
  const pins = r.ok.filter((x) => kept.includes(x))
  const out: CondOut[] = [...r.out, ...r.ok.filter((x) => !kept.includes(x)).map((x) => ({ entry: c.entryFor(home, x), why: 'unapproved' as const }))]
  const g = grants.get(sid)
  if (epochOf(sid) !== epoch || g?.level !== 'conductor') return { no: 'off' }
  if (g.pins.join('\n') !== pins.join('\n')) grants.set(sid, { ...g, pins })
  if (pins.length === 0) return { no: 'conductor-list' }
  return { pins, out }
}

// ---- v15 S6b: the conductor grant by dialog, its saved grant and restore, its tools ----
// The conductor's three tools, declared at its grant. The handlers are the lead's (leadBase refuses every other lane tool at conductor level).
async function conductorTools($: any, sid: string) {
  if (conductorDeclared.has(sid)) return
  const lane = { type: 'object', properties: { lane: { type: 'string' } }, required: ['lane'] }
  const tools: [string, string, unknown][] = [
    ['lane_list', "List the lanes of this conductor's repos, inside one Conductor box with one box per repo and lead (the box header names the lead, whether it is live, and the repo folder name): each lane, its folder when it is outside the repo root, whether a live session carries its name or it is parked, and how many minutes it has waited on a prompt. A lead with no lanes is not listed.", { type: 'object', properties: {} }],
    ['lane_compact', "Ask a session to compact. lane: the session name of a live lead of your repos (it compacts only when it asked with request_compact on-cue, and is never nudged), or a lane name (at once if it asked on-cue, otherwise the plugin nudges it).", lane],
    ['lane_terminate', "Stop a lane's session with SIGTERM, whatever it is doing. Every stop asks the person: they confirm in a dialog that names the lane, its repo, the session and the pid. Once the session has stopped, the lane's record is deleted too (the .archive/<LANE> folder and report stay; a lane a session joined keeps its record while a session carries it; a second stop removes it once the session is gone). A lane with no live session is removed directly. lane: the lane name. A lead cannot be stopped.", lane],
  ]
  for (const [name, description, inputSchema] of tools) await $.tool.register({ name, description, inputSchema })
  await promptToolsRegister($)
  conductorDeclared.add(sid)
}

// The grant itself, for /callboard conductor and the restore. The caller holds leadGranting. The tools first; then, unless an off came meanwhile (epoch), the
// grant with its pins, the conductor repo and the approved list.
async function conductorApply($: any, sid: string, home: string, approved: string[], pins: string[], epoch: number): Promise<'ok' | 'tools' | 'timeout' | 'dropped'> {
  let set: unknown
  try {
    set = await withTimeout($, conductorTools($, sid), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return 'tools'
  }
  if (epochOf(sid) !== epoch) return 'dropped'
  if (set === 'timeout') return 'timeout'
  const prev = grants.get(sid)
  grants.set(sid, { level: 'conductor', pins: [...pins], name: prev?.level === 'conductor' ? prev.name : '' })
  conductorHome.set(sid, home)
  conductorApproved.set(sid, [...approved])
  return 'ok'
}

// The briefing note, once per grant and conductor repo (keyed conductor:<repo> in briefed, as the manager's). A restore that asked nothing appends none.
async function briefConductor($: any, sid: string, home: string) {
  const key = `conductor:${home}`
  if (briefed.get(sid) === key) return
  briefed.set(sid, key)
  try {
    const g = grants.get(sid)
    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: c.conductorBriefingNote(g?.name ?? '', home, g?.pins ?? []) }] } })
    if (r?.deny !== undefined) throw new Error('refused')
  } catch {
    if (briefed.get(sid) === key) briefed.delete(sid)
    await log($, sid, 'error', 'conductor-briefing').catch(() => undefined)
  }
}

// The conductor list as the grant shows it: every check of the conductor repo, then the file read and resolved. ok: the repos in reach, out: the ones that
// are not and why.
async function conductorShowable($: any, sid: string, marks: boolean): Promise<{ home: string; ok: string[]; out: CondOut[] } | { no: string; home?: string; out?: CondOut[] }> {
  const held = await conductorHeld($, sid, marks)
  if (held) return { no: held }
  const here = await conductorHere($)
  if ('no' in here) return here
  const home = here.home
  const used = await conductorRepoInUse($, home)
  if (used) return { no: used, home }
  const f = await readConductorFile($, home)
  if (f.state === 'unsafe') return { no: 'conductor-file-unsafe', home }
  if (f.state === 'bad') return { no: 'conductor-file-bad', home }
  if (f.state === 'error') return { no: 'conductor-file-error', home }
  if (f.state === 'absent') return { no: 'conductor-list', home }
  const r = await resolveConductorList($, home, f.entries)
  if (r.ok.length === 0) return { no: 'conductor-list', home, out: r.out }
  return { home, ok: r.ok, out: r.out }
}

// v15 (F2): /callboard conductor, the grant. Any origin, as /callboard lead: the dialog is the gate the person answers, and another origin is named in its question.
// The dialog names every repo in reach (../NAME beside the conductor repo, any other in full; nothing cut). A yes approves exactly that list for this session; the
// file can only narrow it later. In a conductor session the command opens the dialog again only when the file names repos this session has not approved, and
// only from the person's own prompt or phone: another origin never widens a conductor.
async function conductorGrant($: any, sid: string, code: c.OriginCode, busy: () => Promise<{ text: string }>): Promise<{ text: string }> {
  const on = () => grants.get(sid)?.level === 'conductor'
  const refuse = async (why: string, home = '', out: CondOut[] = []) => {
    await log($, sid, 'refused', why)
    return { text: `${c.conductorRefusalText(why, home, on() ? 'Conductor stays on' : 'Conductor stays off')}${c.conductorOutText(out)}` }
  }
  const p = await where($)
  const h = p ? homeOf(p) : undefined
  const first = await conductorShowable($, sid, true)
  if ('no' in first) return refuse(first.no, first.home, first.out)
  const home = first.home
  if (on()) {
    const approved = conductorApproved.get(sid) ?? []
    if (!c.originIsPerson(code) || first.ok.every((x) => approved.includes(x))) {
      const reach = await conductorReach($, sid)
      return { text: 'no' in reach ? c.conductorRefusalText('conductor-list', home, 'Conductor stays on') : c.conductorReachText(home, reach.pins, h, reach.out) }
    }
  }
  const approvedNow = on() ? (conductorApproved.get(sid) ?? []) : []
  const question = c.askedFrom(c.conductorQuestion(home, first.ok, h, on() ? first.ok.filter((x) => !approvedNow.includes(x)) : []), code)
  if (question.length > c.QUESTION_MAX) return refuse('conductor-list-too-long', home)
  const seq = offSeq.get(sid) ?? 0
  const r = await askOnce($, sid, question, c.CONDUCTOR_YES, c.CONDUCTOR_NO, c.HEADER.conductor)
  if (r === 'busy') return busy()
  if (r !== 'yes') {
    const wasOn = on()
    // A no from the person's own prompt or phone ends the grant and deletes its saved key (as the lead's Cancel); another origin's no, or no answer, changes nothing.
    const kept = r === 'no' && c.originIsPerson(code) && !(await leadDrop($, sid)) ? c.CONDUCTOR_KEPT : ''
    if (r === 'timed-out') {
      await timedOut($, sid)
      return { text: `${on() ? 'Conductor stays on.' : 'Conductor stays off.'} ${c.TIMED_OUT_SENTENCE}` }
    }
    await log($, sid, 'refused', 'conductor-not-confirmed')
    return { text: `${on() ? 'Conductor stays on.' : wasOn ? 'Conductor is now off.' : 'Conductor stays off.'}${kept}` }
  }
  // The post-click re-check, as the lead's and the manager's: the marks are read and set with no await between.
  if (laneBinding.has(sid) || leadGranting.has(sid)) return refuse(laneBinding.has(sid) ? 'lane-holder' : 'lead-holder', home)
  leadGranting.add(sid)
  let grantEpoch = -1
  try {
    const again = await withTimeout($, conductorShowable($, sid, false), c.ENGINE_CALL_TIMEOUT_MS)
    if (again === 'timeout') return refuse('conductor-file-error', home)
    if ('no' in again) return refuse(again.no, again.home ?? home, again.out)
    if ((offSeq.get(sid) ?? 0) !== seq) {
      await log($, sid, 'refused', 'off-meanwhile')
      return { text: 'Nothing changed: callboard was turned off meanwhile.' }
    }
    // (c2, M-F) the list resolved now must be the list the dialog showed.
    // v15 review c1 (S1): the same repos in another order (a writer sorts the file) are no change.
    if (again.home !== home || [...again.ok].sort().join('\n') !== [...first.ok].sort().join('\n')) return refuse('conductor-changed', home)
    const a = await conductorApply($, sid, home, first.ok, first.ok, epochOf(sid))
    if (a !== 'ok') {
      await log($, sid, 'error', `conductor-register-${a}`).catch(() => undefined)
      return { text: c.CONDUCTOR_FAILED }
    }
    grantEpoch = epochOf(sid)
    // v15 PR review (#284): a grant the person made while a restore question was still pending stands, as the lead's does; the pending restore ends here,
    // so a later Cancel on its question cannot delete this grant's saved key.
    conductorRestorePending.delete(sid)
  } finally {
    leadGranting.delete(sid)
  }
  await conductorSave($, sid)
  if (epochOf(sid) !== grantEpoch) return { text: 'Conductor is now off.' }
  await presenceDrop($, sid).catch(() => undefined)
  await presenceTouch($, sid).catch(() => log($, sid, 'error', 'conductor-presence').catch(() => undefined))
  await log($, sid, 'conductor-on', code)
  await briefConductor($, sid, home)
  await nameGrant($, sid)
  return { text: `${c.CONDUCTOR_ON_TEXT}${c.conductorOutText(first.out)}` }
}

// v15 (F2): a session whose saved conductor grant names its own folder is a conductor again when it starts, as a lead is (leadRestore), with these differences:
// the gate is a person's own registry row (personRow: never a --bg worker); a lane on its way back keeps it off; and the approved list caps the reach. A list
// that names nothing new (the same, or narrowed) restores with no question; one that names a repo outside the approved list asks first (conductorRestoreAsk,
// from the tick once the session is idle with an empty prompt box). The tries count only the ticks before a dialog.
const CONDUCTOR_RESTORE_TRIES = 15
type CondPending = { hint: c.ConductorHint; tries: number; last?: string; ask?: { shown: string[]; added: string[] }; asking?: boolean }
const conductorRestorePending = new Map<string, CondPending>()
// One try: a code when it is to be tried again, { ask } when the person must be asked, undefined when it ended (made a conductor, or refused and logged).
// box.hint is the hint as the try leaves it (a ratchet narrows it).
async function conductorRestoreTry($: any, me: string, box: { hint: c.ConductorHint }): Promise<string | { shown: string[]; added: string[] } | undefined> {
  const hint = box.hint
  const key = `${c.CONDUCTOR_HINT_PREFIX}${me}`
  const reject = (code: string) => log($, me, 'conductor-restore-rejected', code)
  const epoch = epochOf(me)
  const dropped = () => epochOf(me) !== epoch
  // (c1, B1) a person's own row: kind interactive. No row yet: tried again (a reopened panel's row may come a moment after session.start). Another kind (a
  // --bg worker resumed under this id) or none: the try ends and the key is kept.
  const row = await registryOf($, me, ownReg($))
  if (dropped()) return
  if (row === undefined) return 'not-person'
  if (row.kind !== 'interactive') return void (await reject('not-person'))
  let cwd: unknown
  try {
    cwd = await withTimeout($, sessionRoot($), c.ENGINE_CALL_TIMEOUT_MS)
  } catch {
    return 'cwd-unreadable'
  }
  if (dropped()) return
  if (cwd === 'timeout' || typeof cwd !== 'string') return 'cwd-unreadable'
  if (cwd !== hint.home) {
    await $.store.delete(key)
    return void (await reject('wrong-folder'))
  }
  // (c1, M2; c2, M-B) a lane on its way back: its binding, its restore hint, or a store record naming this session. A pending rebind alone is tried again:
  // rebindTick clears it once it finds no record, and waits for this restore while it is pending.
  const held = await withTimeout($, $.state.get(lane), c.ENGINE_CALL_TIMEOUT_MS)
  if (dropped()) return
  if (held === 'timeout' || held?.value != null || laneBinding.has(me)) return void (await reject('lane-holder'))
  const now = await $.clock.now()
  if (c.parseHint(await $.store.get(`${c.HINT_PREFIX}${me}`).catch(() => undefined), now)?.lane) return void (await reject('lane-holder'))
  const lanes = await loadLanes($).catch(() => 'lanes-error')
  if (dropped()) return
  if (typeof lanes === 'string') return 'lanes-error'
  if (lanes.some((l) => l.sid === me)) return void (await reject('lane-holder'))
  if (rebindPending.has(me)) return 'rebind-pending'
  if (grants.get(me)?.level === 'conductor') return
  // A lead (a grant or a pending lead restore) stands.
  if (leadBusy(me) || leadRestorePending.has(me)) return void (await reject('lead-holder'))
  const used = await conductorRepoInUse($, hint.home)
  if (dropped()) return
  if (used === 'conductor-repo-in-use') return void (await reject(used))
  if (used) return used
  // (c2, M-E) a list file that cannot be read now restores nothing and is tried again; one that is not there has nothing to restore.
  const f = await readConductorFile($, hint.home)
  if (dropped()) return
  if (f.state === 'absent') {
    toast($, c.conductorNoReposToast(hint.home))
    return void (await reject('no-repos'))
  }
  if (f.state !== 'ok') return 'file-bad'
  const r = await resolveConductorList($, hint.home, f.entries)
  if (dropped()) return
  // (c2, M-C) the ratchet: the approved list keeps only what the file still lists and resolves (a check that could not be made keeps its repo).
  const keep = new Set([...r.ok, ...r.out.filter((o) => o.why === 'error').map((o) => c.entryPath(hint.home, o.entry))])
  const approved = hint.repos.filter((x) => keep.has(x))
  if (approved.length < hint.repos.length) {
    await log($, me, 'conductor-ratchet', String(hint.repos.length - approved.length))
    box.hint = { ...hint, repos: approved, savedAt: now }
    await Promise.resolve($.store.set(key, box.hint)).catch(() => log($, me, 'conductor-unsaved').catch(() => undefined))
    // v15 review c1 (W1): an off that landed during the write deleted the key first; delete it again, as conductorSave does.
    if (dropped()) return void (await Promise.resolve($.store.delete(key)).catch(() => log($, me, 'error', 'conductor-hint-delete').catch(() => undefined)))
  }
  const added = r.ok.filter((x) => !approved.includes(x))
  if (added.length > 0) return { shown: r.ok, added }
  if (r.ok.length === 0) {
    toast($, c.conductorNoReposToast(hint.home))
    return void (await reject('no-repos'))
  }
  if (leadBusy(me)) return
  leadGranting.add(me)
  try {
    const a = await conductorApply($, me, hint.home, approved, r.ok, epoch)
    if (a === 'dropped') return
    if (a === 'timeout') return 'tools-timeout'
    if (a !== 'ok') return void (await reject('tools'))
  } finally {
    leadGranting.delete(me)
  }
  await conductorSave($, me)
  if (dropped()) return
  // No note: the history has it from the grant.
  briefed.set(me, `conductor:${hint.home}`)
  await presenceTouch($, me).catch(() => log($, me, 'error', 'conductor-presence').catch(() => undefined))
  await log($, me, 'conductor-restored')
  toast($, c.conductorRestoredToast(hint.home, r.ok.length))
  await nameGrant($, me)
}
async function conductorRestore($: any, me: string, hint: c.ConductorHint, tries: number, last?: string) {
  const epoch = epochOf(me)
  const box = { hint }
  let again: string | { shown: string[]; added: string[] } | undefined
  try {
    again = await conductorRestoreTry($, me, box)
  } catch {
    again = undefined
    await log($, me, 'conductor-restore-rejected', 'error').catch(() => undefined)
  }
  if (again === undefined || epochOf(me) !== epoch) return void conductorRestorePending.delete(me)
  if (typeof again === 'object') return void conductorRestorePending.set(me, { hint: box.hint, tries, ask: again })
  if (tries >= CONDUCTOR_RESTORE_TRIES) {
    conductorRestorePending.delete(me)
    await log($, me, 'conductor-restore-rejected', again)
    if (again === 'file-bad') toast($, c.conductorFileBadToast(box.hint.home))
    return
  }
  if ((again === 'rebind-pending' || again === 'file-bad') && again !== last) await log($, me, 'conductor-restore-retry', again)
  conductorRestorePending.set(me, { hint: box.hint, tries, last: again })
}
// (F2, decided) the restore dialog, when the list names repos the person has not approved: every repo shown, the new ones named. Conductor restores with the
// whole shown list (the approved list becomes it); Cancel is the person's no (the saved grant goes); no answer restores nothing and keeps the key. (c2, M-F) An
// off or a lead grant while it is open grants nothing, and the list resolved after the click must be the one shown.
async function conductorRestoreAsk($: any, me: string, pend: CondPending) {
  const { hint } = pend
  const { shown, added } = pend.ask!
  const key = `${c.CONDUCTOR_HINT_PREFIX}${me}`
  const epoch = epochOf(me)
  const mine = () => conductorRestorePending.get(me) === pend && epochOf(me) === epoch
  const end = () => {
    if (conductorRestorePending.get(me) === pend) conductorRestorePending.delete(me)
  }
  pend.asking = true
  try {
    const p = await where($)
    const question = c.conductorRestoreQuestion(hint.home, shown, added, p ? homeOf(p) : undefined)
    const r = question.length > c.QUESTION_MAX ? 'error' : await askOnce($, me, question, c.CONDUCTOR_YES, c.CONDUCTOR_NO, c.HEADER.conductor)
    if (r === 'busy') return
    if (!mine()) return void (await log($, me, 'conductor-restore-rejected', 'changed'))
    if (r === 'no') {
      end()
      await Promise.resolve($.store.delete(key)).catch(() => log($, me, 'error', 'conductor-hint-delete').catch(() => undefined))
      return void (await log($, me, 'conductor-restore-cancelled'))
    }
    if (r !== 'yes') {
      end()
      await log($, me, 'conductor-restore-unanswered')
      return void toast($, c.conductorUnansweredToast(hint.home))
    }
    end()
    if (leadBusy(me) || leadRestorePending.has(me)) return void (await log($, me, 'conductor-restore-rejected', 'lead-holder'))
    // Every check again after the click.
    const held = await withTimeout($, $.state.get(lane), c.ENGINE_CALL_TIMEOUT_MS)
    if (held === 'timeout' || held?.value != null || laneBinding.has(me)) return void (await log($, me, 'conductor-restore-rejected', 'lane-holder'))
    const used = await conductorRepoInUse($, hint.home)
    if (used) return void (await log($, me, 'conductor-restore-rejected', used))
    const f = await readConductorFile($, hint.home)
    const r2 = f.state === 'ok' ? await resolveConductorList($, hint.home, f.entries) : undefined
    if (epochOf(me) !== epoch) return void (await log($, me, 'conductor-restore-rejected', 'changed'))
    if (!r2 || [...r2.ok].sort().join('\n') !== [...shown].sort().join('\n')) {
      toast($, c.conductorUnansweredToast(hint.home))
      return void (await log($, me, 'conductor-restore-rejected', 'changed'))
    }
    if (leadBusy(me)) return
    leadGranting.add(me)
    try {
      const a = await conductorApply($, me, hint.home, shown, shown, epoch)
      if (a !== 'ok') return void (await log($, me, 'conductor-restore-rejected', a === 'dropped' ? 'changed' : 'tools'))
    } finally {
      leadGranting.delete(me)
    }
    await conductorSave($, me)
    if (epochOf(me) !== epoch) return
    await presenceTouch($, me).catch(() => log($, me, 'error', 'conductor-presence').catch(() => undefined))
    await log($, me, 'conductor-restored', `widened ${added.length}`)
    await briefConductor($, me, hint.home)
    toast($, c.conductorRestoredToast(hint.home, shown.length))
    await nameGrant($, me)
  } finally {
    pend.asking = false
  }
}
// The tick's part: a running conductor's reach (the ratchet, the presence text, an empty reach) at most every CONDUCTOR_REFRESH_MS and its saved grant once a
// day; a pending restore's next try, or its dialog once the session is idle with an empty prompt box (not awaited: the dialog waits up to 90 s).
const CONDUCTOR_REFRESH_MS = 10_000
const conductorReadAt = new Map<string, number>()
async function conductorTick($: any, sid: string) {
  const pend = conductorRestorePending.get(sid)
  if (pend && !pend.asking) {
    if (!pend.ask) {
      const r = await withTimeout($, conductorRestore($, sid, pend.hint, pend.tries + 1, pend.last), ACTION_TIMEOUT_MS).catch(() => 'error' as const)
      if (r === 'timeout' || r === 'error') await log($, sid, 'error', `conductor-restore-${r}`).catch(() => undefined)
    } else if ((await personRow($, sid)) && (await idleCheck($, sid)) === undefined) {
      void conductorRestoreAsk($, sid, pend).catch(() => log($, sid, 'error', 'conductor-restore-ask').catch(() => undefined))
    }
  }
  if (grants.get(sid)?.level !== 'conductor') return
  const now = await $.clock.now()
  if (c.leadRefreshDue(conductorSavedAt.get(sid), now)) await conductorSave($, sid)
  const last = conductorReadAt.get(sid)
  if (last === undefined || now < last || now - last >= CONDUCTOR_REFRESH_MS) {
    conductorReadAt.set(sid, now)
    await conductorReach($, sid)
  }
}

// Probe P2: /color from a mod is refused inside a hook the turn waits on and works from a timer. Best effort, while the same grant holds; logged either way.
const COLOR_AFTER_MS = 1000
function colorLater($: any, sid: string, epoch: number) {
  const failed = () => log($, sid, 'error', 'manager-color').catch(() => undefined)
  try {
    Promise.resolve(
      $.clock.after(COLOR_AFTER_MS, async () => {
        if (grants.get(sid)?.level !== 'manager' || epochOf(sid) !== epoch) return
        try {
          await $.command.run({ command: 'color', args: 'cyan' })
          await log($, sid, 'manager-color')
        } catch {
          await failed()
        }
      }),
    ).catch(failed)
  } catch {
    void failed()
  }
}

// v13.2: /callboard config. Reading works from any origin and logs nothing (as status). A change is the person's own: from the prompt or the phone it is applied,
// from a plugin, another session or a script it is refused with a fixed text and no dialog (D3). That is a convenience, not a control: any same-uid process can
// write the key itself, and the field bounds are what limit it. The change is a read-modify-write right before the write (two sessions in the same second: the
// last write wins), and the two levels are checked against each other as stored.
async function configCommand($: any, sid: string, code: c.OriginCode, op: c.ConfigOp): Promise<{ text: string }> {
  if (op === 'show') return { text: c.configText(await cfgGet($, sid, true)) }
  if (op === 'bad') return { text: c.CONFIG_USAGE }
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `config-not-person:${code}`).catch(() => undefined)
    return { text: c.CONFIG_NOT_PERSON }
  }
  // Each store call runs inside an async function, so a call that throws at once is answered like one that rejects (review c1).
  const raw = await withTimeout($, (async () => $.store.get(c.CONFIG_KEY))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  if (raw === 'timeout') return { text: c.CONFIG_UNREADABLE }
  const cur = c.parseConfig(raw).cfg
  let next: c.Config
  if (op === 'reset') next = { ...c.CONFIG_DEFAULTS }
  else if (op.field === 'keepalive' || op.field === 'checkin') next = { ...cur, [op.field]: op.value }
  else {
    const no = c.configLevelRefusal(op, cur)
    if (no) return { text: no }
    next = { ...cur, [op.field]: op.value }
  }
  const now = await $.clock.now()
  const w = await withTimeout($, (async () => $.store.set(c.CONFIG_KEY, { ...next, savedAt: now }))().then(() => 'ok' as const), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'failed' as const)
  if (w !== 'ok') {
    await log($, sid, 'error', `config-write-${w}`).catch(() => undefined)
    return { text: c.CONFIG_UNSAVED }
  }
  cfg = next
  cfgReadAt = now
  const field = op === 'reset' ? 'reset' : op.field
  await log($, sid, 'config-set', `${field}:${code}`).catch(() => undefined)
  return { text: op === 'reset' ? c.CONFIG_RESET_TEXT : c.configSetText(op.field, next) }
}

// v15.1 (2026-11-05): /callboard reserve, this machine's reserved names. Showing works from any origin and logs nothing; a change is the person's own,
// as /callboard config (the same convenience, not a control: any same-uid process can write the key, and parseReserved bounds what it can hold). An add is
// refused while a lane record, a lead stamp or a live lead carries the name in any letter case: a lead would lose its lead name and its lanes with it.
async function reserveCommand($: any, sid: string, code: c.OriginCode, op: c.ReserveOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: c.RESERVE_USAGE }
  if (op === 'show') return { text: c.reserveShowText(await reservedGet($, sid, true)) }
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `reserve-not-person:${code}`).catch(() => undefined)
    return { text: c.RESERVE_NOT_PERSON }
  }
  // The list as stored now: also what managerNameOf reads for the remove guard below.
  await reservedGet($, sid, true)
  const raw = await withTimeout($, (async () => $.store.get(c.RESERVE_KEY))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  if (raw === 'timeout') return { text: c.RESERVE_UNREADABLE }
  const cur = c.parseReserved(raw)
  const key = ('remove' in op ? op.remove : op.add).toUpperCase()
  if ('remove' in op) {
    const hit = cur.find((x) => x.toUpperCase() === key)
    if (!hit) return { text: c.reserveNotListedText(op.remove) }
    // Review c1: the live manager's name stays reserved while it runs, or leads would stop trusting it with nothing said.
    const live = await registryEntries($)
    if (!live) return { text: c.RESERVE_UNREADABLE }
    const mgrs = await managersLive($, live, '')
    if (mgrs.some((m) => m.unverified)) return { text: c.RESERVE_UNREADABLE }
    if (mgrs.some((m) => m.name?.toUpperCase() === key)) return { text: c.reserveManagerText(hit) }
  } else {
    const name = op.add
    let inUse: string | undefined
    const lanes = await loadLanes($)
    if (typeof lanes === 'string') return { text: c.RESERVE_UNREADABLE }
    // Security review (M1): judged by skeleton, as enforcement is, so a look-alike in use (LEAD2 for LEAD) counts too.
    const hit = (n: unknown) => typeof n === 'string' && c.reservedHit(n, [name])
    const rec = lanes.find((l) => hit(l.name) || hit(l.leadName))
    if (rec) inUse = hit(rec.name) ? `lane ${rec.name}` : `the lead stamp on lane ${rec.name}`
    if (!inUse) {
      const live = await registryEntries($)
      if (!live) return { text: c.RESERVE_UNREADABLE }
      const errs = { error: false }
      const leads = await leadsFor($, live, undefined, undefined, errs)
      if (errs.error) return { text: c.RESERVE_UNREADABLE }
      const rows = live.map((r) => r.j)
      const lead = leads.flatMap((x) => rows.filter((j) => j?.sessionId === x.sid && hit(j.name))).at(0)
      if (lead) inUse = `the live lead ${lead.name}`
    }
    const no = c.reserveAddRefusal(name, cur, inUse)
    if (no) return { text: no }
  }
  // Review c1: the checks above take time; apply the change to the list as stored right now, so a change another session made meanwhile is kept.
  const raw2 = await withTimeout($, (async () => $.store.get(c.RESERVE_KEY))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'timeout' as const)
  if (raw2 === 'timeout') return { text: c.RESERVE_UNREADABLE }
  const fresh = c.parseReserved(raw2)
  let next: string[]
  if ('remove' in op) next = fresh.filter((x) => x.toUpperCase() !== key)
  else {
    const no = c.reserveAddRefusal(op.add, fresh, undefined)
    if (no) return { text: no }
    next = [...fresh, op.add]
  }
  const now = await $.clock.now()
  const w = await withTimeout($, (async () => $.store.set(c.RESERVE_KEY, { names: next, savedAt: now }))().then(() => 'ok' as const), c.ENGINE_CALL_TIMEOUT_MS).catch(() => 'failed' as const)
  if (w !== 'ok') {
    await log($, sid, 'error', `reserve-write-${w}`).catch(() => undefined)
    return { text: c.RESERVE_UNSAVED }
  }
  reservedGen++
  c.setLocalReserved(next)
  reservedReadAt = now
  await log($, sid, 'add' in op ? 'reserve-add' : 'reserve-remove', code).catch(() => undefined)
  return { text: 'add' in op ? c.reserveAddedText(op.add) : c.reserveRemovedText(cur.find((x) => x.toUpperCase() === op.remove.toUpperCase())!) }
}

// v13.6: the usage line, for an unknown word (`on` included since v13.6).
const USAGE = 'Use /callboard off, lead, lanes, claim, status, config, checkin, conductor, reserve, lane [NAME] or lane off.'

// ---- prompt answering (ADR 0004), PR 1: the hook, the floor, the files and the switch. Off by default; nothing here lets an agent write a decision. ----
// A PermissionRequest hook in the asking session: it refuses what no agent may answer, writes a request file and waits. Every approval would come from
// prompt_answer (PR 2); until then a decision file can only be made by hand, and the hook applies it under every check of pr.applyCheck.
const UUIDGEN = '/usr/bin/uuidgen'
const GREP = '/usr/bin/grep'
const GIT_BIN = '/usr/bin/git'
const ANSWERING_KEY = 'answering'
const CHECK_TTL_MS = 60_000
const CHECKS_MAX = 256
const SWEEP_EVERY_MS = 60_000
const SWEEP_DIRS_MAX = 64
const PERSON_HOLDS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

type CheckEntry = { toolUseId: string; at: number; approver: unknown; facts: pr.CheckFacts; dup: boolean }
// What tool.check saw for an ask, joined to the PermissionRequest that follows by session, tool, whole-input hash and agent. PermissionRequest carries neither
// the approver nor the tool_use_id (probed), so both come from here.
const checks = new Map<string, CheckEntry>()
// The calls whose request is open (or about to be), by tool_use_id: the three done events mark them, so a person's Yes (which fires no signal) is seen.
const openReqs = new Map<string, { sid: string; id?: string; dir?: string }>()
const doneIds = new Set<string>()
// Requests whose hook ended with no closing row written (the write failed, or the dispatch was cut off by the person's No): the files stay and the tick writes the
// row, so every closed request ends with one. After UNCLOSED_TRIES failed tries the files are left to the sweep (session-gone, or swept after a day).
const unclosed = new Map<string, { dir: string; row: Omit<pr.LedgerRow, 't'>; tries: number }>()
const UNCLOSED_TRIES = 5
// What a request's hook has done about its closing row: `closed` once one is in the ledger (or the sweep wrote it), `pending` the row it still owes.
type CloseState = { closed: boolean; requested: boolean; pending?: Omit<pr.LedgerRow, 't'> }
let lastSweepAt = 0
let sweepFrom = 0

async function promptDir($: any, p: { uid: number; root: string }, sid?: string): Promise<string | undefined> {
  const base = `${p.root}/prompts`
  const dirs = sid === undefined ? [p.root, base] : [p.root, base, `${base}/${sid}`]
  await run($, [MKDIR, '-p', '-m', '700', ...dirs])
  for (const d of dirs) if (!(await dirOk($, d, p.uid))) return undefined
  return dirs[dirs.length - 1]
}

// A file of ours, 0600, put in place whole: written beside it, then renamed.
async function promptPut($: any, path: string, text: string): Promise<boolean> {
  const tmp = `${path}.${++seq}.tmp`
  try {
    if ((await run($, [INSTALL, '-m', '600', '/dev/null', tmp])).exitCode !== 0) return false
    if ((await run($, [TEE, '--', tmp], text)).exitCode !== 0 || (await run($, [MV, '-f', tmp, path])).exitCode !== 0) {
      await run($, [RM, '-f', '--', tmp]).catch(() => undefined)
      return false
    }
    return true
  } catch {
    return false
  }
}

// One ledger row, appended whole (one tee call, under pr.LEDGER_ROW_MAX bytes). false: the row could not be written.
async function ledgerAdd($: any, row: Omit<pr.LedgerRow, 't'>): Promise<boolean> {
  try {
    const p = await where($)
    if (!p) return false
    const dir = await promptDir($, p)
    if (!dir) return false
    const now = await $.clock.now()
    const file = `${dir}/${pr.ledgerFile(now)}`
    let f = await facts($, file)
    if (!f) {
      await run($, [INSTALL, '-m', '600', '/dev/null', file])
      f = await facts($, file)
    }
    if (!f || f.kind !== 'file' || f.uid !== p.uid || f.mode !== 0o600 || f.nlink !== 1) return false
    return (await run($, [TEE, '-a', '--', file], pr.ledgerLine({ t: new Date(now).toISOString(), ...row }))).exitCode === 0
  } catch {
    return false
  }
}

// The rows of this month's and last month's ledgers that hold the needle, found with a bounded grep -F. A read that fails or is cut is unreadable.
// The needle is a JSON fragment as pr.ledgerLine writes it (`"id":"<uuid>"`, JSON.stringify's spacing): every row is written with ledgerLine.
async function ledgerRowsFor($: any, p: { uid: number; root: string }, needle: string): Promise<pr.LedgerRow[] | 'unreadable'> {
  try {
    const now = await $.clock.now()
    const rows: pr.LedgerRow[] = []
    for (const name of [pr.ledgerFile(now), pr.ledgerFilePrev(now)]) {
      const path = `${p.root}/prompts/${name}`
      const st = await statR($, path)
      if (st === 'absent') continue
      if (st === 'error' || st.kind !== 'file' || st.uid !== p.uid || (st.mode & 0o022) !== 0) return 'unreadable'
      const r = await $.process.run([GREP, '-F', '-h', '--', needle, path], { timeoutMs: 5000 })
      if (r.exitCode === 1) continue
      if (r.exitCode !== 0 || r.isStdoutTruncated) return 'unreadable'
      rows.push(...pr.parseRows(String(r.stdout)))
    }
    return rows
  } catch {
    return 'unreadable'
  }
}

// Whether this month's or last month's ledger holds an `answered` row for the id and nonce.
async function ledgerHas($: any, p: { uid: number; root: string }, id: string, nonce: string, bind?: { code: string; by: string; via?: 'person' }): Promise<'found' | 'missing' | 'unreadable'> {
  const rows = await ledgerRowsFor($, p, `"id":"${id}"`)
  if (rows === 'unreadable') return 'unreadable'
  // bind: the row must name the same decision and the same author as the file, so a file rewritten after its row (a deny turned allow) is not found.
  return rows.some((j) => j.kind === 'answered' && j.id === id && j.nonce === nonce && (bind === undefined || (j.code === bind.code && j.by === bind.by && j.via === bind.via))) ? 'found' : 'missing'
}

// The standing comment cap for a call that carries an `@claude` body: the `returned` allow rows of this month and last for the same repo, PR and kind. A failed
// read is 'unreadable', which the callers treat as over the cap (the prompt stays the person's).
async function capOf($: any, p: { uid: number; root: string }, cap: { kind: pr.CapKind; target: string }): Promise<'ok' | 'over' | 'unreadable'> {
  const rows = await ledgerRowsFor($, p, `"target":${JSON.stringify(cap.target)}`)
  return rows === 'unreadable' ? 'unreadable' : pr.capState(rows, cap)
}

// The emergency file: while it exists answering is off. A stat that fails counts as present (fail closed).
async function promptsOff($: any): Promise<boolean> {
  const p = await where($)
  if (!p) return true
  return (await statR($, `${p.root}/prompts/OFF`)) !== 'absent'
}

// Whether the switch is on and this session is a lane or a lead: the cheap first test. The scope (a lane's or a lead's name) is judged once the lead is known.
async function promptCoverage($: any, sid: string): Promise<{ a: pr.Answering; level: 'lane' | 'lead'; lane?: string; self?: string; lead?: string } | undefined> {
  const a = pr.parseAnswering(await $.store.get(ANSWERING_KEY))
  if (!a) return undefined
  const b = (await $.state.get(lane)).value as Bound | null | undefined
  if (b && typeof b.name === 'string') return { a, level: 'lane', lane: b.name, ...(typeof b.lead === 'string' ? { lead: b.lead } : {}) }
  const g = grants.get(sid)
  return g?.level === 'lead' ? { a, level: 'lead', self: g.name } : undefined
}

// tool.check only observes: it stores what it saw for an ask in a covered session, and the caller returns the verdict unchanged, every time (F-C).
async function promptObserve($: any, e: any, r: any): Promise<void> {
  if (r?.decision !== 'ask' || typeof e.tool_use_id !== 'string' || typeof e.agentId === 'string') return
  const sid = await $.session.id()
  if (!c.SID_RE.test(sid) || !(await promptCoverage($, sid))) return
  const key = `${sid}\n${pr.joinKey(String(e.tool), await sha($, pr.canonical(e.input)), undefined)}`
  const now = await $.clock.now()
  const old = checks.get(key)
  const dup = old !== undefined && now - old.at <= CHECK_TTL_MS && old.toolUseId !== e.tool_use_id
  if (dup) old.dup = true
  checks.set(key, { toolUseId: e.tool_use_id, at: now, approver: e.approver, dup, facts: { decision: r.decision, reason: r.reason, rule: r.rule, hook: r.hook, setting: r.setting, plugin: r.plugin, ceiling: r.ceiling } })
  for (const [k, v] of checks) if (now - v.at > CHECK_TTL_MS) checks.delete(k)
  while (checks.size > CHECKS_MAX) checks.delete(checks.keys().next().value as string)
}

// The current branch of a repo, by a read-only git call that reads no hook and no optional lock; undefined (detached, or any failure) leaves the floor holding.
async function branchOf($: any, dir: string): Promise<string | undefined> {
  const r = await $.process.run([GIT_BIN, '--no-optional-locks', '-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeoutMs: 5000, env: { LC_ALL: 'C' } }).catch(() => undefined)
  const b = r?.exitCode === 0 ? String(r.stdout).trim() : ''
  return b === '' || /[\u0000-\u001f]/.test(b) ? undefined : b
}

// Where a push of this branch goes when the call names no branch: the keys git reads for it (branch.<b>.remote, pushRemote, merge, remote.pushDefault, push.default,
// a remote's push or mirror). No keys is an answer (the defaults apply); anything else that fails leaves it unresolved, and the floor holds.
const PUSH_KEYS = '^(branch\\..*\\.(remote|pushremote|merge)|remote\\.pushdefault|remote\\..*\\.(push|pushurl|mirror)|url\\..*\\.(insteadof|pushinsteadof)|push\\.default)$'
async function pushTargetOf($: any, dir: string, branch: string, remote?: string): Promise<NonNullable<pr.FloorOpts['pushTarget']>> {
  const r = await $.process.run([GIT_BIN, '--no-optional-locks', '-C', dir, 'config', '--get-regexp', PUSH_KEYS], { timeoutMs: 5000, env: { LC_ALL: 'C' } }).catch(() => undefined)
  // A config that cannot be read may rewrite the push: even a named ref is then the floor.
  if (!r) return { unresolved: true, mapped: true }
  if (r.exitCode === 1 && String(r.stdout).trim() === '') return pr.pushTargetFrom('', branch, remote)
  return r.exitCode === 0 && !r.isStdoutTruncated ? pr.pushTargetFrom(String(r.stdout), branch, remote) : { unresolved: true, mapped: true }
}

// cwdKnown: cwd is the folder the engine said the call ran in. When it said none, the floor reads every relative path as having an unknown base.
async function promptFloorOpts($: any, tool: string, input: any, cwd: string, home: string, cwdKnown = true): Promise<pr.FloorOpts> {
  const o: pr.FloorOpts = { home, roots: [], cwd, ...(cwdKnown ? {} : { cwdUnknown: true }) }
  const isGit = tool.startsWith('mcp__git-mcp__')
  try {
    const co = c.liveCheckout($.plugin.root)
    if (co) {
      o.roots = [co]
      const real = await realR($, co)
      if (typeof real !== 'string' && real.path !== co) o.roots.push(real.path)
    }
  } catch {}
  // The folders the hooks and rules under ~/.claude are linked into (the toolkit's live checkout): an edit there is an edit of the guards themselves.
  if (PERSON_HOLDS.has(tool) || tool === 'Bash' || isGit) for (const r of await linkedRoots($, home)) if (!o.roots!.includes(r)) o.roots!.push(r)
  if (pr.needsBranch(tool, input)) {
    const dir = pr.gitPathOf(tool, input) ?? (tool === 'Bash' ? cwd : undefined)
    if (dir) o.branch = await branchOf($, dir)
  }
  // Every push is judged by where git sends it: a push naming no branch goes to the configured target of the current one, and a remote may rewrite even a named ref.
  // An unread branch is '' (the rewrite check needs none); no folder to read is unresolved.
  if (pr.needsPushTarget(tool, input)) {
    // The git server acts in the folder the call names; with none it acts in its own, which is not read here.
    const dir = pr.gitPathOf(tool, input)
    o.pushTarget = dir === undefined ? { unresolved: true, mapped: true } : await pushTargetOf($, dir, o.branch ?? '', typeof input?.remote === 'string' ? input.remote : undefined)
  }
  if (PERSON_HOLDS.has(tool) || isGit) {
    const real: string[] = []
    // A git call acts on its `path`, or on the folder the session runs in.
    for (const raw of isGit ? [typeof input?.path === 'string' ? input.path : cwd] : [input?.file_path, input?.notebook_path, input?.path]) {
      if (typeof raw !== 'string') continue
      const abs0 = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw
      const abs = abs0.startsWith('/') ? abs0 : `${cwd}/${abs0}`
      let r = await realR($, abs)
      if (r === 'absent') {
        // A file not made yet: its folder's real path, and the name.
        const slash = abs.lastIndexOf('/')
        const d = await realR($, abs.slice(0, slash) || '/')
        r = typeof d === 'string' ? d : { path: `${d.path === '/' ? '' : d.path}${abs.slice(slash)}` }
      }
      if (typeof r === 'string') o.unresolved = true
      else real.push(r.path)
    }
    o.real = real
  }
  return o
}

// The folder above `hooks` or `rules` in the real path of each entry of ~/.claude/hooks and ~/.claude/rules that is a link out of ~/.claude. Best effort: a
// failed list or realpath adds nothing. A folder found this way is as wide as the link's own parent, which errs toward the floor.
async function linkedRoots($: any, home: string): Promise<string[]> {
  const out = new Set<string>()
  const own = `${home.toLowerCase()}/.claude`
  for (const sub of ['hooks', 'rules']) {
    try {
      const names = ((await $.fs.list(`${home}/.claude/${sub}`).catch(() => [])) as { name: string }[]).map((f) => f.name).filter((n) => /^[A-Za-z0-9._-]{1,100}$/.test(n)).slice(0, 64)
      if (names.length === 0) continue
      const r = await $.process.run([REALPATH, '--', ...names.map((n) => `${home}/.claude/${sub}/${n}`)], { timeoutMs: 5000, env: { LC_ALL: 'C' } })
      for (const line of String(r.stdout).split('\n')) {
        const m = /^(\/.+?)\/(?:hooks|rules)\/[^/]+$/.exec(line.trim())
        const low = m?.[1].toLowerCase()
        if (m && low !== own && !low!.startsWith(`${own}/`)) out.add(m[1])
      }
    } catch {}
  }
  return [...out]
}

// The lane's own lead (a live lead of the repo that is not the lane), by sid and name; undefined for a lead's own prompt or when none is live.
async function promptLeadOf($: any, level: 'lane' | 'lead', sid: string, cwd: string, bound?: string): Promise<{ sid: string; name?: string } | undefined> {
  if (level !== 'lane') return undefined
  const live = await registryEntries($)
  if (!live) return undefined
  const leads = (await leadsFor($, live, cwd).catch(() => [] as c.LeadFile[])).filter((l) => l.sid !== sid)
  // Record first, as the briefing does (S2): a lane record that names its lead is reached by the live lead of that registry name and no other (none live: nobody).
  // Else the lead the lane is bound to, if it is live; with no binding, the one live lead of the repo. Two leads and no binding: nobody can be asked.
  // A bound lane whose record cannot be read, or that has none, reaches no lead: the prompt stays the person's.
  const rec = await reportLaneOf($, sid).catch(() => undefined)
  if (!rec) return undefined
  const rows = live.map((r) => r.j)
  const lead = rec?.leadName !== undefined ? leads.find((l) => c.leadNameOf(rows, l.sid) === rec.leadName) : bound !== undefined ? leads.find((l) => l.sid === bound) : leads.length === 1 ? leads[0] : undefined
  if (!lead) return undefined
  return { sid: lead.sid, name: c.leadNameOf(live.map((r) => r.j), lead.sid) ?? undefined }
}

// This session's own registry row, by one file read (not the whole table): the row of the pid the request was made under, kept only if it names this session and
// the same process start. undefined: unknown (a changing, missing or odd file).
async function promptOwnRow($: any, w: WaitCtx): Promise<any | undefined> {
  if (w.p.own === undefined || !(await dirOk($, w.p.own, w.p.uid))) return undefined
  const r = await readSmallR($, `${w.p.own}/${w.req.pid}.json`, w.p.uid, c.REGISTRY_FILE_MAX, true)
  if (r.state !== 'ok') return undefined
  try {
    const j = JSON.parse(r.text)
    return j && typeof j === 'object' && String(j.pid) === String(w.req.pid) && j.sessionId === w.sid && j.procStart === w.req.procStart ? j : undefined
  } catch {
    return undefined
  }
}

async function promptNewId($: any): Promise<string> {
  const r = await run($, [UUIDGEN])
  const id = r.stdout.trim().toLowerCase()
  if (r.exitCode !== 0 || !pr.ID_RE.test(id)) throw new Error('uuid-failed')
  return id
}

// The request's files, removed when it closes (the ledger row is written before this).
async function promptCleanup($: any, dir: string | undefined, id: string | undefined, tid: string): Promise<void> {
  openReqs.delete(tid)
  doneIds.delete(tid)
  if (!dir || !id) return
  await promptRemoveFiles($, dir, id)
}

// Every file a request can have beside its request file: the decision, the pass-up of each tier (the old `escalate.json` is the lead's), the relay with its asked and
// left marks, and the closed marker.
const PROMPT_SUFFIXES = ['request.json', 'decision.json', 'escalate.json', 'escalate-lead.json', 'escalate-conductor.json', 'escalate-manager.json', 'relay.json', 'asked', 'left', 'done']
async function promptRemoveFiles($: any, dir: string, id: string): Promise<void> {
  await run($, [RM, '-f', '--', ...PROMPT_SUFFIXES.map((x) => `${dir}/${id}.${x}`)]).catch(() => undefined)
}

// The marker prompt_list, the lead's notice and prompt_answer read as "closed": no hook waits for this request any more.
async function promptMarkDone($: any, dir: string, id: string): Promise<void> {
  await run($, [INSTALL, '-m', '600', '/dev/null', `${dir}/${id}.done`]).catch(() => undefined)
}

// The tick's retry for a request whose closing row could not be written when its hook ended (a No click cuts the dispatch off; a ledger can fail for a moment).
async function promptCloseTick($: any): Promise<void> {
  for (const [id, u] of [...unclosed]) {
    // Taken out first, so a tick and a hook start that overlap cannot both write the row (or both count a try).
    if (!unclosed.delete(id)) continue
    const ok = await ledgerAdd($, u.row).catch(() => false)
    if (ok) await promptRemoveFiles($, u.dir, id)
    else if (++u.tries < UNCLOSED_TRIES) unclosed.set(id, u)
    // Given up: the files stay for the sweep, marked closed (again) so that prompt_list and the notice do not show a request whose hook is gone.
    else await promptMarkDone($, u.dir, id)
  }
}

// A tool's end, or a No click's PermissionDenied, closes the dialog: the hook's wait learns of a click by this id (a Yes fires no signal).
async function promptDone($: any, e: any): Promise<void> {
  const tid = typeof e?.tool_use_id === 'string' ? e.tool_use_id : undefined
  // The call has ended or been refused: an entry kept for it (an ask the dialog never reached) must not make a later identical call look like a second in flight.
  if (tid !== undefined) for (const [k, v] of checks) if (v.toolUseId === tid) checks.delete(k)
  const o = tid === undefined ? undefined : openReqs.get(tid)
  if (!o || tid === undefined) return
  doneIds.add(tid)
  if (o.dir && o.id) await run($, [INSTALL, '-m', '600', '/dev/null', `${o.dir}/${o.id}.done`]).catch(() => undefined)
}

async function doneHook($: any, e: any, next: any): Promise<any> {
  await promptDone($, e).catch(() => undefined)
  return next(e)
}

// The `Relay <short>` headers of an AskUserQuestion input (at most 8 questions).
const relayShorts = (input: any): string[] => (Array.isArray(input?.questions) ? input.questions.slice(0, 8).flatMap((q: any) => { const m = pr.RELAY_HEADER.exec(typeof q?.header === 'string' ? q.header : ''); return m ? [m[1]] : [] }) : [])

// The open relays this session made: every `<id>.relay.json` in the prompts folders whose `by` is this session. A scan of at most PROMPT_DIRS_MAX folders, run only when a
// `Relay` question is asked or answered.
async function promptOpenRelays($: any, p: { uid: number; root: string }, sid: string): Promise<{ dir: string; relay: pr.Relay }[]> {
  const base = `${p.root}/prompts`
  const out: { dir: string; relay: pr.Relay }[] = []
  if (!(await dirOk($, base, p.uid))) return out
  const dirs = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).map((d) => d.name).sort().slice(0, PROMPT_DIRS_MAX)
  for (const name of dirs) {
    const dir = `${base}/${name}`
    for (const f of ((await $.fs.list(dir).catch(() => [])) as { name: string }[]).filter((x) => /^[0-9a-f-]{36}\.relay\.json$/.test(x.name)).slice(0, 16)) {
      const r = await readSmallR($, `${dir}/${f.name}`, p.uid, pr.DECISION_MAX)
      const x = r.state === 'ok' ? pr.parseRelay(r.text) : undefined
      if (x && x.by.sid === sid && `${x.id}.relay.json` === f.name) out.push({ dir, relay: x })
    }
  }
  return out
}

// The relay question raised its PermissionRequest: the relay is marked asked (`<id>.asked` beside the request) and this tier asking (`prompts/asking/<sid>`, removed
// at the question's end), which keeps new requests off it while its question is open.
async function promptRelayAsked($: any, sid: string, shorts: string[]): Promise<void> {
  const p = await where($)
  if (!p || !(await dirOk($, `${p.root}/prompts`, p.uid))) return
  const mine = (await promptOpenRelays($, p, sid)).filter((r) => shorts.includes(r.relay.short))
  if (mine.length === 0) return
  for (const r of mine) await promptLinkOnce($, `${r.dir}/${r.relay.id}.asked`, '{}')
  await run($, [MKDIR, '-p', '-m', '700', `${p.root}/prompts/asking`]).catch(() => undefined)
  await promptPut($, `${p.root}/prompts/asking/${sid}`, '{}')
}

// The hook (§3.1). nextOnce runs the chain beneath at most once, so a failure after it never runs it a second time.
async function promptHook($: any, e: any, nextOnce: (x: any) => Promise<any>, signal: AbortSignal): Promise<any> {
  const sid = await $.session.id()
  if (!c.SID_RE.test(sid)) return nextOnce(e)
  // A request left without its closing row is retried here as well as on the tick (a no-op while none is owed).
  if (unclosed.size > 0) await promptCloseTick($).catch(() => undefined)
  // 0. A tier's relay question (PLAN-PR3 §3.5): it is the person's already (AskUserQuestion), so it raises no request. It marks the relay asked and the tier asking,
  // before the coverage gate, so a conductor's or the manager's question is marked too. The chain beneath runs as it always did.
  if (String(e.tool_name) === 'AskUserQuestion' && relayShorts(e.tool_input).length > 0) {
    await promptRelayAsked($, sid, relayShorts(e.tool_input)).catch(() => undefined)
    return nextOnce(e)
  }
  // 1. The switch and the session's kind. The emergency file wins over the switch.
  const cov = await promptCoverage($, sid)
  if (!cov || (await promptsOff($))) return nextOnce(e)
  const p = await where($)
  if (!p) return nextOnce(e)
  const tool = String(e.tool_name)
  const input = e.tool_input
  // 2. The tool.check entry, looked up before the chain beneath runs (a slow hook beneath cannot outlast its memory).
  let hash: string
  try {
    hash = await sha($, pr.canonical(input))
  } catch {
    return nextOnce(e)
  }
  const key = `${sid}\n${pr.joinKey(tool, hash, undefined)}`
  const entry = checks.get(key)
  // An entry serves one request: a later identical call gets its own tool.check.
  checks.delete(key)
  const started = await $.clock.now()
  const usable = entry !== undefined && !entry.dup && started - entry.at <= CHECK_TTL_MS
  const tid = usable ? entry.toolUseId : undefined
  // The call is marked open now, so a click (and the tool's end) during the chain beneath is seen.
  if (tid !== undefined) {
    openReqs.set(tid, { sid })
    doneIds.delete(tid)
  }
  const reqDir: { dir?: string; id?: string } = {}
  const st: CloseState = { closed: false, requested: false }
  try {
    // 3. The chain beneath: any non-empty result stands and is returned whole (a settings hook's deny, another plugin's answer).
    const beneath = await nextOnce(e)
    if (beneath && typeof beneath === 'object' && Object.keys(beneath).length > 0) return beneath
    // A No click aborted the signal; a Yes ended the dialog with no signal, so the done events are looked at again (probed P-I6).
    if (signal.aborted || (tid !== undefined && doneIds.has(tid))) return beneath
    const cwd = String(await sessionRoot($).catch(() => ''))
    // A session the switch does not cover leaves no row: a scope of one lane or one lead is judged first, and only a scope that names a lead needs the lead's name.
    let lead: { sid: string; name?: string } | undefined
    let leadRead = false
    if (cov.a.scope !== 'all' && cov.a.scope !== cov.lane && cov.a.scope !== cov.self) {
      lead = await promptLeadOf($, cov.level, sid, cwd, cov.lead)
      leadRead = true
      if (!pr.covers(cov.a, { lane: cov.lane, lead: lead?.name, self: cov.self })) return beneath
    }
    const base = { lane: cov.lane ?? cov.self, repo: cwd, tool, pattern: pr.patternOf(tool, input, cwd), hash }
    if (!usable || entry === undefined) {
      await ledgerAdd($, { ...base, kind: 'not-judgeable', code: 'no-check' })
      return beneath
    }
    // 4. Nobody can be asked, or a host answers: not ours.
    if (entry.approver !== 'person') return beneath
    // 5. Which asks agents may judge.
    const judged = pr.classify(tool, entry.facts)
    if (judged.judge === 'person') {
      await ledgerAdd($, { ...base, kind: 'not-judgeable', code: judged.why })
      return beneath
    }
    // 6. The floor.
    // The floor reads relative paths against the folder the engine says the call ran in (a shell keeps its cd between calls), not the folder the session started in.
    const ecwd = typeof e.cwd === 'string' && e.cwd.startsWith('/') ? e.cwd : undefined
    const fo = await promptFloorOpts($, tool, input, ecwd ?? cwd, homeOf(p), ecwd !== undefined)
    const floor = pr.floorCheck(tool, input, fo)
    // What the floor read besides the input: the audit compares it between a floor row and a later request of the same input.
    const ctx = (await sha($, JSON.stringify(fo)).catch(() => '')).slice(0, 16)
    if (floor !== undefined) {
      await ledgerAdd($, { ...base, ...(ctx ? { ctx } : {}), kind: 'floor', code: floor })
      return beneath
    }
    // 7. A live tier: the lead of a lane, or a conductor or the manager (a lead's own prompt starts at the conductor). Nobody in reach, or an asker that the plain
    // session list does not show (a session under another config folder): no row for a judge, the dialog stays the person's.
    if (!leadRead) lead = await promptLeadOf($, cov.level, sid, cwd, cov.lead)
    const leadName = lead?.name
    const own = await registryOf($, sid, ownReg($))
    const liveNow = await registryEntries($)
    const reach = own && typeof own.pid === 'number' && typeof own.procStart === 'string' && liveNow ? await promptReachTiers($, liveNow, cov.a, { sid, pid: own.pid, procStart: own.procStart, level: cov.level, lane: cov.lane ?? cov.self, ...(leadName ? { leadName } : {}), repo: cwd }, cov.level === 'lane' && lead === undefined).catch(() => [] as pr.Tier[]) : ([] as pr.Tier[])
    if (reach.length === 0 && own && typeof own.pid === 'number' && typeof own.procStart === 'string') {
      await ledgerAdd($, { ...base, kind: 'abandoned', code: 'no-tier' })
      return beneath
    }
    if (!pr.covers(cov.a, { lane: cov.lane, lead: leadName, self: cov.self })) return beneath
    // 8. The request, then the wait.
    const dir = await promptDir($, p, sid)
    if (!own || typeof own.pid !== 'number' || typeof own.procStart !== 'string' || !dir) {
      await ledgerAdd($, { ...base, kind: 'abandoned', code: 'hook-failed' })
      return beneath
    }
    const id = await promptNewId($)
    const nonce = await promptNewId($)
    const capped = pr.capInput(input)
    const req: pr.Request = { id, sid, pid: own.pid, procStart: own.procStart, level: cov.level, lane: cov.lane, ...(leadName ? { leadName } : {}), repo: cwd, tool, ...(ecwd !== undefined ? { cwd: ecwd } : {}), inputHash: hash, raisedBy: judged.raisedBy, at: started, expiresAt: started + pr.EXPIRES_MS, nonce, input: capped.input, truncated: capped.truncated }
    const text = pr.requestText(req)
    if (new TextEncoder().encode(text).length > pr.REQUEST_MAX || !(await promptPut($, `${dir}/${id}.request.json`, text))) {
      await ledgerAdd($, { ...base, kind: 'abandoned', code: 'hook-failed' })
      return beneath
    }
    reqDir.dir = dir
    reqDir.id = id
    openReqs.set(tid as string, { sid, id, dir })
    if (doneIds.has(tid as string)) await promptDone($, { tool_use_id: tid })
    const row = { ...base, ...(ctx ? { ctx } : {}), id, tier: [...reach].sort((x, y) => pr.TIER_RANK[x.level] - pr.TIER_RANK[y.level])[0].level }
    // Without a `requested` row no decision could ever pass the ledger check: the dialog is left to the person.
    if (!(await ledgerAdd($, { ...row, kind: 'requested', nonce }))) throw new Error('ledger-unwritable')
    st.requested = true
    return await promptWait($, e, beneath, signal, { sid, tid: tid as string, id, nonce, dir, hash, input, tool, cwd, ecwd, home: homeOf(p), p, started, row, req, leadName, cap: pr.claudeCap(tool, input), st })
  } catch (err) {
    // A failing hook answers nothing: the dialog stays (the caller returns what the chain beneath gives).
    if (!st.closed) {
      const row = { kind: 'abandoned' as const, code: 'hook-failed', id: reqDir.id }
      st.pending = row
      if (await ledgerAdd($, row).catch(() => false)) st.closed = true
    }
    throw err
  } finally {
    // The files go only with a closing row in the ledger. Without one (the write failed, or the person's No cut this dispatch off) they stay, and the tick writes it.
    // A request that never got its `requested` row has nothing to close: its files go as before.
    if (reqDir.id && reqDir.dir && st.requested && !st.closed) {
      unclosed.set(reqDir.id, { dir: reqDir.dir, row: st.pending ?? { kind: 'abandoned', code: 'hook-failed', id: reqDir.id }, tries: 0 })
      openReqs.delete(tid ?? '')
      doneIds.delete(tid ?? '')
      // No hook waits for it any more: marked closed at once, so a lead cannot list or answer it while the row is owed (promptRemoveFiles takes the marker away again).
      await promptMarkDone($, reqDir.dir, reqDir.id)
    } else await promptCleanup($, reqDir.dir, reqDir.id, tid ?? '')
  }
}

type WaitCtx = { sid: string; tid: string; id: string; nonce: string; dir: string; hash: string; input: unknown; tool: string; cwd: string; home: string; p: { uid: number; root: string; own?: string }; started: number; row: Omit<pr.LedgerRow, 't' | 'kind'>; req: pr.Request; leadName?: string; cap?: { kind: pr.CapKind; target: string }; ecwd?: string; st: CloseState }

// The wait (§3.1a, §6.1). Each poll: a click, the switch, the dialog's own row, the relay (§3.2 of PLAN-PR3), expiry, then a decision file. The awake clock adds each gap,
// capped. A relay (a tier put the prompt to the person) makes the wait `withPerson`: expiry at 2 hours, a 10 s poll, and no 20-minute deny.
async function promptWait($: any, e: any, beneath: any, signal: AbortSignal, w: WaitCtx): Promise<any> {
  const end = async (kind: pr.RowKind, code?: string) => {
    const row = { ...w.row, kind, ...(code ? { code } : {}) }
    w.st.pending = row
    if (await ledgerAdd($, row)) w.st.closed = true
    return beneath
  }
  // The dialog counts as closed only once the own row has been seen waiting for this request and is then empty; a row that is missing or ambiguous is unknown.
  const clickSeen = async (): Promise<boolean> => {
    const rowNow = await promptOwnRow($, w).catch(() => undefined)
    if (!rowNow) return false
    const waiting = rowNow.status === 'waiting' && (rowNow.waitingFor ?? null) !== null
    if (waiting && typeof rowNow.statusUpdatedAt === 'number' && rowNow.statusUpdatedAt >= w.started) seenWaiting = true
    else if (seenWaiting && !waiting) return true
    return false
  }
  // The switch is read again at each poll and before an answer is returned: off, an OFF file, or a scope that no longer covers this lane ends the wait.
  const stillOn = async (): Promise<boolean> => {
    if (await promptsOff($)) return false
    const cv = await promptCoverage($, w.sid)
    return cv !== undefined && pr.covers(cv.a, { lane: cv.lane, lead: w.leadName, self: cv.self })
  }
  // What must hold right before an answer goes back: no click, the switch still on.
  const guards = async (): Promise<any | undefined> => {
    if (signal.aborted || doneIds.has(w.tid)) return end('superseded')
    if (!(await stillOn())) return end('off')
    // Live test A, 4c: the person's Yes can land in the moments the decision was being checked, and the engine sends the hook no signal for it. The dialog's own
    // row is read once more right before the answer goes back, so a click already on it wins; one that has not reached the row yet is a lost race (README).
    if (await clickSeen()) return end('superseded')
    return undefined
  }
  const relayPath = `${w.dir}/${w.id}.relay.json`
  const askedPath = `${w.dir}/${w.id}.asked`
  const leftPath = `${w.dir}/${w.id}.left`
  // The relay file as it is now: none, a good one for this request, or a file that is there and is not (taken as lost).
  const readRelay = async (): Promise<pr.Relay | 'bad' | undefined> => {
    if ((await statR($, relayPath)) === 'absent') return undefined
    const r = await readSmallR($, relayPath, w.p.uid, pr.DECISION_MAX)
    if (r.state !== 'ok') return r.state === 'absent' ? undefined : 'bad'
    const x = pr.parseRelay(r.text)
    return x && x.id === w.id && x.nonce === w.nonce ? x : 'bad'
  }
  let last = await $.clock.now()
  let awake = pr.awakeAdd(0, last - w.started)
  let seenWaiting = false
  let lagSince: number | undefined
  let lastDrop = ''
  let relay: pr.Relay | undefined
  let relayFrom = 0
  let askedSeen = false
  let noCount = 0
  let presenceAt = 0
  const relayLost = async (code: string): Promise<void> => {
    const r = relay
    if (!(await ledgerAdd($, { ...w.row, kind: 'relay-lost', code, ...(r ? { short: r.short, by: r.by.sid, tier: r.by.level } : {}) }))) return
    await run($, [RM, '-f', '--', relayPath, askedPath, leftPath]).catch(() => undefined)
    relay = undefined
    askedSeen = false
  }
  for (;;) {
    if (signal.aborted || doneIds.has(w.tid)) return end('superseded')
    // The request file is gone (the sweep closed it): the sweep's row is the closing one, and the dialog is left to the person.
    if ((await statR($, `${w.dir}/${w.id}.request.json`)) === 'absent') {
      w.st.closed = true
      return beneath
    }
    // Off stops the wait whichever way it was turned off: the emergency file or /callboard answering off.
    if (!(await stillOn())) return end('off')
    if (await clickSeen()) return end('superseded')
    // The relay (§3.2): a tier has put the prompt to the person. It is lost when its question is never asked, or its tier is not live for two checks in a row;
    // it ends with `relay-left` when the person dismissed the question.
    const rf = await readRelay()
    if (rf === 'bad') {
      relay = undefined
      await relayLost('bad-file')
    } else {
      if (rf && !relay) {
        relayFrom = awake
        presenceAt = awake
        noCount = 0
        askedSeen = false
      }
      relay = rf
    }
    if (relay) {
      if ((await statR($, leftPath)) !== 'absent') return end('abandoned', 'relay-left')
      if (!askedSeen) askedSeen = (await statR($, askedPath)) !== 'absent'
      if (!askedSeen && awake - relayFrom >= pr.ASKED_WAIT_MS) await relayLost('not-asked')
      else if (awake - presenceAt >= 60_000) {
        presenceAt = awake
        const step = pr.relayLostStep(noCount, await promptRelayTierSeen($, w.p, relay.by))
        noCount = step.noCount
        if (step.lost) await relayLost('tier-gone')
      }
    }
    const withPerson = relay !== undefined
    if (awake >= pr.expiresAfter(withPerson)) return end('abandoned', 'expired')
    const df = await readSmallR($, `${w.dir}/${w.id}.decision.json`, w.p.uid, pr.DECISION_MAX)
    if (df.state === 'bad' && (await statR($, `${w.dir}/${w.id}.decision.json`)) !== 'absent' && lastDrop !== 'file') {
      lastDrop = 'file'
      await ledgerAdd($, { ...w.row, kind: 'dropped', code: 'file' })
    }
    if (df.state === 'ok') {
      const d = pr.parseDecision(df.text)
      if (!d) {
        if (lastDrop !== 'shape') {
          lastDrop = 'shape'
          await ledgerAdd($, { ...w.row, kind: 'dropped', code: 'shape' })
        }
      } else {
        const out = await promptApply($, w, d, awake, lagSince === undefined ? 0 : awake - lagSince)
        if ('hold' in out) {
          if (out.hold === 'ledger') lagSince ??= awake
        } else if ('drop' in out) {
          if (lastDrop !== out.drop) {
            lastDrop = out.drop
            await ledgerAdd($, { ...w.row, kind: 'dropped', code: out.drop })
          }
        } else {
          // The decision stands, unless a click or the switch got there first meanwhile.
          const stop = await guards()
          if (stop !== undefined) return stop
          // A relay that landed while the decision was being checked still wins: an agent's decision is not returned over the person's open question. The person's own
          // answer (via person) is the one decision a relay lets through.
          if (d.via !== 'person' && (await statR($, relayPath)) !== 'absent') {
            // The relay is read at the next poll.
          } else {
            const back = { ...w.row, kind: 'returned' as const, code: d.decision, why: d.why, tier: d.by.level, by: d.by.sid, ...(d.via ? { via: d.via, ...(relay ? { short: relay.short } : {}) } : {}), tuid: w.tid, ...(w.cap ? { cap: w.cap.kind, target: w.cap.target } : {}) }
            w.st.pending = { ...w.row, kind: 'abandoned', code: 'hook-failed' }
            if (!(await ledgerAdd($, back))) return beneath
            w.st.closed = true
            const text = d.via === 'person' ? `Denied by the person via the ${d.by.level} ${d.by.name}.` : `Denied by the ${d.by.level} ${d.by.name}: ${d.why}`
            const decision = d.decision === 'allow' ? { behavior: 'allow' as const } : { behavior: 'deny' as const, message: pr.capBytes(pr.redact(text), 300).text }
            return { ...(beneath && typeof beneath === 'object' ? beneath : {}), decision }
          }
        }
      }
    }
    // The 20-minute deny: nobody answered and nobody put it to the person. Some tier was in reach when the request began (the hook did not start the wait otherwise).
    if (!relay && awake >= pr.DENY_AFTER_MS && (await statR($, relayPath)) === 'absent') {
      const stop = await guards()
      if (stop !== undefined) return stop
      w.st.pending = { ...w.row, kind: 'abandoned', code: 'hook-failed' }
      if (!(await ledgerAdd($, { ...w.row, kind: 'expired-denied', code: 'timeout' }))) return beneath
      w.st.closed = true
      return { ...(beneath && typeof beneath === 'object' ? beneath : {}), decision: { behavior: 'deny' as const, message: pr.DENY_TIMEOUT_MESSAGE } }
    }
    if (!(await pause($, pr.pollFor(withPerson)))) return signal.aborted ? end('superseded') : end('abandoned', 'hook-failed')
    const now = await $.clock.now()
    awake = pr.awakeAdd(awake, now - last)
    last = now
  }
}

// One check of the relaying tier's presence, for relayLostStep: its presence file of the same level passes every check ('yes'), fails one ('no'), or a check could not be
// made ('error').
async function promptRelayTierSeen($: any, p: { uid: number; root: string }, by: pr.Relay['by']): Promise<'yes' | 'no' | 'error'> {
  try {
    const live = await registryEntries($)
    if (!live) return 'error'
    const r = await presenceCheck($, p, live, by.sid, (f) => f.level === by.level)
    return typeof r === 'string' ? r : 'yes'
  } catch {
    return 'error'
  }
}

// Every check a decision must pass, each failure a `dropped <code>` row and the wait going on (pr.applyCheck holds the order and the codes).
async function promptApply($: any, w: WaitCtx, d: pr.Decision, awake: number, graceMs: number): Promise<pr.ApplyOut> {
  let liveHash = ''
  try {
    liveHash = await sha($, pr.canonical(w.input))
  } catch {}
  const fo = await promptFloorOpts($, w.tool, w.input, w.ecwd ?? w.cwd, w.home, w.ecwd !== undefined)
  let byOk = false
  let relay: { sid: string; nonce: string } | undefined
  if (pr.SID.test(d.by.sid) && d.by.sid !== w.sid) {
    const live = await registryEntries($)
    const cv = await promptCoverage($, w.sid)
    if (live && cv) {
      const names = new Set(((await $.fs.list(w.dir).catch(() => [])) as { name: string }[]).map((f) => f.name))
      const stand = await promptStand($, w.p, live, cv.a, w.dir, names, w.req).catch(() => undefined)
      if (stand) {
        // The author is a live tier in reach of this asker that has not passed the request up, and its level is the one its presence gives (never the decision's own).
        byOk = stand.tiers.some((t) => t.sid === d.by.sid && t.level === d.by.level) && stand.passed[d.by.level as pr.TierLevel] === undefined
        if (stand.relay) relay = { sid: stand.relay.by.sid, nonce: stand.relay.nonce }
      } else byOk = false
    }
  }
  const ledger = await ledgerHas($, w.p, w.id, w.nonce, { code: d.decision, by: d.by.sid, ...(d.via ? { via: d.via } : {}) })
  // Only a call that carries an `@claude` body, and only once the other checks would let the decision through, reads the cap.
  const cap = w.cap && ledger === 'found' && d.decision === 'allow' && d.via !== 'person' ? await capOf($, w.p, w.cap) : undefined
  return pr.applyCheck({ req: w.req, decision: d, liveHash, awakeMs: awake, expiresAt: pr.expiresAfter(relay !== undefined), floor: pr.floorCheck(w.tool, w.input, fo), byOk, ...(relay ? { relay } : {}), ledger, graceMs, cap })
}

// The light link (PLAN-PR3 §3.3): an AskUserQuestion of this tier's own session has ended. For each question headed `Relay <short>` that names a relay of this session,
// the person's answer exactly `Yes` or `No` becomes the decision (written here, by the mod, with `via: person`); a dismissal or any other answer is `relay-left`; one for
// a prompt that has closed, or whose decision is already in, is `relay-late` and the tier is told in one fixed line. The question's wording is never read.
async function promptRelayPost($: any, e: any): Promise<string | undefined> {
  if (String(e?.tool_name) !== 'AskUserQuestion' || (typeof e?.agent_id === 'string' && e.agent_id !== '')) return undefined
  // The questions as asked: the call's input, or (probed on the engine) the response, which repeats them with their headers.
  const qin = Array.isArray(e.tool_input?.questions) ? e.tool_input : e.tool_response && typeof e.tool_response === 'object' ? e.tool_response : e.tool_input
  const shorts = relayShorts(qin)
  if (shorts.length === 0) return undefined
  const sid = await $.session.id()
  const p = await where($)
  if (!c.SID_RE.test(sid) || !p) return undefined
  // The question is over, whatever the answer: this tier is free for new requests.
  await run($, [RM, '-f', '--', `${p.root}/prompts/asking/${sid}`]).catch(() => undefined)
  const open = await promptOpenRelays($, p, sid)
  let late = false
  for (const a of pr.relayAnswers(qin, e.tool_response, open.map((r) => ({ id: r.relay.id, short: r.relay.short })))) {
    const r = open.find((x) => x.relay.id === a.id)
    if (a.outcome === 'unknown' || !r) {
      late = true
      const rows = await ledgerRowsFor($, p, `"short":"${a.short}"`)
      const was = rows === 'unreadable' ? undefined : rows.find((x) => x.kind === 'relayed' && x.short === a.short && x.by === sid)
      await ledgerAdd($, { kind: 'relay-late', short: a.short, by: sid, code: 'closed', ...(was?.id ? { id: was.id } : {}) })
      continue
    }
    const { dir, relay } = r
    const id = relay.id
    if (a.outcome === 'left') {
      if ((await promptLinkOnce($, `${dir}/${id}.left`, '{}')) === 'ok') await ledgerAdd($, { kind: 'relay-left', id, short: relay.short, by: sid, tier: relay.by.level })
      continue
    }
    const rr = await readSmallR($, `${dir}/${id}.request.json`, p.uid, pr.REQUEST_MAX)
    const q = rr.state === 'ok' ? pr.parseRequest(rr.text) : undefined
    const lateRow = async () => {
      late = true
      await ledgerAdd($, { kind: 'relay-late', id, short: relay.short, by: sid, tier: relay.by.level, code: q ? 'decided' : 'closed' })
    }
    if (!q || q.id !== id || q.nonce !== relay.nonce) {
      await lateRow()
      continue
    }
    const now = await $.clock.now()
    const who = relay.by.name === '' ? relay.by.level : relay.by.name
    const why = `the person answered ${a.outcome === 'allow' ? pr.RELAY_YES : pr.RELAY_NO} via the ${relay.by.level} ${who}`.slice(0, pr.WHY_MAX)
    const path = `${dir}/${id}.decision.json`
    const body = JSON.stringify({ id, inputHash: q.inputHash, decision: a.outcome, why, by: { level: relay.by.level, sid, name: who }, via: 'person', at: now, nonce: q.nonce })
    let put = await promptLinkOnce($, path, body)
    if (put === 'exists') {
      // An agent's decision that was written before the relay (and is not applied under it) gives way to the person's; the person's own earlier answer does not.
      const old = await readSmallR($, path, p.uid, pr.DECISION_MAX)
      const od = old.state === 'ok' ? pr.parseDecision(old.text) : undefined
      if (od && od.via !== 'person') {
        await run($, [RM, '-f', '--', path]).catch(() => undefined)
        put = await promptLinkOnce($, path, body)
      }
    }
    if (put !== 'ok') {
      await lateRow()
      continue
    }
    if ((await statR($, `${dir}/${id}.request.json`)) === 'absent') {
      await run($, [RM, '-f', '--', path]).catch(() => undefined)
      await lateRow()
      continue
    }
    const ok = await ledgerAdd($, { id, nonce: q.nonce, lane: q.lane, repo: q.repo, tool: q.tool, pattern: pr.patternOf(q.tool, q.input, q.repo), hash: q.inputHash, tier: relay.by.level, why, kind: 'answered', code: a.outcome, by: sid, via: 'person', short: relay.short })
    if (!ok) await run($, [RM, '-f', '--', path]).catch(() => undefined)
  }
  return late ? pr.RELAY_LATE_LINE : undefined
}

// The tick's sweep: a request whose session is gone, or older than a day, is closed with a row and its files removed. No process call unless a prompts folder is there.
async function promptSweep($: any): Promise<void> {
  const now = await $.clock.now()
  if (now - lastSweepAt < SWEEP_EVERY_MS) return
  lastSweepAt = now
  const p = await where($)
  if (!p) return
  const base = `${p.root}/prompts`
  await promptSweepAsking($, base)
  const all = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).sort((a, b) => (a.name < b.name ? -1 : 1))
  if (all.length === 0) return
  // At most SWEEP_DIRS_MAX folders a tick, taking up where the last tick stopped, so every folder is reached however many there are.
  if (sweepFrom >= all.length) sweepFrom = 0
  const dirs = all.slice(sweepFrom, sweepFrom + SWEEP_DIRS_MAX)
  sweepFrom = sweepFrom + SWEEP_DIRS_MAX >= all.length ? 0 : sweepFrom + SWEEP_DIRS_MAX
  const live = await registryEntries($)
  const busy = new Set([...openReqs.values()].flatMap((o) => (o.id ? [o.id] : [])).concat([...unclosed.keys()]))
  for (const d of dirs) {
    const files = (await $.fs.list(`${base}/${d.name}`).catch(() => [])) as { name: string; mtimeMs?: number }[]
    const gone = live !== undefined && !live.some((r) => r.j.sessionId === d.name)
    // A request older than a day is abandoned only if no live process of that session still holds it: the wait runs on awake time, so a long sleep ages the file, not the prompt.
    const heldByLive = async (name: string): Promise<boolean> => {
      const r = await readSmallR($, `${base}/${d.name}/${name}`, p.uid, pr.REQUEST_MAX)
      if (r.state !== 'ok') return false
      try {
        const q = JSON.parse(r.text)
        return (live ?? []).some((x) => x.j.sessionId === d.name && String(x.j.pid) === String(q?.pid) && x.j.procStart === q?.procStart)
      } catch {
        return false
      }
    }
    const requests = new Set(files.flatMap((f) => (/^[0-9a-f-]{36}\.request\.json$/.test(f.name) ? [f.name.slice(0, 36)] : [])))
    for (const f of files) {
      const old = typeof f.mtimeMs === 'number' && now - f.mtimeMs > pr.SWEEP_MS
      const m = /^([0-9a-f-]{36})\.request\.json$/.exec(f.name)
      if (m) {
        if (!pr.ID_RE.test(m[1]) || busy.has(m[1])) continue
        if (!gone && (!old || live === undefined || (await heldByLive(f.name)))) continue
        // No row, no removal: the next sweep tries again.
        if (!(await ledgerAdd($, { kind: 'abandoned', code: gone ? 'session-gone' : 'swept', id: m[1] }))) continue
        await run($, [RM, '-f', '--', ...PROMPT_SUFFIXES.map((x) => `${base}/${d.name}/${m[1]}.${x}`)]).catch(() => undefined)
        continue
      }
      // A file whose request is gone (a crash between the two removals, or a half-written copy), a day old: removed with no row, it names no open request.
      const o = /^([0-9a-f-]{36})\.(decision\.json|done|escalate(?:-lead|-conductor|-manager)?\.json|relay\.json|asked|left)$/.exec(f.name)
      const orphan = (o !== null && pr.ID_RE.test(o[1]) && !requests.has(o[1]) && !busy.has(o[1])) || /^[0-9a-f-]{36}\.[A-Za-z.]+\.\d+\.tmp$/.test(f.name)
      if (orphan && old) await run($, [RM, '-f', '--', `${base}/${d.name}/${f.name}`]).catch(() => undefined)
    }
    // A folder of a session that has ended, with nothing left in it, goes too (rmdir refuses a folder that holds anything).
    if (gone && files.length === 0) await run($, [RMDIR, '--', `${base}/${d.name}`]).catch(() => undefined)
  }
}

// The `asking` files (a tier with a relay question open) of sessions that have ended go with them. A live session's file stays: it lives as long as its question.
async function promptSweepAsking($: any, base: string): Promise<void> {
  const files = ((await $.fs.list(`${base}/asking`).catch(() => [])) as { name: string }[]).filter((f) => c.SID_RE.test(f.name)).slice(0, 64)
  if (files.length === 0) return
  const live = await registryEntries($)
  if (!live) return
  for (const f of files) if (!live.some((r) => r.j.sessionId === f.name)) await run($, [RM, '-f', '--', `${base}/asking/${f.name}`]).catch(() => undefined)
}

async function answeringCommand($: any, sid: string, code: c.OriginCode, op: pr.AnsweringOp): Promise<{ text: string }> {
  if (op === 'bad') return { text: pr.ANSWERING_USAGE }
  const read = async () => pr.parseAnswering(await $.store.get(ANSWERING_KEY).catch(() => undefined))
  if (op === 'show') return { text: pr.answeringState(await read(), await promptsOff($)) }
  // Off narrows only: any origin, no dialog. It clears the stored switch as well, so deleting the OFF file later does not turn answering back on.
  if (op === 'off' || op === 'off-asks') {
    const a = await read()
    try {
      if (op === 'off') await $.store.delete(ANSWERING_KEY)
      else if (a) await $.store.set(ANSWERING_KEY, { ...a, asks: false })
    } catch {
      await log($, sid, 'error', 'answering-store').catch(() => undefined)
      return { text: 'Prompt answering could not be changed: the store did not answer. Create ~/.claude/callboard/prompts/OFF to stop it now.' }
    }
    await ledgerAdd($, { kind: 'answering-off', code: op })
    return { text: op === 'off' ? 'Prompt answering is off on this Mac.' : 'Answering questions is off; permission prompts are unchanged.' }
  }
  // On is the person's own command, with a dialog that names exactly what turns on.
  if (!c.originIsPerson(code)) {
    await log($, sid, 'refused', `answering-not-person:${code}`).catch(() => undefined)
    return { text: pr.ANSWERING_NOT_PERSON }
  }
  const r = await askOnce($, sid, pr.answeringQuestion(op.on, op.asks), pr.ANSWERING_YES, pr.ANSWERING_NO, pr.ANSWERING_HEADER)
  if (r === 'busy') return { text: 'A callboard question is already open. Answer it first.' }
  if (r !== 'yes') return { text: r === 'timed-out' ? 'Nothing changed: the question timed out.' : 'Cancelled. Nothing changed.' }
  const value: pr.Answering = { scope: op.on, asks: op.asks, savedAt: await $.clock.now() }
  try {
    await $.store.set(ANSWERING_KEY, value)
  } catch {
    return { text: 'Prompt answering could not be turned on: the store did not answer. Nothing changed.' }
  }
  await ledgerAdd($, { kind: 'answering-on', hash: await sha($, pr.canonical(value)).catch(() => undefined) })
  return { text: `${pr.answeringState(value, await promptsOff($))} ${pr.FLOOR_LINE}` }
}

async function promptsCommand($: any): Promise<{ text: string }> {
  const a = pr.parseAnswering(await $.store.get(ANSWERING_KEY).catch(() => undefined))
  const p = await where($)
  let open = 0
  if (p) {
    for (const d of ((await $.fs.list(`${p.root}/prompts`).catch(() => [])) as { name: string }[]).filter((x) => c.SID_RE.test(x.name)).slice(0, 512))
      open += ((await $.fs.list(`${p.root}/prompts/${d.name}`).catch(() => [])) as { name: string }[]).filter((f) => f.name.endsWith('.request.json')).length
  }
  return { text: `${pr.answeringState(a, await promptsOff($))} Open requests: ${open}. ${pr.FLOOR_LINE}` }
}

// ---- PR 2: the lead tier (prompt_list, prompt_answer, prompt_escalate) and its notice ----
const LN = '/bin/ln'
const PROMPT_REQUESTS_MAX = 64
const PROMPT_DIRS_MAX = 512
const promptReason = (tool: string, why: string) => `${tool} refused: ${why}`
const promptRefuse = (code: string): string => pr.PROMPT_REFUSE[code] ?? code

type PromptFile = { dir: string; req: pr.Request; names: Set<string> }

// The request files in the prompts folders, parsed: a folder or file that is not ours (owner, mode, one link, size, shape, a name that does not match the
// request inside it) is skipped. At most PROMPT_REQUESTS_MAX, in folder order.
const PROMPT_SCAN_MAX = 256
async function promptRequests($: any, p: { uid: number; root: string }, accept?: (q: pr.Request, names: Set<string>, dir: string) => Promise<boolean>): Promise<PromptFile[]> {
  let scanned = 0
  const base = `${p.root}/prompts`
  const out: PromptFile[] = []
  if (!(await dirOk($, base, p.uid))) return out
  const dirs = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).map((d) => d.name).sort().slice(0, PROMPT_DIRS_MAX)
  for (const name of dirs) {
    if (out.length >= PROMPT_REQUESTS_MAX) break
    const dir = `${base}/${name}`
    const names = new Set(((await $.fs.list(dir).catch(() => [])) as { name: string }[]).map((f) => f.name))
    const ids = [...names].flatMap((n) => (/^[0-9a-f-]{36}\.request\.json$/.test(n) ? [n.slice(0, 36)] : []))
    if (ids.length === 0 || !(await dirOk($, dir, p.uid))) continue
    for (const id of ids) {
      if (out.length >= PROMPT_REQUESTS_MAX || scanned >= PROMPT_SCAN_MAX) break
      scanned++
      const r = await readSmallR($, `${dir}/${id}.request.json`, p.uid, pr.REQUEST_MAX)
      if (r.state !== 'ok') continue
      const q = pr.parseRequest(r.text)
      if (q && q.id === id && q.sid === name && (accept === undefined || (await accept(q, names, dir)))) out.push({ dir, req: q, names })
    }
  }
  return out
}

// The tiers a request reaches (PLAN-PR3 §2.1), lead first, then the conductors, then the manager: the asker must be a live row under the pid and start the request
// names; a lead is a live lead of the repo (narrowed to the lead the request names), a conductor one whose approved pins hold the request's folder, the manager a
// trusted one. The switch's scope applies to each. Nobody is the asker. noLead: the lane's own lead could not be resolved (its record names another, or none is
// found), so no lead is asked, whichever leads are live. Empty: nobody can be asked, and the prompt stays the person's.
type ReachQ = Pick<pr.Request, 'sid' | 'pid' | 'procStart' | 'level' | 'lane' | 'leadName' | 'repo'>
async function promptReachTiers($: any, live: RegRow[], a: pr.Answering, q: ReachQ, noLead = false): Promise<pr.Tier[]> {
  if (!live.some((r) => r.j.sessionId === q.sid && String(r.j.pid) === r.pid && r.pid === String(q.pid) && r.j.procStart === q.procStart)) return []
  const rows = live.map((r) => r.j)
  const tiers: pr.Tier[] = []
  // A lead's own prompt starts at the conductor: no lead tier for it.
  if (q.level === 'lane' && !noLead) {
    for (const l of await leadsFor($, live, q.repo).catch(() => [] as c.LeadFile[])) {
      const name = c.leadNameOf(rows, l.sid) ?? ''
      if (l.sid === q.sid || (q.leadName !== undefined && (name === '' || q.leadName !== name))) continue
      if (pr.covers(a, { lane: q.lane, lead: name === '' ? undefined : name })) tiers.push({ level: 'lead', sid: l.sid, name })
    }
  }
  if (pr.covers(a, { lane: q.level === 'lane' ? q.lane : undefined, lead: q.leadName, self: q.level === 'lead' ? q.lane : undefined })) {
    for (const x of await conductorsReaching($, live, q.sid, (r) => r === q.repo || c.within(r, q.repo)).catch(() => [])) tiers.push({ level: 'conductor', sid: x.sid, name: x.name ?? '' })
    for (const m of await managersLive($, live, q.sid).catch(() => [])) if (m.unverified !== true && m.name !== undefined) tiers.push({ level: 'manager', sid: m.sid, name: m.name })
  }
  return tiers
}

// Where a request stands: who it reaches, who has passed it up (the files `<id>.escalate-<level>.json`, with the time of each), the relay if a tier put it to the
// person, which of the reached tiers can act now (not passed, and not asking: a tier whose own relay question is open is blocked in that turn, unless it is this
// request's relay), the top one of those, and when each one's window opens.
type Stand = { tiers: pr.Tier[]; active: pr.Tier[]; top?: pr.Tier; passed: Partial<Record<pr.TierLevel, number>>; relay?: pr.Relay; windows: Record<string, number> }
async function promptStand($: any, p: { uid: number; root: string }, live: RegRow[], a: pr.Answering, dir: string, names: Set<string>, q: pr.Request): Promise<Stand> {
  const tiers = await promptReachTiers($, live, a, q)
  const passed: Partial<Record<pr.TierLevel, number>> = {}
  for (const l of pr.TIER_LEVELS) {
    for (const n of l === 'lead' ? ['escalate-lead.json', 'escalate.json'] : [`escalate-${l}.json`]) {
      if (!names.has(`${q.id}.${n}`)) continue
      const r = await readSmallR($, `${dir}/${q.id}.${n}`, p.uid, pr.DECISION_MAX)
      const at = r.state === 'ok' ? pr.parseEscalate(r.text)?.at : undefined
      passed[l] = Math.min(passed[l] ?? Infinity, typeof at === 'number' ? at : q.at)
    }
  }
  let relay: pr.Relay | undefined
  if (names.has(`${q.id}.relay.json`)) {
    const r = await readSmallR($, `${dir}/${q.id}.relay.json`, p.uid, pr.DECISION_MAX)
    const x = r.state === 'ok' ? pr.parseRelay(r.text) : undefined
    if (x && x.id === q.id && x.nonce === q.nonce) relay = x
  }
  const asking = new Set<string>()
  for (const t of tiers) if (t.sid !== relay?.by.sid && (await statR($, `${p.root}/prompts/asking/${t.sid}`)) !== 'absent') asking.add(t.sid)
  const active = tiers.filter((t) => passed[t.level] === undefined && !asking.has(t.sid))
  const reps = pr.TIER_LEVELS.flatMap((l) => active.filter((t) => t.level === l).slice(0, 1))
  const opens = pr.tierWindows(q.at, reps, passed)
  const windows: Record<string, number> = {}
  for (const t of active) windows[t.sid] = opens[reps.find((r) => r.level === t.level)!.sid]
  return { tiers, active, top: pr.topOf(active), passed, relay, windows }
}

// Whether a tier's window for a request has not opened. The first tier's window is the 30-second minimum itself, which the hook holds a decision for; refusing an
// answer in it would only change what a lead sees, so only a later window refuses.
const promptWindowShut = (q: pr.Request, s: Stand, sid: string, now: number): boolean => s.windows[sid] !== undefined && s.windows[sid] > q.at + pr.MIN_AGE_MS && now < s.windows[sid]

// The tier's own context for the three tools: the lead steps every lead tool shares, the switch, the OFF file.
async function promptTierCtx($: any, e: unknown, sid: string) {
  const base = await leadBase($, e, sid)
  if ('err' in base) return base
  const p = await where($)
  if (!p) return { err: ['write-failed', pr.PROMPT_REFUSE['write-failed']] as const }
  const answering = pr.parseAnswering(await $.store.get(ANSWERING_KEY).catch(() => undefined))
  return { ...base, p, answering, off: await promptsOff($) }
}

// A request by id, with every refusal the answering tools share. Each refusal is a code of pr.PROMPT_REFUSE.
async function promptFind($: any, t: { p: { uid: number; root: string }; live: RegRow[]; g: c.Grant; answering: pr.Answering }, sid: string, id: string, allowDecided = false): Promise<{ file: PromptFile; stand: Stand; self: pr.Tier } | { no: string }> {
  const base = `${t.p.root}/prompts`
  if (!(await dirOk($, base, t.p.uid))) return { no: 'unknown-request' }
  const dirs = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).map((d) => d.name).sort().slice(0, PROMPT_DIRS_MAX)
  let found: { dir: string; names: Set<string>; q: pr.Request } | undefined
  for (const name of dirs) {
    const dir = `${base}/${name}`
    const names = new Set(((await $.fs.list(dir).catch(() => [])) as { name: string }[]).map((f) => f.name))
    if (!names.has(`${id}.request.json`) || !(await dirOk($, dir, t.p.uid))) continue
    const r = await readSmallR($, `${dir}/${id}.request.json`, t.p.uid, pr.REQUEST_MAX)
    const q = r.state === 'ok' ? pr.parseRequest(r.text) : undefined
    if (!q || q.id !== id || q.sid !== name) continue
    // Two folders holding a request with one id: the tier could judge one and answer the other, so neither is answered.
    if (found !== undefined) return { no: 'unknown-request' }
    found = { dir, names, q }
  }
  if (found === undefined) return { no: 'unknown-request' }
  const { dir, names, q } = found
  if (q.sid === sid) return { no: 'own-request' }
  const stand = await promptStand($, t.p, t.live, t.answering, dir, names, q)
  const self = stand.tiers.find((x) => x.sid === sid)
  if (!self) return { no: 'unknown-request' }
  if (names.has(`${id}.done`)) return { no: 'closed' }
  if (stand.passed[self.level] !== undefined) return { no: 'escalated' }
  if (stand.relay) return { no: 'with-person' }
  // A tier whose own question is open (and not this request's) cannot act; it could not call a tool at all, so this is only a stale view.
  if (!stand.active.some((x) => x.sid === sid)) return { no: 'unknown-request' }
  // A decision the hook dropped (a cap, the floor at apply) stays in the folder: passing the request up is still open to the tier, answering again is not.
  if (!allowDecided && names.has(`${id}.decision.json`)) return { no: 'decided' }
  return { file: { dir, req: q, names }, stand, self }
}

// A file of ours, written whole beside its name and linked into place: `ln` fails when the target exists, so the first writer wins (mv -n gives no failure to
// rely on). 'exists': the target was there; 'failed': nothing was written.
async function promptLinkOnce($: any, path: string, text: string): Promise<'ok' | 'exists' | 'failed'> {
  // Two leads of one repo are two processes writing in the asker's folder: the name carries digits drawn from a fresh uuid (the sweep's orphan pattern is
  // `<id>.<word>.<digits>.tmp`), so a counter that two processes share cannot make them write one file.
  let tmp = ''
  try {
    tmp = `${path}.${BigInt(`0x${(await promptNewId($)).replace(/-/g, '').slice(0, 16)}`).toString()}.tmp`
    if ((await run($, [INSTALL, '-m', '600', '/dev/null', tmp])).exitCode !== 0) return 'failed'
    if ((await run($, [TEE, '--', tmp], text)).exitCode !== 0) return 'failed'
    const l = await run($, [LN, '--', tmp, path])
    if (l.exitCode === 0) {
      // A target that was a folder, or a link to one, takes the link inside it and says nothing: only a plain file in place counts.
      const f = await statR($, path)
      return f !== 'absent' && f !== 'error' && f.kind === 'file' ? 'ok' : 'failed'
    }
    return (await statR($, path)) === 'absent' ? 'failed' : 'exists'
  } catch {
    return 'failed'
  } finally {
    if (tmp !== '') await run($, [RM, '-f', '--', tmp]).catch(() => undefined)
  }
}

// Dropped decisions this month and last that look forged or stale (the codes the audit counts as anomalies): a cheap, ledger-only number for prompt_list.
async function promptAnomalyHint($: any, p: { uid: number; root: string }): Promise<string | undefined> {
  const rows = await ledgerRowsFor($, p, '"kind":"dropped"')
  if (rows === 'unreadable') return undefined
  const n = rows.filter((r) => r.kind === 'dropped' && ['no-answered-row', 'id', 'hash', 'nonce', 'by-sid'].includes(String(r.code))).length
  return n > 0 ? `${n} decision${n === 1 ? ' was' : 's were'} dropped in the last two months for a reason that can mean a forged or stale file; tell the person (tools/callboard/prompt-audit.mjs lists them).` : undefined
}

async function promptListTool($: any, e: unknown): Promise<{ result: string } | { deny: string }> {
  const sid = await $.session.id()
  const t = await promptTierCtx($, e, sid)
  if ('err' in t) {
    await log($, sid, 'refused', `prompt-${t.err[0]}`)
    return { deny: promptReason('prompt_list', t.err[1]) }
  }
  if (!t.answering || t.off) return { result: pr.promptListText([], { on: false }) }
  const now = await $.clock.now()
  const items: pr.ListItem[] = []
  const stands = new Map<string, { stand: Stand; self: pr.Tier }>()
  const open = (
    await promptRequests($, t.p, async (q, names, dir) => {
      if (names.has(`${q.id}.done`) || names.has(`${q.id}.decision.json`) || q.sid === sid) return false
      const stand = await promptStand($, t.p, t.live, t.answering!, dir, names, q)
      const self = stand.tiers.find((x) => x.sid === sid)
      // Not in reach, passed up, or blocked in its own question: not this tier's to see.
      if (!self || stand.passed[self.level] !== undefined || !stand.active.some((x) => x.sid === sid)) return false
      stands.set(q.id, { stand, self })
      return true
    })
  ).sort((a, b) => a.req.at - b.req.at)
  for (const f of open) {
    const q = f.req
    const s = stands.get(q.id)!
    const top = s.stand.top
    const turn = pr.turnLine({ relay: s.stand.relay?.by, top: top?.sid === s.self.sid || top?.level === s.self.level, above: top, opensInSec: promptWindowShut(q, s.stand, sid, now) ? (s.stand.windows[sid] - now) / 1000 : undefined })
    items.push({ id: q.id, lane: q.lane, tool: q.tool, repo: q.repo, raisedBy: q.raisedBy, ageSec: (now - q.at) / 1000, truncated: q.truncated, agentType: q.agentType, input: q.input, turn })
  }
  return { result: pr.promptListText(items, { on: true, hint: await promptAnomalyHint($, t.p).catch(() => undefined) }) }
}

// prompt_answer and prompt_escalate share their checks; `answer` false is the escalation: a tier that is not the top one passes the request up, the top one puts it
// to the person (the relay).
async function promptAnswerTool($: any, e: any, answer: boolean): Promise<{ result: string } | { deny: string }> {
  const sid = await $.session.id()
  const tool = answer ? 'prompt_answer' : 'prompt_escalate'
  const refuse = async (code: string, why?: string) => {
    await log($, sid, 'refused', `prompt-${code}`)
    return { deny: promptReason(tool, why ?? promptRefuse(code)) }
  }
  const t = await promptTierCtx($, e, sid)
  if ('err' in t) return refuse(t.err[0], t.err[1])
  const id = typeof e.id === 'string' ? e.id : ''
  const decision = e.decision
  const why = pr.cleanWhy(e.why)
  if (!pr.ID_RE.test(id) || why === undefined || (answer && decision !== 'allow' && decision !== 'deny')) return refuse('bad-input')
  if (!t.answering || t.off) return refuse('off')
  const found = await promptFind($, { p: t.p, live: t.live, g: t.g, answering: t.answering }, sid, id, !answer)
  if ('no' in found) return refuse(found.no)
  const { dir, req: q, names } = found.file
  const { stand, self } = found
  const name = self.name === '' ? self.level : self.name
  const now = await $.clock.now()
  // The decision is judged on the copy the tier read. A truncated copy cannot be allowed (the rubric: seen whole), and cannot be put to the person either: it is
  // denied, asking the lane for a cleaner call. A floor call is never answered, whichever way.
  if (answer) {
    if (q.truncated && decision === 'allow') return refuse('truncated')
    if (!q.truncated) {
      const fo = await promptFloorOpts($, q.tool, q.input, q.cwd ?? q.repo, homeOf(t.p), q.cwd !== undefined)
      if (pr.floorCheck(q.tool, q.input, fo) !== undefined) return refuse('floor')
    }
    if (promptWindowShut(q, stand, sid, now)) return refuse('window')
  }
  const cap = answer && decision === 'allow' ? pr.claudeCap(q.tool, q.input) : undefined
  if (cap && (await capOf($, t.p, cap)) !== 'ok') return refuse('cap')
  const row = { id, nonce: q.nonce, lane: q.lane, repo: q.repo, tool: q.tool, pattern: pr.patternOf(q.tool, q.input, q.repo), hash: q.inputHash, tier: self.level, why }
  // The request closing while a file is written leaves nothing behind: the file goes, nothing is logged.
  const gone = async (path: string) => {
    if ((await statR($, `${dir}/${id}.request.json`)) !== 'absent') return false
    await run($, [RM, '-f', '--', path]).catch(() => undefined)
    return true
  }
  if (answer) {
    const path = `${dir}/${id}.decision.json`
    const body = JSON.stringify({ id, inputHash: q.inputHash, decision, why, by: { level: self.level, sid, name }, at: now, nonce: q.nonce })
    const put = await promptLinkOnce($, path, body)
    if (put === 'exists') return refuse('decided')
    if (put === 'failed') return refuse('write-failed')
    if (await gone(path)) return refuse('closed')
    // A tier that put the request to the person while this decision was being written wins: the decision is taken back (B1c).
    if ((await statR($, `${dir}/${id}.relay.json`)) !== 'absent') {
      await run($, [RM, '-f', '--', path]).catch(() => undefined)
      return refuse('with-person')
    }
    // The row is written only after the file is in place; the hook holds a decision it sees a moment before its row for a few seconds. A row that cannot be written
    // takes the file back, so a decision never stands without its row.
    if (!(await ledgerAdd($, { ...row, kind: 'answered', code: decision, by: sid, ...(cap ? { cap: cap.kind, target: cap.target } : {}) }))) {
      await run($, [RM, '-f', '--', path]).catch(() => undefined)
      return refuse('write-failed')
    }
    if (decision === 'deny' && pr.isUnclear(why)) await ledgerAdd($, { ...row, kind: 'deny-unclear', code: 'deny', by: sid })
    return { result: `Recorded: ${decision} for ${id}. The dialog stays open in front of the person and their click wins; your answer lands once the prompt has been open 30 seconds. It is yours, not the person's, and carries no approval for anything else.` }
  }
  // Escalation. Not the top tier: pass it up, and the next tier's window opens at once (the 30 seconds still bind).
  if (self.level !== stand.top?.level) {
    const path = `${dir}/${id}.escalate-${self.level}.json`
    const put = await promptLinkOnce($, path, pr.escalateText({ id, tier: 'up', why, at: now, level: self.level, sid }))
    if (put === 'exists') return refuse('escalated')
    if (put === 'failed') return refuse('write-failed')
    if (await gone(path)) return refuse('closed')
    if (!(await ledgerAdd($, { ...row, kind: 'escalated', code: self.level }))) {
      await run($, [RM, '-f', '--', path]).catch(() => undefined)
      return refuse('write-failed')
    }
    return { result: `Passed up: ${id} goes to the next tier, and your right to answer it has ended.` }
  }
  // The top tier: the person decides. A decision already there blocks it; a truncated copy cannot be put to them.
  if (q.truncated) return refuse('truncated')
  if (names.has(`${id}.decision.json`) || (await statR($, `${dir}/${id}.decision.json`)) !== 'absent') return refuse('decided')
  if (promptWindowShut(q, stand, sid, now)) return refuse('window')
  const short = pr.shortOf(id)
  const path = `${dir}/${id}.relay.json`
  const put = await promptLinkOnce($, path, pr.relayText({ id, short, by: { level: self.level, sid, name }, at: now, nonce: q.nonce }))
  if (put === 'exists') return refuse('with-person')
  if (put === 'failed') return refuse('write-failed')
  if (await gone(path)) return refuse('closed')
  // An agent decision that landed while the relay was written wins: the relay is taken back (the first one in place decides).
  if ((await statR($, `${dir}/${id}.decision.json`)) !== 'absent') {
    await run($, [RM, '-f', '--', path]).catch(() => undefined)
    return refuse('decided')
  }
  if (!(await ledgerAdd($, { ...row, kind: 'relayed', code: self.level, short, by: sid }))) {
    await run($, [RM, '-f', '--', path]).catch(() => undefined)
    return refuse('write-failed')
  }
  return { result: pr.relaySteps(short, q.lane ?? '') }
}

// The tick's notice (§6.2): one fixed turn to an idle lead (a busy one gets the text mid-turn, promptMidTurnNotice), covering every open request in reach. A request is told once; a notice over the hourly cap stays owed
// (the next tick tries again). Nothing is read while answering is off, but one store read.
// Per lead: request id to 0 (told) or to the time it was found not to be in reach (looked at again after PROMPT_RECHECK_MS: a check that failed once must not
// hide a request for good).
const PROMPT_RECHECK_MS = 60_000
const PROMPT_WINDOW_RECHECK_MS = 15_000
// Per tier: the requests whose relay was seen (so that one that goes away with the request still open is told again).
const promptRelaySeen = new Map<string, Set<string>>()
const promptTold = new Map<string, Map<string, number>>()
const promptNotices = new Map<string, number[]>()
const promptCapLogged = new Set<string>()
async function promptNoticeTick($: any, sid: string, submitsAtStart: number): Promise<void> {
  const g = grantOf(sid)
  if (g?.level !== 'lead' && g?.level !== 'conductor' && g?.level !== 'manager') return
  const answering = pr.parseAnswering(await $.store.get(ANSWERING_KEY).catch(() => undefined))
  if (!answering || (await promptsOff($))) {
    promptTold.delete(sid)
    return
  }
  const p = await where($)
  if (!p) return
  const base = `${p.root}/prompts`
  // Open requests: not closed, no decision yet. One with a relay is with the person (no tier is told of it); if its relay goes (lost), it is owed again.
  const open = new Map<string, { dir: string; names: Set<string> }>()
  const relayed = new Set<string>()
  const dirs = ((await $.fs.list(base).catch(() => [])) as { name: string }[]).filter((d) => c.SID_RE.test(d.name)).map((d) => d.name).sort().slice(0, PROMPT_DIRS_MAX)
  for (const name of dirs) {
    const names = new Set(((await $.fs.list(`${base}/${name}`).catch(() => [])) as { name: string }[]).map((f) => f.name))
    for (const n of names) {
      const m = /^([0-9a-f-]{36})\.request\.json$/.exec(n)
      if (!m || !pr.ID_RE.test(m[1]) || names.has(`${m[1]}.done`) || names.has(`${m[1]}.decision.json`)) continue
      if (names.has(`${m[1]}.relay.json`)) relayed.add(m[1])
      else open.set(m[1], { dir: `${base}/${name}`, names })
    }
  }
  const told = promptTold.get(sid) ?? new Map<string, number>()
  const seenRelay = promptRelaySeen.get(sid) ?? new Set<string>()
  promptRelaySeen.set(sid, seenRelay)
  for (const id of [...told.keys()]) if (!open.has(id) && !relayed.has(id)) told.delete(id)
  for (const id of [...seenRelay]) if (!open.has(id) && !relayed.has(id)) seenRelay.delete(id)
  for (const id of relayed) seenRelay.add(id)
  // A relay that went away with the request still open (relay-lost): the top tier is told again.
  for (const id of [...seenRelay]) {
    if (open.has(id)) {
      told.delete(id)
      seenRelay.delete(id)
    }
  }
  promptTold.set(sid, told)
  const at = await $.clock.now()
  // 0: told. -1: this tier's, owed a notice (not read again). Above 0: not this tier's yet (not in reach, or its window not open): looked at again at that time.
  const fresh = [...open.keys()].filter((id) => !told.has(id) || (told.get(id)! > 0 && at >= told.get(id)!))
  if (fresh.length > 0) {
    // Each new request is read once: whose it is decides whether it is owed a notice.
    const live = await registryEntries($)
    if (!live || !(await dirOk($, base, p.uid))) return
    for (const id of fresh.slice(0, PROMPT_REQUESTS_MAX)) {
      const o = open.get(id)!
      const r = await readSmallR($, `${o.dir}/${id}.request.json`, p.uid, pr.REQUEST_MAX)
      if (r.state !== 'ok') continue
      const q = pr.parseRequest(r.text)
      if (!q || q.id !== id) {
        told.set(id, at + PROMPT_RECHECK_MS)
        continue
      }
      const stand = await promptStand($, p, live, answering, o.dir, o.names, q)
      const self = stand.tiers.find((x) => x.sid === sid)
      if (!self || stand.passed[self.level] !== undefined || !stand.active.some((x) => x.sid === sid)) told.set(id, at + PROMPT_RECHECK_MS)
      // A lead is told at once (its window is the 30-second minimum itself); a higher tier when its window opens (looked at again sooner, a pass-up opens it at once).
      else told.set(id, self.level !== 'lead' && promptWindowShut(q, stand, sid, at) ? Math.min(stand.windows[sid], at + PROMPT_WINDOW_RECHECK_MS) : -1)
    }
  }
  const mine = [...told].filter(([, v]) => v === -1).map(([id]) => id)
  if (mine.length === 0) return
  const now = await $.clock.now()
  const times = promptNotices.get(sid) ?? []
  if (!c.noticeAllowed(times, now, pr.PROMPT_NOTICES_PER_HOUR)) {
    if (promptCapLogged.has(sid)) return
    promptCapLogged.add(sid)
    return log($, sid, 'notice-capped', 'prompts')
  }
  if (dialogOpen.has(sid) || submits !== submitsAtStart) return
  // A pending request (a compaction that is armed or waiting to resume) or a due nudge has the idle moment first.
  if ((await $.state.get(request)).value != null || (await $.state.get(nudgeDueRef)).value != null) return
  if ((await idleCheck($, sid)) !== undefined) return
  // Every read is behind us: nothing is awaited between this guard and the submit. A request the mid-turn path told meanwhile is not told again.
  if (dialogOpen.has(sid) || submits !== submitsAtStart) return
  const owed = mine.filter((id) => told.get(id) === -1)
  if (owed.length === 0) return
  for (const id of owed) told.set(id, 0)
  promptCapLogged.delete(sid)
  promptNotices.set(sid, [...(promptNotices.get(sid) ?? times).filter((t) => t <= now && now - t < c.HOUR_MS), now])
  await submitOwn($, pr.PROMPT_NOTICE_TEXT, false).catch(async () => {
    for (const id of owed) told.set(id, -1)
    turnKind.delete(sid)
    await log($, sid, 'notice-failed', 'prompts')
  })
}

// The fallback (like midTurnFallback): the engine may not surface the context, or the model may read it and not act. When the turn that carried a mid-turn notice ends,
// each request of it still open is owed again, once, and the idle tick sends it as the idle turn; that resend is not a mid-turn one (promptMidRetold), so it
// is told twice at most. A request that closed meanwhile is dropped by the tick's scan and its marks here with it.
const promptMidSent = new Map<string, Set<string>>()
const promptMidRetold = new Map<string, Set<string>>()
function promptMidFallback(sid: string) {
  const told = promptTold.get(sid)
  const sent = promptMidSent.get(sid)
  promptMidSent.delete(sid)
  const retold = promptMidRetold.get(sid)
  if (retold) {
    for (const id of [...retold]) if (!told?.has(id)) retold.delete(id)
    if (retold.size === 0) promptMidRetold.delete(sid)
  }
  if (!told || !sent) return
  for (const id of sent) {
    if (told.get(id) === 0) {
      told.set(id, -1)
      const r = promptMidRetold.get(sid) ?? new Set<string>()
      r.add(id)
      promptMidRetold.set(sid, r)
    }
  }
}
// The notice in the middle of a turn (like midTurnNudge): a busy lead would learn of a waiting prompt only when its turn ends, and the lane behind it waits meanwhile.
// After a main-agent tool call of a lead, the hook returns PROMPT_NOTICE_TEXT as additionalContext, which the model reads with the tool's result. It reads no file:
// the tick's scan (promptNoticeTick) has already marked the requests owed a notice (-1), busy lead or not, so this only claims them. Same hourly cap, same told
// marks: a request is told once, by whichever path comes first, and the idle submit stays the fallback for a lead whose turn ends without a tool call.
async function promptMidTurnNotice($: any, e: any): Promise<string | undefined> {
  if (typeof e?.agent_id === 'string' && e.agent_id !== '') return undefined
  const sid = await $.session.id()
  if (typeof sid !== 'string' || !c.SID_RE.test(sid) || grantOf(sid) === undefined) return undefined
  const told = promptTold.get(sid)
  const retold = promptMidRetold.get(sid)
  if (!told || ![...told].some(([id, v]) => v === -1 && !retold?.has(id))) return undefined
  try {
    // A compaction that is armed or waiting to resume would take the text with it: the notice stays owed, as for the tick's submit.
    if ((await $.state.get(request)).value != null) return undefined
    const now = await $.clock.now()
    const times = promptNotices.get(sid) ?? []
    if (!c.noticeAllowed(times, now, pr.PROMPT_NOTICES_PER_HOUR)) {
      if (!promptCapLogged.has(sid)) {
        promptCapLogged.add(sid)
        await log($, sid, 'notice-capped', 'prompts')
      }
      return undefined
    }
    // Answering turned off since the tick looked: nothing is told.
    if (!pr.parseAnswering(await $.store.get(ANSWERING_KEY).catch(() => undefined)) || (await promptsOff($))) return undefined
    // Nothing is awaited between this read of the marks and their change.
    const owed = [...told].filter(([id, v]) => v === -1 && !promptMidRetold.get(sid)?.has(id)).map(([id]) => id)
    if (owed.length === 0) return undefined
    for (const id of owed) told.set(id, 0)
    const sent = promptMidSent.get(sid) ?? new Set<string>()
    for (const id of owed) sent.add(id)
    promptMidSent.set(sid, sent)
    promptCapLogged.delete(sid)
    promptNotices.set(sid, [...(promptNotices.get(sid) ?? []).filter((t) => t <= now && now - t < c.HOUR_MS), now])
    await log($, sid, 'notice', 'prompts mid-turn').catch(() => undefined)
    return pr.PROMPT_NOTICE_TEXT
  } catch {
    await log($, sid, 'error', 'mid-turn-prompt-notice').catch(() => undefined)
    return undefined
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    goneSeen.clear()
    const now = await $.clock.now()
    if ((await $.state.get(seen)).value == null) await $.state.set(seen, now)
    // One of the two signs of a person's session for the self-threshold nudge (interactive(): this, or an own registry row). A recorded nudge is left alone (it expires on its own).
    await $.state.set(interactiveRef, (e as { isInteractive?: unknown }).isInteractive === true).catch(async () => log($, await $.session.id(), 'error', 'interactive').catch(() => undefined))
    const req = (await $.state.get(request)).value as Request | null | undefined
    // v13.1: a request still in $.state means the state survived (a reload, not a restart): a cut-compaction mark then gives no note.
    const stateKept = req != null
    if (req) {
      await $.state.set(request, null)
      await log($, await $.session.id(), 'dropped', req.phase === 'compacted' ? 'restart-after-compact' : 'restart')
    }
    await $.tool.register({
      name: TOOL,
      description:
        "Ask this session to compact itself. focus: one sentence of printable ASCII saying what this session is (a hint for the summary). continuation: up to 5 lines (max 600) you read back after compaction: your role, the first file to read, the next step, the constraints. mode: now = compact when this turn ends; on-cue = wait for the lead's cue.",
      inputSchema: {
        type: 'object',
        properties: { focus: { type: 'string' }, continuation: { type: 'string' }, mode: { type: 'string', enum: ['now', 'on-cue'] } },
        required: ['focus', 'continuation', 'mode'],
      },
    })
    const me = await $.session.id()
    try {
      await $.command.register({ name: 'callboard', description: 'Give lead, make this session a lane, list the lanes, show status, show or change the settings, or turn lead and lane off for this session', argumentHint: 'off|lead|lanes|status|config [SETTING VALUE]|conductor [add|remove NAME]|reserve [remove] [NAME]|lane [NAME]|lane off|answering [on LANE|LEAD|all|off]|prompts' })
    } catch {
      await log($, me, 'error', 'command-register')
    }
    // v13.5: what a retired /callboard on left, after /callboard is registered, so a slow store cannot hold the command up.
    await onLeftovers($, me)
    try {
      await pruneHints($, me)
      if (c.parseHint(await $.store.get(`${c.HINT_PREFIX}${me}`), now)) await log($, me, 'hint-found')
    } catch {
      await log($, me, 'error', 'hint-scan').catch(() => undefined)
    }
    // v13.2: the settings, read fresh at each start (cfgGet keeps the last good value when the read fails).
    await cfgGet($, me, true)
    await reservedGet($, me, true)
    await pruneResults($).catch(() => log($, me, 'error', 'result-prune').catch(() => undefined))
    await pruneLogs($, me).catch(() => log($, me, 'error', 'log-prune').catch(() => undefined))
    await presenceDrop($, me).catch(() => log($, me, 'error', 'presence-drop').catch(() => undefined))
    // v13: a saved lead grant for this session (D5), then whether a store record names it, looked at from the tick (D4).
    if (c.SID_RE.test(me)) {
      try {
        const raw = await $.store.get(`${c.LEAD_HINT_PREFIX}${me}`)
        if (raw !== undefined) {
          const p = await where($)
          const h = p ? c.parseLeadHint(raw, now, homeOf(p)) : undefined
          if (!p) await log($, me, 'lead-restore-rejected', 'error')
          else if (!h) {
            await $.store.delete(`${c.LEAD_HINT_PREFIX}${me}`)
            await log($, me, 'lead-restore-rejected', 'invalid')
          } else await leadRestore($, me, h, 0)
        }
      } catch {
        await log($, me, 'lead-restore-rejected', 'error').catch(() => undefined)
      }
      // v15 (F2): a saved conductor grant for this session, restored as the lead's is (conductorRestore).
      try {
        const raw = await $.store.get(`${c.CONDUCTOR_HINT_PREFIX}${me}`)
        if (raw !== undefined) {
          const p = await where($)
          const h = p ? c.parseConductorHint(raw, now, homeOf(p)) : undefined
          if (!p) await log($, me, 'conductor-restore-rejected', 'error')
          else if (!h) {
            await $.store.delete(`${c.CONDUCTOR_HINT_PREFIX}${me}`)
            await log($, me, 'conductor-restore-rejected', 'invalid')
          } else await conductorRestore($, me, h, 0)
        }
      } catch {
        await log($, me, 'conductor-restore-rejected', 'error').catch(() => undefined)
      }
      // v15.3: a saved manager grant for this session: asked about from the tick (managerTick), not restored here. A session that still holds the grant (a
      // compaction) is not asked.
      try {
        const raw = await $.store.get(`${c.MANAGER_HINT_PREFIX}${me}`)
        if (raw !== undefined && grants.get(me)?.level !== 'manager' && !managerRestoreOffered.has(me)) {
          managerRestoreOffered.add(me)
          const h = c.parseManagerHint(raw, now)
          if (!h) {
            await $.store.delete(`${c.MANAGER_HINT_PREFIX}${me}`)
            await log($, me, 'manager-restore-rejected', 'invalid')
          } else managerRestorePending.set(me, { hint: h, tries: 0 })
        }
      } catch {
        await log($, me, 'manager-restore-rejected', 'error').catch(() => undefined)
      }
      // v13.1: a compaction cut off by the restart. A stale mark, or one found while the state survived, goes with no note.
      try {
        const raw = await $.store.get(`${c.CMP_PREFIX}${me}`)
        if (raw !== undefined) {
          if (!stateKept && c.cmpMarkFresh(raw, now)) cmpCutPending.set(me, 0)
          else await cmpClear($, me)
        }
      } catch {
        await log($, me, 'error', 'cmp-read').catch(() => undefined)
      }
      rebindPending.set(me, 0)
      rebindName.delete(me)
    }
    ensureTimer($)
    // v15.2: once per session start, after the restores and the timer, so a slow read delays none of them; it only warns.
    await liveCheckoutCheck($, me)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'callboard' }, async ($, e, next) => {
    const sid = await $.session.id()
    ensureTimer($)
    const rawArgs = (e as { args?: unknown }).args
    const line = typeof rawArgs === 'string' ? rawArgs.trim().replace(/[ \t]+/g, ' ') : ''
    // Prompt answering (ADR 0004): `answering` and `prompts` are read here, so core's parser keeps its own forms.
    if (line === 'prompts') return promptsCommand($)
    if (line === 'answering' || line.startsWith('answering ')) return answeringCommand($, sid, c.originCode((e as { origin?: unknown }).origin), pr.parseAnsweringArgs(line.slice(10)))
    const arg = c.parseCommandArgs(rawArgs)
    if (!arg) return { text: USAGE }
    const code = c.originCode((e as { origin?: unknown }).origin)
    // v13.2: before the verb below, which would take any other object for a lane command.
    if (typeof arg === 'object' && 'config' in arg) return configCommand($, sid, code, arg.config)
    if (typeof arg === 'object' && 'checkin' in arg) return checkinCommand($, sid, code, arg.checkin)
    if (typeof arg === 'object' && 'reserve' in arg) return reserveCommand($, sid, code, arg.reserve)
    const verb = typeof arg === 'string' ? arg : 'manager' in arg ? 'manager' : 'conductor' in arg ? 'conductor' : 'lane'
    const busy = async () => {
      await log($, sid, 'refused', `busy:${verb}:${code}`)
      return { text: 'A callboard question is already open. Answer it first.' }
    }
    // A busy request is logged once, by the busy line below (same key, so a loop is de-duplicated); the person's own commands always get their line.
    if (verb !== 'status' && (!dialogOpen.has(sid) || c.originIsPerson(code))) await log($, sid, 'command', `${verb}:${code}`).catch(() => undefined)
    if (verb === 'lane' || verb === 'lane-off') return laneCommand($, sid, code, arg as c.CommandArg, busy)
    if (arg === 'claim') return claimCommand($, sid, code, busy)
    if (typeof arg === 'object' && 'manager' in arg) return managerCommand($, sid, code, arg.manager, busy)
    // v15 (2026-11-05): the conductor list (add, remove) and the conductor grant.
    if (typeof arg === 'object' && 'conductor' in arg) {
      const op = arg.conductor
      if (op === 'bad') return { text: c.CONDUCTOR_USAGE }
      if (op === 'grant') return conductorGrant($, sid, code, busy)
      return conductorListCommand($, sid, code, op, busy)
    }
    // The table lane_list gives the lead, printed to the person with no model turn. Read-only: no store write, no notice, and the lanes-changed news is not marked as told.
    if (arg === 'lanes') {
      const t = await laneTable($, sid)
      if (!('err' in t)) return { text: t.text }
      if (t.err[0] === 'off') return { text: 'Lead is off in this session. Run /callboard lead first.' }
      return { text: `Lanes unavailable: ${c.hasText(t.err[0]) ? c.REASON_TEXT[t.err[0]] : t.err[1]}` }
    }
    if (arg === 'off' && !c.originIsPerson(code)) {
      const leaves = ((await $.state.get(lane)).value as Bound | null | undefined)?.name
      // v15 (c2): in a conductor session the question names the conductor and its saved grant.
      const offQ = grants.get(sid)?.level === 'conductor' ? c.CONDUCTOR_OFF_QUESTION : c.offQuestionFor(leaves)
      const r = await askOnce($, sid, c.askedFrom(offQ, code), c.OFF_YES, c.OFF_NO, c.HEADER.enable)
      if (r === 'busy') return busy()
      if (r === 'timed-out') return { text: `Nothing changed: ${await timedOut($, sid)}.` }
      if (r !== 'yes') {
        await log($, sid, 'refused', 'off-not-confirmed')
        return { text: 'Cancelled. Nothing changed.' }
      }
    }
    // The saved lead grant could not be deleted: the reply says lead may come back after a restart (F2).
    let leadKept = false
    // v13.5: what off found, for its answer, read before the drops below: a lead (a grant, or a saved one still being restored), a rebind still waiting
    // (and the lane it would take, once the tick has read it), and a saved lead grant with neither.
    let wasLead = false
    let wasManager = false
    let wasConductor = false
    let savedConductor = false
    let savedManager = false
    let rebindWas = false
    let rebindLane: string | undefined
    let savedLead = false
    if (arg === 'off') {
      offSeq.set(sid, (offSeq.get(sid) ?? 0) + 1)
      wasManager = grants.get(sid)?.level === 'manager'
      wasConductor = grants.get(sid)?.level === 'conductor' || conductorRestorePending.has(sid)
      wasLead = !wasManager && !wasConductor && (grants.has(sid) || leadRestorePending.has(sid))
      rebindWas = rebindPending.has(sid)
      rebindLane = rebindName.get(sid)
      // A rebind still waiting is cancelled (F4) before any await: a tick that starts after the bump would pass its own check and could bind after
      // off has read the binding.
      rebindPending.delete(sid)
      rebindName.delete(sid)
      if (!wasLead && !wasManager && !wasConductor) {
        // A read that timed out says nothing about the grant: the reply then leaves it out (#268 review).
        const got = await withTimeout($, (async () => $.store.get(`${c.LEAD_HINT_PREFIX}${sid}`))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
        savedLead = got !== undefined && got !== 'timeout'
        const gotC = await withTimeout($, (async () => $.store.get(`${c.CONDUCTOR_HINT_PREFIX}${sid}`))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
        savedConductor = gotC !== undefined && gotC !== 'timeout'
        const gotM = await withTimeout($, (async () => $.store.get(`${c.MANAGER_HINT_PREFIX}${sid}`))(), c.ENGINE_CALL_TIMEOUT_MS).catch(() => undefined)
        savedManager = managerRestorePending.has(sid) || (gotM !== undefined && gotM !== 'timeout')
      }
      if (!(await leadDrop($, sid))) leadKept = true
      if (!(await managerForget($, sid))) leadKept = true
    }
    if (arg === 'lead') {
      // A lane is never a lead too: asked before the dialog and again after a yes, since the binding may land while the question is open.
      const laneHeld = async () => (await $.state.get(lane)).value != null
      const laneNo = async () => {
        await log($, sid, 'refused', 'lead-lane-holder')
        return { text: `${grants.has(sid) ? 'Lead stays on' : 'Lead stays off'}: ${c.REASON_TEXT['lane-holder']}` }
      }
      if (await laneHeld()) return laneNo()
      // v14 (2026-11-04): the manager is never made a lead in place: a no would drop its grant and a yes replace it.
      if (grants.get(sid)?.level === 'manager') {
        await log($, sid, 'refused', 'lead-manager-holder')
        return { text: `Lead stays off: ${c.REASON_TEXT['manager-holder']}` }
      }
      // v14 (2026-11-04, review c1, W3): nor is a session that was the manager since it started: its manager tools stay declared, and the lead's would be
      // declared over them. Asked before the dialog and again after a yes (as manager-after-lead).
      const wasManagerNo = async () => {
        await log($, sid, 'refused', 'lead-after-manager')
        return { text: `Lead stays off: ${c.REASON_TEXT['lead-after-manager']}` }
      }
      if (managerDeclared.has(sid)) return wasManagerNo()
      // v15: nor a conductor, nor a session that was one; asked again after a yes. A conductor restore still pending does not refuse: the person's lead grant
      // stands, and the restore then ends (lead-holder).
      const conductorNo = async (): Promise<{ text: string } | undefined> => {
        const code = grants.get(sid)?.level === 'conductor' ? 'conductor-holder' : conductorDeclared.has(sid) ? 'lead-after-conductor' : undefined
        if (!code) return undefined
        await log($, sid, 'refused', `lead-${code}`)
        return { text: `Lead stays off: ${c.REASON_TEXT[code]}` }
      }
      const cn = await conductorNo()
      if (cn) return cn
      let cwd: string
      try {
        cwd = await sessionRoot($)
      } catch {
        await log($, sid, 'error', 'lead-register').catch(() => undefined)
        return { text: 'Lead could not be set up.' }
      }
      // A grant from a plugin, session or script keeps the folder an earlier grant pinned; only the person's own prompt or phone moves it.
      const pinned = (!c.originIsPerson(code) && pinOf(sid)) || cwd
      // S2b: with another lead in the repo, both need a usable name. Asked before the dialog and again after a yes.
      const nameNo = async (why: string) => {
        await log($, sid, 'refused', why)
        return { text: `${grants.has(sid) ? 'Lead stays on' : 'Lead stays off'}: ${c.REASON_TEXT[why]}` }
      }
      await reservedGet($, sid, true)
      const named = await secondLeadNo($, sid, pinned)
      if (named !== undefined) return nameNo(named)
      const r = await askOnce($, sid, c.askedFrom(c.leadQuestion(pinned), code), c.LEAD_YES, c.LEAD_NO, c.HEADER.lead)
      if (r === 'busy') return busy()
      if (r !== 'yes') {
        const wasOn = grants.has(sid)
        const kept = (r === 'no' || c.originIsPerson(code)) && !(await leadDrop($, sid)) ? c.LEAD_KEPT : ''
        let why = ''
        if (r === 'timed-out') {
          await timedOut($, sid, 'timed-out', wasOn && !grants.has(sid) ? c.TIMED_OUT_LEAD_OFF_TOAST : c.TIMED_OUT_TOAST)
          why = ` ${c.TIMED_OUT_SENTENCE}`
        } else await log($, sid, 'refused', 'lead-not-confirmed')
        return { text: `${grants.has(sid) ? `Lead stays on.${why}` : wasOn ? `Lead is now off.${why}` : `Lead stays off.${why}`}${kept}` }
      }
      if (laneBinding.has(sid)) return laneNo()
      if (managerDeclared.has(sid)) return wasManagerNo()
      const cnAfter = await conductorNo()
      if (cnAfter) return cnAfter
      let grantEpoch = -1
      leadGranting.add(sid)
      try {
        // The engine calls held inside the mark have a time limit; a state read that does not answer counts as a lane binding.
        if ((await withTimeout($, laneHeld(), c.ENGINE_CALL_TIMEOUT_MS)) !== false) return laneNo()
        const namedNow = await withTimeout($, secondLeadNo($, sid, pinned), c.ENGINE_CALL_TIMEOUT_MS)
        if (namedNow !== undefined) return nameNo(namedNow === 'timeout' ? 'lead-check-slow' : namedNow)
        let set: unknown
        try {
          set = await withTimeout($, leadToolsOnce($, sid), c.ENGINE_CALL_TIMEOUT_MS)
        } catch {
          await log($, sid, 'error', 'lead-register').catch(() => undefined)
          return { text: 'Lead could not be set up.' }
        }
        if (set === 'timeout') {
          await log($, sid, 'error', 'lead-register-timeout').catch(() => undefined)
          return { text: 'Lead could not be set up.' }
        }
        // v13.6 (review c1, S4): a re-grant with a new folder is a new reach: work in flight for the old one (a check-in) sees the epoch move and stops.
        const oldPin = pinOf(sid)
        if (oldPin !== undefined && oldPin !== pinned) {
          leadEpoch.set(sid, epochOf(sid) + 1)
          laneObs.delete(sid)
          attnTold.delete(sid)
        }
        grants.set(sid, c.leadGrant(pinned))
        grantEpoch = epochOf(sid)
      } finally {
        leadGranting.delete(sid)
      }
      // v13: the grant survives a restart (D5).
      await leadSave($, sid, pinned)
      // S1b review c1: an off or a Cancel during the save leaves no presence, log, briefing or "Lead is on" behind.
      if (epochOf(sid) !== grantEpoch) return { text: 'Lead is now off.' }
      // A new grant may pin another folder: the old file and its checks go first.
      await presenceDrop($, sid).catch(() => undefined)
      await presenceTouch($, sid).catch(() => log($, sid, 'error', 'presence').catch(() => undefined))
      await watchInit($, sid).catch(() => log($, sid, 'error', 'lane-watch').catch(() => undefined))
      await log($, sid, 'lead-on')
      await briefLead($, sid, pinned)
      await nameGrant($, sid)
      return { text: 'Lead is on from your next prompt.\nOnly a force stop asks you.' }
    }
    const bound = (await $.state.get(lane)).value as Bound | null | undefined
    // v13.5 (2026-11-03): no ON or OFF part; /callboard on is retired and every session gets the keepalive and the nudges.
    // v13.6: a lead's status adds its check-ins.
    const ckStatus = arg === 'status' && grants.has(sid) && grants.get(sid)?.level !== 'conductor' ? ` ${c.checkinStatus((await cfgGet($, sid)).checkin, (await $.state.get(checkinPauseRef)).value, await $.clock.now())}` : ''
    // v14: the manager's status names its level in place of the lead's.
    const gs = grants.get(sid)
    const grantPart = gs?.level === 'manager' ? 'Manager: ON.' : gs?.level === 'conductor' ? c.conductorStatus(gs.pins.length) : `Lead: ${grants.has(sid) ? 'ON' : 'OFF'}.`
    if (arg === 'status') return { text: `Lane: ${bound ? bound.name : 'NONE'}. ${grantPart}${ckStatus}${bound ? c.laneStatusLead(laneBrief.get(sid), bound.name) : ''}` }
    if (arg === 'off') {
      // A recorded nudge and an open grant go too. Off does not opt out of nudges: a later turn past the level records a new one.
      await $.state.set(nudgeDueRef, null)
      await $.state.set(nudgedAtRef, null)
      if (!(await leadDrop($, sid))) leadKept = true
      // The rebind was cancelled above. No store record may keep naming a session that is off, or a restart would rebind it.
      // v13.5: a session that is neither a lane nor a lead keeps its request as it is: off turns nothing off there, and its own request needs no lane.
      const cur = await $.state.get(request)
      const live = bound || wasLead || wasManager || wasConductor ? (cur.value as Request | null | undefined) : undefined
      // v13.5: what off did, for its answer: a request dropped, or a compaction under way that loses its resume.
      let reqDone: 'dropped' | 'no-resume' | undefined
      if (live && live.phase !== 'compacting') {
        await dropRequest($, sid, 'disabled')
        reqDone = 'dropped'
      } else if (live?.viaNudge === true) {
        reqDone = 'no-resume'
        // A compaction under way through the nudge grant finishes, but loses the grant: its resume then needs the session to be eligible, which off
        // has just ended, so the continuation is dropped as not-eligible. If PostCompact moved it on meanwhile, the request is dropped as above.
        const { viaNudge: _granted, ...kept } = live
        if ((await $.state.set(request, kept, { ifVersion: cur.version })).isSet === false) {
          const again = (await $.state.get(request)).value as Request | null | undefined
          if (again && again.phase !== 'compacting') {
            await dropRequest($, sid, 'disabled')
            reqDone = 'dropped'
          }
        }
      }
      // A bound session is unbound too: off no longer leaves a lane that a lead can still cue.
      const d = bound ? await detach($, sid, bound) : { whole: true, sidKept: false }
      const loose = bound ? undefined : await sidClearAll($, sid).catch(() => ({ ok: false, name: undefined }))
      await log($, sid, 'disabled')
      // v13.5: the answer says what off did; it never stops the keepalive or the nudges, which every session gets.
      const rebindTo = rebindWas ? (rebindLane ?? loose?.name) : undefined
      const did = [
        wasManager ? 'Manager is now off.' : wasConductor ? 'Conductor is now off.' : wasLead ? 'Lead is now off.' : savedLead ? 'Its saved lead grant was removed.' : savedConductor ? 'Its saved conductor grant was removed.' : savedManager ? 'Its saved manager grant was removed.' : '',
        bound ? `This session is no longer lane ${bound.name}.` : '',
        rebindTo !== undefined ? `Lane ${rebindTo} will not rebind automatically.` : '',
        loose?.ok && loose.name !== undefined ? `Lane ${loose.name} no longer names this session.` : '',
        reqDone === 'dropped' ? 'Its compaction request was dropped.' : reqDone === 'no-resume' ? 'The compaction under way will not resume the work.' : '',
      ].filter((x) => x !== '').join(' ')
      return { text: `${did || c.OFF_NOTHING}${d.whole ? '' : ` ${c.DETACH_INCOMPLETE}`}${bound && !bound.adopted ? c.STOPPABLE_BY_NAME(bound.name) : ''}${bound && d.sidKept ? c.SID_KEPT(bound.name) : ''}${loose && !loose.ok && loose.name ? c.SID_KEPT(loose.name) : ''}${leadKept ? (wasConductor || savedConductor ? c.CONDUCTOR_KEPT : wasManager || savedManager ? c.MANAGER_KEPT : c.LEAD_KEPT) : ''}` }
    }
    // v13.6 (2026-11-03): no verb is left here; /callboard on is an unknown word (the usage line above).
    return { text: USAGE }
  }).catch(() => ({ text: 'Callboard hit an error. Run /callboard status.' }))

  on('tool.call', { tool: `mcp__callboard__${TOOL}` }, async ($, e, next) => {
    const sid = await $.session.id()
    ensureTimer($)
    if ((e as { agentId?: string }).agentId !== undefined) {
      await log($, sid, 'refused', 'subagent')
      return { deny: 'request_compact is for the main agent only.' }
    }
    // The input first: a session nudged moments ago is let through on its mode, so the mode must be a valid one.
    const v = c.validateRequest(e)
    if (!v.ok) return { deny: `request_compact refused: ${v.reason}` }
    const now = await $.clock.now()
    // Any interactive session may compact itself now (self; requestGate keeps it to mode `now`); the person's session check reads the registry only when the
    // session is not eligible.
    const elig = await isEligible($)
    // v14 (2026-11-04, S7): a session holding a lead grant may ask on-cue too: only the manager's compact cue acts on it.
    const leadCue = !elig && v.req.mode === 'on-cue' && grants.get(sid)?.level === 'lead'
    const self = !elig && !leadCue && (await interactive($, sid))
    const gate = leadCue ? 'lead' : c.requestGate(elig, v.req.mode, (await $.state.get(nudgedAtRef)).value, now, self)
    if (!gate) {
      await log($, sid, 'refused', 'not-eligible')
      return { deny: "request_compact is not enabled for this session: mode on-cue needs a lane, mode now a person's session." }
    }
    const ct = await counts($)
    const early = c.compactAllowed(ct, (await $.session.usage()).context.tokens ?? 0, now)
    if (early) {
      await log($, sid, 'refused', early)
      return { deny: c.compactDenyText(early, ct.lastCompactMs, now) }
    }
    const sum = await sha($, v.req.continuation)
    // Any stored request spends the grant, before it is stored: a failure after this point leaves no grant behind.
    await $.state.set(nudgedAtRef, null)
    await $.state.set(request, {
      id: `${now}`,
      mode: v.req.mode,
      focus: v.req.focus,
      continuation: v.req.continuation,
      sha256: sum,
      requestedMs: now,
      phase: 'called',
      ...(gate === 'nudge' || gate === 'self' ? { viaNudge: true } : {}),
      ...(gate === 'lead' ? { viaLead: true } : {}),
    })
    await log($, sid, 'requested', gate === 'nudge' ? `${v.req.mode}-nudged` : gate === 'self' ? `${v.req.mode}-self` : gate === 'lead' ? `${v.req.mode}-lead` : v.req.mode)
    return { result: 'queued' } as never
  }).catch(() => ({ deny: 'callboard: request_compact failed closed.' }))

  for (const verb of c.LEAD_VERBS) {
    on('tool.call', { tool: `mcp__callboard__lane_${verb}` }, async ($, e, next) => leadRun($, e, async () => {
      const sid = await $.session.id()
      const deadline = (await $.clock.now()) + c.RESULT_DEADLINE_MS
      ensureTimer($)
      const no = async (reason: string, why: string) => {
        await log($, sid, 'refused', `lead-${reason}`)
        return { deny: leadReason(verb, why) }
      }
      // v14 (2026-11-04, S7): the manager's lane_compact may name a live lead by its session name, in any repo (leadByName).
      // v15: the conductor's too, for a lead of its repos.
      if (verb === 'compact' && (grantOf(sid)?.level === 'manager' || grantOf(sid)?.level === 'conductor')) {
        const ld = await leadByName($, e, sid)
        if (ld && 'err' in ld) return no(...ld.err)
        if (ld) {
          const sent = await cueExchange($, sid, ld.name, ld.sid, 'compact', deadline, no)
          if (sent) return sent
          return { result: `cue compact acted for lead ${ld.name}.` } as never
        }
      }
      let prep = await leadPrep($, e, sid)
      if ('err' in prep) return no(...prep.err)
      // A parked lane keeps its conversation: a new session is never bound over it (lane_unpark reopens it).
      if (verb === 'rename' && prep.lane.parked !== undefined) return no('parked', c.reasonWhy('parked'))
      let to = c.leadTarget(prep.entries, prep.lane, sid, verb, (e as { sid?: unknown }).sid)
      for (let i = 0; verb === 'start' && !to.ok && to.reason === 'no-live-session' && i < c.START_WAIT_TRIES; i++) {
        if (!(await pause($, c.START_WAIT_MS))) break
        const again = await leadPrep($, e, sid)
        if ('err' in again) return no(...again.err)
        prep = again
        to = c.leadTarget(prep.entries, prep.lane, sid, verb, (e as { sid?: unknown }).sid)
      }
      if (!to.ok) return no(to.reason, c.reasonWhy(to.reason))
      // v14 (2026-11-04, review c1, L1): a lead's lane_compact never cues a session that holds a live presence file (another lead carrying the lane's name),
      // as leadByName's lane-or-lead; a file whose check could not be made counts (fail closed).
      if (verb === 'compact' && (grantOf(sid)?.level === 'lead' || grantOf(sid)?.level === 'conductor')) {
        const live = await registryEntries($)
        if (!live) return no('registry-unreadable', c.reasonWhy('registry-unreadable'))
        if (await presenceHeld($, live, to.sid)) return no('lane-or-lead', c.reasonWhy('lane-or-lead'))
      }
      const sent = await cueExchange($, sid, prep.lane.name, to.sid, verb, deadline, no)
      if (sent) return sent
      return { result: `cue ${verb} acted for lane ${prep.lane.name}.` } as never
    })).catch(() => ({ deny: `lane_${verb} failed closed.` }))
  }


  on('tool.call', { tool: 'mcp__callboard__lane_create' }, async ($, e, next) => leadRun($, e, async () => {
    const sid = await $.session.id()
    ensureTimer($)
    await reservedGet($, sid, true)
    const no = async (reason: string, why: string) => {
      await log($, sid, 'refused', `lead-${reason}`)
      return { deny: leadReason('create', why) }
    }
    if ((e as { agentId?: string }).agentId !== undefined) return no('subagent', 'for the main agent only.')
    // v14: the manager never creates a lane (it has no pin either).
    if (grantOf(sid)?.level === 'manager') return no('manager-tool', c.REASON_TEXT['manager-tool'])
    if (grantOf(sid)?.level === 'conductor') return no('conductor-tool', c.REASON_TEXT['conductor-tool'])
    const pin = pinOf(sid)
    if (pin === undefined) return no('off', 'the lead tools are off. Ask the person to turn them on.')
    const p = await where($)
    if (!p) return no('no-paths', 'no-paths')
    const home = homeOf(p)
    const broad = c.pinRefusal(pin, home)
    if (broad) return no(broad, `${broad}: the lead folder is too broad or not a plain path, so it cannot hold lanes.`)
    if ((await real($, pin)) !== pin) return no('pin-link', 'pin-link: the lead folder is not its own real path.')
    const g = await gitRoot($, pin)
    if (g === 'error') return no('pin-check-error', 'pin-check-error: the lead folder could not be checked. Retry in a moment.')
    if (g !== 'yes') return no('pin-no-git', 'pin-no-git: the lead folder is not a git repo root.')
    const key = await sha($, pin)
    const a = e as { name?: unknown; task?: unknown; folder?: unknown; model?: unknown }
    let made: c.Lane | undefined
    const w = await ownWrite($, sid, () => editStore(
      $,
      key,
      async (cur, lanes: c.Lane[]) => {
        if (cur.state === 'bad') return { no: 'store-unreadable' }
        const parsed = cur.state === 'ok' ? c.parseStore(cur.text) : undefined
        if (parsed && !parsed.ok) return { no: parsed.reason }
        const parsedStore = parsed && parsed.ok ? parsed.store : undefined
        if (parsedStore && parsedStore.repo !== pin) return { no: 'store-repo' }
        // Records whose folder no longer resolves are invisible to every reader; they are dropped when the list is rewritten (judged here, on the record itself).
        const kept = parsedStore ? await keptLanes($, parsedStore.lanes) : []
        const store = parsedStore ? { ...parsedStore, lanes: kept } : undefined
        const now = await $.clock.now()
        const r = c.createRefusal({ name: a.name, task: a.task, folder: a.folder, model: a.model }, pin, lanes, store, now)
        if (!r.ok) return { no: r.reason, why: c.reasonWhy(r.reason) }
        const reg = await registryEntries($)
        if (!reg) return { no: 'registry-unreadable', why: c.REASON_TEXT['registry-unreadable'] }
        // Any letter case (S2): a lane `alpha` beside lead `Alpha` would make c.leadNameOf void the lead's name and strand its lanes.
        if (reg.some((x) => typeof x.j.name === 'string' && x.j.name.toLowerCase() === r.lane.name.toLowerCase())) return { no: 'name-in-use', why: 'name-in-use: a live session already carries that name.' }
        // The record names this lead by its registry name now (S2), so only it reaches the lane. A lead that had a name at its grant (the cached one) and has
        // none now is refused, so its lane is not made legacy by a passing clash; so is one with no name beside another live lead of the repo (S2b), whose
        // legacy lane that lead would reach too. A lone lead that never had a name makes a legacy lane, reachable by any lead of the repo.
        const leadName = c.leadNameOf(reg.map((x) => x.j), sid)
        if (leadName === undefined && ((grantOf(sid)?.name ?? '') !== '' || (await leadsFor($, reg, pin, pin)).some((x) => x.sid !== sid))) return { no: 'lead-unnamed', why: c.reasonWhy('lead-unnamed') }
        const lane = leadName !== undefined ? { ...r.lane, leadName } : r.lane
        const df = await facts($, r.lane.folder)
        if (!df || df.kind !== 'dir' || df.uid !== p.uid || (await real($, r.lane.folder)) !== r.lane.folder) return { no: 'folder-bad', why: 'folder-bad: the folder must exist and be its own real path.' }
        // The brief is written only once every other check has passed; a store-changed retry writes the same text again. The checks below run after the write.
        const wb = await writeBrief($, p.uid, r.lane.brief, c.briefHead(r.lane.name), c.briefText(r.lane.name, a.task as string))
        if (wb) return { no: wb, why: c.reasonWhy(wb) }
        const bf = await facts($, r.lane.brief)
        if (!bf || bf.kind !== 'file' || bf.nlink !== 1 || bf.uid !== p.uid || (await real($, r.lane.brief)) !== r.lane.brief) return { no: 'brief-missing', why: c.reasonWhy('brief-missing') }
        const keep = kept.filter((l) => l.name !== r.lane.name).map(c.storeLaneJson)
        const text = JSON.stringify({
          repo: pin,
          lanes: [...keep, c.storeLaneJson(lane)],
          creates: [...(parsedStore?.creates ?? []).filter((t) => now - t < c.HOUR_MS && t <= now), now],
        })
        if (text.length > c.STORE_MAX_BYTES) return { no: 'store-size' }
        made = lane
        return { text, landed: (s) => !!s?.lanes.some((l) => l.name === r.lane.name && l.folder === r.lane.folder && l.leadName === lane.leadName) }
      },
      async () => {
        const lanes = await loadLanes($)
        return typeof lanes === 'string' ? { no: lanes } : lanes
      },
    ))
    if ('no' in w) return no(w.no, w.why ?? c.reasonWhy(w.no))
    await log($, sid, 'lane-created', made!.name)
    toast($, `Lane ${made!.name} created (model ${made!.model})`)
    return { result: `lane ${made!.name} created (model ${made!.model}); brief written to ${made!.brief}.${made!.leadName ? '' : c.LANE_NO_LEAD} Next: lane_open, then lane_rename with the id it returns, then lane_start.` } as never
  })).catch(() => ({ deny: 'lane_create failed closed.' }))

  on('tool.call', { tool: 'mcp__callboard__lane_open' }, async ($, e, next) => leadRun($, e, async () => {
    const sid = await $.session.id()
    ensureTimer($)
    const no = async (reason: string, why: string) => {
      await log($, sid, 'refused', `lead-${reason}`)
      return { deny: leadReason('open', why) }
    }
    const prep = await leadPrep($, e, sid)
    if ('err' in prep) return no(...prep.err)
    if (prep.lane.adopted) return no('adopted-record', c.reasonWhy('adopted-record'))
    if (prep.lane.parked !== undefined) return no('parked', c.reasonWhy('parked'))
    if (prep.entries.some((x) => x.name === prep.lane.name)) return no('name-in-use', 'a live session already carries that lane name.')
    const p = await where($)
    if (!p) return no('no-paths', 'no-paths')
    const result = `${p.root}/open/${prep.lane.name}.result`
    const request = `${p.root}/open/${prep.lane.name}.open`
    if (!(await resultDirOk($, p, 'open'))) return no('unsafe-open-dir', 'unsafe-open-dir: ~/.claude/callboard/open is not a private folder of yours. Ask the person to check it.')
    const openDeadline = (await $.clock.now()) + c.OPEN_POLL_MS * c.OPEN_POLL_MAX
    await run($, [RM, '-f', '--', result])
    const w = await writeIn($, 'open', `${prep.lane.name}.open`, c.OPEN_TEXT)
    if ('err' in w) return no(w.err, w.err)
    await log($, sid, 'open-requested', prep.lane.name)
    for (let i = 0; i < c.OPEN_POLL_MAX && (await $.clock.now()) < openDeadline; i++) {
      if (!(await pause($, c.OPEN_POLL_MS))) break
      const a = await readAnswer($, result, p.uid, Math.max(c.OPEN_POLL_MS, Math.min(5000, openDeadline - (await $.clock.now()))))
      if (a.state === 'absent') continue
      if (a.state === 'bad') return no('result-file', 'result-file')
      await run($, [RM, '-f', '--', result])
      const r = c.parseOpenResult(a.text)
      if (!r.ok) {
        const why = r.reason === 'bad-result' ? 'bad-result: the window answer was not valid.' : `${r.reason}: ${c.OPEN_TEXT_BY_CODE[r.reason]}`
        return no(`open-${r.reason}`, why)
      }
      await log($, sid, 'opened', prep.lane.name)
      return { result: `lane ${prep.lane.name}: panel opened as session ${r.sid}. Next: lane_rename with sid ${r.sid}, then lane_start.` } as never
    }
    await run($, [RM, '-f', '--', request])
    return no('open-timeout', 'no window answered in time. A VS Code window with the lane folder as its first workspace folder must run the callboard panels extension. A panel may still appear: check for an unnamed session in that folder first.')
  })).catch(() => ({ deny: 'lane_open failed closed.' }))

  // v13: lane_unpark reopens a store lane's saved conversation by its session id (the record's sid), through <LANE>.reopen in the spool; the reopened session
  // rebinds itself (the tick's rebind step). Live means a registry row of that id whose process still has its start time. A row of the parked process that
  // started before the park mark is waited for (up to 5 s) first: right after lane_park the stopped process can still be exiting.
  on('tool.call', { tool: 'mcp__callboard__lane_unpark' }, async ($, e, next) => leadRun($, e, async () => {
    const sid = await $.session.id()
    ensureTimer($)
    const no = async (reason: string, why: string) => {
      await log($, sid, 'refused', `lead-${reason}`)
      return { deny: leadReason('unpark', why) }
    }
    let prep = await leadPrep($, e, sid)
    if ('err' in prep) return no(...prep.err)
    const rec = prep.lane
    const key = rec.src!
    if (rec.sid === undefined) return no('no-saved-session', c.reasonWhy('no-saved-session'))
    const want = rec.sid
    const name = rec.name
    const liveOf = async (entries: c.RegEntry[]) => {
      const out: c.RegEntry[] = []
      for (const x of entries.filter((y) => y.sessionId === want)) if (c.pidRefusal(x, await psStart($, x.pid)) !== 'pid-changed') out.push(x)
      return out
    }
    const stopped = (x: c.RegEntry) => rec.parked === undefined || typeof x.startedAt !== 'number' || x.startedAt <= rec.parked
    let live = await liveOf(prep.entries)
    // With no parked mark there is no park to wait for: one poll, so a process just stopped by a park whose mark failed is not taken for live (S5).
    for (let i = 0; i < (rec.parked === undefined ? 1 : 10) && live.some(stopped); i++) {
      if (!(await pause($, c.OPEN_POLL_MS))) break
      const again = await leadPrep($, e, sid)
      if ('err' in again) return no(...again.err)
      prep = again
      live = await liveOf(prep.entries)
    }
    // The parked mark goes once the conversation is live again; a mark that stays is dropped by the lane's own sid sync once it is bound.
    const unmark = async () => {
      if (rec.parked === undefined) return
      const bad = await parkWrite($, e, sid, key, name, (l) => ({ ...l, parked: undefined }), (l) => l.sid === want)
      if (bad) await log($, sid, 'error', `unpark-unmarked ${bad}`)
    }
    // The parked process itself still running after the wait is not a reopened conversation: refused, never answered as already live.
    if (rec.parked !== undefined && live.some(stopped)) return no('session-live', c.reasonWhy('session-live'))
    if (live.length === 1 && live[0].name === name) {
      await unmark()
      return { result: c.alreadyLiveText(name, want) } as never
    }
    if (live.length > 0) return no('session-live', c.reasonWhy('session-live'))
    if (prep.entries.some((x) => x.name === name && x.sessionId !== want)) return no('name-in-use', c.reasonWhy('name-in-use'))
    const p = await where($)
    if (!p) return no('no-paths', 'no-paths')
    if (!(await resultDirOk($, p, 'open'))) return no('unsafe-open-dir', 'unsafe-open-dir: ~/.claude/callboard/open is not a private folder of yours. Ask the person to check it.')
    const result = `${p.root}/open/${name}.result`
    const request = `${p.root}/open/${name}.reopen`
    const openDeadline = (await $.clock.now()) + c.OPEN_POLL_MS * c.OPEN_POLL_MAX
    await run($, [RM, '-f', '--', result])
    const w = await writeIn($, 'open', `${name}.reopen`, `${want}\n`)
    if ('err' in w) return no(w.err, w.err)
    await log($, sid, 'reopen-requested', name)
    for (let i = 0; i < c.OPEN_POLL_MAX && (await $.clock.now()) < openDeadline; i++) {
      if (!(await pause($, c.OPEN_POLL_MS))) break
      const a = await readAnswer($, result, p.uid, Math.max(c.OPEN_POLL_MS, Math.min(5000, openDeadline - (await $.clock.now()))))
      if (a.state === 'absent') continue
      if (a.state === 'bad') return no('result-file', 'result-file')
      await run($, [RM, '-f', '--', result])
      const r = c.parseOpenResult(a.text, c.REOPEN_TEXT_BY_CODE)
      if (!r.ok) return no(`reopen-${r.reason}`, r.reason === 'bad-result' ? 'bad-result: the window answer was not valid.' : `${r.reason}: ${c.REOPEN_TEXT_BY_CODE[r.reason]}`)
      if (r.sid !== want) return no('reopen-bad-result', c.reasonWhy('reopen-bad-result'))
      await unmark()
      await log($, sid, 'reopened', name)
      toast($, `Lane ${name} reopened`)
      return { result: c.reopenedText(name, want) } as never
    }
    await run($, [RM, '-f', '--', request])
    return no('reopen-timeout', c.reasonWhy('reopen-timeout'))
  })).catch(() => ({ deny: 'lane_unpark failed closed.' }))

  on('tool.call', { tool: 'mcp__callboard__lane_list' }, async ($, e, next) => leadRun($, e, async () => {
    const sid = await $.session.id()
    ensureTimer($)
    const sub = (e as { agentId?: string }).agentId !== undefined
    const t = sub ? { err: SUBAGENT } : await laneTable($, sid)
    if ('err' in t) {
      await log($, sid, 'refused', `lead-${t.err[0]}`)
      return { deny: leadReason('list', t.err[1]) }
    }
    return { result: t.text } as never
  })).catch(() => ({ deny: 'lane_list failed closed.' }))

  // ADR 0004: the lead tier's three tools. leadRun keeps the lead's presence file fresh and tells it once of a changed lane list, as for every lead tool.
  on('tool.call', { tool: 'mcp__callboard__prompt_list' }, async ($, e, next) => leadRun($, e, async () => {
    ensureTimer($)
    return (await promptListTool($, e)) as never
  })).catch(() => ({ deny: 'prompt_list failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__prompt_answer' }, async ($, e, next) => leadRun($, e, async () => {
    ensureTimer($)
    return (await promptAnswerTool($, e, true)) as never
  })).catch(() => ({ deny: 'prompt_answer failed closed.' }))
  on('tool.call', { tool: 'mcp__callboard__prompt_escalate' }, async ($, e, next) => leadRun($, e, async () => {
    ensureTimer($)
    return (await promptAnswerTool($, e, false)) as never
  })).catch(() => ({ deny: 'prompt_escalate failed closed.' }))

  for (const verb of c.STOP_VERBS) {
    on('tool.call', { tool: `mcp__callboard__lane_${verb}` }, async ($, e, next) => leadRun($, e, async () => {
      const sid = await $.session.id()
      let deadline = (await $.clock.now()) + c.RESULT_DEADLINE_MS
      ensureTimer($)
      let lastCode = ''
      const no = async (reason: string, why: string) => {
        lastCode = reason
        await log($, sid, 'refused', `lead-${reason}`)
        return { deny: leadReason(verb, why) }
      }
      // v14 (2026-11-04): the level the call started under. At manager reach every stop asks the person once, in a dialog that names the repo, and nothing is
      // signalled unless the grant still holds at that level after the click.
      const level = grantOf(sid)?.level
      // v15.3 (review): the grant is the same one, not only the same level (an off and a new grant meanwhile ends the call).
      const epoch = epochOf(sid)
      const heldNow = () => grantOf(sid)?.level === level && epochOf(sid) === epoch
      // v15.4: the engine abandons the dispatch when its time ran out or the person interrupted (`next.signal` aborts: plugin-authoring reference, "Work that outlives a dispatch");
      // the answer then went out already, so nothing may be signalled after it. An abandoned call answers nothing anyone reads, so it logs nothing and returns at once.
      const abandoned = () => next?.signal?.aborted === true
      const cut = () => ({ deny: leadReason(verb, c.reasonWhy('abandoned')) })
      let prep = await leadPrep($, e, sid)
      if ('err' in prep) return no(...prep.err)
      let one = c.laneSession(prep.entries, prep.lane, sid)
      // v15.3 (2026-11-06): a retire or a force stop of a lane no live session carries removes its record directly (stopNoSession); a park has nothing to stop.
      if (!one.ok && one.reason === 'no-live-session' && verb !== 'park') return stopNoSession($, e, sid, verb, level, prep, no, abandoned)
      if (!one.ok) return no(one.reason, c.reasonWhy(one.reason))
      // v15.3 (2026-11-06): a retire or park waits for the lane's idle time itself, up to c.IDLE_WAIT_MS, so a lead that calls it right after the lane's last turn
      // need not time it. Every poll reads the lane and the registry afresh (leadPrep, laneSession) and the grant again; the session must stay the same process.
      // Past the wait the check below refuses, naming the seconds left. The answer wait of the cue starts after this one (the deadline is set again).
      if (verb !== 'terminate' && c.idleRefusal(one.entry, await $.clock.now())) {
        const first = one.entry
        const until = (await $.clock.now()) + c.IDLE_WAIT_MS
        for (;;) {
          const left = until - (await $.clock.now())
          if (left <= 0) break
          // If the wait cannot run, the check below refuses naming the seconds left; looping on a failing wait would spin.
          const waited = await pause($, Math.min(c.IDLE_POLL_MS, left))
          if (abandoned()) return cut()
          if (!heldNow()) return no('grant-changed', c.reasonWhy('grant-changed'))
          if (!waited) break
          const again = await leadPrep($, e, sid)
          // A read that fails now and then (the lane's own registry row is rewritten just as it turns idle) is polled again; the refusal comes at the deadline.
          if ('err' in again && ['registry-unreadable', 'store-unreadable', 'store-busy'].includes(again.err[0])) continue
          if ('err' in again) return no(...again.err)
          const two = c.laneSession(again.entries, again.lane, sid)
          if (!two.ok) return no(two.reason, c.reasonWhy(two.reason))
          if (two.entry.sessionId !== first.sessionId || two.entry.pid !== first.pid || !c.sameStart(two.entry.procStart, first.procStart)) return no('session-changed', c.reasonWhy('session-changed'))
          prep = again
          one = two
          if (!c.idleRefusal(two.entry, await $.clock.now())) break
        }
        deadline = (await $.clock.now()) + c.RESULT_DEADLINE_MS
      }
      const target = one.entry
      if (!Number.isInteger(target.pid) || (target.pid as number) < 2) return no('no-pid', c.reasonWhy('no-pid'))
      // Before any dialog or cue: one registry file carries the session id (a file left by a process that ended would make the pid below ambiguous).
      if (prep.entries.filter((x) => x.sessionId === target.sessionId).some((x) => x !== target)) return no('session-duplicate', c.reasonWhy('session-duplicate'))
      // Exactly one entry of this session, as attach: with two, neither pid is known to be this process, so the self check below has none.
      const selfRows = prep.entries.filter((x) => x.sessionId === sid)
      const selfPid = selfRows.length === 1 ? selfRows[0].pid : undefined
      // v14 (2026-11-04, review c1, M2): at manager reach, before any dialog and again after it: a record that names a session must name this one, and the
      // session must hold no live presence file (a lead, a conductor or the manager may carry a lane's name: leadByName guards only lane_compact).
      const targetNo = async (lane: c.Lane, t: c.RegEntry) => {
        // v15: a conductor's stop takes the manager's wide path.
        if (level === 'lead') return undefined
        if (lane.sid !== undefined && lane.sid !== t.sessionId) return no('sid-mismatch', c.reasonWhy('sid-mismatch'))
        const live = await registryEntries($)
        if (!live) return no('registry-unreadable', c.reasonWhy('registry-unreadable'))
        return (await presenceHeld($, live, t.sessionId)) ? no('target-is-lead', c.reasonWhy('target-is-lead')) : undefined
      }
      const notLane = await targetNo(prep.lane, target)
      if (notLane) return notLane
      const procCheck = async (t: c.RegEntry) => {
        // Any registry entry of this session itself, not only the one counted as its own: with a twin, the self check must still hold.
        if (selfRows.some((x) => x.pid === t.pid)) return no('self', c.reasonWhy('self'))
        const bad = c.pidRefusal(t, await psStart($, t.pid))
        if (bad) return no(bad, c.reasonWhy(bad))
        const notClaude = c.processRefusal(await psArgs($, t.pid), t.pid, selfPid)
        return notClaude ? no(notClaude, c.reasonWhy(notClaude)) : undefined
      }
      // After any wait (the person's dialog, the target's answer) the signal goes only to the process that was checked before it: the grant is still on, the lane
      // still this lead's and on exactly one live session, exactly one registry entry carries the session id and it is that one, and session id, pid and start
      // time are unchanged; then the process checks run again. `between` runs on the fresh entry before the process checks.
      const recheck = async (between?: (v: c.RegEntry) => Promise<{ deny: string } | undefined>): Promise<{ deny: string } | { victim: c.RegEntry }> => {
        const again = await leadPrep($, e, sid)
        if ('err' in again) return no(...again.err)
        if (!heldNow()) return no('grant-changed', c.reasonWhy('grant-changed'))
        const two = c.laneSession(again.entries, again.lane, sid)
        if (!two.ok) return no(two.reason, c.reasonWhy(two.reason))
        const v = two.entry
        // A regEntry whose file name is not its pid has no pid.
        const same = again.entries.filter((x) => x.sessionId === target.sessionId)
        if (same.length !== 1 || same[0] !== v) return no('session-changed', c.reasonWhy('session-changed'))
        if (v.sessionId !== target.sessionId || v.pid !== target.pid || !c.sameStart(v.procStart, target.procStart)) return no('session-changed', c.reasonWhy('session-changed'))
        const notLaneNow = await targetNo(again.lane, v)
        if (notLaneNow) return notLaneNow
        const held = await between?.(v)
        if (held) return held
        return (await procCheck(v)) ?? { victim: v }
      }
      let victim = target
      if (verb === 'terminate') {
        // The dialog shows a pid and a short session id: they must belong to a live claude process with that start time.
        const early = await procCheck(target)
        if (early) return early
        // At manager reach the question names the repo and is the one dialog of the session (askOnce): a second stop while it is open is refused busy.
        const r = level !== 'lead'
          ? await askOnce($, sid, c.terminateQuestion(prep.lane.name, target.sessionId, target.pid as number, prep.lane.repo, !prep.lane.adopted), c.TERMINATE_YES, c.TERMINATE_NO, c.HEADER.stop)
          : await ask($, c.terminateQuestion(prep.lane.name, target.sessionId, target.pid as number, undefined, !prep.lane.adopted), c.TERMINATE_YES, c.TERMINATE_NO, c.HEADER.stop)
        if (r === 'busy') return no('busy', c.reasonWhy('busy'))
        if (r === 'timed-out') return { deny: leadReason(verb, `${await timedOut($, sid)}.`) }
        if (r !== 'yes') return no('not-confirmed', 'the person did not confirm.')
        const fresh = await recheck()
        if ('deny' in fresh) {
          // The person clicked Force stop and nothing was sent: say so, with the code only.
          toast($, `Force stop not sent: ${lastCode}`)
          return fresh
        }
        victim = fresh.victim
      } else {
        // The registry and the report are a first filter only: the session itself confirms (draft box, idle, background agents and shells, a report newer than its last prompt).
        const idle = c.idleRefusal(target, await $.clock.now())
        if (idle) return no(idle, c.notIdleText(target, await $.clock.now()))
        // A park keeps the conversation: no signed report is needed.
        if (verb === 'retire') {
          const bad = await reportCheck($, prep.lane, target)
          if (bad) return no(bad, c.reasonWhy(bad))
        }
        const early = await procCheck(target)
        if (early) return early
        // v14: a retire at manager reach asks the person once before the cue; anything but Retire sends nothing.
        if (verb === 'retire' && level === 'manager') {
          const r = await askOnce($, sid, c.retireQuestion(prep.lane.name, prep.lane.repo!, !prep.lane.adopted), c.RETIRE_YES, c.RETIRE_NO, c.HEADER.stop)
          if (r === 'busy') return no('busy', c.reasonWhy('busy'))
          if (r === 'timed-out') return { deny: leadReason(verb, `${await timedOut($, sid)}.`) }
          if (r !== 'yes') return no('not-confirmed', 'the person did not confirm.')
          if (grantOf(sid)?.level !== level) return no('grant-changed', c.reasonWhy('grant-changed'))
        }
        if (abandoned()) return cut()
      // The cue's answer is waited for from the cue write; a retire after a dialog gets its own full wait.
        const sent = await cueExchange($, sid, prep.lane.name, target.sessionId, verb, verb === 'retire' && level === 'manager' ? (await $.clock.now()) + c.RESULT_DEADLINE_MS : deadline, no, true)
        if (sent) return sent
        // Before the signal, the record must name the session being parked (the sid sync normally did that while it was bound): lane_unpark reopens it by that
        // id, so a park whose record cannot name it sends no signal.
        if (verb === 'park' && prep.lane.sid !== target.sessionId) {
          const named = await parkWrite($, e, sid, prep.lane.src!, prep.lane.name, (l) => ({ ...l, sid: target.sessionId }), () => true)
          if (named) return no(named, c.reasonWhy(named))
        }
        const fresh = await recheck(async (v) => {
          const idleNow = c.idleRefusal(v, await $.clock.now())
          return idleNow ? no(idleNow, c.notIdleText(v, await $.clock.now())) : undefined
        })
        if ('deny' in fresh) return fresh
        victim = fresh.victim
      }
      await log($, sid, verb === 'terminate' ? 'terminating' : verb === 'retire' ? 'retiring' : 'parking', prep.lane.name)
      // v14 (2026-11-04, review c1, S8): the grant is read once more right before the signal (the process checks and the log line above awaited).
      const stale = !heldNow() ? 'grant-changed' : abandoned() ? 'abandoned' : undefined
      if (stale === 'abandoned') {
        if (verb === 'terminate') toast($, 'Force stop not sent: abandoned')
        return cut()
      }
      if (stale) {
        const r = await no(stale, c.reasonWhy(stale))
        if (verb === 'terminate') toast($, `Force stop not sent: ${lastCode}`)
        return r
      }
      const k = await run($, [KILL, '-TERM', String(victim.pid)])
      if (k.exitCode !== 0) return no('kill-failed', 'the signal failed.')
      // The hook's .catch reads this: a call cut off from here on answers that the session was signalled, not "failed closed".
      const callKey = stopCallKey(sid, verb, (e as { lane?: unknown }).lane)
      signalledCalls.set(callKey, { name: prep.lane.name, pid: victim.pid as number })
      // v15.4 (2026-11-06): from here the session has its signal, so a failure is answered as what it is: signalled, record unknown (code in the log), never "failed closed".
      const afterSignal = async () => {
        // Ask the VS Code window to close the dead tab: the extension's sweep acts only once that pid is dead and no live session carries the name. Best effort.
        const closeReq = await writeIn($, 'open', `${prep.lane.name}.close`, `${victim.sessionId}\n${victim.pid}\n${prep.lane.name}\n`).catch(() => ({ err: 'throw' }))
        await log($, sid, 'err' in closeReq ? 'error' : 'close-requested', 'err' in closeReq ? 'close-request' : prep.lane.name)
        if (verb === 'retire') toast($, `Lane ${prep.lane.name} retired (idle, report signed)`)
        if (verb === 'park') {
          // After the signal: the mark, only while the record still names the stopped session. It is a label (lane_list, lane_open); lane_unpark needs only sid.
          const at = await $.clock.now()
          const marked = await parkWrite($, e, sid, prep.lane.src!, prep.lane.name, (l) => ({ ...l, parked: at }), (l) => l.sid === victim.sessionId)
          toast($, `Lane ${prep.lane.name} parked`)
          if (marked) {
            await log($, sid, 'park-unmarked', marked)
            return { result: c.parkUnmarkedText(prep.lane.name, victim.pid as number) } as never
          }
          await log($, sid, 'parked', prep.lane.name)
          return { result: c.parkedText(prep.lane.name, victim.pid as number) } as never
        }
        // v15.3 (2026-11-06): retire and force stop end the lane for good: once the session got its signal, its store record goes too (the .archive folder and the
        // report stay). A lane a session joined keeps its record, which stops naming the stopped session, as before. A failed removal is told, with its code; the call
        // can be made again: the record stops naming the stopped session, so a retry goes by name and a by-hand reopen of that conversation asks Restore.
        // The record goes only once the process (that pid and start time) has ended, polled up to c.STOP_POLLS times.
        const ended = async (): Promise<boolean> => {
          for (let i = 0; ; i++) {
            // Only ps's own "no such process" (or another start time at that pid) is an end; a ps that failed is no answer, so the record is kept.
            const at = await psOne($, victim.pid, 'lstart=').catch((): 'error' => 'error')
            if (at === 'gone' || (at !== 'error' && !c.sameStart(victim.procStart, at.out))) return true
            if (i >= c.STOP_POLLS) return false
            // A wait that cannot run ends the call as signalled-with-unknown-record (afterSignal's catch), not as a session that is still running.
            if (!(await pause($, c.STOP_POLL_MS))) throw new Error('pause-failed')
          }
        }
        let outcome: 'removed' | 'kept' | 'alive' | { unremoved: string } = 'kept'
        if (prep.lane.src) {
          if (prep.lane.adopted) await sidClearAfterStop($, sid, prep.lane.src, prep.lane.name, victim.sessionId)
          else if (!(await ended())) {
            // A session that survives its SIGTERM keeps its record, so the lead can still stop it by name; the record stops naming the session at once, so reopening
            // that conversation by hand asks Restore again instead of making it the lane silently.
            outcome = 'alive'
            await log($, sid, 'error', 'lane-still-running').catch(() => undefined)
            await sidClearAfterStop($, sid, prep.lane.src, prep.lane.name, victim.sessionId)
          } else {
            const gone = await removeRecord($, e, sid, prep.lane.src, prep.lane.name, { kind: 'stopped', victim: victim.sessionId })
            // A record that is gone already (another writer took it out meanwhile) is the outcome wanted.
            if ('no' in gone && gone.no !== 'unknown-lane') {
              outcome = { unremoved: gone.no }
              await log($, sid, 'error', `lane-unremoved ${gone.no}`).catch(() => undefined)
              await sidClearAfterStop($, sid, prep.lane.src, prep.lane.name, victim.sessionId)
            } else {
              outcome = 'removed'
              await log($, sid, 'lane-removed', prep.lane.name)
            }
          }
        }
        return { result: c.stoppedText(verb as 'retire' | 'terminate', prep.lane.name, victim.pid as number, outcome) } as never
      }
      try {
        return await afterSignal()
      } catch {
        await log($, sid, 'error', `after-signal-${verb}`).catch(() => undefined)
        return { result: c.afterSignalFailedText(verb as 'retire' | 'park' | 'terminate', prep.lane.name, victim.pid as number) } as never
      } finally {
        signalledCalls.delete(callKey)
      }
    })).catch(async ($, e, next) => {
      // v15.4 (2026-11-06): the kind of the failure goes to the log, never its text (it could hold a path): throw, or timeout (the hook outran its 10 s of own time;
      // `next.error.kind`, HookFailure in the hook API). Before the signal nothing was done, and the run-on code stops at abandoned(). A call cut off after the signal
      // answers what happened (signalledCalls), never "failed closed". Nothing here may throw: the answer is built first, the log is best effort.
      const kind = next?.error?.kind === 'timeout' ? 'timeout' : 'throw'
      const sid = await Promise.resolve($.session.id()).catch(() => undefined)
      const sent = typeof sid === 'string' ? signalledCalls.get(stopCallKey(sid, verb, (e as { lane?: unknown }).lane)) : undefined
      if (typeof sid === 'string') await log($, sid, 'error', `lane_${verb}-hook-${kind}${sent ? '-after-signal' : ''}`).catch(() => undefined)
      return sent ? ({ result: c.afterSignalFailedText(verb as 'retire' | 'park' | 'terminate', sent.name, sent.pid) } as never) : { deny: `lane_${verb} failed closed.` }
    })
  }

  // Best effort: a session that ends without it leaves a presence file that goes stale in 30 s.
  on('session.end', async ($, e, next) => {
    const sid = await $.session.id()
    laneBrief.delete(sid)
    laneBriefed.delete(sid)
    midDelivered.delete(sid)
    promptMidSent.delete(sid)
    promptMidRetold.delete(sid)
    // v14 (2026-11-04, review c2, CR1): what a lead last saw of a manager goes with the session.
    managerSeen.delete(sid)
    managerSeenBusy.delete(sid)
    await presenceDrop($, sid).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const sid = await $.session.id()
    try {
      const req = (await $.state.get(request)).value as Request | null | undefined
      if (req && (e as { agentId?: string }).agentId === undefined) {
        if (req.phase === 'called') {
          if (e.reason !== 'answer') await dropRequest($, sid, 'turn-ended-badly')
          else {
            await $.state.set(request, { ...req, phase: 'armed' })
            await log($, sid, 'armed', req.mode)
          }
        } else if (req.phase === 'armed' && req.mode === 'on-cue') {
          await dropRequest($, sid, 'new-turn')
        }
      }
    } catch {
      await dropRequest($, sid, 'turn-complete-error').catch(() => undefined)
    }
    if ((e as { agentId?: string }).agentId === undefined) {
      // v13.2: when the main agent's turn ended starts the keepalive gap; a real turn (not one the mod's ping, nudge, notice or lanes-changed text started)
      // also restarts the stop clock. A ping turn never records a nudge: a session waiting past its level would otherwise get one after every ping.
      const kind = turnKind.get(sid)
      turnKind.delete(sid)
      try {
        const at = await $.clock.now()
        await $.state.set(turnEndRef, at)
        if (kind === undefined) await $.state.set(realEndRef, at)
      } catch {
        await log($, sid, 'error', 'turn-end').catch(() => undefined)
      }
      const mid = midDelivered.delete(sid)
      promptMidFallback(sid)
      if (kind !== 'ping' && e.reason === 'answer') {
        if (mid) await midTurnFallback($, sid).catch(() => log($, sid, 'error', 'nudge-fallback').catch(() => undefined))
        else await thresholdNudge($, sid).catch(() => log($, sid, 'error', 'nudge-check').catch(() => undefined))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The lead's briefing: one session-scope section, only while lead is on in this session. The hook sees the request's tools and traits but not an agent id, so a
  // request that does not offer the lane tools (a subagent with a narrow tool list) or that is a teammate's render of its lead's prompt gets nothing.
  // The lane's briefing, in the same hook (the engine takes one prompt.compose hook per module): one session-scope section while this session is a bound lane
  // (laneBrief, filled where the binding is written). The request must offer request_compact: every session registers it, so this only keeps out a subagent
  // with a narrow tool list; the binding is the real gate. After a reload the module memory is empty: a binding still in the session's state gets the text
  // with the generic lead and report wording; a read that throws gets nothing.
  on('prompt.compose', async ($, e, next) => {
    // The gates are decided before next runs, so the trailing catch can never call next a second time.
    const sid = await $.session.id()
    const pin = pinOf(sid)
    const gated = pin !== undefined && !e.traits.includes('teammate') && Array.isArray(e.tools) && e.tools.includes(c.LEAD_LANE_TOOL)
    // v14 (2026-11-04): the manager's section, on the same gates.
    const mg = grants.get(sid)
    const managerText = mg?.level === 'manager' && !e.traits.includes('teammate') && Array.isArray(e.tools) && e.tools.includes(c.LEAD_LANE_TOOL) ? c.managerBriefing(mg.name) : undefined
    // v15: the conductor's section, on the same gates.
    const condHome = conductorHome.get(sid)
    const conductorText = mg?.level === 'conductor' && condHome !== undefined && !e.traits.includes('teammate') && Array.isArray(e.tools) && e.tools.includes(c.LEAD_LANE_TOOL) ? c.conductorBriefing(mg.name, condHome, mg.pins) : undefined
    let brief: c.LaneFacts | undefined
    if (!e.traits.includes('teammate') && Array.isArray(e.tools) && e.tools.includes(c.LANE_COMPACT_TOOL)) {
      brief = laneBrief.get(sid)
      if (!brief) {
        try {
          const b = (await $.state.get(lane)).value as Bound | null | undefined
          if (b && typeof b.name === 'string') brief = { name: b.name, sid, attached: b.adopted === true }
        } catch {}
      }
    }
    const laneText = brief ? c.laneBriefing(brief) : undefined
    // v14 (2026-11-04, review c1): a lead is told of on-cue compaction only while its tick last saw a live manager (no file read here).
    const leadManager = gated && grants.get(sid)?.level === 'lead' && managerSeen.get(sid)?.live === true
    // v15 S7b: and of a trusted conductor over its repo.
    const seenConductors = gated && grants.get(sid)?.level === 'lead' ? (managerSeen.get(sid)?.conductors ?? []) : []
    const out = await next(e)
    if ((!gated && laneText === undefined && managerText === undefined && conductorText === undefined) || !Array.isArray(out?.sections)) return out
    let sections = out.sections
    if (gated) sections = [...sections.filter((x) => x.id !== c.LEAD_BRIEFING_ID), { id: c.LEAD_BRIEFING_ID, text: c.leadBriefing(pin), scope: 'session' as const }]
    if (gated) sections = [...sections.filter((x) => x.id !== c.LEAD_MANAGER_ID), ...(leadManager ? [{ id: c.LEAD_MANAGER_ID, text: c.LEAD_MANAGER_TEXT, scope: 'session' as const }] : [])]
    // ADR 0004: the lead's prompt section, beside the briefing (whose approved text is left alone).
    if (gated) sections = [...sections.filter((x) => x.id !== pr.LEAD_PROMPTS_ID), ...(grants.get(sid)?.level === 'lead' ? [{ id: pr.LEAD_PROMPTS_ID, text: pr.LEAD_PROMPT_BRIEFING, scope: 'session' as const }] : [])]
    if (gated) sections = [...sections.filter((x) => x.id !== c.LEAD_CONDUCTOR_ID), ...(seenConductors.length > 0 ? [{ id: c.LEAD_CONDUCTOR_ID, text: c.leadConductorText(seenConductors), scope: 'session' as const }] : [])]
    if (managerText !== undefined) sections = [...sections.filter((x) => x.id !== c.MANAGER_BRIEFING_ID), { id: c.MANAGER_BRIEFING_ID, text: managerText, scope: 'session' as const }]
    if (conductorText !== undefined) sections = [...sections.filter((x) => x.id !== c.CONDUCTOR_BRIEFING_ID), { id: c.CONDUCTOR_BRIEFING_ID, text: conductorText, scope: 'session' as const }]
    // PR 3: the conductor's and the manager's prompt section (the lead's is above).
    {
      const lvl = grants.get(sid)?.level
      const tierText = lvl === 'conductor' && conductorText !== undefined ? pr.tierPromptBriefing('conductor') : lvl === 'manager' && managerText !== undefined ? pr.tierPromptBriefing('manager') : undefined
      sections = [...sections.filter((x) => x.id !== pr.TIER_PROMPTS_ID), ...(tierText !== undefined ? [{ id: pr.TIER_PROMPTS_ID, text: tierText, scope: 'session' as const }] : [])]
    }
    if (laneText !== undefined) sections = [...sections.filter((x) => x.id !== c.LANE_BRIEFING_ID), { id: c.LANE_BRIEFING_ID, text: laneText, scope: 'session' as const }]
    return { ...out, sections }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const sid = await $.session.id()
    const n = own.get(e.text) ?? 0
    // v13.2: a prompt starts a new keepalive gap. v13.4: the mod's own prompts do not reach this hook (engine 2.1.316); their gap starts at their turn's end.
    // Were an engine to show them, the ping is the one prompt that leaves the turn mark alone (F1): it is no work, so a lane's signed report stays current
    // and a lane signed done is not read as working.
    const ping = n > 0 && e.text === c.KEEPALIVE_TEXT
    lastSubmitAt.set(sid, await $.clock.now())
    // Every other prompt of every origin, the mod's own included, so a signed report goes stale at the next turn.
    if (!ping) await markTurn($, sid)
    if (n > 0) {
      // A turn the ping, a nudge, a notice or the lanes-changed text starts is not real work (A): it does not restart the keepalive stop clock.
      // v13.4: nothing is counted down here; the turn.start that carries the text does it, so nothing is counted twice.
      if ((unrealOwn.get(e.text) ?? 0) > 0) turnKind.set(sid, ping ? 'ping' : 'unreal')
      else turnKind.delete(sid)
      return next(e)
    }
    turnKind.delete(sid)
    // A prompt that is not the mod's own ends the nudge grant: it covers the nudge turn and the turns that follow without the person typing.
    if ((await $.state.get(nudgedAtRef)).value != null) await $.state.set(nudgedAtRef, null)
    const req = (await $.state.get(request)).value as Request | null | undefined
    if (req && req.phase !== 'compacting') await dropRequest($, sid, req.phase === 'compacted' ? 'user-message-cancelled-resume' : 'new-prompt')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    // The ping's own turn leaves the turn mark alone, as its prompt does (F1).
    if ((e as { agentId?: string }).agentId === undefined) {
      // v13.4: a turn that carries one of the mod's own texts (framed or not) is that submit's: counted down, and not real for a not-real text. Any other
      // (a person's prompt, a wake, a queued message) is real.
      const t = ownTextOf((e as { text?: unknown }).text)
      let kind: 'ping' | 'unreal' | undefined
      if (t !== undefined) {
        countDown(own, t)
        if ((unrealOwn.get(t) ?? 0) > 0) {
          countDown(unrealOwn, t)
          kind = t === c.KEEPALIVE_TEXT ? 'ping' : 'unreal'
        }
      }
      const sid = await $.session.id()
      if (kind) turnKind.set(sid, kind)
      else turnKind.delete(sid)
      if (kind !== 'ping') await markTurn($, sid)
    }
    const req = (await $.state.get(request)).value as Request | null | undefined
    if (req && req.phase === 'armed' && req.mode === 'on-cue' && (e as { agentId?: string }).agentId === undefined) await dropRequest($, await $.session.id(), 'new-turn')
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- prompt answering (ADR 0004): see promptHook ----
  // tool.check returns the engine's verdict unchanged, every time (F-C: a mod's tool.check can pierce a deny rule, so callboard's never changes one).
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    await promptObserve($, e, r).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    // P-I5 (probed 2026-11-06): the dialog of a subagent's ask is shown only after the hooks return, so a wait would hide it from the person. Its ask stays his:
    // the chain beneath at once, with no request file, no wait and no notice.
    const agent = (e as { agent_id?: unknown }).agent_id
    if (typeof agent === 'string' && agent !== '') return next(e)
    let once: Promise<any> | undefined
    const nextOnce = (x: any) => (once ??= Promise.resolve(next(x)))
    try {
      return await promptHook($, e, nextOnce, next.signal)
    } catch {
      // A failing hook answers nothing: the dialog stays.
      return nextOnce(e)
    }
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', postToolHook).catch(($, e, next) => next(e))
  on('classic.PostToolUseFailure', postToolHook).catch(($, e, next) => next(e))
  on('classic.PermissionDenied', doneHook).catch(($, e, next) => next(e))

  on('classic.PostCompact', async ($, e, next) => {
    const sid = await $.session.id()
    try {
      const req = (await $.state.get(request)).value as Request | null | undefined
      if (req && req.phase === 'compacting') {
        const doneAt = await $.clock.now()
        await bump($, (ct) => ({ ...ct, lastCompactMs: doneAt })).catch(() => log($, sid, 'error', 'postcompact-counter'))
        await $.state.set(request, { ...req, phase: 'compacted', compactedMs: doneAt })
        await log($, sid, 'compacted')
        await saveHint($, sid)
      }
    } finally {
      // v13.1: any compaction that ended clears the mark, whatever the request says (a reload may have dropped it) and even if the step above threw;
      // after the request, so it delays nothing.
      await cmpClear($, sid)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
