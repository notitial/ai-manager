'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRegistry, readEntry } = require('./registry.js')

const row = (pid, extra = {}) => JSON.stringify({ pid, sessionId: `00000000-0000-4000-8000-${String(pid).padStart(12, '0')}`, cwd: '/r', entrypoint: 'claude-vscode', ...extra })

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-registry-'))
  const put = (name, text) => fs.writeFileSync(path.join(dir, name), text)
  return { dir, put }
}

test('a whole read lists every entry and is complete', async () => {
  const f = folder()
  f.put('101.json', row(101))
  f.put('102.json', row(102))
  const list = await createRegistry(f.dir).list()
  assert.deepEqual(list.map((e) => e.pid).sort(), [101, 102])
  assert.equal(list.complete, true)
})

test('a steady unparsable file, a bad name or a row for another pid is skipped and the read stays complete', async () => {
  const f = folder()
  f.put('101.json', row(101))
  f.put('102.json', '')
  f.put('103.json', '{"pid": 103, "sessionId": "x"')
  f.put('104.json', 'null')
  f.put('105.json', row(999))
  f.put('notes.txt', 'x')
  f.put('a b.json', row(7))
  fs.mkdirSync(path.join(f.dir, '106.json'))
  const list = await createRegistry(f.dir).list()
  assert.deepEqual(list.map((e) => e.pid), [101])
  assert.equal(list.complete, true, 'one bad file must not stop every open')
})

test('a file that keeps changing under the read makes the read incomplete; one that settles is read', async () => {
  const f = folder()
  const file = path.join(f.dir, '101.json')
  f.put('101.json', row(101))
  const real = fs.promises.readFile
  let n = 0
  fs.promises.readFile = async (p, o) => (p === file ? `{"torn ${n++}` : real(p, o))
  try {
    const list = await createRegistry(f.dir).list()
    assert.equal(list.complete, false)
    assert.deepEqual(list, [])
    let m = 0
    fs.promises.readFile = async (p, o) => (p === file && m++ === 0 ? '{"torn' : real(p, o))
    const again = await createRegistry(f.dir).list()
    assert.equal(again.complete, true)
    assert.deepEqual(again.map((e) => e.pid), [101])
  } finally {
    fs.promises.readFile = real
  }
})

test('a file that cannot be read twice makes the read incomplete; a file gone since the listing is skipped', async () => {
  const f = folder()
  f.put('101.json', row(101))
  const file = path.join(f.dir, '101.json')
  const real = fs.promises.readFile
  try {
    fs.promises.readFile = async (p, o) => { if (p === file) throw Object.assign(new Error('busy'), { code: 'EIO' }); return real(p, o) }
    assert.equal((await createRegistry(f.dir).list()).complete, false)
    fs.promises.readFile = async (p, o) => { if (p === file) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return real(p, o) }
    const list = await createRegistry(f.dir).list()
    assert.equal(list.complete, true)
    assert.deepEqual(list, [])
  } finally {
    fs.promises.readFile = real
  }
})

test('a missing registry folder is an empty, complete read; one that cannot be listed is incomplete', async () => {
  const f = folder()
  const none = await createRegistry(path.join(f.dir, 'missing')).list()
  assert.deepEqual([none.length, none.complete], [0, true])
  f.put('file', 'x')
  const notDir = await createRegistry(path.join(f.dir, 'file')).list()
  assert.deepEqual([notDir.length, notDir.complete], [0, false])
})

test('readEntry answers gone, bad or unsure, or the parsed row; a parsed "unsure" is just a row', async () => {
  const f = folder()
  f.put('1.json', '{"a":1}')
  f.put('2.json', 'nope')
  f.put('4.json', '"unsure"')
  assert.deepEqual(await readEntry(path.join(f.dir, '1.json')), { state: 'ok', j: { a: 1 } })
  assert.deepEqual(await readEntry(path.join(f.dir, '2.json')), { state: 'bad' })
  assert.deepEqual(await readEntry(path.join(f.dir, '3.json')), { state: 'gone' })
  assert.deepEqual(await readEntry(path.join(f.dir, '4.json')), { state: 'ok', j: 'unsure' })
  f.put('5.json', row(5))
  const list = await createRegistry(f.dir).list()
  assert.equal(list.complete, true, 'a row whose JSON is the string "unsure" is not an unsure read')
})

test('the second read comes after a pause, so a file the engine is rewriting gets time to settle', async () => {
  const f = folder()
  const file = path.join(f.dir, '9.json')
  f.put('9.json', '')
  let paused = 0
  const got = await readEntry(file, async () => { paused++; fs.writeFileSync(file, row(9)) })
  assert.equal(paused, 1)
  assert.equal(got.state, 'ok', 'the half-written file is read again after the pause, now whole')
})

test('a file this user may not read is skipped, not an incomplete read', async () => {
  const f = folder()
  f.put('101.json', row(101))
  const file = path.join(f.dir, '101.json')
  const real = fs.promises.readFile
  try {
    for (const code of ['EACCES', 'EPERM']) {
      fs.promises.readFile = async (p, o) => { if (p === file) throw Object.assign(new Error('no'), { code }); return real(p, o) }
      const list = await createRegistry(f.dir).list()
      assert.equal(list.complete, true, code)
    }
  } finally {
    fs.promises.readFile = real
  }
})
