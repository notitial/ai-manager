'use strict'
// Panel control for callboard. All vscode and filesystem access is injected so the
// registry-diff race can be tested with a fake registry.

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const { reservedHit } = require('./reserved.js')

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/
const ADOPT_MAX = 64
const PID_MAX = 2 ** 22
// An adopted panel is dropped when its process is still alive this long after the request and no registry entry ever showed it: a close request for an unrelated live process.
const ADOPT_TTL_MS = 5 * 60_000

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !!err && err.code === 'EPERM'
  }
}

// Start time of a process as `ps` prints it in UTC, the way the session registry records procStart; undefined when it cannot be read.
function psStart(pid) {
  return new Promise((resolve) => {
    require('node:child_process').execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000, env: { TZ: 'UTC', LC_ALL: 'C' } }, (err, out) =>
      resolve(err ? undefined : String(out)),
    )
  })
}
const startKey = (s) => (typeof s === 'string' && s.trim() !== '' ? s.trim().replace(/\s+/g, ' ') : undefined)

function createLanes({ vscode, registry, sleep, now, workspaceFolders = () => undefined, timeoutMs = 15000, pollMs = 200, guardMs = 120000, adoptTtlMs = ADOPT_TTL_MS, alive = pidAlive, startOf = psStart }) {
  // registry.list() -> [{ sessionId, cwd, entrypoint, name }] (parsed ~/.claude/sessions/*.json)
  let chain = Promise.resolve()
  function serial(fn) {
    const run = chain.then(fn, fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  const panels = (list) => list.filter((e) => e.entrypoint === 'claude-vscode')

  // The list an open compares against must hold every panel, or an existing one could be taken for the new one. A read that skipped a file (a torn
  // write) or could not list the folder says so (complete false); it is tried twice more, then the open fails.
  async function fullList() {
    for (let i = 0; i < 3; i++) {
      const list = await registry.list()
      if (list.complete !== false) return list
      if (i < 2) await sleep(pollMs)
    }
    throw new Error('registry-incomplete: the session registry could not be read in full')
  }

  // The Claude extension's open command, bounded: one that never settles would hold the serial chain, and with it every later open, reopen and the spool.
  // It fails with a timeout once limitMs has passed; the panel may still come up later, which the callers already handle as a late panel.
  async function bounded(p, limitMs, what) {
    let state = 0
    let val
    let err
    const settled = Promise.resolve(p).then((v) => { state = 1; val = v }, (e) => { state = 2; err = e })
    const start = now()
    for (;;) {
      await Promise.race([settled, sleep(pollMs)])
      if (state === 1) return val
      if (state === 2) throw err
      if (now() - start >= limitMs) throw new Error(`timeout: ${what} did not return`)
    }
  }
  // Time left of a call's limit, never below one poll: a wait after a slow command still reads the registry at least once.
  const left = (start, limitMs) => Math.max(pollMs, limitMs - (now() - start))

  async function waitNew(before, cwd, limitMs = timeoutMs) {
    const seen = new Set(before.map((e) => e.sessionId))
    const start = now()
    let lastFound = []
    for (;;) {
      lastFound = panels(await registry.list()).filter((e) => !seen.has(e.sessionId) && e.cwd === cwd)
      if (lastFound.length > 1) throw new Error('ambiguous: more than one new panel in that folder')
      if (lastFound.length === 1) return lastFound[0].sessionId
      if (now() - start >= limitMs) break
      await sleep(pollMs)
    }
    throw new Error('timeout: no new panel registered')
  }

  // Opens one panel without a prompt and returns its session id. Opens run one at a time.
  // The spool passes a shorter timeoutMs than the lead's wait, and refuseUnnamed: a panel that registers after that
  // timeout still sits unnamed in the folder, so a retry is refused until the lead names it instead of opening a second.
  function open(folder, { timeoutMs: limitMs = timeoutMs, refuseUnnamed = false } = {}) {
    if (typeof folder !== 'string' || !folder.startsWith('/')) return Promise.reject(new Error('folder must be an absolute path'))
    const ws = workspaceFolders()
    if (ws !== undefined && !ws.includes(folder)) return Promise.reject(new Error('folder is not the first workspace folder of this window; editor.open opens there'))
    return serial(async () => {
      const start = now()
      const before = await fullList()
      if (refuseUnnamed && unnamedOurs(before, folder)) throw new Error('unnamed-panel: an unnamed panel already sits in that folder')
      const prev = activeTab()
      try {
        // The fifth argument opens it as a full editor, like a panel opened by hand: no panel header, the editor's background.
        // One time limit covers the registry read, the command and the wait, so the spool still answers before the lead stops waiting.
        await bounded(vscode.commands.executeCommand('claude-vscode.editor.open', undefined, undefined, undefined, undefined, true), left(start, limitMs), 'the open command')
        const sid = await waitNew(before, folder, left(start, limitMs))
        opened.set(sid, now())
        return sid
      } catch (err) {
        if (/^(timeout|ambiguous)/.test(String(err && err.message))) trackLate(folder, before)
        throw err
      } finally {
        await refocus(prev)
      }
    })
  }

  // Panels this extension opened and nobody has named yet. Claude gives every new panel a generated name (nameSource auto), so a missing
  // name says nothing; a rename sets nameSource to user. After a timeout or an ambiguous result the panel may still register, so
  // any panel in that folder that was not there before the earliest unresolved attempt counts too: a retry keeps that record
  // instead of replacing it. The lead's own panel is never counted. A record older than guardMs is dropped: a rename is
  // refused once the panel is that old, so keeping it would only block the lane for good.
  const opened = new Map()
  const late = new Map()
  const named = (e) => e.nameSource === 'user' || (e.nameSource === undefined && !!e.name)
  function trackLate(folder, before) {
    const cur = late.get(folder)
    if (cur && now() - cur.at < guardMs) return
    late.set(folder, { at: now(), seen: new Set(before.map((e) => e.sessionId)) })
  }
  function unnamedOurs(list, folder) {
    const t = now()
    const l = late.get(folder)
    const lateLive = l !== undefined && t - l.at < guardMs
    return panels(list).some(
      (e) =>
        e.cwd === folder &&
        !named(e) &&
        ((opened.has(e.sessionId) && t - opened.get(e.sessionId) < guardMs) || (lateLive && !l.seen.has(e.sessionId))),
    )
  }

  // The new panel takes focus from the tab the lead was in; switch back to that tab once the panel has registered.
  // The tab is found again by identity (then by a label no other tab shares), because opening a panel can shift every index. If it is gone,
  // or the active column moved, focus stays where it is. After a timeout the panel may still register later and take
  // focus again; that case is left alone.
  function activeTab() {
    try {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab
      return t ? { tab: t, col: t.group.viewColumn, label: t.label } : undefined
    } catch {
      return undefined
    }
  }

  async function refocus(prev) {
    try {
      if (!prev) return
      const g = prev.tab.group
      if (g.viewColumn !== prev.col || vscode.window.tabGroups.activeTabGroup.viewColumn !== prev.col) return
      let i = g.tabs.indexOf(prev.tab)
      if (i < 0 && prev.label) {
        const same = g.tabs.flatMap((t, k) => (t.label === prev.label ? [k] : []))
        if (same.length === 1) i = same[0]
      }
      if (i < 0) return
      // Bounded too: it runs inside the serial chain, after a timed-out open as well.
      await bounded(vscode.commands.executeCommand('workbench.action.openEditorAtIndex', i), 5 * pollMs, 'the focus command')
    } catch {}
  }

  // Reopens a saved conversation by its session id. Only a registry row whose process is alive counts (the registry keeps the rows of processes that died), and
  // alive means its pid answers and `ps` agrees with the row's procStart, as the mod checks: a pid reused by another process leaves the old row dead. A live
  // panel of that id returns at once, a live row that is not a panel (a terminal) is refused rather than opened a second time, and the wait takes only a live
  // panel whose pid is new, so a row left by the stopped process is never taken for the reopened one. The spool passes a timeout shorter than the lead's wait.
  function reopen(sid, { timeoutMs: limitMs = timeoutMs } = {}) {
    if (!SID_RE.test(String(sid))) return Promise.reject(new Error('bad session id'))
    const started = async (e) => {
      const want = startKey(e.procStart)
      return want !== undefined && startKey(await startOf(e.pid)) === want
    }
    const live = async (list) => {
      const out = []
      for (const e of list) if (e.sessionId === sid && Number.isInteger(e.pid) && e.pid > 1 && alive(e.pid) && (await started(e))) out.push(e)
      return out
    }
    return serial(async () => {
      const start = now()
      const before = await fullList()
      const now0 = await live(before)
      if (panels(now0).length > 0) return sid
      if (now0.length > 0) throw new Error('live-elsewhere: that session runs outside a VS Code panel')
      const old = new Set(before.filter((e) => e.sessionId === sid).map((e) => e.pid))
      // As open: the panel opened for the lane does not keep focus; the tab that was active gets it back.
      const prev = activeTab()
      try {
        // As open: one time limit from the first registry read, and the wait reads at least once.
        await bounded(vscode.commands.executeCommand('claude-vscode.editor.open', sid, undefined, undefined, undefined, true), left(start, limitMs), 'the open command')
        const waitFrom = now()
        const waitMs = left(start, limitMs)
        for (;;) {
          if (panels(await live(await registry.list())).some((e) => !old.has(e.pid))) return sid
          if (now() - waitFrom >= waitMs) break
          await sleep(pollMs)
        }
        throw new Error('timeout: panel did not register')
      } finally {
        await refocus(prev)
      }
    })
  }

  // A panel this extension opened leaves a dead tab with an exit banner once its session ends. Sweeping notes each such panel's last name,
  // process id and tab from the registry. When the entry is gone and that process is dead, its tab is closed, but only if no live session
  // still carries that name (a new panel for the same lane), only for a known pid (a missing or odd pid is never taken for dead), never a
  // reserved name, and only the tab seen for that panel (or, if VS Code gave out a new object, the one Claude tab with its label).
  // History stays, so the session can be reopened. A live process (a /clear or a resume in the same panel) is never closed.
  const lastSeen = new Map()
  const adoptedAt = new Map()
  const claudeTabs = () =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /claude/i.test(String(t.input && t.input.viewType)))
  async function sweep() {
    if (opened.size === 0) return
    const all = await registry.list()
    if (all.complete === false) return
    const list = panels(all)
    for (const sid of [...opened.keys()]) {
      const e = list.find((x) => x.sessionId === sid)
      if (e) {
        adoptedAt.delete(sid)
        const same = e.name ? claudeTabs().filter((t) => t.label === e.name) : []
        const prev = lastSeen.get(sid)
        lastSeen.set(sid, { name: e.name, pid: e.pid, tab: same.length === 1 ? same[0] : prev && prev.name === e.name ? prev.tab : undefined })
        continue
      }
      const rec = lastSeen.get(sid)
      if (!rec) {
        if (now() - opened.get(sid) > guardMs) opened.delete(sid)
        continue
      }
      if (!Number.isInteger(rec.pid) || rec.pid < 2) {
        opened.delete(sid)
        lastSeen.delete(sid)
        adoptedAt.delete(sid)
        continue
      }
      if (alive(rec.pid)) {
        if (adoptedAt.has(sid) && now() - adoptedAt.get(sid) > adoptTtlMs) {
          opened.delete(sid)
          lastSeen.delete(sid)
          adoptedAt.delete(sid)
        }
        continue
      }
      opened.delete(sid)
      lastSeen.delete(sid)
      adoptedAt.delete(sid)
      if (!rec.name || reservedHit(rec.name)) continue
      if (all.some((x) => x.name === rec.name)) continue
      const tabs = claudeTabs().filter((t) => t.label === rec.name)
      const tab = rec.tab && tabs.includes(rec.tab) ? rec.tab : tabs.length === 1 ? tabs[0] : undefined
      if (!tab) continue
      try {
        await Promise.resolve(vscode.window.tabGroups.close(tab))
      } catch {}
    }
  }

  // A close request the mod writes after it stopped a lane's session (the spool hands it over): the panel was not opened by this extension, but the sweep may
  // close its tab under the same rules, so the request adds nothing a forged file could use: the pid must be dead, no live session may carry the name,
  // and only the one Claude tab with that label goes. The number of adopted panels is bounded.
  function adopt(sid, { name, pid } = {}) {
    if (!SID_RE.test(String(sid)) || !Number.isInteger(pid) || pid < 2 || pid > PID_MAX || typeof name !== 'string' || !NAME_RE.test(name) || reservedHit(name)) return false
    if (!opened.has(sid) && opened.size >= ADOPT_MAX) return false
    const prev = lastSeen.get(sid)
    if (!opened.has(sid)) adoptedAt.set(sid, now())
    opened.set(sid, now())
    lastSeen.set(sid, { name, pid, tab: prev && prev.name === name ? prev.tab : undefined })
    return true
  }

  async function close(sid) {
    if (!SID_RE.test(String(sid))) throw new Error('bad session id')
    const entry = panels(await registry.list()).find((e) => e.sessionId === sid)
    if (!entry || !entry.name) throw new Error('no such open panel')
    if (reservedHit(entry.name)) throw new Error('refusing to close a reserved lane name')
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.label === entry.name && /claude/i.test(String(t.input && t.input.viewType)))
    if (tabs.length !== 1) throw new Error(`expected one tab named for the panel, found ${tabs.length}`)
    await vscode.window.tabGroups.close(tabs[0])
    return sid
  }

  return { open, reopen, close, sweep, adopt }
}

module.exports = { createLanes, SID_RE }
