import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

// The validator refuses a function that calls $.state and that no hook reaches, so each accessor in state.ts needs a caller in engine/.
const state = readFileSync(new URL('./state.ts', import.meta.url), 'utf8')
const engine = new URL('./engine/', import.meta.url)
const callers = readdirSync(engine).filter((f) => /\.ts$/.test(f)).map((f) => readFileSync(new URL(f, engine), 'utf8'))

test('state.ts accessors: each has a caller in engine/, and no engine file calls $.state itself', () => {
  const names = [...state.matchAll(/^export function (\w+)\(/gm)].map((m) => m[1] as string)
  assert.ok(names.length > 0)
  assert.deepEqual(names.filter((n) => !callers.some((src) => new RegExp(`\\b${n}\\(`).test(src))), [])
  assert.deepEqual(callers.filter((src) => /\$\.state\b/.test(src.replace(/^\s*\/\/.*$/gm, ''))), [])
})
