#!/usr/bin/env node
// callboard send <sid> <rename NAME|start|resume|compact>
// Writer side of the callboard contract (ADR 0002, the cue contract). Convenience only:
// every real limit lives in the mod. Writes a 0600 temp file, then rename()s it into place.
import { mkdirSync, writeFileSync, renameSync, lstatSync, chmodSync, unlinkSync, openSync, closeSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { userInfo } from 'node:os'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CUE_RE = /^(rename [A-Za-z0-9_-]{1,40}|start|resume|compact)$/

export function cueText(args) {
  const body = args.join(' ')
  if (!CUE_RE.test(body)) throw new Error('grammar: expected rename NAME | start | resume | compact')
  return `${body}\n`
}

export function send(sid, args, root = join(userInfo().homedir, '.claude', 'callboard')) {
  if (!SID_RE.test(sid)) throw new Error('bad session id')
  const text = cueText(args)
  const cueDir = join(root, 'cue')
  process.umask(0o077)
  mkdirSync(cueDir, { recursive: true, mode: 0o700 })
  for (const d of [root, cueDir]) {
    const st = lstatSync(d)
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) throw new Error(`unsafe directory: ${d}`)
    chmodSync(d, 0o700)
  }
  const tmp = join(cueDir, `.${sid}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeFileSync(fd, text)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, join(cueDir, `${sid}.cue`))
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
  return join(cueDir, `${sid}.cue`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [sid, ...rest] = process.argv.slice(2)
  try {
    if (!sid) throw new Error('usage: callboard-send.mjs <sid> <rename NAME|start|resume|compact>')
    console.log(send(sid, rest))
  } catch (e) {
    console.error(`callboard send: ${e.message}`)
    process.exit(2)
  }
}
