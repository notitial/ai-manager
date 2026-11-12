'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createLanes } = require('./lanes.js')

const A = '/w/a'
const B = '/w/b'
let n = 0
const sid = () => `${String(++n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`

const CLAUDE_VIEW = 'mainThreadWebview-claudeVSCodePanel'
const claudeTab = (label) => ({ label, input: { viewType: CLAUDE_VIEW } })
// Puts the given tabs in one group of the world's window (none: no group) and makes tabGroups.close record the tabs it is asked to close; returns that list.
function trackTabs(w, ...tabs) {
  const closed = []
  if (tabs.length) w.vscode.window.tabGroups.all.push({ tabs })
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
  return closed
}

// Fake VS Code + registry. Each editor.open registers a panel after `delay` ticks.
// A new panel gets a generated name (nameSource auto), as in the real registry; renaming it sets nameSource to user.
// `tabs`: { column, activeColumn, failFocus } gives the fake an active tab at index 0, to test switching back to it.
// `cwd`: the folder each panel it opens registers under (the folder the caller asks for, A, unless a test says otherwise); setCwd changes it between opens.
function world({ delays = [], extra = [], tabs, guardMs, alive, pids = false, startOf, cwd = A } = {}) {
  const entries = []
  const focusCalls = []
  let t = 0
  const pending = []
  let opens = 0
  const group = { viewColumn: tabs ? tabs.column : 1, tabs: [] }
  group.tabs.push({ group }, { group })
  const vscode = {
    commands: {
      async executeCommand(cmd, s, ...rest) {
        if (cmd === 'workbench.action.openEditorAtIndex') {
          if (tabs && tabs.failFocus) throw new Error('no such command')
          focusCalls.push(s)
          return
        }
        assert.equal(cmd, 'claude-vscode.editor.open')
        assert.deepEqual(rest, [undefined, undefined, undefined, true], 'every lane panel opens as a full editor')
        const i = opens++
        const id = s ?? sid()
        const cwdOf = cwd
        pending.push({ at: t + (delays[i] ?? 1), entry: { sessionId: id, cwd: cwdOf, entrypoint: 'claude-vscode', name: `auto-${i}`, nameSource: 'auto', ...(pids ? { pid: 5000 + i } : {}) } })
        for (const x of extra) if (x.onOpen === i) pending.push({ at: t + x.after, entry: x.entry })
      },
    },
    window: { tabGroups: { all: [], close: async () => {}, ...(tabs ? { activeTabGroup: { viewColumn: tabs.activeColumn ?? tabs.column, activeTab: group.tabs[0] } } : {}) } },
  }
  const flush = () => { for (const p of pending.filter((p) => p.at <= t)) { entries.push(p.entry); pending.splice(pending.indexOf(p), 1) } }
  const registry = { async list() { flush(); return entries.map((e) => ({ procStart: `start-${e.pid}`, ...e })) } }
  world.opens = () => opens
  const sleep = async () => { t += 1 }
  const lanes = createLanes({ vscode, registry, sleep, now: () => t, timeoutMs: 50, pollMs: 1, ...(guardMs ? { guardMs } : {}), ...(alive ? { alive } : {}), startOf: startOf ?? (async (pid) => `start-${pid}`) })
  return { lanes, entries, vscode, registry, focusCalls, tick: (n) => { t += n }, setCwd: (c) => { cwd = c } }
}

test('several panels opened one after another each get their own sid', async () => {
  const w = world()
  const got = []
  for (const cwd of [A, A, B, A]) { w.setCwd(cwd); got.push(await w.lanes.open(cwd)) }
  assert.equal(new Set(got).size, 4)
  assert.deepEqual(got, w.entries.map((e) => e.sessionId))
})

test('concurrent opens are serialised and still get distinct sids', async () => {
  const w = world({ delays: [10, 1, 5] })
  const got = await Promise.all([w.lanes.open(A), w.lanes.open(A), w.lanes.open(A)])
  assert.equal(new Set(got).size, 3)
  assert.deepEqual(got, w.entries.map((e) => e.sessionId))
})

test('a panel opened by someone else in another folder is ignored', async () => {
  const w = world({ extra: [{ onOpen: 0, after: 0, entry: { sessionId: 'f0000000-0000-4000-8000-000000000001', cwd: B, entrypoint: 'claude-vscode', name: 'x' } }] })
  const s = await w.lanes.open(A)
  assert.notEqual(s, 'f0000000-0000-4000-8000-000000000001')
})

test('a terminal session in the same folder is ignored', async () => {
  const w = world({ extra: [{ onOpen: 0, after: 0, entry: { sessionId: 'f0000000-0000-4000-8000-000000000002', cwd: A, entrypoint: 'cli', name: 'x' } }] })
  const s = await w.lanes.open(A)
  assert.notEqual(s, 'f0000000-0000-4000-8000-000000000002')
})

test('a foreign panel in the same folder at the same moment is ambiguous, never guessed', async () => {
  const w = world({ extra: [{ onOpen: 0, after: 1, entry: { sessionId: 'f0000000-0000-4000-8000-000000000003', cwd: A, entrypoint: 'claude-vscode', name: 'x' } }] })
  await assert.rejects(w.lanes.open(A), /ambiguous/)
})

test('timeout when no panel registers', async () => {
  const w = world({ delays: [1000] })
  await assert.rejects(w.lanes.open(A), /timeout/)
})

test('a shorter timeoutMs per call gives up sooner than the default', async () => {
  const w = world({ delays: [30] })
  await assert.rejects(w.lanes.open(A, { timeoutMs: 10 }), /timeout/)
})

test('refuseUnnamed blocks the next open while a panel this extension opened is unnamed, until it is named', async () => {
  const w = world()
  await w.lanes.open(A, { refuseUnnamed: true })
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /unnamed-panel/)
  assert.equal(w.entries.length, 1)
  w.entries[0].nameSource = 'user'
  assert.ok(await w.lanes.open(A, { refuseUnnamed: true }))
})

test('refuseUnnamed ignores a panel it did not open (the lead) and an unnamed panel in another folder', async () => {
  const w = world()
  w.entries.push({ sessionId: 'f0000000-0000-4000-8000-000000000008', cwd: A, entrypoint: 'claude-vscode', name: 'auto-lead', nameSource: 'auto' })
  w.entries.push({ sessionId: 'f0000000-0000-4000-8000-000000000007', cwd: B, entrypoint: 'claude-vscode', name: undefined })
  assert.ok(await w.lanes.open(A, { refuseUnnamed: true }))
})

test('a panel that registers after a timeout still blocks the retry until it is named', async () => {
  const w = world({ delays: [60] })
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /timeout/)
  w.tick(20)
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /unnamed-panel/)
  assert.equal(w.entries.length, 1)
  w.entries[0].nameSource = 'user'
  assert.ok(await w.lanes.open(A, { refuseUnnamed: true }))
})

test('a retry made before the late panel registers does not forget it', async () => {
  const w = world({ delays: [60, 1] })
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /timeout/)
  const second = await w.lanes.open(A, { refuseUnnamed: true })
  assert.equal(w.entries.find((e) => e.sessionId === second).name, 'auto-1')
  w.tick(20)
  w.entries.find((e) => e.sessionId === second).nameSource = 'user'
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /unnamed-panel/)
  assert.equal(w.entries.length, 2)
})

test('an ambiguous result still leaves its panels tracked as unnamed', async () => {
  const w = world({ extra: [{ onOpen: 0, after: 1, entry: { sessionId: 'f0000000-0000-4000-8000-000000000004', cwd: A, entrypoint: 'claude-vscode', name: 'x', nameSource: 'auto' } }] })
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /ambiguous/)
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /unnamed-panel/)
  assert.equal(w.entries.length, 2)
})

test('an unnamed panel stops blocking once it is older than the guard window', async () => {
  const w = world({ delays: [60], guardMs: 100 })
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /timeout/)
  w.tick(20)
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /unnamed-panel/)
  w.tick(200)
  assert.ok(await w.lanes.open(A, { refuseUnnamed: true }))
})

test('after opening, focus returns to the tab that was active, when it is still in the same column', async () => {
  const w = world({ tabs: { column: 1 } })
  await w.lanes.open(A)
  assert.deepEqual(w.focusCalls, [0])
})

test('focus follows the lead tab when opening a panel shifts the tab list, and is left alone when the tab is gone', async () => {
  const shifted = world({ tabs: { column: 1 } })
  const g = shifted.vscode.window.tabGroups.activeTabGroup.activeTab.group
  const run = shifted.vscode.commands.executeCommand
  shifted.vscode.commands.executeCommand = (c, ...a) => {
    if (c === 'claude-vscode.editor.open') g.tabs.unshift({ group: g })
    return run(c, ...a)
  }
  await shifted.lanes.open(A)
  assert.deepEqual(shifted.focusCalls, [1])
  const gone = world({ tabs: { column: 1 } })
  const g2 = gone.vscode.window.tabGroups.activeTabGroup.activeTab.group
  const run2 = gone.vscode.commands.executeCommand
  gone.vscode.commands.executeCommand = (c, ...a) => {
    if (c === 'claude-vscode.editor.open') g2.tabs.shift()
    return run2(c, ...a)
  }
  await gone.lanes.open(A)
  assert.deepEqual(gone.focusCalls, [])
  const relabel = (labels) => {
    const w = world({ tabs: { column: 1 } })
    const grp = w.vscode.window.tabGroups.activeTabGroup.activeTab.group
    grp.tabs[0].label = 'Lead'
    const run3 = w.vscode.commands.executeCommand
    w.vscode.commands.executeCommand = (c, ...a) => {
      if (c === 'claude-vscode.editor.open') grp.tabs.splice(0, grp.tabs.length, ...labels.map((label) => ({ group: grp, label })))
      return run3(c, ...a)
    }
    return w
  }
  const one = relabel(['Other', 'Lead'])
  await one.lanes.open(A)
  assert.deepEqual(one.focusCalls, [1])
  const twice = relabel(['Lead', 'Lead'])
  await twice.lanes.open(A)
  assert.deepEqual(twice.focusCalls, [])
})

test('focus is left alone when the active column changed, and a failing refocus does not fail the open', async () => {
  const moved = world({ tabs: { column: 1, activeColumn: 2 } })
  assert.ok(await moved.lanes.open(A))
  assert.deepEqual(moved.focusCalls, [])
  const broken = world({ tabs: { column: 1, failFocus: true } })
  assert.ok(await broken.lanes.open(A))
})

test('a failed open does not block the next one', async () => {
  const w = world({ delays: [1000, 1] })
  await assert.rejects(w.lanes.open(A), /timeout/)
  await w.lanes.open(A)
})

test('bad arguments are refused before any command runs', async () => {
  const w = world()
  await assert.rejects(w.lanes.open('relative'), /absolute/)
  await assert.rejects(w.lanes.reopen('nope'), /bad session id/)
  await assert.rejects(w.lanes.close('../x'), /bad session id/)
})

test('reopen is a no-op for a live panel and opens a closed one by sid', async () => {
  const w = world({ pids: true, alive: () => true })
  const s = await w.lanes.open(A)
  assert.equal(await w.lanes.reopen(s), s)
  assert.equal(world.opens(), 1)
  const closed = 'abcdef01-0000-4000-8000-00000000000a'
  assert.equal(await w.lanes.reopen(closed), closed)
  assert.equal(world.opens(), 2)
})

test('reopen takes a per-call timeoutMs', async () => {
  const w = world({ delays: [30], pids: true, alive: () => true })
  const closed = 'abcdef01-0000-4000-8000-00000000000b'
  await assert.rejects(w.lanes.reopen(closed, { timeoutMs: 5 }), /^Error: timeout/)
  const v = world({ delays: [30], pids: true, alive: () => true })
  assert.equal(await v.lanes.reopen(closed), closed)
})

test('reopen: a registry row of a dead pid for that sid is not taken as open, and the wait takes only a live panel with a new pid', async () => {
  const dead = new Set([4242])
  const w = world({ pids: true, alive: (pid) => !dead.has(pid) })
  const s = 'abcdef01-0000-4000-8000-00000000000c'
  w.entries.push({ sessionId: s, cwd: A, entrypoint: 'claude-vscode', name: 'LAB', nameSource: 'user', pid: 4242 })
  assert.equal(await w.lanes.reopen(s), s)
  assert.equal(world.opens(), 1)
  assert.ok(w.entries.some((e) => e.sessionId === s && e.pid === 5000))
  // A live panel row of that id returns at once, with no command run.
  const x = world({ pids: true, alive: () => true, delays: [1000] })
  x.entries.push({ sessionId: s, cwd: A, entrypoint: 'claude-vscode', name: 'LAB', nameSource: 'user', pid: 4242 })
  dead.clear()
  assert.equal(await x.lanes.reopen(s), s)
  assert.equal(world.opens(), 0)
})

test('reopen: a row of the old pid that reads alive later (its pid reused) is never taken for the reopened panel', async () => {
  let looks = 0
  const w = world({ pids: true, delays: [5], alive: (pid) => (pid === 4242 ? looks++ > 0 : true) })
  const s = 'abcdef01-0000-4000-8000-00000000000e'
  w.entries.push({ sessionId: s, cwd: A, entrypoint: 'claude-vscode', name: 'LAB', nameSource: 'user', pid: 4242 })
  assert.equal(await w.lanes.reopen(s), s)
  assert.ok(w.entries.some((e) => e.sessionId === s && e.pid === 5000))
})

test('reopen: a live pid whose start time is not the row\'s (the pid reused) is a dead row: the panel is opened, and a terminal row is not live-elsewhere', async () => {
  const s = 'abcdef01-0000-4000-8000-00000000000f'
  const w = world({ pids: true, alive: () => true, startOf: async (pid) => (pid === 4242 ? 'someone else' : `start-${pid}`) })
  w.entries.push({ sessionId: s, cwd: A, entrypoint: 'claude-vscode', name: 'LAB', nameSource: 'user', pid: 4242 })
  assert.equal(await w.lanes.reopen(s), s)
  assert.equal(world.opens(), 1)
  assert.ok(w.entries.some((e) => e.sessionId === s && e.pid === 5000))
  const t = world({ pids: true, alive: () => true, startOf: async (pid) => (pid === 4300 ? undefined : `start-${pid}`) })
  t.entries.push({ sessionId: s, cwd: A, entrypoint: 'cli', name: 'LAB', nameSource: 'user', pid: 4300 })
  assert.equal(await t.lanes.reopen(s), s)
  assert.equal(world.opens(), 1)
  const u = world({ pids: true, alive: () => true })
  u.entries.push({ sessionId: s, cwd: A, entrypoint: 'claude-vscode', name: 'LAB', nameSource: 'user', pid: 4242, procStart: '' })
  assert.equal(await u.lanes.reopen(s), s)
  assert.equal(world.opens(), 1)
})

test('reopen: a live row of that sid that is not a panel throws live-elsewhere and runs no command', async () => {
  const w = world({ pids: true, alive: () => true })
  const s = 'abcdef01-0000-4000-8000-00000000000d'
  w.entries.push({ sessionId: s, cwd: A, entrypoint: 'cli', name: 'LAB', nameSource: 'user', pid: 4300 })
  await assert.rejects(w.lanes.reopen(s), /^Error: live-elsewhere/)
  assert.equal(world.opens(), 0)
  const d = world({ pids: true, alive: (pid) => pid !== 4300 })
  d.entries.push({ sessionId: s, cwd: A, entrypoint: 'cli', name: 'LAB', nameSource: 'user', pid: 4300 })
  assert.equal(await d.lanes.reopen(s), s)
  assert.equal(world.opens(), 1)
})

test('close needs exactly one tab named for the panel', async () => {
  const w = world({ pids: true, alive: () => true })
  const s = await w.lanes.open(A)
  const closedTabs = []
  const tab = { label: w.entries[0].name, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } }
  w.vscode.window.tabGroups.all.push({ tabs: [tab] })
  w.vscode.window.tabGroups.close = async (t) => closedTabs.push(t)
  assert.equal(await w.lanes.close(s), s)
  assert.deepEqual(closedTabs, [tab])
  w.vscode.window.tabGroups.all[0].tabs.push({ label: tab.label, input: tab.input })
  await assert.rejects(w.lanes.close(s), /found 2/)
})

test('close ignores an editor tab that is not a Claude panel, and reserved names', async () => {
  const w = world({ pids: true, alive: () => true })
  const s = await w.lanes.open(A)
  w.vscode.window.tabGroups.all.push({ tabs: [{ label: w.entries[0].name, input: { viewType: 'default' } }] })
  await assert.rejects(w.lanes.close(s), /found 0/)
  w.entries[0].name = 'manager'
  await assert.rejects(w.lanes.close(s), /reserved/)
})

test('open refuses a folder that is not the first workspace folder of the window', async () => {
  const w = world()
  const lanes = createLanes({ vscode: w.vscode, registry: { list: async () => [] }, sleep: async () => {}, now: () => 0, workspaceFolders: () => [A] })
  await assert.rejects(lanes.open(B), /workspace folder/)
})

// A stopped lane's tab: only panels opened by the extension, only once the process is dead, only one matching Claude tab.

test('sweep closes the tab of an opened panel once its session is gone and its process is dead', async () => {
  let live = true
  const w = world({ alive: () => live })
  const s = await w.lanes.open(A)
  w.entries[0].pid = 4242
  w.entries[0].name = 'LABA'
  const tab = claudeTab('LABA')
  const closed = trackTabs(w, tab, claudeTab('lead'))
  await w.lanes.sweep()
  assert.deepEqual(closed, [])
  w.entries.length = 0
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'the process is still alive')
  live = false
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
  await w.lanes.sweep()
  assert.equal(closed.length, 1, 'closed once')
  assert.ok(s)
})

test('sweep never closes a panel it did not open, a reserved name, an ambiguous label or a non-Claude tab', async () => {
  // Each process is alive while its row is listed and dead once the row is gone.
  const dead = new Set()
  const w = world({ alive: (pid) => !dead.has(pid) })
  const gone = (pid) => { w.entries.length = 0; dead.add(pid) }
  const closed = trackTabs(w)
  w.entries.push({ sessionId: 'f0000000-0000-4000-8000-000000000009', cwd: A, entrypoint: 'claude-vscode', name: 'LABX', pid: 7 })
  w.vscode.window.tabGroups.all.push({ tabs: [claudeTab('LABX')] })
  await w.lanes.sweep()
  gone(7)
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'not opened by the extension')

  await w.lanes.open(A)
  w.entries[0].pid = 11
  w.entries[0].name = 'manager'
  w.vscode.window.tabGroups.all[0].tabs = [claudeTab('manager')]
  await w.lanes.sweep()
  gone(11)
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'reserved name')

  await w.lanes.open(A)
  w.entries[0].pid = 12
  w.entries[0].name = 'LABB'
  w.vscode.window.tabGroups.all[0].tabs = [claudeTab('LABB'), claudeTab('LABB')]
  await w.lanes.sweep()
  gone(12)
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'two tabs with the same label')

  await w.lanes.open(A)
  w.entries[0].pid = 13
  w.entries[0].name = 'LABC'
  w.vscode.window.tabGroups.all[0].tabs = [{ label: 'LABC', input: { viewType: 'default' } }]
  await w.lanes.sweep()
  gone(13)
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'not a Claude panel')
})

test('sweep keeps the tab when a live session already carries the name, and drops a record with no known pid without closing', async () => {
  const dead = new Set()
  const w = world({ alive: (pid) => !dead.has(pid) })
  const closed = trackTabs(w)
  await w.lanes.open(A)
  w.entries[0].pid = 21
  w.entries[0].name = 'LABA'
  w.vscode.window.tabGroups.all.push({ tabs: [claudeTab('LABA')] })
  await w.lanes.sweep()
  const gone = w.entries.shift()
  dead.add(21)
  w.entries.push({ sessionId: 'f0000000-0000-4000-8000-0000000000aa', cwd: A, entrypoint: 'claude-vscode', name: 'LABA', pid: 22 })
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'a new live LABA holds the name')
  assert.ok(gone)

  const w2 = world({ alive: () => false })
  const closed2 = trackTabs(w2)
  await w2.lanes.open(A)
  w2.entries[0].name = 'LABD'
  w2.vscode.window.tabGroups.all.push({ tabs: [claudeTab('LABD')] })
  await w2.lanes.sweep()
  w2.entries.length = 0
  await w2.lanes.sweep()
  assert.deepEqual(closed2, [], 'no pid recorded: never taken for dead')
})

test('sweep survives a close that rejects and closes the tab it saw', async () => {
  let live = true
  const w = world({ alive: () => live })
  await w.lanes.open(A)
  w.entries[0].pid = 31
  w.entries[0].name = 'LABE'
  const tab = claudeTab('LABE')
  w.vscode.window.tabGroups.all.push({ tabs: [tab] })
  let tried
  w.vscode.window.tabGroups.close = (t) => { tried = t; return Promise.reject(new Error('no')) }
  await w.lanes.sweep()
  w.entries.length = 0
  live = false
  await w.lanes.sweep()
  assert.equal(tried, tab)
})

test('sweep closes nothing when the registry read was incomplete, and closes once the read is whole again', async () => {
  let live = true
  const w = world({ alive: () => live })
  const closed = trackTabs(w)
  await w.lanes.open(A)
  w.entries[0].pid = 41
  w.entries[0].name = 'LABF'
  const tab = claudeTab('LABF')
  w.vscode.window.tabGroups.all.push({ tabs: [tab] })
  await w.lanes.sweep()
  w.entries.length = 0
  live = false
  const list = w.registry.list
  w.registry.list = async function () { return Object.defineProperty(await list.call(this), 'complete', { value: false }) }
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'incomplete read')
  w.registry.list = list
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
})

test('an open reads the registry again when a read was incomplete, and fails without opening after three', async () => {
  const w = world()
  const list = w.registry.list
  let bad = 2
  w.registry.list = async function () {
    const r = await list.call(this)
    return bad-- > 0 ? Object.defineProperty(r, 'complete', { value: false }) : r
  }
  assert.match(await w.lanes.open(A), /^[0-9a-f]{8}-/)
  assert.equal(world.opens(), 1, 'opened once, after two incomplete reads')
  bad = 3
  await assert.rejects(w.lanes.open(A), /^Error: registry-incomplete/)
  assert.equal(world.opens(), 1, 'nothing opened on three incomplete reads')
  w.registry.list = list
  assert.match(await w.lanes.open(A), /^[0-9a-f]{8}-/)
})

test('a reopen fails without opening when three registry reads in a row are incomplete', async () => {
  const w = world({ pids: true, alive: () => true })
  const list = w.registry.list
  w.registry.list = async function () { return Object.defineProperty(await list.call(this), 'complete', { value: false }) }
  const closed = 'abcdef01-0000-4000-8000-00000000000c'
  await assert.rejects(w.lanes.reopen(closed), /^Error: registry-incomplete/)
  assert.equal(world.opens(), 0)
  w.registry.list = list
  assert.equal(await w.lanes.reopen(closed), closed)
})

test('an open command that never returns times out, and later opens still run', async () => {
  const w = world()
  const exec = w.vscode.commands.executeCommand
  let hang = true
  w.vscode.commands.executeCommand = function (cmd, ...rest) {
    if (cmd === 'claude-vscode.editor.open' && hang) return new Promise(() => {})
    return exec.call(this, cmd, ...rest)
  }
  await assert.rejects(w.lanes.open(A), /^Error: timeout: the open command did not return/)
  hang = false
  assert.match(await w.lanes.open(A), /^[0-9a-f]{8}-/, 'the serial chain is free again')
})

test('one time limit covers the open command and the wait', async () => {
  const w = world({ delays: [5] })
  const exec = w.vscode.commands.executeCommand
  w.vscode.commands.executeCommand = async function (cmd, ...rest) {
    if (cmd === 'claude-vscode.editor.open') w.tick(46)
    return exec.call(this, cmd, ...rest)
  }
  await assert.rejects(w.lanes.open(A), /^Error: timeout: no new panel registered/, 'the panel comes up at 51, after the limit of 50')
})

test('a wait left with no time still reads the registry once', async () => {
  const w = world({ delays: [0] })
  const list = w.registry.list
  let first = true
  w.registry.list = async function () {
    if (first) { first = false; w.tick(60) }
    return list.call(this)
  }
  assert.match(await w.lanes.open(A), /^[0-9a-f]{8}-/, 'the panel is there on the one read past the limit')
})

test('a focus command that never returns does not hold the open', async () => {
  const w = world({ tabs: { column: 1 } })
  const exec = w.vscode.commands.executeCommand
  w.vscode.commands.executeCommand = function (cmd, ...rest) {
    if (cmd === 'workbench.action.openEditorAtIndex') return new Promise(() => {})
    return exec.call(this, cmd, ...rest)
  }
  assert.match(await w.lanes.open(A), /^[0-9a-f]{8}-/)
  assert.match(await w.lanes.open(A), /^[0-9a-f]{8}-/, 'the chain is free for the next open')
})

test('a reopen whose open command never returns times out', async () => {
  const w = world({ pids: true, alive: () => false })
  w.vscode.commands.executeCommand = (cmd) => (cmd === 'claude-vscode.editor.open' ? new Promise(() => {}) : undefined)
  await assert.rejects(w.lanes.reopen('a0000000-0000-4000-8000-00000000000b'), /^Error: timeout: the open command did not return/)
})

const VALID_SID = 'a0000000-0000-4000-8000-00000000000a'

test('adopt gives the sweep a panel it did not open: its tab closes once the pid is dead and no live session carries the name', async () => {
  let live = true
  const w = world({ alive: () => live })
  const tab = claudeTab('ATT')
  const closed = trackTabs(w, tab, claudeTab('lead'))
  assert.equal(w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 }), true)
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'the process is still alive')
  live = false
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
  await w.lanes.sweep()
  assert.equal(closed.length, 1, 'closed once')
})

test('an adopted panel keeps its tab while a live session carries the name, or while its registry entry is still there', async () => {
  const dead = new Set([4242])
  const w = world({ alive: (pid) => !dead.has(pid) })
  const tab = claudeTab('ATT')
  const closed = trackTabs(w, tab)
  w.entries.push({ sessionId: 'b0000000-0000-4000-8000-00000000000b', cwd: A, entrypoint: 'claude-vscode', name: 'ATT', pid: 4300 })
  w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'a new session carries the name')
  assert.equal(w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 }), true, 'the record was dropped with the check; a new request adopts again')
  w.entries.length = 0
  w.entries.push({ sessionId: VALID_SID, cwd: A, entrypoint: 'claude-vscode', name: 'ATT', pid: 4242 })
  dead.delete(4242)
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'the entry is still in the registry')
  w.entries.length = 0
  dead.add(4242)
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
})

test('adopt ignores a bad session id, pid or name, a reserved name, and more than 64 panels; the sweep closes nothing for them', async () => {
  const w = world({ alive: () => false })
  const closed = trackTabs(w, claudeTab('manager'), claudeTab('ATT'))
  for (const [id, r] of [['nope', { name: 'ATT', pid: 4242 }], [VALID_SID, { name: 'ATT', pid: 1 }], [VALID_SID, { name: 'ATT', pid: 12.5 }], [VALID_SID, { name: 'ATT', pid: '4242' }], [VALID_SID, { name: 'manager', pid: 4242 }], [VALID_SID, { name: 'a b', pid: 4242 }], [VALID_SID, {}], [VALID_SID, undefined]]) {
    assert.equal(w.lanes.adopt(id, r), false, JSON.stringify([id, r]))
  }
  await w.lanes.sweep()
  assert.deepEqual(closed, [])
  let ok = 0
  for (let i = 0; i < 70; i++) if (w.lanes.adopt(`c${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, { name: 'ATT', pid: 5000 + i })) ok++
  assert.equal(ok, 64)
})

test('an adopted panel with two tabs of that label, or a tab that is not a Claude panel, is left open', async () => {
  const w = world({ alive: () => false })
  const closed = trackTabs(w)
  w.vscode.window.tabGroups.all.push({ tabs: [claudeTab('ATT'), claudeTab('ATT')] })
  w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  await w.lanes.sweep()
  assert.deepEqual(closed, [])
  w.vscode.window.tabGroups.all[0].tabs = [{ label: 'BBB', input: { viewType: 'default' } }]
  w.lanes.adopt('d0000000-0000-4000-8000-00000000000d', { name: 'BBB', pid: 4243 })
  await w.lanes.sweep()
  assert.deepEqual(closed, [])
})

test('adopt caps the pid at 2^22', async () => {
  const w = world({ alive: () => false })
  assert.equal(w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 2 ** 22 }), true)
  assert.equal(w.lanes.adopt('e0000000-0000-4000-8000-00000000000e', { name: 'ATT', pid: 2 ** 22 + 1 }), false)
  assert.equal(w.lanes.adopt('e0000000-0000-4000-8000-00000000000e', { name: 'ATT', pid: 99999999999 }), false)
})

test('an adopted panel whose process is still alive and that no registry entry ever showed is dropped after five minutes; a dead pid before that still closes', async () => {
  let live = true
  const w = world({ alive: () => live })
  const tab = claudeTab('ATT')
  const closed = trackTabs(w, tab)
  w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  w.tick(4 * 60_000)
  await w.lanes.sweep()
  assert.deepEqual(closed, [])
  w.tick(2 * 60_000)
  await w.lanes.sweep()
  live = false
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'the request expired while the process lived; a dead pid later closes nothing')
  live = true
  w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  w.tick(60_000)
  live = false
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
})

test('an adopted panel that the registry shows is tracked like one the extension opened: it does not expire while its entry is there', async () => {
  let live = true
  const w = world({ alive: () => live })
  const tab = claudeTab('ATT')
  const closed = trackTabs(w, tab)
  w.entries.push({ sessionId: VALID_SID, cwd: A, entrypoint: 'claude-vscode', name: 'ATT', pid: 4242 })
  w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  await w.lanes.sweep()
  w.tick(30 * 60_000)
  w.entries.length = 0
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'alive, no entry, but it was seen: kept')
  live = false
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
})

// The registry keeps the rows of dead processes: a row counts for the sweep only while its pid is alive and `ps` agrees with its procStart.
test('sweep: a stale row with the sid (its pid dead) no longer keeps the entry: the tab closes once the recorded pid is dead', async () => {
  const dead = new Set()
  const w = world({ alive: (pid) => !dead.has(pid) })
  const tab = claudeTab('LABS')
  const closed = trackTabs(w, tab)
  await w.lanes.open(A)
  w.entries[0].pid = 4242
  w.entries[0].name = 'LABS'
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'live')
  dead.add(4242)
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab], 'the row is still listed, but its process is dead')
  assert.equal(w.entries.length, 1)
  // An adopted panel whose stale row stays listed is closed too, and its record does not linger.
  const v = world({ alive: () => false })
  const vtab = claudeTab('ATT')
  const vclosed = trackTabs(v, vtab)
  v.entries.push({ sessionId: VALID_SID, cwd: A, entrypoint: 'claude-vscode', name: 'ATT', pid: 4242 })
  v.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  await v.lanes.sweep()
  assert.deepEqual(vclosed, [vtab])
})

test('sweep: a stale row with the lane\'s name (its pid dead) no longer blocks the close', async () => {
  const w = world({ alive: () => false })
  const tab = claudeTab('ATT')
  const closed = trackTabs(w, tab)
  w.entries.push({ sessionId: 'b0000000-0000-4000-8000-0000000000b1', cwd: A, entrypoint: 'claude-vscode', name: 'ATT', pid: 4300 })
  w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
})

test('sweep: a row with the lane\'s name whose pid is alive but whose procStart differs counts as dead; a failed ps or a missing procStart blocks the close', async () => {
  const TAB = 'closes'
  for (const [row, startOf, want] of [
    [{ pid: 4300 }, async (pid) => (pid === 4300 ? 'someone else' : `start-${pid}`), TAB],
    [{ pid: 4300, procStart: '' }, undefined, 'kept'],
    [{ pid: 4300 }, async (pid) => (pid === 4300 ? undefined : `start-${pid}`), 'kept'],
  ]) {
    const w = world({ alive: (pid) => pid !== 4242, startOf })
    const tab = claudeTab('ATT')
    const closed = trackTabs(w, tab)
    w.entries.push({ sessionId: 'b0000000-0000-4000-8000-0000000000b2', cwd: A, entrypoint: 'claude-vscode', name: 'ATT', ...row })
    w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
    await w.lanes.sweep()
    assert.deepEqual(closed, want === TAB ? [tab] : [], JSON.stringify(row))
  }
})

test('sweep: the recorded pid, reused by another process (alive, another start time), is dead: the tab closes; a failed ps keeps it', async () => {
  let start4242 = 'start-4242'
  const w = world({ alive: () => true, startOf: async (pid) => (pid === 4242 ? start4242 : `start-${pid}`) })
  const tab = claudeTab('LABR')
  const closed = trackTabs(w, tab)
  await w.lanes.open(A)
  w.entries[0].pid = 4242
  w.entries[0].name = 'LABR'
  await w.lanes.sweep()
  w.entries.length = 0
  start4242 = undefined
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'ps failed: not proven dead')
  start4242 = 'someone else'
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab], 'the pid now belongs to another process')
})

test('sweep: asks ps about a pid once per sweep, for the recorded process and for a row that carries the name', async () => {
  const asked = []
  let reused = false
  const w = world({ alive: () => true, startOf: async (pid) => (asked.push(pid), pid === 4242 && reused ? 'someone else' : `start-${pid}`) })
  const tab = claudeTab('LABQ')
  const closed = trackTabs(w, tab)
  await w.lanes.open(A)
  w.entries[0].pid = 4242
  w.entries[0].name = 'LABQ'
  await w.lanes.sweep()
  w.entries.length = 0
  w.entries.push({ sessionId: VALID_SID, cwd: A, entrypoint: 'claude-vscode', name: 'LABQ', pid: 4242, procStart: 'someone else' })
  reused = true
  asked.length = 0
  await w.lanes.sweep()
  assert.deepEqual(asked, [4242], 'one ps for the pid, though the record and the named row both need it')
  assert.deepEqual(closed, [], 'the named row is live, so the tab stays')
  asked.length = 0
  await w.lanes.sweep()
  assert.equal(asked.length, 0, 'nothing is left to judge: the record was dropped, and no sweep keeps an answer')
})

test('sweep: a row of the sid whose check fails (ps failed) keeps the tab even when the recorded pid is dead, until its own pid is dead', async () => {
  const dead = new Set([4242])
  const w = world({ alive: (pid) => !dead.has(pid), startOf: async (pid) => (pid === 4243 ? undefined : `start-${pid}`) })
  const tab = claudeTab('LABM')
  const closed = trackTabs(w, tab)
  w.entries.push({ sessionId: VALID_SID, cwd: A, entrypoint: 'claude-vscode', name: 'LABM', pid: 4243 })
  w.lanes.adopt(VALID_SID, { name: 'LABM', pid: 4242 })
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'a maybe-live process of that sid')
  w.entries.length = 0
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'the noted process is still maybe-live')
  dead.add(4243)
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
})

test('sweep: a live row still keeps the tab open, and a live row with the lane\'s name still blocks the close', async () => {
  const w = world({ alive: () => true })
  const tab = claudeTab('LABL')
  const closed = trackTabs(w, tab)
  await w.lanes.open(A)
  w.entries[0].pid = 4242
  w.entries[0].name = 'LABL'
  for (let i = 0; i < 3; i++) await w.lanes.sweep()
  w.tick(60 * 60_000)
  await w.lanes.sweep()
  assert.deepEqual(closed, [])
  const v = world({ alive: (pid) => pid !== 4242 })
  const vtab = claudeTab('ATT')
  const vclosed = trackTabs(v, vtab)
  v.entries.push({ sessionId: 'b0000000-0000-4000-8000-0000000000b3', cwd: A, entrypoint: 'claude-vscode', name: 'ATT', pid: 4300 })
  v.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  await v.lanes.sweep()
  assert.deepEqual(vclosed, [], 'a live session carries the name')
})

test('close uses only a live row: a stale row whose old name is now another live session\'s tab closes nothing, nor does a row whose check fails', async () => {
  const s = 'abcdef01-0000-4000-8000-0000000000c1'
  for (const [alive, startOf] of [[(pid) => pid !== 4242, undefined], [() => true, async (pid) => (pid === 4242 ? undefined : `start-${pid}`)]]) {
    const w = world({ alive, startOf })
    const closed = trackTabs(w)
    w.entries.push({ sessionId: s, cwd: A, entrypoint: 'claude-vscode', name: 'LABO', nameSource: 'user', pid: 4242 })
    w.entries.push({ sessionId: 'abcdef01-0000-4000-8000-0000000000c2', cwd: A, entrypoint: 'claude-vscode', name: 'LABO', nameSource: 'user', pid: 4300 })
    w.vscode.window.tabGroups.all.push({ tabs: [claudeTab('LABO')] })
    await assert.rejects(w.lanes.close(s), /no such open panel/)
    assert.deepEqual(closed, [])
  }
})

test('sweep: a panel only ever seen as maybe-live (ps failing) is noted, and its tab closes once its pid is dead', async () => {
  let live = true
  const w = world({ alive: () => live, startOf: async (pid) => (pid === 4242 ? undefined : `start-${pid}`) })
  const tab = claudeTab('LABQ')
  const closed = trackTabs(w, tab)
  await w.lanes.open(A)
  w.entries[0].pid = 4242
  w.entries[0].name = 'LABQ'
  await w.lanes.sweep()
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'maybe-live: kept')
  w.entries.length = 0
  live = false
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
})

test('sweeps do not overlap: a call while one runs returns that sweep, and the tab is closed once', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const w = world({ alive: (pid) => pid !== 4242, startOf: async (pid) => { await gate; return `start-${pid}` } })
  const tab = claudeTab('ATT')
  const closed = trackTabs(w, tab)
  w.entries.push({ sessionId: 'b0000000-0000-4000-8000-0000000000b4', cwd: A, entrypoint: 'claude-vscode', name: 'ATT', pid: 4300, procStart: 'stale' })
  w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  const a = w.lanes.sweep()
  const b = w.lanes.sweep()
  assert.equal(a, b)
  release()
  await Promise.all([a, b])
  assert.deepEqual(closed, [tab])
  assert.notEqual(w.lanes.sweep(), a, 'a later call starts a new sweep')
})

test('after a reopen, focus returns to the tab that was active', async () => {
  const w = world({ tabs: { column: 1 }, pids: true, alive: () => true })
  const closed = sid()
  assert.equal(await w.lanes.reopen(closed), closed)
  assert.deepEqual(w.focusCalls, [0])
})
