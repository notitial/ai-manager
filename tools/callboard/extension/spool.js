'use strict'
// Open requests from a lead session (ADR 0002). The lead's lane_open tool writes <LANE>.open into
// ~/.claude/callboard/open; this window opens the lane's panel when the lane is in a lane store and its
// folder is a workspace folder of this window, then writes <LANE>.result (`ok <sid>` or `error <code>`).
// A conductor's lead_open writes <NAME>.lead (ADR 0006): no lane record exists, so the request names the repo, and this window
// opens a panel only when that repo is its first workspace folder, answering on <NAME>.result the same way.
// Every file is a filter: any process of the same user can write here, so the limits below do not rely on the file.

const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const nodefs = require('node:fs')
const os = require('node:os')
const { reservedHit, pinRefusal, SID_RE, NAME_RE } = require('./reserved.js')

const MAX_AGE_MS = 120_000
const MIN_GAP_MS = 10_000
const MAX_SKEW_MS = 5000
const RESULT_KEEP_MS = 600_000
const REQUEST_TEXT = 'open\n'
// <NAME>.lead: `lead <nonce, 32 hex> <repo real path>`, one line.
const LEAD_MAX = 1024
const LEAD_RE = /^lead [0-9a-f]{32} (\/[\x21-\x7e]{1,500})\n$/
const OPEN_BUDGET = 6
const OPEN_BUDGET_MS = 60_000
const LIVE_PER_REPO = 8
const STORE_MAX_BYTES = 16_384
const STORE_MAX_LANES = 16

const clean = (p) => typeof p === 'string' && /^\/[\x21-\x7e]*$/.test(p) && !p.split('/').some((s) => s === '..' || s === '.') && p.length < 512 && !p.includes('//')

// The text of a plain file of this user's, or undefined for anything else. The file is opened without following a link and checked on the open handle:
// a plain file, owned by uid, with one link, a mode that modeBad(mode) does not reject, and at most max bytes. max + 1 bytes are read, so a file that
// grew after the check is cut. A failed open, check or read is undefined too.
async function readOwned(file, uid, { modeBad, max }) {
  const fh = await fsp.open(file, nodefs.constants.O_RDONLY | nodefs.constants.O_NOFOLLOW | nodefs.constants.O_NONBLOCK).catch(() => undefined)
  if (!fh) return undefined
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.uid !== uid || modeBad(st.mode) || st.nlink !== 1 || st.size > max) return undefined
    const buf = Buffer.alloc(max + 1)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return undefined
  } finally {
    await fh.close().catch(() => undefined)
  }
}

// Whether a folder is a git repo root, by the mod's rule (gitRoot in the mod's engine/base.ts): `.git`, not followed if it is a link, is a folder holding a plain HEAD file,
// or a plain file of this user's, not group or other writable, whose text starts `gitdir: ` (a worktree or submodule). An empty `.git` folder, a
// symlinked `.git`, anything else or a failed check is not.
async function gitRoot(dir, uid) {
  const git = path.join(dir, '.git')
  const g = await fsp.lstat(git).catch(() => undefined)
  if (!g) return false
  if (g.isDirectory()) return !!(await fsp.lstat(path.join(git, 'HEAD')).catch(() => undefined))?.isFile()
  if (!g.isFile()) return false
  const text = await readOwned(git, uid, { modeBad: (mode) => (mode & 0o7022) !== 0, max: 4096 })
  return text !== undefined && text.startsWith('gitdir: ')
}

// The lanes a lead made: one file per repo in the user's own callboard folder, named by the sha-256 of the repo's real path.
// Read the way the mod reads them (plain file, ours, 0600, one link, small, found by listing, never by walking up), and a lane counts only when its
// folder is inside the repo and is its own real path. The extension reads only this folder, never a repo's own files.
async function readStores(dir, { uid = process.getuid(), home = os.homedir() } = {}) {
  const d = await fsp.lstat(dir).catch(() => undefined)
  if (!d || !d.isDirectory() || d.uid !== uid || (d.mode & 0o777) !== 0o700) return []
  const out = []
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).sort().slice(0, 64)
  for (const n of names) {
    const file = path.join(dir, n)
    const text = await readOwned(file, uid, { modeBad: (mode) => (mode & 0o777) !== 0o600, max: STORE_MAX_BYTES })
    if (text === undefined) continue
    let j
    try {
      j = JSON.parse(text)
    } catch {
      continue
    }
    if (!j || !clean(j.repo) || j.repo.length < 2 || !Array.isArray(j.lanes) || j.lanes.length > STORE_MAX_LANES) continue
    if (!Array.isArray(j.creates) || j.creates.length > 64 || j.creates.some((t) => !Number.isFinite(t))) continue
    if (pinRefusal(j.repo, home) !== undefined) continue
    if (crypto.createHash('sha256').update(j.repo).digest('hex') !== n.slice(0, -5)) continue
    if ((await fsp.realpath(j.repo).catch(() => '')) !== j.repo) continue
    if (!(await gitRoot(j.repo, uid))) continue
    // The mod refuses a whole store for any bad record; so does this.
    const seen = new Set()
    const bad = j.lanes.some((l) => {
      if (!l || typeof l.name !== 'string' || !NAME_RE.test(l.name) || reservedHit(l.name) || seen.has(l.name) || !Number.isFinite(l.createdAt)) return true
      seen.add(l.name)
      if (!clean(l.folder) || !(l.folder === j.repo || l.folder.startsWith(`${j.repo}/`))) return true
      // A lane an existing session joined: adopted is exactly true and names the lead's session id; any other record has no lead.
      if (l.adopted === undefined ? l.lead !== undefined : l.adopted !== true || typeof l.lead !== 'string' || !SID_RE.test(l.lead)) return true
      // sid is absent or a session id; parked is absent or a finite time, and only with a sid.
      if (l.sid !== undefined && (typeof l.sid !== 'string' || !SID_RE.test(l.sid))) return true
      if (l.parked !== undefined && (!Number.isFinite(l.parked) || l.sid === undefined)) return true
      return !/^\/[A-Za-z0-9._\/-]{1,200}$/.test(String(l.brief)) || !clean(l.brief) || !l.brief.startsWith(`${l.folder}/`)
    })
    if (bad) continue
    for (const l of j.lanes) {
      if ((await fsp.realpath(l.folder).catch(() => '')) !== l.folder) continue
      out.push({ name: l.name, folder: l.folder, repo: j.repo, store: n, ...(l.sid !== undefined ? { sid: l.sid } : {}) })
    }
  }
  return out
}

// The lanes the leads made, from the stores. A lane whose name is in more than one store is dropped.
async function allLanes({ storeDir, uid, home } = {}) {
  const out = []
  const stores = await readStores(storeDir, { uid, home })
  const stored = new Map()
  for (const l of stores) stored.set(l.name, new Set([...(stored.get(l.name) ?? []), l.store]))
  for (const l of stores) if (stored.get(l.name).size === 1) out.push({ name: l.name, folder: l.folder, repo: l.repo, ...(l.sid !== undefined ? { sid: l.sid } : {}) })
  return out
}

function createSpool({ dir, uid = process.getuid(), home = os.homedir(), loadLanes, openLane, closeLane, reopenLane, workspaceFolders, liveInRepo, now = Date.now }) {
  let seq = 0
  let busy = false
  const lastOpen = new Map()
  const opens = []
  // An open that failed only because the session registry could not be read in full opened nothing: it does not count against the budget or the gap.
  const giveBack = (t, name, prev) => {
    const i = opens.lastIndexOf(t)
    if (i >= 0) opens.splice(i, 1)
    if (prev === undefined) lastOpen.delete(name)
    else lastOpen.set(name, prev)
  }

  async function ensureDir() {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    const st = await fsp.lstat(dir)
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) throw new Error('unsafe directory')
    if ((st.mode & 0o777) !== 0o700) await fsp.chmod(dir, 0o700)
  }

  async function writeResult(name, text) {
    const tmp = path.join(dir, `.${name}.${process.pid}.${++seq}.tmp`)
    const fh = await fsp.open(tmp, 'wx', 0o600)
    try {
      await fh.writeFile(text)
    } finally {
      await fh.close()
    }
    try {
      await fsp.rename(tmp, path.join(dir, `${name}.result`))
    } catch (e) {
      await fsp.unlink(tmp).catch(() => undefined)
      throw e
    }
  }

  const drop = (file) => fsp.unlink(file).catch(() => undefined)

  // The front half every request kind shares: look at the file, the file test (plain, ours, 0600, one link, at most maxBytes) and the age test. It returns
  // { code } for the refusal to give back (a bad or stale file is dropped), or { file, st, t }.
  async function look(name, ext, maxBytes) {
    const file = path.join(dir, `${name}.${ext}`)
    const st = await fsp.lstat(file).catch(() => undefined)
    if (!st) return { code: 'gone' }
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > maxBytes) {
      await drop(file)
      return { code: 'bad-file' }
    }
    const t = now()
    if (st.mtimeMs - t > MAX_SKEW_MS || t - st.mtimeMs > MAX_AGE_MS) {
      await drop(file)
      return { code: 'stale' }
    }
    return { file, st, t }
  }

  // The back half: the claim by rename (the request is handled once, and the 1 s rescan never reopens it), the inode check, the bounded read, and the claimed
  // file dropped. { code } when the rename lost; otherwise { body }, undefined when the claimed file was not the one first looked at.
  async function take(name, file, st, maxBytes) {
    const taken = path.join(dir, `.${name}.${process.pid}.${++seq}.taken`)
    try {
      await fsp.rename(file, taken)
    } catch {
      return { code: 'claim-lost' }
    }
    const moved = await fsp.lstat(taken).catch(() => undefined)
    const body = moved && moved.isFile() && moved.ino === st.ino && moved.size <= maxBytes ? await fsp.readFile(taken, 'utf8').catch(() => undefined) : undefined
    await drop(taken)
    return { body }
  }

  // The three lane request kinds in this order: look, the lane list, the lane, the window's folder, take. It returns { code } for the refusal to give back, or
  // { lane, body, t }. answers: a refusal for the lane list or an unknown lane is also answered on <LANE>.result; a close request answers nothing.
  async function claim(name, ext, maxBytes, answers) {
    const f = await look(name, ext, maxBytes)
    if (f.code) return f
    let lanes
    try {
      lanes = await loadLanes()
    } catch {
      await drop(f.file)
      if (answers) await writeResult(name, 'error lanes-file\n')
      return { code: 'lanes-file' }
    }
    const lane = lanes.find((l) => l.name === name)
    if (!lane) {
      await drop(f.file)
      if (answers) await writeResult(name, 'error unknown-lane\n')
      return { code: 'unknown-lane' }
    }
    // Another window may hold the folder: leave the file for it, and answer nothing.
    if (!(workspaceFolders() || []).includes(lane.folder)) return { code: 'not-mine' }
    const got = await take(name, f.file, f.st, maxBytes)
    if (got.code) return got
    return { lane, body: got.body, t: f.t }
  }

  // The half an open and a reopen share once the request is read: the gap since this lane's last open, the live sessions in its repo, the budget of opens a
  // minute. It answers a refusal on <LANE>.result and returns { code }; otherwise it records the open and returns { prev }, the lane's earlier open time for giveBack.
  async function admit(name, lane, t) {
    if (t - (lastOpen.get(name) ?? -Infinity) < MIN_GAP_MS) {
      await writeResult(name, 'error too-soon\n')
      return { code: 'too-soon' }
    }
    if (lane.repo && liveInRepo && (await liveInRepo(lane.repo).catch(() => Infinity)) >= LIVE_PER_REPO) {
      await writeResult(name, 'error too-many\n')
      return { code: 'too-many' }
    }
    while (opens.length && t - opens[0] > OPEN_BUDGET_MS) opens.shift()
    if (opens.length >= OPEN_BUDGET) {
      await writeResult(name, 'error too-soon\n')
      return { code: 'too-soon' }
    }
    const prev = lastOpen.get(name)
    opens.push(t)
    lastOpen.set(name, t)
    return { prev }
  }

  // Handles one request file. Returns what happened, for the tests; nothing is thrown for a bad request.
  async function handle(name) {
    const got = await claim(name, 'open', 16, true)
    if (got.code) return got.code
    const { lane, body, t } = got
    if (body !== REQUEST_TEXT) {
      await writeResult(name, 'error bad-request\n')
      return 'bad-request'
    }
    const adm = await admit(name, lane, t)
    if (adm.code) return adm.code
    return openPanel(name, lane.folder, t, adm.prev)
  }

  // Opens the panel in the folder and answers on <NAME>.result: `ok <sid>`, or `error <code>`.
  async function openPanel(name, folder, t, prevOpen) {
    try {
      const sid = await openLane(folder)
      if (!SID_RE.test(String(sid))) throw new Error('no sid')
      await writeResult(name, `ok ${sid}\n`)
      return 'opened'
    } catch (e) {
      const m = String((e && e.message) || '')
      if (m.startsWith('registry-incomplete')) giveBack(t, name, prevOpen)
      const code = m.startsWith('timeout') ? 'timeout' : m.startsWith('ambiguous') ? 'ambiguous' : m.startsWith('unnamed-panel') ? 'unnamed-panel' : m.includes('workspace folder') ? 'not-workspace' : 'failed'
      await writeResult(name, `error ${code}\n`)
      return code
    }
  }

  // A lead request, <NAME>.lead, written by a conductor's lead_open: `lead <nonce> <repo>`. No lane record names the repo, so the request does. It is read first,
  // without following a link and without claiming it: a request for another window's repo is left where it is, and answers nothing. Only a repo that is this window's first
  // workspace folder, is its own real path and is no broad folder is claimed (renamed, checked by inode, read again, and the same text required), so a request
  // is handled once. Then the same limits as an open (the gap per name, 8 live sessions in the repo, 6 opens a minute) and the same panel open, which refuses
  // while an unnamed panel of ours sits in the folder. The nonce is not read here: the request only opens a window.
  async function handleLead(name) {
    const f = await look(name, 'lead', LEAD_MAX)
    if (f.code) return f.code
    const text = await readOwned(f.file, uid, { modeBad: (mode) => (mode & 0o777) !== 0o600, max: LEAD_MAX })
    const m = text === undefined ? null : LEAD_RE.exec(text)
    if (!m) {
      await drop(f.file)
      await writeResult(name, 'error bad-request\n')
      return 'bad-request'
    }
    const repo = m[1]
    if (!clean(repo) || pinRefusal(repo, home) !== undefined || reservedHit(name) || !(workspaceFolders() || []).includes(repo)) return 'not-mine'
    if ((await fsp.realpath(repo).catch(() => '')) !== repo) return 'not-mine'
    const got = await take(name, f.file, f.st, LEAD_MAX)
    if (got.code) return got.code
    if (got.body !== text) {
      await writeResult(name, 'error bad-request\n')
      return 'bad-request'
    }
    const adm = await admit(name, { repo }, f.t)
    if (adm.code) return adm.code
    return openPanel(name, repo, f.t, adm.prev)
  }

  // A close request: <LANE>.close, three lines (session id, pid, lane name), written by the mod after a stop signal. The lane must be in the lane list and
  // its folder the first workspace folder of this window; nothing is answered. The panel then goes to the extension's sweep, which closes the tab only once
  // that pid is dead and no live session carries the name.
  async function handleClose(name) {
    const got = await claim(name, 'close', 128, false)
    if (got.code) return got.code
    const { body } = got
    const m = typeof body === 'string' ? /^([0-9a-f-]{36})\n([0-9]{1,10})\n([A-Za-z0-9_-]{1,40})\n$/.exec(body) : null
    if (!m || !SID_RE.test(m[1]) || m[3] !== name || reservedHit(name) || !closeLane) return 'bad-request'
    const pid = Number(m[2])
    if (!Number.isInteger(pid) || pid < 2 || pid > 2 ** 22) return 'bad-request'
    return closeLane({ sid: m[1], pid, name }) ? 'closing' : 'bad-request'
  }

  // A reopen request, <LANE>.reopen, written by lane_unpark: one line, the session id of the lane's saved conversation. The lane's store record must name
  // that very id, and the window must hold the lane folder as its first folder. The same rate limits as an open; answered on
  // <LANE>.result with `ok <sid>` or `error <code>`.
  async function handleReopen(name) {
    const got = await claim(name, 'reopen', 64, true)
    if (got.code) return got.code
    const { lane, body, t } = got
    const m = typeof body === 'string' ? /^([0-9a-f-]{36})\n$/.exec(body) : null
    if (!m || !SID_RE.test(m[1])) {
      await writeResult(name, 'error bad-request\n')
      return 'bad-request'
    }
    if (lane.sid !== m[1]) {
      await writeResult(name, 'error sid-mismatch\n')
      return 'sid-mismatch'
    }
    const adm = await admit(name, lane, t)
    if (adm.code) return adm.code
    const prevOpen = adm.prev
    try {
      if (!reopenLane) throw new Error('no reopen')
      const got = await reopenLane(m[1])
      if (got !== m[1]) throw new Error('other sid')
      await writeResult(name, `ok ${m[1]}\n`)
      return 'reopened'
    } catch (e) {
      const msg = String((e && e.message) || '')
      if (msg.startsWith('registry-incomplete')) giveBack(t, name, prevOpen)
      const code = msg.startsWith('timeout') ? 'timeout' : msg.startsWith('live-elsewhere') ? 'live-elsewhere' : 'failed'
      await writeResult(name, `error ${code}\n`)
      return code
    }
  }

  // The request kinds a scan handles, by file suffix (the suffixes exclude each other: .open is last, and no other suffix ends in it); a name that fails NAME_RE is left alone.
  const KINDS = [['.close', handleClose], ['.reopen', handleReopen], ['.lead', handleLead], ['.open', handle]]
  async function scan() {
    if (busy) return []
    busy = true
    const out = []
    try {
      await ensureDir()
      for (const f of await fsp.readdir(dir)) {
        if (f.endsWith('.result')) {
          const r = await fsp.lstat(path.join(dir, f)).catch(() => undefined)
          if (r && now() - r.mtimeMs > RESULT_KEEP_MS) await drop(path.join(dir, f))
          continue
        }
        const kind = KINDS.find(([suffix]) => f.endsWith(suffix))
        if (!kind) continue
        const name = f.slice(0, -kind[0].length)
        if (NAME_RE.test(name)) out.push([name, await kind[1](name)])
      }
    } catch {
      // an unsafe or unreadable folder is skipped until the next scan
    } finally {
      busy = false
    }
    return out
  }

  function start(intervalMs = 1000) {
    const timer = setInterval(() => void scan(), intervalMs)
    return { dispose: () => clearInterval(timer) }
  }

  return { scan, handle, handleClose, handleReopen, handleLead, start }
}

module.exports = { createSpool, readStores, allLanes, REQUEST_TEXT }
