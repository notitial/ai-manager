'use strict'
// The session registry (~/.claude/sessions/<pid>.json) as the extension reads it. Kept apart from extension.js, which needs VS Code, so it can be tested.
const fs = require('node:fs')
const path = require('node:path')

// One registry file, read the way the mod reads it (registryEntriesWhy in the mod's engine/store.ts). The answer is { state: 'ok', j } with the parsed row, or 'gone' (deleted
// since the listing), 'bad' (never an entry: a folder, a file this user cannot read, or text that does not parse and read the same both times) or 'unsure'.
// A file that cannot be read or does not parse is read once more after a short pause, since the engine rewrites these files while it runs; only a file still
// changing, or one that fails both reads, is 'unsure' and makes the whole read untrustworthy.
const PAUSE_MS = 50
async function readEntry(file, pause = () => new Promise((r) => setTimeout(r, PAUSE_MS))) {
  let last
  for (let i = 0; i < 2; i++) {
    if (i > 0) await pause()
    let text
    try {
      text = await fs.promises.readFile(file, 'utf8')
    } catch (err) {
      const code = err && err.code
      if (code === 'ENOENT') return { state: 'gone' }
      // Not a plain file of ours (a folder, or one this user may not read): never an entry, as the mod's read refuses those too.
      if (code === 'EISDIR' || code === 'EACCES' || code === 'EPERM') return { state: 'bad' }
      last = undefined
      continue
    }
    try {
      return { state: 'ok', j: JSON.parse(text) }
    } catch {
      if (last !== undefined && text === last) return { state: 'bad' }
      last = text
    }
  }
  return { state: 'unsure' }
}

// Each list carries its own complete flag: false when that read could not list the folder or a file could not be read steadily. Reads run at the same
// time (the sweep, an open's poll, the spool), so a flag shared on the registry could be reset by another read. The sweep closes nothing on such a read;
// an open retries it. A file that is not an entry (a bad name, unparsable but steady, not this pid's) is skipped and does not count against the read.
function createRegistry(dir) {
  return {
    async list() {
      const out = []
      let complete = true
      let files = []
      try {
        files = await fs.promises.readdir(dir)
      } catch (err) {
        return Object.defineProperty(out, 'complete', { value: !!err && err.code === 'ENOENT' })
      }
      for (const f of files) {
        if (!/^[A-Za-z0-9-]{1,64}\.json$/.test(f)) continue
        const r = await readEntry(path.join(dir, f))
        if (r.state === 'unsure') complete = false
        const j = r.state === 'ok' ? r.j : undefined
        if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.sessionId === 'string' && f === `${j.pid}.json`) out.push({ sessionId: j.sessionId, cwd: j.cwd, entrypoint: j.entrypoint, name: j.name, nameSource: j.nameSource, pid: j.pid, procStart: j.procStart })
      }
      return Object.defineProperty(out, 'complete', { value: complete })
    },
  }
}

module.exports = { createRegistry, readEntry }
