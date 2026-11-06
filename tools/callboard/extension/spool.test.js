'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSpool } = require('./spool.js')

const SID = '1a1b2c3d-0000-4000-8000-123456789abc'
const FOLDER = '/work/repo/lab'

function world({ lanes = [{ name: 'LAB', folder: FOLDER }], ws = [FOLDER], openLane, reopenLane, now, closeFails, uid } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-spool-'))
  fs.chmodSync(dir, 0o700)
  const opened = []
  const closed = []
  const reopened = []
  let shift = 0
  const spool = createSpool({
    dir,
    ...(uid === undefined ? {} : { uid }),
    loadLanes: async () => {
      if (lanes instanceof Error) throw lanes
      return lanes
    },
    openLane: openLane ?? (async (f) => {
      opened.push(f)
      return SID
    }),
    closeLane: (r) => {
      closed.push(r)
      return !closeFails
    },
    reopenLane: reopenLane ?? (async (s) => {
      reopened.push(s)
      return s
    }),
    workspaceFolders: () => ws,
    now: now ?? (() => Date.now() + shift),
  })
  const put = (name, text = 'open\n', mode = 0o600) => {
    const f = path.join(dir, `${name}.open`)
    fs.writeFileSync(f, text, { mode })
    fs.chmodSync(f, mode)
    return f
  }
  const result = (name) => {
    try { return fs.readFileSync(path.join(dir, `${name}.result`), 'utf8') } catch { return undefined }
  }
  const putClose = (name, text = `${SID}\n4242\n${name}\n`, mode = 0o600) => {
    const f = path.join(dir, `${name}.close`)
    fs.writeFileSync(f, text, { mode })
    fs.chmodSync(f, mode)
    return f
  }
  const putReopen = (name, text = `${SID}\n`, mode = 0o600) => {
    const f = path.join(dir, `${name}.reopen`)
    fs.writeFileSync(f, text, { mode })
    fs.chmodSync(f, mode)
    return f
  }
  return { dir, spool, opened, closed, reopened, put, putClose, putReopen, result, tick: (ms) => { shift += ms } }
}

test('a request for a listed lane in this window opens its folder and answers the session id', async () => {
  const w = world()
  w.put('LAB')
  assert.deepEqual(await w.spool.scan(), [['LAB', 'opened']])
  assert.deepEqual(w.opened, [FOLDER])
  assert.equal(w.result('LAB'), `ok ${SID}\n`)
  assert.equal(fs.statSync(path.join(w.dir, 'LAB.result')).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(path.join(w.dir, 'LAB.open')), false)
  assert.deepEqual(fs.readdirSync(w.dir).filter((f) => f.startsWith('.')), [])
})

test('an unknown lane and an unreadable lane list are answered with a fixed code and open nothing', async () => {
  const a = world()
  a.put('NOLANE')
  assert.deepEqual(await a.spool.scan(), [['NOLANE', 'unknown-lane']])
  assert.equal(a.result('NOLANE'), 'error unknown-lane\n')
  const b = world({ lanes: new Error('boom') })
  b.put('LAB')
  assert.deepEqual(await b.spool.scan(), [['LAB', 'lanes-file']])
  assert.equal(b.result('LAB'), 'error lanes-file\n')
  assert.deepEqual([...a.opened, ...b.opened], [])
})

test('a folder that is not a workspace folder of this window is left for another window', async () => {
  const w = world({ ws: ['/other'] })
  const f = w.put('LAB')
  assert.deepEqual(await w.spool.scan(), [['LAB', 'not-mine']])
  assert.equal(fs.existsSync(f), true)
  assert.equal(w.result('LAB'), undefined)
  assert.deepEqual(w.opened, [])
})

test('bad files are dropped unanswered: wrong mode, wrong text, too long, stale, a symlink', async () => {
  const w = world()
  w.put('MODE', 'open\n', 0o644)
  assert.equal((await w.spool.handle('MODE')), 'bad-file')
  w.put('TEXT', 'start\n')
  assert.equal(await w.spool.handle('TEXT'), 'unknown-lane')
  const x = world({ lanes: [{ name: 'LAB', folder: FOLDER }] })
  x.put('LAB', 'open\nopen\nopen\nopen\nopen\n')
  assert.equal(await x.spool.handle('LAB'), 'bad-file')
  x.put('LAB', 'start\n')
  assert.equal(await x.spool.handle('LAB'), 'bad-request')
  assert.equal(x.result('LAB'), 'error bad-request\n')
  const y = world()
  y.put('LAB')
  y.tick(121_000)
  assert.equal(await y.spool.handle('LAB'), 'stale')
  assert.equal(y.result('LAB'), undefined)
  const z = world()
  fs.writeFileSync(path.join(z.dir, 'real'), 'open\n', { mode: 0o600 })
  fs.symlinkSync(path.join(z.dir, 'real'), path.join(z.dir, 'LAB.open'))
  assert.equal(await z.spool.handle('LAB'), 'bad-file')
  assert.deepEqual(z.opened, [])
})

test('the same lane is opened at most once every 10 seconds', async () => {
  const w = world()
  w.put('LAB')
  assert.equal(await w.spool.handle('LAB'), 'opened')
  w.put('LAB')
  assert.equal(await w.spool.handle('LAB'), 'too-soon')
  assert.equal(w.result('LAB'), 'error too-soon\n')
  w.tick(11_000)
  w.put('LAB')
  assert.equal(await w.spool.handle('LAB'), 'opened')
  assert.equal(w.opened.length, 2)
})

test('an open that fails is answered with a fixed code, never the error text', async () => {
  for (const [msg, code] of [['timeout: no new panel registered', 'timeout'], ['ambiguous: more than one new panel in that folder', 'ambiguous'], ['folder is not a workspace folder of this window', 'not-workspace'], ['unnamed-panel: an unnamed panel already sits in that folder', 'unnamed-panel'], ['secret /Users/x detail', 'failed']]) {
    const w = world({ openLane: async () => { throw new Error(msg) } })
    w.put('LAB')
    assert.equal(await w.spool.handle('LAB'), code)
    assert.equal(w.result('LAB'), `error ${code}\n`)
  }
})

test('an open or reopen that failed only on an incomplete registry read gives back its budget and its 10 s gap', async () => {
  let fail = true
  const w = world({
    lanes: [...PARKED],
    openLane: async () => { if (fail) throw new Error('registry-incomplete: the session registry could not be read in full'); return SID },
    reopenLane: async (s) => { if (fail) throw new Error('registry-incomplete: the session registry could not be read in full'); return s },
  })
  w.put('LAB')
  assert.equal(await w.spool.handle('LAB'), 'failed')
  assert.equal(w.result('LAB'), 'error failed\n')
  fail = false
  w.put('LAB')
  assert.equal(await w.spool.handle('LAB'), 'opened', 'no 10 s wait after an open that opened nothing')
  w.tick(11_000)
  fail = true
  w.putReopen('LAB')
  assert.equal(await w.spool.handleReopen('LAB'), 'failed')
  fail = false
  w.putReopen('LAB')
  assert.equal(await w.spool.handleReopen('LAB'), 'reopened', 'the gap is back to the last real open')
  const names = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']
  fail = true
  const v = world({ lanes: names.map((name) => ({ name, folder: FOLDER })), openLane: async () => { if (fail) throw new Error('registry-incomplete: x'); return SID } })
  for (const n of names) {
    v.put(n)
    await v.spool.handle(n)
  }
  fail = false
  v.put('L1')
  assert.equal(await v.spool.handle('L1'), 'opened', 'failed reads spent none of the six a minute')
})

test('a non-session answer from the open call is refused', async () => {
  const w = world({ openLane: async () => 'not-a-sid' })
  w.put('LAB')
  assert.equal(await w.spool.handle('LAB'), 'failed')
})

test('an unsafe spool folder (a symlink) is skipped', async () => {
  const w = world()
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-real-'))
  const link = path.join(os.tmpdir(), `cb-link-${process.pid}-${Date.now()}`)
  fs.symlinkSync(real, link)
  const s = createSpool({ dir: link, loadLanes: async () => [{ name: 'LAB', folder: FOLDER }], openLane: async () => SID, workspaceFolders: () => [FOLDER] })
  fs.writeFileSync(path.join(real, 'LAB.open'), 'open\n', { mode: 0o600 })
  assert.deepEqual(await s.scan(), [])
  assert.equal(fs.existsSync(path.join(real, 'LAB.result')), false)
  fs.unlinkSync(link)
  assert.equal(w.opened.length, 0)
})

const crypto = require('node:crypto')
const { readStores, allLanes } = require('./spool.js')
const { reservedHit } = require('./reserved.js')

function gitDir(repo) {
  fs.mkdirSync(path.join(repo, '.git'))
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
}

function storeWorld() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-repo-')))
  fs.mkdirSync(path.join(repo, 'api'))
  gitDir(repo)
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-stores-')))
  fs.chmodSync(dir, 0o700)
  const key = crypto.createHash('sha256').update(repo).digest('hex')
  const put = (obj, { name = `${key}.json`, mode = 0o600 } = {}) => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj), { mode })
    fs.chmodSync(f, mode)
    return f
  }
  const good = { repo, lanes: [{ name: 'API', folder: `${repo}/api`, brief: `${repo}/api/B.md`, createdAt: 1 }], creates: [] }
  return { repo, dir, key, put, good }
}

test('readStores reads a lead-made lane and refuses a store that is not what the mod would trust', async () => {
  const w = storeWorld()
  w.put(w.good)
  assert.deepEqual((await readStores(w.dir)).map((l) => [l.name, l.folder, l.repo]), [['API', `${w.repo}/api`, w.repo]])
  const bad = [
    ['wrong file name', () => w.put(w.good, { name: `${'b'.repeat(64)}.json` })],
    ['group readable', () => w.put(w.good, { mode: 0o640 })],
    ['not json', () => w.put('{')],
    ['repo not clean', () => w.put({ ...w.good, repo: `${w.repo}/../x` })],
    ['reserved name', () => w.put({ ...w.good, lanes: [{ ...w.good.lanes[0], name: 'MANAGER_' }] })],
    ['folder outside the repo', () => w.put({ ...w.good, lanes: [{ ...w.good.lanes[0], folder: '/tmp' }] })],
    ['folder missing', () => w.put({ ...w.good, lanes: [{ ...w.good.lanes[0], folder: `${w.repo}/nothere` }] })],
    ['too many lanes', () => w.put({ ...w.good, lanes: Array.from({ length: 17 }, (_, i) => ({ ...w.good.lanes[0], name: `L${i}` })) })],
    ['too big', () => w.put(`${JSON.stringify(w.good)}${' '.repeat(20000)}`)],
  ]
  for (const [why, make] of bad) {
    fs.rmSync(path.join(w.dir, `${w.key}.json`), { force: true })
    fs.rmSync(path.join(w.dir, `${'b'.repeat(64)}.json`), { force: true })
    make()
    assert.deepEqual(await readStores(w.dir), [], why)
  }
  fs.rmSync(path.join(w.dir, `${'b'.repeat(64)}.json`), { force: true })
  w.put(w.good)
  fs.symlinkSync(path.join(w.dir, `${w.key}.json`), path.join(w.dir, `${'c'.repeat(64)}.json`))
  assert.equal((await readStores(w.dir)).length, 1)
  fs.chmodSync(w.dir, 0o755)
  assert.deepEqual(await readStores(w.dir), [])
})

test('a lane folder that is a link is skipped', async () => {
  const w = storeWorld()
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-real-'))
  fs.rmSync(`${w.repo}/api`, { recursive: true })
  fs.symlinkSync(real, `${w.repo}/api`)
  w.put(w.good)
  assert.deepEqual(await readStores(w.dir), [])
})

test('allLanes reads the stores, and a missing store folder is no lanes', async () => {
  const w = storeWorld()
  w.put(w.good)
  assert.deepEqual(await allLanes({ storeDir: w.dir }), [{ name: 'API', folder: `${w.repo}/api`, repo: w.repo }])
  assert.deepEqual(await allLanes({ storeDir: path.join(w.dir, 'nothere') }), [])
})

test('reserved names are matched by skeleton', async () => {
  for (const n of ['MANAGER', 'manager_', 'MANAGER-2', 'MANAG3R', 'rnANAGER']) assert.equal(reservedHit(n), true, n)
  for (const n of ['LAB', 'API', 'HARBOR', 'MANAGER-API']) assert.equal(reservedHit(n), false, n)
})

test('the spool opens at most six panels a minute', async () => {
  const names = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']
  const w = world({ lanes: names.map((name) => ({ name, folder: FOLDER })) })
  const out = []
  for (const n of names) {
    w.put(n)
    out.push(await w.spool.handle(n))
  }
  assert.deepEqual(out, ['opened', 'opened', 'opened', 'opened', 'opened', 'opened', 'too-soon'])
  assert.equal(w.opened.length, 6)
  w.tick(61_000)
  w.put('L7')
  assert.equal(await w.spool.handle('L7'), 'opened')
})

test('a store file that is a link to a good file is not read', async () => {
  const w = storeWorld()
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-other-'))
  const target = path.join(other, 'x.json')
  fs.writeFileSync(target, JSON.stringify(w.good), { mode: 0o600 })
  fs.symlinkSync(target, path.join(w.dir, `${w.key}.json`))
  assert.deepEqual(await readStores(w.dir), [])
})

test('a whole store is refused for one bad record, a repo that is not a git root, or a repo that is too broad', async () => {
  const w = storeWorld()
  const lane = w.good.lanes[0]
  for (const [why, store] of [
    ['dup name', { ...w.good, lanes: [lane, lane] }],
    ['brief outside the folder', { ...w.good, lanes: [{ ...lane, brief: `${w.repo}/B.md` }] }],
    ['brief with odd characters', { ...w.good, lanes: [{ ...lane, brief: `${w.repo}/api/B$(x).md` }] }],
    ['no createdAt', { ...w.good, lanes: [{ ...lane, createdAt: 'x' }] }],
    ['one reserved name among good ones', { ...w.good, lanes: [lane, { ...lane, name: 'MANA6ER' }] }],
  ]) {
    w.put(store)
    assert.deepEqual(await readStores(w.dir), [], why)
  }
  w.put(w.good)
  assert.equal((await readStores(w.dir)).length, 1)
  fs.rmSync(path.join(w.repo, '.git', 'HEAD'))
  fs.rmdirSync(path.join(w.repo, '.git'))
  assert.deepEqual(await readStores(w.dir), [], 'no .git')
  gitDir(w.repo)
  assert.deepEqual(await readStores(w.dir, { home: w.repo }), [], 'the repo is the home folder')
})

test('a store counts only when its repo is a git root by the mod\'s rule', async () => {
  const w = storeWorld()
  w.put(w.good)
  const git = path.join(w.repo, '.git')
  const reset = () => {
    const st = fs.lstatSync(git)
    if (!st.isDirectory()) return fs.unlinkSync(git)
    const head = path.join(git, 'HEAD')
    if (fs.existsSync(head)) (fs.lstatSync(head).isDirectory() ? fs.rmdirSync : fs.unlinkSync)(head)
    fs.rmdirSync(git)
  }
  assert.equal((await readStores(w.dir)).length, 1, '.git folder with a plain HEAD')
  reset()
  fs.mkdirSync(git)
  assert.deepEqual(await readStores(w.dir), [], 'empty .git folder')
  fs.mkdirSync(path.join(git, 'HEAD'))
  assert.deepEqual(await readStores(w.dir), [], 'HEAD is a folder')
  reset()
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-gitlink-'))
  gitDir(target)
  fs.symlinkSync(path.join(target, '.git'), git)
  assert.deepEqual(await readStores(w.dir), [], 'symlinked .git')
  reset()
  fs.writeFileSync(git, 'gitdir: /somewhere/.git/worktrees/x\n', { mode: 0o644 })
  fs.chmodSync(git, 0o644)
  assert.equal((await readStores(w.dir)).length, 1, 'a gitdir: file (worktree)')
  fs.chmodSync(git, 0o664)
  assert.deepEqual(await readStores(w.dir), [], 'a group-writable gitdir: file')
  fs.chmodSync(git, 0o644)
  fs.writeFileSync(git, 'not a gitdir line\n')
  assert.deepEqual(await readStores(w.dir), [], 'a .git file without gitdir:')
  reset()
  gitDir(w.repo)
  assert.equal((await readStores(w.dir)).length, 1, 'back to a repo')
})

test('a name that is in two stores is dropped from both', async () => {
  const a = storeWorld()
  const b = storeWorld()
  a.put(a.good)
  const other = JSON.stringify(b.good)
  fs.writeFileSync(path.join(a.dir, `${b.key}.json`), other, { mode: 0o600 })
  assert.equal((await readStores(a.dir)).length, 2)
  assert.deepEqual(await allLanes({ storeDir: a.dir }), [])
})

test('the spool refuses to open a lead-made lane when its repo already has eight live sessions', async () => {
  const w = world({ lanes: [{ name: 'LAB', folder: FOLDER, repo: '/work/repo' }] })
  const spool = createSpool({ dir: w.dir, loadLanes: async () => [{ name: 'LAB', folder: FOLDER, repo: '/work/repo' }], openLane: async () => SID, workspaceFolders: () => [FOLDER], liveInRepo: async () => 8, now: () => Date.now() })
  w.put('LAB')
  assert.equal(await spool.handle('LAB'), 'too-many')
  assert.match(w.result('LAB'), /too-many/)
  const ok = createSpool({ dir: w.dir, loadLanes: async () => [{ name: 'LAB', folder: FOLDER, repo: '/work/repo' }], openLane: async () => SID, workspaceFolders: () => [FOLDER], liveInRepo: async () => 7, now: () => Date.now() })
  w.put('LAB')
  assert.equal(await ok.handle('LAB'), 'opened')
})

test('a store with a bad creates list or a name that is not a string is refused whole, as in the mod', async () => {
  const w = storeWorld()
  const lane = w.good.lanes[0]
  for (const [why, store] of [
    ['creates is not a list', { ...w.good, creates: 'x' }],
    ['a create time that is not a number', { ...w.good, creates: ['a'] }],
    ['a name that is a number', { ...w.good, lanes: [{ ...lane, name: 7 }] }],
    ['no name', { ...w.good, lanes: [{ ...lane, name: undefined }] }],
  ]) {
    w.put(store)
    assert.deepEqual(await readStores(w.dir), [], why)
  }
})

test('a lane an existing session joined is read with adopted and lead; a bad adopted or lead refuses the whole store, as in the mod', async () => {
  const w = storeWorld()
  const lead = '5a1b2c3d-0000-4000-8000-123456789abc'
  const att = { name: 'ATT', folder: `${w.repo}/api`, brief: `${w.repo}/api/.callboard-attached`, createdAt: 1, adopted: true, lead }
  w.put({ ...w.good, lanes: [w.good.lanes[0], { ...att, folder: w.repo, brief: `${w.repo}/.callboard-attached` }] })
  assert.deepEqual((await readStores(w.dir)).map((l) => l.name), ['API', 'ATT'])
  const { adopted, ...plain } = att
  for (const [why, rec] of [
    ['adopted false', { ...att, adopted: false }],
    ['adopted a string', { ...att, adopted: 'true' }],
    ['adopted null', { ...att, adopted: null }],
    ['no lead', { ...att, lead: undefined }],
    ['lead not a session id', { ...att, lead: 'x' }],
    ['lead a number', { ...att, lead: 5 }],
    ['lead without adopted', plain],
    ['lead null without adopted', { ...plain, lead: null }],
  ]) {
    w.put({ ...w.good, lanes: [rec] })
    assert.deepEqual(await readStores(w.dir), [], why)
  }
})

test('a close request for a listed lane in this window is handed to the sweep and the file is removed; nothing is answered', async () => {
  const w = world()
  const f = w.putClose('LAB')
  assert.deepEqual(await w.spool.scan(), [['LAB', 'closing']])
  assert.deepEqual(w.closed, [{ sid: SID, pid: 4242, name: 'LAB' }])
  assert.equal(fs.existsSync(f), false)
  assert.equal(w.result('LAB'), undefined)
  assert.deepEqual(w.opened, [])
  assert.deepEqual(fs.readdirSync(w.dir).filter((x) => x.startsWith('.')), [])
})

test('a close request for a folder that is not this window\'s is left for another window; an unknown lane or an unreadable lane list drops it', async () => {
  const a = world({ ws: ['/other'] })
  const f = a.putClose('LAB')
  assert.equal(await a.spool.handleClose('LAB'), 'not-mine')
  assert.equal(fs.existsSync(f), true)
  const b = world()
  b.putClose('NOLANE')
  assert.equal(await b.spool.handleClose('NOLANE'), 'unknown-lane')
  assert.equal(fs.existsSync(path.join(b.dir, 'NOLANE.close')), false)
  const c = world({ lanes: new Error('boom') })
  c.putClose('LAB')
  assert.equal(await c.spool.handleClose('LAB'), 'lanes-file')
  assert.equal(fs.existsSync(path.join(c.dir, 'LAB.close')), false)
  assert.deepEqual([...a.closed, ...b.closed, ...c.closed], [])
})

test('a close request with a bad session id, pid, name line or extra text is dropped and hands over nothing', async () => {
  const w = world({ lanes: [{ name: 'LAB', folder: FOLDER }, { name: 'manager', folder: FOLDER }] })
  const bad = [
    `nope\n4242\nLAB\n`,
    `${SID}\n1\nLAB\n`,
    `${SID}\n0\nLAB\n`,
    `${SID}\n-5\nLAB\n`,
    `${SID}\n4242x\nLAB\n`,
    `${SID}\n99999999999\nLAB\n`,
    `${SID}\n4242\nOTHER\n`,
    `${SID}\n4242\nLAB`,
    `${SID}\n4242\nLAB\nmore\n`,
    `${SID}\n4242\n`,
    `\n`,
  ]
  for (const text of bad) {
    const f = w.putClose('LAB', text)
    assert.equal(await w.spool.handleClose('LAB'), 'bad-request', JSON.stringify(text))
    assert.equal(fs.existsSync(f), false)
  }
  const r = w.putClose('manager', `${SID}\n4242\nmanager\n`)
  assert.equal(await w.spool.handleClose('manager'), 'bad-request')
  assert.equal(fs.existsSync(r), false)
  assert.deepEqual(w.closed, [])
})

test('a close request that is not a plain 0600 file of ours, too long, stale or a link is dropped', async () => {
  const w = world()
  w.putClose('LAB', undefined, 0o644)
  assert.equal(await w.spool.handleClose('LAB'), 'bad-file')
  w.putClose('LAB', `${SID}\n4242\nLAB\n${'x'.repeat(200)}`)
  assert.equal(await w.spool.handleClose('LAB'), 'bad-file')
  w.putClose('LAB')
  w.tick(200_000)
  assert.equal(await w.spool.handleClose('LAB'), 'stale')
  assert.equal(fs.existsSync(path.join(w.dir, 'LAB.close')), false)
  const target = path.join(w.dir, 'real')
  fs.writeFileSync(target, `${SID}\n4242\nLAB\n`, { mode: 0o600 })
  fs.symlinkSync(target, path.join(w.dir, 'LAB.close'))
  assert.equal(await w.spool.handleClose('LAB'), 'bad-file')
  assert.equal(await w.spool.handleClose('LAB'), 'gone')
  assert.deepEqual(w.closed, [])
})

test('a sweep that refuses the panel (the extension answers false) leaves a bad-request, and a close request does not use the open budget', async () => {
  const w = world({ closeFails: true })
  w.putClose('LAB')
  assert.equal(await w.spool.handleClose('LAB'), 'bad-request')
  const x = world()
  for (let i = 0; i < 8; i++) {
    x.putClose('LAB')
    assert.equal(await x.spool.handleClose('LAB'), 'closing')
  }
  x.put('LAB')
  assert.equal(await x.spool.handle('LAB'), 'opened')
})

test('a close request that is a hard link, owned by another user, or dated in the future is dropped', async () => {
  const w = world()
  const f = w.putClose('LAB')
  fs.linkSync(f, path.join(w.dir, 'other-link'))
  assert.equal(await w.spool.handleClose('LAB'), 'bad-file')
  assert.equal(fs.existsSync(f), false)
  const x = world({ uid: process.getuid() + 1 })
  x.putClose('LAB')
  assert.equal(await x.spool.handleClose('LAB'), 'bad-file')
  const y = world()
  const g = y.putClose('LAB')
  const future = new Date(Date.now() + 60_000)
  fs.utimesSync(g, future, future)
  assert.equal(await y.spool.handleClose('LAB'), 'stale')
  assert.equal(fs.existsSync(g), false)
  assert.deepEqual([...w.closed, ...x.closed, ...y.closed], [])
})

test('a close request with a pid above 2^22 is refused and a pid at the limit is handed over', async () => {
  const w = world()
  w.putClose('LAB', `${SID}\n4194305\nLAB\n`)
  assert.equal(await w.spool.handleClose('LAB'), 'bad-request')
  assert.deepEqual(w.closed, [])
  w.putClose('LAB', `${SID}\n4194304\nLAB\n`)
  assert.equal(await w.spool.handleClose('LAB'), 'closing')
  assert.equal(w.closed.length, 1)
})

// ---- v13: <LANE>.reopen (lane_unpark) ----
const PARKED = [{ name: 'LAB', folder: FOLDER, repo: '/work/repo', sid: SID }]

test('a reopen request for a listed lane whose record names that sid reopens it and answers ok <sid>', async () => {
  const w = world({ lanes: PARKED })
  const f = w.putReopen('LAB')
  assert.deepEqual(await w.spool.scan(), [['LAB', 'reopened']])
  assert.deepEqual(w.reopened, [SID])
  assert.deepEqual(w.opened, [])
  assert.equal(w.result('LAB'), `ok ${SID}\n`)
  assert.equal(fs.existsSync(f), false)
  assert.deepEqual(fs.readdirSync(w.dir).filter((x) => x.startsWith('.')), [])
})

test('a reopen whose sid is not the record\'s, for a lane with no saved session, or with a bad body is answered with a fixed code and reopens nothing', async () => {
  const other = '2a1b2c3d-0000-4000-8000-123456789abc'
  const cases = [
    [PARKED, `${other}\n`, 'sid-mismatch'],
    [[{ name: 'LAB', folder: FOLDER }], `${SID}\n`, 'sid-mismatch'],
    [PARKED, `${SID}`, 'bad-request'],
    [PARKED, `${SID}\n\n`, 'bad-request'],
    [PARKED, `${SID.toUpperCase()}\n`, 'bad-request'],
    [PARKED, 'open\n', 'bad-request'],
  ]
  for (const [lanes, body, code] of cases) {
    const w = world({ lanes })
    w.putReopen('LAB', body)
    assert.equal(await w.spool.handleReopen('LAB'), code, JSON.stringify(body))
    assert.equal(w.result('LAB'), `error ${code}\n`)
    assert.deepEqual(w.reopened, [])
  }
  const u = world({ lanes: [] })
  u.putReopen('LAB')
  assert.equal(await u.spool.handleReopen('LAB'), 'unknown-lane')
  const e = world({ lanes: new Error('bad') })
  e.putReopen('LAB')
  assert.equal(await e.spool.handleReopen('LAB'), 'lanes-file')
  assert.equal(e.result('LAB'), 'error lanes-file\n')
  const n = world({ lanes: PARKED, ws: ['/other'] })
  const f = n.putReopen('LAB')
  assert.equal(await n.spool.handleReopen('LAB'), 'not-mine')
  assert.equal(fs.existsSync(f), true)
  assert.deepEqual([...u.reopened, ...e.reopened, ...n.reopened], [])
})

test('a reopen request that is not a plain 0600 file of ours, too long, stale, a link or another user\'s is dropped unanswered', async () => {
  const w = world({ lanes: PARKED })
  w.putReopen('LAB', `${SID}\n`, 0o644)
  assert.equal(await w.spool.handleReopen('LAB'), 'bad-file')
  w.putReopen('LAB', `${SID}\n${'x'.repeat(64)}`)
  assert.equal(await w.spool.handleReopen('LAB'), 'bad-file')
  const f = w.putReopen('LAB')
  const old = new Date(Date.now() - 200_000)
  fs.utimesSync(f, old, old)
  assert.equal(await w.spool.handleReopen('LAB'), 'stale')
  const g = w.putReopen('LAB')
  fs.linkSync(g, path.join(w.dir, 'other-link'))
  assert.equal(await w.spool.handleReopen('LAB'), 'bad-file')
  const real = path.join(w.dir, 'real.txt')
  fs.writeFileSync(real, `${SID}\n`, { mode: 0o600 })
  fs.symlinkSync(real, path.join(w.dir, 'LAB.reopen'))
  assert.equal(await w.spool.handleReopen('LAB'), 'bad-file')
  const x = world({ lanes: PARKED, uid: process.getuid() + 1 })
  x.putReopen('LAB')
  assert.equal(await x.spool.handleReopen('LAB'), 'bad-file')
  assert.equal(w.result('LAB'), undefined)
  assert.deepEqual([...w.reopened, ...x.reopened], [])
})

test('a reopen shares the per-lane 10 s gap and the six-a-minute budget with opens', async () => {
  const w = world({ lanes: [...PARKED] })
  w.put('LAB')
  assert.equal(await w.spool.handle('LAB'), 'opened')
  w.putReopen('LAB')
  assert.equal(await w.spool.handleReopen('LAB'), 'too-soon')
  w.tick(11_000)
  w.putReopen('LAB')
  assert.equal(await w.spool.handleReopen('LAB'), 'reopened')
  const names = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']
  const v = world({ lanes: names.map((name) => ({ name, folder: FOLDER, sid: SID })) })
  const out = []
  for (const n of names.slice(0, 5)) {
    v.put(n)
    out.push(await v.spool.handle(n))
  }
  v.putReopen('L6')
  out.push(await v.spool.handleReopen('L6'))
  v.putReopen('L6')
  v.tick(11_000)
  out.push(await v.spool.handleReopen('L6'))
  assert.deepEqual(out, ['opened', 'opened', 'opened', 'opened', 'opened', 'reopened', 'too-soon'])
})

test('a reopen that fails is answered with a fixed code, never the error text', async () => {
  for (const [msg, code] of [['timeout: panel did not register', 'timeout'], ['live-elsewhere: that session runs outside a VS Code panel', 'live-elsewhere'], ['secret /Users/x detail', 'failed']]) {
    const w = world({ lanes: PARKED, reopenLane: async () => { throw new Error(msg) } })
    w.putReopen('LAB')
    assert.equal(await w.spool.handleReopen('LAB'), code)
    assert.equal(w.result('LAB'), `error ${code}\n`)
  }
  const o = world({ lanes: PARKED, reopenLane: async () => '2a1b2c3d-0000-4000-8000-123456789abc' })
  o.putReopen('LAB')
  assert.equal(await o.spool.handleReopen('LAB'), 'failed')
})

test('readStores carries sid and refuses a store with a bad sid or parked without sid, as the mod does', async () => {
  const w = storeWorld()
  const sid = '7a1b2c3d-0000-4000-8000-123456789abc'
  w.put({ ...w.good, lanes: [{ ...w.good.lanes[0], sid, parked: 5 }] })
  assert.deepEqual((await readStores(w.dir)).map((l) => [l.name, l.sid]), [['API', sid]])
  w.put(w.good)
  assert.equal('sid' in (await readStores(w.dir))[0], false)
  for (const [why, patch] of [
    ['sid not a session id', { sid: 'x' }],
    ['sid a number', { sid: 5 }],
    ['sid null', { sid: null }],
    ['parked without sid', { parked: 5 }],
    ['parked a string', { sid, parked: '5' }],
    ['parked null', { sid, parked: null }],
  ]) {
    w.put({ ...w.good, lanes: [{ ...w.good.lanes[0], ...patch }] })
    assert.deepEqual(await readStores(w.dir), [], why)
  }
})
