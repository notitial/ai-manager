import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, readdirSync, symlinkSync, mkdirSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { send, cueText } from './callboard-send.mjs'

const SID = '0a1b2c3d-0000-4000-8000-123456789abc'
const root = () => join(mkdtempSync(join(tmpdir(), 'lc-')), 'callboard')

test('writes grammar-exact content, 0600 file in 0700 dir, no temp left', () => {
  const r = root()
  const p = send(SID, ['rename', 'api'], r)
  assert.equal(readFileSync(p, 'utf8'), 'rename api\n')
  assert.equal(statSync(p).mode & 0o777, 0o600)
  assert.equal(statSync(join(r, 'cue')).mode & 0o777, 0o700)
  assert.deepEqual(readdirSync(join(r, 'cue')), [`${SID}.cue`])
})

test('replaces an existing cue atomically', () => {
  const r = root()
  send(SID, ['start'], r)
  const p = send(SID, ['compact'], r)
  assert.equal(readFileSync(p, 'utf8'), 'compact\n')
})

test('refuses bad grammar and bad sids', () => {
  const r = root()
  for (const a of [['submit', 'hi'], ['rename'], ['rename', 'a b'], ['start', 'now'], ['rename', 'x'.repeat(41)], ['compact\nstart'], ['']])
    assert.throws(() => cueText(a), /grammar/)
  assert.throws(() => send('../etc', ['start'], r), /bad session id/)
  assert.throws(() => send(SID.toUpperCase(), ['start'], r), /bad session id/)
})

test('refuses a symlinked cue directory', () => {
  const r = root()
  mkdirSync(r, { recursive: true })
  const real = mkdtempSync(join(tmpdir(), 'lc-real-'))
  symlinkSync(real, join(r, 'cue'))
  assert.throws(() => send(SID, ['start'], r), /unsafe directory|EEXIST/)
})

test('the command line entry works through a symlink and a path with spaces, and says so on failure', () => {
  const d = mkdtempSync(join(tmpdir(), 'lc sp-'))
  const src = new URL('./callboard-send.mjs', import.meta.url).pathname
  mkdirSync(join(d, 'a b'))
  copyFileSync(src, join(d, 'a b', 'send.mjs'))
  symlinkSync(join(d, 'a b', 'send.mjs'), join(d, 'link.mjs'))
  const home = mkdtempSync(join(tmpdir(), 'lc-home-'))
  for (const script of [join(d, 'a b', 'send.mjs'), join(d, 'link.mjs')]) {
    const bad = spawnSync(process.execPath, [script, 'nope', 'start'], { encoding: 'utf8', env: { ...process.env, HOME: home } })
    assert.equal(bad.status, 2, script)
    assert.match(bad.stderr, /bad session id/)
  }
})
