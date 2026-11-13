// The process calls (every external binary), the log, the person-facing dialogs and toasts, the private-file reads and the one sender of the mod's own fixed turns.
// Trust rules held here: a dialog answer is the person's own click or a failure; a file read checks owner, mode, link count and size before and after; submitOwn counts each own text.
import * as c from '../core.ts'
import { own, lastLogged, unrealOwn, dialogOpen, mem } from '../mem.ts'

const ID = '/usr/bin/id'
export const STAT = '/usr/bin/stat'
export const MV = '/bin/mv'
export const RM = '/bin/rm'
export const RMDIR = '/bin/rmdir'
export const MKDIR = '/bin/mkdir'
export const TEE = '/usr/bin/tee'
export const INSTALL = '/usr/bin/install'
const SHASUM = '/usr/bin/shasum'
export const REALPATH = '/bin/realpath'
export const HEAD = '/usr/bin/head'
export const PS = '/bin/ps'
export const KILL = '/bin/kill'
const SLEEP = '/bin/sleep'
export const STAT_FMT = '%u %Lp %l %HT %i %z %m'
export const TICK_MS = 2000
export const ACTION_TIMEOUT_MS = 60_000

type R = { exitCode: number; stdout: string; stderr: string }

const ASK_TIMEOUT_MS = 90_000

export function run($: any, argv: string[], stdin?: string, env?: Record<string, string>): Promise<R> {
  return $.process.run(argv, { timeoutMs: 5000, ...(stdin === undefined ? {} : { stdin }), ...(env === undefined ? {} : { env }) })
}
// Remove files that may not exist; a failed remove is swallowed. One path or an array of them (the mod's checks do not allow `$` beside a spread).
export function rmF($: any, paths: string | string[]): Promise<R | undefined> {
  return run($, [RM, '-f', '--', ...(typeof paths === 'string' ? [paths] : paths)]).catch(() => undefined)
}

// A wait inside one tool call goes through a host process, never $.clock.sleep. A hook has 10 s of its own time per dispatch (HookBudget.ms),
// and a $.clock.sleep counts against it while no $ call does; a hook past it is cut off, its .catch answers, and the code that was running goes on unseen.
// false: the process did not run or failed, so the caller must not loop on it.
export async function pause($: any, ms: number): Promise<boolean> {
  if (!Number.isFinite(ms) || ms <= 0) return false
  const r = await $.process.run([SLEEP, String(ms / 1000)], { timeoutMs: ms + 5000 }).catch(() => undefined)
  return r?.exitCode === 0
}

export async function where($: any) {
  if (mem.paths) return mem.paths
  const u = await run($, [ID, '-u'])
  const n = await run($, [ID, '-un'])
  const uid = Number(u.stdout.trim())
  const name = n.stdout.trim()
  if (u.exitCode !== 0 || n.exitCode !== 0 || !Number.isInteger(uid) || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name)) return undefined
  const sessions = `/Users/${name}/.claude/sessions`
  mem.paths = { uid, root: `/Users/${name}/.claude/callboard`, sessions }
  return mem.paths
}

export async function facts($: any, path: string) {
  const r = await run($, [STAT, '-f', STAT_FMT, '--', path])
  return r.exitCode === 0 ? c.parseStat(r.stdout) : undefined
}

export async function dirOk($: any, path: string, uid: number): Promise<boolean> {
  const f = await facts($, path)
  return !!f && f.kind === 'dir' && f.uid === uid && f.mode === 0o700
}

// One log file per session id; fixed reason codes and lane names from the lane stores only.
// Repeated identical refusals (and capped notices) are logged once, so a stuck cue cannot fill the disk.
export async function log($: any, sid: string, event: string, reason = '') {
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
  if (!f || c.cueFileOk(f, p.uid)) return
  // Past LOG_MAX_BYTES only the noisy kinds stop: every rename, stop and compaction line is still written.
  lastLogged.set(sid, key)
  if ((event === 'refused' || event === 'error' || event === 'notice-capped') && f.size > c.LOG_MAX_BYTES) return
  const line = JSON.stringify({ t: new Date(await $.clock.now()).toISOString(), event, reason })
  await run($, [TEE, '-a', '--', file], `${line}\n`)
}

// log, with a failed write swallowed: a log line is never worth failing the step that wrote it. `log` itself still throws.
export function logq($: any, sid: string, event: string, reason = ''): Promise<void> {
  return log($, sid, event, reason).catch(() => undefined)
}
// The tail of a failed step, for `.catch(...)`: log the error under `reason` and swallow a failing log.
export function logFail($: any, sid: string, reason: string) {
  return (): Promise<void> => logq($, sid, 'error', reason)
}

export async function sha($: any, text: string): Promise<string> {
  const r = await run($, [SHASUM, '-a', '256'], text)
  const h = r.stdout.slice(0, 64)
  if (r.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(h)) throw new Error('sha-failed')
  return h
}

export async function real($: any, path: string): Promise<string> {
  const r = await run($, [REALPATH, '--', path])
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

// "Not a directory": a part of the path is a file, so the path cannot exist as written; it is as absent as a missing one.
const GONE_RE = /No such file or directory|Not a directory/

// A path's real path, or 'absent' when realpath says there is no such file, or 'error' when the check itself failed (a timeout, a spawn failure, anything
// else): a writer must not treat a failed check as a folder that is gone. The message is read, so it runs in the C locale.
export async function realR($: any, path: string): Promise<{ path: string } | 'absent' | 'error'> {
  try {
    const r = await run($, [REALPATH, '--', path], undefined, { LC_ALL: 'C' })
    if (r.exitCode === 0) return { path: r.stdout.trim() }
    return GONE_RE.test(r.stderr) ? 'absent' : 'error'
  } catch {
    return 'error'
  }
}

// lstat facts of a path, 'absent', or 'error' (any failure but "no such file" or "not a directory", or a throw).
export async function statR($: any, path: string): Promise<(c.FileFacts & { ino: number }) | 'absent' | 'error'> {
  try {
    const r = await run($, [STAT, '-f', STAT_FMT, '--', path], undefined, { LC_ALL: 'C' })
    if (r.exitCode === 0) return c.parseStat(r.stdout) ?? 'error'
    return GONE_RE.test(r.stderr) ? 'absent' : 'error'
  } catch {
    return 'error'
  }
}

// Whether a folder is a git repo root, by one rule for every caller: `.git` (not followed if it is a link) is a folder holding a plain HEAD file, or a plain
// file whose first line starts `gitdir: ` (a worktree or submodule). A symlinked `.git`, an empty `.git` folder or anything else is not. 'error': a check
// failed, which is neither answer.
export async function gitRoot($: any, dir: string): Promise<'yes' | 'no' | 'error'> {
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

// A small plain file of ours (0600 unless `loose`, one link), read with a bound and checked again after the read; never with $.fs.read, which a FIFO would hang.
// 'changed': the file was replaced while it was read (worth one more try); 'failed': it was there but the read or the second look failed (also worth one more
// try, and never the same as 'bad'); 'bad': gone, too big or not a file we trust.
type Small = { state: 'ok'; text: string; mtimeMs: number } | { state: 'changed' | 'failed' | 'bad' }
export async function readSmallR($: any, path: string, uid: number, max: number, loose = false): Promise<Small> {
  const f = await facts($, path)
  if (!f || f.kind !== 'file' || f.uid !== uid || (loose ? (f.mode & 0o7022) !== 0 : f.mode !== 0o600) || f.nlink !== 1 || f.size > max) return { state: 'bad' }
  const r = await run($, [HEAD, '-c', String(max + 1), '--', path])
  const after = await facts($, path)
  if (r.exitCode !== 0 || !after) return { state: 'failed' }
  if (r.stdout.length > max) return { state: 'bad' }
  return c.sameFile(f, after) ? { state: 'ok', text: r.stdout, mtimeMs: f.mtimeMs } : { state: 'changed' }
}
export async function readSmall($: any, path: string, uid: number, max: number): Promise<{ text: string; mtimeMs: number } | undefined> {
  const r = await readSmallR($, path, uid, max)
  return r.state === 'ok' ? r : undefined
}

// The start times of the asked pids, by one ps call; undefined on any doubt (a throw, a timeout, another exit, output that does not parse).
export async function psConfirm($: any, pids: number[]): Promise<Map<number, string> | undefined> {
  try {
    const r = await run($, [PS, '-o', 'pid=,lstart=', '-p', pids.join(',')], undefined, { TZ: 'UTC', LC_ALL: 'C' })
    return typeof r.stdout === 'string' && r.stdout.length <= c.PS_TABLE_MAX ? c.parsePsConfirm(r.stdout, r.exitCode, pids, r.stderr) : undefined
  } catch {
    return undefined
  }
}

// Every process's start time, as the registry records it (UTC, C locale). undefined: ps failed, threw, or printed what cannot be trusted.
export async function psStarts($: any): Promise<Map<number, string> | undefined> {
  try {
    const r = await run($, [PS, '-A', '-o', 'pid=,lstart='], undefined, { TZ: 'UTC', LC_ALL: 'C' })
    return r.exitCode === 0 && typeof r.stdout === 'string' && r.stdout.length <= c.PS_TABLE_MAX ? c.parsePsStarts(r.stdout) : undefined
  } catch {
    return undefined
  }
}

export const countDown = (m: Map<string, number>, text: string) => {
  const n = (m.get(text) ?? 1) - 1
  if (n > 0) m.set(text, n)
  else m.delete(text)
}

// real: false for a turn that is not work: it moves no stop clock of the keepalive ping. The counts are taken down by the turn.start that
// carries the text (ownTextOf), or here when the submit throws.
export async function submitOwn($: any, text: string, real = true) {
  own.set(text, (own.get(text) ?? 0) + 1)
  if (!real) unrealOwn.set(text, (unrealOwn.get(text) ?? 0) + 1)
  mem.submits++
  try {
    await $.prompt.submit({ text })
  } catch (e) {
    countDown(own, text)
    if (!real) countDown(unrealOwn, text)
    throw e
  }
}

// The own text a main-loop turn.start carries (see c.OWN_FRAME_HEAD): one submitted and not yet counted down, as it stands or framed.
export const ownTextOf = (startText: unknown): string | undefined => c.ownTextOf(startText, own.keys())

// 'error' covers a failed dialog and any answer that is neither button; 'timed-out' a question nobody answered in time. Neither is
// a decision, and every caller treats them alike: only 'no' clears anything. The engine dialog stays on screen (no cancel call); a late click is ignored.
export type Asked = 'yes' | 'no' | 'error' | 'timed-out'
export async function ask($: any, question: string, yes: string, no: string, header: string): Promise<Asked> {
  try {
    const a = await withTimeout($, $.ui.ask(question, { options: [yes, no], header }) as Promise<string>, ASK_TIMEOUT_MS)
    return a === 'timeout' ? 'timed-out' : a === yes ? 'yes' : a === no ? 'no' : 'error'
  } catch {
    return 'error'
  }
}

// The log line and toast for a question nobody answered; returns the words the command or tool result ends with.
export async function timedOut($: any, sid: string, code = 'timed-out', toastText: string = c.TIMED_OUT_TOAST): Promise<string> {
  await log($, sid, 'refused', code)
  toast($, toastText)
  return c.TIMED_OUT
}

// A toast only informs: it runs after the effect it reports and can never change the result of the call.
export function toast($: any, text: string) {
  try {
    Promise.resolve($.ui.toast(text)).catch(() => undefined)
  } catch {}
}

// The live checkout's branch, checked once per session start (ADR 0003). The checkout is found from the mod's own folder ($.plugin.root, the folder
// holding plugin.json: <checkout>/tools/callboard/mod); .git/HEAD is read as a plain file with a bound, never through git (a changed .git/config could run
// code). Main: nothing. Another branch or a detached commit: one toast and `warn live-checkout-not-main`. No checkout at that place, a .git that is a file (a
// worktree), an unreadable or odd HEAD: `warn live-checkout-unknown`, no toast. It only warns: the mod loads and nothing is blocked. No path enters a log line.
export async function liveCheckoutCheck($: any, sid: string): Promise<void> {
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

export async function askOnce($: any, sid: string, question: string, yes: string, no: string, header: string): Promise<Asked | 'busy'> {
  if (dialogOpen.has(sid)) return 'busy'
  dialogOpen.add(sid)
  try {
    return await ask($, question, yes, no, header)
  } finally {
    dialogOpen.delete(sid)
  }
}

// The Join dialog's lead picker, with ask's time limit and error handling. More… turns the page; a dismissal, a failure or an answer not offered is 'error'.
// The answer is wrapped, so a lead named like the timeout mark is still a name.
export async function pickLead($: any, names: string[]): Promise<{ name: string } | 'error' | 'timed-out'> {
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

// One field of one process, as `ps` prints it, with the failure told apart: exit 0 is the answer; exit 1 with no output is ps's "no such process" (gone);
// any other result is a ps that failed. A ps that throws still throws. lstart is in UTC, the way the session registry records `procStart`.
export async function psOne($: any, pid: unknown, field: 'lstart=' | 'args='): Promise<{ out: string } | 'gone' | 'error'> {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return 'gone'
  const r = await run($, [PS, '-o', field, '-p', String(pid)], undefined, field === 'lstart=' ? { TZ: 'UTC', LC_ALL: 'C' } : { LC_ALL: 'C' })
  if (r.exitCode === 0) return { out: r.stdout }
  return r.exitCode === 1 && `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() === '' ? 'gone' : 'error'
}

// psOne with every failure as undefined.
export async function psStart($: any, pid: unknown): Promise<string | undefined> {
  const r = await psOne($, pid, 'lstart=')
  return typeof r === 'string' ? undefined : r.out
}

export async function psArgs($: any, pid: unknown): Promise<string | undefined> {
  const r = await psOne($, pid, 'args=')
  return typeof r === 'string' ? undefined : r.out
}

export async function withTimeout<T>($: any, p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, $.clock.sleep(ms).then(() => 'timeout' as const)])
}
