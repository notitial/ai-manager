'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createLanes } = require('./lanes.js')

const A = '/w/a'
const B = '/w/b'
let n = 0
const sid = () => `${String(++n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`

// Fake VS Code + registry. Each editor.open registers a panel after `delay` ticks.
// A new panel gets a generated name (nameSource auto), as in the real registry; renaming it sets nameSource to user.
// `tabs`: { column, activeColumn, failFocus } gives the fake an active tab at index 0, to test switching back to it.
function world({ delays = [], extra = [], tabs, guardMs, alive, pids = false, startOf } = {}) {
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
        const cwdOf = world.nextCwd
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
  return { lanes, entries, vscode, registry, focusCalls, tick: (n) => { t += n } }
}

test('several panels opened one after another each get their own sid', async () => {
  const w = world()
  const got = []
  for (const cwd of [A, A, B, A]) { world.nextCwd = cwd; got.push(await w.lanes.open(cwd)) }
  assert.equal(new Set(got).size, 4)
  assert.deepEqual(got, w.entries.map((e) => e.sessionId))
})

test('concurrent opens are serialised and still get distinct sids', async () => {
  const w = world({ delays: [10, 1, 5] })
  world.nextCwd = A
  const got = await Promise.all([w.lanes.open(A), w.lanes.open(A), w.lanes.open(A)])
  assert.equal(new Set(got).size, 3)
  assert.deepEqual(got, w.entries.map((e) => e.sessionId))
})

test('a panel opened by someone else in another folder is ignored', async () => {
  const w = world({ extra: [{ onOpen: 0, after: 0, entry: { sessionId: 'f0000000-0000-4000-8000-000000000001', cwd: B, entrypoint: 'claude-vscode', name: 'x' } }] })
  world.nextCwd = A
  const s = await w.lanes.open(A)
  assert.notEqual(s, 'f0000000-0000-4000-8000-000000000001')
})

test('a terminal session in the same folder is ignored', async () => {
  const w = world({ extra: [{ onOpen: 0, after: 0, entry: { sessionId: 'f0000000-0000-4000-8000-000000000002', cwd: A, entrypoint: 'cli', name: 'x' } }] })
  world.nextCwd = A
  const s = await w.lanes.open(A)
  assert.notEqual(s, 'f0000000-0000-4000-8000-000000000002')
})

test('a foreign panel in the same folder at the same moment is ambiguous, never guessed', async () => {
  const w = world({ extra: [{ onOpen: 0, after: 1, entry: { sessionId: 'f0000000-0000-4000-8000-000000000003', cwd: A, entrypoint: 'claude-vscode', name: 'x' } }] })
  world.nextCwd = A
  await assert.rejects(w.lanes.open(A), /ambiguous/)
})

test('timeout when no panel registers', async () => {
  const w = world({ delays: [1000] })
  world.nextCwd = A
  await assert.rejects(w.lanes.open(A), /timeout/)
})

test('a shorter timeoutMs per call gives up sooner than the default', async () => {
  const w = world({ delays: [30] })
  world.nextCwd = A
  await assert.rejects(w.lanes.open(A, { timeoutMs: 10 }), /timeout/)
})

test('refuseUnnamed blocks the next open while a panel this extension opened is unnamed, until it is named', async () => {
  const w = world()
  world.nextCwd = A
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
  world.nextCwd = A
  assert.ok(await w.lanes.open(A, { refuseUnnamed: true }))
})

test('a panel that registers after a timeout still blocks the retry until it is named', async () => {
  const w = world({ delays: [60] })
  world.nextCwd = A
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /timeout/)
  w.tick(20)
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /unnamed-panel/)
  assert.equal(w.entries.length, 1)
  w.entries[0].nameSource = 'user'
  assert.ok(await w.lanes.open(A, { refuseUnnamed: true }))
})

test('a retry made before the late panel registers does not forget it', async () => {
  const w = world({ delays: [60, 1] })
  world.nextCwd = A
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
  world.nextCwd = A
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /ambiguous/)
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /unnamed-panel/)
  assert.equal(w.entries.length, 2)
})

test('an unnamed panel stops blocking once it is older than the guard window', async () => {
  const w = world({ delays: [60], guardMs: 100 })
  world.nextCwd = A
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /timeout/)
  w.tick(20)
  await assert.rejects(w.lanes.open(A, { refuseUnnamed: true }), /unnamed-panel/)
  w.tick(200)
  assert.ok(await w.lanes.open(A, { refuseUnnamed: true }))
})

test('after opening, focus returns to the tab that was active, when it is still in the same column', async () => {
  const w = world({ tabs: { column: 1 } })
  world.nextCwd = A
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
  world.nextCwd = A
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
  world.nextCwd = A
  assert.ok(await moved.lanes.open(A))
  assert.deepEqual(moved.focusCalls, [])
  const broken = world({ tabs: { column: 1, failFocus: true } })
  assert.ok(await broken.lanes.open(A))
})

test('a failed open does not block the next one', async () => {
  const w = world({ delays: [1000, 1] })
  world.nextCwd = A
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
  world.nextCwd = A
  const s = await w.lanes.open(A)
  assert.equal(await w.lanes.reopen(s), s)
  assert.equal(world.opens(), 1)
  const closed = 'abcdef01-0000-4000-8000-00000000000a'
  assert.equal(await w.lanes.reopen(closed), closed)
  assert.equal(world.opens(), 2)
})

test('reopen takes a per-call timeoutMs', async () => {
  const w = world({ delays: [30], pids: true, alive: () => true })
  world.nextCwd = A
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
  const w = world()
  world.nextCwd = A
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
  const w = world()
  world.nextCwd = A
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
const CLAUDE_VIEW = 'mainThreadWebview-claudeVSCodePanel'

test('sweep closes the tab of an opened panel once its session is gone and its process is dead', async () => {
  let live = true
  const w = world({ alive: () => live })
  world.nextCwd = A
  const s = await w.lanes.open(A)
  w.entries[0].pid = 4242
  w.entries[0].name = 'LABA'
  const tab = { label: 'LABA', input: { viewType: CLAUDE_VIEW } }
  const closed = []
  w.vscode.window.tabGroups.all.push({ tabs: [tab, { label: 'lead', input: { viewType: CLAUDE_VIEW } }] })
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
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
  const w = world({ alive: () => false })
  const closed = []
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
  w.entries.push({ sessionId: 'f0000000-0000-4000-8000-000000000009', cwd: A, entrypoint: 'claude-vscode', name: 'LABX', pid: 7 })
  w.vscode.window.tabGroups.all.push({ tabs: [{ label: 'LABX', input: { viewType: CLAUDE_VIEW } }] })
  await w.lanes.sweep()
  w.entries.length = 0
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'not opened by the extension')

  world.nextCwd = A
  await w.lanes.open(A)
  w.entries[0].pid = 11
  w.entries[0].name = 'manager'
  w.vscode.window.tabGroups.all[0].tabs = [{ label: 'manager', input: { viewType: CLAUDE_VIEW } }]
  await w.lanes.sweep()
  w.entries.length = 0
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'reserved name')

  await w.lanes.open(A)
  w.entries[0].pid = 12
  w.entries[0].name = 'LABB'
  w.vscode.window.tabGroups.all[0].tabs = [{ label: 'LABB', input: { viewType: CLAUDE_VIEW } }, { label: 'LABB', input: { viewType: CLAUDE_VIEW } }]
  await w.lanes.sweep()
  w.entries.length = 0
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'two tabs with the same label')

  await w.lanes.open(A)
  w.entries[0].pid = 13
  w.entries[0].name = 'LABC'
  w.vscode.window.tabGroups.all[0].tabs = [{ label: 'LABC', input: { viewType: 'default' } }]
  await w.lanes.sweep()
  w.entries.length = 0
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'not a Claude panel')
})

test('sweep keeps the tab when a live session already carries the name, and drops a record with no known pid without closing', async () => {
  const w = world({ alive: () => false })
  const closed = []
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
  world.nextCwd = A
  await w.lanes.open(A)
  w.entries[0].pid = 21
  w.entries[0].name = 'LABA'
  w.vscode.window.tabGroups.all.push({ tabs: [{ label: 'LABA', input: { viewType: CLAUDE_VIEW } }] })
  await w.lanes.sweep()
  const gone = w.entries.shift()
  w.entries.push({ sessionId: 'f0000000-0000-4000-8000-0000000000aa', cwd: A, entrypoint: 'claude-vscode', name: 'LABA', pid: 22 })
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'a new live LABA holds the name')
  assert.ok(gone)

  const w2 = world({ alive: () => false })
  const closed2 = []
  w2.vscode.window.tabGroups.close = async (t) => closed2.push(t)
  world.nextCwd = A
  await w2.lanes.open(A)
  w2.entries[0].name = 'LABD'
  w2.vscode.window.tabGroups.all.push({ tabs: [{ label: 'LABD', input: { viewType: CLAUDE_VIEW } }] })
  await w2.lanes.sweep()
  w2.entries.length = 0
  await w2.lanes.sweep()
  assert.deepEqual(closed2, [], 'no pid recorded: never taken for dead')
})

test('sweep survives a close that rejects and closes the tab it saw', async () => {
  const w = world({ alive: () => false })
  world.nextCwd = A
  await w.lanes.open(A)
  w.entries[0].pid = 31
  w.entries[0].name = 'LABE'
  const tab = { label: 'LABE', input: { viewType: CLAUDE_VIEW } }
  w.vscode.window.tabGroups.all.push({ tabs: [tab] })
  let tried
  w.vscode.window.tabGroups.close = (t) => { tried = t; return Promise.reject(new Error('no')) }
  await w.lanes.sweep()
  w.entries.length = 0
  await w.lanes.sweep()
  assert.equal(tried, tab)
})

test('sweep closes nothing when the registry read was incomplete, and closes once the read is whole again', async () => {
  const w = world({ alive: () => false })
  const closed = []
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
  world.nextCwd = A
  await w.lanes.open(A)
  w.entries[0].pid = 41
  w.entries[0].name = 'LABF'
  const tab = { label: 'LABF', input: { viewType: CLAUDE_VIEW } }
  w.vscode.window.tabGroups.all.push({ tabs: [tab] })
  await w.lanes.sweep()
  w.entries.length = 0
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
  world.nextCwd = A
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
  world.nextCwd = A
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
  world.nextCwd = A
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
  world.nextCwd = A
  const exec = w.vscode.commands.executeCommand
  w.vscode.commands.executeCommand = async function (cmd, ...rest) {
    if (cmd === 'claude-vscode.editor.open') w.tick(46)
    return exec.call(this, cmd, ...rest)
  }
  await assert.rejects(w.lanes.open(A), /^Error: timeout: no new panel registered/, 'the panel comes up at 51, after the limit of 50')
})

test('a wait left with no time still reads the registry once', async () => {
  const w = world({ delays: [0] })
  world.nextCwd = A
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
  world.nextCwd = A
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
  world.nextCwd = A
  w.vscode.commands.executeCommand = (cmd) => (cmd === 'claude-vscode.editor.open' ? new Promise(() => {}) : undefined)
  await assert.rejects(w.lanes.reopen('a0000000-0000-4000-8000-00000000000b'), /^Error: timeout: the open command did not return/)
})

const VALID_SID = 'a0000000-0000-4000-8000-00000000000a'

test('adopt gives the sweep a panel it did not open: its tab closes once the pid is dead and no live session carries the name', async () => {
  let live = true
  const w = world({ alive: () => live })
  const tab = { label: 'ATT', input: { viewType: CLAUDE_VIEW } }
  const closed = []
  w.vscode.window.tabGroups.all.push({ tabs: [tab, { label: 'lead', input: { viewType: CLAUDE_VIEW } }] })
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
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
  const w = world({ alive: () => false })
  const tab = { label: 'ATT', input: { viewType: CLAUDE_VIEW } }
  const closed = []
  w.vscode.window.tabGroups.all.push({ tabs: [tab] })
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
  w.entries.push({ sessionId: 'b0000000-0000-4000-8000-00000000000b', cwd: A, entrypoint: 'claude-vscode', name: 'ATT', pid: 4300 })
  w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 })
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'a new session carries the name')
  assert.equal(w.lanes.adopt(VALID_SID, { name: 'ATT', pid: 4242 }), true, 'the record was dropped with the check; a new request adopts again')
  w.entries.length = 0
  w.entries.push({ sessionId: VALID_SID, cwd: A, entrypoint: 'claude-vscode', name: 'ATT', pid: 4242 })
  await w.lanes.sweep()
  assert.deepEqual(closed, [], 'the entry is still in the registry')
  w.entries.length = 0
  await w.lanes.sweep()
  assert.deepEqual(closed, [tab])
})

test('adopt ignores a bad session id, pid or name, a reserved name, and more than 64 panels; the sweep closes nothing for them', async () => {
  const w = world({ alive: () => false })
  const closed = []
  w.vscode.window.tabGroups.all.push({ tabs: [{ label: 'manager', input: { viewType: CLAUDE_VIEW } }, { label: 'ATT', input: { viewType: CLAUDE_VIEW } }] })
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
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
  const closed = []
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
  w.vscode.window.tabGroups.all.push({ tabs: [{ label: 'ATT', input: { viewType: CLAUDE_VIEW } }, { label: 'ATT', input: { viewType: CLAUDE_VIEW } }] })
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
  const tab = { label: 'ATT', input: { viewType: CLAUDE_VIEW } }
  const closed = []
  w.vscode.window.tabGroups.all.push({ tabs: [tab] })
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
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
  const tab = { label: 'ATT', input: { viewType: CLAUDE_VIEW } }
  const closed = []
  w.vscode.window.tabGroups.all.push({ tabs: [tab] })
  w.vscode.window.tabGroups.close = async (t) => closed.push(t)
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

test('after a reopen, focus returns to the tab that was active', async () => {
  const w = world({ tabs: { column: 1 }, pids: true, alive: () => true })
  world.nextCwd = A
  const closed = sid()
  assert.equal(await w.lanes.reopen(closed), closed)
  assert.deepEqual(w.focusCalls, [0])
})
