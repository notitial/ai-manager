import { expect, test } from 'claude-code/testing'
import { refusalText } from '../hooks/core'
import { h, LANESDIR, T0, YES, extraStat, lockLog, lockOwnerReads, psDead, psFail, realFails, realMap, regFacts, storeFiles, storeReads, teeTexts } from './harness'
import { ATTSESS, KEY, LEADPS, LOCK_CYCLE, OTHER, OTHERLEAD, OWNER_LIVE, PIN, STOREFILE, attRec, attacher, callCreate, created, creator, cueSession, dirStat, doLane, dropRec, grantAt, leadAt, leadCall, leadSelfReg, logged, noLaneWritten, ownerText, putStore, storeLaneNames, tickTwice, ticks } from './fixtures'

test('a store file that is not named by the hash of its repo, or is not private, is not loaded', async ($, on) => {
  await creator($, on)
  const good = JSON.stringify({ repo: PIN, lanes: [{ name: 'API', folder: `${PIN}/api`, brief: `${PIN}/api/BRIEF.md`, createdAt: 1 }], creates: [] })
  storeFiles.set(`${LANESDIR}/${'b'.repeat(64)}.json`, good)
  h.sessions = cueSession(OTHER, 'API', `${PIN}/api`)
  expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' })))).toContain('unknown-lane')
  storeFiles.clear()
  putStore([{ name: 'MANAGER', folder: PIN, brief: `${PIN}/B.md`, createdAt: 1 }])
  expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'MANAGER' })))).toContain('unknown-lane')
  storeFiles.set(STOREFILE, good.replace(PIN, '/Users/x/code/../app'))
  expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' })))).toContain('unknown-lane')
})

test('a store file with the wrong owner, mode, link count or size is not loaded, and a lane folder that is a link is skipped', async ($, on) => {
  await creator($, on)
  await callCreate($)
  h.sessions = cueSession(OTHER, 'API', `${PIN}/api`)
  expect((await $.tool.call(leadCall('start', { lane: 'API' }))).result).toContain('cue start acted')
  for (const bad of ['501 644 1 Regular File 77 50 1700000000\n', '502 600 1 Regular File 77 50 1700000000\n', '501 600 2 Regular File 77 50 1700000000\n', '501 600 1 Regular File 77 99999 1700000000\n', '501 600 1 Symbolic Link 77 50 1700000000\n']) {
    h.storeStatOverride = bad
    expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' })))).toContain('unknown-lane')
  }
  h.storeStatOverride = undefined
  realMap.set(`${PIN}/api`, '/Users/x/code/elsewhere')
  expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' })))).toContain('unknown-lane')
})

test('lane_create never overwrites a store it cannot read safely', async ($, on) => {
  await creator($, on)
  await callCreate($)
  const before = storeFiles.get(STOREFILE)
  h.storeStatOverride = '501 644 1 Regular File 77 50 1700000000\n'
  extraStat.set(`${PIN}/b`, dirStat)
  expect(JSON.stringify(await callCreate($, created({ name: 'B', folder: `${PIN}/b` })))).toContain('store-unreadable')
  expect(storeFiles.get(STOREFILE)).toBe(before)
})

test('two lane_create calls at once both end up in the store', async ($, on) => {
  await creator($, on)
  for (const n of ['L1', 'L2', 'L3']) {
    extraStat.set(`${PIN}/${n}`, dirStat)
  }
  const all = await Promise.all(['L1', 'L2', 'L3'].map((n) => callCreate($, created({ name: n, folder: `${PIN}/${n}` }))))
  expect(all.map((r: any) => JSON.stringify(r)).every((r: string) => r.includes('created'))).toBe(true)
  expect(storeLaneNames().sort()).toEqual(['L1', 'L2', 'L3'])
})

test('a store whose repo is too broad or has no .git is not loaded, and a store lane needs the lead pinned at its repo', async ($, on) => {
  await creator($, on)
  await callCreate($)
  h.sessions = cueSession(OTHER, 'API', `${PIN}/api`)
  await grantAt($, `${PIN}/api`)
  expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' })))).toContain('other-repo')
  await grantAt($, PIN)
  extraStat.delete(`${PIN}/.git`)
  expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' })))).toContain('unknown-lane')
  extraStat.set(`${PIN}/.git`, dirStat)
  storeFiles.set(STOREFILE, JSON.stringify({ repo: '/Users/x', lanes: [{ name: 'API', folder: '/Users/x/x', brief: '/Users/x/x/B.md', createdAt: 1 }], creates: [] }))
  extraStat.set('/Users/x/.git', dirStat)
  await grantAt($, '/Users/x')
  expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' })))).toContain('unknown-lane')
})

test('a lane name that is in two stores is dropped', async ($, on) => {
  await creator($, on)
  await callCreate($)
  const app2 = '/Users/x/code/app2'
  extraStat.set(`${app2}/.git`, dirStat)
  storeFiles.set(`${LANESDIR}/${'b'.repeat(64)}.json`, JSON.stringify({ repo: app2, lanes: [{ name: 'API', folder: `${app2}/api`, brief: `${app2}/api/BRIEF.md`, createdAt: 1 }], creates: [] }))
  h.sessions = cueSession(OTHER, 'API', `${PIN}/api`)
  expect(JSON.stringify(await $.tool.call(leadCall('start', { lane: 'API' })))).toContain('unknown-lane')
  storeFiles.delete(`${LANESDIR}/${'b'.repeat(64)}.json`)
  expect((await $.tool.call(leadCall('start', { lane: 'API' }))).result).toContain('cue start acted')
})

test('a removed lane stays removed: a removal (lane_terminate) and a create at once both land, and the removed lane does not come back', async ($, on) => {
  await leadAt($, on, [])
  h.askAnswer = YES
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  extraStat.set(`${PIN}/n`, dirStat)
  const [a, b] = await Promise.all([$.tool.call(leadCall('terminate', { lane: 'API' })), callCreate($, created({ name: 'N', folder: `${PIN}/n` }))])
  expect(JSON.stringify(a)).toContain('terminated and removed')
  expect(JSON.stringify(b)).toContain('created')
  expect(storeLaneNames()).toEqual(['N'])
  expect(h.lockState.held).toBe(false)
})
const OWNER_DEAD = ownerText(9999, 'dead-nonce-0001')
const settleCreate = async ($: any, ms = 3000) => {
  const p = callCreate($)
  for (let t = 0; t < ms; t += 150) await h.clock!.advance(150)
  return JSON.stringify(await p)
}

test('a store write while another process holds the lock waits up to 2 seconds, then refuses store-busy and leaves the lock alone', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.lockState = { held: true, owner: OWNER_LIVE, mtimeSec: T0 / 1000 }
  let done = -1
  const start = h.nowMs
  const p = callCreate($).then((r: any) => ((done = h.nowMs - start), r))
  for (let t = 0; t < 4000 && done < 0; t += 150) await h.clock!.advance(150)
  expect(JSON.stringify(await p)).toContain('store-busy')
  expect(done).toBeGreaterThanOrEqual(1900)
  expect(done).toBeLessThanOrEqual(2300)
  expect(lockLog.filter((e) => e === 'mkdir').length).toBeGreaterThan(5)
  expect(lockLog.filter((e) => e === 'mkdir').length).toBeLessThan(20)
  for (const e of ['break', 'rm-owner', 'rmdir', 'rm-stale-owner', 'rm-stale']) expect(lockLog).not.toContain(e)
  expect(lockLog.filter((e) => e === 'gate').length).toBe(lockLog.filter((e) => e === 'gate-release').length)
  expect(h.lockState).toMatchObject({ held: true, owner: OWNER_LIVE })
  expect(storeFiles.has(STOREFILE)).toBe(false)
})

test('a lock whose owner is dead, or has another start time, is broken and the write goes on; the lock is released afterwards', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.lockState = { held: true, owner: OWNER_DEAD, mtimeSec: T0 / 1000 }
  psDead.add('9999')
  expect(await settleCreate($, 300)).toContain('lane API created')
  expect(lockLog).toEqual(['mkdir', 'gate', 'break', 'rm-stale-owner', 'rm-stale', 'gate-release', ...LOCK_CYCLE])
  expect(h.lockState.held).toBe(false)
  expect(h.gateHeld).toBeUndefined()
  dropRec('API')
  lockLog.length = 0
  h.lockState = { held: true, owner: ownerText(4242, 'live-nonce-0002', 'Wed Oct 28 01:00:00 2026'), mtimeSec: T0 / 1000 }
  expect(await settleCreate($, 300)).toContain('lane API created')
  expect(lockLog).toContain('break')
  expect(h.lockState.held).toBe(false)
})

test('a live holder whose start time ps pads ("Nov  1") and the owner file does not is not judged gone: its lock is not broken', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.lockState = { held: true, owner: ownerText(4242, 'live-nonce-0003', 'Sun Nov 1 00:48:56 2026'), mtimeSec: T0 / 1000 }
  h.psOut = 'Sun Nov  1 00:48:56 2026\n'
  expect(await settleCreate($)).toContain('store-busy')
  expect(lockLog).not.toContain('break')
  expect(h.lockState.held).toBe(true)
})

test('a lock is not broken when ps fails for another reason than "no such process"', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.lockState = { held: true, owner: OWNER_DEAD, mtimeSec: T0 / 1000 }
  psFail.add('9999')
  expect(await settleCreate($)).toContain('store-busy')
  expect(lockLog).not.toContain('break')
})

test('a lock with no owner file is broken only after 10 seconds', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.lockState = { held: true, mtimeSec: T0 / 1000 - 7 }
  expect(await settleCreate($)).toContain('store-busy')
  expect(lockLog).not.toContain('break')
  lockLog.length = 0
  h.lockState = { held: true, mtimeSec: h.nowMs / 1000 - 11 }
  expect(await settleCreate($, 300)).toContain('lane API created')
  expect(lockLog).toContain('break')
})

test('a lock that changed hands while it was being broken is put back, never deleted: another owner text, or another folder with no owner file', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  const theirs = ownerText(4242, 'their-nonce-0001')
  h.lockState = { held: true, owner: OWNER_DEAD, mtimeSec: T0 / 1000 }
  h.lockOwnerAfterMove = theirs
  psDead.add('9999')
  expect(await settleCreate($)).toContain('store-busy')
  expect(lockLog).toContain('put-back')
  for (const e of ['rm-stale-owner', 'rm-stale', 'rm-owner', 'rmdir']) expect(lockLog).not.toContain(e)
  expect(h.lockState).toMatchObject({ held: true, owner: theirs })
  lockLog.length = 0
  h.lockOwnerAfterMove = undefined
  h.lockState = { held: true, mtimeSec: h.nowMs / 1000 - 11, ino: 14 }
  h.lockOwnerAfterMoveIno = 99
  expect(await settleCreate($)).toContain('store-busy')
  expect(lockLog).toContain('put-back')
  for (const e of ['rm-stale-owner', 'rm-stale']) expect(lockLog).not.toContain(e)
  expect(h.lockState.held).toBe(true)
})

test('only one process breaks a stale lock at a time: while another holds the break gate nothing is moved; a gate older than 30 seconds is broken by age alone', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.lockState = { held: true, owner: OWNER_DEAD, mtimeSec: T0 / 1000 }
  psDead.add('9999')
  h.gateHeld = { mtimeSec: h.nowMs / 1000 }
  expect(await settleCreate($)).toContain('store-busy')
  expect(lockLog).not.toContain('break')
  expect(h.gateHeld).toBeDefined()
  expect(h.lockState).toMatchObject({ held: true, owner: OWNER_DEAD })
  lockLog.length = 0
  h.gateHeld = { mtimeSec: h.nowMs / 1000 - 31 }
  expect(await settleCreate($, 600)).toContain('lane API created')
  expect(lockLog.filter((e) => e === 'break').length).toBe(1)
  expect(h.gateHeld).toBeUndefined()
})

test('a lock that is already gone when the breaker looks, or whose move fails, is not reported broken', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.lockState = { held: true, owner: OWNER_DEAD, mtimeSec: T0 / 1000 }
  psDead.add('9999')
  h.lockHook = (event) => {
    if (event === 'mkdir' && lockLog.filter((e) => e === 'mkdir').length === 1) h.lockState = { held: false }
  }
  expect(await settleCreate($, 600)).toContain('lane API created')
  expect(lockLog).not.toContain('break')
})

test('a stale lock that is re-taken by another stale owner at every try cannot keep the loop past its 2 seconds', async ($, on) => {
  await leadAt($, on, [])
  h.lockState = { held: true, owner: OWNER_DEAD, mtimeSec: T0 / 1000 }
  h.lockRehold = OWNER_DEAD
  psDead.add('9999')
  h.lockHook = (event) => {
    if (event === 'mkdir') h.nowMs += 300
  }
  expect(JSON.stringify(await callCreate($))).toContain('store-busy')
  expect(lockLog.filter((e) => e === 'mkdir').length).toBeLessThan(12)
})

test('an mkdir that fails for another reason than "File exists" gives up at once, with no wait', async ($, on) => {
  await leadAt($, on, [])
  h.lockMkdirErr = 'mkdir: /Users/x/.claude/callboard/lanes: Permission denied'
  expect(JSON.stringify(await callCreate($))).toContain('store-busy')
  expect(lockLog).toEqual(['mkdir'])
  expect(storeFiles.has(STOREFILE)).toBe(false)
})

test('a process with no registry entry of its own takes no lock: store-busy, nothing made', async ($, on) => {
  await leadAt($, on, [])
  h.ownEntryAuto = false
  h.sessions = {}
  expect(JSON.stringify(await callCreate($))).toContain('store-busy')
  expect(lockLog).toEqual([])
})

test('a lock is released only while its owner file still carries our nonce; a read that fails once is tried again', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins)
  h.lockOwnerWritten = ownerText(4400, 'someone-elses-nonce')
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  expect(lockLog).toEqual(['mkdir', 'owner-file', 'owner-write'])
  expect(h.lockState).toMatchObject({ held: true, owner: h.lockOwnerWritten })
  expect(logged(stdins)).toContain('error:lock-lost')
  h.lockState = { held: false }
  lockLog.length = 0
  h.lockOwnerWritten = undefined
  lockOwnerReads.push(ownerText(4400, 'garbled-first-read'))
  expect(JSON.stringify(await callCreate($, created({ name: 'SECOND', folder: `${PIN}/svc` })))).toContain('lane SECOND created')
  expect(lockLog).toEqual(LOCK_CYCLE)
  expect(h.lockState.held).toBe(false)
})

test('an unlock that throws is logged and does not replace the result of the edit', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins)
  h.lockRmThrows = true
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  expect(storeFiles.has(STOREFILE)).toBe(true)
  expect(logged(stdins)).toContain('error:unlock')
})

test('the lock is released after a refusal inside the critical section, and after a write that fails', async ($, on) => {
  await leadAt($, on, [])
  expect(JSON.stringify(await callCreate($, created({ name: 'has space' })))).toContain('bad-name')
  expect(h.lockState.held).toBe(false)
  h.storeWrites = 'fail'
  expect(JSON.stringify(await callCreate($))).toContain('write-failed')
  expect(h.lockState.held).toBe(false)
  h.storeWrites = 'ignore'
  expect(JSON.stringify(await callCreate($))).toContain('store-changed')
  expect(h.lockState.held).toBe(false)
  expect(lockLog.filter((e) => e === 'mkdir').length).toBe(lockLog.filter((e) => e === 'rmdir').length)
  expect(lockLog.filter((e) => e === 'mkdir').length).toBe(3)
})

test('the owner file names this process by its registry entry with a nonce, is written into the folder just made with install and tee, and the lock is never removed with rm -rf', async ($, on) => {
  const argv: string[][] = []
  await leadAt($, on, [], { argv })
  await callCreate($)
  const lock = `${LANESDIR}/.${KEY}.lock`
  const owner = JSON.parse(teeTexts.get(`${lock}/owner`)!)
  expect(owner).toMatchObject({ pid: 4400, procStart: LEADPS })
  expect(owner.nonce).toMatch(/^[0-9]+-[0-9]+-[a-z0-9]+$/)
  const mkdir = argv.find((a) => a[0] === '/bin/mkdir' && !a.includes('-p') && a[a.length - 1] === lock)!
  expect(mkdir).toEqual(['/bin/mkdir', '-m', '700', '--', lock])
  expect(argv).toContainEqual(['/usr/bin/install', '-m', '600', '/dev/null', `${lock}/owner`])
  expect(argv).toContainEqual(['/usr/bin/tee', '--', `${lock}/owner`])
  expect(argv).toContainEqual(['/bin/rm', '-f', '--', `${lock}/owner`])
  expect(argv).toContainEqual(['/bin/rmdir', '--', lock])
  expect(argv.some((a) => a[0] === '/bin/rm' && a.includes('-rf'))).toBe(false)
  expect(argv.some((a) => a[0] === '/bin/mv' && a.some((x) => x.startsWith(lock)))).toBe(false)
})

test('a removal (lane_terminate of a lane no live session carries) waits behind the lock like a create', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  h.lockState = { held: true, owner: OWNER_LIVE, mtimeSec: h.nowMs / 1000 }
  h.askAnswer = YES
  const p = $.tool.call(leadCall('terminate', { lane: 'API' }))
  for (let t = 0; t < 3000; t += 150) await h.clock!.advance(150)
  expect(JSON.stringify(await p)).toContain('store-busy')
  expect(storeLaneNames()).toEqual(['API'])
})

test('an attach waits behind the lock too, and says store-busy', async ($, on) => {
  await attacher($, on, [], { clock: true })
  h.lockState = { held: true, owner: OWNER_LIVE, mtimeSec: T0 / 1000 }
  const p = doLane($, 'lane svc-api')
  await new Promise((r) => setTimeout(r, 30))
  for (let t = 0; t < 3000; t += 150) await h.clock!.advance(150)
  expect((await p).text).toBe(refusalText('store-busy'))
  await noLaneWritten($)
})

test('a store that changes between the read and the write is not overwritten', async ($, on) => {
  await leadAt($, on, [])
  putStore([attRec(OTHERLEAD, 'OLD')])
  const before = storeFiles.get(STOREFILE)
  storeReads.push(before!, JSON.stringify({ repo: PIN, lanes: [], creates: [1] }))
  expect(JSON.stringify(await callCreate($))).toContain('store-changed')
  expect(storeFiles.get(STOREFILE)).toBe(before)
  expect(h.lockState.held).toBe(false)
})

test('the 16-lane cap is judged again inside the lock, on the store as it is then', async ($, on) => {
  await attacher($, on)
  const lanes = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `L${i}`, folder: PIN, brief: `${PIN}/B${i}.md`, createdAt: 1 }))
  putStore(lanes(15))
  const full = JSON.stringify({ repo: PIN, lanes: lanes(16), creates: [] })
  storeReads.push(full, full)
  expect((await doLane($, 'lane svc-api')).text).toBe(refusalText('lane-cap'))
  expect(JSON.parse(storeFiles.get(STOREFILE)!).lanes.length).toBe(15)
  expect(h.lockState.held).toBe(false)
})

test('a lock whose owner file cannot be written is given up at once: store-busy, and the lock is not left behind', async ($, on) => {
  await leadAt($, on, [])
  h.lockOwnerFails = true
  expect(JSON.stringify(await callCreate($))).toContain('store-busy')
  expect(h.lockState.held).toBe(false)
  expect(lockLog).toEqual(LOCK_CYCLE)
})

test('a lock taken while the registry cannot be read is refused registry-unreadable, not store-busy', async ($, on) => {
  await leadAt($, on, [], { sess: { ...leadSelfReg(), ...ATTSESS() } })
  regFacts.set('4500.json', { failHead: 2 })
  const r = JSON.stringify(await callCreate($))
  expect(r).toContain('could not read the session list')
  expect(r).not.toContain('store-busy')
  expect(lockLog).toEqual([])
})

test('a break gate that cannot be looked at after it was made is left to its age, and says so', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true })
  h.lockState = { held: true, owner: OWNER_DEAD, mtimeSec: T0 / 1000 }
  psDead.add('9999')
  h.gateStatFails = true
  expect(await settleCreate($, 300)).toContain('lane API created')
  expect(h.gateHeld).toBeDefined()
  expect(lockLog).not.toContain('gate-release')
  expect(logged(stdins)).toContain('error:lock-gate')
})

test('a release that could not be confirmed is retried from the tick until it succeeds', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true })
  lockOwnerReads.push(undefined, undefined)
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  expect(h.lockState.held).toBe(true)
  expect(logged(stdins)).toContain('error:lock-unconfirmed')
  await h.clock!.advance(2000)
  expect(h.lockState.held).toBe(false)
  expect(lockLog.slice(-2)).toEqual(['rm-owner', 'rmdir'])
  lockLog.length = 0
  await h.clock!.advance(2000)
  expect(lockLog).toEqual([])
})

test('a release that finds another holder is dropped and removes nothing', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true })
  lockOwnerReads.push(undefined, undefined)
  await callCreate($)
  const theirs = ownerText(4242, 'their-nonce-0003')
  h.lockState = { held: true, owner: theirs, mtimeSec: Math.floor(h.nowMs / 1000), ino: 14 }
  await tickTwice()
  expect(h.lockState).toMatchObject({ held: true, owner: theirs })
  expect(lockLog).not.toContain('rm-owner')
  expect(lockLog.filter((e) => e === 'rmdir').length).toBe(0)
  await ticks(32)
  expect(logged(stdins)).not.toContain('error:unlock-gave-up')
})

test('a release that stays unconfirmed is given up after 30 tries', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true })
  for (let i = 0; i < 40; i++) lockOwnerReads.push(undefined)
  await callCreate($)
  expect(h.lockState.held).toBe(true)
  await ticks(31)
  expect(logged(stdins)).toContain('error:unlock-gave-up')
  expect(h.lockState.held).toBe(true)
})

test('a moved lock folder is not put back over a lock that was made again meanwhile: it stays aside and is logged', async ($, on) => {
  const stdins: string[] = []
  await leadAt($, on, stdins, { clock: true })
  h.lockState = { held: true, owner: OWNER_DEAD, mtimeSec: T0 / 1000 }
  h.lockOwnerAfterMove = ownerText(4242, 'their-nonce-0002')
  psDead.add('9999')
  const fresh = ownerText(4242, 'new-holder-0001')
  h.lockHook = (event) => {
    if (event === 'break') h.lockState = { held: true, owner: fresh, mtimeSec: Math.floor(h.nowMs / 1000), ino: 40 }
  }
  expect(await settleCreate($)).toContain('store-busy')
  expect(lockLog).not.toContain('put-back')
  expect(logged(stdins)).toContain('error:lock-aside')
  expect(h.lockState).toMatchObject({ held: true, owner: fresh })
})

test('the break gate is removed only while it is still the folder this call made', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  h.lockState = { held: true, owner: OWNER_DEAD, mtimeSec: T0 / 1000 }
  psDead.add('9999')
  h.lockHook = (event) => {
    if (event === 'break') h.gateHeld = { mtimeSec: Math.floor(h.nowMs / 1000), ino: 77 }
  }
  expect(await settleCreate($, 300)).toContain('lane API created')
  expect(h.gateHeld).toMatchObject({ ino: 77 })
  expect(lockLog).not.toContain('gate-release')
})

test('the lock mkdir runs with a fixed locale, so its "File exists" cannot be translated', async ($, on) => {
  await leadAt($, on, [])
  await callCreate($)
  expect(h.lockMkdirEnv).toEqual({ LC_ALL: 'C' })
})

test('a lock folder that was replaced, or touched, while its owner was read is not judged stale on the old look', async ($, on) => {
  await leadAt($, on, [], { clock: true })
  const old = () => Math.floor(h.nowMs / 1000) - 11
  h.lockState = { held: true, mtimeSec: old(), ino: 14 }
  let n = 0
  h.lockHook = (event) => {
    if (event === 'owner-stat' && n++ === 0) h.lockState = { held: true, mtimeSec: Math.floor(h.nowMs / 1000), ino: 99 }
  }
  expect(await settleCreate($)).toContain('store-busy')
  expect(lockLog).not.toContain('break')
  lockLog.length = 0
  h.lockState = { held: true, mtimeSec: old(), ino: 14 }
  n = 0
  h.lockHook = (event) => {
    if (event === 'owner-stat' && n++ === 0) h.lockState = { held: true, mtimeSec: Math.floor(h.nowMs / 1000), ino: 14 }
  }
  expect(await settleCreate($)).toContain('store-busy')
  expect(lockLog).not.toContain('break')
  lockLog.length = 0
  h.lockState = { held: true, mtimeSec: old(), ino: 14 }
  n = 0
  h.lockHook = (event) => {
    if (event === 'owner-stat' && n++ === 0) h.lockState = { held: true, mtimeSec: old(), ino: 99 }
  }
  expect(await settleCreate($, 600)).toContain('lane API created')
  expect(lockLog.filter((e) => e === 'break').length).toBe(1)
  expect(lockLog).not.toContain('put-back')
})

test('a store rewrite keeps a record whose folder check failed and drops one whose folder is gone', async ($, on) => {
  const stdins: string[] = []
  await creator($, on, stdins)
  extraStat.set(`${PIN}/svc`, dirStat)
  expect(JSON.stringify(await callCreate($, created({ name: 'SVC', folder: `${PIN}/svc` })))).toContain('lane SVC created')
  // Every check of that folder fails during this create (the lane list read and the rewrite).
  realFails.set(`${PIN}/svc`, { n: 99, err: 'realpath: Operation timed out' })
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  realFails.delete(`${PIN}/svc`)
  expect(storeLaneNames().sort()).toEqual(['API', 'SVC'])
  expect(logged(stdins)).toContain('error:store-check')
  dropRec('API')
  realFails.set(`${PIN}/svc`, { n: 99, err: `realpath: ${PIN}/svc: No such file or directory` })
  expect(JSON.stringify(await callCreate($))).toContain('lane API created')
  expect(storeLaneNames()).toEqual(['API'])
})
