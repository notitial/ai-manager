'use strict'
const vscode = require('vscode')
const os = require('node:os')
const path = require('node:path')
const { createLanes } = require('./lanes.js')
const { createSpool, allLanes } = require('./spool.js')
const { createRegistry } = require('./registry.js')

const SESSIONS = path.join(os.homedir(), '.claude', 'sessions')

const registry = createRegistry(SESSIONS)

// Shorter than the lead's 8 s wait for lane_open, which also covers the spool's 1 s scan and the lead's 0.5 s poll.
const SPOOL_OPEN_MS = 5000

// claude-vscode.editor.open opens the panel in the window's first folder, so a lane is only this window's when its folder is that one.
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !!err && err.code === 'EPERM'
  }
}

const primaryFolder = () => (vscode.workspace.workspaceFolders || []).slice(0, 1).map((f) => f.uri.fsPath)

function activate(context) {
  const lanes = createLanes({ vscode, registry, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now,
    workspaceFolders: primaryFolder,
  })
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  reg('callboard.open', (folder) => lanes.open(folder))
  reg('callboard.reopen', (sid) => lanes.reopen(sid))
  reg('callboard.close', (sid) => lanes.close(sid))
  const spool = createSpool({
    dir: path.join(os.homedir(), '.claude', 'callboard', 'open'),
    loadLanes: () => allLanes({ rootFile: '/usr/local/libexec/callboard/lanes.json', storeDir: path.join(os.homedir(), '.claude', 'callboard', 'lanes') }),
    openLane: (folder) => lanes.open(folder, { timeoutMs: SPOOL_OPEN_MS, refuseUnnamed: true }),
    closeLane: ({ sid, pid, name }) => lanes.adopt(sid, { name, pid }),
    reopenLane: (sid) => lanes.reopen(sid, { timeoutMs: SPOOL_OPEN_MS }),
    workspaceFolders: primaryFolder,
    liveInRepo: async (repo) =>
      (await registry.list()).filter((x) => x && typeof x.cwd === 'string' && (x.cwd === repo || x.cwd.startsWith(`${repo}/`)) && (!Number.isInteger(x.pid) || pidAlive(x.pid))).length,
  })
  context.subscriptions.push(spool.start())
  const sweep = setInterval(() => lanes.sweep().catch(() => undefined), 2000)
  context.subscriptions.push({ dispose: () => clearInterval(sweep) })
}

module.exports = { activate, deactivate() {} }
