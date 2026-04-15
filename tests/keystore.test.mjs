import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolated test — use a temp directory for keys
const tmp = mkdtempSync(join(tmpdir(), 'meridian-test-'))
process.chdir(tmp)

const { generateKey } = await import('../src/keystore.mjs')

test('generateKey returns mrd_live_ prefix', () => {
  const k = generateKey()
  assert.match(k, /^mrd_live_[A-Za-z0-9_-]{30,}$/)
})

test('generateKey returns unique keys', () => {
  const a = generateKey(), b = generateKey()
  assert.notStrictEqual(a, b)
})
