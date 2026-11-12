// Proves that the mod tests moved from one big cases file into topic files without a test, an assertion or a test body changing.
//   git show <old commit>:tools/callboard/mod/test/mod.cases.ts > /tmp/old-cases.ts
//   node tools/callboard/check-test-move.mjs /tmp/old-cases.ts [test dir]
// The test dir defaults to mod/test beside this script; it holds harness.ts (the state object `h`) and the *.test.ts topic files.
// Checked, each as a multiset, so the order of tests across files does not matter:
//   1. the number of test( and longTest( declarations;
//   2. every line that holds expect( (the assertions);
//   3. every line inside a test body.
// A line is compared after the state prefix is dropped (`h.sessions` reads as `sessions`) and the quiet-stretch helper reads as the
// clock advance it stands for (`advanceQuiet(` as `clock!.advance(`). Exit 0 when all three are equal, 1 with the differing lines
// otherwise, 2 on a bad argument. It is a one-off proof for that move, kept so the claim can be rerun; it is not part of test.sh.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [oldPath, dirArg] = process.argv.slice(2)
if (!oldPath) {
  console.error('usage: node check-test-move.mjs <old cases file> [test dir]')
  process.exit(2)
}
const dir = dirArg ?? join(dirname(fileURLToPath(import.meta.url)), 'mod/test')
const oldText = readFileSync(oldPath, 'utf8')
const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort()
const newTexts = files.map((f) => readFileSync(join(dir, f), 'utf8'))

// The state names: the entries of the exported object in harness.ts.
const harness = readFileSync(join(dir, 'harness.ts'), 'utf8')
const objStart = harness.indexOf('export const h = {')
const objEnd = harness.indexOf('\n}\n', objStart)
if (objStart < 0 || objEnd < 0) {
  console.error('harness.ts has no `export const h = {` object')
  process.exit(2)
}
const keys = [...harness.slice(objStart, objEnd).matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])
const stateRe = new RegExp(`\\bh\\.(${keys.join('|')})\\b`, 'g')
const norm = (line) => line.trim().replace(stateRe, '$1').replace(/\badvanceQuiet\(/g, 'clock!.advance(').replace(/\bclock!\.advance\(/g, 'ADVANCE(').replace(/\blongTest\(/g, 'test(')

const declRe = /^(\s*)(?:long)?[tT]est\(/
function scan(text) {
  const lines = text.split('\n')
  const out = { tests: 0, asserts: [], bodies: [] }
  for (let i = 0; i < lines.length; i++) {
    const m = declRe.exec(lines[i])
    if (!m) continue
    out.tests++
    if (!/\{\s*$/.test(lines[i])) continue // a test written on one line has no body to compare
    const close = `${m[1]}})`
    let j = i + 1
    while (j < lines.length && lines[j] !== close) j++
    if (j === lines.length) throw new Error(`no end for the test at line ${i + 1}`)
    for (let k = i + 1; k < j; k++) {
      const n = norm(lines[k])
      out.bodies.push(n)
      if (/\bexpect\(/.test(lines[k])) out.asserts.push(n)
    }
    i = j
  }
  return out
}
const before = scan(oldText)
const after = newTexts.map(scan).reduce((a, s) => ({ tests: a.tests + s.tests, asserts: a.asserts.concat(s.asserts), bodies: a.bodies.concat(s.bodies) }), { tests: 0, asserts: [], bodies: [] })

function diff(a, b) {
  const count = new Map()
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1)
  for (const x of b) count.set(x, (count.get(x) ?? 0) - 1)
  return [...count].filter(([, n]) => n !== 0)
}
let bad = 0
const report = (what, a, b) => {
  const d = diff(a, b)
  console.log(`${what}: ${a.length} before, ${b.length} after, ${d.length === 0 ? 'equal' : `${d.length} lines differ`}`)
  for (const [line, n] of d.slice(0, 20)) console.log(`  ${n > 0 ? 'only before' : 'only after'} (${Math.abs(n)}x): ${line.slice(0, 140)}`)
  if (d.length) bad = 1
}
console.log(`test declarations: ${before.tests} before, ${after.tests} after, ${files.length} files`)
if (before.tests !== after.tests) bad = 1
report('assertion lines', before.asserts, after.asserts)
report('test body lines', before.bodies, after.bodies)
const moved = newTexts.join('\n').split('\n').filter((l) => /\badvanceQuiet\(/.test(l)).length
console.log(`quiet stretches jumped: ${moved} advance lines`)
process.exit(bad)
