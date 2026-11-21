'use strict'
// Panel control for callboard. All vscode and filesystem access is injected so the
// registry-diff race can be tested with a fake registry.

const { SID_RE, NAME_RE, pidAlive } = require('./reserved.js')
const { psStart, procStateWith } = require('./proc.js')

const ADOPT_MAX = 64
const PID_MAX = 2 ** 22
// An adopted panel is dropped when its process is still alive this long after the request and no registry entry ever showed it: a close request for an unrelated live process.
const ADOPT_TTL_MS = 5 * 60_000
// How long a new panel's registry row must keep its session id before an open answers with it.
const SETTLE_MS = 2000
// How long a dead tab is shown before the sweep closes it: time for the Claude extension to see it as the active tab.
const SHOW_MS = 300
const GROUP_FOCUS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].map((n) => `workbench.action.focus${n}EditorGroup`)

function createLanes({ vscode, registry, sleep, now, workspaceFolders = () => undefined, passCwd = false, timeoutMs = 15000, pollMs = 200, settleMs = SETTLE_MS, showMs = SHOW_MS, guardMs = 120000, adoptTtlMs = ADOPT_TTL_MS, alive = pidAlive, startOf = psStart }) {
  // registry.list() -> [{ sessionId, cwd, entrypoint, name }] (parsed ~/.claude/sessions/*.json)
  let chain = Promise.resolve()
  function serial(fn) {
    const run = chain.then(fn, fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  const panels = (list) => list.filter((e) => e.entrypoint === 'claude-vscode')

  // With the patched Claude extension (claude-patch.js) the open command takes the folder in its sixth argument and starts the panel there; unpatched, it
  // always starts in the window's first folder, so the caller's workspaceFolders lists only that one and nothing is passed.
  const cwdArg = (folder) => (passCwd && folder !== undefined ? [{ cwd: folder }] : [])
  const folderError = (folder) => {
    const ws = workspaceFolders()
    if (ws === undefined || ws.includes(folder)) return undefined
    return passCwd ? 'folder is not a workspace folder of this window' : 'folder is not the first workspace folder of this window; editor.open opens there'
  }

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

  // The Claude extension's open command, bounded: one that never settles would hold the serial chain, and with it every later open and reopen.
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
      if (lastFound.length === 1) return lastFound[0]
      if (now() - start >= limitMs) break
      await sleep(pollMs)
    }
    throw new Error('timeout: no new panel registered')
  }

  // A new panel's process writes its registry row, and the row can be rewritten with another session id once the panel's session is up (seen: about a
  // second after the first write on a fast open, and the first id never appears in the registry again). The row is followed by its pid until its session
  // id and start time have held for settleMs, and that id is the answer. An id still moving when `end` passes is a timeout, as is a row that is gone by then:
  // the panel stays tracked as late (trackLate), and the plugin names it from the registry.
  async function settled(first, cwd, end) {
    const same = (a, b) => (a.pid !== undefined ? a.pid === b.pid : a.sessionId === b.sessionId)
    let cur = first
    let since = now()
    let missing = false
    for (;;) {
      if (!missing && now() - since >= settleMs) return cur.sessionId
      if (now() >= end) throw new Error(missing ? 'timeout: the new panel left the registry' : 'timeout: the panel session id did not settle')
      await sleep(pollMs)
      const row = panels(await registry.list()).find((e) => e.cwd === cwd && same(cur, e))
      missing = row === undefined
      if (missing) {
        since = now()
        continue
      }
      if (row.sessionId !== cur.sessionId || row.startedAt !== cur.startedAt) since = now()
      cur = row
    }
  }

  // Opens one panel without a prompt and returns its session id. Opens run one at a time.
  // The spool passes a shorter timeoutMs than the plugin's wait, and refuseUnnamed: a panel that registers after that
  // timeout still sits unnamed in the folder, so a retry is refused until the lead names it instead of opening a second.
  function open(folder, { timeoutMs: limitMs = timeoutMs, refuseUnnamed = false } = {}) {
    if (typeof folder !== 'string' || !folder.startsWith('/')) return Promise.reject(new Error('folder must be an absolute path'))
    const bad = folderError(folder)
    if (bad) return Promise.reject(new Error(bad))
    return serial(async () => {
      const start = now()
      const before = await fullList()
      if (refuseUnnamed && unnamedOurs(before, folder)) throw new Error('unnamed-panel: an unnamed panel already sits in that folder')
      const prev = activeTab()
      let refocused = false
      try {
        // The fifth argument opens it as a full editor, like a panel opened by hand: no panel header, the editor's background.
        // One time limit covers the registry read, the command and the wait, so the spool still answers before the plugin stops waiting.
        await bounded(vscode.commands.executeCommand('claude-vscode.editor.open', undefined, undefined, undefined, undefined, true, ...cwdArg(folder)), left(start, limitMs), 'the open command')
        const row = await waitNew(before, folder, left(start, limitMs))
        // The panel took focus when it opened: the lead's tab gets it back now, not after the wait for the id to settle.
        await refocus(prev)
        refocused = true
        const sid = await settled(row, folder, start + limitMs)
        opened.set(sid, now())
        return sid
      } catch (err) {
        if (/^(timeout|ambiguous)/.test(String(err && err.message))) trackLate(folder, before)
        throw err
      } finally {
        if (!refocused) await refocus(prev)
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

  // The Claude extension marks a session unread, and its list then counts it as active, when a turn ends in a tab that is not showing; it clears the mark only
  // when that tab is shown. A lane's last turn usually ends that way, so the sweep shows a dead tab for a moment before it closes it, then gives focus back to
  // the tab that had it. A tab that is showing already (the active tab of its group) is closed as it is. This runs in the serial chain, so it never crosses an
  // open's own focus changes, and it may wait behind one: a tab that is gone by then is left alone. Showing is best effort: whatever fails or cannot be told
  // here is skipped, and the tab is closed either way. The focus commands take keyboard focus, so for that moment keys go to the dead tab, and afterwards
  // focus is in the tab that was active, also when it was in a terminal or a side bar before.
  async function focusTab(tab) {
    const groups = vscode.window.tabGroups
    const g = groups.all.find((x) => x.tabs.includes(tab))
    if (!g) return
    if (groups.activeTabGroup.viewColumn !== g.viewColumn) {
      const cmd = GROUP_FOCUS[g.viewColumn - 1]
      if (!cmd) throw new Error('no focus command for that group')
      await bounded(vscode.commands.executeCommand(cmd), 5 * pollMs, 'the group focus command')
    }
    await bounded(vscode.commands.executeCommand('workbench.action.openEditorAtIndex', g.tabs.indexOf(tab)), 5 * pollMs, 'the focus command')
  }
  // The sweep judged the tab dead some time ago and this may have waited behind an open or a reopen: the registry is read again here, and the tab stays when a
  // session that is not dead carries the lane's name now (an unpark's resumed panel), or when the registry cannot be read in full after the same three tries an open makes.
  async function nameHeld(name) {
    try {
      const all = await fullList()
      for (const x of all) if (x.name === name && (await procState(x.pid, x.procStart)) !== 'dead') return true
      return false
    } catch {
      return true
    }
  }
  function closeSeen(tab, name) {
    return serial(async () => {
      if (!claudeTabs().includes(tab)) return
      if (await nameHeld(name)) return
      let prev
      try {
        const at = activeTab()
        if (at && at.tab !== tab && tab.isActive !== true) {
          prev = at.tab
          await focusTab(tab)
          await sleep(showMs)
        }
      } catch {}
      try {
        await Promise.resolve(vscode.window.tabGroups.close(tab))
      } catch {}
      try {
        if (prev) await focusTab(prev)
      } catch {}
    })
  }

  // The state of a process the registry names ('dead', 'live' or 'maybe': proc.js). reopen takes only 'live'; the sweep closes a tab only on 'dead', so a
  // check that fails keeps the tab. A sweep passes its own pid -> start time map and drops it at its end.
  const procState = procStateWith({ alive, startOf })
  const rowLive = async (e) => (await procState(e.pid, e.procStart)) === 'live'

  // Reopens a saved conversation by its session id. Only a registry row whose process is alive counts (the registry keeps the rows of processes that died), and
  // alive means its pid answers and `ps` agrees with the row's procStart, as the plugin checks: a pid reused by another process leaves the old row dead. A live
  // panel of that id returns at once, a live row that is not a panel (a terminal) is refused rather than opened a second time, and the wait takes only a live
  // panel whose pid is new, so a row left by the stopped process is never taken for the reopened one. The spool passes a timeout shorter than the plugin's wait.
  // `folder`, when given, is the lane's folder: the patched Claude extension resumes the conversation there (the transcript is looked up from the panel's folder).
  function reopen(sid, { timeoutMs: limitMs = timeoutMs, folder } = {}) {
    if (!SID_RE.test(String(sid))) return Promise.reject(new Error('bad session id'))
    const bad = folder === undefined ? undefined : folderError(folder)
    if (bad) return Promise.reject(new Error(bad))
    const live = async (list) => {
      const out = []
      for (const e of list) if (e.sessionId === sid && (await rowLive(e))) out.push(e)
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
        await bounded(vscode.commands.executeCommand('claude-vscode.editor.open', sid, undefined, undefined, undefined, true, ...cwdArg(folder)), left(start, limitMs), 'the open command')
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
  // process id and tab from the registry. When no live entry is left and that process is dead, its tab is closed, but only if no live session
  // still carries that name (a new panel for the same lane), only for a known pid (a missing or odd pid is never taken for dead), and only
  // the tab seen for that panel (or, if VS Code gave out a new object, the one Claude tab with its label).
  // The tab is shown for a moment first, so its session does not stay marked unread (closeSeen). History stays, so the session can be reopened. A live process (a /clear or a resume in the same panel) is never closed.
  // Rows and the recorded process are judged by procState: a dead row neither keeps a tab nor blocks a close, and anything not proven dead
  // (a failed `ps`, a row with no start time) keeps the tab: a row of that sid that is 'maybe' and not the recorded pid keeps it, the recorded
  // pid closes it only when 'dead' (a pid since reused by another process is 'dead'), and a row with the name blocks the close unless 'dead'.
  // Sweeps never overlap (the interval may fire while one still waits on `ps`): a call during a sweep returns that sweep.
  const lastSeen = new Map()
  const adoptedAt = new Map()
  const forget = (sid) => {
    opened.delete(sid)
    lastSeen.delete(sid)
    adoptedAt.delete(sid)
  }
  const claudeTabs = () =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /claude/i.test(String(t.input && t.input.viewType)))
  let sweeping
  function sweep() {
    if (!sweeping) sweeping = sweepOnce().finally(() => { sweeping = undefined })
    return sweeping
  }
  async function sweepOnce() {
    if (opened.size === 0) return
    // The tabs to close, closed once every panel is judged: a close can wait behind an open, and nothing is judged on a registry read that old.
    const dead = []
    try {
      await judge(dead)
    } finally {
      for (const { tab, name } of dead) await closeSeen(tab, name)
    }
  }
  async function judge(dead) {
    const all = await registry.list()
    if (all.complete === false) return
    const list = panels(all)
    const starts = new Map()
    for (const sid of [...opened.keys()]) {
      let e
      let firstMaybe
      const maybePids = []
      for (const x of list) {
        if (x.sessionId !== sid) continue
        const st = await procState(x.pid, x.procStart, starts)
        if (st === 'live') { e = x; break }
        if (st === 'maybe') { maybePids.push(x.pid); if (!firstMaybe) firstMaybe = x }
      }
      const note = (x) => {
        const same = x.name ? claudeTabs().filter((t) => t.label === x.name) : []
        const prev = lastSeen.get(sid)
        lastSeen.set(sid, { name: x.name, pid: x.pid, procStart: x.procStart, tab: same.length === 1 ? same[0] : prev && prev.name === x.name ? prev.tab : undefined })
      }
      if (e) {
        adoptedAt.delete(sid)
        note(e)
        continue
      }
      // No live row, but one that may be live: note it, so its tab can still close once its pid is proven dead. The step below keeps the tab
      // while it is 'maybe'; an adopted record still expires by its TTL.
      if (firstMaybe) note(firstMaybe)
      const rec = lastSeen.get(sid)
      if (!rec) {
        if (now() - opened.get(sid) > guardMs) opened.delete(sid)
        continue
      }
      if (!Number.isInteger(rec.pid) || rec.pid < 2) {
        forget(sid)
        continue
      }
      if (maybePids.some((p) => p !== rec.pid) || (await procState(rec.pid, rec.procStart, starts)) !== 'dead') {
        if (adoptedAt.has(sid) && now() - adoptedAt.get(sid) > adoptTtlMs) forget(sid)
        continue
      }
      forget(sid)
      if (!rec.name) continue
      let held = false
      for (const x of all) if (x.name === rec.name && (await procState(x.pid, x.procStart, starts)) !== 'dead') { held = true; break }
      if (held) continue
      const tabs = claudeTabs().filter((t) => t.label === rec.name)
      const tab = rec.tab && tabs.includes(rec.tab) ? rec.tab : tabs.length === 1 ? tabs[0] : undefined
      if (!tab) continue
      dead.push({ tab, name: rec.name })
    }
  }

  // A close request the plugin writes after it stopped a session (the spool hands it over): the panel was not opened by this extension, but the sweep may
  // close its tab under the same rules, so the request adds nothing a forged file could use: the pid must be dead, no live session may carry the name,
  // and only the one Claude tab with that label goes. The number of adopted panels is bounded.
  function adopt(sid, { name, pid } = {}) {
    if (!SID_RE.test(String(sid)) || !Number.isInteger(pid) || pid < 2 || pid > PID_MAX || typeof name !== 'string' || !NAME_RE.test(name)) return false
    if (!opened.has(sid) && opened.size >= ADOPT_MAX) return false
    const prev = lastSeen.get(sid)
    if (!opened.has(sid)) adoptedAt.set(sid, now())
    opened.set(sid, now())
    lastSeen.set(sid, { name, pid, procStart: prev && prev.pid === pid ? prev.procStart : undefined, tab: prev && prev.name === name ? prev.tab : undefined })
    return true
  }

  return { open, reopen, sweep, adopt }
}

module.exports = { createLanes }
