'use strict'
// Open requests from a lead session (ADR 0002). The lead's lane_open tool writes <LANE>.open into
// ~/.claude/callboard/open; this window opens the lane's panel when the lane is in the root-owned lanes.json and its
// folder is a workspace folder of this window, then writes <LANE>.result (`ok <sid>` or `error <code>`).
// Every file is a filter: any process of the same user can write here, so the limits below do not rely on the file.

const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const nodefs = require('node:fs')
const os = require('node:os')
const { reservedHit, pinRefusal } = require('./reserved.js')

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_AGE_MS = 120_000
const MIN_GAP_MS = 10_000
const MAX_SKEW_MS = 5000
const RESULT_KEEP_MS = 600_000
const REQUEST_TEXT = 'open\n'
const OPEN_BUDGET = 6
const OPEN_BUDGET_MS = 60_000
const LIVE_PER_REPO = 8
const STORE_MAX_BYTES = 16_384
const STORE_MAX_LANES = 16

const clean = (p) => typeof p === 'string' && /^\/[\x21-\x7e]*$/.test(p) && !p.split('/').some((s) => s === '..' || s === '.') && p.length < 512 && !p.includes('//')

// The root-owned lanes file, read the way the mod reads it: a plain file owned by ownerUid, not group or other writable,
// in directories that are too, from its folder up to stopAt.
async function readLanes(file, { ownerUid = 0, stopAt = '/' } = {}) {
  const st = await fsp.lstat(file)
  if (!st.isFile() || st.uid !== ownerUid || st.nlink !== 1 || (st.mode & 0o022) !== 0) throw new Error('lanes-file')
  let dir = file
  for (;;) {
    dir = path.dirname(dir)
    const d = await fsp.lstat(dir)
    if (!d.isDirectory() || d.uid !== ownerUid || (d.mode & 0o022) !== 0) throw new Error('lanes-parent')
    if (dir === stopAt || dir === '/') break
  }
  const j = JSON.parse(await fsp.readFile(file, 'utf8'))
  if (!j || !Array.isArray(j.lanes)) throw new Error('lanes-shape')
  return j.lanes.filter((l) => l && NAME_RE.test(l.name) && !reservedHit(l.name) && clean(l.folder)).map((l) => ({ name: l.name, folder: l.folder }))
}

// Whether a folder is a git repo root, by the mod's rule (register.ts gitRoot): `.git`, not followed if it is a link, is a folder holding a plain HEAD file,
// or a plain file of this user's, not group or other writable, whose text starts `gitdir: ` (a worktree or submodule). An empty `.git` folder, a
// symlinked `.git`, anything else or a failed check is not.
async function gitRoot(dir, uid) {
  const git = path.join(dir, '.git')
  const g = await fsp.lstat(git).catch(() => undefined)
  if (!g) return false
  if (g.isDirectory()) return !!(await fsp.lstat(path.join(git, 'HEAD')).catch(() => undefined))?.isFile()
  if (!g.isFile()) return false
  const fh = await fsp.open(git, nodefs.constants.O_RDONLY | nodefs.constants.O_NOFOLLOW | nodefs.constants.O_NONBLOCK).catch(() => undefined)
  if (!fh) return false
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o7022) !== 0 || st.nlink !== 1 || st.size > 4096) return false
    const buf = Buffer.alloc(4097)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).toString('utf8').startsWith('gitdir: ')
  } catch {
    return false
  } finally {
    await fh.close().catch(() => undefined)
  }
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
    let text
    const fh = await fsp.open(file, nodefs.constants.O_RDONLY | nodefs.constants.O_NOFOLLOW | nodefs.constants.O_NONBLOCK).catch(() => undefined)
    if (!fh) continue
    try {
      const st = await fh.stat()
      if (!st.isFile() || st.uid !== uid || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > STORE_MAX_BYTES) continue
      const buf = Buffer.alloc(STORE_MAX_BYTES + 1)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      text = buf.subarray(0, bytesRead).toString('utf8')
    } catch {
      continue
    } finally {
      await fh.close().catch(() => undefined)
    }
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
      // v13: sid is absent or a session id; parked is absent or a finite time, and only with a sid.
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

// The root-owned file when there is one (a missing file is no root lanes; an unsafe one still throws), plus the lead-made lanes. A root lane wins a name clash.
async function allLanes({ rootFile, storeDir, ownerUid = 0, stopAt = '/', uid, home } = {}) {
  let root = []
  try {
    root = await readLanes(rootFile, { ownerUid, stopAt })
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) throw e
  }
  const out = [...root]
  const stores = await readStores(storeDir, { uid, home })
  const stored = new Map()
  for (const l of stores) stored.set(l.name, new Set([...(stored.get(l.name) ?? []), l.store]))
  for (const l of stores) if (stored.get(l.name).size === 1 && !out.some((x) => x.name === l.name)) out.push({ name: l.name, folder: l.folder, repo: l.repo, ...(l.sid !== undefined ? { sid: l.sid } : {}) })
  return out
}

function createSpool({ dir, uid = process.getuid(), loadLanes, openLane, closeLane, reopenLane, workspaceFolders, liveInRepo, now = Date.now }) {
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

  // Handles one request file. Returns what happened, for the tests; nothing is thrown for a bad request.
  async function handle(name) {
    const file = path.join(dir, `${name}.open`)
    const st = await fsp.lstat(file).catch(() => undefined)
    if (!st) return 'gone'
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > 16) {
      await drop(file)
      return 'bad-file'
    }
    const t = now()
    if (st.mtimeMs - t > MAX_SKEW_MS || t - st.mtimeMs > MAX_AGE_MS) {
      await drop(file)
      return 'stale'
    }
    let lanes
    try {
      lanes = await loadLanes()
    } catch {
      await drop(file)
      await writeResult(name, 'error lanes-file\n')
      return 'lanes-file'
    }
    const lane = lanes.find((l) => l.name === name)
    if (!lane) {
      await drop(file)
      await writeResult(name, 'error unknown-lane\n')
      return 'unknown-lane'
    }
    // Another window may hold the folder: leave the file for it, and answer nothing.
    if (!(workspaceFolders() || []).includes(lane.folder)) return 'not-mine'
    const taken = path.join(dir, `.${name}.${process.pid}.${++seq}.taken`)
    try {
      await fsp.rename(file, taken)
    } catch {
      return 'claim-lost'
    }
    const moved = await fsp.lstat(taken).catch(() => undefined)
    const body = moved && moved.isFile() && moved.ino === st.ino && moved.size <= 16 ? await fsp.readFile(taken, 'utf8').catch(() => undefined) : undefined
    await drop(taken)
    if (body !== REQUEST_TEXT) {
      await writeResult(name, 'error bad-request\n')
      return 'bad-request'
    }
    if (t - (lastOpen.get(name) ?? -Infinity) < MIN_GAP_MS) {
      await writeResult(name, 'error too-soon\n')
      return 'too-soon'
    }
    if (lane.repo && liveInRepo && (await liveInRepo(lane.repo).catch(() => Infinity)) >= LIVE_PER_REPO) {
      await writeResult(name, 'error too-many\n')
      return 'too-many'
    }
    while (opens.length && t - opens[0] > OPEN_BUDGET_MS) opens.shift()
    if (opens.length >= OPEN_BUDGET) {
      await writeResult(name, 'error too-soon\n')
      return 'too-soon'
    }
    const prevOpen = lastOpen.get(name)
    opens.push(t)
    lastOpen.set(name, t)
    try {
      const sid = await openLane(lane.folder)
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

  // A close request: <LANE>.close, three lines (session id, pid, lane name), written by the mod after a stop signal. The lane must be in the lane list and
  // its folder the first workspace folder of this window; nothing is answered. The panel then goes to the extension's sweep, which closes the tab only once
  // that pid is dead and no live session carries the name.
  async function handleClose(name) {
    const file = path.join(dir, `${name}.close`)
    const st = await fsp.lstat(file).catch(() => undefined)
    if (!st) return 'gone'
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > 128) {
      await drop(file)
      return 'bad-file'
    }
    const t = now()
    if (st.mtimeMs - t > MAX_SKEW_MS || t - st.mtimeMs > MAX_AGE_MS) {
      await drop(file)
      return 'stale'
    }
    let lanes
    try {
      lanes = await loadLanes()
    } catch {
      await drop(file)
      return 'lanes-file'
    }
    const lane = lanes.find((l) => l.name === name)
    if (!lane) {
      await drop(file)
      return 'unknown-lane'
    }
    if (!(workspaceFolders() || []).includes(lane.folder)) return 'not-mine'
    const taken = path.join(dir, `.${name}.${process.pid}.${++seq}.taken`)
    try {
      await fsp.rename(file, taken)
    } catch {
      return 'claim-lost'
    }
    const moved = await fsp.lstat(taken).catch(() => undefined)
    const body = moved && moved.isFile() && moved.ino === st.ino && moved.size <= 128 ? await fsp.readFile(taken, 'utf8').catch(() => undefined) : undefined
    await drop(taken)
    const m = typeof body === 'string' ? /^([0-9a-f-]{36})\n([0-9]{1,10})\n([A-Za-z0-9_-]{1,40})\n$/.exec(body) : null
    if (!m || !SID_RE.test(m[1]) || m[3] !== name || reservedHit(name) || !closeLane) return 'bad-request'
    const pid = Number(m[2])
    if (!Number.isInteger(pid) || pid < 2 || pid > 2 ** 22) return 'bad-request'
    return closeLane({ sid: m[1], pid, name }) ? 'closing' : 'bad-request'
  }

  // v13: a reopen request, <LANE>.reopen, written by lane_unpark: one line, the session id of the lane's saved conversation. The lane's store record must name
  // that very id (a root lane has none), and the window must hold the lane folder as its first folder. The same rate limits as an open; answered on
  // <LANE>.result with `ok <sid>` or `error <code>`.
  async function handleReopen(name) {
    const file = path.join(dir, `${name}.reopen`)
    const st = await fsp.lstat(file).catch(() => undefined)
    if (!st) return 'gone'
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > 64) {
      await drop(file)
      return 'bad-file'
    }
    const t = now()
    if (st.mtimeMs - t > MAX_SKEW_MS || t - st.mtimeMs > MAX_AGE_MS) {
      await drop(file)
      return 'stale'
    }
    let lanes
    try {
      lanes = await loadLanes()
    } catch {
      await drop(file)
      await writeResult(name, 'error lanes-file\n')
      return 'lanes-file'
    }
    const lane = lanes.find((l) => l.name === name)
    if (!lane) {
      await drop(file)
      await writeResult(name, 'error unknown-lane\n')
      return 'unknown-lane'
    }
    if (!(workspaceFolders() || []).includes(lane.folder)) return 'not-mine'
    const taken = path.join(dir, `.${name}.${process.pid}.${++seq}.taken`)
    try {
      await fsp.rename(file, taken)
    } catch {
      return 'claim-lost'
    }
    const moved = await fsp.lstat(taken).catch(() => undefined)
    const body = moved && moved.isFile() && moved.ino === st.ino && moved.size <= 64 ? await fsp.readFile(taken, 'utf8').catch(() => undefined) : undefined
    await drop(taken)
    const m = typeof body === 'string' ? /^([0-9a-f-]{36})\n$/.exec(body) : null
    if (!m || !SID_RE.test(m[1])) {
      await writeResult(name, 'error bad-request\n')
      return 'bad-request'
    }
    if (lane.sid !== m[1]) {
      await writeResult(name, 'error sid-mismatch\n')
      return 'sid-mismatch'
    }
    if (t - (lastOpen.get(name) ?? -Infinity) < MIN_GAP_MS) {
      await writeResult(name, 'error too-soon\n')
      return 'too-soon'
    }
    if (lane.repo && liveInRepo && (await liveInRepo(lane.repo).catch(() => Infinity)) >= LIVE_PER_REPO) {
      await writeResult(name, 'error too-many\n')
      return 'too-many'
    }
    while (opens.length && t - opens[0] > OPEN_BUDGET_MS) opens.shift()
    if (opens.length >= OPEN_BUDGET) {
      await writeResult(name, 'error too-soon\n')
      return 'too-soon'
    }
    const prevOpen = lastOpen.get(name)
    opens.push(t)
    lastOpen.set(name, t)
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
        if (f.endsWith('.close')) {
          const cname = f.slice(0, -6)
          if (NAME_RE.test(cname)) out.push([cname, await handleClose(cname)])
          continue
        }
        if (f.endsWith('.reopen')) {
          const rname = f.slice(0, -7)
          if (NAME_RE.test(rname)) out.push([rname, await handleReopen(rname)])
          continue
        }
        if (!f.endsWith('.open')) continue
        const name = f.slice(0, -5)
        if (!NAME_RE.test(name)) continue
        out.push([name, await handle(name)])
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

  return { scan, handle, handleClose, handleReopen, start }
}

module.exports = { createSpool, readLanes, readStores, allLanes, NAME_RE, REQUEST_TEXT }
