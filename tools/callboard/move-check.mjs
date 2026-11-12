#!/usr/bin/env node
// Checks that a split of the callboard mod's hooks module is a move and nothing else.
//
// usage: node move-check.mjs <old hooks dir> <new hooks dir>
//   old: a folder whose register.ts is the single-file module; new: the folder holding register.ts, mem.ts and engine/*.ts.
// exit codes: 0 every check passed, 1 a difference was found (each is printed), 2 usage error or unreadable input.
//
// It extracts every top-level declaration of the old register.ts by name (functions, constants, types, the `let`s, the `$.state` key
// constants) and every hook body of its register function, finds the same name in the new files, and fails on any byte difference once the
// five allowed form changes are undone:
//   1. a top-level const arrow that takes `$` became a function declaration (`export function`, `return` for an expression body);
//   2. a module-level `let` became a property of the `mem` holder in mem.ts (references read `mem.name`);
//   3. a local captured by a hook closure (the loop's `verb`) became a parameter of the named hook function;
//   4. import and export plumbing (`.ts` specifiers, `export` on what another file imports);
//   5. a `$.state` key constant is declared again in each file that uses it.
// Comments are compared as a multiset of lines (they move with their code; a file's own header and the one key-constant comment are the only
// additions). Indentation is compared exactly for top-level declarations; a hook body is compared line by line without its leading
// whitespace, after checking that it holds no template literal that spans lines.
import fs from 'node:fs'
import path from 'node:path'

const [oldDir, newDir] = process.argv.slice(2)
if (!oldDir || !newDir) { console.error('usage: node move-check.mjs <old hooks dir> <new hooks dir>'); process.exit(2) }

// ---------------------------------------------------------------- scanner (masks comments, strings, template text, regex literals)
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await'])
function mask(src) {
  const out = src.split('')
  const n = src.length
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ' }
  const stack = []
  let i = 0, prevSig = '', prevWord = ''
  const tpl = (start) => {
    let k = start
    while (k < n) {
      const ch = src[k]
      if (ch === '\\') { out[k] = ' '; if (out[k + 1] !== '\n') out[k + 1] = ' '; k += 2; continue }
      if (ch === '`') return { end: k + 1, expr: false }
      if (ch === '$' && src[k + 1] === '{') { out[k] = ' '; out[k + 1] = ' '; return { end: k + 2, expr: true } }
      if (ch !== '\n') out[k] = ' '
      k++
    }
    throw new Error('unterminated template')
  }
  while (i < n) {
    const ch = src[i], two = src.slice(i, i + 2)
    if (two === '//') { let e = src.indexOf('\n', i); if (e < 0) e = n; blank(i, e); i = e; continue }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); blank(i, e + 2); i = e + 2; continue }
    if (ch === "'" || ch === '"') { let k = i + 1; while (k < n && src[k] !== ch) { if (src[k] === '\\') k++; k++ } blank(i + 1, k); i = k + 1; prevSig = ch; prevWord = ''; continue }
    if (ch === '`') { const r = tpl(i + 1); if (r.expr) stack.push({ depth: 0 }); i = r.end; prevSig = r.expr ? '{' : '`'; prevWord = ''; continue }
    if (ch === '{' && stack.length) { stack[stack.length - 1].depth++; i++; prevSig = '{'; prevWord = ''; continue }
    if (ch === '}' && stack.length) {
      const top = stack[stack.length - 1]
      if (top.depth === 0) { stack.pop(); out[i] = ' '; const r = tpl(i + 1); if (r.expr) stack.push({ depth: 0 }); i = r.end; prevSig = r.expr ? '{' : '`'; prevWord = ''; continue }
      top.depth--; i++; prevSig = '}'; prevWord = ''; continue
    }
    if (ch === '/' && (prevSig === '' || REGEX_PREV.has(prevSig) || KW_BEFORE_REGEX.has(prevWord))) {
      let k = i + 1, cls = false
      while (k < n) { const d = src[k]; if (d === '\\') { k += 2; continue } if (cls) { if (d === ']') cls = false } else if (d === '[') cls = true; else if (d === '/') break; k++ }
      blank(i + 1, k); k++
      while (k < n && /[a-z]/.test(src[k])) k++
      i = k; prevSig = '/'; prevWord = ''; continue
    }
    if (/[A-Za-z_$]/.test(ch)) { let k = i + 1; while (k < n && /[\w$]/.test(src[k])) k++; prevWord = src.slice(i, k); prevSig = 'a'; i = k; continue }
    if (/\s/.test(ch)) { i++; continue }
    if (/[0-9]/.test(ch)) { let k = i + 1; while (k < n && /[\w.]/.test(src[k])) k++; prevSig = '0'; prevWord = ''; i = k; continue }
    prevSig = ch; prevWord = ''; i++
  }
  return out.join('')
}
function matchBracket(m, open) {
  const o = m[open], cl = { '(': ')', '{': '}', '[': ']' }[o]
  let d = 0
  for (let i = open; i < m.length; i++) { if (m[i] === o) d++; else if (m[i] === cl) { d--; if (d === 0) return i } }
  throw new Error('no matching bracket')
}
// A template literal whose text spans lines: its content would change if a body were re-indented.
function hasMultilineTemplate(src) {
  const m = mask(src)
  // masked template text is blanks; find backtick-delimited stretches in the raw text outside comments/strings by comparing
  let i = 0
  while (i < src.length) {
    if (src[i] === '`' && m[i] === '`') {
      let k = i + 1
      let depth = 0
      let multi = false
      while (k < src.length) {
        if (src[k] === '\\') { k += 2; continue }
        if (depth === 0 && src[k] === '`') break
        if (src[k] === '$' && src[k + 1] === '{') depth++
        if (depth > 0 && src[k] === '}') depth--
        if (depth === 0 && src[k] === '\n') multi = true
        k++
      }
      if (multi) return true
      i = k + 1
    } else i++
  }
  return false
}

// ---------------------------------------------------------------- chunker: top-level declarations with their comment preamble
function chunk(text) {
  const lines = text.split('\n')
  const isStart = (l) => l.length > 0 && !/^[\s})\]`]/.test(l) && !/^\/\//.test(l) && !/^\/\*/.test(l)
  const starts = []
  lines.forEach((l, i) => { if (isStart(l)) starts.push(i) })
  const res = []
  let prevEnd = -1
  const header = []
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]
    const nextS = k + 1 < starts.length ? starts[k + 1] : lines.length
    let j = nextS - 1
    while (j > s && (lines[j] === '' || /^\/\//.test(lines[j]))) j--
    let ps = prevEnd + 1
    while (ps < s && lines[ps] === '') ps++
    const pre = lines.slice(ps, s)
    const decl = lines.slice(s, j + 1).join('\n')
    const head = lines[s]
    let kind, name, m
    if ((m = /^(?:export )?(?:async )?function\s+(\w+)/.exec(head))) { kind = 'function'; name = m[1] }
    else if ((m = /^(?:export )?const\s+(\w+)/.exec(head))) { kind = 'const'; name = m[1] }
    else if ((m = /^let\s+(\w+)/.exec(head))) { kind = 'let'; name = m[1] }
    else if ((m = /^(?:export )?type\s+(\w+)/.exec(head))) { kind = 'type'; name = m[1] }
    else if (/^import /.test(head)) { kind = 'import'; name = head }
    else throw new Error('unrecognised top-level line: ' + head.slice(0, 60))
    res.push({ kind, name, pre, decl })
    prevEnd = j
  }
  return res
}
const stripExport = (t) => (t.startsWith('export ') ? t.slice(7) : t)
const norm = (l) => l.trim()
const commentLines = (pre) => pre.map(norm).filter((l) => l !== '')

// ---------------------------------------------------------------- inputs
const readF = (p) => fs.readFileSync(p, 'utf8')
let oldSrc, newFiles = {}
try {
  oldSrc = readF(path.join(oldDir, 'register.ts'))
  newFiles['register.ts'] = readF(path.join(newDir, 'register.ts'))
  newFiles['mem.ts'] = readF(path.join(newDir, 'mem.ts'))
  for (const f of fs.readdirSync(path.join(newDir, 'engine')).filter((x) => x.endsWith('.ts')).sort()) newFiles['engine/' + f] = readF(path.join(newDir, 'engine', f))
} catch (e) { console.error('cannot read input: ' + e.message); process.exit(2) }

const problems = []
const fail = (m) => problems.push(m)

const oldChunks = chunk(oldSrc)
const newChunksByFile = {}
for (const [f, t] of Object.entries(newFiles)) newChunksByFile[f] = chunk(t)

// ---------------------------------------------------------------- old register function: statements
const regOld = oldChunks.find((c) => c.name === 'register')
const regLines = (regOld.pre.join('\n') + '\n' + regOld.decl).split('\n')
const regStart = regLines.findIndex((l) => l.startsWith('export const register'))
const oldStmts = []
{
  const body = regLines.slice(regStart + 1, regLines.length - 1)
  const starts = []
  body.forEach((l, i) => { if (/^  [^\s})\]\/]/.test(l)) starts.push(i) })
  let carry = body.slice(0, starts[0])
  starts.forEach((s0, k) => {
    const e0 = k + 1 < starts.length ? starts[k + 1] : body.length
    let seg = body.slice(s0, e0)
    let cut = seg.length
    while (cut > 1 && (/^\s*$/.test(seg[cut - 1]) || /^  \/\//.test(seg[cut - 1]))) cut--
    oldStmts.push({ pre: carry, text: seg.slice(0, cut).join('\n') })
    carry = seg.slice(cut)
  })
}
// new register function statements: same split
const regNewChunk = newChunksByFile['register.ts'].find((c) => c.name === 'register')
const newStmts = []
{
  const lines = regNewChunk.decl.split('\n')
  const body = lines.slice(1, lines.length - 1)
  const starts = []
  body.forEach((l, i) => { if (/^  [^\s})\]\/]/.test(l)) starts.push(i) })
  starts.forEach((s0, k) => {
    const e0 = k + 1 < starts.length ? starts[k + 1] : body.length
    let seg = body.slice(s0, e0)
    let cut = seg.length
    while (cut > 1 && /^\s*$/.test(seg[cut - 1])) cut--
    newStmts.push(seg.slice(0, cut).join('\n'))
  })
}

// ---------------------------------------------------------------- allowed form 1: const arrow taking $ -> function declaration
function arrowToFn(decl) {
  const mk = mask(decl)
  const m = /^const (\w+) = (async )?(<[^>]*>)?\(/.exec(mk)
  const open = mk.indexOf('(', m[0].length - 1)
  const close = matchBracket(mk, open)
  let k = close + 1
  while (/\s/.test(mk[k])) k++
  let ret = ''
  if (mk[k] === ':') { const a = mk.indexOf('=>', k); ret = decl.slice(k, a).trimEnd(); k = a }
  k += 2
  while (/\s/.test(mk[k])) k++
  const head = `${m[2] ? 'async ' : ''}function ${m[1]}${m[3] || ''}${decl.slice(open, close + 1)}${ret}`
  if (mk[k] === '{') return head + ' ' + decl.slice(k)
  return `${head} {\n  return ${decl.slice(k).trimEnd()}\n}`
}

// ---------------------------------------------------------------- allowed form 2: lets in mem.ts
const oldLets = oldChunks.filter((c) => c.kind === 'let')
const LETS = oldLets.map((c) => c.name)
const memChunks = newChunksByFile['mem.ts']
const memHolder = memChunks.find((c) => c.name === 'mem')
const holderProps = {}
const holderComments = []
{
  const ls = memHolder.decl.split('\n')
  if (ls[0] !== 'export const mem = {' || ls[ls.length - 1] !== '}') fail('mem holder has an unexpected shape')
  for (const l of ls.slice(1, -1)) {
    if (/^\s*\/\//.test(l)) { holderComments.push(norm(l)); continue }
    if (l.trim() === '') continue
    const m = /^  (\w+): (.*),$/.exec(l)
    if (!m) { fail('mem holder line not a one-line property: ' + l); continue }
    holderProps[m[1]] = m[2]
  }
}
for (const l of oldLets) {
  const m = /^let (\w+)(?:: (.+?))?(?: = (.+))?$/s.exec(l.decl)
  const [, name, type, init] = m
  const want = init !== undefined ? (type ? `${init} as ${type}` : init) : `undefined as ${type}`
  if (holderProps[name] !== want) fail(`let ${name}: holder has ${JSON.stringify(holderProps[name])}, expected ${JSON.stringify(want)}`)
}
for (const p of Object.keys(holderProps)) if (!LETS.includes(p)) fail(`mem holder has a property that is no old let: ${p}`)

// ---------------------------------------------------------------- compare declarations by name
const KEY_RE = /^const (\w+) = \{ plugin: 'callboard', key: '(\w+)' \} as const$/
const newByName = new Map()
const newFileOf = new Map()
for (const [f, cs] of Object.entries(newChunksByFile)) {
  for (const c of cs) {
    if (c.kind === 'import' || c.name === 'register' || c.name === 'mem') continue
    if (KEY_RE.test(c.decl.split('\n')[0])) continue
    if (newByName.has(c.name)) { fail(`name ${c.name} declared in ${newFileOf.get(c.name)} and ${f}`); continue }
    newByName.set(c.name, c)
    newFileOf.set(c.name, f)
  }
}
const ARROW_DOLLAR = /^const \w+ = (async )?\(\$/
const oldNames = new Set()
const stats = { functions: 0, consts: 0, types: 0, arrows: 0, lets: oldLets.length, keys: 0, maps: 0 }
const oldPre = []
const movedPre = []
const preOfNew = new Map()
const keyOld = new Map()
for (const c of oldChunks) {
  if (c.kind === 'import' || c.name === 'register') continue
  oldPre.push(...commentLines(c.pre))
  if (c.kind === 'let') continue
  const first = c.decl.split('\n')[0]
  if (KEY_RE.test(first)) { keyOld.set(c.name, c); continue }
  oldNames.add(c.name)
  const n = newByName.get(c.name)
  if (!n) { fail(`missing in the new files: ${c.kind} ${c.name}`); continue }
  let expected = c.decl
  if (ARROW_DOLLAR.test(first)) { expected = arrowToFn(c.decl); stats.arrows++ }
  else if (c.kind === 'function') stats.functions++
  else if (c.kind === 'type') stats.types++
  else if (/^const \w+(?:: [^=]+)? = new (Map|Set)(<.*>)?\(\)\s*$/.test(c.decl)) stats.maps++
  else stats.consts++
  // undo form 2: mem.<let> -> <let>
  let got = stripExport(n.decl).replace(new RegExp(`\\bmem\\.(${LETS.join('|')})\\b`, 'g'), '$1')
  if (/\bmem\b/.test(mask(c.decl))) fail(`${c.name}: the old text already uses the name mem`)
  if (got !== expected) {
    const a = expected.split('\n'), b = got.split('\n')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    fail(`${c.name}: differs at line ${i + 1}:\n    old: ${a[i]?.slice(0, 160)}\n    new: ${b[i]?.slice(0, 160)}  (in ${newFileOf.get(c.name)})`)
  }
  // a let that the old chunk shadows locally must not be rewritten
  for (const l of LETS) {
    const decl = new RegExp(`\\b(const|let|var)\\s+${l}\\b|(\\(|,\\s*)${l}\\??\\s*:\\s*[A-Za-z{\\[]`).test(mask(c.decl))
    if (decl && new RegExp(`\\bmem\\.${l}\\b`).test(n.decl)) fail(`${c.name}: declares a local ${l} and the new text reads mem.${l}`)
  }
  const pre = commentLines(n.pre), was = commentLines(c.pre)
  if (pre.join('\n') !== was.join('\n')) movedPre.push(c.name)
}
for (const [name, n] of newByName) if (!oldNames.has(name) && !HOOK_NAMES()) { /* hook functions are checked below */ }
function HOOK_NAMES() { return false }

// ---------------------------------------------------------------- key constants: each file declares its own, byte equal to the old one
for (const [f, cs] of Object.entries(newChunksByFile)) {
  for (const c of cs) {
    if (c.kind !== 'const') continue
    const first = c.decl.split('\n')[0]
    if (!KEY_RE.test(first)) continue
    const o = keyOld.get(c.name)
    if (!o) { fail(`${f}: key constant ${c.name} is not an old one`); continue }
    if (o.decl !== c.decl) fail(`${f}: key constant ${c.name} differs`)
    stats.keys++
  }
}
for (const [f, t] of Object.entries(newFiles)) {
  const m = mask(t)
  for (const [name] of keyOld) {
    const used = new RegExp(`\\$\\.state\\.\\w+\\(\\s*${name}\\b`).test(m)
    const declared = newChunksByFile[f].some((c) => c.name === name && KEY_RE.test(c.decl.split('\n')[0]))
    if (used && !declared) fail(`${f}: uses state key ${name} without declaring it`)
  }
}

// ---------------------------------------------------------------- hooks
function findLambda(text, from) {
  const m = mask(text)
  const re = /async \(\$, e, next\) =>/g
  re.lastIndex = from
  const lm = re.exec(m)
  if (!lm) return undefined
  const start = lm.index
  let k = start + lm[0].length
  while (m[k] === ' ') k++
  return { m, start, bodyStart: k, arrowEnd: start + lm[0].length }
}
const newFnByName = new Map()
for (const [name, c] of newByName) if (c.kind === 'function') newFnByName.set(name, c)
const usedNew = new Set()
if (oldStmts.length !== newStmts.length) fail(`register statements: ${oldStmts.length} old, ${newStmts.length} new`)
const hookReport = []
oldStmts.forEach((st, idx) => {
  const ns = newStmts[idx]
  if (ns === undefined) return
  const raw = st.text
  const m = mask(raw)
  const onIdx = m.search(/\bon\(/)
  const closeP = matchBracket(m, onIdx + 2)
  const lam = findLambda(raw, onIdx)
  if (!lam || lam.start > closeP) {
    // by reference already: the statement is unchanged
    if (ns !== raw) fail(`statement ${idx + 1} (${raw.slice(0, 50)}) changed`)
    return
  }
  const isLoop = /^ *for \(/.test(raw)
  const onIndent = raw.match(/^ */)[0].length
  // body of the lambda
  let lamEnd, bodyKind, bodyText
  if (m[lam.bodyStart] === '{') {
    const close = matchBracket(m, lam.bodyStart)
    lamEnd = close + 1
    bodyKind = 'block'
    bodyText = raw.slice(lam.bodyStart + 1, close)
  } else { lamEnd = closeP; bodyKind = 'expr'; bodyText = raw.slice(lam.bodyStart, lamEnd) }
  // new statement = old prefix + ref + old suffix
  const prefix = raw.slice(0, lam.start), suffix = raw.slice(lamEnd)
  let suffixOld = suffix
  // the stop loop's catch lambda is a second lambda after the on() call
  const lam2 = findLambda(suffix, 0)
  let catchBody
  let suffixPattern = suffix
  if (lam2 && /^\s*\)?\.catch\(\s*async/.test(suffix.slice(0, lam2.start + 8).replace(/\n/g, ' ')) ) {
    const m2 = lam2.m
    if (m2[lam2.bodyStart] !== '{') fail(`statement ${idx + 1}: catch lambda is not a block`)
    const close2 = matchBracket(m2, lam2.bodyStart)
    catchBody = suffix.slice(lam2.bodyStart + 1, close2)
    suffixPattern = { before: suffix.slice(0, lam2.start), after: suffix.slice(close2 + 1) }
  }
  if (!ns.startsWith(prefix)) { fail(`statement ${idx + 1}: wiring prefix differs`); return }
  let mid
  if (typeof suffixPattern === 'string') {
    if (!ns.endsWith(suffixPattern)) { fail(`statement ${idx + 1}: wiring suffix differs`); return }
    mid = ns.slice(prefix.length, ns.length - suffixPattern.length)
  } else {
    const sp = suffixPattern
    const i1 = ns.indexOf(sp.before, prefix.length)
    if (i1 < 0 || !ns.endsWith(sp.after)) { fail(`statement ${idx + 1}: wiring suffix differs`); return }
    mid = ns.slice(prefix.length, i1)
    const catchRef = ns.slice(i1 + sp.before.length, ns.length - sp.after.length)
    var catchWire = catchRef
  }
  // mid is the reference: NAME, or an arrow that forwards the parameters
  const refM = /^(\w+)$|^\(\$, e(?:, next)?\) => (\w+)\(\$, e(?:, next)?(?:, (verb))?\)$/.exec(mid)
  if (!refM) { fail(`statement ${idx + 1}: handler reference has an unexpected shape: ${mid}`); return }
  const fname = refM[1] || refM[2]
  const fn = newFnByName.get(fname)
  if (!fn) { fail(`hook function ${fname} not found`); return }
  usedNew.add(fname)
  // signature
  const sigM = /^export async function (\w+)\(\$: any, e: any(?:, next: any)?(?:, verb: (\(typeof c\.(?:LEAD_VERBS|STOP_VERBS)\)\[number\]))?\) \{$/.exec(fn.decl.split('\n')[0])
  if (!sigM) fail(`${fname}: unexpected signature ${fn.decl.split('\n')[0]}`)
  if (isLoop !== (refM[3] === 'verb')) fail(`${fname}: loop variable is ${isLoop ? '' : 'not '}passed`)
  if (isLoop) {
    const want = `(typeof c.${/c\.(LEAD_VERBS|STOP_VERBS)/.exec(raw)[1]})[number]`
    if (sigM && sigM[2] !== want) fail(`${fname}: verb type ${sigM && sigM[2]}, expected ${want}`)
  }
  // body comparison
  const fl = fn.decl.split('\n')
  const fbody = fl.slice(1, -1)
  let oldBody
  if (bodyKind === 'block') { const il = bodyText.split('\n'); oldBody = il.slice(1, -1) } else { const el = bodyText.split('\n'); oldBody = ['return ' + el[0], ...el.slice(1)] }
  const A = oldBody.map(norm), B = fbody.map(norm)
  if (A.join('\n') !== B.join('\n')) {
    let i = 0
    while (i < A.length && i < B.length && A[i] === B[i]) i++
    fail(`${fname}: body differs at line ${i + 1}:\n    old: ${A[i]?.slice(0, 160)}\n    new: ${B[i]?.slice(0, 160)}`)
  }
  if (hasMultilineTemplate(bodyText)) fail(`${fname}: the old body holds a template literal that spans lines (re-indenting would change it)`)
  // comments before the statement move with the function
  const want = commentLines(st.pre), got = commentLines(fn.pre)
  if (want.join('\n') !== got.join('\n')) fail(`${fname}: preamble comments differ`)
  oldPre.push(...want)
  hookReport.push(fname)
  if (catchBody !== undefined) {
    const cm = /^\(\$, e, next\) => (\w+)\(\$, e, next, verb\)$/.exec(catchWire || '')
    if (!cm) { fail(`statement ${idx + 1}: catch reference has an unexpected shape: ${catchWire}`); return }
    const cfn = newFnByName.get(cm[1])
    if (!cfn) { fail(`catch function ${cm[1]} not found`); return }
    usedNew.add(cm[1])
    const A2 = catchBody.split('\n').slice(1, -1).map(norm), B2 = cfn.decl.split('\n').slice(1, -1).map(norm)
    if (A2.join('\n') !== B2.join('\n')) fail(`${cm[1]}: body differs`)
    if (hasMultilineTemplate(catchBody)) fail(`${cm[1]}: multi-line template literal`)
    hookReport.push(cm[1])
  }
})
// every new function the old file does not have is a hook function reached above
for (const [name] of newByName) if (!oldNames.has(name) && !usedNew.has(name)) fail(`new top-level name with no old counterpart: ${name}`)
// the set of names must match exactly
for (const n of oldNames) if (!newByName.has(n)) fail(`old name missing: ${n}`)

// ---------------------------------------------------------------- comments: multiset of preamble lines
{
  const newPre = []
  for (const [f, cs] of Object.entries(newChunksByFile)) for (const c of cs) {
    if (c.kind === 'import') continue
    if (c.name === 'mem') { newPre.push(...holderComments); continue }
    if (c.name === 'register') continue
    newPre.push(...commentLines(c.pre))
  }
  const count = (a) => { const m = new Map(); for (const x of a) m.set(x, (m.get(x) || 0) + 1); return m }
  const a = count(oldPre), b = count(newPre)
  const KEYNOTE = '// $.state keys declared again where they are used: `claude plugin validate` reads a key in the file that uses it.'
  const extraAllowed = new Map([[KEYNOTE, Infinity]])
  for (const [k, v] of a) if ((b.get(k) || 0) < v) fail(`comment line lost: ${k.slice(0, 140)}`)
  for (const [k, v] of b) {
    const had = a.get(k) || 0
    // key constants are repeated per file, with their comment only in one
    if (v > had && !(extraAllowed.has(k))) {
      const isKeyComment = [...keyOld.values()].some((c) => commentLines(c.pre).includes(k))
      if (!isKeyComment) fail(`comment line added or repeated: ${k.slice(0, 140)} (${v} vs ${had})`)
    }
  }
}

// ---------------------------------------------------------------- structure of the new files
for (const [f, t] of Object.entries(newFiles)) {
  const cs = newChunksByFile[f]
  const imps = cs.filter((c) => c.kind === 'import')
  for (const i of imps) {
    const spec = /from '([^']+)'/.exec(i.decl)?.[1]
    if (!spec) { fail(`${f}: import without a specifier`); continue }
    if (!/\.ts$/.test(spec) && !/\/types$/.test(spec) && spec !== 'claude-code') fail(`${f}: import specifier without .ts: ${spec}`)
    if (f === 'mem.ts' && /engine\//.test(spec)) fail('mem.ts imports an engine file')
    if (/^import \* as/.test(i.decl) && /engine|mem/.test(spec)) fail(`${f}: namespace import of an engine file`)
  }
  if (/\bimport\(/.test(mask(t))) fail(`${f}: dynamic import`)
  const header = t.split('\n').slice(0, 3).filter((l) => l.startsWith('//'))
  if (header.length < 1 || header.length > 3) fail(`${f}: needs a 1-3 line comment header`)
  // module-level constants may not read another engine file's value at load time
  if (f !== 'register.ts') {
    const imported = new Set()
    for (const i of imps) { const spec = /from '([^']+)'/.exec(i.decl)?.[1]; if (spec && /^\.\/|^\.\.\/mem\.ts/.test(spec) && !/core|prompts|types/.test(spec) && !/type \{/.test(i.decl)) for (const n of i.decl.replace(/\n/g, ' ').match(/\{([^}]*)\}/)?.[1].split(',').map((x) => x.trim()).filter(Boolean) || []) imported.add(n) }
    for (const c of cs) {
      if (c.kind !== 'const' || c.name === 'mem') continue
      if (/^export const \w+ = new (Map|Set)/.test(c.decl) || /^(export )?const \w+ = .*=>/.test(c.decl.split('\n')[0])) continue
      for (const id of mask(c.decl).match(/[A-Za-z_$][\w$]*/g) || []) if (imported.has(id)) fail(`${f}: constant ${c.name} reads ${id} from another file at load time`)
    }
  }
}
// hooks.json
try {
  const a = readF(path.join(oldDir, 'hooks.json')), b = readF(path.join(newDir, 'hooks.json'))
  if (a !== b) fail('hooks.json changed')
} catch (e) { fail('cannot compare hooks.json: ' + e.message) }

// ---------------------------------------------------------------- report
console.log(`old declarations by name: ${oldNames.size} (functions ${stats.functions}, const arrows taking $ ${stats.arrows}, constants ${stats.consts}, per-session maps and sets ${stats.maps}, types ${stats.types}); module lets ${stats.lets}; key constants declared ${stats.keys} (old ${keyOld.size})`)
console.log(`hook functions matched: ${hookReport.length} (${hookReport.join(', ')})`)
console.log(`declarations whose preamble comment lines are not identical to the old chunk's (moved with other code): ${movedPre.length}${movedPre.length ? ' - ' + movedPre.join(', ') : ''}`)
console.log(`new files: ${Object.keys(newFiles).join(', ')}`)
if (problems.length) {
  console.log(`\nFAIL: ${problems.length} difference(s)`)
  for (const p of problems) console.log(' - ' + p)
  process.exit(1)
}
console.log('\nPASS: every old declaration and hook body is in the new files, equal after the five allowed form changes')
